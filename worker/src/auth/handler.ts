import type { Context, Next } from 'hono'
import type { Env } from '../env'
import { controlError, controlSuccess, readJsonObject } from '../control/http'
import { readSystemSettingSecret } from '../control/settings'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  hashPassword,
  isPasswordInputValid,
  PasswordValidationError,
  validateNewPassword,
  verifyPassword,
} from './password'
import {
  checkAuthRateLimit,
  clearAuthAccountRateLimit,
  commitAuthRateLimitAttempt,
  commitPublicAuthStartRateLimit,
  recordAuthRateLimitFailure,
} from './rate-limit'
import {
  createOpaqueToken,
  isOpaqueToken,
  parseBearerToken,
  tokenDigest,
  TokenValidationError,
} from './tokens'
import type { RegistrationEmailChallengeConsumption } from './email-challenges'
import {
  claimTotpVerificationAttempt,
  createTotpLoginChallenge,
  findTotpCredential,
  findTotpLoginChallenge,
  isTotpLoginToken,
  isTotpRecoveryCode,
  TOTP_MAX_ATTEMPTS,
  totpFeatureAvailable,
  totpRecoveryCodeDigest,
  totpTokenDigest,
  verifyStoredTotpCode,
} from './totp'
import {
  commercialRegistrationInsertSql,
  mapCommercialRegistrationWriteError,
  prepareCommercialRegistration,
} from '../commercial/registration'
import { initialPlatformQuotaStatements } from '../user/platform-quotas'
import { requireRegistrationEmailSuffixAllowed } from './email-policy'

type AuthBindings = { Bindings: Env }

const ACCESS_TTL_MS = 15 * 60 * 1_000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_USER_AGENT_LENGTH = 512

interface PublicAuthSettings {
  registration_enabled?: boolean
  registration_email_suffix_whitelist?: string[]
  email_verification_enabled?: boolean
  turnstile_enabled?: boolean
}

export interface UserRow {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  balance_micros: number
  concurrency: number
  rpm_limit: number
  state_version: number
  auth_version: number
  password_credential: string | null
  email_verified_at_ms: number | null
  password_changed_at_ms: number | null
  last_login_at_ms: number | null
  avatar_object_key: string | null
  avatar_content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null
  avatar_updated_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
}

interface SessionUserRow extends UserRow {
  session_id: string
  family_id: string
  session_auth_version: number
  access_token_hash: string
  refresh_token_hash: string
  previous_refresh_token_hash: string | null
  access_expires_at_ms: number
  refresh_expires_at_ms: number
  revoked_at_ms: number | null
  step_up_expires_at_ms: number | null
}

interface IssuedSession {
  sessionId: string
  familyId: string
  accessToken: string
  refreshToken: string
  accessHash: string
  refreshHash: string
  accessExpiresAtMs: number
  refreshExpiresAtMs: number
}

export async function registerWithPassword(context: Context<AuthBindings>): Promise<Response> {
  try {
    const settings = await publicAuthSettings(context.env)
    if (settings.registration_enabled !== true) {
      throw new GatewayError(403, 'registration_disabled', 'Registration is disabled', 'permission_error')
    }
    const body = await readJsonObject(context.req.raw)
    const email = requireEmail(body.email)
    requireRegistrationEmailSuffixAllowed(email, settings.registration_email_suffix_whitelist)
    const password = requirePassword(body.password)
    validateNewPassword(password)
    const rateLimitSubject = await checkAuthRateLimit(
      context.env,
      context.req.raw,
      email,
      'register',
    )
    await verifyTurnstile(context, settings, body.turnstile_token)
    await commitAuthRateLimitAttempt(context.env, rateLimitSubject)
    const existing = await findUserByEmail(context.env, email)
    if (existing !== null) {
      await recordAuthRateLimitFailure(context.env, rateLimitSubject)
      throw new GatewayError(409, 'email_already_registered', 'Email is already registered')
    }

    const credential = await hashPassword(password)
    await clearAuthAccountRateLimit(context.env, rateLimitSubject)
    const now = Date.now()
    const userId = crypto.randomUUID()
    const commercial = await prepareCommercialRegistration(context.env, body, userId, now)
    let registrationChallenge: RegistrationEmailChallengeConsumption | null = null
    let registrationChallengeModule: typeof import('./email-challenges') | null = null
    if (settings.email_verification_enabled === true) {
      registrationChallengeModule = await import('./email-challenges')
      registrationChallenge = await registrationChallengeModule.prepareRegistrationEmailChallengeConsumption(
        context.env,
        email,
        body.verify_code,
        userId,
        now,
      )
    }
    const user: UserRow = {
      id: userId,
      email,
      display_name: email.slice(0, email.indexOf('@')).slice(0, 128),
      role: 'user',
      status: 'active',
      balance_micros: commercial.bonusMicros,
      concurrency: 5,
      rpm_limit: 0,
      state_version: 0,
      auth_version: 1,
      password_credential: credential,
      email_verified_at_ms: registrationChallenge?.verifiedAtMs ?? null,
      password_changed_at_ms: now,
      last_login_at_ms: now,
      avatar_object_key: null,
      avatar_content_type: null,
      avatar_updated_at_ms: null,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const issued = await issueSession(context.env, user, now)
    const emailHash = await sha256Hex(email)
    try {
      const statements: D1PreparedStatement[] = []
      if (commercial.claimStatement !== undefined) statements.push(commercial.claimStatement)
      if (registrationChallenge !== null) statements.push(registrationChallenge.consumeStatement)
      statements.push(
        context.env.DB.prepare(
          commercialRegistrationInsertSql(commercial.active),
        ).bind(
          user.id,
          email,
          user.display_name,
          ...(commercial.active ? [user.balance_micros] : []),
          now,
          now,
          credential,
          now,
          now,
          registrationChallenge?.verifiedAtMs ?? null,
          ...(commercial.active ? [user.id] : []),
        ),
      )
      statements.push(...initialPlatformQuotaStatements(context.env, user.id, now))
      if (registrationChallenge !== null) statements.push(registrationChallenge.claimStatement)
      statements.push(...commercial.afterUserStatements)
      statements.push(
        sessionInsert(context.env, user, issued, requestUserAgent(context.req.raw)),
        authAuditInsert(
          context.env,
          user.id,
          'auth.register',
          'succeeded',
          emailHash,
          issued.sessionId,
          now,
        ),
      )
      await context.env.DB.batch(statements)
    } catch (error) {
      if (/UNIQUE constraint failed: (?:users\.(?:email|canonical_email_inbox)|index 'uq_users_canonical_email_inbox')/i.test(errorMessage(error))) {
        await recordAuthRateLimitFailure(context.env, rateLimitSubject)
        throw new GatewayError(409, 'email_already_registered', 'Email is already registered')
      }
      if (registrationChallengeModule?.isRegistrationEmailChallengeClaimFailure(error) === true) {
        throw new GatewayError(400, 'INVALID_VERIFY_CODE', 'Invalid or expired verification code')
      }
      const commercialError = mapCommercialRegistrationWriteError(error)
      if (commercialError !== null) throw commercialError
      throw error
    }
    return controlSuccess(authPayload(user, issued), 201)
  } catch (error) {
    return authControlError(normalizeAuthError(error))
  }
}

export async function loginWithPassword(context: Context<AuthBindings>): Promise<Response> {
  let email = ''
  try {
    const body = await readJsonObject(context.req.raw)
    email = requireEmail(body.email)
    const password = requirePassword(body.password)
    if (!isPasswordInputValid(password)) throw invalidCredentials()
    const rateLimitSubject = await checkAuthRateLimit(
      context.env,
      context.req.raw,
      email,
      'login',
    )
    const settings = await publicAuthSettings(context.env)
    await verifyTurnstile(context, settings, body.turnstile_token)
    await commitAuthRateLimitAttempt(context.env, rateLimitSubject)
    const user = await findUserByEmail(context.env, email)
    if (user === null || user.password_credential === null) {
      // Spend one password-derivation operation for missing identities so the
      // endpoint does not expose an obvious fast account-enumeration path.
      await hashPassword('invalid-password-placeholder')
      await recordAuthRateLimitFailure(context.env, rateLimitSubject)
      await recordAuthFailure(context.env, email, null, 'auth.login')
      throw invalidCredentials()
    }
    if (!(await verifyPassword(password, user.password_credential))) {
      await recordAuthRateLimitFailure(context.env, rateLimitSubject)
      await recordAuthFailure(context.env, email, user.id, 'auth.login')
      throw invalidCredentials()
    }
    if (user.status !== 'active') {
      throw new GatewayError(403, 'user_disabled', 'User account is disabled', 'permission_error')
    }

    await clearAuthAccountRateLimit(context.env, rateLimitSubject)
    const now = Date.now()
    const totpCredential = await findTotpCredential(context.env, user.id)
    if (totpCredential !== null) {
      if (!totpFeatureAvailable(context.env)) {
        throw new GatewayError(
          503,
          'TOTP_NOT_CONFIGURED',
          'TOTP encryption is not configured',
          'server_error',
        )
      }
      return controlSuccess({
        requires_2fa: true,
        temp_token: await createTotpLoginChallenge(context.env, user.id, now),
        user_email_masked: maskEmail(user.email),
      })
    }
    const issued = await issueSession(context.env, user, now)
    const emailHash = await sha256Hex(email)
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE users
            SET last_login_at_ms = ?, updated_at_ms = ?
          WHERE id = ?`,
      ).bind(now, now, user.id),
      sessionInsert(context.env, user, issued, requestUserAgent(context.req.raw)),
      authAuditInsert(
        context.env,
        user.id,
        'auth.login',
        'succeeded',
        emailHash,
        issued.sessionId,
        now,
      ),
    ])
    user.last_login_at_ms = now
    user.updated_at_ms = now
    return controlSuccess(authPayload(user, issued))
  } catch (error) {
    return authControlError(normalizeAuthError(error))
  }
}

/** Apply the same public captcha policy before a passwordless Passkey ceremony starts. */
export async function requirePublicAuthStartCaptcha(
  context: Context<AuthBindings>,
  next: Next,
): Promise<Response | void> {
  try {
    const request = context.req.raw
    await commitPublicAuthStartRateLimit(context.env, request)
    const body = request.body === null
      ? {}
      : await readJsonObject(request.clone() as unknown as Request)
    const settings = await publicAuthSettings(context.env)
    await verifyTurnstile(context, settings, body.turnstile_token)
    await next()
  } catch (error) {
    return authControlError(normalizeAuthError(error))
  }
}

/** Completes the password-login challenge and creates the first real session. */
export async function loginWithTotp(context: Context<AuthBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const tempToken = body.temp_token
    const code = body.totp_code
    const recoveryCode = body.recovery_code
    const useAuthenticatorCode = typeof code === 'string' && /^\d{6}$/.test(code) &&
      recoveryCode === undefined
    const useRecoveryCode = isTotpRecoveryCode(recoveryCode) && code === undefined
    if (!isTotpLoginToken(tempToken) || (!useAuthenticatorCode && !useRecoveryCode)) {
      throw invalidTotpLogin()
    }
    const tokenHash = await totpTokenDigest(tempToken)
    const rateLimitSubject = await checkAuthRateLimit(
      context.env,
      context.req.raw,
      `totp:${tokenHash}`,
      'login',
    )
    await commitAuthRateLimitAttempt(context.env, rateLimitSubject)
    const now = Date.now()
    const challenge = await findTotpLoginChallenge(context.env, tempToken)
    if (
      challenge === null || challenge.status !== 'pending' || challenge.expires_at_ms <= now
    ) {
      await recordAuthRateLimitFailure(context.env, rateLimitSubject)
      throw invalidTotpLogin()
    }
    if (challenge.verification_attempts >= TOTP_MAX_ATTEMPTS) {
      throw new GatewayError(429, 'TOTP_TOO_MANY_ATTEMPTS', 'Too many verification attempts')
    }
    const user = await findUserById(context.env, challenge.user_id)
    const credential = await findTotpCredential(context.env, challenge.user_id)
    if (user === null || user.status !== 'active' || credential === null) {
      await recordAuthRateLimitFailure(context.env, rateLimitSubject)
      throw invalidTotpLogin()
    }
    await claimTotpVerificationAttempt(context.env, user.id, now)
    const reservedAttempt = await context.env.DB.prepare(
      `UPDATE user_totp_login_challenges
          SET verification_attempts = verification_attempts + 1,
              version = version + 1, updated_at_ms = ?
        WHERE id = ? AND user_id = ? AND token_hash = ? AND status = 'pending'
          AND expires_at_ms > ? AND verification_attempts < ?
        RETURNING verification_attempts`,
    ).bind(
      now,
      challenge.id,
      challenge.user_id,
      tokenHash,
      now,
      TOTP_MAX_ATTEMPTS,
    ).all<{ verification_attempts: number }>()
    if (reservedAttempt.results.length !== 1) {
      throw new GatewayError(429, 'TOTP_TOO_MANY_ATTEMPTS', 'Too many verification attempts')
    }
    let recoveryHash: string | null = null
    let valid = false
    if (useRecoveryCode) {
      recoveryHash = await totpRecoveryCodeDigest(context.env, user.id, recoveryCode)
      valid = (await context.env.DB.prepare(
        `SELECT 1 AS available FROM user_totp_recovery_codes
          WHERE user_id = ? AND code_hash = ? AND consumed_at_ms IS NULL LIMIT 1`,
      ).bind(user.id, recoveryHash).first()) !== null
    } else {
      valid = await verifyStoredTotpCode(context.env, credential, code, now)
    }
    if (!valid) {
      await recordAuthRateLimitFailure(context.env, rateLimitSubject)
      throw new GatewayError(400, 'TOTP_INVALID_CODE', 'Invalid TOTP code')
    }

    const issued = await issueSession(context.env, user, now)
    const consumeNonce = crypto.randomUUID()
    const emailHash = await sha256Hex(user.email)
    const writes = await context.env.DB.batch([
      consumeTotpLoginChallengeStatement(
        context.env,
        challenge.id,
        user.id,
        tokenHash,
        consumeNonce,
        now,
        recoveryHash,
        user.auth_version,
      ),
      ...(recoveryHash === null ? [] : [context.env.DB.prepare(
        `UPDATE user_totp_recovery_codes
            SET consumed_at_ms = ?, consume_nonce = ?
          WHERE user_id = ? AND code_hash = ? AND consumed_at_ms IS NULL
            AND EXISTS (
              SELECT 1 FROM user_totp_login_challenges
               WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
            )
          RETURNING position`,
      ).bind(
        now, consumeNonce, user.id, recoveryHash,
        challenge.id, user.id, consumeNonce,
      )]),
      conditionalSessionInsert(
        context.env,
        user,
        issued,
        requestUserAgent(context.req.raw),
        challenge.id,
        consumeNonce,
        now,
        recoveryHash === null ? null : { codeHash: recoveryHash, consumeNonce },
      ),
      context.env.DB.prepare(
        `UPDATE users SET last_login_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'active' AND auth_version = ?
            AND EXISTS (
              SELECT 1 FROM user_totp_login_challenges
               WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
            )
          RETURNING id`,
      ).bind(now, now, user.id, user.auth_version, challenge.id, user.id, consumeNonce),
      context.env.DB.prepare(
        `INSERT INTO auth_audit_events (
           id, user_id, event_type, outcome, email_hash, ip_hash,
           session_id, metadata_json, occurred_at_ms
         )
         SELECT ?, ?, 'auth.login.2fa', 'succeeded', ?, NULL, ?, '{}', ?
           FROM user_totp_login_challenges
          WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
         RETURNING id`,
      ).bind(
        crypto.randomUUID(),
        user.id,
        emailHash,
        issued.sessionId,
        now,
        challenge.id,
        user.id,
        consumeNonce,
      ),
      context.env.DB.prepare(
        `DELETE FROM user_totp_verification_budgets
          WHERE user_id = ?
            AND EXISTS (
              SELECT 1 FROM user_totp_login_challenges
               WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
            )
          RETURNING user_id`,
      ).bind(user.id, challenge.id, user.id, consumeNonce),
    ])
    if (writes.some((result) => result.results.length !== 1)) throw invalidTotpLogin()
    await clearAuthAccountRateLimit(context.env, rateLimitSubject)
    user.last_login_at_ms = now
    user.updated_at_ms = now
    return controlSuccess(authPayload(user, issued))
  } catch (error) {
    return authControlError(normalizeAuthError(error))
  }
}

export async function refreshUserSession(context: Context<AuthBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const refreshToken = body.refresh_token
    if (!isOpaqueToken(refreshToken, 'refresh')) {
      throw new GatewayError(401, 'invalid_refresh_token', 'Invalid or expired refresh token', 'authentication_error')
    }
    const pepper = requireTokenPepper(context.env)
    const digest = await tokenDigest(refreshToken, pepper, 'refresh')
    const session = await context.env.DB.prepare(
      `${sessionUserSelect()}
        WHERE (s.refresh_token_hash = ? OR s.previous_refresh_token_hash = ?)
        LIMIT 1`,
    ).bind(digest, digest).first<SessionUserRow>()
    if (session === null) throw invalidRefreshToken()

    const now = Date.now()
    if (session.previous_refresh_token_hash === digest) {
      await revokeSessionFamily(context.env, session.family_id, now, 'refresh_token_reuse')
      throw new GatewayError(401, 'refresh_token_reused', 'Refresh token reuse was detected', 'authentication_error')
    }
    if (
      session.refresh_token_hash !== digest ||
      session.revoked_at_ms !== null ||
      session.refresh_expires_at_ms <= now ||
      session.status !== 'active' ||
      session.session_auth_version !== session.auth_version
    ) {
      throw invalidRefreshToken()
    }

    const accessToken = createOpaqueToken('access')
    const nextRefreshToken = createOpaqueToken('refresh')
    const [accessHash, refreshHash] = await Promise.all([
      tokenDigest(accessToken, pepper, 'access'),
      tokenDigest(nextRefreshToken, pepper, 'refresh'),
    ])
    const accessExpiresAtMs = now + ACCESS_TTL_MS
    const update = await context.env.DB.prepare(
      `UPDATE user_sessions
          SET access_token_hash = ?, refresh_token_hash = ?,
              previous_refresh_token_hash = ?, access_expires_at_ms = ?,
              rotated_at_ms = ?
        WHERE id = ? AND refresh_token_hash = ? AND revoked_at_ms IS NULL`,
    ).bind(
      accessHash,
      refreshHash,
      digest,
      accessExpiresAtMs,
      now,
      session.session_id,
      digest,
    ).run()
    if (resultChanges(update) !== 1) {
      await revokeSessionFamily(context.env, session.family_id, now, 'concurrent_refresh_reuse')
      throw new GatewayError(401, 'refresh_token_reused', 'Refresh token reuse was detected', 'authentication_error')
    }
    return controlSuccess({
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      expires_in: Math.floor(ACCESS_TTL_MS / 1_000),
      token_type: 'Bearer',
    })
  } catch (error) {
    return controlError(normalizeAuthError(error))
  }
}

export async function logoutUserSession(context: Context<AuthBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const refreshToken = body.refresh_token
    if (isOpaqueToken(refreshToken, 'refresh')) {
      const pepper = requireTokenPepper(context.env)
      const digest = await tokenDigest(refreshToken, pepper, 'refresh')
      const now = Date.now()
      await context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = ?, revoke_reason = ?
          WHERE revoked_at_ms IS NULL
            AND (refresh_token_hash = ? OR previous_refresh_token_hash = ?)`,
      ).bind(now, 'logout', digest, digest).run()
    }
    return controlSuccess({ message: 'Logged out' })
  } catch (error) {
    return controlError(normalizeAuthError(error))
  }
}

export async function currentUser(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const { projectOAuthIdentityBindings } = await import('./oauth-identities')
    return controlSuccess(await projectOAuthIdentityBindings(
      context.env,
      user,
      publicUser(user),
    ))
  } catch (error) {
    return controlError(normalizeAuthError(error))
  }
}

export async function authenticateUserRequest(request: Request, env: Env): Promise<SessionUserRow> {
  let accessToken: string
  try {
    accessToken = parseBearerToken(request.headers.get('authorization'))
  } catch {
    throw new GatewayError(401, 'invalid_access_token', 'Invalid or expired access token', 'authentication_error')
  }
  const digest = await tokenDigest(accessToken, requireTokenPepper(env), 'access')
  const session = await env.DB.prepare(
    `${sessionUserSelect()}
      WHERE s.access_token_hash = ?
        AND s.revoked_at_ms IS NULL AND s.access_expires_at_ms > ?
        AND s.auth_version = u.auth_version AND u.status = 'active'
      LIMIT 1`,
  ).bind(digest, Date.now()).first<SessionUserRow>()
  if (session === null) {
    throw new GatewayError(401, 'invalid_access_token', 'Invalid or expired access token', 'authentication_error')
  }
  return session
}

/**
 * Issue the same first-party session used by password and passkey login after an
 * external identity has already been verified. The conditional insert keeps a
 * concurrent disable/auth-version change from minting a usable session.
 */
export async function issueOAuthUserSession(
  env: Env,
  user: UserRow,
  userAgent: string,
): Promise<Record<string, unknown>> {
  const prepared = await prepareOAuthUserSession(env, user, userAgent)
  await env.DB.batch(prepared.statements)
  const persisted = await env.DB.prepare(
    'SELECT 1 AS present FROM user_sessions WHERE id = ? LIMIT 1',
  ).bind(prepared.sessionId).first<{ present: number }>()
  if (persisted === null) {
    throw new GatewayError(
      409,
      'concurrent_security_update',
      'Account security changed; restart sign-in',
      'authentication_error',
    )
  }
  return prepared.payload
}

export interface PreparedOAuthUserSession {
  /** Append after a new user INSERT, or execute together for an existing user. */
  statements: D1PreparedStatement[]
  payload: Record<string, unknown>
  sessionId: string
}

/** Prepare session writes so first-time OAuth user, identity and session can commit atomically. */
export async function prepareOAuthUserSession(
  env: Env,
  user: UserRow,
  userAgent: string,
): Promise<PreparedOAuthUserSession> {
  const now = Date.now()
  const issued = await issueSession(env, user, now)
  const boundedUserAgent = userAgent.slice(0, MAX_USER_AGENT_LENGTH)
  const emailHash = await sha256Hex(user.email)
  const session = env.DB.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version,
       access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms,
       previous_refresh_token_hash, rotated_at_ms, last_seen_at_ms,
       revoked_at_ms, revoke_reason, user_agent, ip_hash
     )
     SELECT ?, ?, id, auth_version, ?, ?, ?, ?, ?,
            NULL, NULL, NULL, NULL, NULL, ?, NULL
       FROM users
      WHERE id = ? AND status = 'active' AND auth_version = ?
     RETURNING id`,
  ).bind(
    issued.sessionId,
    issued.familyId,
    issued.accessHash,
    issued.refreshHash,
    now,
    issued.accessExpiresAtMs,
    issued.refreshExpiresAtMs,
    boundedUserAgent,
    user.id,
    user.auth_version,
  )
  const updateLogin = env.DB.prepare(
    `UPDATE users
        SET last_login_at_ms = ?, updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
      WHERE id = ? AND status = 'active' AND auth_version = ?
        AND EXISTS (SELECT 1 FROM user_sessions WHERE id = ?)`,
  ).bind(now, now, now, user.id, user.auth_version, issued.sessionId)
  const audit = env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     )
     SELECT ?, ?, 'auth.oauth.login', 'succeeded', ?, NULL, ?, '{}', ?
      WHERE EXISTS (SELECT 1 FROM user_sessions WHERE id = ?)`,
  ).bind(
    crypto.randomUUID(),
    user.id,
    emailHash,
    issued.sessionId,
    now,
    issued.sessionId,
  )
  return {
    statements: [session, updateLogin, audit],
    payload: authPayload({ ...user, last_login_at_ms: now }, issued),
    sessionId: issued.sessionId,
  }
}

function sessionUserSelect(): string {
  return `SELECT s.id AS session_id, s.family_id,
                 s.auth_version AS session_auth_version,
                 s.access_token_hash, s.refresh_token_hash,
                 s.previous_refresh_token_hash, s.access_expires_at_ms,
                 s.refresh_expires_at_ms, s.revoked_at_ms, s.step_up_expires_at_ms,
                 u.id, u.email, u.display_name, u.role, u.status,
                 u.balance_micros, u.concurrency, u.rpm_limit,
                 u.state_version, u.auth_version,
                 u.password_credential, u.email_verified_at_ms,
                 u.password_changed_at_ms, u.last_login_at_ms,
                 u.avatar_object_key, u.avatar_content_type, u.avatar_updated_at_ms,
                 u.created_at_ms, u.updated_at_ms
            FROM user_sessions s
            JOIN users u ON u.id = s.user_id`
}

async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
            state_version, auth_version, password_credential,
            email_verified_at_ms, password_changed_at_ms,
            last_login_at_ms, avatar_object_key, avatar_content_type, avatar_updated_at_ms,
            created_at_ms, updated_at_ms
       FROM users
      WHERE email = ?
      LIMIT 1`,
  ).bind(email).first<UserRow>()
}

async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
            state_version, auth_version, password_credential,
            email_verified_at_ms, password_changed_at_ms,
            last_login_at_ms, avatar_object_key, avatar_content_type, avatar_updated_at_ms,
            created_at_ms, updated_at_ms
       FROM users WHERE id = ? LIMIT 1`,
  ).bind(id).first<UserRow>()
}

async function issueSession(
  env: Env,
  user: UserRow,
  now: number,
): Promise<IssuedSession> {
  const pepper = requireTokenPepper(env)
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  const [accessHash, refreshHash] = await Promise.all([
    tokenDigest(accessToken, pepper, 'access'),
    tokenDigest(refreshToken, pepper, 'refresh'),
  ])
  return {
    sessionId: crypto.randomUUID(),
    familyId: crypto.randomUUID(),
    accessToken,
    refreshToken,
    accessHash,
    refreshHash,
    accessExpiresAtMs: now + ACCESS_TTL_MS,
    refreshExpiresAtMs: now + REFRESH_TTL_MS,
  }
}

function sessionInsert(
  env: Env,
  user: UserRow,
  issued: IssuedSession,
  userAgent: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version,
       access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms,
       previous_refresh_token_hash, rotated_at_ms, last_seen_at_ms,
       revoked_at_ms, revoke_reason, user_agent, ip_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
  ).bind(
    issued.sessionId,
    issued.familyId,
    user.id,
    user.auth_version,
    issued.accessHash,
    issued.refreshHash,
    issued.accessExpiresAtMs - ACCESS_TTL_MS,
    issued.accessExpiresAtMs,
    issued.refreshExpiresAtMs,
    userAgent,
  )
}

function conditionalSessionInsert(
  env: Env,
  user: UserRow,
  issued: IssuedSession,
  userAgent: string,
  challengeId: string,
  consumeNonce: string,
  now: number,
  recovery: { codeHash: string; consumeNonce: string } | null = null,
): D1PreparedStatement {
  const recoveryPredicate = recovery === null ? '' : `
        AND EXISTS (
          SELECT 1 FROM user_totp_recovery_codes
           WHERE user_id = ? AND code_hash = ? AND consume_nonce = ?
        )`
  return env.DB.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version,
       access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms,
       previous_refresh_token_hash, rotated_at_ms, last_seen_at_ms,
       revoked_at_ms, revoke_reason, user_agent, ip_hash, step_up_expires_at_ms
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL
       FROM user_totp_login_challenges
      WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
        AND EXISTS (
          SELECT 1 FROM users WHERE id = ? AND status = 'active' AND auth_version = ?
        )${recoveryPredicate}
     RETURNING id`,
  ).bind(
    issued.sessionId,
    issued.familyId,
    user.id,
    user.auth_version,
    issued.accessHash,
    issued.refreshHash,
    now,
    issued.accessExpiresAtMs,
    issued.refreshExpiresAtMs,
    userAgent,
    challengeId,
    user.id,
    consumeNonce,
    user.id,
    user.auth_version,
    ...(recovery === null ? [] : [user.id, recovery.codeHash, recovery.consumeNonce]),
  )
}

function consumeTotpLoginChallengeStatement(
  env: Env,
  challengeId: string,
  userId: string,
  tokenHash: string,
  consumeNonce: string,
  now: number,
  recoveryHash: string | null,
  authVersion: number,
): D1PreparedStatement {
  const recoveryPredicate = recoveryHash === null ? '' : `
            AND EXISTS (
              SELECT 1 FROM user_totp_recovery_codes
               WHERE user_id = ? AND code_hash = ? AND consumed_at_ms IS NULL
            )`
  return env.DB.prepare(
    `UPDATE user_totp_login_challenges
        SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?,
            version = version + 1, updated_at_ms = ?
      WHERE id = ? AND user_id = ? AND token_hash = ?
        AND status = 'pending' AND expires_at_ms > ?
        AND verification_attempts <= ?
        AND EXISTS (
          SELECT 1 FROM users WHERE id = ? AND status = 'active' AND auth_version = ?
        )${recoveryPredicate}
      RETURNING id`,
  ).bind(
    now,
    consumeNonce,
    now,
    challengeId,
    userId,
    tokenHash,
    now,
    TOTP_MAX_ATTEMPTS,
    userId,
    authVersion,
    ...(recoveryHash === null ? [] : [userId, recoveryHash]),
  )
}

function authAuditInsert(
  env: Env,
  userId: string | null,
  eventType: string,
  outcome: 'succeeded' | 'failed' | 'blocked',
  emailHash: string,
  sessionId: string | null,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', ?)`,
  ).bind(crypto.randomUUID(), userId, eventType, outcome, emailHash, sessionId, now)
}

async function recordAuthFailure(
  env: Env,
  email: string,
  userId: string | null,
  eventType: string,
): Promise<void> {
  try {
    const now = Date.now()
    await authAuditInsert(env, userId, eventType, 'failed', await sha256Hex(email), null, now).run()
  } catch (error) {
    console.error('failed to record auth audit event', {
      name: error instanceof Error ? error.name : 'unknown',
    })
  }
}

async function revokeSessionFamily(
  env: Env,
  familyId: string,
  now: number,
  reason: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_sessions
        SET revoked_at_ms = ?, revoke_reason = ?
      WHERE family_id = ? AND revoked_at_ms IS NULL`,
  ).bind(now, reason, familyId).run()
}

async function publicAuthSettings(env: Env): Promise<PublicAuthSettings> {
  try {
    return await env.CONFIG_KV.get<PublicAuthSettings>(
      `${env.ENVIRONMENT}:public-settings:v1`,
      'json',
    ) ?? {}
  } catch {
    throw new GatewayError(503, 'settings_unavailable', 'Authentication settings are unavailable', 'server_error')
  }
}

async function verifyTurnstile(
  context: Context<AuthBindings>,
  settings: PublicAuthSettings,
  token: unknown,
): Promise<void> {
  if (settings.turnstile_enabled !== true) return
  if (typeof token !== 'string' || token.trim() === '' || token.length > 2_048) {
    throw new GatewayError(400, 'captcha_required', 'Turnstile verification is required')
  }
  const secret = context.env.TURNSTILE_SECRET_KEY ??
    await readSystemSettingSecret(context.env, 'turnstile_secret_key')
  if (!secret) {
    throw new GatewayError(503, 'turnstile_not_configured', 'Turnstile is not configured', 'server_error')
  }
  const form = new URLSearchParams({ secret, response: token })
  const ip = context.req.header('cf-connecting-ip')
  if (ip) form.set('remoteip', ip)
  let response: Response
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
  } catch {
    throw new GatewayError(503, 'turnstile_unavailable', 'Turnstile verification is unavailable', 'server_error')
  }
  const result = await response.json().catch(() => null) as { success?: unknown } | null
  if (!response.ok || result?.success !== true) {
    throw new GatewayError(400, 'captcha_invalid', 'Turnstile verification failed')
  }
}

function authPayload(user: UserRow, issued: IssuedSession): Record<string, unknown> {
  return {
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    expires_in: Math.floor(ACCESS_TTL_MS / 1_000),
    token_type: 'Bearer',
    user: publicUser(user),
  }
}

export function publicUser(user: UserRow): Record<string, unknown> {
  const hasPassword = user.password_credential !== null
  return {
    id: user.id,
    username: user.display_name || user.email.slice(0, user.email.indexOf('@')),
    email: user.email,
    avatar_url: avatarUrl(user),
    role: user.role,
    balance: user.balance_micros / 1_000_000,
    concurrency: Number.isSafeInteger(user.concurrency) ? user.concurrency : 0,
    rpm_limit: Number.isSafeInteger(user.rpm_limit) ? user.rpm_limit : 0,
    status: user.status,
    allowed_groups: null,
    balance_notify_enabled: false,
    balance_notify_threshold: null,
    balance_notify_extra_emails: [],
    has_password: hasPassword,
    password_binding_required: !hasPassword,
    email_bound: hasPassword,
    auth_bindings: {
      email: { bound: hasPassword, verified_at: toIso(user.email_verified_at_ms) },
    },
    last_active_at: toIso(user.last_login_at_ms),
    created_at: new Date(user.created_at_ms).toISOString(),
    updated_at: new Date(user.updated_at_ms).toISOString(),
    run_mode: 'standard',
  }
}

function avatarUrl(user: Pick<UserRow, 'id' | 'avatar_object_key' | 'avatar_updated_at_ms'>): string | null {
  if (!user.avatar_object_key || !Number.isSafeInteger(user.avatar_updated_at_ms)) return null
  return `/api/v1/user/avatar/${encodeURIComponent(user.id)}?v=${user.avatar_updated_at_ms}`
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function requireEmail(value: unknown): string {
  if (typeof value !== 'string') throw new GatewayError(400, 'invalid_email', 'Email is invalid')
  const email = value.trim().toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GatewayError(400, 'invalid_email', 'Email is invalid')
  }
  return email
}

function requirePassword(value: unknown): string {
  if (typeof value !== 'string') throw new GatewayError(400, 'invalid_password', 'Password is invalid')
  return value
}

function requireTokenPepper(env: Env): string {
  if (!env.API_KEY_PEPPER || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < 32) {
    throw new GatewayError(503, 'auth_not_configured', 'Authentication is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function requestUserAgent(request: Request): string {
  return (request.headers.get('user-agent') ?? '').slice(0, MAX_USER_AGENT_LENGTH)
}

function invalidCredentials(): GatewayError {
  return new GatewayError(401, 'invalid_credentials', 'Invalid email or password', 'authentication_error')
}

function invalidRefreshToken(): GatewayError {
  return new GatewayError(401, 'invalid_refresh_token', 'Invalid or expired refresh token', 'authentication_error')
}

function invalidTotpLogin(): GatewayError {
  return new GatewayError(
    400,
    'TOTP_LOGIN_EXPIRED',
    'Invalid or expired 2FA session',
  )
}

function maskEmail(email: string): string {
  const separator = email.indexOf('@')
  if (separator < 1) return `${email.slice(0, 1)}***`
  const local = email.slice(0, separator)
  const domain = email.slice(separator)
  return local.length <= 2
    ? `${local.slice(0, 1)}***${domain}`
    : `${local.slice(0, 1)}***${local.slice(-1)}${domain}`
}

function resultChanges(result: D1Result<unknown>): number {
  const changes = (result.meta as D1Meta & { changes?: unknown }).changes
  return Number.isSafeInteger(changes) ? changes as number : 0
}

function normalizeAuthError(error: unknown): GatewayError {
  if (error instanceof PasswordValidationError) {
    return new GatewayError(400, error.code, error.message)
  }
  if (error instanceof TokenValidationError) {
    return new GatewayError(401, error.code, 'Invalid or expired token', 'authentication_error')
  }
  return asGatewayError(error)
}

function authControlError(error: GatewayError): Response {
  const response = controlError(error)
  if (error.retryAfter !== undefined) response.headers.set('retry-after', error.retryAfter)
  return response
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
