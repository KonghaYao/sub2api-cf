import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { encryptCredential } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import type { ModelRoute } from '../../src/gateway/types'

const masterKey = 'm'.repeat(32)
const accountId = 'account-1'
const secretId = 'secret-1'

const model: ModelRoute = {
  config_revision: 1,
  model_id: 'model-1',
  public_name: 'gpt-public',
  upstream_name: 'gpt-upstream',
  endpoint: 'both',
  embeddings: 1,
  price_id: 'price-1',
  price_version: 1,
  input_micros_per_million: 2_000_000,
  output_micros_per_million: 4_000_000,
  cache_read_micros_per_million: 500_000,
  per_request_micros: 0,
  minimum_reservation_micros: 1,
  rate_multiplier_ppm: 1_000_000,
  max_output_tokens: 16_384,
  default_max_output_tokens: 4_096,
}

class FakeStatement {
  private values: unknown[] = []

  constructor(
    readonly query: string,
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
    if (this.query.includes('FROM group_models gm')) {
      return { success: true, results: [model as T], meta: {} as D1Meta & Record<string, unknown> }
    }
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
            config_revision: 1,
            model_id: 'model-1',
          } as T,
        ],
        meta: {} as D1Meta & Record<string, unknown>,
      }
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

  async batch(statements: FakeStatement[]): Promise<D1Result<unknown>[]> {
    const values: D1Result<unknown>[] = []
    for (const statement of statements) {
      if (statement.query.includes('FROM account_groups ag')) {
        values.push(await statement.all())
      } else {
        const row = await statement.first()
        values.push({
          success: true,
          results: row === null ? [] : [row],
          meta: {} as D1Meta & Record<string, unknown>,
        })
      }
    }
    return values
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

  it('serves the root model-list compatibility alias', async () => {
    const { env } = await harness()
    const response = await createApp().request(
      '/models',
      { headers: { authorization: 'Bearer sk-customer' } },
      env,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      object: 'list',
      data: [{ id: 'gpt-public', object: 'model' }],
    })
  })

  it('accepts the Gemini x-goog-api-key header without allowing query credentials', async () => {
    const { env } = await harness()

    const response = await createApp().request('/v1/models', {
      headers: { 'x-goog-api-key': 'sk-customer' },
    }, env)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ object: 'list' })
  })

  it('serves a complete, cache-validatable Codex model manifest', async () => {
    const { env } = await harness()
    const app = createApp()

    const response = await app.request('/backend-api/codex/models', {
      headers: { authorization: 'Bearer sk-customer' },
    }, env)
    const manifest = await response.json() as { models: Array<Record<string, unknown>> }

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/)
    expect(manifest.models).toHaveLength(1)
    expect(manifest.models[0]).toMatchObject({
      slug: 'gpt-public',
      display_name: 'gpt-public',
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority: 50,
      supports_parallel_tool_calls: true,
      input_modalities: ['text'],
      model_messages: { instructions_template: expect.any(String) },
    })
    for (const key of [
      'default_service_tier', 'availability_nux', 'upgrade', 'default_verbosity',
      'apply_patch_tool_type', 'auto_compact_token_limit', 'comp_hash',
      'auto_review_model_override', 'model_specialty', 'tool_mode', 'multi_agent_version',
      'supports_image_detail_original', 'node_repl_auto_review_required', 'node_repl_disabled',
    ]) expect(manifest.models[0]).toHaveProperty(key)

    const cached = await app.request('/models?client_version=0.147.0', {
      headers: {
        authorization: 'Bearer sk-customer',
        'if-none-match': response.headers.get('etag')!,
      },
    }, env)
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
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

  it('atomically replaces Pool members with a versioned account snapshot', async () => {
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
      path: '/accounts/sync',
      body: expect.objectContaining({
        schema_version: 1,
        config_revision: 1,
        accounts: [
          {
            account_id: 'account-1',
            max_concurrency: 4,
            priority: 0,
            weight: 1,
          },
        ],
      }),
    })
  })

  it('routes an Anthropic Messages request through Responses without leaking the upstream model', async () => {
    const { env, user, pool } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'resp_anthropic_1',
        model: 'gpt-upstream',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello from Anthropic.' }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 4 },
        },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': 'sk-customer',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-public',
          max_tokens: 64,
          system: 'Be concise.',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'resp_anthropic_1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-public',
      content: [{ type: 'text', text: 'Hello from Anthropic.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4,
      },
    })
    expect(upstream).toHaveBeenCalledOnce()
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/responses')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-upstream',
      max_output_tokens: 64,
      stream: false,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Be concise.' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }],
        },
      ],
    })
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      amount_micros: 34,
      usage_event: {
        payload: {
          requested_model: 'gpt-public',
          upstream_model: 'gpt-upstream',
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 4,
          outcome: 'completed',
        },
      },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('returns Anthropic validation errors before reserving funds or upstream capacity', async () => {
    const { env, user, pool } = await harness()

    const response = await createApp().request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Hello' }],
          upstream_url: 'https://attacker.example/v1',
        }),
      },
      env,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    })
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('streams Anthropic Messages events and settles from the Responses terminal usage', async () => {
    const { env, user, pool } = await harness()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const frames = [
          { type: 'response.created', response: { id: 'resp_anthropic_stream' } },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
          { type: 'response.output_text.delta', output_index: 0, delta: 'Hi' },
          { type: 'response.output_text.done', output_index: 0 },
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              usage: {
                input_tokens: 8,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 3 },
              },
            },
          },
        ]
        return new Response(
          frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }),
    )

    const response = await createApp().request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      },
      env,
    )
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect([...text.matchAll(/^event: ([^\n]+)$/gm)].map((match) => match[1])).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(text).toContain('"model":"gpt-public"')
    expect(text).not.toContain('gpt-upstream')
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      amount_micros: 20,
      usage_event: {
        payload: {
          stream: true,
          input_tokens: 8,
          output_tokens: 2,
          cache_read_tokens: 3,
          outcome: 'completed',
        },
      },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('bridges Anthropic count_tokens to Responses input_tokens without billing the user', async () => {
    const { env, user, pool } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ object: 'response.input_tokens', input_tokens: 42 }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1/messages/count_tokens',
      {
        method: 'POST',
        headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          system: 'Be concise.',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ input_tokens: 42 })
    expect(upstream).toHaveBeenCalledOnce()
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/responses/input_tokens')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Be concise.' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }],
        },
      ],
    })
    expect(user.calls).toEqual([])
    expect(pool.calls.filter((call) => call.path === '/reserve')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('falls back to a positive local token estimate when input_tokens is unsupported', async () => {
    const { env, user, pool } = await harness()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { message: 'endpoint not found' } },
          { status: 404 },
        ),
      ),
    )

    const response = await createApp().request(
      '/messages/count_tokens',
      {
        method: 'POST',
        headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', messages: [] }),
      },
      env,
    )

    expect(response.status).toBe(200)
    const payload = await response.json() as { input_tokens: number }
    expect(payload.input_tokens).toBeGreaterThan(0)
    expect(user.calls).toEqual([])
    expect(pool.calls.some((call) => call.path === '/failure')).toBe(false)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('forwards Responses compact and Codex aliases through the normal billed gateway', async () => {
    const { env, user, pool } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'resp_compact',
        model: 'gpt-upstream',
        status: 'completed',
        output: [],
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    )
    vi.stubGlobal('fetch', upstream)
    const app = createApp()
    const request = (path: string) => app.request(
      path,
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', input: 'compact this' }),
      },
      env,
    )

    const codex = await request('/backend-api/codex/responses')
    const compact = await request('/v1/responses/compact')
    const codexCompact = await request('/backend-api/codex/responses/compact')

    expect([codex.status, compact.status, codexCompact.status]).toEqual([200, 200, 200])
    expect((await codex.json() as { model: string }).model).toBe('gpt-public')
    expect(upstream.mock.calls.map(([url]) => String(url))).toEqual([
      'https://upstream.example/v1/responses',
      'https://upstream.example/v1/responses/compact',
      'https://upstream.example/v1/responses/compact',
    ])
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(3)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(3)
  })

  it('serves native Responses input_tokens without reserving or charging balance', async () => {
    const { env, user, pool } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ object: 'response.input_tokens', input_tokens: 31 }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1/responses/input_tokens',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          instructions: 'Be concise.',
          input: [{ role: 'user', content: 'Hello' }],
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      object: 'response.input_tokens',
      input_tokens: 31,
    })
    expect(upstream).toHaveBeenCalledOnce()
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/responses/input_tokens')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'Hello' }],
    })
    expect(user.calls).toEqual([])
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('serves OpenAI embeddings through an embeddings-capable account and bills input only', async () => {
    const { env, user, pool } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        object: 'list',
        model: 'gpt-upstream',
        data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.5] }],
        usage: { prompt_tokens: 6, total_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1/embeddings',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', input: ['one', 'two'], encoding_format: 'float' }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ model: 'gpt-public' })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/embeddings')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      input: ['one', 'two'],
      encoding_format: 'float',
    })
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      amount_micros: 12,
      usage_event: { payload: { input_tokens: 6, output_tokens: 0 } },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('rejects streaming embeddings before reserving funds or upstream capacity', async () => {
    const { env, user, pool } = await harness()
    const response = await createApp().request(
      '/v1/embeddings',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', input: 'hello', stream: true }),
      },
      env,
    )

    expect(response.status).toBe(400)
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('bridges native Gemini generateContent to Responses and restores the public model', async () => {
    const { env, user } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'resp_gemini_1',
        model: 'gpt-upstream',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello from Gemini.' }],
        }],
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1beta/models/gpt-public:generateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'Hello from Gemini.' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 3,
        totalTokenCount: 10,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
      },
      modelVersion: 'gpt-public',
    })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/responses')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-upstream',
      stream: false,
      store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
    })
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      amount_micros: 26,
      usage_event: { payload: { requested_model: 'gpt-public', input_tokens: 7, output_tokens: 3 } },
    })
  })

  it('streams Gemini-native SSE from Responses terminal events', async () => {
    const { env, user } = await harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":1}}}\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })))

    const response = await createApp().request(
      '/v1beta/models/gpt-public:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] }),
      },
      env,
    )
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('"parts":[{"text":"Hi"}]')
    expect(text).toContain('"finishReason":"STOP"')
    expect(text).toContain('"modelVersion":"gpt-public"')
    expect(text).not.toContain('gpt-upstream')
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { stream: true, input_tokens: 4, output_tokens: 1 } },
    })
  })

  it('returns Gemini-native validation errors without reserving capacity', async () => {
    const { env, user, pool } = await harness()
    const response = await createApp().request(
      '/v1beta/models/gpt-public:generateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [], proxy_url: 'https://attacker.example' }),
      },
      env,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 400, status: 'INVALID_ARGUMENT' },
    })
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('lists and gets Gemini-native model metadata', async () => {
    const { env } = await harness()
    const app = createApp()
    const list = await app.request('/v1beta/models', {
      headers: { 'x-goog-api-key': 'sk-customer' },
    }, env)
    const detail = await app.request('/v1beta/models/gpt-public', {
      headers: { 'x-goog-api-key': 'sk-customer' },
    }, env)

    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      models: [{
        name: 'models/gpt-public',
        supportedGenerationMethods: expect.arrayContaining([
          'generateContent', 'streamGenerateContent', 'countTokens', 'embedContent',
        ]),
      }],
    })
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({ name: 'models/gpt-public' })
  })

  it('bridges Gemini countTokens to Responses input_tokens without charging balance', async () => {
    const { env, user, pool } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ input_tokens: 17 }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1beta/models/gpt-public:countTokens',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'How many?' }] }] }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ totalTokens: 17 })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/responses/input_tokens')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-upstream',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'How many?' }] }],
    })
    expect(user.calls).toEqual([])
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('bridges Gemini embedContent to OpenAI embeddings with native output', async () => {
    const { env, user } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => Response.json({
      object: 'list',
      model: 'gpt-upstream',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }))
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      '/v1beta/models/gpt-public:embedContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: 'Represent this sentence.' }] },
          outputDimensionality: 2,
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ embedding: { values: [0.1, 0.2] } })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/embeddings')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      input: 'Represent this sentence.',
      dimensions: 2,
      encoding_format: 'float',
    })
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { requested_model: 'gpt-public', input_tokens: 2, output_tokens: 0 } },
    })
  })
})
