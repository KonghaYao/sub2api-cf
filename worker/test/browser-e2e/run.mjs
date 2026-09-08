import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { unstable_startWorker } from 'wrangler'
import { reserveLoopbackPort, workerOriginBindings } from './runtime.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workerDirectory = resolve(scriptDirectory, '../..')
const repositoryDirectory = resolve(workerDirectory, '..')
const frontendDirectory = join(repositoryDirectory, 'frontend')
const configPath = join(workerDirectory, 'wrangler.browser-e2e.jsonc')
const playwrightTestArguments = process.argv.slice(2)
const persistenceDirectory = await mkdtemp(join(tmpdir(), 'sub2api-browser-e2e-'))
const portReservation = await reserveLoopbackPort()
const { origin, port } = portReservation

let worker
let shuttingDown = false
const stripeSessions = new Map()
const stripeSecretKey = 'sk_test_browser_e2e_checkout'

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

function stripeProtocolError(message, details = {}) {
  console.error('[browser-e2e] Stripe protocol violation', { message, details })
  return Response.json({ error: message, ...details }, { status: 422 })
}

function stripeSessionResponse(session, status = session.status) {
  return Response.json({
    id: session.id,
    object: 'checkout.session',
    status,
    payment_status: 'unpaid',
    amount_total: session.amountTotal,
    currency: session.currency,
    url: session.url,
    payment_intent: null,
  })
}

async function stripeResponse(request, url) {
  if (request.headers.get('authorization') !== `Bearer ${stripeSecretKey}`) {
    return stripeProtocolError('unexpected Stripe authorization')
  }

  if (url.pathname === '/v1/checkout/sessions') {
    if (request.method !== 'POST') return stripeProtocolError('unexpected Stripe checkout method')
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      return stripeProtocolError('unexpected Stripe checkout content type')
    }
    const form = new URLSearchParams(await request.text())
    const orderId = form.get('client_reference_id') ?? ''
    const successUrl = new URL(form.get('success_url') ?? 'https://invalid.local')
    const cancelUrl = new URL(form.get('cancel_url') ?? 'https://invalid.local')
    const expiresAt = Number(form.get('expires_at'))
    const expected = {
      mode: 'payment',
      metadataOrder: orderId,
      paymentIntentOrder: orderId,
      currency: 'usd',
      amount: '1234',
      product: 'Browser:Browser E2E Stripe Monthly:subscription',
      quantity: '1',
    }
    const actual = {
      mode: form.get('mode'),
      metadataOrder: form.get('metadata[order_id]'),
      paymentIntentOrder: form.get('payment_intent_data[metadata][order_id]'),
      currency: form.get('line_items[0][price_data][currency]'),
      amount: form.get('line_items[0][price_data][unit_amount]'),
      product: form.get('line_items[0][price_data][product_data][name]'),
      quantity: form.get('line_items[0][quantity]'),
    }
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
      return stripeProtocolError('invalid Stripe checkout order id', { orderId })
    }
    if (request.headers.get('idempotency-key') !== `checkout-${orderId}`) {
      return stripeProtocolError('unexpected Stripe checkout idempotency key')
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return stripeProtocolError('unexpected Stripe checkout form', { expected, actual })
    }
    if (
      successUrl.origin !== origin || successUrl.pathname !== '/payment/result' ||
      successUrl.searchParams.get('order_id') !== orderId ||
      cancelUrl.origin !== origin || cancelUrl.pathname !== '/purchase' ||
      cancelUrl.searchParams.get('cancelled_order_id') !== orderId ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      return stripeProtocolError('unexpected Stripe checkout redirect contract')
    }

    const id = `cs_test_${orderId}`
    const session = {
      id,
      status: 'open',
      amountTotal: 1_234,
      currency: 'usd',
      url: `${origin}/payment/result?stripe_checkout=${encodeURIComponent(id)}`,
    }
    stripeSessions.set(id, session)
    return stripeSessionResponse(session)
  }

  const expireMatch = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname)
  if (expireMatch !== null) {
    const id = decodeURIComponent(expireMatch[1])
    if (request.method !== 'POST' || request.headers.get('idempotency-key') !== `expire-${id}`) {
      return stripeProtocolError('unexpected Stripe expire request')
    }
    if (await request.text() !== '') return stripeProtocolError('unexpected Stripe expire body')
    const session = stripeSessions.get(id)
    if (!session) return Response.json({ error: { message: 'session not found' } }, { status: 404 })
    session.status = 'expired'
    return stripeSessionResponse(session)
  }

  const retrieveMatch = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname)
  if (retrieveMatch !== null) {
    if (request.method !== 'GET' || request.headers.has('idempotency-key')) {
      return stripeProtocolError('unexpected Stripe retrieve request')
    }
    const id = decodeURIComponent(retrieveMatch[1])
    const session = stripeSessions.get(id)
    if (!session) return Response.json({ error: { message: 'session not found' } }, { status: 404 })
    return stripeSessionResponse(session)
  }

  return stripeProtocolError('unexpected Stripe browser E2E endpoint', {
    method: request.method,
    path: url.pathname,
  })
}

let browserOAuthCurrentToken = 'browser-oauth-access-token'
let browserMixedFailures = 0
async function upstreamResponse(request) {
  const url = new URL(request.url)
  if (url.origin === 'https://platform.claude.com' && url.pathname === '/v1/oauth/token' && request.method === 'POST') {
    const body = await request.json()
    if (body.grant_type !== 'refresh_token' || body.refresh_token !== 'browser-claude-refresh-token' ||
      body.client_id !== '9d1c250a-e61b-44d9-88ed-5944d1962f5e' || request.headers.get('user-agent') !== 'axios/1.13.6') {
      return new Response('invalid Claude refresh', { status: 400 })
    }
    return Response.json({ access_token: 'browser-claude-usage-token', refresh_token: 'browser-claude-rotated-token',
      token_type: 'Bearer', expires_in: 3600, scope: 'user:inference' })
  }
  if (url.origin === 'https://mixed.browser-e2e.invalid' && url.pathname === '/v1/responses' && request.method === 'POST') {
    const body = await request.json()
    if (request.headers.get('authorization') !== 'Bearer browser-mixed-key') return new Response('incorrect mixed credential', { status: 401 })
    if (body.tool_choice !== 'required') browserMixedFailures++
    return Response.json({ error: { message: 'mixed Responses temporarily unavailable' } }, { status: 503 })
  }
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/api/oauth/usage' && request.method === 'GET') {
    if (request.headers.get('authorization') !== 'Bearer browser-claude-usage-token' || request.headers.get('anthropic-beta') !== 'oauth-2025-04-20') return new Response('invalid Claude usage auth', { status: 401 })
    return Response.json({ five_hour: { utilization: 35, resets_at: new Date(Date.now() + 18000000).toISOString() },
      seven_day: { utilization: 65, resets_at: new Date(Date.now() + 604800000).toISOString() } })
  }
  if (url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/token' && request.method === 'POST') {
    const form = new URLSearchParams(await request.text())
    const validCode = form.get('grant_type') === 'authorization_code' && form.get('code') === 'browser-ui-oauth-code' &&
      form.get('redirect_uri') === 'http://localhost:1455/auth/callback' && /^[a-f0-9]{128}$/.test(form.get('code_verifier') ?? '')
    const savedRefresh = form.get('refresh_token') === 'browser-oauth-ui-refresh'
    const validRefresh = form.get('grant_type') === 'refresh_token' && (form.get('refresh_token') === 'browser-ui-create-refresh' || savedRefresh) &&
      form.get('scope') === 'openid profile email'
    if ((!validCode && !validRefresh) || form.get('client_id') !== 'app_EMoamEEZ73f0CkXaXp7hrann' ||
        request.headers.get('originator') !== 'codex-tui' || request.headers.has('version')) {
      return Response.json({ error: 'incorrect OAuth code exchange' }, { status: 422 })
    }
    browserOAuthCurrentToken = savedRefresh ? 'browser-oauth-ui-refreshed-token' : 'browser-oauth-ui-token'
    return Response.json({ access_token: browserOAuthCurrentToken, refresh_token: 'browser-oauth-ui-refresh', expires_in: 3600,
      id_token: `header.${btoa(JSON.stringify({ email: savedRefresh ? 'oauth-refreshed@example.test' : 'oauth-ui@example.test', 'https://api.openai.com/auth': {
        chatgpt_account_id: 'browser-oauth-upstream-account', chatgpt_plan_type: savedRefresh ? 'plus' : 'pro',
      } }))}.signature` })
  }
  if (url.origin === 'https://chatgpt.com' && ['/backend-api/accounts/check/v4-2023-04-27', '/backend-api/subscriptions', '/backend-api/settings/account_user_setting'].includes(url.pathname)) {
    if (request.headers.get('authorization') !== `Bearer ${browserOAuthCurrentToken}`) return new Response('incorrect profile token', { status: 401 })
    if (url.pathname.includes('/settings/')) {
      if (request.method !== 'PATCH' || url.searchParams.get('feature') !== 'training_allowed' || url.searchParams.get('value') !== 'false') return new Response('incorrect privacy request', { status: 422 })
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/subscriptions')) return Response.json({ active_until: '2099-01-01T00:00:00Z' })
    return Response.json({ accounts: {} })
  }
  if ((url.origin === 'https://upstream.browser-e2e.invalid' && url.pathname === '/v1/responses') ||
      (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/responses')) {
    if (request.method === 'POST') {
      const body = await request.clone().json()
      if (url.origin === 'https://upstream.browser-e2e.invalid' && body.tool_choice === 'required' && body.tools?.[0]?.name === 'probe_ping') {
        if (request.headers.get('authorization') !== 'Bearer browser-create-api-key' || request.headers.get('openai-beta') !== 'responses=experimental' ||
            !request.headers.get('x-codex-window-id') || body.stream !== false || body.max_output_tokens !== 512) return new Response('incorrect capability probe', { status: 422 })
        return Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'probe_ping', arguments: '{"ok":true}' }] })
      }
      if (body.input?.some(item => item.type === 'compaction_trigger')) {
        const oauth = url.origin === 'https://chatgpt.com'
        if (body.model === 'gpt-rate-limit') return Response.json({ error: { type: 'usage_limit_reached', resets_in_seconds: 600 } }, { status: 429 })
        if (body.model === 'gpt-auth-failure') return new Response('private provider details', { status: 401 })
        if (request.headers.get('authorization') !== (oauth ? 'Bearer browser-oauth-access-token' : 'Bearer browser-create-api-key') ||
            body.model !== (oauth ? 'gpt-5.3-codex' : 'gpt-5.3-high') || body.stream !== true ||
            request.headers.get('x-codex-beta-features') !== 'remote_compaction_v2' ||
            !request.headers.get('session_id') || request.headers.get('session_id') !== request.headers.get('conversation_id') ||
            (!oauth && request.headers.get('x-browser-account-route') !== 'saved-route')) {
          return Response.json({ error: 'incorrect compact probe request' }, { status: 422 })
        }
        return new Response('data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"browser-compact-blob"}}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } })
      }
    }
  }
  const imagePNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  if (url.origin === 'https://upstream.browser-e2e.invalid' && url.pathname === '/v1/images/generations' && request.method === 'POST') {
    const body = await request.json()
    if (request.headers.get('authorization') !== 'Bearer browser-create-api-key' ||
        request.headers.get('x-browser-account-route') !== 'saved-route' || body.model !== 'gpt-image-2' ||
        body.n !== 1 || body.response_format !== 'b64_json' || !body.prompt) {
      return Response.json({ error: 'incorrect API-key image diagnostic' }, { status: 422 })
    }
    return Response.json({ data: [{ b64_json: imagePNG, revised_prompt: 'browser-openai-image-ok' }] })
  }
  if (url.origin === 'https://generativelanguage.googleapis.com' && url.pathname.endsWith(':streamGenerateContent') && request.method === 'POST') {
    const body = await request.json()
    const image = url.pathname.includes('gemini-3.1-flash-image-preview')
    if (request.headers.get('x-goog-api-key') !== 'browser-gemini-api-key' || url.searchParams.get('alt') !== 'sse' ||
        (image && JSON.stringify(body.generationConfig?.responseModalities) !== '["TEXT","IMAGE"]')) {
      return Response.json({ error: 'incorrect Gemini diagnostic request' }, { status: 422 })
    }
    const parts = [{ text: 'browser-gemini-diagnostic-ok' }]
    if (image) parts.push({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } })
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages' && request.method === 'POST') {
    const body = await request.json()
    if (request.headers.get('authorization') !== 'Bearer browser-claude-api-key' || request.headers.has('x-api-key') ||
        url.searchParams.get('beta') !== 'true' || body.model !== 'claude-sonnet-4-6' || body.stream !== true ||
        body.max_tokens !== 1024 || !body.metadata?.user_id) {
      return Response.json({ error: 'incorrect Claude diagnostic request' }, { status: 422 })
    }
    return new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"browser-claude-diagnostic-ok"}}\n\n' +
      'data: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/responses' && request.method === 'POST') {
    const body = await request.json()
    if (body.tools?.[0]?.type === 'image_generation') {
      if (request.headers.get('authorization') !== 'Bearer browser-oauth-access-token' ||
          request.headers.get('chatgpt-account-id') !== 'browser-oauth-upstream-account' ||
          body.model !== 'gpt-5.4-mini' || body.tools[0].model !== 'gpt-image-2' ||
          body.tool_choice?.type !== 'image_generation' || body.stream !== true || body.store !== false) {
        return Response.json({ error: 'incorrect OAuth image diagnostic' }, { status: 422 })
      }
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'image_generation_call', result: imagePNG, output_format: 'png', revised_prompt: 'browser-openai-image-ok' },
      ] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const afterReauth = JSON.stringify(body.input).includes('browser-after-reauth')
    const expectedOAuthModel = browserOAuthCurrentToken === 'browser-oauth-ui-refreshed-token' ? 'codex-auto-review'
      : browserOAuthCurrentToken.startsWith('browser-oauth-ui') ? 'gpt-5.6-sol' : 'gpt-5.3-codex'
    if (request.headers.get('authorization') !== (afterReauth ? 'Bearer browser-oauth-reauthorized-token' : `Bearer ${browserOAuthCurrentToken}`) ||
        request.headers.get('chatgpt-account-id') !== 'browser-oauth-upstream-account' ||
        (body.model !== expectedOAuthModel && !(body.model === 'codex-auto-review' && JSON.stringify(body.input).includes('hi'))) || body.stream !== true || body.store !== false || !body.instructions) {
      return Response.json({ error: 'incorrect OAuth diagnostic request' }, { status: 422 })
    }
    if (JSON.stringify(body.input).includes('browser-gateway-rate-limit')) return Response.json({
      error: { type: 'usage_limit_reached', resets_in_seconds: 120 },
    }, { status: 429 })
    return new Response('data: {"type":"response.output_text.delta","delta":"browser-oauth-diagnostic-ok"}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp-browser-oauth","object":"response","model":"gpt-5.3-codex","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"browser-oauth-diagnostic-ok"}]}],"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '50', 'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-after-seconds': '604800', 'x-codex-secondary-used-percent': '25', 'x-codex-secondary-window-minutes': '300', 'x-codex-secondary-reset-after-seconds': '18000' } })
  }
  if (url.origin === 'https://upstream.browser-e2e.invalid' && url.pathname === '/v1/responses' && request.method === 'POST') {
    const body = await request.json()
    if (request.headers.get('authorization') !== 'Bearer browser-create-api-key' ||
        body.model !== 'gpt-browser-e2e-upstream' || body.stream !== true ||
        request.headers.get('x-browser-account-route') !== 'saved-route') {
      return Response.json({ error: 'incorrect diagnostic request' }, { status: 422 })
    }
    if (JSON.stringify(body.input).includes('browser-temp-rule')) return Response.json({ error: { message: 'MODEL MAINTENANCE' } }, { status: 400 })
    if (JSON.stringify(body.input).includes('browser-policy-429')) return Response.json({ error: { message: 'quota unavailable' } },
      { status: 429, headers: { 'x-codex-primary-reset-after-seconds': '300' } })
    if (JSON.stringify(body.input).includes('Say browser-gateway-ok.')) {
      const completed = { id: 'resp-browser-gateway', object: 'response', status: 'completed', model: body.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'browser-gateway-ok' }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
      return new Response('data: {"type":"response.output_text.delta","delta":"browser-gateway-ok"}\n\n' +
        `data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('data: {"type":"response.output_text.delta","delta":"browser-diagnostic-ok"}\n\n' +
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url.origin === 'https://upstream.browser-e2e.invalid' && url.pathname === '/v1/sub2api/billing' && request.method === 'GET') {
    if (request.headers.get('authorization') !== 'Bearer browser-create-api-key') return Response.json({ error: 'incorrect billing credential' }, { status: 401 })
    return Response.json({ object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token',
      group_rate_multiplier: 1.25, resolved_rate_multiplier: 1.25, peak_rate_enabled: false,
      effective_rate_multiplier: 1.25, observed_at: new Date().toISOString() })
  }
  if (url.origin === 'https://upstream.browser-e2e.invalid' && url.pathname === '/v1/models' && request.method === 'GET') {
    if (!request.headers.get('authorization')?.startsWith('Bearer ')) return Response.json({ error: 'missing credential' }, { status: 401 })
    return Response.json({ data: [{ id: 'gpt-browser-e2e-upstream', reasoning: false, input_modalities: ['text'], context_window: 128000 }] })
  }
  if (url.origin === 'https://api.stripe.com') {
    return stripeResponse(request, url)
  }
  if (
    url.origin !== 'https://upstream.browser-e2e.invalid' ||
    url.pathname !== '/v1/chat/completions' ||
    request.method !== 'POST'
  ) {
    return Response.json({ error: 'unexpected browser E2E outbound request' }, { status: 502 })
  }

  const body = await request.json()
  if (body?.messages?.[0]?.content === 'browser-policy-429' && request.headers.get('authorization') === 'Bearer browser-create-api-key') {
    return Response.json({ error: { message: 'quota unavailable' } }, { status: 429, headers: { 'x-codex-primary-reset-after-seconds': '300' } })
  }
  if (body?.messages?.[0]?.content === 'browser-temp-rule' && request.headers.get('authorization') === 'Bearer browser-create-api-key') {
    return Response.json({ error: { message: 'MODEL MAINTENANCE' } }, { status: 400 })
  }
  if (request.headers.get('authorization') === 'Bearer browser-create-api-key' &&
      request.headers.get('x-browser-account-route') !== 'saved-route') {
    return Response.json({ error: 'missing saved account header override' }, { status: 422 })
  }
  if (body?.messages?.[0]?.content === 'Say browser-mixed-failover-ok.') {
    if (browserMixedFailures < 1 || body.model !== 'gpt-browser-e2e-upstream' || request.headers.get('authorization') !== 'Bearer browser-create-api-key') {
      return Response.json({ error: 'mixed protocol priority/failover was skipped' }, { status: 422 })
    }
    return Response.json({ id: 'chatcmpl-browser-mixed', object: 'chat.completion', created: 1700000000, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'browser-mixed-failover-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  if (body?.stream === true && body?.model === 'gpt-browser-e2e-upstream' &&
      body?.messages?.[0]?.content === 'hi' && request.headers.get('authorization') === 'Bearer browser-create-api-key') {
    return new Response('data: {"choices":[{"delta":{"content":"browser-chat-diagnostic-ok"}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  }
  if (
    body?.model !== 'gpt-browser-e2e-upstream' ||
    body?.stream !== false ||
    body?.messages?.[0]?.content !== 'Say browser-gateway-ok.'
  ) {
    return Response.json({ error: 'unexpected Chat request', body }, { status: 422 })
  }
  return Response.json({
    id: 'chatcmpl-browser-e2e',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-browser-e2e-upstream',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'browser-gateway-ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

async function waitForReady() {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`readiness returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error('Worker did not become ready within 30 seconds', { cause: lastError })
}

async function cleanup() {
  if (shuttingDown) return
  shuttingDown = true
  await portReservation.release().catch(() => {})
  await worker?.dispose().catch(() => {})
  await rm(persistenceDirectory, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130))
  })
}

try {
  console.log('[browser-e2e] building frontend assets')
  await run('pnpm', ['run', 'build:cloudflare'], { cwd: frontendDirectory })
  console.log('[browser-e2e] applying D1 migrations to isolated local state')
  await run(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      'wrangler.browser-e2e.jsonc',
      '--persist-to',
      persistenceDirectory,
    ],
    { cwd: workerDirectory },
  )

  console.log('[browser-e2e] starting local Worker')
  await portReservation.release()
  worker = await unstable_startWorker({
    config: configPath,
    bindings: workerOriginBindings(origin),
    dev: {
      remote: false,
      server: { hostname: '127.0.0.1', port, secure: false },
      inspector: false,
      persist: persistenceDirectory,
      watch: false,
      logLevel: 'warn',
      outboundService: upstreamResponse,
    },
  })
  await worker.ready
  console.log(`[browser-e2e] Worker listening at ${await worker.url}`)
  await waitForReady()

  console.log('[browser-e2e] running Playwright')
  await run('pnpm', [
    'exec',
    'playwright',
    'test',
    ...playwrightTestArguments,
    '--config',
    'playwright.config.ts',
  ], {
    cwd: frontendDirectory,
    env: { WORKER_BROWSER_E2E_ORIGIN: origin },
  })
} finally {
  await cleanup()
}
