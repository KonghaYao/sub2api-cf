import type { Context } from 'hono'
import type { Env, PlatformEvent } from '../env'
import { authenticateUserRequest, publicUser, type UserRow } from '../auth/handler'
import { controlError, controlSuccess, readJsonObject } from '../control/http'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  deliverPlatformEmail,
  hasEmailDeliveryConfigured,
} from '../email/delivery'
import {
  executeLeasedEmailDelivery,
  type EmailDeliveryExecutionResult,
} from '../email/delivery-executor'

type UserBindings = { Bindings: Env }

const MAX_NOTIFICATION_EMAILS = 3
const MAX_VERIFICATION_ATTEMPTS = 5
const VERIFICATION_TTL_MS = 15 * 60 * 1_000
const VERIFICATION_COOLDOWN_MS = 60 * 1_000
const DELIVERY_LEASE_MS = 60 * 1_000
const DELIVERY_ERROR_MAX_LENGTH = 256
const MAX_THRESHOLD_MICROS = Number.MAX_SAFE_INTEGER

interface NotificationPreferenceRow {
  balance_notify_enabled: number
  balance_notify_threshold_micros: number | null
  version: number
}

interface NotificationEmailRow {
  email: string
  disabled: number
  verified_at_ms: number
}

interface NotificationEmailChallengeRow {
  id: string
  token_hash: string
  generation: number
  status: 'pending' | 'consumed'
  verification_attempts: number
  delivery_state: 'pending' | 'queued' | 'failed'
  created_at_ms: number
  expires_at_ms: number
}

export interface NotificationEmailEntry {
  email: string
  disabled: boolean
  verified: true
}

export interface UserNotificationPreferences {
  balance_notify_enabled: boolean
  balance_notify_threshold: number | null
  balance_notify_extra_emails: NotificationEmailEntry[]
  notification_preferences_version: number
}

export interface PreparedNotificationPreferencesUpdate {
  statement: D1PreparedStatement | null
}

export interface NotificationEmailVerificationPayload {
  challenge_id: string
  user_id: string
  recipient_email: string
  verification_code: string
  action_url: string
  site_name: string
  locale: string
  expires_at_ms: number
  generation: number
}

export type NotificationEmailDeliveryResult = EmailDeliveryExecutionResult

/**
 * Delivery is deliberately outside this module. The plaintext code exists only
 * in this transient Queue event; D1 stores domain-separated hashes only.
 */
export type NotificationEmailVerificationEvent = PlatformEvent<NotificationEmailVerificationPayload> & {
  event_type: 'user.notification-email.verification.requested.v1'
  aggregate_type: 'user'
}

export async function readUserNotificationPreferences(
  env: Env,
  userId: string,
): Promise<UserNotificationPreferences> {
  const [preferences, emails] = await Promise.all([
    env.DB.prepare(
      `SELECT balance_notify_enabled, balance_notify_threshold_micros, version
         FROM user_notification_preferences
        WHERE user_id = ?`,
    ).bind(userId).first<NotificationPreferenceRow>(),
    env.DB.prepare(
      `SELECT email, disabled, verified_at_ms
         FROM user_notification_emails
        WHERE user_id = ?
        ORDER BY created_at_ms ASC, email ASC`,
    ).bind(userId).all<NotificationEmailRow>(),
  ])
  return projectPreferences(preferences, emails.results)
}

export async function projectUserNotificationPreferences(
  env: Env,
  userId: string,
  profile: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return { ...profile, ...await readUserNotificationPreferences(env, userId) }
}

/** Prepare a CAS mutation so a combined profile update can commit it atomically. */
export async function prepareUserNotificationPreferencesUpdate(
  env: Env,
  userId: string,
  request: Request,
  body: Record<string, unknown>,
  now: number,
): Promise<PreparedNotificationPreferencesUpdate> {
  const expectedVersion = requireExpectedVersion(request, body)
  const enabled = optionalBoolean(body.balance_notify_enabled, 'balance_notify_enabled')
  const thresholdMicros = optionalThresholdMicros(body)
  if (enabled === undefined && thresholdMicros === undefined) {
    throw new GatewayError(
      400,
      'empty_notification_preferences_update',
      'At least one notification preference is required',
    )
  }

  await ensurePreferenceRow(env, userId, now)
  const current = await requiredPreferenceRow(env, userId)
  const nextEnabled = enabled === undefined ? current.balance_notify_enabled : enabled ? 1 : 0
  const nextThreshold = thresholdMicros === undefined
    ? current.balance_notify_threshold_micros
    : thresholdMicros
  if (
    nextEnabled === current.balance_notify_enabled &&
    nextThreshold === current.balance_notify_threshold_micros
  ) {
    return { statement: null }
  }
  return {
    statement: env.DB.prepare(
      `UPDATE user_notification_preferences
          SET balance_notify_enabled = ?, balance_notify_threshold_micros = ?,
              version = CASE WHEN version = ? THEN version + 1 ELSE -1 END,
              updated_at_ms = ?
        WHERE user_id = ?`,
    ).bind(nextEnabled, nextThreshold, expectedVersion, now, userId),
  }
}

/**
 * Creates a hashed, owner-bound challenge and emits a delivery request. A Queue
 * consumer may send the email; this module never calls an email provider.
 */
export async function sendNotificationEmailVerificationCode(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    if (!(await hasEmailDeliveryConfigured(context.env))) {
      throw new GatewayError(
        503,
        'notification_email_delivery_unavailable',
        'Notification email delivery is unavailable',
        'server_error',
      )
    }
    const body = await readJsonObject(context.req.raw)
    rejectUnknownFields(body, ['email'])
    const email = requireEmail(body.email)
    const now = Date.now()
    await context.env.DB.prepare(
      `DELETE FROM user_notification_email_challenges
        WHERE user_id = ? AND expires_at_ms <= ?`,
    ).bind(user.id, now).run()
    const existingEmail = await findNotificationEmail(context.env, user.id, email)
    if (existingEmail !== null) {
      return controlSuccess({ message: 'Verification code sent successfully' })
    }

    const existing = await context.env.DB.prepare(
      `SELECT id, token_hash, generation, status, verification_attempts,
              delivery_state, created_at_ms, expires_at_ms
         FROM user_notification_email_challenges
        WHERE user_id = ? AND email = ?`,
    ).bind(user.id, email).first<NotificationEmailChallengeRow>()
    if (
      existing !== null && existing.status === 'pending' &&
      existing.delivery_state !== 'failed' && existing.expires_at_ms > now &&
      existing.created_at_ms + VERIFICATION_COOLDOWN_MS > now
    ) {
      return controlSuccess({ message: 'Verification code sent successfully' })
    }

    const code = createSixDigitCode()
    const challengeId = crypto.randomUUID()
    const generation = (existing?.generation ?? 0) + 1
    const deliveryEventId = `notification-email:${challengeId}:${generation}`
    const [emailHash, tokenHash] = await Promise.all([
      sha256Hex(email),
      notificationCodeDigest(context.env, user.id, email, code),
    ])
    const expiresAtMs = now + VERIFICATION_TTL_MS
    let challengeStatement: D1PreparedStatement
    try {
      if (existing === null) {
        challengeStatement = context.env.DB.prepare(
          `INSERT INTO user_notification_email_challenges (
             id, user_id, email, email_hash, token_hash, generation, status,
           verification_attempts, delivery_event_id, delivery_state,
           created_at_ms, expires_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, 'pending', ?, ?, ?)
           RETURNING id`,
        ).bind(
          challengeId,
          user.id,
          email,
          emailHash,
          tokenHash,
          generation,
          deliveryEventId,
          now,
          expiresAtMs,
          now,
        )
      } else {
        challengeStatement = context.env.DB.prepare(
          `UPDATE user_notification_email_challenges
              SET id = ?, email_hash = ?, token_hash = ?, generation = ?,
                  status = 'pending', verification_attempts = 0,
                  delivery_event_id = ?, delivery_state = 'pending',
                  delivery_attempts = 0, delivery_lease_id = NULL,
                  delivery_lease_expires_at_ms = NULL, last_delivery_error = NULL,
                  delivered_at_ms = NULL,
                  created_at_ms = ?, expires_at_ms = ?, consumed_at_ms = NULL,
                  consume_nonce = NULL, updated_at_ms = ?
            WHERE user_id = ? AND email = ? AND generation = ?
            RETURNING id`,
        ).bind(
          challengeId,
          emailHash,
          tokenHash,
          generation,
          deliveryEventId,
          now,
          expiresAtMs,
          now,
          user.id,
          email,
          existing.generation,
        )
      }
      const writes = await context.env.DB.batch([
        notificationEmailRateLimitStatement(context.env, user.id, now),
        challengeStatement,
      ])
      if (writes[1]?.results.length !== 1) {
        return controlSuccess({ message: 'Verification code sent successfully' })
      }
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
        return controlSuccess({ message: 'Verification code sent successfully' })
      }
      throw error
    }

    const event = createNotificationEmailVerificationEvent({
      challenge_id: challengeId,
      user_id: user.id,
      recipient_email: email,
      verification_code: code,
      action_url: new URL('/profile', context.req.url).toString(),
      site_name: 'Sub2API',
      locale: context.req.header('accept-language')?.slice(0, 128) ?? '',
      expires_at_ms: expiresAtMs,
      generation,
    }, now)
    try {
      await context.env.EVENTS_QUEUE.send(event)
      await context.env.DB.prepare(
        `UPDATE user_notification_email_challenges
            SET delivery_state = 'queued', updated_at_ms = ?
          WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
      ).bind(Date.now(), challengeId, deliveryEventId).run()
    } catch {
      await context.env.DB.prepare(
        `UPDATE user_notification_email_challenges
            SET delivery_state = 'failed', updated_at_ms = ?
          WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
      ).bind(Date.now(), challengeId, deliveryEventId).run()
      throw new GatewayError(
        503,
        'notification_email_delivery_unavailable',
        'Notification email delivery is unavailable',
        'server_error',
      )
    }
    return controlSuccess({ message: 'Verification code sent successfully' })
  } catch (error) {
    return notificationError(error)
  }
}

function notificationEmailRateLimitStatement(
  env: Env,
  userId: string,
  now: number,
): D1PreparedStatement {
  const resetBefore = now - 60 * 60 * 1_000
  return env.DB.prepare(
    `INSERT INTO user_notification_email_rate_limits (
       user_id, window_started_at_ms, send_count, updated_at_ms
     ) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       window_started_at_ms = CASE
         WHEN window_started_at_ms <= ? THEN excluded.window_started_at_ms
         ELSE window_started_at_ms
       END,
       send_count = CASE
         WHEN window_started_at_ms <= ? THEN 1
         ELSE send_count + 1
       END,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(userId, now, now, resetBefore, resetBefore)
}

export async function verifyNotificationEmail(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    rejectUnknownFields(body, ['email', 'code', 'expected_version', 'notification_preferences_version'])
    const email = requireEmail(body.email)
    const code = requireVerificationCode(body.code)
    const expectedVersion = requireExpectedVersion(context.req.raw, body)
    await ensurePreferenceRow(context.env, user.id)
    if (await findNotificationEmail(context.env, user.id, email) !== null) {
      return controlSuccess(await notificationProfile(context.env, user))
    }

    const now = Date.now()
    const challenge = await context.env.DB.prepare(
      `SELECT id, token_hash, generation, status, verification_attempts,
              delivery_state, created_at_ms, expires_at_ms
         FROM user_notification_email_challenges
        WHERE user_id = ? AND email = ?`,
    ).bind(user.id, email).first<NotificationEmailChallengeRow>()
    const tokenHash = await notificationCodeDigest(context.env, user.id, email, code)
    if (
      challenge === null || challenge.status !== 'pending' ||
      challenge.expires_at_ms <= now ||
      challenge.verification_attempts >= MAX_VERIFICATION_ATTEMPTS ||
      !constantTimeHexEqual(challenge.token_hash, tokenHash)
    ) {
      if (
        challenge !== null && challenge.status === 'pending' &&
        challenge.expires_at_ms > now
      ) {
        await context.env.DB.prepare(
          `UPDATE user_notification_email_challenges
              SET verification_attempts = MIN(?, verification_attempts + 1), updated_at_ms = ?
            WHERE id = ? AND status = 'pending' AND expires_at_ms > ?`,
        ).bind(MAX_VERIFICATION_ATTEMPTS, now, challenge.id, now).run()
      }
      throw invalidNotificationCode()
    }

    const consumeNonce = crypto.randomUUID()
    try {
      await context.env.DB.batch([
        preferenceVerificationCasStatement(
          context.env,
          user.id,
          expectedVersion,
          challenge.id,
          email,
          tokenHash,
          now,
        ),
        context.env.DB.prepare(
          `UPDATE user_notification_email_challenges
              SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?, updated_at_ms = ?,
                  verification_attempts = CASE
                    WHEN status = 'pending' AND token_hash = ? AND expires_at_ms > ?
                      THEN verification_attempts
                    ELSE 6
                  END
            WHERE id = ? AND user_id = ? AND email = ?`,
        ).bind(now, consumeNonce, now, tokenHash, now, challenge.id, user.id, email),
        context.env.DB.prepare(
          `INSERT INTO user_notification_emails (
             user_id, email, disabled, verified_at_ms, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 0, ?, ?, ?)`,
        ).bind(user.id, email, now, now, now),
      ])
    } catch (error) {
      const stored = await findNotificationEmail(context.env, user.id, email)
      if (stored !== null) {
        return controlSuccess(await notificationProfile(context.env, user))
      }
      throw error
    }
    return controlSuccess(await notificationProfile(context.env, user))
  } catch (error) {
    return notificationError(error)
  }
}

export async function removeNotificationEmail(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    rejectUnknownFields(body, ['email', 'expected_version', 'notification_preferences_version'])
    const email = requireEmail(body.email)
    const expectedVersion = requireExpectedVersion(context.req.raw, body)
    if (email === normalizeEmail(user.email)) {
      throw new GatewayError(
        400,
        'primary_notification_email_cannot_be_removed',
        'The account email can be disabled but cannot be removed',
      )
    }
    await ensurePreferenceRow(context.env, user.id)
    if (await findNotificationEmail(context.env, user.id, email) === null) {
      throw notificationEmailNotFound()
    }
    const now = Date.now()
    await context.env.DB.batch([
      preferenceCasStatement(
        context.env,
        user.id,
        expectedVersion,
        now,
        { email },
      ),
      context.env.DB.prepare(
        'DELETE FROM user_notification_emails WHERE user_id = ? AND email = ?',
      ).bind(user.id, email),
    ])
    return controlSuccess(await notificationProfile(context.env, user))
  } catch (error) {
    return notificationError(error)
  }
}

export async function toggleNotificationEmail(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    rejectUnknownFields(body, ['email', 'disabled', 'expected_version', 'notification_preferences_version'])
    const email = requireEmail(body.email)
    const disabled = requireBoolean(body.disabled, 'disabled')
    const expectedVersion = requireExpectedVersion(context.req.raw, body)
    await ensurePreferenceRow(context.env, user.id)
    const existing = await findNotificationEmail(context.env, user.id, email)
    if (existing === null) throw notificationEmailNotFound()
    if ((existing.disabled === 1) === disabled) {
      return controlSuccess(await notificationProfile(context.env, user))
    }
    const now = Date.now()
    await context.env.DB.batch([
      preferenceCasStatement(
        context.env,
        user.id,
        expectedVersion,
        now,
        { email, disabled },
      ),
      context.env.DB.prepare(
        `UPDATE user_notification_emails SET disabled = ?, updated_at_ms = ?
          WHERE user_id = ? AND email = ?`,
      ).bind(disabled ? 1 : 0, now, user.id, email),
    ])
    return controlSuccess(await notificationProfile(context.env, user))
  } catch (error) {
    return notificationError(error)
  }
}

export function createNotificationEmailVerificationEvent(
  payload: NotificationEmailVerificationPayload,
  occurredAtMs: number,
): NotificationEmailVerificationEvent {
  return {
    schema_version: 1,
    event_id: `notification-email:${payload.challenge_id}:${payload.generation}`,
    event_type: 'user.notification-email.verification.requested.v1',
    occurred_at_ms: occurredAtMs,
    aggregate_type: 'user',
    aggregate_id: payload.user_id,
    payload,
  }
}

export function isNotificationEmailVerificationEvent(
  value: unknown,
): value is NotificationEmailVerificationEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<NotificationEmailVerificationEvent>
  const payload = event.payload
  if (
    event.schema_version !== 1 ||
    event.event_type !== 'user.notification-email.verification.requested.v1' ||
    event.aggregate_type !== 'user' ||
    typeof event.event_id !== 'string' ||
    typeof event.aggregate_id !== 'string' ||
    !Number.isSafeInteger(event.occurred_at_ms) ||
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    typeof payload.challenge_id !== 'string' || payload.challenge_id.length === 0 ||
    typeof payload.user_id !== 'string' || payload.user_id !== event.aggregate_id ||
    typeof payload.recipient_email !== 'string' ||
    normalizeEmail(payload.recipient_email) !== payload.recipient_email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.recipient_email) ||
    typeof payload.verification_code !== 'string' || !/^\d{6}$/.test(payload.verification_code) ||
    typeof payload.action_url !== 'string' || payload.action_url.length > 2_048 ||
    !isHttpUrl(payload.action_url) ||
    typeof payload.site_name !== 'string' || payload.site_name.length > 128 ||
    typeof payload.locale !== 'string' || payload.locale.length > 128 ||
    !Number.isSafeInteger(payload.expires_at_ms) ||
    !Number.isSafeInteger(payload.generation) || (payload.generation as number) < 1
  ) return false
  return event.schema_version === 1 &&
    event.event_type === 'user.notification-email.verification.requested.v1' &&
    event.aggregate_type === 'user' &&
    event.event_id === `notification-email:${payload.challenge_id}:${payload.generation}` &&
    (event.occurred_at_ms as number) >= 0 &&
    (payload.expires_at_ms as number) > (event.occurred_at_ms as number)
}

/**
 * Queue consumer for notification-email verification. A D1 lease makes retry
 * and concurrent delivery bounded; the event is accepted only when its code
 * still matches the owner-bound challenge hash.
 */
export async function consumeNotificationEmailVerificationDelivery(
  value: unknown,
  env: Env,
): Promise<NotificationEmailDeliveryResult> {
  return executeLeasedEmailDelivery(value, {
    leaseMs: DELIVERY_LEASE_MS,
    failureErrorMaxLength: DELIVERY_ERROR_MAX_LENGTH,
    describe: (event: NotificationEmailVerificationEvent) =>
      `Notification email delivery ${event.event_id}`,
    load: async (candidate, now) => {
      if (!isNotificationEmailVerificationEvent(candidate)) {
        throw new Error('Invalid notification email verification event')
      }
      const event = candidate
      const tokenHash = await notificationCodeDigest(
        env,
        event.payload.user_id,
        event.payload.recipient_email,
        event.payload.verification_code,
      )
      const challenge = await env.DB.prepare(
        `SELECT id, status, delivery_state, last_delivery_error, expires_at_ms
           FROM user_notification_email_challenges
          WHERE id = ? AND user_id = ? AND email = ? AND token_hash = ?
            AND generation = ? AND delivery_event_id = ?
          LIMIT 1`,
      ).bind(
        event.payload.challenge_id,
        event.payload.user_id,
        event.payload.recipient_email,
        tokenHash,
        event.payload.generation,
        event.event_id,
      ).first<{
        id: string
        status: string
        delivery_state: string
        last_delivery_error: string | null
        expires_at_ms: number
      }>()
      return {
        event,
        record: challenge === null || challenge.status !== 'pending' || challenge.expires_at_ms <= now
          ? null
          : {
              id: challenge.id,
              deliveryState: challenge.delivery_state,
              lastDeliveryError: challenge.last_delivery_error,
            },
      }
    },
    acquireLease: async ({ event, record }, leaseId, now, leaseExpiresAtMs) => {
      const lease = await env.DB.prepare(
        `UPDATE user_notification_email_challenges
            SET delivery_state = 'delivering', delivery_attempts = delivery_attempts + 1,
                delivery_lease_id = ?, delivery_lease_expires_at_ms = ?,
                last_delivery_error = NULL, updated_at_ms = ?
          WHERE id = ? AND status = 'pending' AND expires_at_ms > ?
            AND delivery_event_id = ?
            AND (
              delivery_state IN ('pending', 'queued')
              OR (delivery_state = 'failed' AND (
                last_delivery_error IS NULL OR last_delivery_error NOT LIKE 'permanent:%'
              ))
              OR (delivery_state = 'delivering' AND delivery_lease_expires_at_ms <= ?)
            )
          RETURNING id`,
      ).bind(
        leaseId, leaseExpiresAtMs, now, record.id, now, event.event_id, now,
      ).all<{ id: string }>()
      return lease.results.length === 1
    },
    inspect: async ({ record }) => {
      const current = await env.DB.prepare(
        `SELECT delivery_state, last_delivery_error
           FROM user_notification_email_challenges WHERE id = ?`,
      ).bind(record.id).first<{ delivery_state: string; last_delivery_error: string | null }>()
      return current === null ? null : {
        id: record.id,
        deliveryState: current.delivery_state,
        lastDeliveryError: current.last_delivery_error,
      }
    },
    send: (event) => deliverNotificationEmailVerification(event, env),
    markSent: async ({ record }, leaseId, completedAtMs) => {
      const update = await env.DB.prepare(
        `UPDATE user_notification_email_challenges
            SET delivery_state = 'sent', delivered_at_ms = ?,
                delivery_lease_id = NULL, delivery_lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ? AND delivery_state = 'delivering' AND delivery_lease_id = ?`,
      ).bind(completedAtMs, completedAtMs, record.id, leaseId).run()
      return resultChanges(update) === 1
    },
    markFailed: async ({ record }, leaseId, failure, failedAtMs) => {
      await env.DB.prepare(
        `UPDATE user_notification_email_challenges
            SET delivery_state = 'failed', delivery_lease_id = NULL,
                delivery_lease_expires_at_ms = NULL, last_delivery_error = ?,
                updated_at_ms = ?
          WHERE id = ? AND delivery_state = 'delivering' AND delivery_lease_id = ?`,
      ).bind(failure, failedAtMs, record.id, leaseId).run()
    },
  })
}

async function deliverNotificationEmailVerification(
  event: NotificationEmailVerificationEvent,
  env: Env,
): Promise<void> {
  const siteName = sanitizeSiteName(event.payload.site_name)
  const code = event.payload.verification_code
  const minutes = Math.max(
    1,
    Math.ceil((event.payload.expires_at_ms - event.occurred_at_ms) / 60_000),
  )
  await deliverPlatformEmail({
    eventId: event.event_id,
    recipient: event.payload.recipient_email,
    subject: `${siteName}: Verify notification email`,
    text: `${siteName}\n\nYour notification email verification code is ${code}. It expires in ${minutes} minutes.`,
    html: `<h1>Verify notification email</h1><p>Your verification code is <code>${code}</code>.</p><p>It expires in ${minutes} minutes.</p>`,
    compatibilityPayload: {
      recipient_email: event.payload.recipient_email,
      purpose: 'notification_email_verification',
      token: event.payload.verification_code,
      action_url: event.payload.action_url,
      site_name: siteName,
      locale: event.payload.locale,
      expires_at_ms: event.payload.expires_at_ms,
    },
  }, env)
}

function sanitizeSiteName(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128)
  return normalized === '' ? 'Sub2API' : normalized
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function projectPreferences(
  preferences: NotificationPreferenceRow | null,
  emails: NotificationEmailRow[],
): UserNotificationPreferences {
  return {
    balance_notify_enabled: preferences === null ? true : preferences.balance_notify_enabled === 1,
    balance_notify_threshold: preferences?.balance_notify_threshold_micros === null || preferences === null
      ? null
      : preferences.balance_notify_threshold_micros / 1_000_000,
    balance_notify_extra_emails: emails.map((entry) => ({
      email: entry.email,
      disabled: entry.disabled === 1,
      verified: true,
    })),
    notification_preferences_version: preferences?.version ?? 0,
  }
}

async function notificationProfile(env: Env, user: UserRow): Promise<Record<string, unknown>> {
  return projectUserNotificationPreferences(env, user.id, publicUser(user))
}

async function ensurePreferenceRow(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_notification_preferences (
       user_id, balance_notify_enabled, balance_notify_threshold_micros,
       version, created_at_ms, updated_at_ms
     ) VALUES (?, 1, NULL, 0, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  ).bind(userId, now, now).run()
}

async function requiredPreferenceRow(env: Env, userId: string): Promise<NotificationPreferenceRow> {
  const row = await env.DB.prepare(
    `SELECT balance_notify_enabled, balance_notify_threshold_micros, version
       FROM user_notification_preferences WHERE user_id = ?`,
  ).bind(userId).first<NotificationPreferenceRow>()
  if (row === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
  return row
}

async function findNotificationEmail(
  env: Env,
  userId: string,
  email: string,
): Promise<NotificationEmailRow | null> {
  return env.DB.prepare(
    `SELECT email, disabled, verified_at_ms
       FROM user_notification_emails
      WHERE user_id = ? AND email = ?`,
  ).bind(userId, email).first<NotificationEmailRow>()
}

function preferenceCasStatement(
  env: Env,
  userId: string,
  expectedVersion: number,
  now: number,
  requiredEmail?: { email: string; disabled?: boolean },
): D1PreparedStatement {
  // The CHECK on version aborts the entire D1 batch if the aggregate or target
  // email changed concurrently.
  if (requiredEmail !== undefined) {
    const disabledCondition = requiredEmail.disabled === undefined ? '' : ' AND disabled <> ?'
    const disabledBindings = requiredEmail.disabled === undefined
      ? []
      : [requiredEmail.disabled ? 1 : 0]
    return env.DB.prepare(
      `UPDATE user_notification_preferences
          SET version = CASE
                WHEN version = ? AND EXISTS (
                  SELECT 1 FROM user_notification_emails
                   WHERE user_id = ? AND email = ?${disabledCondition}
                ) THEN version + 1
                ELSE -1
              END,
              updated_at_ms = ?
        WHERE user_id = ?`,
    ).bind(
      expectedVersion,
      userId,
      requiredEmail.email,
      ...disabledBindings,
      now,
      userId,
    )
  }
  return env.DB.prepare(
    `UPDATE user_notification_preferences
        SET version = CASE WHEN version = ? THEN version + 1 ELSE -1 END,
            updated_at_ms = ?
      WHERE user_id = ?`,
  ).bind(expectedVersion, now, userId)
}

function preferenceVerificationCasStatement(
  env: Env,
  userId: string,
  expectedVersion: number,
  challengeId: string,
  email: string,
  tokenHash: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE user_notification_preferences
        SET version = CASE
              WHEN version = ? AND EXISTS (
                SELECT 1 FROM user_notification_email_challenges
                 WHERE id = ? AND user_id = ? AND email = ? AND token_hash = ?
                   AND status = 'pending' AND verification_attempts < ?
                   AND expires_at_ms > ?
              ) THEN version + 1
              ELSE -1
            END,
            updated_at_ms = ?
      WHERE user_id = ?`,
  ).bind(
    expectedVersion,
    challengeId,
    userId,
    email,
    tokenHash,
    MAX_VERIFICATION_ATTEMPTS,
    now,
    now,
    userId,
  )
}

function optionalThresholdMicros(body: Record<string, unknown>): number | null | undefined {
  if (body.balance_notify_threshold === undefined) return undefined
  if (body.balance_notify_threshold === null) return null
  const value = body.balance_notify_threshold
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GatewayError(
      400,
      'invalid_balance_notify_threshold',
      'balance_notify_threshold must be null or a non-negative number',
    )
  }
  const micros = Math.round(value * 1_000_000)
  if (!Number.isSafeInteger(micros) || micros > MAX_THRESHOLD_MICROS) {
    throw new GatewayError(
      400,
      'invalid_balance_notify_threshold',
      'balance_notify_threshold is too large',
    )
  }
  return micros
}

function requireExpectedVersion(request: Request, body: Record<string, unknown>): number {
  const bodyValue = body.expected_version ?? body.notification_preferences_version
  const header = request.headers.get('if-match')?.trim()
  let headerValue: number | undefined
  if (header !== undefined && header !== '') {
    const match = /^(?:W\/)?"?(\d+)"?$/.exec(header)
    if (match === null) {
      throw new GatewayError(400, 'invalid_notification_preferences_version', 'If-Match is invalid')
    }
    headerValue = Number(match[1])
  }
  let parsedBody: number | undefined
  if (bodyValue !== undefined) {
    if (!Number.isSafeInteger(bodyValue) || (bodyValue as number) < 0) {
      throw new GatewayError(
        400,
        'invalid_notification_preferences_version',
        'Notification preferences version must be a non-negative integer',
      )
    }
    parsedBody = bodyValue as number
  }
  if (parsedBody !== undefined && headerValue !== undefined && parsedBody !== headerValue) {
    throw new GatewayError(
      400,
      'notification_preferences_version_mismatch',
      'If-Match and request version disagree',
    )
  }
  const version = parsedBody ?? headerValue
  if (version === undefined) {
    throw new GatewayError(
      428,
      'notification_preferences_version_required',
      'If-Match or expected_version is required',
    )
  }
  return version
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  return requireBoolean(value, field)
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a boolean`)
  }
  return value
}

function requireEmail(value: unknown): string {
  if (typeof value !== 'string') throw invalidEmail()
  const email = normalizeEmail(value)
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalidEmail()
  return email
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function requireVerificationCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) throw invalidNotificationCode()
  return value
}

function createSixDigitCode(): string {
  const values = new Uint32Array(1)
  const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  do crypto.getRandomValues(values)
  while (values[0] >= ceiling)
  return String(values[0] % 1_000_000).padStart(6, '0')
}

async function notificationCodeDigest(
  env: Env,
  userId: string,
  email: string,
  code: string,
): Promise<string> {
  const pepper = env.API_KEY_PEPPER
  if (typeof pepper !== 'string' || new TextEncoder().encode(pepper).byteLength < 32) {
    throw new GatewayError(
      503,
      'notification_preferences_not_configured',
      'Notification preferences are not configured',
      'server_error',
    )
  }
  return sha256Hex(`${pepper}\u0000notification-email-verification\u0000${userId}\u0000${email}\u0000${code}`)
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(body).find((field) => !accepted.has(field))
  if (unknown !== undefined) {
    throw new GatewayError(400, 'unsupported_notification_preferences_field', `${unknown} is not supported`)
  }
}

function resultChanges(result: D1Result<unknown>): number {
  const changes = (result.meta as D1Meta & { changes?: unknown }).changes
  return Number.isSafeInteger(changes) ? changes as number : 0
}

function invalidEmail(): GatewayError {
  return new GatewayError(400, 'invalid_notification_email', 'Notification email is invalid')
}

function invalidNotificationCode(): GatewayError {
  return new GatewayError(400, 'invalid_notification_email_code', 'Notification email code is invalid or expired')
}

function notificationEmailNotFound(): GatewayError {
  return new GatewayError(400, 'notification_email_not_found', 'Notification email was not found')
}

function notificationError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/CHECK constraint failed: version >= 0|user_notification_preferences\.version/i.test(message)) {
    return controlError(new GatewayError(
      409,
      'notification_preferences_version_conflict',
      'Notification preferences changed; reload and retry',
    ))
  }
  if (/notification_email_limit_exceeded/i.test(message)) {
    return controlError(new GatewayError(
      400,
      'too_many_notification_emails',
      `A maximum of ${MAX_NOTIFICATION_EMAILS} notification emails is allowed`,
    ))
  }
  if (/send_count BETWEEN 1 AND 5|user_notification_email_rate_limits\.send_count/i.test(message)) {
    return controlError(new GatewayError(
      429,
      'notification_email_rate_limit_exceeded',
      'Too many notification email verification requests; retry later',
      'rate_limit_error',
    ))
  }
  if (/verification_attempts.*CHECK|CHECK constraint failed: verification_attempts/i.test(message)) {
    return controlError(invalidNotificationCode())
  }
  return controlError(asGatewayError(error))
}
