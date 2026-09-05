import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, PlatformEvent } from '../../src/env'
import {
  confirmEmailVerification,
  consumeEmailChallengeDelivery,
  prepareRegistrationEmailChallengeConsumption,
  requestEmailVerification,
  requestPasswordReset,
  requestRegistrationEmailVerification,
  resetPasswordWithChallenge,
  type EmailChallengeDeliveryEvent,
} from '../../src/auth/email-challenges'
import { hashPassword, verifyPassword } from '../../src/auth/password'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { loginWithPassword, registerWithPassword } from '../../src/auth/handler'
import { getMyPlatformQuotas } from '../../src/user/platform-quotas'
import { listUserSubscriptions } from '../../src/user/subscriptions'
import { recoverPendingSubscriptionState } from '../../src/control/subscriptions'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'email-challenge-test-pepper-is-at-least-32-bytes'

interface Harness {
  raw: any
  env: Env
  events: EmailChallengeDeliveryEvent[]
  accessToken: string
  app: Hono<{ Bindings: Env }>
}

describe('Worker-native email challenges', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('preserves the six-digit pre-registration contract with cooldown and an enumeration-safe response', async () => {
    const available = await fixture()
    const existing = await fixture()

    const sent = await post(available, '/api/v1/auth/send-verify-code', {
      email: 'new-user@example.com',
    })
    const repeated = await post(available, '/api/v1/auth/send-verify-code', {
      email: 'new-user@example.com',
    })
    const alreadyRegistered = await post(existing, '/api/v1/auth/send-verify-code', {
      email: 'alice@example.com',
    })

    expect(sent.status).toBe(200)
    expect(repeated.status).toBe(200)
    expect(alreadyRegistered.status).toBe(200)
    expect(await sent.json()).toEqual(await alreadyRegistered.json())
    expect(available.events).toHaveLength(1)
    expect(existing.events).toHaveLength(0)
    expect(available.events[0].payload).toMatchObject({
      purpose: 'registration_email_verification',
      user_id: null,
      recipient_email: 'new-user@example.com',
    })
    expect(available.events[0].payload.token).toMatch(/^\d{6}$/)
    const stored = available.raw.prepare(
      `SELECT token_hash, verification_attempts FROM email_challenges
        WHERE purpose = 'registration_email_verification'`,
    ).get() as { token_hash: string; verification_attempts: number }
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.token_hash).not.toBe(available.events[0].payload.token)
    expect(stored.verification_attempts).toBe(0)
  })

  it('provides an atomic pre-registration consume/claim bundle and rejects replay', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/send-verify-code', { email: 'new-user@example.com' })
    const code = test.events[0].payload.token
    const now = Date.now()
    const prepared = await prepareRegistrationEmailChallengeConsumption(
      test.env,
      'new-user@example.com',
      code,
      'new-user',
      now,
    )
    const credential = await hashPassword('new-user-correct-password')

    await test.env.DB.batch([
      prepared.consumeStatement,
      test.env.DB.prepare(
        `INSERT INTO users (
           id, email, display_name, role, status, balance_micros, state_version,
           created_at_ms, updated_at_ms, password_credential, auth_version,
           email_verified_at_ms, password_changed_at_ms
         ) VALUES (?, ?, ?, 'user', 'active', 0, 0, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        'new-user',
        'new-user@example.com',
        'New User',
        now,
        now,
        credential,
        prepared.verifiedAtMs,
        now,
      ),
      prepared.claimStatement,
    ])

    expect(test.raw.prepare(
      `SELECT email_verified_at_ms FROM users WHERE id = 'new-user'`,
    ).get()).toEqual({ email_verified_at_ms: prepared.verifiedAtMs })
    expect(test.raw.prepare(
      `SELECT user_id, email_hash FROM registration_email_challenge_claims`,
    ).get()).toEqual({ user_id: 'new-user', email_hash: prepared.emailHash })
    await expect(prepareRegistrationEmailChallengeConsumption(
      test.env,
      'new-user@example.com',
      code,
      'replayed-user',
    )).rejects.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
  })

  it('atomically consumes the pre-registration code in the real registration handler', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/send-verify-code', { email: 'registered@example.com' })
    const code = test.events[0].payload.token

    const registered = await post(test, '/api/v1/auth/register', {
      email: 'registered@example.com',
      password: 'registered-correct-horse-password',
      verify_code: code,
    })

    expect(registered.status).toBe(201)
    await expect(registered.json()).resolves.toMatchObject({
      code: 0,
      data: {
        user: {
          email: 'registered@example.com',
          auth_bindings: { email: { bound: true, verified_at: expect.any(String) } },
        },
      },
    })
    expect(test.raw.prepare(
      `SELECT email_verified_at_ms IS NOT NULL AS verified
         FROM users WHERE email = 'registered@example.com'`,
    ).get()).toEqual({ verified: 1 })
    expect(test.raw.prepare(
      `SELECT status FROM email_challenges
        WHERE purpose = 'registration_email_verification'`,
    ).get()).toEqual({ status: 'consumed' })

    const replay = await post(test, '/api/v1/auth/register', {
      email: 'replay@example.com',
      password: 'another-correct-horse-password',
      verify_code: code,
    })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
  })

  it('applies email signup defaults exactly once and exposes every entitlement publicly', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO "groups" (
         id, name, platform, group_type, daily_quota_micros,
         weekly_quota_micros, monthly_quota_micros, created_at_ms, updated_at_ms
       ) VALUES ('email-welcome', 'Email welcome', 'openai', 'subscription',
                 1000000, 5000000, 9000000, ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `UPDATE auth_source_defaults
          SET balance_micros = 12500000, concurrency = 7, grant_on_signup = 1
        WHERE source = 'email'`,
    ).run()
    test.raw.prepare(
      `INSERT INTO auth_source_default_subscriptions (source, group_id, validity_days)
       VALUES ('email', 'email-welcome', 30)`,
    ).run()
    test.raw.prepare(
      `INSERT INTO auth_source_default_platform_quotas (
         source, platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
       ) VALUES ('email', 'openai', 1250000, NULL, 8000000)`,
    ).run()
    test.env.SUBSCRIPTION_STATE = successfulStateNamespace()

    await post(test, '/api/v1/auth/send-verify-code', { email: 'grant@example.com' })
    const registered = await post(test, '/api/v1/auth/register', {
      email: 'grant@example.com',
      password: 'registered-correct-horse-password',
      verify_code: test.events[0].payload.token,
    })

    expect(registered.status).toBe(201)
    const payload = await registered.json() as any
    expect(payload.data.user).toMatchObject({ balance: 12.5, concurrency: 7 })
    const authorization = `Bearer ${payload.data.access_token}`

    const subscriptions = await test.app.request('/api/v1/subscriptions', {
      headers: { authorization },
    }, test.env)
    expect(subscriptions.status).toBe(200)
    await expect(subscriptions.json()).resolves.toMatchObject({
      data: [{ group_id: 'email-welcome', status: 'active' }],
    })
    const quotas = await test.app.request('/api/v1/user/platform-quotas', {
      headers: { authorization },
    }, test.env)
    expect(quotas.status).toBe(200)
    await expect(quotas.json()).resolves.toMatchObject({
      data: {
        platform_quotas: [{
          platform: 'openai',
          daily_limit_usd: 1.25,
          weekly_limit_usd: null,
          monthly_limit_usd: 8,
        }],
      },
    })

    const replay = await post(test, '/api/v1/auth/register', {
      email: 'grant@example.com',
      password: 'registered-correct-horse-password',
      verify_code: test.events[0].payload.token,
    })
    expect(replay.status).not.toBe(201)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM auth_source_entitlement_grants
        WHERE source = 'email' AND reason = 'signup'`,
    ).get()).toEqual({ count: 1 })
  })

  it('does not apply configured email defaults while the signup grant switch is off', async () => {
    const test = await fixture()
    test.raw.prepare(
      `UPDATE auth_source_defaults
          SET balance_micros = 99000000, concurrency = 99, grant_on_signup = 0
        WHERE source = 'email'`,
    ).run()
    await post(test, '/api/v1/auth/send-verify-code', { email: 'off@example.com' })

    const registered = await post(test, '/api/v1/auth/register', {
      email: 'off@example.com',
      password: 'registered-correct-horse-password',
      verify_code: test.events[0].payload.token,
    })

    expect(registered.status).toBe(201)
    await expect(registered.json()).resolves.toMatchObject({
      data: { user: { balance: 0, concurrency: 5 } },
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM auth_source_entitlement_grants
        WHERE source = 'email' AND reason = 'signup'`,
    ).get()).toEqual({ count: 0 })
  })

  it('leaves a durable signup subscription intent that the global recovery loop can replay', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO "groups" (id, name, platform, group_type, created_at_ms, updated_at_ms)
       VALUES ('recover-welcome', 'Recover welcome', 'openai', 'subscription', ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `UPDATE auth_source_defaults SET grant_on_signup = 1 WHERE source = 'email'`,
    ).run()
    test.raw.prepare(
      `INSERT INTO auth_source_default_subscriptions (source, group_id, validity_days)
       VALUES ('email', 'recover-welcome', 7)`,
    ).run()
    let stateCalls = 0
    test.env.SUBSCRIPTION_STATE = {
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => {
          stateCalls += 1
          return stateCalls === 1
            ? Response.json({ error: { message: 'temporary outage' } }, { status: 503 })
            : Response.json({ ok: true })
        }),
      })),
    } as unknown as DurableObjectNamespace
    await post(test, '/api/v1/auth/send-verify-code', { email: 'recover-signup@example.com' })

    const interrupted = await post(test, '/api/v1/auth/register', {
      email: 'recover-signup@example.com',
      password: 'registered-correct-horse-password',
      verify_code: test.events[0].payload.token,
    })
    expect(interrupted.status).toBe(503)
    expect(test.raw.prepare(
      `SELECT status, attempts FROM subscription_state_sync`,
    ).get()).toEqual({ status: 'pending', attempts: 1 })

    await recoverPendingSubscriptionState(test.env)
    expect(test.raw.prepare(
      `SELECT status, attempts FROM subscription_state_sync`,
    ).get()).toEqual({ status: 'applied', attempts: 1 })
    const login = await post(test, '/api/v1/auth/login', {
      email: 'recover-signup@example.com',
      password: 'registered-correct-horse-password',
    })
    expect(login.status).toBe(200)
    const token = (await login.json() as any).data.access_token as string
    const subscriptions = await test.app.request('/api/v1/subscriptions', {
      headers: { authorization: `Bearer ${token}` },
    }, test.env)
    await expect(subscriptions.json()).resolves.toMatchObject({
      data: [{ group_id: 'recover-welcome', status: 'active' }],
    })
  })

  it('durably caps wrong pre-registration verification attempts', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/send-verify-code', { email: 'attempts@example.com' })
    const correctCode = test.events[0].payload.token

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(prepareRegistrationEmailChallengeConsumption(
        test.env,
        'attempts@example.com',
        correctCode === '000000' ? '000001' : '000000',
        'attempt-user',
      )).rejects.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
    }
    expect(test.raw.prepare(
      `SELECT verification_attempts FROM email_challenges
        WHERE purpose = 'registration_email_verification'`,
    ).get()).toEqual({ verification_attempts: 5 })
    await expect(prepareRegistrationEmailChallengeConsumption(
      test.env,
      'attempts@example.com',
      correctCode,
      'attempt-user',
    )).rejects.toMatchObject({ code: 'INVALID_VERIFY_CODE' })
  })

  it('returns the same forgot-password response for known and unknown accounts and stores only a token hash', async () => {
    const known = await fixture()
    const unknown = await fixture()

    const knownResponse = await post(known, '/api/v1/auth/forgot-password', {
      email: ' ALICE@example.com ',
    })
    const unknownResponse = await post(unknown, '/api/v1/auth/forgot-password', {
      email: 'missing@example.com',
    })

    expect(knownResponse.status).toBe(200)
    expect(unknownResponse.status).toBe(200)
    expect(await knownResponse.json()).toEqual(await unknownResponse.json())
    expect(known.events).toHaveLength(1)
    expect(unknown.events).toHaveLength(0)

    const rawToken = known.events[0].payload.token
    const stored = known.raw.prepare(
      `SELECT token_hash, email_hash, purpose FROM email_challenges WHERE user_id = 'alice'`,
    ).get() as { token_hash: string; email_hash: string; purpose: string }
    expect(stored).toMatchObject({ purpose: 'password_reset' })
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.email_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(rawToken)
  })

  it('fails closed before issuing a challenge when persistent account/IP limiting is unavailable', async () => {
    const test = await fixture()
    test.env.AUTH_RATE_LIMIT = undefined

    const response = await post(test, '/api/v1/auth/forgot-password', {
      email: 'alice@example.com',
    })

    expect(response.status).toBe(503)
    expect(test.events).toHaveLength(0)
    expect(test.raw.prepare('SELECT count(*) AS count FROM email_challenges').get()).toEqual({ count: 0 })
  })

  it('retries the same queued delivery without minting another token and makes successful delivery idempotent', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/forgot-password', { email: 'alice@example.com' })
    const event = test.events[0]
    const calls: string[] = []
    const failingDelivery = serviceBinding(async (request) => {
      calls.push(await request.text())
      return new Response('temporary failure', { status: 503 })
    })
    ;(test.env as Env & { EMAIL_DELIVERY?: Fetcher }).EMAIL_DELIVERY = failingDelivery

    await expect(consumeEmailChallengeDelivery(event, test.env)).rejects.toThrow('503')
    await expect(consumeEmailChallengeDelivery(event, test.env)).rejects.toThrow('503')
    expect(new Set(calls.map((body) => JSON.parse(body).token))).toEqual(new Set([event.payload.token]))
    expect(test.raw.prepare(
      `SELECT generation, delivery_attempts, delivery_state FROM email_challenges WHERE id = ?`,
    ).get(event.payload.challenge_id)).toEqual({
      generation: 1,
      delivery_attempts: 2,
      delivery_state: 'failed',
    })

    let successfulCalls = 0
    ;(test.env as Env & { EMAIL_DELIVERY?: Fetcher }).EMAIL_DELIVERY = serviceBinding(async () => {
      successfulCalls += 1
      return new Response(null, { status: 202 })
    })
    await expect(consumeEmailChallengeDelivery(event, test.env)).resolves.toBe('delivered')
    await expect(consumeEmailChallengeDelivery(event, test.env)).resolves.toBe('already_delivered')
    expect(successfulCalls).toBe(1)
  })

  it('prefers the native Cloudflare email binding and composes escaped text and HTML', async () => {
    const test = await fixture('<Sub2API>\r\nBcc: attacker@example.com')
    await post(test, '/api/v1/auth/forgot-password', { email: 'alice@example.com' })
    const event = test.events[0]
    const sent: Array<Record<string, unknown>> = []
    let compatibilityCalls = 0
    test.env.SEND_EMAIL = {
      send: vi.fn(async (message: EmailMessage | EmailMessageBuilder) => {
        sent.push(message as unknown as Record<string, unknown>)
        return { messageId: 'native-email-1' }
      }),
    } as unknown as SendEmail
    test.env.EMAIL_FROM_ADDRESS = 'noreply@example.com'
    test.env.EMAIL_DELIVERY = serviceBinding(async () => {
      compatibilityCalls += 1
      return new Response(null, { status: 202 })
    })

    await expect(consumeEmailChallengeDelivery(event, test.env)).resolves.toBe('delivered')

    expect(compatibilityCalls).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      from: 'noreply@example.com',
      to: 'alice@example.com',
      subject: expect.stringContaining('password'),
      text: expect.stringContaining(event.payload.token),
      html: expect.stringContaining('&lt;Sub2API&gt; Bcc: attacker@example.com'),
    })
    expect(String(sent[0].subject)).not.toMatch(/[\r\n]/)
    expect(String(sent[0].html)).toContain('&amp;token=')
    expect(String(sent[0].html)).not.toContain('&token=')
  })

  it('fails explicitly when neither native nor compatibility email delivery is configured', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/forgot-password', { email: 'alice@example.com' })
    const event = test.events[0]

    await expect(consumeEmailChallengeDelivery(event, test.env)).rejects.toThrow(
      'No email delivery binding is configured',
    )
    expect(test.raw.prepare(
      `SELECT delivery_state, last_delivery_error FROM email_challenges WHERE id = ?`,
    ).get(event.payload.challenge_id)).toEqual({
      delivery_state: 'failed',
      last_delivery_error: expect.stringContaining('No email delivery binding is configured'),
    })
  })

  it('rejects a queue payload whose recipient or action was changed after issuance', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/forgot-password', { email: 'alice@example.com' })
    const tampered = structuredClone(test.events[0])
    tampered.payload.recipient_email = 'attacker@example.com'
    let deliveryCalls = 0
    ;(test.env as Env & { EMAIL_DELIVERY?: Fetcher }).EMAIL_DELIVERY = serviceBinding(async () => {
      deliveryCalls += 1
      return new Response(null, { status: 202 })
    })

    await expect(consumeEmailChallengeDelivery(tampered, test.env)).resolves.toBe('stale')
    expect(deliveryCalls).toBe(0)
  })

  it('atomically consumes a reset token, changes the password, and revokes every session', async () => {
    const test = await fixture()
    const oldCredential = test.raw.prepare(
      `SELECT password_credential FROM users WHERE id = 'alice'`,
    ).get().password_credential as string
    await post(test, '/api/v1/auth/forgot-password', { email: 'alice@example.com' })
    const token = test.events[0].payload.token

    const response = await post(test, '/api/v1/auth/reset-password', {
      email: 'alice@example.com',
      token,
      new_password: 'new-correct-horse-password',
    })

    expect(response.status).toBe(200)
    const user = test.raw.prepare(
      `SELECT password_credential, auth_version FROM users WHERE id = 'alice'`,
    ).get() as { password_credential: string; auth_version: number }
    expect(user.password_credential).not.toBe(oldCredential)
    await expect(verifyPassword('new-correct-horse-password', user.password_credential)).resolves.toBe(true)
    expect(user.auth_version).toBe(2)
    expect(test.raw.prepare(
      `SELECT count(*) AS count FROM user_sessions WHERE user_id = 'alice' AND revoked_at_ms IS NULL`,
    ).get()).toEqual({ count: 0 })
    expect(test.raw.prepare(
      `SELECT status, consume_nonce IS NOT NULL AS has_nonce FROM email_challenges WHERE user_id = 'alice'`,
    ).get()).toEqual({ status: 'consumed', has_nonce: 1 })

    const replay = await post(test, '/api/v1/auth/reset-password', {
      email: 'alice@example.com',
      token,
      new_password: 'second-password-that-must-not-win',
    })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'INVALID_RESET_TOKEN' })
  })

  it('allows only one concurrent reset consumer', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/forgot-password', { email: 'alice@example.com' })
    const token = test.events[0].payload.token
    const body = {
      email: 'alice@example.com',
      token,
      new_password: 'concurrent-safe-password',
    }

    const responses = await Promise.all([
      post(test, '/api/v1/auth/reset-password', body),
      post(test, '/api/v1/auth/reset-password', body),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
    expect(test.raw.prepare(
      `SELECT auth_version FROM users WHERE id = 'alice'`,
    ).get()).toEqual({ auth_version: 2 })
  })

  it('rejects expired, wrong-purpose, and wrong-user tokens without consuming them', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/forgot-password', { email: 'alice@example.com' })
    const resetEvent = test.events[0]

    const wrongUser = await post(test, '/api/v1/auth/reset-password', {
      email: 'bob@example.com',
      token: resetEvent.payload.token,
      new_password: 'new-password-for-bob',
    })
    expect(wrongUser.status).toBe(400)
    expect(test.raw.prepare(
      `SELECT status FROM email_challenges WHERE id = ?`,
    ).get(resetEvent.payload.challenge_id)).toEqual({ status: 'pending' })

    test.raw.prepare(
      `UPDATE email_challenges SET expires_at_ms = ? WHERE id = ?`,
    ).run(Date.now() - 1, resetEvent.payload.challenge_id)
    const expired = await post(test, '/api/v1/auth/reset-password', {
      email: 'alice@example.com',
      token: resetEvent.payload.token,
      new_password: 'new-password-after-expiry',
    })
    expect(expired.status).toBe(400)

    const verifyTest = await fixture()
    await post(verifyTest, '/api/v1/auth/email-verification/request', {}, verifyTest.accessToken)
    const verificationToken = verifyTest.events[0].payload.token
    const wrongPurpose = await post(verifyTest, '/api/v1/auth/reset-password', {
      email: 'alice@example.com',
      token: verificationToken,
      new_password: 'purpose-bound-password',
    })
    expect(wrongPurpose.status).toBe(400)
  })

  it('verifies the authenticated user email once and rejects replay', async () => {
    const test = await fixture()

    const requested = await post(
      test,
      '/api/v1/auth/email-verification/request',
      {},
      test.accessToken,
    )
    expect(requested.status).toBe(200)
    expect(test.events).toHaveLength(1)
    expect(test.events[0].payload.purpose).toBe('email_verification')

    const token = test.events[0].payload.token
    const confirmed = await post(
      test,
      '/api/v1/auth/email-verification/confirm',
      { token },
      test.accessToken,
    )
    expect(confirmed.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT email_verified_at_ms IS NOT NULL AS verified FROM users WHERE id = 'alice'`,
    ).get()).toEqual({ verified: 1 })

    const replay = await post(
      test,
      '/api/v1/auth/email-verification/confirm',
      { token },
      test.accessToken,
    )
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'INVALID_EMAIL_VERIFICATION_TOKEN' })
  })

  it('does not verify a new address with a challenge issued for the old address', async () => {
    const test = await fixture()
    await post(test, '/api/v1/auth/email-verification/request', {}, test.accessToken)
    const event = test.events[0]
    test.raw.prepare(
      `UPDATE users SET email = ?, email_verified_at_ms = NULL WHERE id = 'alice'`,
    ).run('changed@example.com')

    const confirmed = await post(
      test,
      '/api/v1/auth/email-verification/confirm',
      { token: event.payload.token },
      test.accessToken,
    )

    expect(confirmed.status).toBe(400)
    await expect(confirmed.json()).resolves.toMatchObject({ code: 'INVALID_EMAIL_VERIFICATION_TOKEN' })
    expect(test.raw.prepare(
      `SELECT email, email_verified_at_ms FROM users WHERE id = 'alice'`,
    ).get()).toEqual({ email: 'changed@example.com', email_verified_at_ms: null })
    expect(test.raw.prepare(
      `SELECT status FROM email_challenges WHERE id = ?`,
    ).get(event.payload.challenge_id)).toEqual({ status: 'pending' })
  })
})

async function fixture(siteName = 'Sub2API Test'): Promise<Harness> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  const passwordCredential = await hashPassword('old-correct-horse-password')
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, balance_micros, state_version,
       created_at_ms, updated_at_ms, password_credential, auth_version,
       password_changed_at_ms
     ) VALUES (?, ?, ?, 'user', 'active', 0, 0, ?, ?, ?, 1, ?)`,
  ).run('alice', 'alice@example.com', 'Alice', now, now, passwordCredential, now)
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, balance_micros, state_version,
       created_at_ms, updated_at_ms, password_credential, auth_version,
       password_changed_at_ms
     ) VALUES (?, ?, ?, 'user', 'active', 0, 0, ?, ?, ?, 1, ?)`,
  ).run('bob', 'bob@example.com', 'Bob', now, now, passwordCredential, now)

  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  const accessHash = await tokenDigest(accessToken, PEPPER, 'access')
  const refreshHash = await tokenDigest(refreshToken, PEPPER, 'refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, '')`,
  ).run('alice-session', 'alice-family', 'alice', accessHash, refreshHash, now, now + 60_000, now + 120_000)
  const secondAccess = await tokenDigest(createOpaqueToken('access'), PEPPER, 'access')
  const secondRefresh = await tokenDigest(createOpaqueToken('refresh'), PEPPER, 'refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, '')`,
  ).run('alice-session-2', 'alice-family-2', 'alice', secondAccess, secondRefresh, now, now + 60_000, now + 120_000)

  const events: EmailChallengeDeliveryEvent[] = []
  const env = {
    DB: d1,
    API_KEY_PEPPER: PEPPER,
    ENVIRONMENT: 'test',
    CONFIG_KV: {
      get: vi.fn(async () => ({
        registration_enabled: true,
        email_verification_enabled: true,
        turnstile_enabled: false,
        site_name: siteName,
      })),
    },
    AUTH_RATE_LIMIT: rateLimitNamespace(),
    EVENTS_QUEUE: {
      send: vi.fn(async (event: PlatformEvent) => { events.push(event as EmailChallengeDeliveryEvent) }),
    },
  } as unknown as Env

  const app = new Hono<{ Bindings: Env }>()
  app.post('/api/v1/auth/register', registerWithPassword)
  app.post('/api/v1/auth/login', loginWithPassword)
  app.post('/api/v1/auth/forgot-password', requestPasswordReset)
  app.post('/api/v1/auth/reset-password', resetPasswordWithChallenge)
  app.post('/api/v1/auth/send-verify-code', requestRegistrationEmailVerification)
  app.post('/api/v1/auth/email-verification/request', requestEmailVerification)
  app.post('/api/v1/auth/email-verification/confirm', confirmEmailVerification)
  app.get('/api/v1/subscriptions', listUserSubscriptions)
  app.get('/api/v1/user/platform-quotas', getMyPlatformQuotas)
  return { raw, env, events, accessToken, app }
}

function post(
  test: Harness,
  path: string,
  body: Record<string, unknown>,
  accessToken?: string,
): Promise<Response> {
  return Promise.resolve(test.app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.7',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  }, test.env))
}

function rateLimitNamespace(): DurableObjectNamespace {
  const response = (request: Request): Response => {
    const path = new URL(request.url).pathname
    if (path === '/success') return Response.json({ schema_version: 1, cleared: ['account'] })
    if (path === '/failure') return Response.json({ schema_version: 1, recorded: true })
    return Response.json({ schema_version: 1, allowed: true, retry_after_seconds: 0 })
  }
  return {
    idFromName: vi.fn(() => ({ toString: () => 'rate-limit-id' })),
    get: vi.fn(() => ({ fetch: vi.fn(async (request: Request) => response(request)) })),
  } as unknown as DurableObjectNamespace
}

function successfulStateNamespace(): DurableObjectNamespace {
  return {
    idFromName: vi.fn((name: string) => ({ toString: () => name })),
    get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ ok: true })) })),
  } as unknown as DurableObjectNamespace
}

function serviceBinding(handler: (request: Request) => Promise<Response>): Fetcher {
  return { fetch: vi.fn(handler) } as unknown as Fetcher
}
