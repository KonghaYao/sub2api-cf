import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import type { Env, PlatformEvent } from '../../src/env'
import { consumeEmailChallengeDelivery } from '../../src/auth/email-challenges'
import { hashPassword } from '../../src/auth/password'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'email-binding-test-pepper-is-at-least-32-bytes'
const DAY_MS = 86_400_000

interface BindingEvent extends PlatformEvent<{
  challenge_id: string
  user_id: string
  email_hash: string
  purpose: string
  recipient_email: string
  token: string
  action_url: string
  site_name: string
  locale: string
  expires_at_ms: number
  generation: number
}> {}

interface Fixture {
  raw: any
  env: Env
  events: BindingEvent[]
  accessToken: string
  otherAccessToken: string
}

describe('authenticated email/password binding', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('queues one six-digit challenge bound to the authenticated OAuth-only account and target email', async () => {
    const test = await fixture()

    const first = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: ' New.Login@Example.com ',
    })
    const repeated = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'new.login@example.com',
    })

    expect(first.status).toBe(200)
    expect(repeated.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      code: 0,
      data: { message: 'Verification code sent successfully' },
    })
    expect(test.events).toHaveLength(1)
    expect(test.events[0].payload).toMatchObject({
      user_id: 'oauth-user',
      purpose: 'email_binding',
      recipient_email: 'new.login@example.com',
    })
    expect(test.events[0].payload.token).toMatch(/^\d{6}$/)
  })

  it('enforces exact and wildcard registration suffix policy at send and consume time', async () => {
    const test = await fixture()
    let whitelist = ['@qq.com', '*.edu.cn']
    test.env.CONFIG_KV = {
      get: vi.fn(async () => ({
        registration_enabled: true,
        registration_email_suffix_whitelist: whitelist,
        email_verification_enabled: true,
        turnstile_enabled: false,
        site_name: 'Sub2API Test',
      })),
    } as unknown as KVNamespace

    const rejected = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'outside@example.com',
    })
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({ code: 'EMAIL_SUFFIX_NOT_ALLOWED' })
    expect(test.events).toHaveLength(0)

    const allowed = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'student@cs.edu.cn',
    })
    expect(allowed.status).toBe(200)
    expect(test.events).toHaveLength(1)

    whitelist = ['@qq.com']
    const policyChanged = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'student@cs.edu.cn',
      verify_code: test.events[0].payload.token,
      password: 'new-correct-horse-password',
    })
    expect(policyChanged.status).toBe(400)
    await expect(policyChanged.json()).resolves.toMatchObject({ code: 'EMAIL_SUFFIX_NOT_ALLOWED' })
    expect(test.raw.prepare(
      `SELECT status FROM email_binding_challenges WHERE user_id = 'oauth-user'`,
    ).get()).toEqual({ status: 'pending' })
  })

  it('delivers the binding challenge through the existing D1 lease and consumes duplicate queue events idempotently', async () => {
    const test = await fixture()
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'new.login@example.com',
    })
    const recipients: string[] = []
    test.env.EMAIL_DELIVERY = {
      fetch: vi.fn(async (request: Request) => {
        const body = await request.json() as { recipient_email: string }
        recipients.push(body.recipient_email)
        return new Response(null, { status: 202 })
      }),
    } as unknown as Fetcher

    await expect(consumeEmailChallengeDelivery(test.events[0], test.env)).resolves.toBe('delivered')
    await expect(consumeEmailChallengeDelivery(test.events[0], test.env)).resolves.toBe('already_delivered')
    expect(recipients).toEqual(['new.login@example.com'])
  })

  it('binds an OAuth-only account, revokes every old session, rejects replay, and enables password login', async () => {
    const test = await fixture()
    const before = await get(test, '/api/v1/user/profile')
    await expect(before.json()).resolves.toMatchObject({
      data: {
        has_password: false,
        password_binding_required: true,
        email_bound: false,
        auth_bindings: {
          email: { bound: false, can_bind: true, verified_at: expect.any(String) },
        },
      },
    })
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'new.login@example.com',
    })

    const bound = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'new.login@example.com',
      verify_code: test.events[0].payload.token,
      password: 'new-correct-horse-password',
    })

    expect(bound.status).toBe(200)
    await expect(bound.json()).resolves.toMatchObject({
      code: 0,
      data: {
        email: 'new.login@example.com',
        has_password: true,
        password_binding_required: false,
        email_bound: true,
      },
    })
    expect((await get(test, '/api/v1/user/profile')).status).toBe(401)
    expect((await get(test, '/api/v1/user/profile', test.otherAccessToken)).status).toBe(401)

    const login = await post(test, '/api/v1/auth/login', {
      email: 'new.login@example.com',
      password: 'new-correct-horse-password',
    })
    expect(login.status).toBe(200)
    const loginBody = await login.json() as { data: { access_token: string } }
    const replay = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'new.login@example.com',
      verify_code: test.events[0].payload.token,
      password: 'new-correct-horse-password',
    }, loginBody.data.access_token)
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
  })

  it('requires an existing password user to re-enter the current password and never treats it as a replacement', async () => {
    const test = await fixture()
    test.raw.prepare(
      `UPDATE users SET password_credential = ?, password_changed_at_ms = ? WHERE id = 'oauth-user'`,
    ).run(await hashPassword('existing-correct-password'), Date.now())
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'replacement@example.com',
    })
    const token = test.events[0].payload.token

    const bogusCodeWrongPassword = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'replacement@example.com',
      verify_code: token === '000000' ? '000001' : '000000',
      password: 'attacker-chosen-new-password',
    })
    expect(bogusCodeWrongPassword.status).toBe(400)
    await expect(bogusCodeWrongPassword.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })

    const bypass = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'replacement@example.com',
      verify_code: token,
      password: 'attacker-chosen-new-password',
    })
    expect(bypass.status).toBe(401)
    await expect(bypass.json()).resolves.toMatchObject({ code: 'invalid_current_password' })

    const replaced = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'replacement@example.com',
      verify_code: token,
      password: 'existing-correct-password',
    })
    expect(replaced.status).toBe(200)
    const login = await post(test, '/api/v1/auth/login', {
      email: 'replacement@example.com',
      password: 'existing-correct-password',
    })
    expect(login.status).toBe(200)
    const attackerPassword = await post(test, '/api/v1/auth/login', {
      email: 'replacement@example.com',
      password: 'attacker-chosen-new-password',
    })
    expect(attackerPassword.status).toBe(401)
  })

  it('locks a binding challenge after five wrong codes and rejects the correct code afterward', async () => {
    const test = await fixture()
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'attempts@example.com',
    })
    const correctCode = test.events[0].payload.token
    const wrongCode = correctCode === '000000' ? '000001' : '000000'

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await post(test, '/api/v1/user/account-bindings/email', {
        email: 'attempts@example.com',
        verify_code: wrongCode,
        password: 'new-correct-horse-password',
      })
      expect(rejected.status).toBe(400)
      await expect(rejected.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
    }
    const locked = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'attempts@example.com',
      verify_code: correctCode,
      password: 'new-correct-horse-password',
    })
    expect(locked.status).toBe(400)
    await expect(locked.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
  })

  it('rejects an expired code without changing the public password-binding state', async () => {
    const test = await fixture()
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'expired@example.com',
    })
    const current = Date.now()
    test.raw.prepare(
      `UPDATE email_binding_challenges
          SET created_at_ms = ?, expires_at_ms = ?, updated_at_ms = ?
        WHERE user_id = 'oauth-user'`,
    ).run(current - 2_000, current - 1_000, current)

    const expired = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'expired@example.com',
      verify_code: test.events[0].payload.token,
      password: 'new-correct-horse-password',
    })
    expect(expired.status).toBe(400)
    await expect(expired.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
    await expect((await get(test, '/api/v1/user/profile')).json()).resolves.toMatchObject({
      data: { has_password: false, password_binding_required: true },
    })
  })

  it('allows only the exact session that requested the code to consume it', async () => {
    const test = await fixture()
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'session-bound@example.com',
    })
    const payload = {
      email: 'session-bound@example.com',
      verify_code: test.events[0].payload.token,
      password: 'new-correct-horse-password',
    }

    const wrongSession = await post(
      test,
      '/api/v1/user/account-bindings/email',
      payload,
      test.otherAccessToken,
    )
    expect(wrongSession.status).toBe(400)
    await expect(wrongSession.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })

    const correctSession = await post(test, '/api/v1/user/account-bindings/email', payload)
    expect(correctSession.status).toBe(200)
  })

  it('invalidates a code after auth_version changes and rotates it immediately for the retained session', async () => {
    const test = await fixture()
    test.raw.prepare(
      `UPDATE users SET password_credential = ?, password_changed_at_ms = ? WHERE id = 'oauth-user'`,
    ).run(await hashPassword('before-security-change'), Date.now())
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'version-bound@example.com',
    })
    const staleToken = test.events[0].payload.token

    const passwordChanged = await put(test, '/api/v1/user/password', {
      old_password: 'before-security-change',
      new_password: 'after-security-change',
    })
    expect(passwordChanged.status).toBe(200)
    const stale = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'version-bound@example.com',
      verify_code: staleToken,
      password: 'after-security-change',
    })
    expect(stale.status).toBe(400)
    await expect(stale.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })

    const rotated = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'version-bound@example.com',
    })
    expect(rotated.status).toBe(200)
    expect(test.events).toHaveLength(2)
    expect(test.events[1].payload.token).not.toBe(staleToken)
    const rebound = await post(test, '/api/v1/user/account-bindings/email', {
      email: 'version-bound@example.com',
      verify_code: test.events[1].payload.token,
      password: 'after-security-change',
    })
    expect(rebound.status).toBe(200)
  })

  it('fails closed before delivery when the exact address or canonical inbox belongs to another account', async () => {
    const test = await fixture()
    const current = Date.now()
    for (const [id, email] of [
      ['exact-owner', 'taken@example.com'],
      ['alias-owner', 'some.one+existing@gmail.com'],
    ] as const) {
      test.raw.prepare(
        `INSERT INTO users (
           id, email, display_name, role, status, balance_micros, state_version,
           created_at_ms, updated_at_ms, password_credential, auth_version,
           email_verified_at_ms
         ) VALUES (?, ?, ?, 'user', 'active', 0, 0, ?, ?, NULL, 1, ?)`,
      ).run(id, email, id, current, current, current)
    }

    const exact = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'TAKEN@example.com',
    })
    expect(exact.status).toBe(409)
    await expect(exact.json()).resolves.toMatchObject({ code: 'email_exists' })

    const alias = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'someone@googlemail.com',
    })
    expect(alias.status).toBe(409)
    await expect(alias.json()).resolves.toMatchObject({ code: 'email_exists' })
    expect(test.events).toHaveLength(0)
  })

  it('rejects synthetic OAuth placeholder domains, including FQDN-root-dot variants', async () => {
    const test = await fixture()

    const reserved = await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'placeholder@oidc-connect.invalid.',
    })

    expect(reserved.status).toBe(400)
    await expect(reserved.json()).resolves.toMatchObject({ code: 'email_reserved' })
    expect(test.events).toHaveLength(0)
  })

  it('allows only one concurrent binding for two aliases of the same inbox', async () => {
    const test = await fixture()
    const secondAccess = await addOAuthUserSession(
      test,
      'oauth-user-2',
      'oauth-user-2@example.com',
    )
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'parallel+one@gmail.com',
    })
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'p.a.r.a.l.l.e.l+two@googlemail.com',
    }, secondAccess)
    expect(test.events).toHaveLength(2)

    const [first, second] = await Promise.all([
      post(test, '/api/v1/user/account-bindings/email', {
        email: 'parallel+one@gmail.com',
        verify_code: test.events[0].payload.token,
        password: 'first-new-correct-password',
      }),
      post(test, '/api/v1/user/account-bindings/email', {
        email: 'p.a.r.a.l.l.e.l+two@googlemail.com',
        verify_code: test.events[1].payload.token,
        password: 'second-new-correct-password',
      }, secondAccess),
    ])

    expect([first.status, second.status].sort()).toEqual([200, 409])
    const conflict = first.status === 409 ? first : second
    await expect(conflict.json()).resolves.toMatchObject({ code: 'email_exists' })
  })

  it('atomically arbitrates a canonical inbox raced by password registration and binding', async () => {
    const test = await fixture()
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'r.a.c.e+binding@gmail.com',
    })
    test.env.CONFIG_KV = {
      get: vi.fn(async () => ({
        registration_enabled: true,
        email_verification_enabled: false,
        turnstile_enabled: false,
      })),
    } as unknown as KVNamespace

    const [binding, registration] = await Promise.all([
      post(test, '/api/v1/user/account-bindings/email', {
        email: 'r.a.c.e+binding@gmail.com',
        verify_code: test.events[0].payload.token,
        password: 'binding-correct-horse-password',
      }),
      post(test, '/api/v1/auth/register', {
        email: 'race+registration@googlemail.com.',
        password: 'registration-correct-horse-password',
      }),
    ])

    expect([binding.status, registration.status].sort((left, right) => left - right))
      .toEqual(expect.arrayContaining([409]))
    expect([binding.status, registration.status].filter((status) => status === 200 || status === 201))
      .toHaveLength(1)
  })

  it('allows only one concurrent consume of the same session-bound challenge', async () => {
    const test = await fixture()
    await post(test, '/api/v1/user/account-bindings/email/send-code', {
      email: 'single-consume@example.com',
    })
    const payload = {
      email: 'single-consume@example.com',
      verify_code: test.events[0].payload.token,
      password: 'single-consume-correct-password',
    }

    const responses = await Promise.all([
      post(test, '/api/v1/user/account-bindings/email', payload),
      post(test, '/api/v1/user/account-bindings/email', payload),
    ])

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1)
    const rejected = responses.filter((response) => response.status !== 200)
    expect(rejected).toHaveLength(1)
    expect([401, 409]).toContain(rejected[0].status)
  })
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, balance_micros, state_version,
       created_at_ms, updated_at_ms, password_credential, auth_version,
       email_verified_at_ms
     ) VALUES (?, ?, ?, 'user', 'active', 0, 0, ?, ?, NULL, 1, ?)`,
  ).run('oauth-user', 'oauth-user@example.com', 'OAuth User', now, now, now)

  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  const otherAccessToken = createOpaqueToken('access')
  const otherRefreshToken = createOpaqueToken('refresh')
  for (const [id, familyId, access, refresh] of [
    ['current-session', 'current-family', accessToken, refreshToken],
    ['other-session', 'other-family', otherAccessToken, otherRefreshToken],
  ] as const) {
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
       ) VALUES (?, ?, 'oauth-user', 1, ?, ?, ?, ?, ?, 'vitest')`,
    ).run(
      id,
      familyId,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      now,
      now + DAY_MS,
      now + 30 * DAY_MS,
    )
  }

  const events: BindingEvent[] = []
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    ASSETS: { fetch: async () => new Response('asset') },
    DB: d1,
    CONFIG_KV: {
      get: vi.fn(async () => ({
        registration_enabled: true,
        email_verification_enabled: true,
        turnstile_enabled: false,
        site_name: 'Sub2API Test',
      })),
    },
    OBJECTS: {},
    EVENTS_QUEUE: {
      send: vi.fn(async (event: PlatformEvent) => { events.push(event as BindingEvent) }),
    },
    AUTH_RATE_LIMIT: rateLimitNamespace(),
    USER_STATE: {},
    POOL_STATE: {},
  } as unknown as Env
  return { raw, env, events, accessToken, otherAccessToken }
}

async function addOAuthUserSession(test: Fixture, userId: string, email: string): Promise<string> {
  const current = Date.now()
  test.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, balance_micros, state_version,
       created_at_ms, updated_at_ms, password_credential, auth_version,
       email_verified_at_ms
     ) VALUES (?, ?, ?, 'user', 'active', 0, 0, ?, ?, NULL, 1, ?)`,
  ).run(userId, email, userId, current, current, current)
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  test.raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'vitest')`,
  ).run(
    `${userId}-session`,
    `${userId}-family`,
    userId,
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    current,
    current + DAY_MS,
    current + 30 * DAY_MS,
  )
  return access
}

async function post(
  test: Fixture,
  path: string,
  body: Record<string, unknown>,
  accessToken = test.accessToken,
): Promise<Response> {
  return await createApp().request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.42',
    },
    body: JSON.stringify(body),
  }, test.env)
}

async function get(test: Fixture, path: string, accessToken = test.accessToken): Promise<Response> {
  return await createApp().request(path, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, test.env)
}

async function put(
  test: Fixture,
  path: string,
  body: Record<string, unknown>,
  accessToken = test.accessToken,
): Promise<Response> {
  return await createApp().request(path, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }, test.env)
}

function rateLimitNamespace(): DurableObjectNamespace {
  return {
    idFromName: vi.fn(() => ({ toString: () => 'email-binding-rate-limit' })),
    get: vi.fn(() => ({
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname
        if (path === '/success') {
          return Response.json({ schema_version: 1, cleared: ['account'] })
        }
        if (path === '/failure') {
          return Response.json({ schema_version: 1, recorded: true })
        }
        return Response.json({ schema_version: 1, allowed: true, retry_after_seconds: 0 })
      }),
    })),
  } as unknown as DurableObjectNamespace
}
