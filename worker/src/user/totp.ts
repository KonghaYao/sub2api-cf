import type { Context } from 'hono'
import {
  authenticateUserRequest,
  type UserRow,
} from '../auth/handler'
import { verifyPassword } from '../auth/password'
import {
  checkAuthRateLimit,
  clearAuthAccountRateLimit,
  commitAuthRateLimitAttempt,
  recordAuthRateLimitFailure,
} from '../auth/rate-limit'
import {
  deliverPlatformEmail,
  hasEmailDeliveryBinding,
} from '../email/delivery'
import {
  executeLeasedEmailDelivery,
  type EmailDeliveryExecutionResult,
} from '../email/delivery-executor'
import {
  createTotpSetupToken,
  decryptTotpSecret,
  encryptTotpSecret,
  findTotpCredential,
  generateTotpSecret,
  generateTotpRecoveryCodes,
  isTotpSetupToken,
  isTotpRecoveryCode,
  TOTP_MAX_ATTEMPTS,
  TOTP_SETUP_TTL_MS,
  TOTP_STEP_UP_TTL_MS,
  totpFeatureAvailable,
  totpRecoveryCodeDigest,
  totpTokenDigest,
  verifyStoredTotpCode,
  verifyTotpCode,
  type EncryptedTotpSecret,
} from '../auth/totp'
import { controlError, controlSuccess, readJsonObject, readOptionalJsonObject } from '../control/http'
import type { Env, PlatformEvent } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'

type UserBindings = { Bindings: Env }

const EMAIL_TTL_MS = 15 * 60 * 1_000
const EMAIL_COOLDOWN_MS = 60 * 1_000
const EMAIL_LEASE_MS = 60 * 1_000
const EMAIL_RATE_WINDOW_MS = 60 * 60 * 1_000

interface TotpSettings {
  email_verification_enabled?: boolean
  email_verify_enabled?: boolean
  site_name?: string
}

interface SetupChallengeRow extends EncryptedTotpSecret {
  id: string
  user_id: string
  token_hash: string
  status: 'pending' | 'consumed'
  verification_attempts: number
  version: number
  created_at_ms: number
  expires_at_ms: number
}

interface EmailChallengeRow {
  id: string
  user_id: string
  email_hash: string
  token_hash: string
  generation: number
  status: 'pending' | 'consumed'
  verification_attempts: number
  delivery_event_id: string
  delivery_state: 'pending' | 'queued' | 'delivering' | 'sent' | 'failed'
  version: number
  created_at_ms: number
  expires_at_ms: number
}

export interface TotpEmailVerificationPayload {
  challenge_id: string
  user_id: string
  recipient_email: string
  verification_code: string
  site_name: string
  locale: string
  expires_at_ms: number
  generation: number
}

export type TotpEmailVerificationEvent = PlatformEvent<TotpEmailVerificationPayload> & {
  event_type: 'auth.totp-email-challenge.delivery.v1'
  aggregate_type: 'user'
}

export type TotpEmailDeliveryResult = EmailDeliveryExecutionResult

export async function getTotpStatus(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const [credential, recoveryCount] = await Promise.all([
      findTotpCredential(context.env, user.id),
      context.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM user_totp_recovery_codes
          WHERE user_id = ? AND consumed_at_ms IS NULL`,
      ).bind(user.id).first<{ count: number }>(),
    ])
    return controlSuccess({
      enabled: credential !== null,
      enabled_at: credential === null ? null : Math.floor(credential.enabled_at_ms / 1_000),
      feature_enabled: totpFeatureAvailable(context.env),
      recovery_codes_remaining: recoveryCount?.count ?? 0,
    })
  } catch (error) {
    return totpError(error)
  }
}

export async function getTotpVerificationMethod(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    return controlSuccess({ method: await verificationMethod(context.env, user) })
  } catch (error) {
    return totpError(error)
  }
}

export async function sendTotpVerificationCode(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const settings = await readTotpSettings(context.env)
    if (user.role === 'admin' || !emailVerificationEnabled(settings)) {
      throw new GatewayError(400, 'EMAIL_VERIFY_NOT_ENABLED', 'Email verification is not enabled')
    }
    if (!totpFeatureAvailable(context.env)) throw totpNotConfigured()
    if (!hasEmailDeliveryBinding(context.env)) {
      throw new GatewayError(
        503,
        'TOTP_EMAIL_DELIVERY_UNAVAILABLE',
        'TOTP verification email delivery is unavailable',
        'server_error',
      )
    }

    const now = Date.now()
    const existing = await context.env.DB.prepare(
      `SELECT id, user_id, email_hash, token_hash, generation, status,
              verification_attempts, delivery_event_id, delivery_state, version,
              created_at_ms, expires_at_ms
         FROM user_totp_email_challenges WHERE user_id = ? LIMIT 1`,
    ).bind(user.id).first<EmailChallengeRow>()
    if (
      existing !== null && existing.status === 'pending' &&
      existing.delivery_state !== 'failed' && existing.expires_at_ms > now &&
      existing.created_at_ms + EMAIL_COOLDOWN_MS > now
    ) {
      return controlSuccess({ success: true })
    }

    const code = createSixDigitCode()
    const id = crypto.randomUUID()
    const generation = (existing?.generation ?? 0) + 1
    const eventId = `totp-email:${id}:${generation}`
    const [emailHash, tokenHash] = await Promise.all([
      sha256Hex(user.email),
      totpEmailCodeDigest(context.env, user.id, user.email, code),
    ])
    const expiresAtMs = now + EMAIL_TTL_MS
    let challenge: D1PreparedStatement
    if (existing === null) {
      challenge = context.env.DB.prepare(
        `INSERT INTO user_totp_email_challenges (
           id, user_id, email_hash, token_hash, generation, status,
           verification_attempts, delivery_event_id, delivery_state, version,
           created_at_ms, expires_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'pending', 1, ?, ?, ?)
         RETURNING id`,
      ).bind(
        id, user.id, emailHash, tokenHash, generation, eventId, now, expiresAtMs, now,
      )
    } else {
      challenge = context.env.DB.prepare(
        `UPDATE user_totp_email_challenges
            SET id = ?, email_hash = ?, token_hash = ?, generation = ?,
                status = 'pending', verification_attempts = 0,
                delivery_event_id = ?, delivery_state = 'pending',
                delivery_attempts = 0, delivery_lease_id = NULL,
                delivery_lease_expires_at_ms = NULL, last_delivery_error = NULL,
                delivered_at_ms = NULL, version = version + 1,
                created_at_ms = ?, expires_at_ms = ?, consumed_at_ms = NULL,
                consume_nonce = NULL, updated_at_ms = ?
          WHERE user_id = ? AND version = ?
          RETURNING id`,
      ).bind(
        id, emailHash, tokenHash, generation, eventId, now, expiresAtMs, now,
        user.id, existing.version,
      )
    }
    const writes = await context.env.DB.batch([
      totpEmailRateLimitStatement(context.env, user.id, now),
      challenge,
    ])
    if (writes[1]?.results.length !== 1) return controlSuccess({ success: true })

    const event = createTotpEmailVerificationEvent({
      challenge_id: id,
      user_id: user.id,
      recipient_email: user.email,
      verification_code: code,
      site_name: normalizedSiteName(settings.site_name),
      locale: context.req.header('accept-language')?.slice(0, 128) ?? '',
      expires_at_ms: expiresAtMs,
      generation,
    }, now)
    try {
      await context.env.EVENTS_QUEUE.send(event)
      await context.env.DB.prepare(
        `UPDATE user_totp_email_challenges
            SET delivery_state = 'queued', updated_at_ms = ?
          WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
      ).bind(Date.now(), id, eventId).run()
    } catch {
      await context.env.DB.prepare(
        `UPDATE user_totp_email_challenges
            SET delivery_state = 'failed', updated_at_ms = ?
          WHERE id = ? AND delivery_event_id = ? AND delivery_state = 'pending'`,
      ).bind(Date.now(), id, eventId).run()
      throw new GatewayError(
        503,
        'TOTP_EMAIL_DELIVERY_UNAVAILABLE',
        'TOTP verification email delivery is unavailable',
        'server_error',
      )
    }
    return controlSuccess({ success: true })
  } catch (error) {
    return totpError(error)
  }
}

export async function initiateTotpSetup(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    if (!totpFeatureAvailable(context.env)) throw totpNotConfigured()
    if (await findTotpCredential(context.env, user.id) !== null) {
      throw new GatewayError(400, 'TOTP_ALREADY_ENABLED', 'TOTP is already enabled for this account')
    }
    const body = await readOptionalJsonObject(context.req.raw)
    const method = await verificationMethod(context.env, user)
    const emailChallenge = method === 'email'
      ? await requireTotpEmailChallenge(context.env, user, body.email_code)
      : null
    if (method === 'password') await verifyPasswordIdentity(context, user, body.password)

    const now = Date.now()
    const secret = generateTotpSecret()
    const encrypted = await encryptTotpSecret(context.env, user.id, secret)
    const setupToken = createTotpSetupToken()
    const tokenHash = await totpTokenDigest(setupToken)
    const challengeId = crypto.randomUUID()
    let writes: D1Result<unknown>[]
    if (emailChallenge === null) {
      writes = await context.env.DB.batch([
        upsertSetupChallengeStatement(
          context.env, challengeId, user.id, tokenHash, encrypted, now,
        ),
      ])
    } else {
      const consumeNonce = crypto.randomUUID()
      writes = await context.env.DB.batch([
        consumeEmailChallengeStatement(
          context.env, emailChallenge, user, consumeNonce, now,
        ),
        upsertSetupChallengeFromEmailStatement(
          context.env, challengeId, user.id, tokenHash, encrypted,
          emailChallenge.id, consumeNonce, now,
        ),
      ])
      if (writes[0]?.results.length !== 1 || writes[1]?.results.length !== 1) {
        throw invalidIdentityCode()
      }
    }
    if (writes.at(-1)?.results.length !== 1) {
      throw new GatewayError(409, 'TOTP_SETUP_CONFLICT', 'TOTP setup changed concurrently')
    }
    const siteName = normalizedSiteName((await readTotpSettings(context.env)).site_name)
    return controlSuccess({
      secret,
      qr_code_url: totpQrCodeUrl(siteName, user.email, secret),
      setup_token: setupToken,
      countdown: Math.floor(TOTP_SETUP_TTL_MS / 1_000),
    })
  } catch (error) {
    return totpError(error)
  }
}

export async function enableTotp(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    if (!totpFeatureAvailable(context.env)) throw totpNotConfigured()
    const body = await readJsonObject(context.req.raw)
    const setupToken = body.setup_token
    const code = body.totp_code
    const now = Date.now()
    const challenge = await context.env.DB.prepare(
      `SELECT id, user_id, token_hash, secret_version, nonce_b64, ciphertext_b64,
              status, verification_attempts, version, created_at_ms, expires_at_ms
         FROM user_totp_setup_challenges WHERE user_id = ? LIMIT 1`,
    ).bind(user.id).first<SetupChallengeRow>()
    if (
      challenge === null || challenge.status !== 'pending' ||
      challenge.expires_at_ms <= now || !isTotpSetupToken(setupToken)
    ) throw setupExpired()
    if (challenge.verification_attempts >= TOTP_MAX_ATTEMPTS) throw tooManyAttempts()
    const reservedChallenge = await reserveSetupAttempt(context.env, challenge, now)

    const tokenHash = await totpTokenDigest(setupToken)
    let valid = constantTimeStringEqual(tokenHash, reservedChallenge.token_hash)
    if (valid) {
      const secret = await decryptTotpSecret(context.env, user.id, reservedChallenge)
      valid = await verifyTotpCode(code, secret, now)
    }
    if (!valid) {
      throw new GatewayError(400, 'TOTP_INVALID_CODE', 'Invalid TOTP code')
    }

    const consumeNonce = crypto.randomUUID()
    const recovery = await prepareRecoveryCodeSet(context.env, user.id)
    let writes: D1Result<unknown>[]
    try {
      writes = await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE user_totp_setup_challenges
              SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?,
                  version = version + 1, updated_at_ms = ?
            WHERE id = ? AND user_id = ? AND token_hash = ?
              AND status = 'pending' AND expires_at_ms > ?
              AND verification_attempts <= ?
            RETURNING id`,
        ).bind(
          now, consumeNonce, now, reservedChallenge.id, user.id, tokenHash,
          now, TOTP_MAX_ATTEMPTS,
        ),
        context.env.DB.prepare(
          `INSERT INTO user_totp_credentials (
             user_id, secret_version, nonce_b64, ciphertext_b64,
             version, enabled_at_ms, created_at_ms, updated_at_ms
           )
           SELECT user_id, secret_version, nonce_b64, ciphertext_b64, 1, ?, ?, ?
             FROM user_totp_setup_challenges
           WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
           RETURNING user_id`,
        ).bind(now, now, now, reservedChallenge.id, user.id, consumeNonce),
        context.env.DB.prepare(
          `INSERT INTO user_totp_recovery_code_sets (
             user_id, set_id, version, created_at_ms, updated_at_ms
           )
           SELECT user_id, ?, 1, ?, ? FROM user_totp_credentials
            WHERE user_id = ?
              AND EXISTS (
                SELECT 1 FROM user_totp_setup_challenges
                 WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
              )
           RETURNING user_id`,
        ).bind(
          recovery.setId, now, now, user.id,
          reservedChallenge.id, user.id, consumeNonce,
        ),
        ...recovery.hashes.map((hash, position) => context.env.DB.prepare(
          `INSERT INTO user_totp_recovery_codes (
             user_id, set_id, position, code_hash, created_at_ms
           )
           SELECT user_id, set_id, ?, ?, ? FROM user_totp_recovery_code_sets
            WHERE user_id = ? AND set_id = ?
           RETURNING position`,
        ).bind(position, hash, now, user.id, recovery.setId)),
      ])
    } catch (error) {
      if (/user_totp_credentials\.user_id/i.test(errorMessage(error))) {
        throw new GatewayError(400, 'TOTP_ALREADY_ENABLED', 'TOTP is already enabled for this account')
      }
      throw error
    }
    if (writes.some((write) => write.results.length !== 1)) throw setupExpired()
    return controlSuccess({ success: true, recovery_codes: recovery.codes })
  } catch (error) {
    return totpError(error)
  }
}

export async function disableTotp(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const credential = await findTotpCredential(context.env, user.id)
    if (credential === null) {
      throw new GatewayError(400, 'TOTP_NOT_SETUP', 'TOTP is not set up for this account')
    }
    const body = await readJsonObject(context.req.raw)
    const now = Date.now()
    let writes: D1Result<unknown>[]
    const hasStepUp = user.step_up_expires_at_ms !== null && user.step_up_expires_at_ms > now
    if (hasStepUp) {
      writes = await context.env.DB.batch([
        context.env.DB.prepare(
          `DELETE FROM user_totp_credentials
            WHERE user_id = ? AND version = ?
              AND EXISTS (
                SELECT 1 FROM user_sessions
                 WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
                   AND access_expires_at_ms > ? AND step_up_expires_at_ms > ?
              )
            RETURNING user_id`,
        ).bind(user.id, credential.version, user.session_id, user.id, now, now),
      ])
    } else if (await verificationMethod(context.env, user) === 'password') {
      await verifyPasswordIdentity(context, user, body.password)
      writes = await context.env.DB.batch([
        context.env.DB.prepare(
          `DELETE FROM user_totp_credentials
            WHERE user_id = ? AND version = ? RETURNING user_id`,
        ).bind(user.id, credential.version),
      ])
    } else {
      const challenge = await requireTotpEmailChallenge(context.env, user, body.email_code)
      const consumeNonce = crypto.randomUUID()
      writes = await context.env.DB.batch([
        consumeEmailChallengeStatement(context.env, challenge, user, consumeNonce, now),
        context.env.DB.prepare(
          `DELETE FROM user_totp_credentials
            WHERE user_id = ? AND version = ?
              AND EXISTS (
                SELECT 1 FROM user_totp_email_challenges
                 WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
              )
            RETURNING user_id`,
        ).bind(user.id, credential.version, challenge.id, user.id, consumeNonce),
      ])
      if (writes[0]?.results.length !== 1) throw invalidIdentityCode()
    }
    if (writes.at(-1)?.results.length !== 1) {
      throw new GatewayError(409, 'TOTP_VERSION_CONFLICT', 'TOTP state changed concurrently')
    }
    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM user_totp_setup_challenges WHERE user_id = ?').bind(user.id),
      context.env.DB.prepare('DELETE FROM user_totp_login_challenges WHERE user_id = ?').bind(user.id),
      context.env.DB.prepare('DELETE FROM user_totp_verification_budgets WHERE user_id = ?').bind(user.id),
      context.env.DB.prepare(
        `UPDATE user_sessions SET step_up_expires_at_ms = NULL WHERE user_id = ?`,
      ).bind(user.id),
    ])
    return controlSuccess({ success: true })
  } catch (error) {
    return totpError(error)
  }
}

export async function grantTotpStepUp(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const credential = await findTotpCredential(context.env, user.id)
    if (credential === null) {
      throw new GatewayError(400, 'TOTP_NOT_SETUP', 'TOTP is not set up for this account')
    }
    const subject = await checkAuthRateLimit(context.env, context.req.raw, user.email, 'login')
    await commitAuthRateLimitAttempt(context.env, subject)
    const recoveryCode = body.recovery_code
    const useRecoveryCode = isTotpRecoveryCode(recoveryCode) && body.code === undefined
    const useAuthenticatorCode = typeof body.code === 'string' && /^\d{6}$/.test(body.code) &&
      recoveryCode === undefined
    let recoveryHash: string | null = null
    let valid = false
    if (useRecoveryCode) {
      recoveryHash = await totpRecoveryCodeDigest(context.env, user.id, recoveryCode)
      valid = (await context.env.DB.prepare(
        `SELECT 1 AS available FROM user_totp_recovery_codes
          WHERE user_id = ? AND code_hash = ? AND consumed_at_ms IS NULL LIMIT 1`,
      ).bind(user.id, recoveryHash).first()) !== null
    } else if (useAuthenticatorCode) {
      valid = await verifyStoredTotpCode(context.env, credential, body.code)
    }
    if (!valid) {
      await recordAuthRateLimitFailure(context.env, subject)
      throw new GatewayError(400, 'TOTP_INVALID_CODE', 'Invalid TOTP code')
    }
    const expiresAtMs = Date.now() + TOTP_STEP_UP_TTL_MS
    const now = Date.now()
    let updated = false
    if (recoveryHash === null) {
      const update = await context.env.DB.prepare(
        `UPDATE user_sessions SET step_up_expires_at_ms = ?
          WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
            AND access_expires_at_ms > ?
            AND EXISTS (
              SELECT 1 FROM user_totp_credentials
               WHERE user_id = ? AND version = ?
            )
          RETURNING id`,
      ).bind(
        expiresAtMs, user.session_id, user.id, now, user.id, credential.version,
      ).all<{ id: string }>()
      updated = update.results.length === 1
    } else {
      const consumeNonce = crypto.randomUUID()
      const writes = await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE user_totp_recovery_codes
              SET consumed_at_ms = ?, consume_nonce = ?
            WHERE user_id = ? AND code_hash = ? AND consumed_at_ms IS NULL
              AND EXISTS (
                SELECT 1 FROM user_totp_credentials
                 WHERE user_id = ? AND version = ?
              )
              AND EXISTS (
                SELECT 1 FROM user_sessions
                 WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
                   AND access_expires_at_ms > ?
              )
            RETURNING position`,
        ).bind(
          now, consumeNonce, user.id, recoveryHash, user.id, credential.version,
          user.session_id, user.id, now,
        ),
        context.env.DB.prepare(
          `UPDATE user_sessions SET step_up_expires_at_ms = ?
            WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
              AND access_expires_at_ms > ?
              AND EXISTS (
                SELECT 1 FROM user_totp_recovery_codes
                 WHERE user_id = ? AND code_hash = ? AND consume_nonce = ?
              )
            RETURNING id`,
        ).bind(
          expiresAtMs, user.session_id, user.id, now,
          user.id, recoveryHash, consumeNonce,
        ),
      ])
      updated = writes.every((write) => write.results.length === 1)
    }
    if (!updated) {
      await recordAuthRateLimitFailure(context.env, subject)
      throw new GatewayError(401, 'invalid_access_token', 'Invalid or expired access token', 'authentication_error')
    }
    await clearAuthAccountRateLimit(context.env, subject)
    return controlSuccess({
      verified: true,
      expires_in: Math.floor(TOTP_STEP_UP_TTL_MS / 1_000),
    })
  } catch (error) {
    return totpError(error)
  }
}

export async function regenerateTotpRecoveryCodes(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const credential = await findTotpCredential(context.env, user.id)
    if (credential === null) {
      throw new GatewayError(400, 'TOTP_NOT_SETUP', 'TOTP is not set up for this account')
    }
    const now = Date.now()
    if (user.step_up_expires_at_ms === null || user.step_up_expires_at_ms <= now) {
      throw new GatewayError(403, 'STEP_UP_REQUIRED', 'Recent two-factor verification is required', 'permission_error')
    }
    const current = await context.env.DB.prepare(
      `SELECT set_id, version FROM user_totp_recovery_code_sets
        WHERE user_id = ? LIMIT 1`,
    ).bind(user.id).first<{ set_id: string; version: number }>()
    const recovery = await prepareRecoveryCodeSet(context.env, user.id)
    let writes: D1Result<unknown>[]
    try {
      if (current === null) {
        writes = await context.env.DB.batch([
          context.env.DB.prepare(
            `INSERT INTO user_totp_recovery_code_sets (
               user_id, set_id, version, created_at_ms, updated_at_ms
             )
             SELECT ?, ?, 1, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM user_totp_credentials WHERE user_id = ? AND version = ?
              ) AND EXISTS (
                SELECT 1 FROM user_sessions
                 WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
                   AND access_expires_at_ms > ? AND step_up_expires_at_ms > ?
              )
             RETURNING user_id`,
          ).bind(
            user.id, recovery.setId, now, now, user.id, credential.version,
            user.session_id, user.id, now, now,
          ),
          ...recovery.hashes.map((hash, position) => recoveryCodeInsertStatement(
            context.env, user.id, recovery.setId, position, hash, now,
          )),
        ])
        if (writes.some((write) => write.results.length !== 1)) throw recoveryCodeConflict()
      } else {
        writes = await context.env.DB.batch([
          context.env.DB.prepare(
            `DELETE FROM user_totp_recovery_codes
              WHERE user_id = ? AND set_id = ?
                AND EXISTS (
                  SELECT 1 FROM user_totp_recovery_code_sets
                   WHERE user_id = ? AND set_id = ? AND version = ?
                )
                AND EXISTS (
                  SELECT 1 FROM user_sessions
                   WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
                     AND access_expires_at_ms > ? AND step_up_expires_at_ms > ?
                )
              RETURNING position`,
          ).bind(
            user.id, current.set_id, user.id, current.set_id, current.version,
            user.session_id, user.id, now, now,
          ),
          context.env.DB.prepare(
            `UPDATE user_totp_recovery_code_sets
                SET set_id = ?, version = version + 1, created_at_ms = ?, updated_at_ms = ?
              WHERE user_id = ? AND set_id = ? AND version = ?
                AND EXISTS (
                  SELECT 1 FROM user_totp_credentials WHERE user_id = ? AND version = ?
                )
                AND EXISTS (
                  SELECT 1 FROM user_sessions
                   WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
                     AND access_expires_at_ms > ? AND step_up_expires_at_ms > ?
                )
              RETURNING version`,
          ).bind(
            recovery.setId, now, now, user.id, current.set_id, current.version,
            user.id, credential.version, user.session_id, user.id, now, now,
          ),
          ...recovery.hashes.map((hash, position) => recoveryCodeInsertStatement(
            context.env, user.id, recovery.setId, position, hash, now,
          )),
        ])
        // The set-row CAS is the authority. Deleting zero old rows is valid for
        // an upgraded or repaired account, while a losing concurrent rotation
        // returns zero from the CAS and every conditional insert.
        if (writes.slice(1).some((write) => write.results.length !== 1)) {
          throw recoveryCodeConflict()
        }
      }
    } catch (error) {
      if (isRecoveryCodeUniqueConflict(error)) {
        throw recoveryCodeConflict()
      }
      throw error
    }
    return controlSuccess({ success: true, recovery_codes: recovery.codes })
  } catch (error) {
    return totpError(error)
  }
}

export function createTotpEmailVerificationEvent(
  payload: TotpEmailVerificationPayload,
  occurredAtMs: number,
): TotpEmailVerificationEvent {
  return {
    schema_version: 1,
    event_id: `totp-email:${payload.challenge_id}:${payload.generation}`,
    event_type: 'auth.totp-email-challenge.delivery.v1',
    occurred_at_ms: occurredAtMs,
    aggregate_type: 'user',
    aggregate_id: payload.user_id,
    payload,
  }
}

export function isTotpEmailVerificationEvent(value: unknown): value is TotpEmailVerificationEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<TotpEmailVerificationEvent>
  const payload = event.payload
  return event.schema_version === 1 &&
    event.event_type === 'auth.totp-email-challenge.delivery.v1' &&
    event.aggregate_type === 'user' &&
    typeof event.event_id === 'string' && typeof event.aggregate_id === 'string' &&
    Number.isSafeInteger(event.occurred_at_ms) && (event.occurred_at_ms as number) >= 0 &&
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    typeof payload.challenge_id === 'string' && payload.challenge_id.length > 0 &&
    typeof payload.user_id === 'string' && payload.user_id === event.aggregate_id &&
    typeof payload.recipient_email === 'string' && isEmail(payload.recipient_email) &&
    typeof payload.verification_code === 'string' && /^\d{6}$/.test(payload.verification_code) &&
    typeof payload.site_name === 'string' && payload.site_name.length <= 128 &&
    typeof payload.locale === 'string' && payload.locale.length <= 128 &&
    Number.isSafeInteger(payload.expires_at_ms) &&
    (payload.expires_at_ms as number) > (event.occurred_at_ms as number) &&
    Number.isSafeInteger(payload.generation) && (payload.generation as number) > 0 &&
    event.event_id === `totp-email:${payload.challenge_id}:${payload.generation}`
}

export async function consumeTotpEmailVerificationDelivery(
  value: unknown,
  env: Env,
): Promise<TotpEmailDeliveryResult> {
  return executeLeasedEmailDelivery(value, {
    leaseMs: EMAIL_LEASE_MS,
    failureErrorMaxLength: 1_024,
    describe: (event: TotpEmailVerificationEvent) => `TOTP email delivery ${event.event_id}`,
    lostLeaseMessage: (event) => `TOTP email delivery ${event.event_id} lost its lease`,
    load: async (candidate, now) => {
      if (!isTotpEmailVerificationEvent(candidate)) {
        throw new Error('Invalid TOTP email verification event')
      }
      const event = candidate
      const [emailHash, tokenHash] = await Promise.all([
        sha256Hex(event.payload.recipient_email),
        totpEmailCodeDigest(
          env,
          event.payload.user_id,
          event.payload.recipient_email,
          event.payload.verification_code,
        ),
      ])
      const challenge = await env.DB.prepare(
        `SELECT id, status, delivery_state, last_delivery_error, expires_at_ms
           FROM user_totp_email_challenges
          WHERE id = ? AND user_id = ? AND email_hash = ? AND token_hash = ?
            AND generation = ? AND delivery_event_id = ? LIMIT 1`,
      ).bind(
        event.payload.challenge_id,
        event.payload.user_id,
        emailHash,
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
        `UPDATE user_totp_email_challenges
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
           FROM user_totp_email_challenges WHERE id = ?`,
      ).bind(record.id).first<{ delivery_state: string; last_delivery_error: string | null }>()
      return current === null ? null : {
        id: record.id,
        deliveryState: current.delivery_state,
        lastDeliveryError: current.last_delivery_error,
      }
    },
    send: (event) => deliverTotpEmail(event, env),
    markSent: async ({ record }, leaseId, completedAtMs) => {
      const update = await env.DB.prepare(
        `UPDATE user_totp_email_challenges
            SET delivery_state = 'sent', delivered_at_ms = ?,
                delivery_lease_id = NULL, delivery_lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ? AND delivery_state = 'delivering' AND delivery_lease_id = ?`,
      ).bind(completedAtMs, completedAtMs, record.id, leaseId).run()
      return resultChanges(update) === 1
    },
    markFailed: async ({ record }, leaseId, failure, failedAtMs) => {
      await env.DB.prepare(
        `UPDATE user_totp_email_challenges
            SET delivery_state = 'failed', delivery_lease_id = NULL,
                delivery_lease_expires_at_ms = NULL, last_delivery_error = ?,
                updated_at_ms = ?
          WHERE id = ? AND delivery_state = 'delivering' AND delivery_lease_id = ?`,
      ).bind(failure, failedAtMs, record.id, leaseId).run()
    },
  })
}

async function verificationMethod(env: Env, user: Pick<UserRow, 'role'>): Promise<'email' | 'password'> {
  if (user.role === 'admin') return 'password'
  return emailVerificationEnabled(await readTotpSettings(env)) ? 'email' : 'password'
}

async function verifyPasswordIdentity(
  context: Context<UserBindings>,
  user: UserRow,
  value: unknown,
): Promise<void> {
  if (typeof value !== 'string' || value === '') {
    throw new GatewayError(400, 'PASSWORD_REQUIRED', 'Password is required')
  }
  const subject = await checkAuthRateLimit(context.env, context.req.raw, user.email, 'login')
  await commitAuthRateLimitAttempt(context.env, subject)
  if (user.password_credential === null || !(await verifyPassword(value, user.password_credential))) {
    await recordAuthRateLimitFailure(context.env, subject)
    throw new GatewayError(400, 'PASSWORD_INCORRECT', 'Password is incorrect')
  }
  await clearAuthAccountRateLimit(context.env, subject)
}

async function requireTotpEmailChallenge(
  env: Env,
  user: Pick<UserRow, 'id' | 'email'>,
  code: unknown,
): Promise<EmailChallengeRow> {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalidIdentityCode()
  const now = Date.now()
  const challenge = await env.DB.prepare(
    `SELECT id, user_id, email_hash, token_hash, generation, status,
            verification_attempts, delivery_event_id, delivery_state, version,
            created_at_ms, expires_at_ms
       FROM user_totp_email_challenges WHERE user_id = ? LIMIT 1`,
  ).bind(user.id).first<EmailChallengeRow>()
  if (
    challenge === null || challenge.status !== 'pending' || challenge.expires_at_ms <= now ||
    challenge.verification_attempts >= TOTP_MAX_ATTEMPTS
  ) {
    if (challenge?.verification_attempts === TOTP_MAX_ATTEMPTS) throw tooManyAttempts()
    throw invalidIdentityCode()
  }
  const reservation = await env.DB.prepare(
    `UPDATE user_totp_email_challenges
        SET verification_attempts = verification_attempts + 1,
            version = version + 1, updated_at_ms = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'
        AND expires_at_ms > ? AND verification_attempts < ?
      RETURNING verification_attempts, version`,
  ).bind(now, challenge.id, user.id, now, TOTP_MAX_ATTEMPTS)
    .all<{ verification_attempts: number; version: number }>()
  const reserved = reservation.results[0]
  if (reserved === undefined) throw tooManyAttempts()
  const [emailHash, tokenHash] = await Promise.all([
    sha256Hex(user.email),
    totpEmailCodeDigest(env, user.id, user.email, code),
  ])
  if (
    !constantTimeStringEqual(challenge.email_hash, emailHash) ||
    !constantTimeStringEqual(challenge.token_hash, tokenHash)
  ) throw invalidIdentityCode()
  return {
    ...challenge,
    verification_attempts: reserved.verification_attempts,
    version: reserved.version,
  }
}

function consumeEmailChallengeStatement(
  env: Env,
  challenge: EmailChallengeRow,
  user: Pick<UserRow, 'id' | 'email'>,
  consumeNonce: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE user_totp_email_challenges
        SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?,
            version = version + 1, updated_at_ms = ?
      WHERE id = ? AND user_id = ? AND email_hash = ? AND token_hash = ?
        AND version = ? AND status = 'pending' AND expires_at_ms > ?
        AND verification_attempts <= ?
      RETURNING id`,
  ).bind(
    now, consumeNonce, now, challenge.id, user.id, challenge.email_hash,
    challenge.token_hash, challenge.version, now, TOTP_MAX_ATTEMPTS,
  )
}

function upsertSetupChallengeStatement(
  env: Env,
  id: string,
  userId: string,
  tokenHash: string,
  secret: EncryptedTotpSecret,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_totp_setup_challenges (
       id, user_id, token_hash, secret_version, nonce_b64, ciphertext_b64,
       status, verification_attempts, version, created_at_ms, expires_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       id = excluded.id, token_hash = excluded.token_hash,
       secret_version = excluded.secret_version, nonce_b64 = excluded.nonce_b64,
       ciphertext_b64 = excluded.ciphertext_b64, status = 'pending',
       verification_attempts = 0, version = user_totp_setup_challenges.version + 1,
       created_at_ms = excluded.created_at_ms, expires_at_ms = excluded.expires_at_ms,
       consumed_at_ms = NULL, consume_nonce = NULL, updated_at_ms = excluded.updated_at_ms
     RETURNING id`,
  ).bind(
    id, userId, tokenHash, secret.secret_version, secret.nonce_b64,
    secret.ciphertext_b64, now, now + TOTP_SETUP_TTL_MS, now,
  )
}

function upsertSetupChallengeFromEmailStatement(
  env: Env,
  id: string,
  userId: string,
  tokenHash: string,
  secret: EncryptedTotpSecret,
  emailChallengeId: string,
  consumeNonce: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_totp_setup_challenges (
       id, user_id, token_hash, secret_version, nonce_b64, ciphertext_b64,
       status, verification_attempts, version, created_at_ms, expires_at_ms, updated_at_ms
     )
     SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?, ?
       FROM user_totp_email_challenges
      WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
     ON CONFLICT(user_id) DO UPDATE SET
       id = excluded.id, token_hash = excluded.token_hash,
       secret_version = excluded.secret_version, nonce_b64 = excluded.nonce_b64,
       ciphertext_b64 = excluded.ciphertext_b64, status = 'pending',
       verification_attempts = 0, version = user_totp_setup_challenges.version + 1,
       created_at_ms = excluded.created_at_ms, expires_at_ms = excluded.expires_at_ms,
       consumed_at_ms = NULL, consume_nonce = NULL, updated_at_ms = excluded.updated_at_ms
     RETURNING id`,
  ).bind(
    id, userId, tokenHash, secret.secret_version, secret.nonce_b64,
    secret.ciphertext_b64, now, now + TOTP_SETUP_TTL_MS, now,
    emailChallengeId, userId, consumeNonce,
  )
}

async function reserveSetupAttempt(
  env: Env,
  challenge: SetupChallengeRow,
  now: number,
): Promise<SetupChallengeRow> {
  const reservation = await env.DB.prepare(
    `UPDATE user_totp_setup_challenges
        SET verification_attempts = verification_attempts + 1,
            version = version + 1, updated_at_ms = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'
        AND expires_at_ms > ? AND verification_attempts < ?
      RETURNING verification_attempts, version`,
  ).bind(now, challenge.id, challenge.user_id, now, TOTP_MAX_ATTEMPTS)
    .all<{ verification_attempts: number; version: number }>()
  const reserved = reservation.results[0]
  if (reserved === undefined) throw tooManyAttempts()
  return {
    ...challenge,
    verification_attempts: reserved.verification_attempts,
    version: reserved.version,
  }
}

function totpEmailRateLimitStatement(env: Env, userId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_totp_email_rate_limits (
       user_id, window_started_at_ms, send_count, updated_at_ms
     ) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       window_started_at_ms = CASE
         WHEN window_started_at_ms <= ? THEN excluded.window_started_at_ms
         ELSE window_started_at_ms END,
       send_count = CASE
         WHEN window_started_at_ms <= ? THEN 1 ELSE send_count + 1 END,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(userId, now, now, now - EMAIL_RATE_WINDOW_MS, now - EMAIL_RATE_WINDOW_MS)
}

async function prepareRecoveryCodeSet(
  env: Env,
  userId: string,
): Promise<{ setId: string; codes: string[]; hashes: string[] }> {
  const codes = generateTotpRecoveryCodes()
  return {
    setId: crypto.randomUUID(),
    codes,
    hashes: await Promise.all(codes.map((code) => totpRecoveryCodeDigest(env, userId, code))),
  }
}

function recoveryCodeInsertStatement(
  env: Env,
  userId: string,
  setId: string,
  position: number,
  hash: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_totp_recovery_codes (
       user_id, set_id, position, code_hash, created_at_ms
     )
     SELECT user_id, set_id, ?, ?, ? FROM user_totp_recovery_code_sets
      WHERE user_id = ? AND set_id = ?
     RETURNING position`,
  ).bind(position, hash, now, userId, setId)
}

function recoveryCodeConflict(): GatewayError {
  return new GatewayError(
    409,
    'TOTP_RECOVERY_CODES_CONFLICT',
    'TOTP recovery codes changed concurrently',
  )
}

function isRecoveryCodeUniqueConflict(error: unknown): boolean {
  const message = errorMessage(error)
  return /\bUNIQUE constraint failed:\s*(?:main\.)?user_totp_recovery_code_sets\.(?:user_id|set_id)\b/i
    .test(message) ||
    /\bUNIQUE constraint failed:\s*(?:main\.)?user_totp_recovery_codes\.(?:user_id|set_id|position|code_hash)\b/i
      .test(message)
}

async function readTotpSettings(env: Env): Promise<TotpSettings> {
  try {
    return await env.CONFIG_KV.get<TotpSettings>(
      `${env.ENVIRONMENT}:public-settings:v1`,
      'json',
    ) ?? {}
  } catch {
    throw new GatewayError(503, 'settings_unavailable', 'Authentication settings are unavailable', 'server_error')
  }
}

function emailVerificationEnabled(settings: TotpSettings): boolean {
  return settings.email_verification_enabled === true || settings.email_verify_enabled === true
}

function totpQrCodeUrl(issuer: string, email: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${label}?${query.toString()}`
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

export async function totpEmailCodeDigest(
  env: Env,
  userId: string,
  email: string,
  code: string,
): Promise<string> {
  if (!totpFeatureAvailable(env)) throw totpNotConfigured()
  const textEncoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(env.CREDENTIALS_MASTER_KEY!),
    'HKDF',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode('sub2api-totp-email-challenge-salt-v1'),
      info: textEncoder.encode(`totp-email-challenge/hmac-sha256/v1\0${env.ENVIRONMENT}`),
    },
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(`${userId}\0${email.toLowerCase()}\0${code}`),
  )
  return Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function deliverTotpEmail(event: TotpEmailVerificationEvent, env: Env): Promise<void> {
  const siteName = normalizedSiteName(event.payload.site_name)
  const subject = `${siteName}: Verify TOTP security change`
  const text = [
    `${siteName}: TOTP security verification`,
    '',
    `Verification code: ${event.payload.verification_code}`,
    '',
    'If you did not request this change, secure your account immediately.',
  ].join('\n')
  await deliverPlatformEmail({
    eventId: event.event_id,
    recipient: event.payload.recipient_email,
    subject,
    text,
    html: `<h1>TOTP security verification</h1><p>Verification code: <code>${event.payload.verification_code}</code></p>`,
    compatibilityPayload: {
      recipient_email: event.payload.recipient_email,
      purpose: 'totp_identity_verification',
      token: event.payload.verification_code,
      action_url: '',
      site_name: siteName,
      locale: event.payload.locale,
      expires_at_ms: event.payload.expires_at_ms,
    },
  }, env)
}

function normalizedSiteName(value: unknown): string {
  if (typeof value !== 'string') return 'Sub2API'
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128)
  return normalized === '' ? 'Sub2API' : normalized
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < size; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function setupExpired(): GatewayError {
  return new GatewayError(400, 'TOTP_SETUP_EXPIRED', 'TOTP setup session expired')
}

function invalidIdentityCode(): GatewayError {
  return new GatewayError(400, 'INVALID_VERIFY_CODE', 'Invalid or expired verification code')
}

function tooManyAttempts(): GatewayError {
  return new GatewayError(429, 'TOTP_TOO_MANY_ATTEMPTS', 'Too many verification attempts')
}

function totpNotConfigured(): GatewayError {
  return new GatewayError(503, 'TOTP_NOT_CONFIGURED', 'TOTP encryption is not configured', 'server_error')
}

function totpError(error: unknown): Response {
  const normalized = /user_totp_email_rate_limits.*CHECK|send_count/i.test(errorMessage(error))
    ? new GatewayError(429, 'TOTP_EMAIL_RATE_LIMITED', 'Too many TOTP verification emails')
    : asGatewayError(error)
  const response = controlError(normalized)
  if (normalized.retryAfter !== undefined) response.headers.set('retry-after', normalized.retryAfter)
  return response
}

function resultChanges(result: D1Result<unknown>): number {
  const changes = (result.meta as D1Meta & { changes?: unknown }).changes
  return Number.isSafeInteger(changes) ? changes as number : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
