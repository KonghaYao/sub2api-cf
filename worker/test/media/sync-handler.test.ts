import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { apiKeyDigest, encryptCredential } from '../../src/gateway/crypto'
import { handleSyncImages } from '../../src/media/sync-handler'
import type { SyncImageBilling } from '../../src/media/sync-billing'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const RAW_KEY = 'sk-sync-image-test'
const PEPPER = 'sync-image-pepper-value-at-least-32-bytes'
const MASTER_KEY = 'sync-image-master-key-value-at-least-32-bytes'

async function fixture(platform: 'openai' | 'codex' = 'openai') {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(`INSERT INTO users (
    id, email, display_name, balance_micros, concurrency, rpm_limit, created_at_ms, updated_at_ms
  ) VALUES ('user-1','image@example.test','Image User',10000000,2,60,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO "groups" (
    id,name,platform,enabled,rate_multiplier_ppm,group_type,is_exclusive,
    allow_image_generation,image_rate_independent,image_rate_multiplier_ppm,
    image_price_1k_micros,image_price_2k_micros,image_price_4k_micros,created_at_ms,updated_at_ms
  ) VALUES ('group-1','Images','${platform}',1,1000000,'standard',0,1,1,1000000,
    100000,200000,400000,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO api_keys (
    id,user_id,key_hash,name,enabled,group_id,key_prefix,created_at_ms,updated_at_ms
  ) VALUES ('key-1','user-1',?,'Images key',1,'group-1','sk-sync',?,?)`)
    .run(await apiKeyDigest(RAW_KEY, PEPPER), now, now)
  const encrypted = await encryptCredential({ api_key: 'upstream-secret' }, MASTER_KEY, 'test/account-1/secret-1/1')
  raw.exec(`INSERT INTO models (
    id,platform,public_name,upstream_name,endpoint,image_generation,enabled,created_at_ms,updated_at_ms
  ) VALUES ('model-1','${platform}','gpt-image-2','gpt-image-upstream','responses',1,1,1,1);
  INSERT INTO group_models (group_id,model_id,enabled,catalog_visible,created_at_ms,updated_at_ms)
    VALUES ('group-1','model-1',1,1,1,1);
  INSERT INTO model_prices (
    id,group_id,model_id,version,active,input_micros_per_million,output_micros_per_million,
    cache_read_micros_per_million,per_request_micros,minimum_reservation_micros,effective_at_ms,created_at_ms
  ) VALUES ('price-1','group-1','model-1',1,1,0,0,0,0,1,1,1);
  INSERT INTO accounts (
    id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,
    protocol,base_url,auth_scheme,health_status
  ) VALUES ('account-1','${platform}','Image upstream','secret-1',1,2,1,1,'${platform}',
    '${platform === 'codex' ? 'https://chatgpt.example.test' : 'https://api.openai.com'}','bearer','healthy');
  UPDATE accounts SET provider_config_json = '${platform === 'codex' ? '{"account_id":"workspace-123"}' : '{}'}'
    WHERE id = 'account-1';
  INSERT INTO account_secrets (
    id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms
  ) VALUES ('secret-1','account-1',1,'${encrypted.nonce_b64}','${encrypted.ciphertext_b64}',1,1);
  INSERT INTO account_groups (account_id,group_id,priority,weight,created_at_ms,updated_at_ms)
    VALUES ('account-1','group-1',1,1,1,1);
  INSERT INTO account_models (
    account_id,model_id,chat_completions,responses,embeddings,image_generation,created_at_ms,updated_at_ms
  ) VALUES ('account-1','model-1',0,0,0,1,1,1);`)

  const stateCalls: string[] = []
  const failureRequests: Array<Record<string, unknown>> = []
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      stateCalls.push(path)
      if (path === '/admit') {
        const body = await request.json() as { request_id: string }
        return Response.json({ admitted: true, lease: { request_id: body.request_id, status: 'active' } })
      }
      if (path === '/reserve') return Response.json({ lease: { account_id: 'account-1', status: 'active' } })
      if (path === '/failure') failureRequests.push(await request.json() as Record<string, unknown>)
      return Response.json({ ok: true })
    } }),
  } as unknown as DurableObjectNamespace
  const reserve = vi.fn(async () => undefined)
  const settle = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const billing: SyncImageBilling = { reserve, settle, cancel }
  const upstreamBodies: Array<{ url: string; body: Record<string, unknown> }> = []
  const upstreamFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer upstream-secret')
    const body = init?.body instanceof FormData
      ? Object.fromEntries(Array.from(init.body.entries(), ([key, value]) => [
          key,
          typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size },
        ]))
      : JSON.parse(String(init?.body)) as Record<string, unknown>
    upstreamBodies.push({ url: String(input), body })
    // The accounting parser needs only the PNG signature and IHDR dimensions.
    const png = new Uint8Array(24)
    png.set([137,80,78,71,13,10,26,10], 0)
    png.set([0,0,4,0,0,0,4,0], 16)
    let binary = ''
    for (const byte of png) binary += String.fromCharCode(byte)
    return Response.json({ created: 1, data: [{ b64_json: btoa(binary) }] })
  })
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY, DB: d1, USER_STATE: namespace,
    API_KEY_LIMIT_STATE: namespace, POOL_STATE: namespace,
    CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: { send: vi.fn() } as unknown as Queue,
    ASSETS: {} as Fetcher, SYNC_IMAGE_BILLING: billing, SYNC_IMAGE_UPSTREAM_FETCH: upstreamFetch,
  }
  return { raw, env, stateCalls, failureRequests, reserve, settle, cancel, upstreamFetch, upstreamBodies }
}

function app() {
  const api = new Hono()
  api.post('/v1/images/generations', (context) => handleSyncImages(context as never, 'generations'))
  api.post('/images/generations', (context) => handleSyncImages(context as never, 'generations'))
  api.post('/v1/images/edits', (context) => handleSyncImages(context as never, 'edits'))
  api.post('/images/edits', (context) => handleSyncImages(context as never, 'edits'))
  return api
}

describe('synchronous image handler', () => {
  it.each(['/v1/images/generations', '/images/generations'])('serves %s through the image account pool', async (path) => {
    const test = await fixture()
    const response = await app().request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'draw a square', size: '1024x1024' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: 1, data: [{ b64_json: expect.any(String) }] })
    expect(test.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 400_000 }))
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ amountMicros: 100_000, operation: 'generations' }),
    }))
    expect(test.cancel).not.toHaveBeenCalled()
    expect(test.upstreamBodies).toEqual([expect.objectContaining({
      url: 'https://api.openai.com/v1/images/generations',
      body: expect.objectContaining({
        model: 'gpt-image-upstream', prompt: 'draw a square', n: 1, size: '1024x1024', moderation: 'auto',
      }),
    })])
    expect(test.stateCalls).toContain('/accounts/sync')
    expect(test.stateCalls).toContain('/release')
  })

  it.each(['/v1/images/edits', '/images/edits'])('forwards safe JSON edits through %s', async (path) => {
    const test = await fixture()
    const response = await app().request(path, {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'add a hat',
        images: [{ image_url: 'https://images.example.test/cat.png' }],
      }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamBodies).toEqual([expect.objectContaining({
      url: 'https://api.openai.com/v1/images/edits',
      body: expect.objectContaining({
        model: 'gpt-image-upstream', prompt: 'add a hat',
        images: [{ image_url: 'https://images.example.test/cat.png' }],
      }),
    })])
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ operation: 'edits' }),
    }))
  })

  it('forwards bounded multipart edits with image bytes and no synthetic content-type', async () => {
    const test = await fixture()
    const form = new FormData()
    form.set('prompt', 'add a hat')
    form.set('size', '1024x1024')
    form.set('image', new Blob([new Uint8Array([
      137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
    ])], { type: 'image/png' }), 'cat.png')
    const response = await app().request('/v1/images/edits', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}` }, body: form,
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamBodies).toEqual([expect.objectContaining({
      url: 'https://api.openai.com/v1/images/edits',
      body: expect.objectContaining({
        model: 'gpt-image-upstream', prompt: 'add a hat', size: '1024x1024',
        'image[]': { name: 'cat.png', type: 'image/png', size: 24 },
      }),
    })])
  })

  it('cancels the hold when the provider rejects a request before output', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      error: { code: 'content_policy_violation', message: 'Request denied', type: 'invalid_request_error' },
    }, { status: 400 }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'blocked' }),
    }, test.env as never)
    expect(response.status).toBe(400)
    expect(test.cancel).toHaveBeenCalledOnce()
    expect(test.settle).not.toHaveBeenCalled()
  })

  it('preserves a successful provider status and safe response headers', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      created: 1, data: [{ b64_json: 'aGVsbG8=' }], provider_extension: { retained: true },
    }), { status: 201, headers: { 'content-type': 'application/problem+json; charset=utf-8', 'cache-control': 'no-store' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String))
    expect(await response.json()).toMatchObject({ provider_extension: { retained: true } })
  })

  it('does not repeat an upstream image when durable settlement fails', async () => {
    const test = await fixture()
    test.settle.mockRejectedValueOnce(new Error('settlement unavailable'))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledTimes(2))
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('runs configured moderation before admission, billing, and upstream work', async () => {
    const test = await fixture()
    const check = vi.fn(async () => ({ allowed: false, message: 'blocked locally' }))
    ;(test.env as typeof test.env & { SYNC_IMAGE_MODERATOR?: { check: typeof check } }).SYNC_IMAGE_MODERATOR = { check }
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'blocked' }),
    }, test.env as never)
    expect(response.status).toBe(400)
    expect(check).toHaveBeenCalledOnce()
    expect(test.reserve).not.toHaveBeenCalled()
    expect(test.upstreamFetch).not.toHaveBeenCalled()
    expect(test.stateCalls).not.toContain('/admit')
  })

  it('delegates to strict provider moderation when no preflight moderator is bound', async () => {
    const test = await fixture()
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', moderation: 'low' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamBodies[0]?.body).toMatchObject({ moderation: 'auto' })
  })

  it('pins the started provider, settlement, and cleanup lifecycle with waitUntil', async () => {
    const test = await fixture()
    const tasks: Promise<unknown>[] = []
    const request = new Request('https://worker.test/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    })
    const response = await app().fetch(request, test.env as never, {
      waitUntil(task: Promise<unknown>) { tasks.push(task) },
      passThroughOnException() {},
      props: {},
    } as never)
    expect(response.status).toBe(200)
    expect(tasks.length).toBeGreaterThan(0)
    await Promise.all(tasks)
    expect(test.settle).toHaveBeenCalledOnce()
    expect(test.stateCalls).toContain('/release')
  })

  it('renews API-key and account leases while provider work is running', async () => {
    const test = await fixture()
    ;(test.env as typeof test.env & { SYNC_IMAGE_RENEW_AFTER_MS?: number }).SYNC_IMAGE_RENEW_AFTER_MS = 1
    const originalFetch = test.upstreamFetch.getMockImplementation()
    test.upstreamFetch.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (originalFetch === undefined) throw new Error('missing upstream fixture')
      return originalFetch(...args)
    })
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.stateCalls.filter((path) => path === '/renew').length).toBeGreaterThanOrEqual(2)
  })

  it('executes a Codex OAuth account through Responses and returns buffered Images JSON', async () => {
    const test = await fixture('codex')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.output_item.done',
      `data: {"type":"response.output_item.done","item":{"id":"ig_worker","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}}`,
      '',
      'event: response.completed',
      `data: {"type":"response.completed","response":{"created_at":1710000000,"status":"completed","output":[{"id":"ig_worker","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}],"tool_usage":{"image_gen":{"input_tokens":12,"output_tokens":99,"output_tokens_details":{"image_tokens":99},"images":1}}}}`,
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_KEY}`,
        'content-type': 'application/json',
        'accept-language': 'zh-CN',
      },
      body: JSON.stringify({ prompt: '画一个杯子', response_format: 'url' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      created: 1_710_000_000,
      model: 'gpt-image-2',
      data: [{ url: `data:image/png;base64,${png}` }],
    })
    const call = test.upstreamFetch.mock.calls[0]
    expect(call?.[0]).toBe('https://chatgpt.example.test/backend-api/codex/responses')
    const headers = new Headers(call?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(headers.get('chatgpt-account-id')).toBe('workspace-123')
    expect(headers.get('accept-language')).toBe('zh-CN')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: true,
      store: false,
      tools: [{ type: 'image_generation', action: 'generate', model: 'gpt-image-upstream' }],
    })
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ accountId: 'account-1', amountMicros: 100_000 }),
    }))
  })

  it('returns transformed Images SSE for a Codex OAuth streaming request and settles it', async () => {
    const test = await fixture('codex')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.image_generation_call.partial_image',
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0,"output_format":"png"}',
      '',
      'event: response.completed',
      `data: {"type":"response.completed","response":{"created_at":1710000002,"status":"completed","output":[{"id":"ig_stream","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}]}}`,
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true, response_format: 'b64_json' }),
    }, test.env as never)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('event: image_generation.partial_image')
    expect(body).toContain('event: image_generation.completed')
    expect(body).toContain(png)
    expect(test.reserve).toHaveBeenCalledOnce()
    expect(test.settle).toHaveBeenCalledOnce()
  })

  it('returns and bills every unique actual Responses output even when it exceeds requested n', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[' +
        '{"id":"ig_1","type":"image_generation_call","result":"Zmlyc3Q="},' +
        '{"id":"ig_2","type":"image_generation_call","result":"c2Vjb25k"}' +
        ']}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'two cats', n: 1 }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect((await response.json() as { data: unknown[] }).data).toHaveLength(2)
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ amountMicros: 400_000 }),
    }))
  })

  it('retries a completed-without-image Responses result on the same account before switching', async () => {
    const test = await fixture('codex')
    test.upstreamFetch
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_retry","type":"image_generation_call","status":"completed","result":"aW1hZ2U=","output_format":"png"}]}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'retry me' }),
    }, test.env as never)
    expect(test.upstreamFetch).toHaveBeenCalledTimes(2)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.settle).toHaveBeenCalledOnce()
  })

  it('honors a bounded retry-after carried by a non-2xx Responses SSE error', async () => {
    const test = await fixture('codex')
    test.upstreamFetch
      .mockResolvedValueOnce(new Response([
        'event: response.failed',
        'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}}',
        '',
        '',
      ].join('\n'), { status: 429, headers: { 'content-type': 'text/event-stream', 'retry-after': '0.001' } }))
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_rate_retry","type":"image_generation_call","status":"completed","result":"aW1hZ2U=","output_format":"png"}]}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'rate retry' }),
    }, test.env as never)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.upstreamFetch).toHaveBeenCalledTimes(2)
    expect(test.settle).toHaveBeenCalledOnce()
  })

  it('does not cool an account for a text fallback but applies the image-pool cooldown for tool unavailable', async () => {
    const textFallback = await fixture('codex')
    textFallback.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Here is a polished prompt"}]}]}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const textResponse = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'fallback' }),
    }, textFallback.env as never)
    expect(textResponse.status).toBe(502)
    expect(textFallback.failureRequests).toEqual([])

    const unavailable = await fixture('codex')
    unavailable.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"upstream_error","code":"image_generation_unavailable","message":"tool absent"}}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const unavailableResponse = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'unavailable' }),
    }, unavailable.env as never)
    expect(unavailableResponse.status).toBe(502)
    expect(unavailable.failureRequests).toEqual([
      expect.objectContaining({ account_id: 'account-1', cooldown_ms: 1_800_000 }),
    ])
  })

  it('applies the default cooldown to an ordinary upstream transport failure', async () => {
    const test = await fixture()
    test.upstreamFetch.mockRejectedValueOnce(new Error('connection reset'))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)

    expect(response.status).toBe(502)
    expect(test.failureRequests).toEqual([
      expect.objectContaining({ account_id: 'account-1', cooldown_ms: 30_000 }),
    ])
  })

  it('preserves a sanitized Responses client error contract including param', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"invalid_request_error","code":"invalid_value","message":"Invalid image size","param":"size"}}}',
      '',
      '',
    ].join('\n'), { status: 400, headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'bad size' }),
    }, test.env as never)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'invalid_request_error', code: 'invalid_value',
        message: 'Invalid image size', param: 'size',
      },
    })
    expect(test.failureRequests).toEqual([])
  })

  it('preserves a sanitized content-policy error without retrying or cooling the account', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{' +
        '"type":"image_generation_user_error","code":"content_policy_violation",' +
        '"message":"Prompt violates image policy","param":"prompt"}}}',
      '',
      '',
    ].join('\n'), { status: 400, headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'blocked' }),
    }, test.env as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'image_generation_user_error', code: 'content_policy_violation',
        message: 'Prompt violates image policy', param: 'prompt',
      },
    })
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    expect(test.failureRequests).toEqual([])
  })

  it('preserves a non-SSE Responses client error including message and param', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      error: {
        type: 'invalid_request_error', code: 'invalid_value',
        message: 'Invalid image size', param: 'size',
      },
    }, { status: 400 }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'bad size' }),
    }, test.env as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'invalid_request_error', code: 'invalid_value',
        message: 'Invalid image size', param: 'size',
      },
    })
    expect(test.failureRequests).toEqual([])
  })

  it('still rejects direct-provider streaming before admission and billing', async () => {
    const test = await fixture()
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)
    expect(response.status).toBe(501)
    expect(test.reserve).not.toHaveBeenCalled()
    expect(test.upstreamFetch).not.toHaveBeenCalled()
  })
})
