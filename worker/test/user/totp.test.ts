import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateTotpCode } from '../../src/auth/totp'
import { hashPassword } from '../../src/auth/password'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { sha256Hex } from '../../src/gateway/crypto'
import { consumeEvents } from '../../src/gateway/queue'
import {
  consumeTotpEmailVerificationDelivery,
  isTotpEmailVerificationEvent,
  type TotpEmailVerificationEvent,
} from '../../src/user/totp'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.parse('2026-09-04T12:00:00.000Z')
const DAY_MS = 86_400_000
const PASSWORD = 'correct horse battery staple'
const PEPPER = 'totp-test-api-key-pepper-32-byte-value'
const MASTER_KEY = 'totp-test-master-key-that-is-at-least-32-bytes'

class CapturingQueue {
  readonly events: unknown[] = []

  async send(body: unknown): Promise<void> {
    this.events.push(body)
  }
}

class AllowingRateLimitNamespace {
  readonly paths: string[] = []

  idFromName(name: string): DurableObjectId {
    return { toString: () => name } as DurableObjectId
  }

  get(): DurableObjectStub {
    return {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
        this.paths.push(path)
        if (path === '/failure') return Response.json({ schema_version: 1, recorded: true })
        if (path === '/success') return Response.json({ schema_version: 1, cleared: ['account'] })
        return Response.json({ schema_version: 1, allowed: true })
      },
    } as unknown as DurableObjectStub
  }
}

interface Fixture {
  raw: any
  env: Env
  queue: CapturingQueue
  authorization: Record<'alice' | 'bob' | 'admin', string>
}

async function fixture(emailVerificationEnabled = false): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const passwordCredential = await hashPassword(PASSWORD)
  for (const [id, email, role] of [
    ['alice', 'alice@example.test', 'user'],
    ['bob', 'bob@example.test', 'user'],
    ['admin', 'admin@example.test', 'admin'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, auth_version, password_credential,
         password_changed_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
    ).run(id, email, id, role, passwordCredential, NOW, NOW, NOW)
  }

  const authorization = {} as Fixture['authorization']
  for (const userId of ['alice', 'bob', 'admin'] as const) {
    const accessToken = createOpaqueToken('access')
    const refreshToken = createOpaqueToken('refresh')
    authorization[userId] = `Bearer ${accessToken}`
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'fixture')`,
    ).run(
      `${userId}-session`,
      `${userId}-family`,
      userId,
      await tokenDigest(accessToken, PEPPER, 'access'),
      await tokenDigest(refreshToken, PEPPER, 'refresh'),
      NOW,
      NOW + DAY_MS,
      NOW + 30 * DAY_MS,
    )
  }

  const queue = new CapturingQueue()
  const limiter = new AllowingRateLimitNamespace()
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: {
      get: async () => ({
        registration_enabled: true,
        email_verification_enabled: emailVerificationEnabled,
        turnstile_enabled: false,
        site_name: 'TOTP Test',
      }),
    } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: queue as unknown as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
    AUTH_RATE_LIMIT: limiter as unknown as DurableObjectNamespace,
  } satisfies Env
  return { raw, env, queue, authorization }
}

async function api(
  test: Fixture,
  path: string,
  options: {
    user?: keyof Fixture['authorization']
    body?: Record<string, unknown>
    method?: string
    authorization?: string
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  const authorization = options.authorization ??
    (options.user === undefined ? undefined : test.authorization[options.user])
  if (authorization !== undefined) headers.authorization = authorization
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return createApp().request(path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }, test.env)
}

async function data(response: Response): Promise<any> {
  return (await response.json() as { data: unknown }).data
}

async function startPasswordSetup(test: Fixture, user: 'alice' | 'admin' = 'alice'): Promise<{
  secret: string
  setup_token: string
}> {
  const response = await api(test, '/api/v1/user/totp/setup', {
    user,
    body: { password: PASSWORD },
  })
  expect(response.status).toBe(200)
  return data(response)
}

async function enableFromSetup(
  test: Fixture,
  setup: { secret: string; setup_token: string },
  user: 'alice' | 'admin' = 'alice',
): Promise<Response> {
  return api(test, '/api/v1/user/totp/enable', {
    user,
    body: {
      setup_token: setup.setup_token,
      totp_code: await generateTotpCode(setup.secret, Date.now()),
    },
  })
}

async function addFixtureSession(
  test: Fixture,
  userId: 'alice' | 'bob' | 'admin',
  sessionId: string,
): Promise<string> {
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  test.raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'fixture-extra')`,
  ).run(
    sessionId,
    `${sessionId}-family`,
    userId,
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    NOW,
    NOW + DAY_MS,
    NOW + 30 * DAY_MS,
  )
  return `Bearer ${accessToken}`
}

describe('Worker-native TOTP HTTP contract', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }))
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('completes setup, two-stage login, session-bound step-up, and disable', async () => {
    const test = await fixture()
    const initialStatus = await api(test, '/api/v1/user/totp/status', { user: 'alice' })
    await expect(data(initialStatus)).resolves.toEqual({
      enabled: false,
      enabled_at: null,
      feature_enabled: true,
    })
    const method = await api(test, '/api/v1/user/totp/verification-method', { user: 'alice' })
    await expect(data(method)).resolves.toEqual({ method: 'password' })

    const setup = await startPasswordSetup(test)
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(setup.setup_token).toMatch(/^sts_v1_/)
    const setupRow = JSON.stringify(test.raw.prepare(
      `SELECT * FROM user_totp_setup_challenges WHERE user_id = 'alice'`,
    ).get())
    expect(setupRow).not.toContain(setup.secret)
    expect(setupRow).not.toContain(setup.setup_token)
    expect((await enableFromSetup(test, setup)).status).toBe(200)

    const credentialRow = JSON.stringify(test.raw.prepare(
      `SELECT * FROM user_totp_credentials WHERE user_id = 'alice'`,
    ).get())
    expect(credentialRow).not.toContain(setup.secret)
    const sessionCountBeforeLogin = test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = 'alice'`,
    ).get().count as number
    const passwordLogin = await api(test, '/api/v1/auth/login', {
      body: { email: 'alice@example.test', password: PASSWORD },
    })
    expect(passwordLogin.status).toBe(200)
    const pending = await data(passwordLogin) as {
      requires_2fa: boolean
      temp_token: string
      user_email_masked: string
    }
    expect(pending).toMatchObject({ requires_2fa: true, user_email_masked: 'a***e@example.test' })
    expect(pending.temp_token).toMatch(/^stl_v1_/)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = 'alice'`,
    ).get().count).toBe(sessionCountBeforeLogin)
    expect(JSON.stringify(test.raw.prepare(
      `SELECT * FROM user_totp_login_challenges WHERE user_id = 'alice'`,
    ).get())).not.toContain(pending.temp_token)

    const loginCode = await generateTotpCode(setup.secret, NOW)
    const [first, second] = await Promise.all([
      api(test, '/api/v1/auth/login/2fa', {
        body: { temp_token: pending.temp_token, totp_code: loginCode },
      }),
      api(test, '/api/v1/auth/login/2fa', {
        body: { temp_token: pending.temp_token, totp_code: loginCode },
      }),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 400])
    const successful = first.status === 200 ? first : second
    const authenticated = await data(successful) as { access_token: string; user: { id: string } }
    expect(authenticated.user.id).toBe('alice')
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = 'alice'`,
    ).get().count).toBe(sessionCountBeforeLogin + 1)

    const stepUp = await api(test, '/api/v1/user/totp/step-up', {
      authorization: `Bearer ${authenticated.access_token}`,
      body: { code: loginCode },
    })
    expect(stepUp.status).toBe(200)
    await expect(data(stepUp)).resolves.toEqual({ verified: true, expires_in: 900 })
    expect(test.raw.prepare(
      `SELECT step_up_expires_at_ms FROM user_sessions WHERE id = 'alice-session'`,
    ).get()).toEqual({ step_up_expires_at_ms: null })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_sessions
        WHERE user_id = 'alice' AND step_up_expires_at_ms = ?`,
    ).get(NOW + 15 * 60_000)).toEqual({ count: 1 })

    const disabled = await api(test, '/api/v1/user/totp/disable', {
      authorization: `Bearer ${authenticated.access_token}`,
      body: {},
    })
    expect(disabled.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_totp_credentials WHERE user_id = 'alice'`,
    ).get()).toEqual({ count: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_sessions
        WHERE user_id = 'alice' AND step_up_expires_at_ms IS NOT NULL`,
    ).get()).toEqual({ count: 0 })
  })

  it('enforces owner, expiry, replay, and bounded setup attempts', async () => {
    const test = await fixture()
    let setup = await startPasswordSetup(test)
    const crossOwner = await api(test, '/api/v1/user/totp/enable', {
      user: 'bob',
      body: {
        setup_token: setup.setup_token,
        totp_code: await generateTotpCode(setup.secret, NOW),
      },
    })
    expect(crossOwner.status).toBe(400)
    await expect(crossOwner.json()).resolves.toMatchObject({ code: 'TOTP_SETUP_EXPIRED' })

    vi.advanceTimersByTime(5 * 60_000 + 1)
    expect((await enableFromSetup(test, setup)).status).toBe(400)
    vi.setSystemTime(NOW)

    setup = await startPasswordSetup(test)
    const validCode = await generateTotpCode(setup.secret, NOW)
    const wrongCode = validCode === '000000' ? '111111' : '000000'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await api(test, '/api/v1/user/totp/enable', {
        user: 'alice',
        body: { setup_token: setup.setup_token, totp_code: wrongCode },
      })
      expect(response.status).toBe(400)
    }
    const blocked = await api(test, '/api/v1/user/totp/enable', {
      user: 'alice',
      body: { setup_token: setup.setup_token, totp_code: validCode },
    })
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({ code: 'TOTP_TOO_MANY_ATTEMPTS' })

    setup = await startPasswordSetup(test)
    expect((await enableFromSetup(test, setup)).status).toBe(200)
    const replay = await enableFromSetup(test, setup)
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'TOTP_SETUP_EXPIRED' })
  })

  it('expires login challenges and blocks the sixth attempt even when its code is correct', async () => {
    const test = await fixture()
    const setup = await startPasswordSetup(test)
    expect((await enableFromSetup(test, setup)).status).toBe(200)
    const loginCode = await generateTotpCode(setup.secret, NOW)
    const wrongCode = loginCode === '000000' ? '111111' : '000000'
    const begin = await api(test, '/api/v1/auth/login', {
      body: { email: 'alice@example.test', password: PASSWORD },
    })
    const pending = await data(begin) as { temp_token: string }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await api(test, '/api/v1/auth/login/2fa', {
        body: { temp_token: pending.temp_token, totp_code: wrongCode },
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ code: 'TOTP_INVALID_CODE' })
    }
    const blocked = await api(test, '/api/v1/auth/login/2fa', {
      body: { temp_token: pending.temp_token, totp_code: loginCode },
    })
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({ code: 'TOTP_TOO_MANY_ATTEMPTS' })

    const rotated = await api(test, '/api/v1/auth/login', {
      body: { email: 'alice@example.test', password: PASSWORD },
    })
    const rotatedPending = await data(rotated) as { temp_token: string }
    expect(rotatedPending.temp_token).not.toBe(pending.temp_token)
    const rotationBlocked = await api(test, '/api/v1/auth/login/2fa', {
      body: { temp_token: rotatedPending.temp_token, totp_code: loginCode },
    })
    expect(rotationBlocked.status).toBe(429)
    await expect(rotationBlocked.json()).resolves.toMatchObject({
      code: 'TOTP_TOO_MANY_ATTEMPTS',
    })

    const expiryTest = await fixture()
    const expirySetup = await startPasswordSetup(expiryTest)
    expect((await enableFromSetup(expiryTest, expirySetup)).status).toBe(200)
    const expiryCode = await generateTotpCode(expirySetup.secret, NOW)
    const expiryLogin = await api(expiryTest, '/api/v1/auth/login', {
      body: { email: 'alice@example.test', password: PASSWORD },
    })
    const expiryPending = await data(expiryLogin) as { temp_token: string }
    vi.advanceTimersByTime(5 * 60_000 + 1)
    const expired = await api(expiryTest, '/api/v1/auth/login/2fa', {
      body: { temp_token: expiryPending.temp_token, totp_code: expiryCode },
    })
    expect(expired.status).toBe(400)
    await expect(expired.json()).resolves.toMatchObject({ code: 'TOTP_LOGIN_EXPIRED' })
  })

  it('atomically caps concurrent setup attempts at five', async () => {
    const test = await fixture()
    const setup = await startPasswordSetup(test)
    const validCode = await generateTotpCode(setup.secret, NOW)
    const wrongCode = validCode === '000000' ? '111111' : '000000'
    const responses = await Promise.all(Array.from({ length: 6 }, () => api(
      test,
      '/api/v1/user/totp/enable',
      {
        user: 'alice',
        body: { setup_token: setup.setup_token, totp_code: wrongCode },
      },
    )))
    expect(responses.map((response) => response.status).sort()).toEqual([400, 400, 400, 400, 400, 429])
    expect(test.raw.prepare(
      `SELECT verification_attempts FROM user_totp_setup_challenges WHERE user_id = 'alice'`,
    ).get()).toEqual({ verification_attempts: 5 })
  })

  it('atomically caps concurrent login attempts with the owner-wide budget', async () => {
    const test = await fixture()
    const setup = await startPasswordSetup(test)
    expect((await enableFromSetup(test, setup)).status).toBe(200)
    const validCode = await generateTotpCode(setup.secret, NOW)
    const wrongCode = validCode === '000000' ? '111111' : '000000'
    const begin = await api(test, '/api/v1/auth/login', {
      body: { email: 'alice@example.test', password: PASSWORD },
    })
    const pending = await data(begin) as { temp_token: string }

    const responses = await Promise.all(Array.from({ length: 6 }, () => api(
      test,
      '/api/v1/auth/login/2fa',
      { body: { temp_token: pending.temp_token, totp_code: wrongCode } },
    )))
    expect(responses.map((response) => response.status).sort()).toEqual([400, 400, 400, 400, 400, 429])
    expect(test.raw.prepare(
      `SELECT verification_attempts FROM user_totp_login_challenges WHERE user_id = 'alice'`,
    ).get()).toEqual({ verification_attempts: 5 })
    expect(test.raw.prepare(
      `SELECT attempt_count FROM user_totp_verification_budgets WHERE user_id = 'alice'`,
    ).get()).toEqual({ attempt_count: 5 })
  })

  it('uses step-up only for its current, unexpired session when disabling TOTP', async () => {
    const test = await fixture()
    const setup = await startPasswordSetup(test)
    expect((await enableFromSetup(test, setup)).status).toBe(200)
    const code = await generateTotpCode(setup.secret, NOW)

    const noGrant = await api(test, '/api/v1/user/totp/disable', {
      user: 'alice', body: {},
    })
    expect(noGrant.status).toBe(400)
    await expect(noGrant.json()).resolves.toMatchObject({ code: 'PASSWORD_REQUIRED' })

    const secondAuthorization = await addFixtureSession(test, 'alice', 'alice-second-session')
    expect((await api(test, '/api/v1/user/totp/step-up', {
      user: 'alice', body: { code },
    })).status).toBe(200)

    const crossSession = await api(test, '/api/v1/user/totp/disable', {
      authorization: secondAuthorization, body: {},
    })
    expect(crossSession.status).toBe(400)
    await expect(crossSession.json()).resolves.toMatchObject({ code: 'PASSWORD_REQUIRED' })

    test.raw.prepare(
      `UPDATE user_sessions SET step_up_expires_at_ms = ? WHERE id = 'alice-session'`,
    ).run(NOW)
    const expired = await api(test, '/api/v1/user/totp/disable', {
      user: 'alice', body: {},
    })
    expect(expired.status).toBe(400)
    await expect(expired.json()).resolves.toMatchObject({ code: 'PASSWORD_REQUIRED' })

    expect((await api(test, '/api/v1/user/totp/step-up', {
      user: 'alice', body: { code },
    })).status).toBe(200)
    const validGrant = await api(test, '/api/v1/user/totp/disable', {
      user: 'alice', body: {},
    })
    expect(validGrant.status).toBe(200)
  })

  it('uses email verification for regular users and password verification for admins', async () => {
    const test = await fixture(true)
    await expect(data(await api(
      test,
      '/api/v1/user/totp/verification-method',
      { user: 'alice' },
    ))).resolves.toEqual({ method: 'email' })
    await expect(data(await api(
      test,
      '/api/v1/user/totp/verification-method',
      { user: 'admin' },
    ))).resolves.toEqual({ method: 'password' })

    const sent = await api(test, '/api/v1/user/totp/send-code', {
      user: 'alice',
      body: {},
    })
    expect(sent.status).toBe(200)
    const event = test.queue.events.at(-1)
    expect(isTotpEmailVerificationEvent(event)).toBe(true)
    const verification = event as TotpEmailVerificationEvent
    const persistedChallenge = test.raw.prepare(
      `SELECT * FROM user_totp_email_challenges WHERE user_id = 'alice'`,
    ).get()
    const challenge = JSON.stringify(persistedChallenge)
    expect(challenge).not.toContain(verification.payload.verification_code)
    expect(persistedChallenge.token_hash).not.toBe(await sha256Hex([
      'sub2api/totp-email/v1',
      'alice',
      'alice@example.test',
      verification.payload.verification_code,
    ].join('\0')))

    const delivered: unknown[] = []
    test.env.EMAIL_DELIVERY = {
      fetch: async (request: Request) => {
        delivered.push(await request.json())
        return new Response(null, { status: 204 })
      },
    } as unknown as Fetcher
    await expect(consumeTotpEmailVerificationDelivery(verification, test.env)).resolves.toBe('delivered')
    await expect(consumeTotpEmailVerificationDelivery(verification, test.env)).resolves.toBe('already_delivered')
    expect(delivered).toHaveLength(1)

    const setupResponse = await api(test, '/api/v1/user/totp/setup', {
      user: 'alice',
      body: { email_code: verification.payload.verification_code },
    })
    expect(setupResponse.status).toBe(200)
    const replay = await api(test, '/api/v1/user/totp/setup', {
      user: 'alice',
      body: { email_code: verification.payload.verification_code },
    })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })

    const emailSetup = await data(setupResponse) as { secret: string; setup_token: string }
    expect((await enableFromSetup(test, emailSetup)).status).toBe(200)
    const resent = await api(test, '/api/v1/user/totp/send-code', {
      user: 'alice',
      body: {},
    })
    expect(resent.status).toBe(200)
    const disableVerification = test.queue.events.at(-1) as TotpEmailVerificationEvent
    expect(disableVerification.payload.verification_code).not.toBe(
      verification.payload.verification_code,
    )
    const oldCode = await api(test, '/api/v1/user/totp/disable', {
      user: 'alice',
      body: { email_code: verification.payload.verification_code },
    })
    expect(oldCode.status).toBe(400)
    await expect(oldCode.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
    const disable = await api(test, '/api/v1/user/totp/disable', {
      user: 'alice',
      body: { email_code: disableVerification.payload.verification_code },
    })
    expect(disable.status).toBe(200)
    const disableReplay = await api(test, '/api/v1/user/totp/disable', {
      user: 'alice',
      body: { email_code: disableVerification.payload.verification_code },
    })
    expect(disableReplay.status).toBe(400)
    await expect(disableReplay.json()).resolves.toMatchObject({ code: 'TOTP_NOT_SETUP' })

    const adminSend = await api(test, '/api/v1/user/totp/send-code', {
      user: 'admin',
      body: {},
    })
    expect(adminSend.status).toBe(400)
    const adminSetup = await startPasswordSetup(test, 'admin')
    expect((await enableFromSetup(test, adminSetup, 'admin')).status).toBe(200)
  })

  it('bounds TOTP email sends and drops a rotated stale Queue event without delivery', async () => {
    const test = await fixture(true)
    const delivered: unknown[] = []
    test.env.EMAIL_DELIVERY = {
      fetch: async (request: Request) => {
        delivered.push(await request.json())
        return new Response(null, { status: 204 })
      },
    } as unknown as Fetcher

    expect((await api(test, '/api/v1/user/totp/send-code', {
      user: 'alice', body: {},
    })).status).toBe(200)
    const stale = test.queue.events.at(-1) as TotpEmailVerificationEvent
    for (let sent = 2; sent <= 5; sent += 1) {
      test.raw.prepare(
        `UPDATE user_totp_email_challenges
            SET delivery_state = 'failed' WHERE user_id = 'alice'`,
      ).run()
      expect((await api(test, '/api/v1/user/totp/send-code', {
        user: 'alice', body: {},
      })).status).toBe(200)
    }
    const currentId = test.raw.prepare(
      `SELECT id FROM user_totp_email_challenges WHERE user_id = 'alice'`,
    ).get().id

    const ack = vi.fn()
    const retry = vi.fn()
    await consumeEvents({
      messages: [{ id: 'stale-totp-email', timestamp: new Date(NOW), body: stale, ack, retry }],
    } as unknown as MessageBatch<unknown>, test.env)
    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
    expect(delivered).toHaveLength(0)

    test.raw.prepare(
      `UPDATE user_totp_email_challenges
          SET delivery_state = 'failed' WHERE user_id = 'alice'`,
    ).run()
    const sixth = await api(test, '/api/v1/user/totp/send-code', {
      user: 'alice', body: {},
    })
    expect(sixth.status).toBe(429)
    await expect(sixth.json()).resolves.toMatchObject({ code: 'TOTP_EMAIL_RATE_LIMITED' })
    expect(test.raw.prepare(
      `SELECT id FROM user_totp_email_challenges WHERE user_id = 'alice'`,
    ).get().id).toBe(currentId)
    expect(test.queue.events).toHaveLength(5)
  })

  it('reports the feature unavailable without weakening an existing credential', async () => {
    const test = await fixture()
    const setup = await startPasswordSetup(test)
    expect((await enableFromSetup(test, setup)).status).toBe(200)
    delete test.env.CREDENTIALS_MASTER_KEY

    const status = await api(test, '/api/v1/user/totp/status', { user: 'alice' })
    await expect(data(status)).resolves.toMatchObject({ enabled: true, feature_enabled: false })
    const login = await api(test, '/api/v1/auth/login', {
      body: { email: 'alice@example.test', password: PASSWORD },
    })
    expect(login.status).toBe(503)
    await expect(login.json()).resolves.toMatchObject({ code: 'TOTP_NOT_CONFIGURED' })
  })

  it('rejects an oversized TOTP JSON body before buffering it without bound', async () => {
    const test = await fixture()
    const response = await api(test, '/api/v1/user/totp/step-up', {
      user: 'alice',
      body: { padding: 'x'.repeat(2 * 1024 * 1024) },
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ code: 'request_too_large' })
  })
})
