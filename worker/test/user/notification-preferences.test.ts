import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { consumeEvents } from '../../src/gateway/queue'
import { updateCurrentUser } from '../../src/user/profile'
import {
  consumeNotificationEmailVerificationDelivery,
  isNotificationEmailVerificationEvent,
  readUserNotificationPreferences,
  removeNotificationEmail,
  sendNotificationEmailVerificationCode,
  toggleNotificationEmail,
  verifyNotificationEmail,
  type NotificationEmailVerificationEvent,
} from '../../src/user/notification-preferences'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'notification-preferences-test-pepper-value-32-bytes'
const DAY_MS = 86_400_000

class CapturingQueue {
  readonly events: unknown[] = []

  async send(body: unknown): Promise<void> {
    this.events.push(body)
  }
}

interface Fixture {
  raw: any
  env: Env
  app: Hono<{ Bindings: Env }>
  queue: CapturingQueue
  aliceAuthorization: string
  bobAuthorization: string
}

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  for (const [id, email] of [
    ['alice', 'alice@example.test'],
    ['bob', 'bob@example.test'],
  ]) {
    raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, auth_version,
         email_verified_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'user', 'active', 1, ?, ?, ?)`,
    ).run(id, email, id, now, now, now)
  }

  const tokens: Record<string, string> = {}
  for (const userId of ['alice', 'bob']) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    tokens[userId] = access
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `${userId}-session`,
      `${userId}-family`,
      userId,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      now,
      now + DAY_MS,
      now + 30 * DAY_MS,
    )
  }

  const queue = new CapturingQueue()
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    ASSETS: {} as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: queue as unknown as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  } satisfies Env
  const app = new Hono<{ Bindings: Env }>()
  app.put('/preferences', updateCurrentUser)
  app.post('/notify-email/send-code', sendNotificationEmailVerificationCode)
  app.post('/notify-email/verify', verifyNotificationEmail)
  app.delete('/notify-email', removeNotificationEmail)
  app.put('/notify-email/toggle', toggleNotificationEmail)
  return {
    raw,
    env,
    app,
    queue,
    aliceAuthorization: `Bearer ${tokens.alice}`,
    bobAuthorization: `Bearer ${tokens.bob}`,
  }
}

async function request(
  test: Fixture,
  path: string,
  body: Record<string, unknown>,
  authorization = test.aliceAuthorization,
  method = 'POST',
): Promise<Response> {
  return test.app.request(path, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, test.env)
}

async function responseData(response: Response): Promise<any> {
  return (await response.json() as { data: unknown }).data
}

function latestVerificationEvent(test: Fixture): NotificationEmailVerificationEvent {
  const event = test.queue.events.at(-1)
  expect(isNotificationEmailVerificationEvent(event)).toBe(true)
  return event as NotificationEmailVerificationEvent
}

describe('user notification preferences migration', () => {
  it('upgrades v19 with strict owner-scoped preferences, normalized unique emails, and hashed challenges', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 19)
    applyMigrations(raw, 20)
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, created_at_ms, updated_at_ms)
       VALUES ('owner-a', 'a@example.test', ?, ?), ('owner-b', 'b@example.test', ?, ?)`,
    ).run(now, now, now, now)

    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 20').get()).toEqual({
      name: 'user_notification_preferences',
    })
    raw.prepare(
      `INSERT INTO user_notification_preferences (user_id, created_at_ms, updated_at_ms)
       VALUES ('owner-a', ?, ?)`,
    ).run(now, now)
    expect(raw.prepare(
      `SELECT balance_notify_enabled, balance_notify_threshold_micros, version
         FROM user_notification_preferences WHERE user_id = 'owner-a'`,
    ).get()).toEqual({ balance_notify_enabled: 1, balance_notify_threshold_micros: null, version: 0 })

    const insertEmail = raw.prepare(
      `INSERT INTO user_notification_emails (
         user_id, email, disabled, verified_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 0, ?, ?, ?)`,
    )
    insertEmail.run('owner-a', 'shared@example.test', now, now, now)
    insertEmail.run('owner-b', 'shared@example.test', now, now, now)
    expect(() => insertEmail.run('owner-a', 'UPPER@example.test', now, now, now)).toThrow(/CHECK constraint/)
    insertEmail.run('owner-a', 'second@example.test', now, now, now)
    insertEmail.run('owner-a', 'third@example.test', now, now, now)
    expect(() => insertEmail.run('owner-a', 'fourth@example.test', now, now, now)).toThrow(
      /notification_email_limit_exceeded/,
    )

    const challengeSql = raw.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'user_notification_email_challenges'`,
    ).get().sql as string
    expect(challengeSql).toContain('token_hash')
    expect(challengeSql).not.toMatch(/verification_code\s+TEXT/i)
    raw.prepare("DELETE FROM users WHERE id = 'owner-a'").run()
    expect(raw.prepare(
      "SELECT COUNT(*) AS total FROM user_notification_emails WHERE user_id = 'owner-a'",
    ).get()).toEqual({ total: 0 })
  })
})

describe('user notification preference handlers', () => {
  it('projects defaults and performs partial, idempotent, owner-isolated CAS updates', async () => {
    const test = await fixture()
    await expect(readUserNotificationPreferences(test.env, 'alice')).resolves.toEqual({
      balance_notify_enabled: true,
      balance_notify_threshold: null,
      balance_notify_extra_emails: [],
      notification_preferences_version: 0,
    })

    const disabled = await request(test, '/preferences', {
      balance_notify_enabled: false,
      expected_version: 0,
    }, test.aliceAuthorization, 'PUT')
    expect(disabled.status).toBe(200)
    expect(await responseData(disabled)).toMatchObject({
      balance_notify_enabled: false,
      balance_notify_threshold: null,
      notification_preferences_version: 1,
    })

    const duplicate = await request(test, '/preferences', {
      balance_notify_enabled: false,
      expected_version: 0,
    }, test.aliceAuthorization, 'PUT')
    expect(duplicate.status).toBe(200)
    expect((await responseData(duplicate)).notification_preferences_version).toBe(1)

    const stale = await request(test, '/preferences', {
      balance_notify_threshold: 1.25,
      expected_version: 0,
    }, test.aliceAuthorization, 'PUT')
    expect(stale.status).toBe(409)
    expect((await stale.json() as any).code).toBe('notification_preferences_version_conflict')

    const [first, second] = await Promise.all([
      request(test, '/preferences', {
        balance_notify_threshold: 1.25,
        expected_version: 1,
      }, test.aliceAuthorization, 'PUT'),
      request(test, '/preferences', {
        balance_notify_threshold: 2.5,
        expected_version: 1,
      }, test.aliceAuthorization, 'PUT'),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const alice = await readUserNotificationPreferences(test.env, 'alice')
    expect([1.25, 2.5]).toContain(alice.balance_notify_threshold)
    expect(alice.notification_preferences_version).toBe(2)
    await expect(readUserNotificationPreferences(test.env, 'bob')).resolves.toMatchObject({
      balance_notify_enabled: true,
      balance_notify_threshold: null,
      notification_preferences_version: 0,
    })
  })

  it('keeps verification codes out of D1 and binds verification to owner, email, expiry, and CAS version', async () => {
    const test = await fixture()
    const sent = await request(test, '/notify-email/send-code', { email: ' Alice@Example.Test ' })
    expect(sent.status).toBe(200)
    const event = latestVerificationEvent(test)
    expect(event.payload.recipient_email).toBe('alice@example.test')
    expect(event.payload.verification_code).toMatch(/^\d{6}$/)
    const stored = test.raw.prepare(
      `SELECT email, token_hash, delivery_state
         FROM user_notification_email_challenges WHERE user_id = 'alice'`,
    ).get()
    expect(stored).toMatchObject({ email: 'alice@example.test', delivery_state: 'queued' })
    expect(stored.token_hash).toHaveLength(64)
    expect(JSON.stringify(stored)).not.toContain(event.payload.verification_code)

    const otherOwner = await request(test, '/notify-email/verify', {
      email: event.payload.recipient_email,
      code: event.payload.verification_code,
      expected_version: 0,
    }, test.bobAuthorization)
    expect(otherOwner.status).toBe(400)
    expect((await otherOwner.json() as any).code).toBe('invalid_notification_email_code')

    const wrongCode = event.payload.verification_code === '000000' ? '000001' : '000000'
    const wrong = await request(test, '/notify-email/verify', {
      email: event.payload.recipient_email,
      code: wrongCode,
      expected_version: 0,
    })
    expect(wrong.status).toBe(400)
    expect(test.raw.prepare(
      "SELECT verification_attempts FROM user_notification_email_challenges WHERE user_id = 'alice'",
    ).get()).toEqual({ verification_attempts: 1 })

    const verified = await request(test, '/notify-email/verify', {
      email: event.payload.recipient_email,
      code: event.payload.verification_code,
      expected_version: 0,
    })
    expect(verified.status).toBe(200)
    expect(await responseData(verified)).toMatchObject({
      balance_notify_extra_emails: [{
        email: 'alice@example.test', disabled: false, verified: true,
      }],
      notification_preferences_version: 1,
    })

    const replay = await request(test, '/notify-email/verify', {
      email: event.payload.recipient_email,
      code: event.payload.verification_code,
      expected_version: 0,
    })
    expect(replay.status).toBe(200)
    expect((await responseData(replay)).notification_preferences_version).toBe(1)
    expect(test.raw.prepare(
      "SELECT COUNT(*) AS total FROM user_notification_emails WHERE user_id = 'alice'",
    ).get()).toEqual({ total: 1 })
  })

  it('toggles the primary address but forbids deleting it, and removes extra addresses with CAS', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO user_notification_preferences (user_id, created_at_ms, updated_at_ms)
       VALUES ('alice', ?, ?)`,
    ).run(now, now)
    const insert = test.raw.prepare(
      `INSERT INTO user_notification_emails (
         user_id, email, disabled, verified_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('alice', ?, 0, ?, ?, ?)`,
    )
    insert.run('alice@example.test', now, now, now)
    insert.run('alerts@example.test', now, now, now)

    const toggled = await request(test, '/notify-email/toggle', {
      email: 'ALICE@example.test', disabled: true, expected_version: 0,
    }, test.aliceAuthorization, 'PUT')
    expect(toggled.status).toBe(200)
    expect(await responseData(toggled)).toMatchObject({
      balance_notify_extra_emails: expect.arrayContaining([
        { email: 'alice@example.test', disabled: true, verified: true },
      ]),
      notification_preferences_version: 1,
    })

    const idempotentToggle = await request(test, '/notify-email/toggle', {
      email: 'alice@example.test', disabled: true, expected_version: 0,
    }, test.aliceAuthorization, 'PUT')
    expect(idempotentToggle.status).toBe(200)
    expect((await responseData(idempotentToggle)).notification_preferences_version).toBe(1)

    const primaryDelete = await request(test, '/notify-email', {
      email: 'alice@example.test', expected_version: 1,
    }, test.aliceAuthorization, 'DELETE')
    expect(primaryDelete.status).toBe(400)
    expect((await primaryDelete.json() as any).code).toBe('primary_notification_email_cannot_be_removed')

    const ownerIsolation = await request(test, '/notify-email/toggle', {
      email: 'alerts@example.test', disabled: true, expected_version: 0,
    }, test.bobAuthorization, 'PUT')
    expect(ownerIsolation.status).toBe(400)
    expect((await ownerIsolation.json() as any).code).toBe('notification_email_not_found')

    const removed = await request(test, '/notify-email', {
      email: 'alerts@example.test', expected_version: 1,
    }, test.aliceAuthorization, 'DELETE')
    expect(removed.status).toBe(200)
    expect(await responseData(removed)).toMatchObject({
      balance_notify_extra_emails: [
        { email: 'alice@example.test', disabled: true, verified: true },
      ],
      notification_preferences_version: 2,
    })
    const repeated = await request(test, '/notify-email', {
      email: 'alerts@example.test', expected_version: 2,
    }, test.aliceAuthorization, 'DELETE')
    expect(repeated.status).toBe(400)
    expect((await repeated.json() as any).code).toBe('notification_email_not_found')
  })

  it('returns 503 and leaves a retryable failed challenge when Queue enqueue fails', async () => {
    const test = await fixture()
    test.env.EVENTS_QUEUE = {
      send: async () => { throw new Error('queue unavailable') },
    } as unknown as Queue
    const response = await request(test, '/notify-email/send-code', { email: 'alerts@example.test' })
    expect(response.status).toBe(503)
    expect((await response.json() as any).code).toBe('notification_email_delivery_unavailable')
    expect(test.raw.prepare(
      `SELECT delivery_state FROM user_notification_email_challenges
        WHERE user_id = 'alice' AND email = 'alerts@example.test'`,
    ).get()).toEqual({ delivery_state: 'failed' })
  })

  it('keeps per-user verification admission in one bounded D1 row', async () => {
    const test = await fixture()
    test.raw.prepare(
      `INSERT INTO user_notification_email_challenges (
         id, user_id, email, email_hash, token_hash, generation,
         delivery_event_id, created_at_ms, expires_at_ms, updated_at_ms
       ) VALUES ('expired', 'alice', 'expired@example.test', ?, ?, 1,
                 'expired-event', ?, ?, ?)`,
    ).run('a'.repeat(64), 'b'.repeat(64), Date.now() - 20_000, Date.now() - 10_000, Date.now() - 20_000)
    for (let index = 0; index < 5; index += 1) {
      const response = await request(test, '/notify-email/send-code', {
        email: `alerts-${index}@example.test`,
      })
      expect(response.status).toBe(200)
    }

    const limited = await request(test, '/notify-email/send-code', {
      email: 'alerts-5@example.test',
    })
    expect(limited.status).toBe(429)
    expect((await limited.json() as any).code).toBe('notification_email_rate_limit_exceeded')
    expect(test.raw.prepare(
      `SELECT send_count FROM user_notification_email_rate_limits WHERE user_id = 'alice'`,
    ).get()).toEqual({ send_count: 5 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM user_notification_email_challenges WHERE user_id = 'alice'`,
    ).get()).toEqual({ total: 5 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM user_notification_email_challenges WHERE id = 'expired'`,
    ).get()).toEqual({ total: 0 })
  })

  it('leases native Email delivery exactly once and retains only bounded failure metadata', async () => {
    const delivered: Array<Record<string, unknown>> = []
    const test = await fixture()
    test.env.SEND_EMAIL = {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        delivered.push(message as unknown as Record<string, unknown>)
        return { messageId: 'notification-email-1' }
      },
    } as unknown as SendEmail
    test.env.EMAIL_FROM_ADDRESS = 'no-reply@example.test'
    await request(test, '/notify-email/send-code', { email: 'alerts@example.test' })
    const event = latestVerificationEvent(test)

    const delivery = {
      id: 'notification-delivery-message',
      timestamp: new Date(),
      body: event,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    await consumeEvents(
      { queue: 'events', messages: [delivery] } as unknown as MessageBatch<unknown>,
      test.env,
    )
    expect(delivery.ack).toHaveBeenCalledOnce()
    expect(delivery.retry).not.toHaveBeenCalled()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      from: 'no-reply@example.test',
      to: 'alerts@example.test',
    })
    expect(delivered[0]?.text).toContain(event.payload.verification_code)
    expect(test.raw.prepare(
      `SELECT delivery_state, delivery_attempts, delivered_at_ms,
              delivery_lease_id, last_delivery_error
         FROM user_notification_email_challenges WHERE id = ?`,
    ).get(event.payload.challenge_id)).toMatchObject({
      delivery_state: 'sent',
      delivery_attempts: 1,
      delivered_at_ms: expect.any(Number),
      delivery_lease_id: null,
      last_delivery_error: null,
    })
    await expect(
      consumeNotificationEmailVerificationDelivery(event, test.env),
    ).resolves.toBe('already_delivered')
    expect(delivered).toHaveLength(1)

    const failed = await fixture()
    await request(failed, '/notify-email/send-code', { email: 'failure@example.test' })
    const failedEvent = latestVerificationEvent(failed)
    await expect(
      consumeNotificationEmailVerificationDelivery(failedEvent, failed.env),
    ).rejects.toThrow('No email delivery binding is configured')
    expect(failed.raw.prepare(
      `SELECT delivery_state, delivery_attempts, delivery_lease_id, last_delivery_error
         FROM user_notification_email_challenges WHERE id = ?`,
    ).get(failedEvent.payload.challenge_id)).toEqual({
      delivery_state: 'failed',
      delivery_attempts: 1,
      delivery_lease_id: null,
      last_delivery_error: 'Error',
    })
  })
})
