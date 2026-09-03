import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { encryptCredential } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import type { ModelRoute } from '../../src/gateway/types'

const masterKey = 'm'.repeat(32)
const accountId = 'account-1'
const secretId = 'secret-1'

const model: ModelRoute = {
  model_id: 'model-1',
  public_name: 'gpt-public',
  upstream_name: 'gpt-upstream',
  endpoint: 'both',
  price_id: 'price-1',
  price_version: 1,
  input_micros_per_million: 2_000_000,
  output_micros_per_million: 4_000_000,
  cache_read_micros_per_million: 500_000,
  per_request_micros: 0,
  minimum_reservation_micros: 1,
  max_output_tokens: 16_384,
  default_max_output_tokens: 4_096,
}

class FakeStatement {
  private values: unknown[] = []

  constructor(
    private readonly query: string,
    private readonly database: FakeDatabase,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.values = values
    this.database.bindings.push({ query: this.query, values })
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM api_keys k')) return this.database.principal as T
    if (this.query.includes('FROM group_models gm')) return model as T
    if (this.query.includes('FROM accounts a') && this.query.includes('account_secrets')) {
      return this.database.credential as T
    }
    if (this.query.includes('FROM inbox')) return null
    if (this.query.includes('FROM settlement_recovery')) return this.database.recovery as T
    throw new Error(`Unexpected first query: ${this.query}`)
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.query.includes('INSERT INTO settlement_recovery')) {
      if (this.database.failRecoveryWrites) throw new Error('D1 unavailable')
      this.database.recovery = {
        user_id: this.values[1],
        amount_micros: this.values[2],
        usage_event_json: this.values[3],
      }
    } else if (this.query.includes('DELETE FROM settlement_recovery')) {
      this.database.recovery = null
    }
    return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.query.includes('FROM account_groups ag')) {
      return {
        success: true,
        results: [
          {
            account_id: accountId,
            base_url: 'https://upstream.example/v1',
            max_concurrency: 4,
            priority: 0,
            weight: 1,
            config_version: 1,
          } as T,
        ],
        meta: {} as D1Meta & Record<string, unknown>,
      }
    }
    if (this.query.includes('FROM group_models gm')) {
      return { success: true, results: [model as T], meta: {} as D1Meta & Record<string, unknown> }
    }
    throw new Error(`Unexpected all query: ${this.query}`)
  }
}

class FakeDatabase {
  readonly bindings: Array<{ query: string; values: unknown[] }> = []
  credential: Record<string, unknown> = {}
  recovery: Record<string, unknown> | null = null
  failRecoveryWrites = false
  readonly principal = {
    api_key_id: 'key-1',
    api_key_auth_version: 1,
    api_key_enabled: 1,
    expires_at_ms: null,
    revoked_at_ms: null,
    user_id: 'user-1',
    user_status: 'active',
    balance_micros: 1_000_000,
    user_state_version: 0,
    group_id: 'group-1',
    group_enabled: 1,
    platform: 'openai',
  }

  prepare(query: string): FakeStatement {
    return new FakeStatement(query, this)
  }
}

class FakeStateStub {
  readonly calls: Array<{ path: string; body: Record<string, unknown> }> = []
  settleFailures = 0
  snapshotAccounts: Array<Record<string, unknown>> = []

  constructor(private readonly kind: 'user' | 'pool') {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/snapshot') {
      return Response.json({ accounts: this.snapshotAccounts })
    }
    const body = (await request.json()) as Record<string, unknown>
    this.calls.push({ path, body })
    if (this.kind === 'pool' && path === '/reserve') {
      return Response.json({ lease: { account_id: accountId, status: 'active' } })
    }
    if (this.kind === 'user' && path === '/settle') {
      if (this.settleFailures > 0) {
        this.settleFailures -= 1
        return Response.json({ error: { code: 'temporary_failure', message: 'retry' } }, { status: 503 })
      }
      return Response.json({ profile: { balance_micros: 999_960, settled_micros: 40 } })
    }
    return Response.json({})
  }
}

async function harness(): Promise<{
  env: Env
  database: FakeDatabase
  user: FakeStateStub
  pool: FakeStateStub
  poolNames: string[]
  queued: unknown[]
}> {
  const database = new FakeDatabase()
  const encrypted = await encryptCredential(
    { api_key: 'sk-upstream-secret' },
    masterKey,
    `test/${accountId}/${secretId}/1`,
  )
  database.credential = {
    account_id: accountId,
    base_url: 'https://upstream.example/v1',
    auth_scheme: 'bearer',
    secret_id: secretId,
    key_version: 1,
    ...encrypted,
  }
  const user = new FakeStateStub('user')
  const pool = new FakeStateStub('pool')
  const poolNames: string[] = []
  const queued: unknown[] = []
  const namespace = (stub: FakeStateStub, names?: string[]) =>
    ({
      idFromName: (name: string) => {
        names?.push(name)
        return name
      },
      get: () => stub,
    }) as unknown as DurableObjectNamespace
  const env: Env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: 'p'.repeat(32),
    CREDENTIALS_MASTER_KEY: masterKey,
    DB: database as unknown as D1Database,
    USER_STATE: namespace(user),
    POOL_STATE: namespace(pool, poolNames),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: { send: async (value: unknown) => void queued.push(value) } as unknown as Queue,
  }
  return { env, database, user, pool, poolNames, queued }
}

describe('OpenAI-compatible gateway', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('rejects missing and query-string credentials before any state mutation', async () => {
    const { env, user } = await harness()

    const missing = await createApp().request('/v1/models', {}, env)
    const query = await createApp().request('/v1/models?api_key=secret', {}, env)

    expect(missing.status).toBe(401)
    expect(query.status).toBe(400)
    expect(user.calls).toEqual([])
  })

  it('rejects client transport controls before reserving funds or capacity', async () => {
    const { env, user, pool } = await harness()
    const response = await createApp().request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', proxy_url: 'http://127.0.0.1:7897' }),
      },
      env,
    )

    expect(response.status).toBe(400)
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('replaces customer credentials and model names on a synchronous request', async () => {
    const { env, database, user, pool, poolNames } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) =>
      Response.json({
        id: 'chatcmpl-1',
        model: 'gpt-upstream',
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', messages: [{ role: 'user', content: 'hi' }] }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ model: 'gpt-public' })
    expect(upstream).toHaveBeenCalledOnce()
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-upstream-secret')
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-upstream' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 4_096 })
    expect(poolNames).toContain(
      'group:group-1:platform:openai:model:model-1:endpoint:chat_completions:shard:0',
    )
    expect(JSON.stringify(database.bindings)).not.toContain('sk-customer')

    const settlement = user.calls.find((call) => call.path === '/settle')
    expect(settlement?.body).toMatchObject({ amount_micros: 40 })
    expect(settlement?.body.usage_event).toMatchObject({
      event_type: 'usage.settled.v1',
      payload: { input_tokens: 10, output_tokens: 5, account_id: accountId },
    })
    expect(pool.calls.some((call) => call.path === '/release')).toBe(true)
  })

  it('streams complete SSE frames and settles from the terminal usage event', async () => {
    const { env, user, pool } = await harness()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"model":"gpt-upstream","choices":[{"delta":{"content":"he'))
            controller.enqueue(new TextEncoder().encode('llo"}}]}\n\ndata: {"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n'))
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return new Response(source, { headers: { 'content-type': 'text/event-stream' } })
      }),
    )

    const response = await createApp().request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, messages: [] }),
      },
      env,
    )
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toContain('"model":"gpt-public"')
    expect(text).toContain('data: [DONE]')
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      amount_micros: 24,
      usage_event: { payload: { stream: true, input_tokens: 8, output_tokens: 2 } },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('does not corrupt a completed stream when every settlement path is unavailable', async () => {
    const { env, database, user, pool } = await harness()
    database.failRecoveryWrites = true
    user.settleFailures = 3
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    )

    const response = await createApp().request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, messages: [] }),
      },
      env,
    )
    const text = await response.text()

    expect(text).toContain('data: [DONE]')
    expect(text).not.toContain('upstream_stream_error')
    expect(pool.calls.some((call) => call.path === '/failure')).toBe(false)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('maps upstream auth failures to a sanitized 502 and releases both reservations', async () => {
    const { env, user, pool } = await harness()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { message: 'secret upstream diagnostic' } },
          { status: 401, headers: { 'retry-after': '999999999' } },
        ),
      ),
    )

    const response = await createApp().request(
      '/v1/responses',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
      },
      env,
    )
    const text = await response.text()

    expect(response.status).toBe(502)
    expect(text).toContain('upstream_auth_error')
    expect(text).not.toContain('secret upstream diagnostic')
    expect(user.calls.some((call) => call.path === '/cancel')).toBe(true)
    expect(pool.calls.some((call) => call.path === '/release')).toBe(true)
  })

  it('marks a truncated SSE response failed and appends a protocol error event', async () => {
    const { env, user } = await harness()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
                ),
              )
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    )

    const response = await createApp().request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, messages: [] }),
      },
      env,
    )
    const text = await response.text()

    expect(text).toContain('upstream_stream_error')
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { outcome: 'failed' } },
    })
  })

  it('persists a recovery command when settlement is temporarily unavailable', async () => {
    const { env, database, user, queued } = await harness()
    user.settleFailures = 3
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          model: 'gpt-upstream',
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
      ),
    )

    const response = await createApp().request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', messages: [] }),
      },
      env,
    )

    expect(response.status).toBe(200)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(3)
    expect(database.recovery).not.toBeNull()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ event_type: 'settlement.retry.v1' })
  })

  it('disables stale Pool members before adding the current account snapshot', async () => {
    const { env, pool } = await harness()
    pool.snapshotAccounts = [
      { account_id: 'stale-account', enabled: true, max_concurrency: 9 },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ model: 'gpt-upstream', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ),
    )

    await createApp().request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', messages: [] }),
      },
      env,
    )

    expect(pool.calls).toContainEqual({
      path: '/accounts/upsert',
      body: {
        schema_version: 1,
        account_id: 'stale-account',
        enabled: false,
        max_concurrency: 9,
      },
    })
  })
})
