import { verifyCaptcha } from './captcha'
import type { CaptchaPublicSettings } from '../control/captcha-settings'
import type { Context } from 'hono'
import type { Env, PlatformEvent } from '../env'
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
import { authenticateUserRequest, findUserById, publicUser, type UserRow } from './handler'
import { hashPassword, PasswordValidationError, validateNewPassword, verifyPassword } from './password'
import { checkAuthRateLimit, commitAuthRateLimitAttempt } from './rate-limit'
import { checkRegistrationEmailPolicy, requireRegistrationEmailSuffixAllowed } from './email-policy'
import {
  prepareAuthSourceGrant,
  settleAuthSourceGrant,
  type PreparedAuthSourceGrant,
} from './source-entitlements'

type AuthBindings = { Bindings: Env }
export type EmailChallengePurpose =
  | 'registration_email_verification'
  | 'email_verification'
  | 'email_binding'
  | 'password_reset'

const EMAIL_VERIFICATION_TTL_MS = 15 * 60 * 1_000
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000
const CHALLENGE_COOLDOWN_MS = 60 * 1_000
const REGISTRATION_MAX_ATTEMPTS = 5
const EMAIL_BINDING_MAX_ATTEMPTS = 5
const DELIVERY_LEASE_MS = 60 * 1_000
const TOKEN_BYTES = 32
const TOKEN_PEPPER_MIN_BYTES = 32
const DELIVERY_ERROR_MAX_LENGTH = 1_024

const EMAIL_VERIFICATION_TOKEN_PATTERN = /^sev_v1_[A-Za-z0-9_-]{43}$/
const PASSWORD_RESET_TOKEN_PATTERN = /^spr_v1_[A-Za-z0-9_-]{43}$/
const REGISTRATION_CODE_PATTERN = /^\d{6}$/

interface EmailChallengeRow {
  id: string
  user_id: string | null
  purpose: EmailChallengePurpose
  token_hash: string
  generation: number
  status: 'pending' | 'consumed'
  delivery_event_id: string
  delivery_event_hash: string
  delivery_state: 'pending' | 'queued' | 'delivering' | 'sent' | 'failed'
  last_delivery_error: string | null
  created_at_ms: number
  expires_at_ms: number
}

interface EmailChallengePublicSettings extends Partial<CaptchaPublicSettings> {
  password_reset_enabled?: boolean
  frontend_url?: string
  email_verification_enabled?: boolean
  registration_email_suffix_whitelist?: string[]
  registration_email_domain_quota_enabled?: boolean
  turnstile_enabled?: boolean
  site_name?: string
}

export interface EmailChallengeDeliveryPayload {
  challenge_id: string
  user_id: string | null
  email_hash: string
  purpose: EmailChallengePurpose
  recipient_email: string
  token: string
  action_url: string
  site_name: string
  locale: string
  expires_at_ms: number
  generation: number
}

export type EmailChallengeDeliveryEvent = PlatformEvent<EmailChallengeDeliveryPayload> & {
  event_type: 'auth.email-challenge.delivery.v1'
  aggregate_type: 'user' | 'email_identity'
}

export type EmailChallengeDeliveryResult = EmailDeliveryExecutionResult

export interface RegistrationEmailChallengeConsumption {
  /** Put this statement before the user INSERT in the same D1 batch. */
  consumeStatement: D1PreparedStatement
  /** Put this statement after the user INSERT; its FKs abort the batch if consume lost a race. */
  claimStatement: D1PreparedStatement
  consumeNonce: string
  emailHash: string
  verifiedAtMs: number
}

/** True when the claim FK aborted a registration batch after a consume race/replay. */
export function isRegistrationEmailChallengeClaimFailure(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

/** Compatible with the original POST /api/v1/auth/send-verify-code contract. */
export function requestRegistrationEmailVerification(context: Context<AuthBindings>): Promise<Response> {
  return issueRegistrationCode(context, false)
}
/** Only call after authenticating an unexpired browser-bound pending OAuth registration. */
export function requestPendingOAuthEmailVerification(context: Context<AuthBindings>): Promise<Response> {
  return issueRegistrationCode(context, true)
}
async function issueRegistrationCode(context: Context<AuthBindings>, pendingOAuth: boolean): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const email = requireEmail(body.email)
    const settings = pendingOAuth ? await readEmailChallengeSettings(context.env) : await requireEmailChallengeSettings(context.env, 'registration_email_verification')
    await requireEmailDeliveryBinding(context.env)
    await checkRegistrationEmailPolicy(context.env, email, settings)
    const rateLimit = await checkAuthRateLimit(context.env, context.req.raw, email, 'register')
    await verifyCaptcha(context.req.raw, context.env, settings, body)
    await commitAuthRateLimitAttempt(context.env, rateLimit)
    const existingUser = await findUserByEmail(context.env, email)
    if (existingUser === null) {
      await issueChallenge(
        context.env,
        context.req.raw,
        { id: null, email },
        'registration_email_verification',
        settings,
      )
    }
    return controlSuccess({ message: 'Verification code sent successfully', countdown: 60 })
  } catch (error) {
    return challengeError(error)
  }
}

/**
 * Validate a six-digit registration code and return statements for the caller's
 * existing registration D1 batch. The caller must execute them in this order:
 * consumeStatement, user INSERT (with email_verified_at_ms=verifiedAtMs),
 * claimStatement, then session/audit statements. The claim FK guarantees an
 * invalid or concurrent replay rolls the entire batch back.
 *
 * A wrong code increments its durable attempt counter before this function
 * rejects. No raw code is returned or persisted by this preparation step.
 */
export async function prepareRegistrationEmailChallengeConsumption(
  env: Env,
  emailValue: unknown,
  codeValue: unknown,
  userId: string,
  now = Date.now(),
): Promise<RegistrationEmailChallengeConsumption> {
  const email = requireEmail(emailValue)
  const code = requireChallengeToken(codeValue, 'registration_email_verification')
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
    throw new GatewayError(400, 'invalid_user_id', 'User id is invalid')
  }
  const [emailHash, tokenHash] = await Promise.all([
    sha256Hex(email),
    challengeTokenDigest(env, code, 'registration_email_verification'),
  ])
  const row = await env.DB.prepare(
    `SELECT id, token_hash, status, expires_at_ms, verification_attempts
       FROM email_challenges
      WHERE email_hash = ? AND purpose = 'registration_email_verification'
      LIMIT 1`,
  ).bind(emailHash).first<{
    id: string
    token_hash: string
    status: string
    expires_at_ms: number
    verification_attempts: number
  }>()
  if (
    row === null || row.status !== 'pending' || row.expires_at_ms <= now ||
    row.verification_attempts >= REGISTRATION_MAX_ATTEMPTS ||
    !constantTimeHexEqual(row.token_hash, tokenHash)
  ) {
    if (row !== null && row.status === 'pending' && row.expires_at_ms > now) {
      await env.DB.prepare(
        `UPDATE email_challenges
            SET verification_attempts = MIN(?, verification_attempts + 1), updated_at_ms = ?
          WHERE id = ? AND status = 'pending' AND expires_at_ms > ?`,
      ).bind(REGISTRATION_MAX_ATTEMPTS, now, row.id, now).run()
    }
    throw invalidChallenge('registration_email_verification')
  }

  const consumeNonce = crypto.randomUUID()
  return {
    consumeStatement: env.DB.prepare(
      `UPDATE email_challenges
          SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?, updated_at_ms = ?
        WHERE id = ? AND email_hash = ? AND purpose = 'registration_email_verification'
          AND token_hash = ? AND status = 'pending' AND expires_at_ms > ?
          AND verification_attempts < ?
        RETURNING id`,
    ).bind(
      now,
      consumeNonce,
      now,
      row.id,
      emailHash,
      tokenHash,
      now,
      REGISTRATION_MAX_ATTEMPTS,
    ),
    claimStatement: env.DB.prepare(
      `INSERT INTO registration_email_challenge_claims (
         consume_nonce, user_id, email_hash, claimed_at_ms
       ) VALUES (?, ?, ?, ?)`,
    ).bind(consumeNonce, userId, emailHash, now),
    consumeNonce,
    emailHash,
    verifiedAtMs: now,
  }
}

/** Public request endpoint. Its success response deliberately reveals no account state. */
export async function requestPasswordReset(context: Context<AuthBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const email = requireEmail(body.email)
    const settings = await requireEmailChallengeSettings(context.env, 'password_reset')
    await requireEmailDeliveryBinding(context.env)
    const rateLimit = await checkAuthRateLimit(context.env, context.req.raw, email, 'login')
    await verifyCaptcha(context.req.raw, context.env, settings, body)
    await commitAuthRateLimitAttempt(context.env, rateLimit)

    const user = await findActiveUserByEmail(context.env, email)
    if (user !== null) {
      await issueChallenge(context.env, context.req.raw, user, 'password_reset', settings)
    }
    return passwordResetRequestAccepted()
  } catch (error) {
    return challengeError(error)
  }
}

/** Public reset endpoint. Challenge consumption, password mutation, and session revocation are one D1 batch. */
export async function resetPasswordWithChallenge(context: Context<AuthBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const email = requireEmail(body.email)
    const token = requireChallengeToken(body.token, 'password_reset')
    const newPassword = requirePassword(body.new_password)
    validateNewPassword(newPassword)
    await requireEmailChallengeSettings(context.env, 'password_reset')
    const rateLimit = await checkAuthRateLimit(context.env, context.req.raw, email, 'login')
    await commitAuthRateLimitAttempt(context.env, rateLimit)
    const [digest, credential] = await Promise.all([
      challengeTokenDigest(context.env, token, 'password_reset'),
      hashPassword(newPassword),
    ])
    const user = await findActiveUserByEmail(context.env, email)
    if (user === null) throw invalidChallenge('password_reset')
    const now = Date.now()
    const consumeNonce = crypto.randomUUID()
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE email_challenges
            SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?, updated_at_ms = ?
          WHERE user_id = ? AND purpose = 'password_reset' AND token_hash = ?
            AND status = 'pending' AND expires_at_ms > ?
            AND EXISTS (
              SELECT 1 FROM users
               WHERE users.id = email_challenges.user_id
                 AND users.email = ? AND users.status = 'active'
            )
          RETURNING id`,
      ).bind(now, consumeNonce, now, user.id, digest, now, email),
      context.env.DB.prepare(
        `UPDATE users
            SET password_credential = ?, auth_version = auth_version + 1,
                password_changed_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'active'
            AND EXISTS (
              SELECT 1 FROM email_challenges
               WHERE user_id = users.id AND purpose = 'password_reset'
                 AND consume_nonce = ? AND status = 'consumed'
            )
          RETURNING id`,
      ).bind(credential, now, now, user.id, consumeNonce),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = COALESCE(revoked_at_ms, ?),
                revoke_reason = COALESCE(revoke_reason, 'password_reset')
          WHERE user_id = ? AND revoked_at_ms IS NULL
            AND EXISTS (
              SELECT 1 FROM email_challenges
               WHERE user_id = ? AND purpose = 'password_reset'
                 AND consume_nonce = ? AND status = 'consumed'
            )`,
      ).bind(now, user.id, user.id, consumeNonce),
      context.env.DB.prepare(
        `INSERT INTO auth_audit_events (
           id, user_id, event_type, outcome, email_hash, ip_hash,
           session_id, metadata_json, occurred_at_ms
         )
         SELECT ?, ?, 'auth.password_reset', 'succeeded', email_hash, NULL,
                NULL, '{}', ?
           FROM email_challenges
          WHERE user_id = ? AND purpose = 'password_reset' AND consume_nonce = ?`,
      ).bind(crypto.randomUUID(), user.id, now, user.id, consumeNonce),
    ])
    if (results[0].results.length !== 1 || results[1].results.length !== 1) {
      throw invalidChallenge('password_reset')
    }
    return controlSuccess({
      message: 'Your password has been reset successfully. You can now log in with your new password.',
    })
  } catch (error) {
    return challengeError(error)
  }
}

/** Authenticated endpoint that sends a verification challenge only to the session owner's email. */
export async function requestEmailVerification(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const settings = await requireEmailChallengeSettings(context.env, 'email_verification')
    await requireEmailDeliveryBinding(context.env)
    const rateLimit = await checkAuthRateLimit(
      context.env,
      context.req.raw,
      user.email,
      'register',
    )
    await commitAuthRateLimitAttempt(context.env, rateLimit)
    if (user.email_verified_at_ms === null) {
      await issueChallenge(context.env, context.req.raw, user, 'email_verification', settings)
    }
    return controlSuccess({ message: 'If verification is needed, an email will arrive shortly.' })
  } catch (error) {
    return challengeError(error)
  }
}

/** Authenticated endpoint for issuing a code tied to a new local email identity. */
export async function requestEmailIdentityBindingCode(
  context: Context<AuthBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const email = requireBindableEmail(body.email)
    const settings = await readEmailChallengeSettings(context.env)
    await requireEmailDeliveryBinding(context.env)
    requireRegistrationEmailSuffixAllowed(email, settings.registration_email_suffix_whitelist)
    const rateLimit = await checkAuthRateLimit(
      context.env,
      context.req.raw,
      email,
      'register',
    )
    await commitAuthRateLimitAttempt(context.env, rateLimit)
    if (await findConflictingEmailInboxOwner(context.env, email, user.id) !== null) {
      throw new GatewayError(409, 'email_exists', 'Email is already used by another account')
    }
    await issueEmailBindingChallenge(context.env, context.req.raw, user, email, settings)
    return controlSuccess({ message: 'Verification code sent successfully', countdown: 60 })
  } catch (error) {
    return challengeError(error)
  }
}

/**
 * Consumes an authenticated, session-bound mailbox challenge and establishes
 * the local email/password credential. Existing password users must re-enter
 * their current password; OAuth-only users use the field as their new password.
 */
export async function bindEmailIdentity(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const email = requireBindableEmail(body.email)
    const settings = await readEmailChallengeSettings(context.env)
    requireRegistrationEmailSuffixAllowed(email, settings.registration_email_suffix_whitelist)
    const token = requireChallengeToken(body.verify_code, 'email_binding')
    const password = requirePassword(body.password)
    const rateLimit = await checkAuthRateLimit(context.env, context.req.raw, email, 'login')
    await commitAuthRateLimitAttempt(context.env, rateLimit)

    const now = Date.now()
    const [emailHash, tokenHash] = await Promise.all([
      sha256Hex(email),
      challengeTokenDigest(context.env, token, 'email_binding'),
    ])
    const challenge = await context.env.DB.prepare(
      `SELECT id, user_id, session_id, auth_version, email_hash, token_hash,
              status, verification_attempts, expires_at_ms
         FROM email_binding_challenges
        WHERE user_id = ?
        LIMIT 1`,
    ).bind(user.id).first<{
      id: string
      user_id: string
      session_id: string
      auth_version: number
      email_hash: string
      token_hash: string
      status: 'pending' | 'consumed'
      verification_attempts: number
      expires_at_ms: number
    }>()
    const addressMatches = challenge !== null && constantTimeHexEqual(challenge.email_hash, emailHash)
    const tokenMatches = challenge !== null && constantTimeHexEqual(challenge.token_hash, tokenHash)
    if (
      challenge === null || challenge.status !== 'pending' || challenge.expires_at_ms <= now ||
      challenge.verification_attempts >= EMAIL_BINDING_MAX_ATTEMPTS ||
      challenge.user_id !== user.id || challenge.session_id !== user.session_id ||
      challenge.auth_version !== user.auth_version || !addressMatches || !tokenMatches
    ) {
      if (
        challenge !== null && challenge.status === 'pending' && challenge.expires_at_ms > now &&
        challenge.session_id === user.session_id && challenge.auth_version === user.auth_version &&
        addressMatches && !tokenMatches
      ) {
        await context.env.DB.prepare(
          `UPDATE email_binding_challenges
              SET verification_attempts = MIN(?, verification_attempts + 1), updated_at_ms = ?
            WHERE id = ? AND status = 'pending' AND expires_at_ms > ?`,
        ).bind(EMAIL_BINDING_MAX_ATTEMPTS, now, challenge.id, now).run()
      }
      throw invalidChallenge('email_binding')
    }

    // A valid, session-bound mailbox challenge is required before doing any
    // password comparison so this route cannot become a password oracle for a
    // stolen bearer session. The shared auth limiter bounds both code and
    // password attempts before either expensive credential operation.
    if (user.password_credential === null) {
      validateNewPassword(password)
    } else if (!(await verifyPassword(password, user.password_credential))) {
      throw new GatewayError(
        401,
        'invalid_current_password',
        'Current password is incorrect',
        'authentication_error',
      )
    }

    if (await findConflictingEmailInboxOwner(context.env, email, user.id) !== null) {
      throw new GatewayError(409, 'email_exists', 'Email is already used by another account')
    }
    const nextAuthVersion = user.auth_version + 1
    if (!Number.isSafeInteger(nextAuthVersion)) {
      throw new GatewayError(409, 'auth_version_exhausted', 'Session security version is exhausted')
    }
    const credential = user.password_credential ?? await hashPassword(password)
    const consumeNonce = crypto.randomUUID()
    const sourceGrant: PreparedAuthSourceGrant | null = user.password_credential === null
      ? await prepareAuthSourceGrant(
        context.env,
        user.id,
        'email',
        'first_bind',
        { kind: 'email_binding', value: consumeNonce },
        now,
      )
      : null
    const condition = `auth_version = ? AND EXISTS (
      SELECT 1 FROM email_binding_challenges
       WHERE user_id = users.id AND consume_nonce = ? AND status = 'consumed'
    )`
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE email_binding_challenges
            SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?, updated_at_ms = ?
          WHERE id = ? AND user_id = ? AND session_id = ? AND auth_version = ?
            AND email_hash = ? AND token_hash = ? AND status = 'pending'
            AND verification_attempts < ? AND expires_at_ms > ?
            AND EXISTS (
              SELECT 1 FROM user_sessions s
               JOIN users u ON u.id = s.user_id
              WHERE s.id = email_binding_challenges.session_id
                AND s.user_id = email_binding_challenges.user_id
                AND s.auth_version = email_binding_challenges.auth_version
                AND u.auth_version = email_binding_challenges.auth_version
                AND u.status = 'active' AND s.revoked_at_ms IS NULL
                AND s.refresh_expires_at_ms > ?
            )
          RETURNING id`,
      ).bind(
        now,
        consumeNonce,
        now,
        challenge.id,
        user.id,
        user.session_id,
        user.auth_version,
        emailHash,
        tokenHash,
        EMAIL_BINDING_MAX_ATTEMPTS,
        now,
        now,
      ),
      context.env.DB.prepare(
        `UPDATE users
            SET email = CASE WHEN ${condition} THEN ? ELSE NULL END,
                password_credential = CASE
                  WHEN ${condition} AND password_credential IS NULL THEN ?
                  ELSE password_credential
                END,
                email_verified_at_ms = CASE WHEN ${condition} THEN ? ELSE email_verified_at_ms END,
                password_changed_at_ms = CASE
                  WHEN ${condition} AND password_credential IS NULL THEN ?
                  ELSE password_changed_at_ms
                END,
                auth_version = CASE WHEN ${condition} THEN ? ELSE 0 END,
                updated_at_ms = CASE WHEN ${condition} THEN ? ELSE updated_at_ms END
          WHERE id = ? AND status = 'active'
          RETURNING id, email, display_name, role, status, balance_micros,
                    concurrency, rpm_limit, state_version, auth_version,
                    password_credential, email_verified_at_ms, password_changed_at_ms,
                    last_login_at_ms, avatar_object_key, avatar_content_type,
                    avatar_updated_at_ms, created_at_ms, updated_at_ms`,
      ).bind(
        user.auth_version, consumeNonce, email,
        user.auth_version, consumeNonce, credential,
        user.auth_version, consumeNonce, now,
        user.auth_version, consumeNonce, now,
        user.auth_version, consumeNonce, nextAuthVersion,
        user.auth_version, consumeNonce, now,
        user.id,
      ),
      ...(sourceGrant?.statements ?? []),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = COALESCE(revoked_at_ms, ?),
                revoke_reason = COALESCE(revoke_reason, 'email_identity_bound')
          WHERE user_id = ? AND revoked_at_ms IS NULL
            AND EXISTS (
              SELECT 1 FROM email_binding_challenges
               WHERE user_id = ? AND consume_nonce = ? AND status = 'consumed'
            )`,
      ).bind(now, user.id, user.id, consumeNonce),
      context.env.DB.prepare(
        `INSERT INTO auth_audit_events (
           id, user_id, event_type, outcome, email_hash, ip_hash,
           session_id, metadata_json, occurred_at_ms
         )
         SELECT ?, ?, 'auth.email_identity.bind', 'succeeded', email_hash, NULL,
                ?, ?, ?
           FROM email_binding_challenges
          WHERE user_id = ? AND consume_nonce = ? AND status = 'consumed'`,
      ).bind(
        crypto.randomUUID(),
        user.id,
        user.session_id,
        JSON.stringify({ password_created: user.password_credential === null }),
        now,
        user.id,
        consumeNonce,
      ),
    ])
    if (results[0].results.length !== 1 || results[1].results.length !== 1) {
      throw invalidChallenge('email_binding')
    }
    await settleAuthSourceGrant(context.env, sourceGrant?.grantId ?? null)
    const updated = await findUserById(context.env, user.id)
    if (updated === null) throw new GatewayError(503, 'auth_source_entitlement_unavailable', 'Updated user is unavailable')
    const { projectOAuthIdentityBindings } = await import('./oauth-identities')
    return controlSuccess(await projectOAuthIdentityBindings(
      context.env,
      updated,
      publicUser(updated),
    ))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/UNIQUE constraint failed: (?:users\.(?:email|canonical_email_inbox)|index 'uq_users_canonical_email_inbox')/i.test(message)) {
      return controlError(new GatewayError(409, 'email_exists', 'Email is already used by another account'))
    }
    if (/NOT NULL constraint failed: users\.email|CHECK constraint failed: auth_version/i.test(message)) {
      return controlError(new GatewayError(
        409,
        'concurrent_security_update',
        'Security settings changed; request a new verification code',
      ))
    }
    return challengeError(error)
  }
}

/** Authenticated endpoint that binds a one-time challenge to the current user. */
export async function confirmEmailVerification(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const token = requireChallengeToken(body.token, 'email_verification')
    const normalizedEmail = requireEmail(user.email)
    const [digest, currentEmailHash] = await Promise.all([
      challengeTokenDigest(context.env, token, 'email_verification'),
      sha256Hex(normalizedEmail),
    ])
    const now = Date.now()
    const challenge = await context.env.DB.prepare(
      `SELECT id, email_hash
         FROM email_challenges
        WHERE user_id = ? AND purpose = 'email_verification' AND token_hash = ?
          AND status = 'pending' AND expires_at_ms > ?
        LIMIT 1`,
    ).bind(user.id, digest, now).first<{ id: string; email_hash: string }>()
    if (challenge === null || !constantTimeHexEqual(challenge.email_hash, currentEmailHash)) {
      throw invalidChallenge('email_verification')
    }
    const consumeNonce = crypto.randomUUID()
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE email_challenges
            SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?, updated_at_ms = ?
          WHERE id = ? AND user_id = ? AND purpose = 'email_verification'
            AND token_hash = ? AND email_hash = ?
            AND status = 'pending' AND expires_at_ms > ?
            AND EXISTS (
              SELECT 1 FROM users
               WHERE id = ? AND lower(trim(email)) = ?
            )
          RETURNING id`,
      ).bind(
        now,
        consumeNonce,
        now,
        challenge.id,
        user.id,
        digest,
        currentEmailHash,
        now,
        user.id,
        normalizedEmail,
      ),
      context.env.DB.prepare(
        `UPDATE users
            SET email_verified_at_ms = COALESCE(email_verified_at_ms, ?), updated_at_ms = ?
          WHERE id = ? AND lower(trim(email)) = ?
            AND EXISTS (
              SELECT 1 FROM email_challenges
               WHERE user_id = users.id AND purpose = 'email_verification'
                 AND consume_nonce = ? AND status = 'consumed'
            )
          RETURNING id`,
      ).bind(now, now, user.id, normalizedEmail, consumeNonce),
      context.env.DB.prepare(
        `INSERT INTO auth_audit_events (
           id, user_id, event_type, outcome, email_hash, ip_hash,
           session_id, metadata_json, occurred_at_ms
         )
         SELECT ?, ?, 'auth.email_verified', 'succeeded', email_hash, NULL,
                ?, '{}', ?
           FROM email_challenges
          WHERE user_id = ? AND purpose = 'email_verification' AND consume_nonce = ?`,
      ).bind(crypto.randomUUID(), user.id, user.session_id, now, user.id, consumeNonce),
    ])
    if (results[0].results.length !== 1 || results[1].results.length !== 1) {
      throw invalidChallenge('email_verification')
    }
    return controlSuccess({ message: 'Email verified successfully.', verified_at: new Date(now).toISOString() })
  } catch (error) {
    return challengeError(error)
  }
}

/**
 * Queue consumer seam. Delivery failures are thrown so the caller can retry the
 * same event; the D1 lease prevents concurrent duplicate sends. Native Cloudflare
 * email delivery is preferred, with the Worker service binding retained as a
 * compatibility adapter that receives a stable Idempotency-Key.
 */
export async function consumeEmailChallengeDelivery(
  value: unknown,
  env: Env,
): Promise<EmailChallengeDeliveryResult> {
  return executeLeasedEmailDelivery(value, {
    leaseMs: DELIVERY_LEASE_MS,
    failureErrorMaxLength: DELIVERY_ERROR_MAX_LENGTH,
    describe: (event: EmailChallengeDeliveryEvent) =>
      `Email challenge delivery ${event.event_id}`,
    load: async (candidate, now) => {
      const event = requireEmailChallengeDeliveryEvent(candidate)
      const challengeTable = emailChallengeTable(event)
      const [digest, eventHash] = await Promise.all([
        challengeTokenDigest(env, event.payload.token, event.payload.purpose),
        emailDeliveryEventDigest(env, event),
      ])
      const challenge = await env.DB.prepare(
        `SELECT id, status, delivery_state, last_delivery_error, expires_at_ms
           FROM ${challengeTable}
          WHERE id = ? AND user_id IS ? AND email_hash = ? AND purpose = ? AND token_hash = ?
            AND delivery_event_hash = ? AND generation = ? AND delivery_event_id = ?
          LIMIT 1`,
      ).bind(
        event.payload.challenge_id,
        event.payload.user_id,
        event.payload.email_hash,
        event.payload.purpose,
        digest,
        eventHash,
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
        `UPDATE ${emailChallengeTable(event)}
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
    inspect: async ({ event, record }) => {
      const current = await env.DB.prepare(
        `SELECT delivery_state, last_delivery_error
           FROM ${emailChallengeTable(event)} WHERE id = ?`,
      ).bind(record.id).first<{ delivery_state: string; last_delivery_error: string | null }>()
      return current === null ? null : {
        id: record.id,
        deliveryState: current.delivery_state,
        lastDeliveryError: current.last_delivery_error,
      }
    },
    send: (event) => deliverEmailChallenge(event, env),
    markSent: async ({ event, record }, leaseId, completedAtMs) => {
      const update = await env.DB.prepare(
        `UPDATE ${emailChallengeTable(event)}
            SET delivery_state = 'sent', delivered_at_ms = ?, delivery_lease_id = NULL,
                delivery_lease_expires_at_ms = NULL, updated_at_ms = ?
          WHERE id = ? AND delivery_state = 'delivering' AND delivery_lease_id = ?`,
      ).bind(completedAtMs, completedAtMs, record.id, leaseId).run()
      return resultChanges(update) === 1
    },
    markFailed: async ({ event, record }, leaseId, failure, failedAtMs) => {
      await env.DB.prepare(
        `UPDATE ${emailChallengeTable(event)}
            SET delivery_state = 'failed', delivery_lease_id = NULL,
                delivery_lease_expires_at_ms = NULL, last_delivery_error = ?, updated_at_ms = ?
          WHERE id = ? AND delivery_state = 'delivering' AND delivery_lease_id = ?`,
      ).bind(failure, failedAtMs, record.id, leaseId).run()
    },
  })
}

function emailChallengeTable(event: EmailChallengeDeliveryEvent): string {
  return event.payload.purpose === 'email_binding'
    ? 'email_binding_challenges'
    : 'email_challenges'
}

async function deliverEmailChallenge(event: EmailChallengeDeliveryEvent, env: Env): Promise<void> {
  const content = renderEmailChallenge(event)
  await deliverPlatformEmail({
    eventId: event.event_id,
    recipient: event.payload.recipient_email,
    subject: content.subject,
    text: content.text,
    html: content.html,
    compatibilityPayload: {
      recipient_email: event.payload.recipient_email,
      purpose: event.payload.purpose,
      token: event.payload.token,
      action_url: event.payload.action_url,
      site_name: event.payload.site_name,
      locale: event.payload.locale,
      expires_at_ms: event.payload.expires_at_ms,
    },
  }, env)
}

function renderEmailChallenge(event: EmailChallengeDeliveryEvent): {
  subject: string
  text: string
  html: string
} {
  const siteName = normalizedSiteName(event.payload.site_name)
  const actionUrl = requireEmailActionUrl(event.payload.action_url)
  const details = event.payload.purpose === 'password_reset'
    ? { subject: 'Reset your password', heading: 'Reset your password', action: 'Reset password' }
    : event.payload.purpose === 'registration_email_verification'
    ? { subject: 'Verify your registration', heading: 'Verify your email', action: 'Verify email' }
    : event.payload.purpose === 'email_binding'
    ? { subject: 'Confirm your sign-in email', heading: 'Confirm your sign-in email', action: 'Confirm email' }
    : { subject: 'Verify your email', heading: 'Verify your email', action: 'Verify email' }
  const subject = `${siteName}: ${details.subject}`
  const text = [
    `${siteName}: ${details.heading}`,
    '',
    `Verification token: ${event.payload.token}`,
    `${details.action}: ${actionUrl}`,
    '',
    'If you did not request this message, you can ignore it.',
  ].join('\n')
  const html = [
    '<!doctype html><html><body>',
    `<h1>${escapeHtml(details.heading)}</h1>`,
    `<p>${escapeHtml(siteName)} received a request for this email address.</p>`,
    `<p><a href="${escapeHtml(actionUrl)}">${escapeHtml(details.action)}</a></p>`,
    `<p>Verification token: <code>${escapeHtml(event.payload.token)}</code></p>`,
    '<p>If you did not request this message, you can ignore it.</p>',
    '</body></html>',
  ].join('')
  return { subject, text, html }
}

function requireEmailActionUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Email challenge action URL is invalid')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Email challenge action URL must use HTTP or HTTPS')
  }
  return url.toString()
}

async function requireEmailDeliveryBinding(env: Env): Promise<void> {
  if (await hasEmailDeliveryConfigured(env)) return
  throw new GatewayError(
    503,
    'email_delivery_unavailable',
    'Email delivery is unavailable',
    'server_error',
  )
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

export function isEmailChallengeDeliveryEvent(value: unknown): value is EmailChallengeDeliveryEvent {
  try {
    requireEmailChallengeDeliveryEvent(value)
    return true
  } catch {
    return false
  }
}

async function issueChallenge(
  env: Env,
  request: Request,
  user: { id: string | null; email: string },
  purpose: EmailChallengePurpose,
  settings: EmailChallengePublicSettings,
): Promise<void> {
  const now = Date.now()
  const emailHash = await sha256Hex(user.email)
  const existing = await env.DB.prepare(
    `SELECT id, user_id, purpose, token_hash, generation, status,
            delivery_event_id, delivery_event_hash, delivery_state, created_at_ms, expires_at_ms
       FROM email_challenges
      WHERE email_hash = ? AND purpose = ?
      LIMIT 1`,
  ).bind(emailHash, purpose).first<EmailChallengeRow>()
  if (
    existing !== null &&
    existing.status === 'pending' &&
    existing.expires_at_ms > now &&
    existing.created_at_ms + CHALLENGE_COOLDOWN_MS > now
  ) {
    return
  }

  const token = createChallengeToken(purpose)
  const challengeId = crypto.randomUUID()
  const generation = (existing?.generation ?? 0) + 1
  const eventId = `email-challenge:${challengeId}:${generation}`
  const [tokenHash, ipHash] = await Promise.all([
    challengeTokenDigest(env, token, purpose),
    requestIpHash(request),
  ])
  const expiresAtMs = now + challengeTtl(purpose)
  const event = createEmailChallengeDeliveryEvent({
    challenge_id: challengeId,
    user_id: user.id,
    email_hash: emailHash,
    purpose,
    recipient_email: user.email,
    token,
    action_url: challengeActionUrl(request, user.email, token, purpose, settings.frontend_url),
    site_name: normalizedSiteName(settings.site_name),
    locale: request.headers.get('accept-language')?.slice(0, 128) ?? '',
    expires_at_ms: expiresAtMs,
    generation,
  }, now)
  const eventHash = await emailDeliveryEventDigest(env, event)
  let changed = 0
  try {
    if (existing === null) {
      const insert = await env.DB.prepare(
        `INSERT INTO email_challenges (
           id, user_id, purpose, email_hash, token_hash, generation, status,
           delivery_event_id, delivery_event_hash, delivery_state,
           delivery_attempts, verification_attempts,
           requested_ip_hash, created_at_ms, expires_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'pending', 0, 0, ?, ?, ?, ?)`,
      ).bind(
        challengeId,
        user.id,
        purpose,
        emailHash,
        tokenHash,
        generation,
        eventId,
        eventHash,
        ipHash,
        now,
        expiresAtMs,
        now,
      ).run()
      changed = resultChanges(insert)
    } else {
      const update = await env.DB.prepare(
        `UPDATE email_challenges
            SET id = ?, email_hash = ?, token_hash = ?, generation = ?, status = 'pending',
                delivery_event_id = ?, delivery_event_hash = ?, delivery_state = 'pending',
                delivery_attempts = 0,
                verification_attempts = 0,
                delivery_lease_id = NULL, delivery_lease_expires_at_ms = NULL,
                last_delivery_error = NULL, requested_ip_hash = ?, created_at_ms = ?,
                expires_at_ms = ?, delivered_at_ms = NULL, consumed_at_ms = NULL,
                consume_nonce = NULL, updated_at_ms = ?
          WHERE email_hash = ? AND purpose = ? AND generation = ?`,
      ).bind(
        challengeId,
        emailHash,
        tokenHash,
        generation,
        eventId,
        eventHash,
        ipHash,
        now,
        expiresAtMs,
        now,
        emailHash,
        purpose,
        existing.generation,
      ).run()
      changed = resultChanges(update)
    }
  } catch (error) {
    if (isConstraintConflict(error)) return
    throw error
  }
  if (changed !== 1) return

  try {
    await env.EVENTS_QUEUE.send(event)
    await env.DB.prepare(
      `UPDATE email_challenges SET delivery_state = 'queued', updated_at_ms = ?
        WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
    ).bind(Date.now(), challengeId, eventId).run()
  } catch (error) {
    await env.DB.prepare(
      `UPDATE email_challenges
          SET delivery_state = 'failed', last_delivery_error = ?, updated_at_ms = ?
        WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
    ).bind('queue enqueue failed', Date.now(), challengeId, eventId).run()
    // The public response is deliberately unchanged. A later request may rotate
    // this failed challenge, while the persistent limiter prevents token churn.
    console.error('email challenge enqueue failed', {
      purpose,
      name: error instanceof Error ? error.name : 'unknown',
    })
  }
}

async function issueEmailBindingChallenge(
  env: Env,
  request: Request,
  user: { id: string; session_id: string; auth_version: number },
  email: string,
  settings: EmailChallengePublicSettings,
): Promise<void> {
  const now = Date.now()
  const emailHash = await sha256Hex(email)
  const existing = await env.DB.prepare(
    `SELECT id, session_id, auth_version, email_hash, generation, status,
            created_at_ms, expires_at_ms
       FROM email_binding_challenges
      WHERE user_id = ?
      LIMIT 1`,
  ).bind(user.id).first<{
    id: string
    session_id: string
    auth_version: number
    email_hash: string
    generation: number
    status: 'pending' | 'consumed'
    created_at_ms: number
    expires_at_ms: number
  }>()
  if (
    existing !== null &&
    existing.session_id === user.session_id &&
    existing.auth_version === user.auth_version &&
    existing.email_hash === emailHash &&
    existing.status === 'pending' &&
    existing.expires_at_ms > now &&
    existing.created_at_ms + CHALLENGE_COOLDOWN_MS > now
  ) {
    return
  }

  const token = createChallengeToken('email_binding')
  const challengeId = crypto.randomUUID()
  const generation = (existing?.generation ?? 0) + 1
  const eventId = `email-challenge:${challengeId}:${generation}`
  const [tokenHash, ipHash] = await Promise.all([
    challengeTokenDigest(env, token, 'email_binding'),
    requestIpHash(request),
  ])
  const expiresAtMs = now + challengeTtl('email_binding')
  const event = createEmailChallengeDeliveryEvent({
    challenge_id: challengeId,
    user_id: user.id,
    email_hash: emailHash,
    purpose: 'email_binding',
    recipient_email: email,
    token,
    action_url: challengeActionUrl(request, email, token, 'email_binding'),
    site_name: normalizedSiteName(settings.site_name),
    locale: request.headers.get('accept-language')?.slice(0, 128) ?? '',
    expires_at_ms: expiresAtMs,
    generation,
  }, now)
  const eventHash = await emailDeliveryEventDigest(env, event)
  let changed = 0
  try {
    if (existing === null) {
      const insert = await env.DB.prepare(
        `INSERT INTO email_binding_challenges (
           id, user_id, session_id, auth_version, email_hash, token_hash,
           generation, status, delivery_event_id, delivery_event_hash,
           delivery_state, delivery_attempts, verification_attempts,
           requested_ip_hash, created_at_ms, expires_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'pending', 0, 0, ?, ?, ?, ?)`,
      ).bind(
        challengeId,
        user.id,
        user.session_id,
        user.auth_version,
        emailHash,
        tokenHash,
        generation,
        eventId,
        eventHash,
        ipHash,
        now,
        expiresAtMs,
        now,
      ).run()
      changed = resultChanges(insert)
    } else {
      const update = await env.DB.prepare(
        `UPDATE email_binding_challenges
            SET id = ?, session_id = ?, auth_version = ?, email_hash = ?, token_hash = ?,
                generation = ?, status = 'pending', delivery_event_id = ?,
                delivery_event_hash = ?, delivery_state = 'pending', delivery_attempts = 0,
                verification_attempts = 0, delivery_lease_id = NULL,
                delivery_lease_expires_at_ms = NULL, last_delivery_error = NULL,
                requested_ip_hash = ?, created_at_ms = ?, expires_at_ms = ?,
                delivered_at_ms = NULL, consumed_at_ms = NULL, consume_nonce = NULL,
                updated_at_ms = ?
          WHERE user_id = ? AND id = ? AND generation = ?`,
      ).bind(
        challengeId,
        user.session_id,
        user.auth_version,
        emailHash,
        tokenHash,
        generation,
        eventId,
        eventHash,
        ipHash,
        now,
        expiresAtMs,
        now,
        user.id,
        existing.id,
        existing.generation,
      ).run()
      changed = resultChanges(update)
    }
  } catch (error) {
    if (isConstraintConflict(error)) {
      throw new GatewayError(409, 'email_binding_conflict', 'Email binding is already in progress')
    }
    throw error
  }
  if (changed !== 1) {
    throw new GatewayError(409, 'concurrent_email_binding_request', 'Email binding changed; retry')
  }

  try {
    await env.EVENTS_QUEUE.send(event)
    await env.DB.prepare(
      `UPDATE email_binding_challenges SET delivery_state = 'queued', updated_at_ms = ?
        WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
    ).bind(Date.now(), challengeId, eventId).run()
  } catch (error) {
    await env.DB.prepare(
      `UPDATE email_binding_challenges
          SET delivery_state = 'failed', last_delivery_error = ?, updated_at_ms = ?
        WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
    ).bind('queue enqueue failed', Date.now(), challengeId, eventId).run()
    console.error('email binding challenge enqueue failed', {
      name: error instanceof Error ? error.name : 'unknown',
    })
  }
}

export function createEmailChallengeDeliveryEvent(
  payload: EmailChallengeDeliveryPayload,
  occurredAtMs: number,
): EmailChallengeDeliveryEvent {
  return {
    schema_version: 1,
    event_id: `email-challenge:${payload.challenge_id}:${payload.generation}`,
    event_type: 'auth.email-challenge.delivery.v1',
    occurred_at_ms: occurredAtMs,
    aggregate_type: payload.user_id === null ? 'email_identity' : 'user',
    aggregate_id: payload.user_id ?? payload.email_hash,
    payload,
  }
}

function requireEmailChallengeDeliveryEvent(value: unknown): EmailChallengeDeliveryEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidEvent()
  const event = value as Partial<EmailChallengeDeliveryEvent>
  const payload = event.payload
  if (
    event.schema_version !== 1 ||
    event.event_type !== 'auth.email-challenge.delivery.v1' ||
    (event.aggregate_type !== 'user' && event.aggregate_type !== 'email_identity') ||
    typeof event.event_id !== 'string' ||
    typeof event.aggregate_id !== 'string' ||
    !Number.isSafeInteger(event.occurred_at_ms) ||
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    typeof payload.challenge_id !== 'string' ||
    (payload.user_id !== null && typeof payload.user_id !== 'string') ||
    typeof payload.email_hash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.email_hash) ||
    event.aggregate_type !== (payload.user_id === null ? 'email_identity' : 'user') ||
    event.aggregate_id !== (payload.user_id ?? payload.email_hash) ||
    (payload.purpose !== 'registration_email_verification' &&
      payload.purpose !== 'email_verification' && payload.purpose !== 'email_binding' &&
      payload.purpose !== 'password_reset') ||
    typeof payload.recipient_email !== 'string' || payload.recipient_email.length > 320 ||
    !isChallengeToken(payload.token, payload.purpose) ||
    typeof payload.action_url !== 'string' || payload.action_url.length > 2_048 ||
    typeof payload.site_name !== 'string' || payload.site_name.length > 128 ||
    typeof payload.locale !== 'string' || payload.locale.length > 128 ||
    !Number.isSafeInteger(payload.expires_at_ms) ||
    !Number.isSafeInteger(payload.generation) || payload.generation < 1 ||
    event.event_id !== `email-challenge:${payload.challenge_id}:${payload.generation}`
  ) {
    throw invalidEvent()
  }
  return event as EmailChallengeDeliveryEvent
}

async function findActiveUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, state_version,
            auth_version, password_credential, email_verified_at_ms,
            password_changed_at_ms, last_login_at_ms, avatar_object_key,
            avatar_content_type, avatar_updated_at_ms, created_at_ms, updated_at_ms
       FROM users
      WHERE email = ? AND status = 'active'
      LIMIT 1`,
  ).bind(email).first<UserRow>()
}

async function findUserByEmail(env: Env, email: string): Promise<Pick<UserRow, 'id'> | null> {
  return env.DB.prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
    .bind(email)
    .first<Pick<UserRow, 'id'>>()
}

/** Uses the migration-owned canonical inbox index shared by every users writer. */
async function findConflictingEmailInboxOwner(
  env: Env,
  email: string,
  currentUserId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM users
      WHERE canonical_email_inbox = ? AND id <> ?
      LIMIT 1`,
  ).bind(canonicalEmailInbox(email), currentUserId).first<{ id: string }>()
  return row?.id ?? null
}

function canonicalEmailInbox(value: string): string {
  const normalized = value.trim().toLowerCase()
  const at = normalized.lastIndexOf('@')
  let local = normalized.slice(0, at)
  let domain = normalized.slice(at + 1).replace(/\.+$/, '')
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const dotless = local.replaceAll('.', '')
    if (dotless !== '') local = dotless
    domain = 'gmail.com'
  }
  return `${local}@${domain}`
}

async function requireEmailChallengeSettings(
  env: Env,
  purpose: EmailChallengePurpose,
): Promise<EmailChallengePublicSettings> {
  const settings = await readEmailChallengeSettings(env)
  const enabled = purpose === 'password_reset'
    ? settings.password_reset_enabled ?? settings.email_verification_enabled
    : settings.email_verification_enabled
  if (enabled !== true) {
    throw new GatewayError(
      403,
      purpose === 'password_reset' ? 'PASSWORD_RESET_DISABLED' : 'EMAIL_VERIFICATION_DISABLED',
      purpose === 'password_reset' ? 'Password reset is not enabled' : 'Email verification is not enabled',
      'permission_error',
    )
  }
  return settings
}

async function readEmailChallengeSettings(env: Env): Promise<EmailChallengePublicSettings> {
  let settings: EmailChallengePublicSettings | null
  try {
    settings = await env.CONFIG_KV.get<EmailChallengePublicSettings>(
      `${env.ENVIRONMENT}:public-settings:v1`,
      'json',
    )
  } catch {
    throw new GatewayError(503, 'settings_unavailable', 'Authentication settings are unavailable', 'server_error')
  }
  if (settings === null) {
    throw new GatewayError(503, 'settings_unavailable', 'Authentication settings are unavailable', 'server_error')
  }
  return settings
}


function createChallengeToken(purpose: EmailChallengePurpose): string {
  if (purpose === 'registration_email_verification' || purpose === 'email_binding') {
    return createSixDigitCode()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const random = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `${purpose === 'email_verification' ? 'sev' : 'spr'}_v1_${random}`
}

function createSixDigitCode(): string {
  const digits = new Uint8Array(6)
  for (let index = 0; index < digits.length; index += 1) {
    let value = 255
    while (value >= 250) value = crypto.getRandomValues(new Uint8Array(1))[0]
    digits[index] = value % 10
  }
  return Array.from(digits).join('')
}

async function challengeTokenDigest(
  env: Env,
  token: string,
  purpose: EmailChallengePurpose,
): Promise<string> {
  return hmacDigest(env, `sub2api/email-challenge/${purpose}/v1\0${token}`)
}

async function emailDeliveryEventDigest(env: Env, event: EmailChallengeDeliveryEvent): Promise<string> {
  return hmacDigest(env, `sub2api/email-challenge-delivery/v1\0${JSON.stringify(event)}`)
}

async function hmacDigest(env: Env, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(requirePepper(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function requestIpHash(request: Request): Promise<string> {
  const address = request.headers.get('cf-connecting-ip')?.trim().toLowerCase() ||
    'cloudflare-address-unavailable'
  return sha256Hex(address.slice(0, 128))
}

function challengeActionUrl(
  request: Request,
  email: string,
  token: string,
  purpose: EmailChallengePurpose,
  frontendUrl?: string,
): string {
  const pathname = purpose === 'password_reset'
    ? '/reset-password'
    : purpose === 'email_binding'
    ? '/profile'
    : '/email-verify'
  const target = new URL(pathname, frontendUrl || request.url)
  target.searchParams.set('email', email)
  target.searchParams.set('token', token)
  return target.toString()
}

function challengeTtl(purpose: EmailChallengePurpose): number {
  return purpose === 'password_reset' ? PASSWORD_RESET_TTL_MS : EMAIL_VERIFICATION_TTL_MS
}

function normalizedSiteName(value: unknown): string {
  if (typeof value !== 'string') return 'Sub2API'
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128)
  return normalized === '' ? 'Sub2API' : normalized
}

function requireEmail(value: unknown): string {
  if (typeof value !== 'string') throw new GatewayError(400, 'invalid_email', 'Email is invalid')
  const email = value.trim().toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GatewayError(400, 'invalid_email', 'Email is invalid')
  }
  return email
}

function requireBindableEmail(value: unknown): string {
  const email = requireEmail(value)
  if (canonicalEmailInbox(email).endsWith('.invalid')) {
    throw new GatewayError(400, 'email_reserved', 'Email address is reserved')
  }
  return email
}

function requirePassword(value: unknown): string {
  if (typeof value !== 'string') throw new GatewayError(400, 'invalid_password', 'Password is invalid')
  return value
}

function requireChallengeToken(value: unknown, purpose: EmailChallengePurpose): string {
  if (!isChallengeToken(value, purpose)) throw invalidChallenge(purpose)
  return value
}

function isChallengeToken(value: unknown, purpose: EmailChallengePurpose): value is string {
  return typeof value === 'string' && (
    purpose === 'registration_email_verification' || purpose === 'email_binding'
      ? REGISTRATION_CODE_PATTERN.test(value)
      : purpose === 'email_verification'
      ? EMAIL_VERIFICATION_TOKEN_PATTERN.test(value)
      : PASSWORD_RESET_TOKEN_PATTERN.test(value)
  )
}

function requirePepper(env: Env): string {
  if (!env.API_KEY_PEPPER || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < TOKEN_PEPPER_MIN_BYTES) {
    throw new GatewayError(503, 'auth_not_configured', 'Authentication is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function passwordResetRequestAccepted(): Response {
  return controlSuccess({
    message: 'If your email is registered, you will receive a password reset link shortly.',
  })
}

function invalidChallenge(purpose: EmailChallengePurpose): GatewayError {
  if (purpose === 'registration_email_verification' || purpose === 'email_binding') {
    return new GatewayError(400, 'INVALID_VERIFY_CODE', 'Invalid or expired verification code')
  }
  return new GatewayError(
    400,
    purpose === 'password_reset' ? 'INVALID_RESET_TOKEN' : 'INVALID_EMAIL_VERIFICATION_TOKEN',
    purpose === 'password_reset'
      ? 'Invalid or expired password reset token'
      : 'Invalid or expired email verification token',
  )
}

function invalidEvent(): Error {
  return new Error('Invalid email challenge delivery event')
}

function challengeError(error: unknown): Response {
  if (error instanceof PasswordValidationError) {
    return controlError(new GatewayError(400, error.code, error.message))
  }
  return controlError(asGatewayError(error))
}

function resultChanges(result: D1Result<unknown>): number {
  const changes = (result.meta as D1Meta & { changes?: unknown }).changes
  return Number.isSafeInteger(changes) ? changes as number : 0
}

function isConstraintConflict(error: unknown): boolean {
  return /(?:UNIQUE|PRIMARY KEY) constraint failed/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}
