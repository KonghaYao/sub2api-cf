import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { encryptCredential } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import type { ModelRoute } from '../../src/gateway/types'

const masterKey = 'm'.repeat(32)
const accountId = 'account-1'
const secretId = 'secret-1'
const maxGatewayRequestBytes = 2 * 1024 * 1024

const model: ModelRoute = {
  config_revision: 1,
  platform: 'openai',
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
  group_rate_multiplier_ppm: 1_000_000,
  user_rate_multiplier_ppm: null,
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
    if (this.query.includes('FROM group_models gm')) {
      return { ...model, platform: this.database.principal.platform } as T
    }
    if (this.query.includes('FROM accounts a') && this.query.includes('account_secrets')) {
      if (this.database.chatOnly && this.query.includes('am.responses = 1')) return null
      if (this.database.responsesOnly && this.query.includes('am.chat_completions = 1')) return null
      const requestedAccountId = this.values[0]
      const credential = requestedAccountId === accountId
        ? this.database.credential
        : this.database.additionalCredentials.get(String(requestedAccountId))
      return (credential ?? null) as T | null
    }
    if (this.query.includes('FROM inbox')) return null
    if (this.query.includes('FROM settlement_recovery')) return this.database.recovery as T
    throw new Error(`Unexpected first query: ${this.query}`)
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.query.includes('INSERT INTO settlement_recovery')) {
      if (this.database.failRecoveryWrites) throw new Error('D1 unavailable')
      this.database.recovery = {
        request_id: this.values[0],
        user_id: this.values[1],
        billing_type: this.values[2],
        subscription_id: this.values[3],
        api_key_id: this.values[4],
        amount_micros: this.values[5],
        usage_event_json: this.values[6],
        attempts: 0,
        billing_settled: 0,
        api_key_settled: 0,
        api_key_usage_json: null,
        api_key_projected: 0,
      }
    } else if (this.query.includes('SET billing_settled = 1')) {
      if (this.database.recovery !== null) this.database.recovery.billing_settled = 1
    } else if (this.query.includes('SET api_key_settled = 1')) {
      if (this.database.recovery !== null) {
        this.database.recovery.api_key_settled = 1
        this.database.recovery.api_key_usage_json = this.values[0]
      }
    } else if (this.query.includes('SET api_key_projected = 1')) {
      if (this.database.recovery !== null) this.database.recovery.api_key_projected = 1
    } else if (this.query.includes('DELETE FROM settlement_recovery')) {
      this.database.recovery = null
    }
    return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.query.includes('FROM group_models gm')) {
      return {
        success: true,
        results: [{ ...model, platform: this.database.principal.platform } as T],
        meta: {} as D1Meta & Record<string, unknown>,
      }
    }
    if (this.query.includes('FROM account_groups ag')) {
      if (this.database.chatOnly && this.query.includes('am.responses = 1')) {
        return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
      }
      if (this.database.responsesOnly && this.query.includes('am.chat_completions = 1')) {
        return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
      }
      const credentials = [
        this.database.credential,
        ...this.database.additionalCredentials.values(),
      ]
      return {
        success: true,
        results: credentials.map((credential) =>
          ({
            account_id: credential.account_id,
            platform: credential.platform,
            protocol: credential.protocol,
            auth_scheme: credential.auth_scheme,
            provider_config_json: credential.provider_config_json,
            base_url: credential.base_url,
            max_concurrency: 4,
            priority: 0,
            weight: 1,
            config_version: 1,
            config_revision: 1,
            model_id: 'model-1',
          } as T)),
        meta: {} as D1Meta & Record<string, unknown>,
      }
    }
    throw new Error(`Unexpected all query: ${this.query}`)
  }
}

class FakeDatabase {
  readonly bindings: Array<{ query: string; values: unknown[] }> = []
  credential: Record<string, unknown> = {}
  readonly additionalCredentials = new Map<string, Record<string, unknown>>()
  recovery: Record<string, unknown> | null = null
  failRecoveryWrites = false
  chatOnly = false
  responsesOnly = false
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
    limit_config_version: 1,
    concurrency_limit: 0,
    user_rpm_limit: 0,
    group_rpm_limit: 0,
    api_key_control_version: 0,
    quota_micros: 0,
    quota_used_micros: 0,
    rate_limit_5h_micros: 0,
    rate_limit_1d_micros: 0,
    rate_limit_7d_micros: 0,
    usage_5h_micros: 0,
    usage_1d_micros: 0,
    usage_7d_micros: 0,
    window_5h_start_ms: null,
    window_1d_start_ms: null,
    window_7d_start_ms: null,
    api_key_quota_reset_epoch: 0,
    api_key_rate_limit_reset_epoch: 0,
    group_id: 'group-1',
    group_enabled: 1,
    group_accessible: 1,
    platform: 'openai',
    group_type: 'standard',
    subscription_id: null,
  }

  prepare(query: string): FakeStatement {
    return new FakeStatement(query, this)
  }

  async batch(statements: FakeStatement[]): Promise<D1Result<unknown>[]> {
    const values: D1Result<unknown>[] = []
    for (const statement of statements) {
      if (statement.query.includes('FROM account_groups ag')) {
        values.push(await statement.all())
      } else if (statement.query.includes('UPDATE api_keys')) {
        values.push(await statement.run())
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
  readonly affinityAccounts = new Map<string, string>()
  reserveAccountIds: string[] = []

  constructor(private readonly kind: 'user' | 'subscription' | 'pool' | 'limit') {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/snapshot') {
      return Response.json({ accounts: this.snapshotAccounts })
    }
    const body = (await request.json()) as Record<string, unknown>
    this.calls.push({ path, body })
    if (this.kind === 'pool' && path === '/reserve') {
      const affinityKey = typeof body.affinity_key === 'string' ? body.affinity_key : undefined
      const selected = this.reserveAccountIds.shift() ??
        (affinityKey === undefined ? undefined : this.affinityAccounts.get(affinityKey)) ??
        accountId
      if (affinityKey !== undefined) this.affinityAccounts.set(affinityKey, selected)
      return Response.json({ lease: { account_id: selected, status: 'active' } })
    }
    if (this.kind === 'pool' && path === '/failure') {
      for (const [affinityKey, boundAccountId] of this.affinityAccounts) {
        if (boundAccountId === body.account_id) this.affinityAccounts.delete(affinityKey)
      }
      return Response.json({})
    }
    if (this.kind === 'user' && path === '/settle') {
      if (this.settleFailures > 0) {
        this.settleFailures -= 1
        return Response.json({ error: { code: 'temporary_failure', message: 'retry' } }, { status: 503 })
      }
      return Response.json({ profile: { balance_micros: 999_960, settled_micros: 40 } })
    }
    if (this.kind === 'limit' && path === '/admit') {
      return Response.json({ admitted: true, lease: { request_id: body.request_id, status: 'active' } })
    }
    if (this.kind === 'limit' && path === '/monetary/settle') {
      return Response.json({ usage: {
        api_key_id: 'key-1',
        quota_reset_epoch: 0,
        rate_limit_reset_epoch: 0,
        total_settled_micros: 40,
        active_reserved_micros: 0,
        windows: (['5h', '1d', '7d'] as const).map((window) => ({
          api_key_id: 'key-1', kind: window, window_started_at_ms: 1,
          settled_micros: 40, updated_at_ms: 1,
        })),
      } })
    }
    return Response.json({})
  }
}

async function harness(): Promise<{
  env: Env
  database: FakeDatabase
  user: FakeStateStub
  subscription: FakeStateStub
  pool: FakeStateStub
  limit: FakeStateStub
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
    platform: 'openai',
    protocol: 'openai',
    base_url: 'https://upstream.example/v1',
    auth_scheme: 'bearer',
    provider_config_json: '{}',
    secret_id: secretId,
    key_version: 1,
    ...encrypted,
  }
  const user = new FakeStateStub('user')
  const subscription = new FakeStateStub('subscription')
  const pool = new FakeStateStub('pool')
  const limit = new FakeStateStub('limit')
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
    SUBSCRIPTION_STATE: namespace(subscription),
    POOL_STATE: namespace(pool, poolNames),
    API_KEY_LIMIT_STATE: namespace(limit),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: { send: async (value: unknown) => void queued.push(value) } as unknown as Queue,
  }
  return { env, database, user, subscription, pool, limit, poolNames, queued }
}

async function addGatewayAccount(
  database: FakeDatabase,
  addedAccountId: string,
  baseUrl: string,
): Promise<void> {
  const addedSecretId = `secret-${addedAccountId}`
  const encrypted = await encryptCredential(
    { api_key: `sk-${addedAccountId}` },
    masterKey,
    `test/${addedAccountId}/${addedSecretId}/1`,
  )
  database.additionalCredentials.set(addedAccountId, {
    account_id: addedAccountId,
    platform: 'openai',
    protocol: 'openai',
    base_url: baseUrl,
    auth_scheme: 'bearer',
    provider_config_json: '{}',
    secret_id: addedSecretId,
    key_version: 1,
    ...encrypted,
  })
}

async function compressGatewayBody(
  format: 'gzip' | 'deflate',
  body: string,
): Promise<ArrayBuffer> {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream(format))
  return new Response(stream).arrayBuffer()
}

async function readStreamToTextWithin(response: Response, milliseconds = 250): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let output = ''
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('response stream did not finish')), milliseconds)
        }),
      ])
      if (result.done) return output + decoder.decode()
      output += decoder.decode(result.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

function captureExecutionContext(): {
  executionCtx: ExecutionContext
  tasks: Promise<unknown>[]
} {
  const tasks: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil(task: Promise<unknown>) {
      tasks.push(task)
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext
  return { executionCtx, tasks }
}

function expectZeroCostBillingLifecycle(user: FakeStateStub): void {
  expect(user.calls.map((call) => call.path)).toEqual([
    '/configure', '/authorize', '/reserve', '/cancel',
  ])
  expect(user.calls.find((call) => call.path === '/reserve')?.body).toMatchObject({
    amount_micros: 0,
  })
  expect(user.calls.some((call) => call.path === '/settle')).toBe(false)
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

  it('stops reading and cancels an unknown-length request as soon as it exceeds the limit', async () => {
    const { env, user, pool } = await harness()
    let pulls = 0
    let cancelled = false
    let finishPendingPull: (() => void) | undefined
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls <= 2) {
          controller.enqueue(new Uint8Array(maxGatewayRequestBytes / 2).fill(0x20))
        } else if (pulls === 3) {
          controller.enqueue(new Uint8Array([0x20]))
        } else {
          return new Promise<void>((resolve) => {
            finishPendingPull = resolve
          })
        }
      },
      cancel() {
        cancelled = true
        finishPendingPull?.()
      },
    })
    const request = new Request('https://gateway.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: source,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    const response = await createApp().request(request, undefined, env)

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'request_too_large', type: 'invalid_request_error' },
    })
    // The stream implementation may prefetch one pull, but it must not keep
    // consuming the attacker-controlled body after the first excess byte.
    expect(pulls).toBeLessThanOrEqual(4)
    expect(cancelled).toBe(true)
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('accepts the original gateway leniency for a UTF-8 BOM and raw control bytes inside strings', async () => {
    const { env, database } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => Response.json({
      model: 'gpt-upstream',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))
    vi.stubGlobal('fetch', upstream)
    const body = '\uFEFF{"model":"gpt-public","messages":[{"role":"user","content":"hello\u0000world\u001b"}]}'

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body,
    }, env)

    expect(response.status).toBe(200)
    const [, init] = upstream.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      messages: [{ role: 'user', content: 'hello\u0000world\u001b' }],
    })
    expect(database.bindings.some(({ query }) =>
      query.includes('INSERT INTO request_observations'))).toBe(true)
    expect(database.bindings.some(({ query, values }) =>
      query.includes('UPDATE request_observations') && values[0] === 'completed')).toBe(true)
  })

  it.each(['gzip', 'deflate'] as const)('accepts a bounded %s-compressed JSON request', async (encoding) => {
    const { env } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => Response.json({
      model: 'gpt-upstream',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))
    vi.stubGlobal('fetch', upstream)
    const body = JSON.stringify({
      model: 'gpt-public',
      messages: [{ role: 'user', content: `hello from ${encoding}` }],
    })

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'content-encoding': encoding,
      },
      body: await compressGatewayBody(encoding, body),
    }, env)

    expect(response.status).toBe(200)
    const [, init] = upstream.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-upstream',
      messages: [{ role: 'user', content: `hello from ${encoding}` }],
    })
    expect(new Headers(init?.headers).has('content-encoding')).toBe(false)
  })

  it('preserves an explicitly identity-encoded request', async () => {
    const { env } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => Response.json({
      model: 'gpt-upstream',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'content-encoding': 'identity',
      },
      body: JSON.stringify({ model: 'gpt-public', messages: [] }),
    }, env)

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
  })

  it.each(['br', 'gzip, deflate'])('rejects unsupported Content-Encoding %s before reservation', async (encoding) => {
    const { env, user, pool } = await harness()

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'content-encoding': encoding,
      },
      body: JSON.stringify({ model: 'gpt-public', messages: [] }),
    }, env)

    expect(response.status).toBe(415)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unsupported_content_encoding', type: 'invalid_request_error' },
    })
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('returns a sanitized error for a corrupt compressed stream before reservation', async () => {
    const { env, user, pool } = await harness()

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]).buffer,
    }, env)
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(text).toContain('invalid_compressed_body')
    expect(text).not.toContain('incorrect header')
    expect(text).not.toContain('unexpected end')
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('stops a compressed-body expansion at the decompressed request limit', async () => {
    const { env, user, pool } = await harness()
    const expanded = JSON.stringify({
      model: 'gpt-public',
      messages: [{ role: 'user', content: 'x'.repeat(maxGatewayRequestBytes) }],
    })
    const compressed = await compressGatewayBody('gzip', expanded)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: compressed,
    }, env)

    expect(compressed.byteLength).toBeLessThan(maxGatewayRequestBytes)
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'request_too_large', type: 'invalid_request_error' },
    })
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('applies the request limit again after lenient JSON normalization', async () => {
    const { env, user, pool } = await harness()
    const body = `{"model":"gpt-public","messages":[{"role":"user","content":"${'\u0000'.repeat(350_000)}"}]}`

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body,
    }, env)

    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(maxGatewayRequestBytes)
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'request_too_large', type: 'invalid_request_error' },
    })
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('keeps malformed JSON with a control byte outside a string invalid', async () => {
    const { env, database, user, pool } = await harness()

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: '{"model":"gpt-public",\u0000"messages":[]}',
    }, env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_json', type: 'invalid_request_error' },
    })
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
    expect(database.bindings.some(({ query }) => query.includes('INSERT INTO request_observations'))).toBe(true)
    expect(database.bindings.some(({ query }) => query.includes("lifecycle = ?"))).toBe(true)
  })

  it('sanitizes request-stream read failures before any reservation or upstream call', async () => {
    const { env, user, pool } = await harness()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('secret transport failure')
      },
    })
    const request = new Request('https://gateway.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
      },
      body: source,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    const response = await createApp().request(request, undefined, env)
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(text).toContain('request_body_read_error')
    expect(text).not.toContain('secret transport failure')
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
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
        body: JSON.stringify({
          model: 'gpt-public', messages: [{ role: 'user', content: 'hi' }],
          service_tier: ' FAST ',
        }),
      },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ model: 'gpt-public' })
    expect(upstream).toHaveBeenCalledOnce()
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-upstream-secret')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-upstream', service_tier: 'priority',
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 4_096 })
    expect(poolNames).toContain(
      'group:group-1:platform:openai:model:model-1:endpoint:chat_completions:shard:0',
    )
    expect(JSON.stringify(database.bindings)).not.toContain('sk-customer')

    const settlement = user.calls.find((call) => call.path === '/settle')
    expect(settlement?.body).toMatchObject({ amount_micros: 80 })
    expect(settlement?.body.usage_event).toMatchObject({
      event_type: 'usage.settled.v1',
      payload: { input_tokens: 10, output_tokens: 5, account_id: accountId },
    })
    expect(pool.calls.some((call) => call.path === '/release')).toBe(true)
  })

  it('passes scale to native Responses and rejects invalid tiers before reservations', async () => {
    const { env, user } = await harness()
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'resp-scale',
        object: 'response',
        model: 'gpt-upstream',
        status: 'completed',
        service_tier: 'scale',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const accepted = await createApp().request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello', service_tier: ' SCALE ' }),
    }, env)
    expect(accepted.status).toBe(200)
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toMatchObject({
      model: 'gpt-upstream', service_tier: 'scale',
    })
    const reservationsBeforeInvalid = user.calls.filter((call) => call.path === '/reserve').length

    const rejected = await createApp().request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello', service_tier: 'turbo' }),
    }, env)
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'invalid_service_tier' } })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(user.calls.filter((call) => call.path === '/reserve')).toHaveLength(
      reservationsBeforeInvalid,
    )
  })

  it('bridges a Responses request through a Chat Completions-only account', async () => {
    const { env, database, user, poolNames } = await harness()
    database.chatOnly = true
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'chatcmpl-fallback',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'gpt-upstream',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'hello from chat' },
        }],
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        instructions: 'Be concise.',
        input: 'hello',
        max_output_tokens: 77,
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: 'chatcmpl-fallback',
      object: 'response',
      model: 'gpt-public',
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'hello from chat' }],
      }],
      usage: { input_tokens: 6, output_tokens: 3, total_tokens: 9 },
    })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://upstream.example/v1/chat/completions')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-upstream',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hello' },
      ],
      max_completion_tokens: 77,
      stream: false,
    })
    expect(poolNames).toContain(
      'group:group-1:platform:openai:model:model-1:endpoint:chat_completions:shard:0',
    )
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { input_tokens: 6, output_tokens: 3 } },
    })
  })

  it('restores custom, namespace, and tool-search identity through a buffered Chat-only fallback', async () => {
    const { env, database } = await harness()
    database.chatOnly = true
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'chatcmpl-tools-fallback',
        object: 'chat.completion',
        created: 1_700_000_001,
        model: 'gpt-upstream',
        service_tier: 'priority',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_shell',
                type: 'function',
                function: { name: 'shell', arguments: '{"input":"pwd"}' },
              },
              {
                id: 'call_team',
                type: 'function',
                function: { name: 'team__send', arguments: '{"message":"hi"}' },
              },
              {
                id: 'call_search',
                type: 'function',
                function: { name: 'tool_search', arguments: '{"query":"deploy"}' },
              },
            ],
          },
        }],
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        input: 'run tools',
        service_tier: '  FAST ',
        tools: [
          { type: 'custom', name: 'shell', format: { type: 'text' }, dangerous: 'drop-me' },
          {
            type: 'namespace',
            name: 'team',
            tools: [{ type: 'function', name: 'send', parameters: { type: 'object' } }],
          },
          { type: 'tool_search' },
        ],
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      object: 'response',
      model: 'gpt-public',
      service_tier: 'priority',
      output: [
        {
          type: 'custom_tool_call',
          call_id: 'call_shell',
          name: 'shell',
          input: 'pwd',
        },
        {
          type: 'function_call',
          call_id: 'call_team',
          namespace: 'team',
          name: 'send',
          arguments: '{"message":"hi"}',
        },
        {
          type: 'tool_search_call',
          call_id: 'call_search',
          execution: 'client',
          arguments: { query: 'deploy' },
        },
      ],
    })
    const [, init] = upstream.mock.calls[0]
    const upstreamBody = JSON.parse(String(init?.body))
    expect(upstreamBody).toMatchObject({
      service_tier: 'priority',
      tools: [
        { type: 'function', function: { name: 'shell' } },
        { type: 'function', function: { name: 'team__send' } },
        { type: 'function', function: { name: 'tool_search' } },
      ],
    })
    expect(JSON.stringify(upstreamBody)).not.toContain('dangerous')
  })

  it('rejects ambiguous custom tool mappings before reserving funds or upstream capacity', async () => {
    const { env, database, user, pool } = await harness()
    database.chatOnly = true
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        input: 'run tool',
        tools: [
          { type: 'custom', name: 'shell' },
          { type: 'function', name: 'shell', parameters: { type: 'object' } },
        ],
      }),
    }, env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'invalid_request_error' },
    })
    expect(upstream).not.toHaveBeenCalled()
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('bridges Chat Completions SSE into a terminal Responses event stream', async () => {
    const { env, database, user } = await harness()
    database.chatOnly = true
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"id":"chatcmpl-stream-fallback","object":"chat.completion.chunk","created":1700000000,"model":"gpt-upstream","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })))

    const response = await createApp().request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello', stream: true }),
    }, env)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('event: response.created')
    expect(text).toContain('event: response.output_text.delta')
    expect(text).toContain('event: response.completed')
    expect(text).toContain('"model":"gpt-public"')
    expect(text).not.toContain('gpt-upstream')
    expect(text).not.toContain('[DONE]')
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { stream: true, input_tokens: 4, output_tokens: 2 } },
    })
  })

  it('restores custom tool identity through a streaming Chat-only fallback', async () => {
    const { env, database } = await harness()
    database.chatOnly = true
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"id":"chatcmpl-custom","service_tier":"flex","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_exec","type":"function","function":{"name":"exec","arguments":"{\\"input\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })))

    const response = await createApp().request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        input: 'run pwd',
        stream: true,
        tools: [{ type: 'custom', name: 'exec' }],
      }),
    }, env)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('event: response.custom_tool_call_input.done')
    expect(text).toContain('"type":"custom_tool_call"')
    expect(text).toContain('"call_id":"call_exec"')
    expect(text).toContain('"input":"pwd"')
    expect(text).toContain('"service_tier":"flex"')
    expect(text).not.toContain('event: response.function_call_arguments')
  })

  it('charges an active subscription at the effective rate without touching balance state', async () => {
    const { env, database, user, subscription } = await harness()
    const now = Date.now()
    Object.assign(database.principal, {
      group_type: 'subscription',
      subscription_id: 'subscription-1',
      subscription_starts_at_ms: now - 1_000,
      subscription_expires_at_ms: now + 86_400_000,
      daily_quota_micros: 1_000_000,
      weekly_quota_micros: 2_000_000,
      monthly_quota_micros: 3_000_000,
      daily_used_micros: 0,
      weekly_used_micros: 0,
      monthly_used_micros: 0,
      daily_anchor_ms: 0,
      daily_window_start_ms: null,
      weekly_window_start_ms: null,
      monthly_window_start_ms: null,
      quota_reset_epoch: 0,
      quota_reset_generation: 0,
      subscription_control_version: 0,
    })
    const originalMultiplier = model.rate_multiplier_ppm
    model.rate_multiplier_ppm = 800_000
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      model: 'gpt-upstream',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })))

    try {
      const response = await createApp().request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', messages: [] }),
      }, env)

      expect(response.status).toBe(200)
      expect(user.calls).toEqual([])
      expect(subscription.calls.map((call) => call.path)).toEqual([
        '/configure',
        '/authorize',
        '/reserve',
        '/settle',
      ])
      expect(subscription.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        amount_micros: 32,
        usage_event: {
          payload: {
            billing_type: 'subscription',
            subscription_id: 'subscription-1',
            amount_micros: 32,
          },
        },
      })

      subscription.calls.length = 0
      model.rate_multiplier_ppm = 0
      const freeResponse = await createApp().request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', messages: [] }),
      }, env)
      expect(freeResponse.status).toBe(200)
      expect(subscription.calls.find((call) => call.path === '/reserve')?.body).toMatchObject({
        amount_micros: 0,
      })
      expect(subscription.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        amount_micros: 0,
      })
    } finally {
      model.rate_multiplier_ppm = originalMultiplier
    }
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

  it('finishes a Responses stream at its terminal event without waiting for upstream EOF', async () => {
    const { env, user, pool } = await harness()
    let upstreamCancelled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
            ))
          },
          cancel() {
            upstreamCancelled = true
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )),
    )

    const response = await createApp().request(
      '/v1/responses',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, input: 'hello' }),
      },
      env,
    )
    const text = await readStreamToTextWithin(response)

    expect(text).toContain('event: response.completed')
    expect(upstreamCancelled).toBe(true)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { input_tokens: 5, output_tokens: 2, outcome: 'completed' } },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('recognizes an event-named Responses terminal when data omits type', async () => {
    const { env, user, pool } = await harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":6,"output_tokens":2}}}\n\n',
          ))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )))

    const response = await createApp().request(
      '/v1/responses',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, input: 'hello' }),
      },
      env,
    )
    const text = await readStreamToTextWithin(response)

    expect(text).toContain('event: response.completed')
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { input_tokens: 6, output_tokens: 2, outcome: 'completed' } },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it.each([
    {
      protocol: 'Chat Completions',
      path: '/v1/chat/completions',
      headers: new Headers({ authorization: 'Bearer sk-customer', 'content-type': 'application/json' }),
      body: { model: 'gpt-public', stream: true, messages: [] },
      upstream: 'data: {"model":"gpt-upstream","usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      terminal: 'data: [DONE]',
    },
    {
      protocol: 'Anthropic Messages',
      path: '/v1/messages',
      headers: new Headers({ 'x-api-key': 'sk-customer', 'content-type': 'application/json' }),
      body: {
        model: 'gpt-public',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      },
      upstream: 'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      terminal: 'event: message_stop',
    },
    {
      protocol: 'Responses-from-Chat bridge',
      path: '/v1/responses',
      headers: new Headers({ authorization: 'Bearer sk-customer', 'content-type': 'application/json' }),
      body: { model: 'gpt-public', stream: true, input: 'Hello' },
      upstream: [
        'data: {"id":"chatcmpl-terminal","model":"gpt-upstream","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      terminal: 'event: response.completed',
      chatOnly: true,
    },
    {
      protocol: 'Gemini generateContent',
      path: '/v1beta/models/gpt-public:streamGenerateContent?alt=sse',
      headers: new Headers({ 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' }),
      body: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
      upstream: 'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      terminal: '"finishReason":"STOP"',
    },
  ])('finishes $protocol output at the protocol terminal without upstream EOF', async ({
    path,
    headers,
    body,
    upstream,
    terminal,
    chatOnly,
  }) => {
    const { env, database, user, pool } = await harness()
    database.chatOnly = chatOnly === true
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(upstream))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )))

    const response = await createApp().request(
      path,
      { method: 'POST', headers, body: JSON.stringify(body) },
      env,
    )
    const text = await readStreamToTextWithin(response)

    expect(text).toContain(terminal)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('drains a cancelled client stream in waitUntil and settles terminal usage exactly', async () => {
    const { env, user, pool } = await harness()
    const background = captureExecutionContext()
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let upstreamCancelled = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller
          controller.enqueue(new TextEncoder().encode(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          ))
        },
        cancel() {
          upstreamCancelled = true
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )))

    const response = await createApp().request(
      '/v1/responses',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, input: 'hello' }),
      },
      env,
      background.executionCtx,
    )
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('partial')

    await reader.cancel('client disconnected')
    expect(background.tasks).toHaveLength(1)
    upstreamController!.enqueue(new TextEncoder().encode(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":13,"output_tokens":5}}}\n\n',
    ))
    await Promise.all(background.tasks)

    expect(upstreamCancelled).toBe(true)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: {
          input_tokens: 13,
          output_tokens: 5,
          estimated: false,
          outcome: 'cancelled',
        },
      },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('bounds a cancelled-stream drain and falls back to estimated usage', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-04T00:00:00.000Z') })
    try {
      const { env, user, pool } = await harness()
      const background = captureExecutionContext()
      let upstreamCancelled = false
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
            ))
          },
          cancel() {
            upstreamCancelled = true
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )))

      const response = await createApp().request(
        '/v1/responses',
        {
          method: 'POST',
          headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-public', stream: true, input: 'hello' }),
        },
        env,
        background.executionCtx,
      )
      const reader = response.body!.getReader()
      await reader.read()
      const pendingClientRead = reader.read()
      await Promise.resolve()
      await reader.cancel('client disconnected')
      await expect(pendingClientRead).resolves.toMatchObject({ done: true })

      expect(background.tasks).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(user.calls.some((call) => call.path === '/settle')).toBe(false)
      expect(pool.calls.some((call) => call.path === '/release')).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      await Promise.all(background.tasks)

      expect(upstreamCancelled).toBe(true)
      expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
      expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        usage_event: { payload: { estimated: true, outcome: 'cancelled' } },
      })
      expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps disconnect draining at its total timeout even while upstream keeps emitting', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-04T00:00:00.000Z') })
    try {
      const { env, user, pool } = await harness()
      const background = captureExecutionContext()
      let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamController = controller
            controller.enqueue(new TextEncoder().encode(
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first"}\n\n',
            ))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )))

      const response = await createApp().request(
        '/v1/responses',
        {
          method: 'POST',
          headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-public', stream: true, input: 'hello' }),
        },
        env,
        background.executionCtx,
      )
      const reader = response.body!.getReader()
      await reader.read()
      const pendingClientRead = reader.read()
      await Promise.resolve()
      await reader.cancel('client disconnected')
      await pendingClientRead

      for (const delta of ['second', 'third', 'fourth']) {
        await vi.advanceTimersByTimeAsync(9_000)
        upstreamController!.enqueue(new TextEncoder().encode(
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${delta}"}\n\n`,
        ))
        await Promise.resolve()
      }
      expect(user.calls.some((call) => call.path === '/settle')).toBe(false)
      await vi.advanceTimersByTimeAsync(3_001)
      await Promise.all(background.tasks)

      expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
      expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        usage_event: { payload: { estimated: true, outcome: 'cancelled' } },
      })
      expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('finishes and fails accounting at response.failed without waiting for upstream EOF', async () => {
    const { env, user, pool } = await harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","usage":{"input_tokens":7,"output_tokens":1}}}\n\n',
          ))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )))

    const response = await createApp().request(
      '/v1/responses',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, input: 'hello' }),
      },
      env,
    )
    const text = await readStreamToTextWithin(response)

    expect(text).toContain('event: response.failed')
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { input_tokens: 7, output_tokens: 1, outcome: 'failed' } },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('settles and releases once when client cancellation races duplicate terminal events', async () => {
    const { env, user, pool } = await harness()
    const background = captureExecutionContext()
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller
          controller.enqueue(new TextEncoder().encode(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          ))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )))

    const response = await createApp().request(
      '/v1/responses',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', stream: true, input: 'hello' }),
      },
      env,
      background.executionCtx,
    )
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel('client disconnected')
    upstreamController!.enqueue(new TextEncoder().encode([
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":4}}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":4}}}\n\n',
    ].join('')))
    await Promise.all(background.tasks)

    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('does not corrupt a completed stream when every settlement path is unavailable', async () => {
    const { env, database, user, pool, limit } = await harness()
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
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(0)
    expect(limit.calls.filter((call) => call.path === '/monetary/settle')).toHaveLength(0)
    expect(user.calls.filter((call) => call.path === '/cancel')).toHaveLength(1)
    expect(limit.calls.filter((call) => call.path === '/monetary/cancel')).toHaveLength(1)
  })

  it('returns 503 without settling either authority when the recovery command cannot be persisted', async () => {
    const { env, database, user, limit } = await harness()
    database.failRecoveryWrites = true
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({
        model: 'gpt-upstream',
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      })),
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

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'settlement_recovery_unavailable' },
    })
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(0)
    expect(limit.calls.filter((call) => call.path === '/monetary/settle')).toHaveLength(0)
    expect(user.calls.filter((call) => call.path === '/cancel')).toHaveLength(1)
    expect(limit.calls.filter((call) => call.path === '/monetary/cancel')).toHaveLength(1)
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

  it('classifies an upstream 429 as a provider-owned observation', async () => {
    const { env, database } = await harness()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(
        { error: { message: 'rate limited' } },
        { status: 429 },
      )),
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

    expect(response.status).toBe(429)
    const outcome = database.bindings.find(({ query }) =>
      query.includes('UPDATE request_observations') && query.includes('error_owner = ?'))
    expect(outcome?.values).toMatchObject({
      0: 'failed',
      2: 429,
      11: 'upstream',
      13: 'provider',
      14: 'upstream',
    })
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

  it('routes Anthropic Messages natively with x-api-key authentication and native usage', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'anthropic' })
    Object.assign(database.credential, {
      platform: 'anthropic',
      protocol: 'anthropic',
      auth_scheme: 'x-api-key',
      provider_config_json: '{}',
      base_url: 'https://api.anthropic.example',
    })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'msg_native_1',
        type: 'message',
        role: 'assistant',
        model: 'gpt-upstream',
        content: [{ type: 'text', text: 'native hello' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 11,
          output_tokens: 4,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 5,
        },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'sk-customer',
        'anthropic-version': 'attacker-version',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-public',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: 'msg_native_1',
      model: 'gpt-public',
      content: [{ type: 'text', text: 'native hello' }],
    })
    const [url, init] = upstream.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(String(url)).toBe('https://api.anthropic.example/v1/messages')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBe('sk-upstream-secret')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    })
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: {
          input_tokens: 19,
          output_tokens: 4,
          cache_read_tokens: 3,
          outcome: 'completed',
        },
      },
      amount_micros: 50,
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

  it('passes through native Anthropic SSE and settles only after message_stop', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'anthropic' })
    Object.assign(database.credential, {
      platform: 'anthropic',
      protocol: 'anthropic',
      auth_scheme: 'x-api-key',
      provider_config_json: '{}',
      base_url: 'https://api.anthropic.example',
    })
    const frames = [
      {
        type: 'message_start',
        message: {
          id: 'msg_stream_native',
          type: 'message',
          role: 'assistant',
          model: 'gpt-upstream',
          content: [],
          usage: {
            input_tokens: 8,
            output_tokens: 0,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 3,
          },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )))

    const response = await createApp().request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }, env)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('event: message_stop')
    expect(text).toContain('"model":"gpt-public"')
    expect(text).not.toContain('gpt-upstream')
    expect(text).not.toContain('response.failed')
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: {
          input_tokens: 16,
          output_tokens: 2,
          cache_read_tokens: 3,
          outcome: 'completed',
        },
      },
      amount_micros: 36,
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('drains a cancelled native Anthropic stream to terminal usage exactly once', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'anthropic' })
    Object.assign(database.credential, {
      platform: 'anthropic',
      protocol: 'anthropic',
      auth_scheme: 'x-api-key',
      provider_config_json: '{}',
      base_url: 'https://api.anthropic.example',
    })
    const background = captureExecutionContext()
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let upstreamCancelled = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller
          controller.enqueue(new TextEncoder().encode(
            'event: message_start\ndata: {"type":"message_start","message":{"model":"gpt-upstream","usage":{"input_tokens":13,"output_tokens":0}}}\n\n',
          ))
        },
        cancel() {
          upstreamCancelled = true
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )))

    const response = await createApp().request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }, env, background.executionCtx)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel('client disconnected')
    upstreamController!.enqueue(new TextEncoder().encode([
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')))
    await Promise.all(background.tasks)

    expect(upstreamCancelled).toBe(true)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: {
          input_tokens: 13,
          output_tokens: 5,
          estimated: false,
          outcome: 'cancelled',
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
    expectZeroCostBillingLifecycle(user)
    expect(pool.calls.filter((call) => call.path === '/reserve')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('routes Anthropic count_tokens to the native provider without billing', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'anthropic' })
    Object.assign(database.credential, {
      platform: 'anthropic',
      protocol: 'anthropic',
      auth_scheme: 'x-api-key',
      provider_config_json: '{}',
      base_url: 'https://api.anthropic.example',
    })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ input_tokens: 21 }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 99,
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ input_tokens: 21 })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://api.anthropic.example/v1/messages/count_tokens')
    expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-upstream-secret')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      messages: [{ role: 'user', content: 'Hello' }],
    })
    expectZeroCostBillingLifecycle(user)
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
    expectZeroCostBillingLifecycle(user)
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

  it.each(['/v1/responses/compact', '/responses/compact'])(
    'normalizes %s as a unary compact request and bills terminal usage',
    async (path) => {
      const { env, user, pool } = await harness()
      const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          id: 'resp_compact_contract',
          object: 'response',
          model: 'gpt-upstream',
          status: 'completed',
          output: [{ type: 'compaction', encrypted_content: 'opaque' }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        }),
      )
      vi.stubGlobal('fetch', upstream)

      const response = await createApp().request(path, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          input: [{ type: 'message', role: 'user', content: 'compact this' }],
          instructions: 'Keep the important facts.',
          tools: [{ type: 'function', name: 'lookup' }],
          parallel_tool_calls: true,
          reasoning: { effort: 'high' },
          service_tier: 'default',
          text: { verbosity: 'low' },
          previous_response_id: 'resp_previous',
          store: true,
          stream: true,
          prompt_cache_key: 'request-scoped-cache-key',
          tool_choice: 'auto',
        }),
      }, env)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        id: 'resp_compact_contract',
        model: 'gpt-public',
        output: [{ type: 'compaction', encrypted_content: 'opaque' }],
      })
      const [url, init] = upstream.mock.calls[0]
      expect(String(url)).toBe('https://upstream.example/v1/responses/compact')
      expect(new Headers(init?.headers).get('accept')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-upstream',
        input: [{ type: 'message', role: 'user', content: 'compact this' }],
        instructions: 'Keep the important facts.',
        tools: [{ type: 'function', name: 'lookup' }],
        parallel_tool_calls: true,
        reasoning: { effort: 'high' },
        service_tier: 'default',
        text: { verbosity: 'low' },
        previous_response_id: 'resp_previous',
      })
      expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        amount_micros: 10,
        usage_event: {
          payload: {
            input_tokens: 3,
            output_tokens: 1,
            amount_micros: 10,
            stream: false,
          },
        },
      })
      expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    },
  )

  it('routes Codex Responses through the provider planner with Codex-owned authentication', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'codex' })
    Object.assign(database.credential, {
      platform: 'codex',
      protocol: 'codex',
      auth_scheme: 'bearer',
      provider_config_json: '{"account_id":"workspace-123"}',
      base_url: 'https://chatgpt.example',
    })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'resp_codex_native',
        model: 'gpt-upstream',
        status: 'completed',
        output: [],
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        originator: 'attacker',
        'chatgpt-account-id': 'attacker-account',
      },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello', store: true }),
    }, env)

    expect(response.status).toBe(200)
    const [url, init] = upstream.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(String(url)).toBe('https://chatgpt.example/backend-api/codex/responses')
    expect(headers.get('authorization')).toBe('Bearer sk-upstream-secret')
    expect(headers.get('originator')).toBe('codex_cli_rs')
    expect(headers.get('chatgpt-account-id')).toBe('workspace-123')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-upstream',
      input: 'hello',
      store: false,
    })
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('bridges Chat Completions through a Responses-only Codex account with Codex body rules', async () => {
    const { env, database, user, pool } = await harness()
    database.responsesOnly = true
    Object.assign(database.principal, { platform: 'codex' })
    Object.assign(database.credential, {
      platform: 'codex',
      protocol: 'codex',
      auth_scheme: 'bearer',
      provider_config_json: '{"account_id":"workspace-123"}',
      base_url: 'https://chatgpt.example',
    })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_codex_bridge","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":4,"output_tokens":1}}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        messages: [
          { role: 'system', content: 'Be precise.' },
          { role: 'user', content: 'Hello' },
        ],
        max_tokens: 64,
        stream: false,
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: 'resp_codex_bridge',
      model: 'gpt-public',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://chatgpt.example/backend-api/codex/responses')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      input: [{ role: 'user', content: 'Hello' }],
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      instructions: 'Be precise.',
    })
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it.each([false, true])(
    'preserves cyber-policy failures and settles zero usage through the Chat bridge (stream=%s)',
    async (stream) => {
      const { env, database, user, pool } = await harness()
      database.responsesOnly = true
      await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
      pool.reserveAccountIds.push('account-1', 'account-2')
      const upstream = vi.fn(async () => new Response([
        'event: response.failed',
        'data: {"type":"response.failed","response":{"id":"resp_cyber","status":"failed","output":[],"error":{"code":"cyber_policy","message":"flagged by policy"},"usage":{"input_tokens":99,"output_tokens":3}}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
      vi.stubGlobal('fetch', upstream)

      const response = await createApp().request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          messages: [{ role: 'user', content: 'Hello' }],
          stream,
        }),
      }, env)

      if (stream) {
        expect(response.status).toBe(200)
        const wire = await response.text()
        expect(wire).toContain('"code":"cyber_policy"')
        expect(wire).toContain('flagged by policy')
        expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1)
      } else {
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({
          error: {
            code: 'cyber_policy',
            type: 'invalid_request_error',
            message: 'flagged by policy',
          },
        })
      }
      expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
      expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        amount_micros: 0,
        usage_event: {
          payload: {
            input_tokens: 0,
            output_tokens: 0,
            outcome: 'failed',
          },
        },
      })
      expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(0)
      expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
      expect(upstream).toHaveBeenCalledOnce()
    },
  )

  it('preserves a standard incomplete reason as buffered partial success without retrying', async () => {
    const { env, database, user, pool } = await harness()
    database.responsesOnly = true
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2')
    const upstream = vi.fn(async () => new Response([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"partial but buffered"}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","output":[],"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":7,"output_tokens":4}}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      model: 'gpt-public',
      choices: [{
        message: { content: 'partial but buffered' },
        finish_reason: 'length',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
    })
    expect(upstream).toHaveBeenCalledOnce()
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(0)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: { input_tokens: 7, output_tokens: 4, outcome: 'completed' },
      },
    })
  })

  it.each(['failed', 'incomplete', 'canceled'] as const)(
    'fails over a Responses 200 response.%s terminal before visible Chat output',
    async (terminal) => {
      const { env, database, user, pool, limit } = await harness()
      database.responsesOnly = true
      await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
      pool.reserveAccountIds.push('account-1', 'account-2')
      const upstream = vi.fn(async (request: RequestInfo | URL) => {
        if (String(request).includes('upstream-two')) {
          return new Response([
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"resp_semantic_fallback","model":"gpt-upstream"}}',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"semantic-fallback-ok"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_semantic_fallback","status":"completed","output":[],"usage":{"input_tokens":4,"output_tokens":2}}}',
            '',
            '',
          ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
        }
        const status = terminal === 'incomplete' ? 'incomplete' : terminal
        return new Response([
          `event: response.${terminal}`,
          `data: ${JSON.stringify({
            type: `response.${terminal}`,
            response: {
              id: `resp_${terminal}_first`,
              status,
              output: [],
              error: { code: 'server_error', message: `first ${terminal} account failed` },
              usage: { input_tokens: 99, output_tokens: 7 },
            },
          })}`,
          '',
          '',
        ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', upstream)

      const response = await createApp().request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      }, env)
      const wire = await readStreamToTextWithin(response)

      expect(response.status).toBe(200)
      expect(upstream.mock.calls.map(([request]) => String(request))).toEqual([
        'https://upstream.example/v1/responses',
        'https://upstream-two.example/v1/responses',
      ])
      expect(wire).toContain('semantic-fallback-ok')
      expect(wire).not.toContain(`first ${terminal} account failed`)
      expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1)
      expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(1)
      expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(2)
      expect(user.calls.filter((call) => call.path === '/reserve')).toHaveLength(1)
      expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
      expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        usage_event: {
          payload: { input_tokens: 4, output_tokens: 2, outcome: 'completed' },
        },
      })
      expect(limit.calls.filter((call) => call.path === '/monetary/reserve')).toHaveLength(1)
      expect(limit.calls.filter((call) => call.path === '/monetary/settle')).toHaveLength(1)
    },
  )

  it('retries a buffered Chat bridge even when the failed Responses attempt produced deltas', async () => {
    const { env, database, user, pool } = await harness()
    database.responsesOnly = true
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2')
    const upstream = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).includes('upstream-two')) {
        return new Response([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_buffered_retry","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"buffered-retry-ok"}]}],"usage":{"input_tokens":5,"output_tokens":2}}}',
          '',
          '',
        ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"never exposed"}',
        '',
        'event: response.failed',
        'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"retry buffered account"},"usage":{"input_tokens":50,"output_tokens":4}}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: 'resp_buffered_retry',
      choices: [{ message: { content: 'buffered-retry-ok' } }],
    })
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(2)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: { input_tokens: 5, output_tokens: 2, outcome: 'completed' },
      },
    })
  })

  it('records the final retryable failure when buffered Responses failover is exhausted', async () => {
    const { env, database, user, pool } = await harness()
    database.responsesOnly = true
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2')
    const upstream = vi.fn(async (request: RequestInfo | URL) => {
      const second = String(request).includes('upstream-two')
      return new Response([
        'event: response.failed',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: second ? 'buffered_final_code' : 'buffered_first_code',
              message: second ? 'buffered final message' : 'buffered first message',
            },
            usage: second
              ? { input_tokens: 6, output_tokens: 1 }
              : { input_tokens: 60, output_tokens: 10 },
          },
        })}`,
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
    }, env)

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'buffered_final_code', message: 'buffered final message' },
    })
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(2)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(2)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: { input_tokens: 6, output_tokens: 1, outcome: 'failed' },
      },
    })
  })

  it.each(['failed', 'incomplete'] as const)(
    'never retries a Responses semantic response.%s after visible Chat output',
    async (terminal) => {
    const { env, database, user, pool } = await harness()
    database.responsesOnly = true
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2')
    const upstream = vi.fn(async () => new Response([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_visible_failure","model":"gpt-upstream"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"partial-visible"}',
      '',
      `event: response.${terminal}`,
      `data: {"type":"response.${terminal}","response":{"id":"resp_visible_failure","status":"${terminal}","output":[],"error":{"code":"semantic_visible_failure","message":"failed after output"},"usage":{"input_tokens":3,"output_tokens":1}}}`,
      ...(terminal === 'failed' ? ['', ''] : []),
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    }, env)
    const wire = await readStreamToTextWithin(response)

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
    expect(wire).toContain('partial-visible')
    expect(wire.match(/semantic_visible_failure/g)).toHaveLength(1)
    expect(wire.match(/failed after output/g)).toHaveLength(1)
    expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: { input_tokens: 3, output_tokens: 1, outcome: 'failed' },
      },
    })
    },
  )

  it('preserves the final Responses semantic code and message after failover is exhausted', async () => {
    const { env, database, user, pool } = await harness()
    database.responsesOnly = true
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2')
    const upstream = vi.fn(async (request: RequestInfo | URL) => {
      const second = String(request).includes('upstream-two')
      return new Response([
        'event: response.failed',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            id: second ? 'resp_final_failure' : 'resp_first_failure',
            status: 'failed',
            output: [],
            error: {
              code: second ? 'final_semantic_code' : 'first_semantic_code',
              message: second ? 'final semantic message' : 'first semantic message',
            },
            usage: second
              ? { input_tokens: 8, output_tokens: 2 }
              : { input_tokens: 80, output_tokens: 20 },
          },
        })}`,
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    }, env)
    const wire = await readStreamToTextWithin(response)

    expect(upstream).toHaveBeenCalledTimes(2)
    expect(wire.match(/final_semantic_code/g)).toHaveLength(1)
    expect(wire.match(/final semantic message/g)).toHaveLength(1)
    expect(wire).not.toContain('first_semantic_code')
    expect(wire).not.toContain('first semantic message')
    expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(2)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(2)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: { input_tokens: 8, output_tokens: 2, outcome: 'failed' },
      },
    })
  })

  it('preserves zero-billable cyber policy when a Responses fallback returns JSON', async () => {
    const originalBaseFee = model.per_request_micros
    model.per_request_micros = 19
    try {
      const { env, database, user, pool } = await harness()
      database.responsesOnly = true
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        id: 'resp_cyber_json',
        status: 'failed',
        output: [],
        error: { code: 'cyber_policy', message: 'blocked in JSON' },
        usage: { input_tokens: 88, output_tokens: 2 },
      })))

      const response = await createApp().request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-public',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }, env)

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'cyber_policy', message: 'blocked in JSON' },
      })
      expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
        amount_micros: 0,
        usage_event: {
          payload: {
            input_tokens: 0,
            output_tokens: 0,
            base_amount_micros: 0,
            outcome: 'failed',
          },
        },
      })
      expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(0)
      expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    } finally {
      model.per_request_micros = originalBaseFee
    }
  })

  it('rejects unsupported cross-protocol operations before state mutation or fetch', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'anthropic' })
    Object.assign(database.credential, {
      platform: 'anthropic',
      protocol: 'anthropic',
      auth_scheme: 'x-api-key',
      provider_config_json: '{}',
      base_url: 'https://api.anthropic.example',
    })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => Response.json({}))
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', messages: [{ role: 'user', content: 'Hello' }] }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'provider_operation_not_supported' },
    })
    expect(upstream).not.toHaveBeenCalled()
    expect(user.calls).toEqual([])
    expect(pool.calls).toEqual([])
  })

  it('rebuilds native provider authentication on every retry attempt', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'anthropic' })
    Object.assign(database.credential, {
      platform: 'anthropic',
      protocol: 'anthropic',
      auth_scheme: 'x-api-key',
      provider_config_json: '{}',
      base_url: 'https://api.anthropic.example',
    })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      upstream.mock.calls.length === 1
        ? Response.json({ error: { message: 'busy' } }, { status: 503 })
        : Response.json({
            id: 'msg_retry',
            type: 'message',
            role: 'assistant',
            model: 'gpt-upstream',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }, env)

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
    for (const [url, init] of upstream.mock.calls) {
      expect(String(url)).toBe('https://api.anthropic.example/v1/messages')
      expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-upstream-secret')
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
    }
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(1)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
  })

  it.each(['/v1/responses/input_tokens', '/responses/input_tokens'])(
    'serves native %s without charging balance',
    async (path) => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.credential, { base_url: 'https://api.openai.com/v1' })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ object: 'response.input_tokens', input_tokens: 31 }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request(
      path,
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
    expect(String(url)).toBe('https://api.openai.com/v1/responses/input_tokens')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-upstream',
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'Hello' }],
    })
    expectZeroCostBillingLifecycle(user)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
    },
  )

  it('estimates Responses input_tokens locally for a custom relay without charging', async () => {
    const { env, user, pool } = await harness()
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/responses/input_tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-public',
        instructions: 'Be concise.',
        input: 'hello world',
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      object: 'response.input_tokens',
      input_tokens: expect.any(Number),
    })
    expect(upstream).not.toHaveBeenCalled()
    expectZeroCostBillingLifecycle(user)
    expect(pool.calls).toEqual([])
  })

  it('estimates input_tokens locally when a mixed account pool selects a custom relay', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.credential, { base_url: 'https://api.openai.com/v1' })
    await addGatewayAccount(database, 'account-2', 'https://custom-relay.example/v1')
    pool.reserveAccountIds.push('account-2')
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/responses/input_tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', input: 'mixed pool request' }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      object: 'response.input_tokens',
      input_tokens: expect.any(Number),
    })
    expect(upstream).not.toHaveBeenCalled()
    expectZeroCostBillingLifecycle(user)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('returns a stable error for malformed input_tokens usage without settling a charge', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.credential, { base_url: 'https://api.openai.com/v1' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ object: 'response.input_tokens' })))

    const response = await createApp().request('/responses/input_tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
    }, env)

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'server_error',
        code: 'invalid_upstream_response',
        message: 'Upstream returned invalid token usage',
      },
    })
    expectZeroCostBillingLifecycle(user)
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

  it('retries an embeddings account access-state failure on a second account exactly once', async () => {
    const { env, database, user, pool, limit } = await harness()
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2')
    const upstream = vi.fn(async (request: RequestInfo | URL) =>
      String(request).includes('upstream-two')
        ? Response.json({
            object: 'list',
            model: 'gpt-upstream',
            data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
            usage: { prompt_tokens: 3, total_tokens: 3 },
          })
        : Response.json(
            { error: { code: 'deactivated_workspace', message: 'request rejected' } },
            { status: 400 },
          ),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/embeddings', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
    }, env)

    expect(response.status).toBe(200)
    expect(upstream.mock.calls.map(([request]) => String(request))).toEqual([
      'https://upstream.example/v1/embeddings',
      'https://upstream-two.example/v1/embeddings',
    ])
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(2)
    expect(user.calls.filter((call) => call.path === '/reserve')).toHaveLength(1)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(1)
    expect(user.calls.filter((call) => call.path === '/cancel')).toHaveLength(0)
    expect(limit.calls.filter((call) => call.path === '/monetary/reserve')).toHaveLength(1)
    expect(limit.calls.filter((call) => call.path === '/monetary/settle')).toHaveLength(1)
    expect(limit.calls.filter((call) => call.path === '/monetary/cancel')).toHaveLength(0)
  })

  it('bounds stalled embeddings error-body classification before failing over', async () => {
    const { env, database, pool } = await harness()
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2')
    const upstream = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).includes('upstream-two')) {
        return Response.json({
          object: 'list',
          model: 'gpt-upstream',
          data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        })
      }
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', upstream)

    let guard: ReturnType<typeof setTimeout> | undefined
    let response: Response
    try {
      response = await Promise.race([
        createApp().request('/v1/embeddings', {
          method: 'POST',
          headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
        }, env),
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(
            () => reject(new Error('embeddings error classification did not finish')),
            750,
          )
        }),
      ])
    } finally {
      if (guard !== undefined) clearTimeout(guard)
    }

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('does not retry deterministic or untyped-403 embeddings failures', async () => {
    const cases = [
      {
        status: 400,
        payload: { error: { type: 'invalid_request_error', code: 'invalid_input', message: 'bad input' } },
      },
      {
        status: 403,
        payload: { error: { type: 'permission_error', code: 'insufficient_permissions', message: 'forbidden' } },
      },
      {
        status: 403,
        payload: { error: { message: 'Your account is deactivated' } },
      },
      {
        status: 404,
        payload: { error: { type: 'invalid_request_error', code: 'model_not_found', message: 'missing' } },
      },
      {
        status: 503,
        payload: { error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'too long' } },
      },
    ]

    for (const fixture of cases) {
      const { env, database, user, pool, limit } = await harness()
      await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
      pool.reserveAccountIds.push('account-1', 'account-2')
      const upstream = vi.fn(async () => Response.json(fixture.payload, { status: fixture.status }))
      vi.stubGlobal('fetch', upstream)

      const response = await createApp().request('/v1/embeddings', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
      }, env)

      expect(response.status).toBe(fixture.status === 403 || fixture.status >= 500 ? 502 : fixture.status)
      expect(upstream, JSON.stringify(fixture)).toHaveBeenCalledOnce()
      expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(0)
      expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
      expect(user.calls.filter((call) => call.path === '/reserve')).toHaveLength(1)
      expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(0)
      expect(user.calls.filter((call) => call.path === '/cancel')).toHaveLength(1)
      expect(limit.calls.filter((call) => call.path === '/monetary/reserve')).toHaveLength(1)
      expect(limit.calls.filter((call) => call.path === '/monetary/settle')).toHaveLength(0)
      expect(limit.calls.filter((call) => call.path === '/monetary/cancel')).toHaveLength(1)
    }
  })

  it('stops embeddings failover after each configured account has failed', async () => {
    const { env, database, user, pool, limit } = await harness()
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-1', 'account-2', 'account-1')
    const upstream = vi.fn(async () =>
      Response.json({ error: { code: 'server_is_overloaded', message: 'busy' } }, { status: 503 }),
    )
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1/embeddings', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
    }, env)

    expect(response.status).toBe(502)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(2)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(2)
    expect(user.calls.filter((call) => call.path === '/reserve')).toHaveLength(1)
    expect(user.calls.filter((call) => call.path === '/cancel')).toHaveLength(1)
    expect(limit.calls.filter((call) => call.path === '/monetary/reserve')).toHaveLength(1)
    expect(limit.calls.filter((call) => call.path === '/monetary/cancel')).toHaveLength(1)
  })

  it('keeps a hashed session sticky, clears it on failure, and rebinds the fallback account', async () => {
    const { env, database, user, pool, limit } = await harness()
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-2')
    let secondAccountCalls = 0
    const upstream = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).includes('upstream-two')) {
        secondAccountCalls += 1
        if (secondAccountCalls === 2) {
          return Response.json({ error: { code: 'server_is_overloaded', message: 'busy' } }, { status: 503 })
        }
      }
      return Response.json({
        object: 'list',
        model: 'gpt-upstream',
        data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      })
    })
    vi.stubGlobal('fetch', upstream)
    const request = () => createApp().request('/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'session-id': 'private-session-value',
      },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
    }, env)

    const first = await request()
    const second = await request()

    expect([first.status, second.status]).toEqual([200, 200])
    expect(upstream.mock.calls.map(([upstreamRequest]) => String(upstreamRequest))).toEqual([
      'https://upstream-two.example/v1/embeddings',
      'https://upstream-two.example/v1/embeddings',
      'https://upstream.example/v1/embeddings',
    ])
    const reserves = pool.calls.filter((call) => call.path === '/reserve')
    expect(reserves).toHaveLength(3)
    expect(reserves.map((call) => call.body.affinity_key)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ])
    expect(new Set(reserves.map((call) => call.body.affinity_key)).size).toBe(1)
    expect(JSON.stringify(reserves)).not.toContain('private-session-value')
    expect(pool.calls.filter((call) => call.path === '/failure')).toHaveLength(1)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(3)
    expect([...pool.affinityAccounts.values()]).toEqual(['account-1'])
    expect(user.calls.filter((call) => call.path === '/reserve')).toHaveLength(2)
    expect(user.calls.filter((call) => call.path === '/settle')).toHaveLength(2)
    expect(limit.calls.filter((call) => call.path === '/monetary/reserve')).toHaveLength(2)
    expect(limit.calls.filter((call) => call.path === '/monetary/settle')).toHaveLength(2)
  })

  it('does not carry a sticky binding across API-key groups', async () => {
    const { env, database, pool, poolNames } = await harness()
    await addGatewayAccount(database, 'account-2', 'https://upstream-two.example/v1')
    pool.reserveAccountIds.push('account-2')
    const upstream = vi.fn(async (_requestInfo: RequestInfo | URL) => Response.json({
      object: 'list',
      model: 'gpt-upstream',
      data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }))
    vi.stubGlobal('fetch', upstream)
    const request = () => createApp().request('/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
        'session-id': 'same-session',
      },
      body: JSON.stringify({ model: 'gpt-public', input: 'hello' }),
    }, env)

    expect((await request()).status).toBe(200)
    database.principal.group_id = 'group-2'
    expect((await request()).status).toBe(200)

    const reserves = pool.calls.filter((call) => call.path === '/reserve')
    expect(reserves.map((call) => call.body.affinity_key)).toHaveLength(2)
    expect(reserves[0]?.body.affinity_key).not.toBe(reserves[1]?.body.affinity_key)
    expect(upstream.mock.calls.map(([requestInfo]) => String(requestInfo))).toEqual([
      'https://upstream-two.example/v1/embeddings',
      'https://upstream.example/v1/embeddings',
    ])
    expect(poolNames).toContain(
      'group:group-1:platform:openai:model:model-1:endpoint:embeddings:shard:0',
    )
    expect(poolNames).toContain(
      'group:group-2:platform:openai:model:model-1:endpoint:embeddings:shard:0',
    )
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

  it('routes Gemini generateContent natively with header auth and native usage metadata', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'gemini' })
    Object.assign(database.credential, {
      platform: 'gemini',
      protocol: 'gemini',
      auth_scheme: 'x-goog-api-key',
      provider_config_json: '{}',
      base_url: 'https://generativelanguage.example',
    })
    const nativeResponse = {
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'native Gemini' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 3,
        totalTokenCount: 13,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 1,
      },
      modelVersion: 'gemini-upstream',
    }
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(nativeResponse),
    )
    vi.stubGlobal('fetch', upstream)

    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      generationConfig: { maxOutputTokens: 64 },
    }
    const response = await createApp().request('/v1beta/models/gpt-public:generateContent', {
      method: 'POST',
      headers: {
        'x-goog-api-key': 'sk-customer',
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(nativeResponse)
    const [url, init] = upstream.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(String(url)).toBe('https://generativelanguage.example/v1beta/models/gpt-upstream:generateContent')
    expect(headers.get('x-goog-api-key')).toBe('sk-upstream-secret')
    expect(headers.get('authorization')).toBeNull()
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: {
          input_tokens: 9,
          output_tokens: 4,
          cache_read_tokens: 2,
          outcome: 'completed',
        },
      },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('passes through native Gemini SSE and settles at a finishReason terminal event', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'gemini' })
    Object.assign(database.credential, {
      platform: 'gemini',
      protocol: 'gemini',
      auth_scheme: 'x-goog-api-key',
      provider_config_json: '{}',
      base_url: 'https://generativelanguage.example',
    })
    const frames = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 2,
          totalTokenCount: 10,
          cachedContentTokenCount: 1,
          thoughtsTokenCount: 1,
        },
      },
    ]
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', upstream)

    const response = await createApp().request('/v1beta/models/gpt-public:streamGenerateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] }),
    }, env)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('"finishReason":"STOP"')
    expect(text).not.toContain('"error"')
    expect(String(upstream.mock.calls[0][0])).toBe(
      'https://generativelanguage.example/v1beta/models/gpt-upstream:streamGenerateContent?alt=sse',
    )
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: {
        payload: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_tokens: 1,
          outcome: 'completed',
        },
      },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
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
    expectZeroCostBillingLifecycle(user)
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })

  it('routes Gemini countTokens natively without charging balance', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'gemini' })
    Object.assign(database.credential, {
      platform: 'gemini',
      protocol: 'gemini',
      auth_scheme: 'x-goog-api-key',
      provider_config_json: '{}',
      base_url: 'https://generativelanguage.example',
    })
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ totalTokens: 23 }),
    )
    vi.stubGlobal('fetch', upstream)
    const body = { contents: [{ role: 'user', parts: [{ text: 'How many?' }] }] }

    const response = await createApp().request('/v1beta/models/gpt-public:countTokens', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ totalTokens: 23 })
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://generativelanguage.example/v1beta/models/gpt-upstream:countTokens')
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('sk-upstream-secret')
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expectZeroCostBillingLifecycle(user)
    expect(pool.calls.filter((call) => call.path === '/reserve')).toHaveLength(1)
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

  it('routes Gemini embedContent natively and preserves the native response', async () => {
    const { env, database, user, pool } = await harness()
    Object.assign(database.principal, { platform: 'gemini' })
    Object.assign(database.credential, {
      platform: 'gemini',
      protocol: 'gemini',
      auth_scheme: 'x-goog-api-key',
      provider_config_json: '{}',
      base_url: 'https://generativelanguage.example',
    })
    const nativeResponse = { embedding: { values: [0.25, -0.5] } }
    const upstream = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(nativeResponse),
    )
    vi.stubGlobal('fetch', upstream)
    const body = {
      content: { parts: [{ text: 'Represent this sentence.' }] },
      taskType: 'RETRIEVAL_DOCUMENT',
    }

    const response = await createApp().request('/v1beta/models/gpt-public:embedContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'sk-customer', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(nativeResponse)
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://generativelanguage.example/v1beta/models/gpt-upstream:embedContent')
    expect(JSON.parse(String(init?.body))).toEqual(body)
    expect(user.calls.find((call) => call.path === '/settle')?.body).toMatchObject({
      usage_event: { payload: { output_tokens: 0, estimated: true, outcome: 'completed' } },
    })
    expect(pool.calls.filter((call) => call.path === '/release')).toHaveLength(1)
  })
})
