import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

interface UserRow {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  balance_micros: number
  state_version: number
  auth_version: number
  password_credential: string | null
  email_verified_at_ms: number | null
  password_changed_at_ms: number | null
  last_login_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
}

interface SessionRow {
  id: string
  family_id: string
  user_id: string
  auth_version: number
  access_token_hash: string
  refresh_token_hash: string
  previous_refresh_token_hash: string | null
  created_at_ms: number
  access_expires_at_ms: number
  refresh_expires_at_ms: number
  rotated_at_ms: number | null
  last_seen_at_ms: number | null
  revoked_at_ms: number | null
  revoke_reason: string | null
  user_agent: string
}

class AuthStatement {
  values: unknown[] = []

  constructor(
    readonly query: string,
    private readonly database: AuthDatabase,
  ) {}

  bind(...values: unknown[]): AuthStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.query, this.values) as T | null
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.database.all(this.query) as T[],
      meta: {} as D1Meta & Record<string, unknown>,
    }
  }

  async run(): Promise<D1Result<unknown>> {
    const changes = this.database.run(this.query, this.values)
    return {
      success: true,
      results: [],
      meta: { changes } as unknown as D1Meta & Record<string, unknown>,
    }
  }
}

class AuthDatabase {
  readonly users = new Map<string, UserRow>()
  readonly sessions = new Map<string, SessionRow>()
  readonly reads: Array<{ query: string; values: unknown[] }> = []
  readonly writes: Array<{ query: string; values: unknown[] }> = []

  constructor(private readonly events?: string[]) {}

  prepare(query: string): AuthStatement {
    return new AuthStatement(query, this)
  }

  async batch(statements: AuthStatement[]): Promise<D1Result<unknown>[]> {
    return Promise.all(statements.map((statement) => statement.run()))
  }

  first(query: string, values: unknown[]): Record<string, unknown> | null {
    this.events?.push('db:read')
    this.reads.push({ query, values })
    if (query.includes('FROM users') && query.includes('WHERE email = ?')) {
      const email = String(values[0])
      const user = Array.from(this.users.values()).find((value) => value.email === email)
      return user === undefined ? null : { ...user }
    }
    if (query.includes('FROM user_sessions s') && query.includes('s.access_token_hash = ?')) {
      const digest = String(values[0])
      const now = Number(values[1])
      const session = Array.from(this.sessions.values()).find((value) =>
        value.access_token_hash === digest &&
        value.revoked_at_ms === null &&
        value.access_expires_at_ms > now,
      )
      return session === undefined ? null : this.joinSession(session)
    }
    if (query.includes('FROM user_sessions s') && query.includes('s.refresh_token_hash = ?')) {
      const digest = String(values[0])
      const session = Array.from(this.sessions.values()).find((value) =>
        value.refresh_token_hash === digest || value.previous_refresh_token_hash === digest,
      )
      return session === undefined ? null : this.joinSession(session)
    }
    throw new Error(`Unexpected first query: ${query}`)
  }

  all(query: string): Record<string, unknown>[] {
    this.reads.push({ query, values: [] })
    if (query.includes('FROM auth_identities') || query.includes('FROM oauth_providers')) return []
    throw new Error(`Unexpected all query: ${query}`)
  }

  run(query: string, values: unknown[]): number {
    this.events?.push('db:write')
    this.writes.push({ query, values })
    if (query.includes('INSERT INTO users')) {
      const [
        id,
        email,
        displayName,
        createdAt,
        updatedAt,
        credential,
        passwordChangedAt,
        lastLoginAt,
      ] = values as [string, string, string, number, number, string, number, number]
      if (Array.from(this.users.values()).some((user) => user.email === email)) {
        throw new Error('UNIQUE constraint failed: users.email')
      }
      this.users.set(id, {
        id,
        email,
        display_name: displayName,
        role: 'user',
        status: 'active',
        balance_micros: 0,
        state_version: 0,
        auth_version: 1,
        password_credential: credential,
        email_verified_at_ms: null,
        password_changed_at_ms: passwordChangedAt,
        last_login_at_ms: lastLoginAt,
        created_at_ms: createdAt,
        updated_at_ms: updatedAt,
      })
      return 1
    }
    if (query.includes('INSERT INTO user_sessions')) {
      const [
        id, familyId, userId, authVersion, accessHash, refreshHash,
        createdAt, accessExpiresAt, refreshExpiresAt, userAgent,
      ] = values as [string, string, string, number, string, string, number, number, number, string]
      this.sessions.set(id, {
        id,
        family_id: familyId,
        user_id: userId,
        auth_version: authVersion,
        access_token_hash: accessHash,
        refresh_token_hash: refreshHash,
        previous_refresh_token_hash: null,
        created_at_ms: createdAt,
        access_expires_at_ms: accessExpiresAt,
        refresh_expires_at_ms: refreshExpiresAt,
        rotated_at_ms: null,
        last_seen_at_ms: null,
        revoked_at_ms: null,
        revoke_reason: null,
        user_agent: userAgent,
      })
      return 1
    }
    if (query.includes('INSERT INTO auth_audit_events')) return 1
    if (query.includes('UPDATE users') && query.includes('last_login_at_ms')) {
      const now = Number(values[0])
      const updatedAt = Number(values[1])
      const id = String(values[2])
      const user = this.users.get(id)
      if (user === undefined) return 0
      user.last_login_at_ms = now
      user.updated_at_ms = updatedAt
      return 1
    }
    if (query.includes('UPDATE user_sessions') && query.includes('SET access_token_hash')) {
      const [accessHash, refreshHash, previousHash, accessExpiresAt, rotatedAt, sessionId, expectedHash] =
        values as [string, string, string, number, number, string, string]
      const session = this.sessions.get(sessionId)
      if (session === undefined || session.revoked_at_ms !== null || session.refresh_token_hash !== expectedHash) return 0
      session.access_token_hash = accessHash
      session.refresh_token_hash = refreshHash
      session.previous_refresh_token_hash = previousHash
      session.access_expires_at_ms = accessExpiresAt
      session.rotated_at_ms = rotatedAt
      session.last_seen_at_ms = rotatedAt
      return 1
    }
    if (query.includes('UPDATE user_sessions') && query.includes('family_id = ?')) {
      const [revokedAt, reason, familyId] = values as [number, string, string]
      let changes = 0
      for (const session of this.sessions.values()) {
        if (session.family_id === familyId && session.revoked_at_ms === null) {
          session.revoked_at_ms = revokedAt
          session.revoke_reason = reason
          changes += 1
        }
      }
      return changes
    }
    if (query.includes('UPDATE user_sessions') && query.includes('refresh_token_hash = ?')) {
      const [revokedAt, reason, digest] = values as [number, string, string]
      let changes = 0
      for (const session of this.sessions.values()) {
        if (
          session.revoked_at_ms === null &&
          (session.refresh_token_hash === digest || session.previous_refresh_token_hash === digest)
        ) {
          session.revoked_at_ms = revokedAt
          session.revoke_reason = reason
          changes += 1
        }
      }
      return changes
    }
    throw new Error(`Unexpected run query: ${query}`)
  }

  private joinSession(session: SessionRow): Record<string, unknown> {
    const user = this.users.get(session.user_id)
    if (user === undefined) throw new Error('orphan session')
    return { ...session, ...user, session_id: session.id, session_auth_version: session.auth_version }
  }
}

class FakeAuthRateLimitNamespace {
  readonly objectNames: string[] = []
  readonly requests: Array<{ path: string; body: Record<string, unknown> }> = []

  constructor(
    private readonly failure: {
      path: '/check' | '/attempt'
      type: 'blocked' | 'unavailable'
    } | null = null,
    private readonly retryAfterSeconds = 17,
    private readonly events?: string[],
  ) {}

  idFromName(name: string): DurableObjectId {
    this.objectNames.push(name)
    return { toString: () => name } as DurableObjectId
  }

  get(): DurableObjectStub {
    return {
      fetch: async (request: Request) => {
        const body = await request.clone().json() as Record<string, unknown>
        const path = new URL(request.url).pathname
        this.requests.push({ path, body })
        this.events?.push(`limiter:${path}`)
        if (this.failure?.path === path && this.failure.type === 'unavailable') {
          return new Response('limiter unavailable', { status: 503 })
        }
        if (this.failure?.path === path && this.failure.type === 'blocked') {
          return Response.json({
            schema_version: 1,
            allowed: false,
            retry_after_seconds: this.retryAfterSeconds,
            blocked_by: ['account'],
          }, {
            status: 429,
            headers: { 'retry-after': String(this.retryAfterSeconds) },
          })
        }
        if (path === '/failure') {
          return Response.json({ schema_version: 1, recorded: true })
        }
        if (path === '/success') {
          return Response.json({ schema_version: 1, cleared: ['account'] })
        }
        return Response.json({ schema_version: 1, allowed: true })
      },
    } as unknown as DurableObjectStub
  }
}

function authEnv(
  database: AuthDatabase,
  rateLimit: FakeAuthRateLimitNamespace | null = new FakeAuthRateLimitNamespace(),
  settings: { registration_enabled: boolean; turnstile_enabled: boolean } = {
    registration_enabled: true,
    turnstile_enabled: false,
  },
): Env {
  const env: Env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: 'p'.repeat(32),
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: database as unknown as D1Database,
    CONFIG_KV: {
      get: async () => settings,
    } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
  if (rateLimit !== null) env.AUTH_RATE_LIMIT = rateLimit as unknown as DurableObjectNamespace
  return env
}

describe('password identity and rotating sessions', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('registers, persists only a password credential, and authenticates /auth/me', async () => {
    const database = new AuthDatabase()
    const env = authEnv(database)
    const app = createApp()

    const response = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
      body: JSON.stringify({ email: 'Alice@Example.com', password: 'correct horse battery staple' }),
    }, env)
    const payload = await response.json() as {
      code: number
      data: { access_token: string; refresh_token: string; expires_in: number; user: { email: string } }
    }

    expect(response.status).toBe(201)
    expect(payload.code).toBe(0)
    expect(payload.data.access_token).toMatch(/^sat_v1_/)
    expect(payload.data.refresh_token).toMatch(/^srt_v1_/)
    expect(payload.data.expires_in).toBeGreaterThan(0)
    expect(payload.data.user.email).toBe('alice@example.com')
    expect(payload.data.user).toMatchObject({ concurrency: 5, rpm_limit: 0 })
    const persisted = Array.from(database.users.values())[0]
    expect(persisted.password_credential).not.toContain('correct horse battery staple')
    expect(JSON.stringify(database.writes)).not.toContain('correct horse battery staple')

    const me = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${payload.data.access_token}` },
    }, env)
    expect(me.status).toBe(200)
    await expect(me.json()).resolves.toMatchObject({
      code: 0,
      data: { email: 'alice@example.com', role: 'user', status: 'active' },
    })
  })

  it('uses a generic login error and does not create a session for a wrong password', async () => {
    const database = new AuthDatabase()
    const rateLimit = new FakeAuthRateLimitNamespace()
    const env = authEnv(database, rateLimit)
    const app = createApp()
    await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery staple' }),
    }, env)
    const sessionCount = database.sessions.size

    const response = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'totally wrong password' }),
    }, env)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      code: 'invalid_credentials',
      message: 'Invalid email or password',
    })
    expect(database.sessions.size).toBe(sessionCount)
    expect(rateLimit.requests.slice(-2).map((request) => request.path)).toEqual([
      '/attempt',
      '/failure',
    ])
  })

  it.each(['/check', '/attempt'] as const)(
    'blocks password work with 429 and Retry-After when %s rejects admission',
    async (blockedPath) => {
      const database = new AuthDatabase()
      const rateLimit = new FakeAuthRateLimitNamespace({ path: blockedPath, type: 'blocked' }, 17)
      const env = authEnv(database, rateLimit)
      const passwordWork = vi.spyOn(crypto.subtle, 'deriveBits')
      const app = createApp()

      const response = await app.request('/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.4',
        },
        body: JSON.stringify({ email: 'Alice@Example.com', password: 'correct horse battery staple' }),
      }, env)

      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('17')
      await expect(response.json()).resolves.toMatchObject({
        code: 'auth_rate_limited',
        error: { type: 'rate_limit_error' },
      })
      expect(rateLimit.requests.map((request) => request.path)).toEqual(
        blockedPath === '/check' ? ['/check'] : ['/check', '/attempt'],
      )
      expect(database.writes).toHaveLength(0)
      expect(database.reads).toHaveLength(0)
      expect(passwordWork).not.toHaveBeenCalled()
    },
  )

  it.each(['/check', '/attempt'] as const)(
    'fails closed before database and password work when %s is unavailable',
    async (unavailablePath) => {
      const database = new AuthDatabase()
      const rateLimit = new FakeAuthRateLimitNamespace({
        path: unavailablePath,
        type: 'unavailable',
      })
      const env = authEnv(database, rateLimit)
      const passwordWork = vi.spyOn(crypto.subtle, 'deriveBits')
      const app = createApp()

      const response = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'plausible-password' }),
      }, env)

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({ code: 'auth_rate_limit_unavailable' })
      expect(rateLimit.requests.map((request) => request.path)).toEqual(
        unavailablePath === '/check' ? ['/check'] : ['/check', '/attempt'],
      )
      expect(database.writes).toHaveLength(0)
      expect(database.reads).toHaveLength(0)
      expect(passwordWork).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['/api/v1/auth/register', 400, 'invalid_password'],
    ['/api/v1/auth/login', 401, 'invalid_credentials'],
  ] as const)('does not consume quota for invalid password input at %s', async (path, status, code) => {
    const database = new AuthDatabase()
    const rateLimit = new FakeAuthRateLimitNamespace()
    const env = authEnv(database, rateLimit)
    const passwordWork = vi.spyOn(crypto.subtle, 'deriveBits')
    const app = createApp()

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'short' }),
    }, env)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({ code })
    expect(rateLimit.requests).toHaveLength(0)
    expect(database.writes).toHaveLength(0)
    expect(database.reads).toHaveLength(0)
    expect(passwordWork).not.toHaveBeenCalled()
  })

  it('checks limits before Turnstile but does not consume quota when Turnstile fails', async () => {
    const database = new AuthDatabase()
    const rateLimit = new FakeAuthRateLimitNamespace()
    const env = authEnv(database, rateLimit, {
      registration_enabled: true,
      turnstile_enabled: true,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ success: false }))
    const app = createApp()

    const response = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'plausible-password',
        turnstile_token: 'invalid-test-token',
      }),
    }, env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'captcha_invalid' })
    expect(rateLimit.requests.map((request) => request.path)).toEqual(['/check'])
    expect(database.writes).toHaveLength(0)
    expect(database.reads).toHaveLength(0)
  })

  it('commits admission before database and PBKDF2 work', async () => {
    const events: string[] = []
    const database = new AuthDatabase(events)
    const rateLimit = new FakeAuthRateLimitNamespace(null, 17, events)
    const settings = { registration_enabled: true, turnstile_enabled: false }
    const env = authEnv(database, rateLimit, settings)
    const app = createApp()
    await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery staple' }),
    }, env)
    events.length = 0
    settings.turnstile_enabled = true

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      events.push('turnstile')
      return Response.json({ success: true })
    })
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation((algorithm, baseKey, length) => {
      events.push('password:derive')
      return deriveBits(algorithm, baseKey, length)
    })
    const response = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'totally wrong password',
        turnstile_token: 'valid-test-token',
      }),
    }, env)

    expect(response.status).toBe(401)
    expect(events).toEqual([
      'limiter:/check',
      'turnstile',
      'limiter:/attempt',
      'db:read',
      'password:derive',
      'limiter:/failure',
      'db:write',
    ])
  })

  it('sends only keyed digests and gives normalized email variants the same account identity', async () => {
    const database = new AuthDatabase()
    const rateLimit = new FakeAuthRateLimitNamespace({ path: '/attempt', type: 'blocked' })
    const env = authEnv(database, rateLimit)
    const app = createApp()

    for (const email of ['Alice@Example.com', ' alice@example.com ']) {
      await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.4',
        },
        body: JSON.stringify({ email, password: 'wrong password' }),
      }, env)
    }

    const attempts = rateLimit.requests.filter((request) => request.path === '/attempt')
    expect(attempts).toHaveLength(2)
    expect(attempts[0].body.account_digest).toBe(attempts[1].body.account_digest)
    expect(attempts[0].body.account_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(attempts[0].body.ip_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(attempts[0].body).not.toHaveProperty('email')
    expect(attempts[0].body).not.toHaveProperty('ip')
    expect(JSON.stringify(rateLimit.requests)).not.toContain('alice@example.com')
    expect(JSON.stringify(rateLimit.requests)).not.toContain('203.0.113.4')
    expect(rateLimit.objectNames).toEqual(Array(4).fill('test:auth-rate-limit:v1'))
  })

  it('fails closed before database and password work when the limiter binding is unavailable', async () => {
    const database = new AuthDatabase()
    const env = authEnv(database, null)
    const app = createApp()

    const response = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'wrong password' }),
    }, env)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'auth_rate_limit_unavailable' })
    expect(database.writes).toHaveLength(0)
    expect(database.reads).toHaveLength(0)
  })

  it('rotates refresh tokens atomically and revokes the family when an old token is replayed', async () => {
    const database = new AuthDatabase()
    const env = authEnv(database)
    const app = createApp()
    const registered = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery staple' }),
    }, env)
    const first = (await registered.json() as { data: { refresh_token: string } }).data

    const refreshed = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: first.refresh_token }),
    }, env)
    const second = await refreshed.json() as {
      code: number
      data: { access_token: string; refresh_token: string }
    }

    expect(refreshed.status).toBe(200)
    expect(second.data.refresh_token).not.toBe(first.refresh_token)

    const replay = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: first.refresh_token }),
    }, env)
    expect(replay.status).toBe(401)

    const revoked = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${second.data.access_token}` },
    }, env)
    expect(revoked.status).toBe(401)
  })

  it('revokes a refresh session on logout without revealing whether the token existed', async () => {
    const database = new AuthDatabase()
    const env = authEnv(database)
    const app = createApp()
    const registered = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery staple' }),
    }, env)
    const tokens = (await registered.json() as {
      data: { access_token: string; refresh_token: string }
    }).data

    const logout = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }, env)
    const repeated = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }, env)

    expect(logout.status).toBe(200)
    expect(repeated.status).toBe(200)
    const me = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }, env)
    expect(me.status).toBe(401)
  })
})
