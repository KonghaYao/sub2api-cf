import { env, exports } from 'cloudflare:workers'
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'

const ORIGIN = 'https://worker.e2e.invalid'

async function workerRequest(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { headers }))
}

async function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))
}

async function registerVerifiedUser(
  email: string,
  password: string,
  requestHeaders: Record<string, string> = {},
): Promise<string> {
  expect((await jsonRequest(
    '/api/v1/auth/send-verify-code', { email }, requestHeaders,
  )).status).toBe(200)
  const verification = await waitForFixtureMessage(email, 'registration_email_verification')
  const response = await jsonRequest('/api/v1/auth/register', {
    email,
    password,
    verify_code: verification.payload.token,
  }, requestHeaders)
  expect(response.status, await response.clone().text()).toBe(201)
  const body = await response.json() as { data: { access_token: string } }
  return body.data.access_token
}

async function totpCode(secret: string, timeMs = Date.now()): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let accumulator = 0
  const decoded: number[] = []
  for (const character of secret) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character)
    bits += 5
    if (bits >= 8) {
      decoded.push((accumulator >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  let counter = BigInt(Math.floor(timeMs / 30_000))
  const message = new Uint8Array(8)
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(counter & 0xffn)
    counter >>= 8n
  }
  const key = await crypto.subtle.importKey(
    'raw', new Uint8Array(decoded), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = digest.at(-1)! & 0x0f
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) >>> 0
  return String(binary % 1_000_000).padStart(6, '0')
}

async function configureVerifiedRegistration(): Promise<void> {
  await env.CONFIG_KV.put('e2e:public-settings:v1', JSON.stringify({
    site_name: 'Binding E2E',
    registration_enabled: true,
    email_verification_enabled: true,
    turnstile_enabled: false,
  }))
}

async function fixtureMessages(recipient: string): Promise<Array<{
  idempotency_key: string
  attempt_count: number
  payload: {
    recipient_email: string
    purpose: string
    token: string
    action_url: string
    site_name: string
    locale: string
    expires_at_ms: number
  }
}>> {
  if (env.EMAIL_DELIVERY === undefined) throw new Error('EMAIL_DELIVERY fixture is unavailable')
  const response = await env.EMAIL_DELIVERY.fetch(new Request(
    `https://email-delivery.internal/__test/messages?recipient=${encodeURIComponent(recipient)}`,
  ))
  expect(response.status).toBe(200)
  return response.json()
}

async function replayAuthEmailDelivery(message: Awaited<ReturnType<typeof waitForFixtureMessage>>): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, purpose, email_hash, generation, created_at_ms, expires_at_ms
       FROM email_challenges WHERE delivery_event_id = ?`,
  ).bind(message.idempotency_key).first<{
    id: string
    user_id: string | null
    purpose: string
    email_hash: string
    generation: number
    created_at_ms: number
    expires_at_ms: number
  }>()
  expect(row).not.toBeNull()
  const body = {
    schema_version: 1,
    event_id: message.idempotency_key,
    event_type: 'auth.email-challenge.delivery.v1',
    occurred_at_ms: row!.created_at_ms,
    aggregate_type: row!.user_id === null ? 'email_identity' : 'user',
    aggregate_id: row!.user_id ?? row!.email_hash,
    payload: {
      challenge_id: row!.id,
      user_id: row!.user_id,
      email_hash: row!.email_hash,
      purpose: row!.purpose,
      recipient_email: message.payload.recipient_email,
      token: message.payload.token,
      action_url: message.payload.action_url,
      site_name: message.payload.site_name,
      locale: message.payload.locale,
      expires_at_ms: row!.expires_at_ms,
      generation: row!.generation,
    },
  }
  const batch = createMessageBatch('sub2api-events-binding-e2e', [{
    id: `duplicate-${crypto.randomUUID()}`,
    timestamp: new Date(),
    attempts: 1,
    body,
  }])
  const context = createExecutionContext()
  await worker.queue(batch, env)
  const result = await getQueueResult(batch, context)
  expect(result.outcome).toBe('ok')
  expect(result.ackAll).toBe(false)
  expect(result.explicitAcks).toHaveLength(1)
}

async function waitForFixtureMessage(
  recipient: string,
  purpose?: string,
): Promise<Awaited<ReturnType<typeof fixtureMessages>>[number]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const messages = await fixtureMessages(recipient)
    const message = purpose === undefined
      ? messages.at(-1)
      : messages.slice().reverse().find((candidate) => candidate.payload.purpose === purpose)
    if (message !== undefined) return message
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Email delivery was not observed for ${recipient}`)
}

describe('Worker email identity E2E', () => {
  it('verifies a registration through the real HTTP, Queue and mail-Worker bindings', async () => {
    await configureVerifiedRegistration()
    const email = `registration-${crypto.randomUUID()}@binding-e2e.test`

    const requested = await jsonRequest('/api/v1/auth/send-verify-code', { email })
    expect(requested.status, await requested.clone().text()).toBe(200)

    const message = await waitForFixtureMessage(email)
    expect(message.payload).toMatchObject({
      recipient_email: email,
      purpose: 'registration_email_verification',
    })
    expect(message.payload.token).toMatch(/^\d{6}$/)
    expect(message.idempotency_key).toMatch(/^email-challenge:/)

    const registered = await jsonRequest('/api/v1/auth/register', {
      email,
      password: 'correct horse battery staple',
      verify_code: message.payload.token,
    })
    expect(registered.status, await registered.clone().text()).toBe(201)
    await expect(registered.json()).resolves.toMatchObject({
      code: 0,
      data: { user: { email } },
    })

    const user = await env.DB.prepare(
      'SELECT email_verified_at_ms FROM users WHERE email = ?',
    ).bind(email).first<{ email_verified_at_ms: number | null }>()
    expect(user?.email_verified_at_ms).toEqual(expect.any(Number))
  })

  it('resets a password through email and acknowledges a duplicate delivery without resending', async () => {
    await configureVerifiedRegistration()
    const email = `reset-${crypto.randomUUID()}@binding-e2e.test`
    const originalPassword = 'correct horse battery staple'
    const nextPassword = 'fresh battery horse staple'

    expect((await jsonRequest('/api/v1/auth/send-verify-code', { email })).status).toBe(200)
    const registration = await waitForFixtureMessage(email)
    expect((await jsonRequest('/api/v1/auth/register', {
      email,
      password: originalPassword,
      verify_code: registration.payload.token,
    })).status).toBe(201)

    expect((await jsonRequest('/api/v1/auth/forgot-password', { email })).status).toBe(200)
    const reset = await waitForFixtureMessage(email, 'password_reset')
    expect(reset.payload.purpose).toBe('password_reset')
    expect(reset.payload.token).toMatch(/^spr_v1_[A-Za-z0-9_-]{43}$/)
    expect(reset.attempt_count).toBe(1)

    await replayAuthEmailDelivery(reset)
    const afterReplay = await fixtureMessages(email)
    const replayed = afterReplay.find((message) => message.idempotency_key === reset.idempotency_key)
    expect(replayed?.attempt_count).toBe(1)

    const changed = await jsonRequest('/api/v1/auth/reset-password', {
      email,
      token: reset.payload.token,
      new_password: nextPassword,
    })
    expect(changed.status, await changed.clone().text()).toBe(200)
    expect((await jsonRequest('/api/v1/auth/login', {
      email, password: originalPassword,
    })).status).toBe(401)
    expect((await jsonRequest('/api/v1/auth/login', {
      email, password: nextPassword,
    })).status).toBe(200)
  })

  it('uses an emailed identity code to complete TOTP setup through public routes', async () => {
    await configureVerifiedRegistration()
    const email = `totp-${crypto.randomUUID()}@binding-e2e.test`
    const requestIp = { 'cf-connecting-ip': '198.51.100.31' }
    const accessToken = await registerVerifiedUser(
      email, 'correct horse battery staple', requestIp,
    )
    const authorization = { ...requestIp, authorization: `Bearer ${accessToken}` }

    const method = await workerRequest('/api/v1/user/totp/verification-method', authorization)
    await expect(method.json()).resolves.toMatchObject({ code: 0, data: { method: 'email' } })
    const sent = await jsonRequest('/api/v1/user/totp/send-code', {}, authorization)
    expect(sent.status, await sent.clone().text()).toBe(200)
    const verification = await waitForFixtureMessage(email, 'totp_identity_verification')
    expect(verification.payload.token).toMatch(/^\d{6}$/)

    const setupResponse = await jsonRequest('/api/v1/user/totp/setup', {
      email_code: verification.payload.token,
    }, authorization)
    expect(setupResponse.status, await setupResponse.clone().text()).toBe(200)
    const setup = await setupResponse.json() as {
      data: { secret: string; setup_token: string }
    }
    expect(setup.data.secret).toMatch(/^[A-Z2-7]{32}$/)

    const enabled = await jsonRequest('/api/v1/user/totp/enable', {
      setup_token: setup.data.setup_token,
      totp_code: await totpCode(setup.data.secret),
    }, authorization)
    expect(enabled.status, await enabled.clone().text()).toBe(200)
    await expect(enabled.json()).resolves.toMatchObject({
      code: 0,
      data: { success: true, recovery_codes: expect.any(Array) },
    })
    const status = await workerRequest('/api/v1/user/totp/status', authorization)
    await expect(status.json()).resolves.toMatchObject({
      code: 0,
      data: { enabled: true, feature_enabled: true, recovery_codes_remaining: 10 },
    })
  })

  it('binds a verified replacement email and revokes the original session', async () => {
    await configureVerifiedRegistration()
    const originalEmail = `binding-old-${crypto.randomUUID()}@binding-e2e.test`
    const nextEmail = `binding-new-${crypto.randomUUID()}@binding-e2e.test`
    const password = 'correct horse battery staple'
    const requestIp = { 'cf-connecting-ip': '198.51.100.41' }
    const accessToken = await registerVerifiedUser(originalEmail, password, requestIp)
    const authorization = { ...requestIp, authorization: `Bearer ${accessToken}` }

    const sent = await jsonRequest(
      '/api/v1/user/account-bindings/email/send-code', { email: nextEmail }, authorization,
    )
    expect(sent.status, await sent.clone().text()).toBe(200)
    const verification = await waitForFixtureMessage(nextEmail, 'email_binding')
    expect(verification.payload.token).toMatch(/^\d{6}$/)

    const bound = await jsonRequest('/api/v1/user/account-bindings/email', {
      email: nextEmail,
      verify_code: verification.payload.token,
      password,
    }, authorization)
    expect(bound.status, await bound.clone().text()).toBe(200)
    await expect(bound.json()).resolves.toMatchObject({
      code: 0,
      data: { email: nextEmail, has_password: true, email_bound: true },
    })
    expect((await workerRequest('/api/v1/user/profile', authorization)).status).toBe(401)
    const login = await jsonRequest('/api/v1/auth/login', {
      email: nextEmail,
      password,
    }, requestIp)
    expect(login.status, await login.clone().text()).toBe(200)
  })

  it('verifies an additional notification email through the shared Queue delivery boundary', async () => {
    await configureVerifiedRegistration()
    const accountEmail = `notify-user-${crypto.randomUUID()}@binding-e2e.test`
    const notificationEmail = `notify-target-${crypto.randomUUID()}@binding-e2e.test`
    const requestIp = { 'cf-connecting-ip': '198.51.100.51' }
    const accessToken = await registerVerifiedUser(
      accountEmail, 'correct horse battery staple', requestIp,
    )
    const authorization = { ...requestIp, authorization: `Bearer ${accessToken}` }

    const sent = await jsonRequest(
      '/api/v1/user/notify-email/send-code', { email: notificationEmail }, authorization,
    )
    expect(sent.status, await sent.clone().text()).toBe(200)
    const verification = await waitForFixtureMessage(
      notificationEmail, 'notification_email_verification',
    )
    expect(verification.payload.token).toMatch(/^\d{6}$/)

    const verified = await jsonRequest('/api/v1/user/notify-email/verify', {
      email: notificationEmail,
      code: verification.payload.token,
      expected_version: 0,
    }, authorization)
    expect(verified.status, await verified.clone().text()).toBe(200)
    await expect(verified.json()).resolves.toMatchObject({
      code: 0,
      data: {
        balance_notify_extra_emails: [{
          email: notificationEmail,
          disabled: false,
          verified: true,
        }],
        notification_preferences_version: 1,
      },
    })
    const challenge = await env.DB.prepare(
      `SELECT status, delivery_state FROM user_notification_email_challenges
        WHERE email = ?`,
    ).bind(notificationEmail).first<{ status: string; delivery_state: string }>()
    expect(challenge).toEqual({ status: 'consumed', delivery_state: 'sent' })
  })
})
