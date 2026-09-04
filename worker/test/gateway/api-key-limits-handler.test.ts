import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { apiKeyDigest, encryptCredential } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const masterKey = 'm'.repeat(32)
const pepper = 'p'.repeat(32)

class StateStub {
  readonly calls: Array<{ path: string; body: Record<string, unknown> }> = []

  constructor(
    private readonly kind: 'user' | 'pool' | 'admission',
    private readonly events: string[],
  ) {}

  admissionResponse: Response | null = null
  monetaryReserveResponse: Response | null = null

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const body = await request.json() as Record<string, unknown>
    this.calls.push({ path, body })
    this.events.push(`${this.kind}:${path}`)
    if (this.kind === 'admission' && path === '/admit') {
      return this.admissionResponse?.clone() ?? Response.json({
        admitted: true,
        lease: { request_id: body.request_id, status: 'active' },
      })
    }
    if (this.kind === 'admission' && path === '/monetary/settle') {
      return Response.json({ usage: {
        api_key_id: 'key-1',
        quota_reset_epoch: 0,
        rate_limit_reset_epoch: 0,
        total_settled_micros: 10,
        active_reserved_micros: 0,
        windows: (['5h', '1d', '7d'] as const).map((kind) => ({
          api_key_id: 'key-1', kind, window_started_at_ms: 1,
          settled_micros: 10, updated_at_ms: 1,
        })),
      } })
    }
    if (this.kind === 'admission' && path === '/monetary/reserve' && this.monetaryReserveResponse !== null) {
      return this.monetaryReserveResponse.clone()
    }
    if (this.kind === 'pool' && path === '/reserve') {
      return Response.json({ lease: { account_id: 'account-1', status: 'active' } })
    }
    if (this.kind === 'user' && path === '/settle') {
      return Response.json({ profile: { balance_micros: 999_990, settled_micros: 10 } })
    }
    return Response.json({})
  }
}

async function harness(): Promise<{
  env: Env
  admission: StateStub
  pool: StateStub
  user: StateStub
  events: string[]
  close: () => void
}> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const rawKey = 'sk-customer-limits'
  const digest = await apiKeyDigest(rawKey, pepper)
  const encrypted = await encryptCredential(
    { api_key: 'sk-upstream' },
    masterKey,
    'test/account-1/secret-1/1',
  )
  raw.prepare(`
    INSERT INTO users (
      id, email, status, balance_micros, concurrency, rpm_limit, created_at_ms, updated_at_ms
    ) VALUES ('user-1', 'gateway-limit@example.com', 'active', 1000000, 1, 60, 1, 1)
  `).run()
  raw.prepare(`
    INSERT INTO "groups" (
      id, name, platform, enabled, rpm_limit, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'default', 'openai', 1, 30, 1, 1)
  `).run()
  raw.prepare(`
    INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
    VALUES ('user-1', 'group-1', 1)
  `).run()
  raw.prepare(`
    INSERT INTO api_keys (
      id, user_id, key_hash, name, enabled, group_id, key_prefix, created_at_ms, updated_at_ms
    ) VALUES ('key-1', 'user-1', ?, 'default', 1, 'group-1', 'sk-customer', 1, 1)
  `).run(digest)
  raw.exec(`
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings,
      enabled, created_at_ms, updated_at_ms
    ) VALUES ('model-1', 'openai', 'gpt-public', 'gpt-upstream', 'both', 1, 1, 1, 1);
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'model-1', 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES ('price-1', 'group-1', 'model-1', 1, 1, 1000, 1000, 0, 0, 1, 1, 1);
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
    ) VALUES (
      'account-1', 'openai', 'primary', 'secret-1', 1, 4,
      1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
    );
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'group-1', 0, 1, 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'model-1', 1, 1, 1, 1, 1);
  `)
  raw.prepare(`
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES ('secret-1', 'account-1', 1, ?, ?, 1, 1)
  `).run(encrypted.nonce_b64, encrypted.ciphertext_b64)

  const events: string[] = []
  const admission = new StateStub('admission', events)
  const pool = new StateStub('pool', events)
  const user = new StateStub('user', events)
  const namespace = (stub: StateStub) => ({
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  }) as unknown as DurableObjectNamespace
  return {
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: pepper,
      CREDENTIALS_MASTER_KEY: masterKey,
      DB: d1,
      USER_STATE: namespace(user),
      POOL_STATE: namespace(pool),
      API_KEY_LIMIT_STATE: namespace(admission),
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: { send: async () => undefined } as unknown as Queue,
    },
    admission,
    pool,
    user,
    events,
    close: () => raw.close(),
  }
}

function gatewayRequest(path = '/v1/responses', body: Record<string, unknown> = {
  model: 'gpt-public',
  input: 'hello',
}): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-customer-limits',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

describe('gateway API key admission lifecycle', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('rejects before billing, account-pool reservation, and upstream fetch', async () => {
    const state = await harness()
    state.admission.admissionResponse = Response.json({
      error: { code: 'user_rpm_limit_exceeded', message: 'RPM exceeded' },
      retry_after_seconds: 17,
    }, { status: 429, headers: { 'retry-after': '17' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await createApp().request('/v1/responses', gatewayRequest(), state.env)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'user_rpm_limit_exceeded' },
    })
    expect(state.user.calls).toEqual([])
    expect(state.pool.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    state.close()
  })

  it('compensates primary billing and rejects before pool/fetch when the key budget is exhausted', async () => {
    const state = await harness()
    state.admission.monetaryReserveResponse = Response.json({
      error: { code: 'api_key_rate_limit_5h_exceeded', message: '5h spend exhausted' },
      retry_after_seconds: 23,
    }, { status: 429, headers: { 'retry-after': '23' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await createApp().request('/v1/responses', gatewayRequest(), state.env)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('23')
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'api_key_rate_limit_5h_exceeded' },
    })
    expect(state.user.calls.map((call) => call.path)).toEqual([
      '/configure', '/authorize', '/reserve', '/cancel',
    ])
    expect(state.admission.calls.map((call) => call.path)).toEqual([
      '/admit', '/monetary/configure', '/monetary/reserve', '/monetary/cancel', '/release',
    ])
    expect(state.pool.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    state.close()
  })

  it('holds one admission across upstream retry and releases it once after sync completion', async () => {
    const state = await harness()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { message: 'temporary' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        id: 'response-1',
        object: 'response',
        model: 'gpt-upstream',
        usage: { input_tokens: 2, output_tokens: 3 },
      }))

    const response = await createApp().request('/v1/responses', gatewayRequest(), state.env)

    expect(response.status).toBe(200)
    expect(state.admission.calls.filter((call) => call.path === '/admit')).toHaveLength(1)
    expect(state.admission.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    expect(state.events.indexOf('admission:/admit')).toBeLessThan(state.events.indexOf('user:/reserve'))
    expect(state.events.indexOf('admission:/admit')).toBeLessThan(state.events.indexOf('pool:/reserve'))
    state.close()
  })

  it('renews admission and pool leases in order while a synchronous body takes over 60 seconds', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-05T00:00:00.000Z') })
    const state = await harness()
    try {
      const encoded = new TextEncoder().encode(JSON.stringify({
        id: 'response-slow',
        object: 'response',
        model: 'gpt-upstream',
        usage: { input_tokens: 2, output_tokens: 3 },
      }))
      let markUpstreamRequested!: () => void
      const upstreamRequested = new Promise<void>((resolve) => {
        markUpstreamRequested = resolve
      })
      const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        markUpstreamRequested()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(encoded)
                controller.close()
              }, 65_000)
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      })

      const pendingResponse = createApp().request('/v1/responses', gatewayRequest(), state.env)
      await upstreamRequested
      expect(upstream).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(65_001)
      const response = await pendingResponse

      expect(response.status).toBe(200)
      expect(state.admission.calls.filter((call) => call.path === '/renew').map((call) =>
        call.body.renewal_sequence,
      )).toEqual([1, 2, 3])
      expect(state.pool.calls.filter((call) => call.path === '/renew').map((call) =>
        call.body.renewal_sequence,
      )).toEqual([1, 2, 3])
      // Billing reservations live for ten minutes, so a two-minute bounded read must not churn them.
      expect(state.user.calls.filter((call) => call.path === '/renew')).toEqual([])
      expect(state.user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
      expect(state.admission.calls.filter((call) => call.path === '/release')).toHaveLength(1)
      expect(state.pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    } finally {
      state.close()
      vi.useRealTimers()
    }
  })

  it('cancels a synchronous upstream at the total deadline and settles it as failed', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-05T00:00:00.000Z') })
    const state = await harness()
    try {
      let upstreamCancelled = false
      let markUpstreamRequested!: () => void
      const upstreamRequested = new Promise<void>((resolve) => {
        markUpstreamRequested = resolve
      })
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        markUpstreamRequested()
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const at of [30_000, 60_000, 90_000]) {
              setTimeout(() => controller.enqueue(new TextEncoder().encode(' ')), at)
            }
          },
          cancel() {
            upstreamCancelled = true
          },
        }), { headers: { 'content-type': 'application/json' } })
      })

      const pendingResponse = createApp().request('/v1/responses', gatewayRequest(), state.env)
      await upstreamRequested
      await vi.advanceTimersByTimeAsync(120_001)
      const response = await pendingResponse

      expect(response.status).toBe(504)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'upstream_timeout' },
      })
      expect(upstreamCancelled).toBe(true)
      expect(state.user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
      expect(state.user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        usage_event: { payload: { outcome: 'failed' } },
      })
      expect(state.admission.calls.filter((call) => call.path === '/release')).toHaveLength(1)
      expect(state.pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    } finally {
      state.close()
      vi.useRealTimers()
    }
  })

  it('releases the admission exactly once after downstream stream cancellation', async () => {
    const state = await harness()
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        upstream = controller
        controller.enqueue(encoder.encode(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        ))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await createApp().request('/v1/responses', gatewayRequest('/v1/responses', {
      model: 'gpt-public',
      input: 'hello',
      stream: true,
    }), state.env)
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const cancelled = reader.cancel('client disconnected')
    upstream.enqueue(encoder.encode(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}\n\n',
    ))
    await cancelled

    expect(state.admission.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    expect(state.pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    state.close()
  })

  it('releases the admission exactly once at a normal stream terminal event', async () => {
    const state = await harness()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await createApp().request('/v1/responses', gatewayRequest('/v1/responses', {
      model: 'gpt-public',
      input: 'hello',
      stream: true,
    }), state.env)
    expect(await response.text()).toContain('response.completed')

    expect(state.admission.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    expect(state.pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    state.close()
  })

  it('releases the admission exactly once when upstream fails', async () => {
    const state = await harness()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      error: { message: 'secret upstream diagnostic' },
    }, { status: 401 }))

    const response = await createApp().request('/v1/responses', gatewayRequest(), state.env)

    expect(response.status).toBe(502)
    expect(state.admission.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    const poolReleases = state.pool.calls.filter((call) => call.path === '/release')
    expect(poolReleases).toHaveLength(2)
    expect(new Set(poolReleases.map((call) => call.body.request_id)).size).toBe(2)
    state.close()
  })

  it.each([
    ['/v1/responses/input_tokens', { model: 'gpt-public', input: 'hello' }],
    ['/v1/messages/count_tokens', {
      model: 'gpt-public',
      messages: [{ role: 'user', content: 'hello' }],
    }],
    ['/v1beta/models/gpt-public:countTokens', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    }],
  ])('protects upstream token-count path %s with the same admission', async (path, body) => {
    const state = await harness()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ input_tokens: 2 }))

    const response = await createApp().request(path, gatewayRequest(path, body), state.env)

    expect(response.status).toBe(200)
    expect(state.user.calls.map((call) => call.path)).toEqual([
      '/configure', '/authorize', '/reserve', '/cancel',
    ])
    expect(state.admission.calls.map((call) => call.path)).toEqual([
      '/admit', '/monetary/configure', '/monetary/reserve', '/monetary/cancel', '/release',
    ])
    expect(state.events.indexOf('admission:/admit')).toBeLessThan(state.events.indexOf('user:/reserve'))
    expect(state.events.indexOf('user:/reserve')).toBeLessThan(state.events.indexOf('admission:/monetary/reserve'))
    expect(state.events.indexOf('admission:/monetary/reserve')).toBeLessThan(state.events.indexOf('pool:/reserve'))
    state.close()
  })

  it.each([
    {
      path: '/v1/responses/input_tokens',
      body: { model: 'gpt-public', input: 'hello' },
      expected: { error: { code: 'api_key_rate_limit_5h_exceeded' } },
      nativeCodeHeader: false,
    },
    {
      path: '/v1/messages/count_tokens',
      body: { model: 'gpt-public', messages: [{ role: 'user', content: 'hello' }] },
      expected: { error: { code: 'api_key_rate_limit_5h_exceeded' } },
      nativeCodeHeader: true,
    },
    {
      path: '/v1beta/models/gpt-public:countTokens',
      body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      expected: { error: { gateway_code: 'api_key_rate_limit_5h_exceeded' } },
      nativeCodeHeader: true,
    },
  ])('blocks token-count upstream fetch for exhausted key budget on $path', async ({
    path, body, expected, nativeCodeHeader,
  }) => {
    const state = await harness()
    state.admission.monetaryReserveResponse = Response.json({
      error: { code: 'api_key_rate_limit_5h_exceeded', message: '5h spend exhausted' },
      retry_after_seconds: 23,
    }, { status: 429, headers: { 'retry-after': '23' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await createApp().request(path, gatewayRequest(path, body), state.env)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('23')
    if (nativeCodeHeader) {
      expect(response.headers.get('x-error-code')).toBe('api_key_rate_limit_5h_exceeded')
    }
    await expect(response.json()).resolves.toMatchObject(expected)
    expect(state.user.calls.map((call) => call.path)).toEqual([
      '/configure', '/authorize', '/reserve', '/cancel',
    ])
    expect(state.admission.calls.map((call) => call.path)).toEqual([
      '/admit', '/monetary/configure', '/monetary/reserve', '/monetary/cancel', '/release',
    ])
    expect(state.pool.calls).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    state.close()
  })
})
