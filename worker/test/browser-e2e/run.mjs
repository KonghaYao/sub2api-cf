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

async function upstreamResponse(request) {
  const url = new URL(request.url)
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
