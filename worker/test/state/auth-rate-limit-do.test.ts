import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { AuthRateLimitDO } from '../../src/state/auth-rate-limit-do'

interface StoredLimit {
  action: string
  dimension: string
  subject_digest: string
  window_started_at_ms: number
  attempts: number
  consecutive_failures: number
  blocked_until_ms: number
  updated_at_ms: number
}

class FakeAuthRateLimitStorage {
  readonly limits = new Map<string, StoredLimit>()
  readonly sqlParameters: unknown[][] = []

  readonly sql = {
    exec: (query: string, ...parameters: unknown[]): object[] => this.exec(query, parameters),
  }

  transactionSync<T>(callback: () => T): T {
    return callback()
  }

  private exec(query: string, parameters: unknown[]): object[] {
    const normalized = query.replace(/\s+/g, ' ').trim()
    this.sqlParameters.push([...parameters])
    if (normalized.startsWith('CREATE ')) return []
    if (normalized.startsWith('DELETE FROM auth_rate_limits WHERE updated_at_ms <')) {
      const before = Number(parameters[0])
      for (const [key, value] of this.limits) {
        if (value.updated_at_ms < before) this.limits.delete(key)
      }
      return []
    }
    if (normalized.startsWith('DELETE FROM auth_rate_limits WHERE action =')) {
      this.limits.delete(keyOf(String(parameters[0]), String(parameters[1]), String(parameters[2])))
      return []
    }
    if (normalized.includes('FROM auth_rate_limits') && normalized.includes('subject_digest = ?')) {
      const value = this.limits.get(
        keyOf(String(parameters[0]), String(parameters[1]), String(parameters[2])),
      )
      return value === undefined ? [] : [{ ...value }]
    }
    if (normalized.startsWith('INSERT INTO auth_rate_limits')) {
      const value: StoredLimit = {
        action: String(parameters[0]),
        dimension: String(parameters[1]),
        subject_digest: String(parameters[2]),
        window_started_at_ms: Number(parameters[3]),
        attempts: Number(parameters[4]),
        consecutive_failures: Number(parameters[5]),
        blocked_until_ms: Number(parameters[6]),
        updated_at_ms: Number(parameters[7]),
      }
      this.limits.set(keyOf(value.action, value.dimension, value.subject_digest), value)
      return []
    }
    throw new Error(`Unexpected SQL in test: ${normalized}`)
  }
}

function keyOf(action: string, dimension: string, digest: string): string {
  return `${action}:${dimension}:${digest}`
}

function createHarness(): { object: AuthRateLimitDO; storage: FakeAuthRateLimitStorage } {
  const storage = new FakeAuthRateLimitStorage()
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
  } as unknown as DurableObjectState
  return { object: new AuthRateLimitDO(state), storage }
}

class InProcessAuthRateLimitNamespace {
  readonly requests: string[] = []

  constructor(
    readonly object: AuthRateLimitDO,
    private readonly events?: string[],
  ) {}

  idFromName(name: string): DurableObjectId {
    return { toString: () => name } as DurableObjectId
  }

  get(): DurableObjectStub {
    return {
      fetch: (request: Request) => {
        const path = new URL(request.url).pathname
        this.requests.push(path)
        this.events?.push(`limiter:${path}`)
        return this.object.fetch(request)
      },
    } as unknown as DurableObjectStub
  }
}

class MissingUserDatabase {
  reads = 0
  writes = 0

  constructor(private readonly events?: string[]) {}

  prepare(): D1PreparedStatement {
    const database = this
    const statement = {
      bind: () => statement,
      first: async () => {
        database.events?.push('db:read')
        database.reads += 1
        return null
      },
      run: async () => {
        database.events?.push('db:write')
        database.writes += 1
        return {
          success: true,
          results: [],
          meta: { changes: 1 } as unknown as D1Meta & Record<string, unknown>,
        }
      },
    }
    return statement as unknown as D1PreparedStatement
  }
}

function integrationEnv(
  database: MissingUserDatabase,
  namespace: InProcessAuthRateLimitNamespace,
): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: 'p'.repeat(32),
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: database as unknown as D1Database,
    CONFIG_KV: {
      get: async () => ({ registration_enabled: true, turnstile_enabled: true }),
    } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
    AUTH_RATE_LIMIT: namespace as unknown as DurableObjectNamespace,
  }
}

const IP_DIGEST = '1'.repeat(64)
const OTHER_IP_DIGEST = '2'.repeat(64)
const ACCOUNT_DIGEST = 'a'.repeat(64)

function post(
  object: AuthRateLimitDO,
  path: '/check' | '/attempt' | '/failure' | '/success',
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return object.fetch(new Request(`https://auth-rate-limit.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 1,
      action: 'login',
      ip_digest: IP_DIGEST,
      account_digest: ACCOUNT_DIGEST,
      ...overrides,
    }),
  }))
}

describe('AuthRateLimitDO contract', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-03T00:00:00.000Z') }))
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('applies increasing account cooldown and a successful authentication clears it', async () => {
    const { object } = createHarness()

    for (let failure = 0; failure < 3; failure += 1) {
      expect((await post(object, '/attempt')).status).toBe(200)
      expect((await post(object, '/failure')).status).toBe(200)
    }

    const blocked = await post(object, '/attempt', { ip_digest: OTHER_IP_DIGEST })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('2')
    await expect(blocked.json()).resolves.toMatchObject({
      allowed: false,
      blocked_by: ['account'],
      retry_after_seconds: 2,
    })

    vi.advanceTimersByTime(2_000)
    expect((await post(object, '/attempt', { ip_digest: OTHER_IP_DIGEST })).status).toBe(200)
    expect((await post(object, '/failure', { ip_digest: OTHER_IP_DIGEST })).status).toBe(200)
    const increasinglyBlocked = await post(object, '/attempt', { ip_digest: OTHER_IP_DIGEST })
    expect(increasinglyBlocked.status).toBe(429)
    expect(increasinglyBlocked.headers.get('retry-after')).toBe('4')

    expect((await post(object, '/success')).status).toBe(200)
    const afterSuccess = await post(object, '/attempt', { ip_digest: OTHER_IP_DIGEST })
    expect(afterSuccess.status).toBe(200)
  })

  it('keeps the IP dimension blocked across account successes', async () => {
    const { object } = createHarness()

    for (let failure = 0; failure < 10; failure += 1) {
      const account_digest = failure.toString(16).padStart(64, '0')
      expect((await post(object, '/attempt', { account_digest })).status).toBe(200)
      expect((await post(object, '/failure', { account_digest })).status).toBe(200)
      expect((await post(object, '/success', { account_digest })).status).toBe(200)
    }

    const blocked = await post(object, '/attempt', { account_digest: 'f'.repeat(64) })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    await expect(blocked.json()).resolves.toMatchObject({
      allowed: false,
      blocked_by: ['ip'],
    })
  })

  it('atomically admits no more than the account attempt budget under concurrency', async () => {
    const { object } = createHarness()

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => post(object, '/attempt')),
    )

    expect(responses.filter((response) => response.status === 200)).toHaveLength(10)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(10)
  })

  it('checks both dimensions without consuming either attempt budget', async () => {
    const { object, storage } = createHarness()

    for (let check = 0; check < 20; check += 1) {
      expect((await post(object, '/check')).status).toBe(200)
    }

    expect(storage.limits.size).toBe(0)
    const attempts = await Promise.all(
      Array.from({ length: 11 }, () => post(object, '/attempt')),
    )
    expect(attempts.filter((response) => response.status === 200)).toHaveLength(10)
    expect(attempts.filter((response) => response.status === 429)).toHaveLength(1)
  })

  it('limits registration bursts by IP even when every email is different', async () => {
    const { object } = createHarness()

    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => post(
      object,
      '/attempt',
      {
        action: 'register',
        account_digest: index.toString(16).padStart(64, '0'),
      },
    )))

    expect(responses.filter((response) => response.status === 200)).toHaveLength(5)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3)
  })

  it('persists only fixed-length subject digests', async () => {
    const { object, storage } = createHarness()
    await post(object, '/attempt')
    await post(object, '/failure')

    expect(Array.from(storage.limits.values())).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject_digest: IP_DIGEST }),
      expect.objectContaining({ subject_digest: ACCOUNT_DIGEST }),
    ]))
    for (const row of storage.limits.values()) {
      expect(row.subject_digest).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(JSON.stringify(storage.sqlParameters)).not.toContain('alice@example.com')
    expect(JSON.stringify(storage.sqlParameters)).not.toContain('203.0.113.4')
  })

  it('keeps invalid input and failed Turnstile outside the attempt budget, then commits before DB and PBKDF2', async () => {
    const { object, storage } = createHarness()
    const events: string[] = []
    const database = new MissingUserDatabase(events)
    const namespace = new InProcessAuthRateLimitNamespace(object, events)
    const env = integrationEnv(database, namespace)
    const app = createApp()

    const invalidPassword = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.254',
      },
      body: JSON.stringify({
        email: 'victim@example.com',
        password: 'short',
      }),
    }, env)
    expect(invalidPassword.status).toBe(401)
    await expect(invalidPassword.json()).resolves.toMatchObject({ code: 'invalid_credentials' })
    expect(namespace.requests).toHaveLength(0)
    expect(storage.limits.size).toBe(0)
    expect(database.reads).toBe(0)

    for (let index = 0; index < 10; index += 1) {
      const response = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': `203.0.113.${index + 1}`,
        },
        body: JSON.stringify({
          email: 'victim@example.com',
          password: 'plausible-password',
        }),
      }, env)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ code: 'captcha_required' })
    }

    const accountLimit = Array.from(storage.limits.values()).find((limit) =>
      limit.action === 'login' && limit.dimension === 'account',
    )
    expect(accountLimit).toBeUndefined()
    expect(namespace.requests).toEqual(Array(10).fill('/check'))

    events.length = 0
    namespace.requests.length = 0
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      events.push('turnstile')
      return Response.json({ success: true })
    })
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation((algorithm, baseKey, length) => {
      events.push('password:derive')
      return deriveBits(algorithm, baseKey, length)
    })
    const legitimateAttempt = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '198.51.100.1',
      },
      body: JSON.stringify({
        email: 'victim@example.com',
        password: 'plausible-password',
        turnstile_token: 'valid-test-token',
      }),
    }, env)

    expect(legitimateAttempt.status).toBe(401)
    await expect(legitimateAttempt.json()).resolves.toMatchObject({ code: 'invalid_credentials' })
    expect(database.reads).toBe(1)
    expect(namespace.requests).toEqual(['/check', '/attempt', '/failure'])
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
})
