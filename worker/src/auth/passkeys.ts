import type { Context, Handler } from 'hono'
import { controlError, controlSuccess, readJsonObject, readOptionalJsonObject } from '../control/http'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateUserRequest, publicUser, type UserRow } from './handler'
import { verifyPassword } from './password'
import { createOpaqueToken, tokenDigest } from './tokens'
import {
  verifyAuthenticationCredential,
  verifyRegistrationCredential,
  WebAuthnVerificationError,
} from './webauthn'

type PasskeyBindings = { Bindings: Env }

const CEREMONY_TTL_MS = 5 * 60_000
const ACCESS_TTL_MS = 15 * 60_000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000
const SESSION_TOKEN_PREFIX = 'spk_v1_'
const SESSION_TOKEN_PATTERN = /^spk_v1_[A-Za-z0-9_-]{43}$/
const MAX_PASSKEY_NAME_CODE_POINTS = 100
const DEFAULT_PASSKEY_NAME = 'Passkey'
const MAX_PASSKEY_BODY_BYTES = 64 * 1024

export interface PasskeyConfiguration {
  enabled: boolean
  rpId: string
  rpOrigins: string[]
  rpDisplayName?: string
}

export type PasskeyConfigurationResolver = (
  env: Env,
) => PasskeyConfiguration | Promise<PasskeyConfiguration>

export interface PasskeyHandlers {
  beginLogin: Handler<PasskeyBindings>
  finishLogin: Handler<PasskeyBindings>
  beginRegistration: Handler<PasskeyBindings>
  finishRegistration: Handler<PasskeyBindings>
  list: Handler<PasskeyBindings>
  rename: Handler<PasskeyBindings>
  remove: Handler<PasskeyBindings>
}

interface ResolvedConfiguration {
  rpId: string
  rpOrigins: string[]
  rpDisplayName: string
}

interface ChallengeRow {
  id: string
  token_hash: string
  kind: 'registration' | 'login'
  user_id: string | null
  user_handle_b64: string | null
  registration_session_id: string | null
  registration_auth_version: number | null
  challenge_b64: string
  rp_id: string
  origins_json: string
  status: 'pending' | 'consumed'
  version: number
  expires_at_ms: number
}

interface CredentialRow {
  id: number
  user_id: string
  credential_id_b64: string
  name: string
  public_key_jwk: string
  algorithm: -7
  sign_count: number
  backup_eligible: 0 | 1
  backup_state: 0 | 1
  transports_json: string
  version: number
  last_used_at_ms: number | null
  created_at_ms: number
}

interface LoginCredentialRow extends UserRow {
  credential_record_id: number
  user_id: string
  credential_id_b64: string
  name: string
  public_key_jwk: string
  algorithm: -7
  sign_count: number
  backup_eligible: 0 | 1
  backup_state: 0 | 1
  transports_json: string
  version: number
  last_used_at_ms: number | null
  user_handle_b64: string
}

interface IssuedSession {
  id: string
  familyId: string
  accessToken: string
  refreshToken: string
  accessHash: string
  refreshHash: string
  accessExpiresAtMs: number
  refreshExpiresAtMs: number
}

interface RegistrationCeremonyOwner {
  userId: string
  userHandle: string
  sessionId: string
  authVersion: number
}

export function createPasskeyHandlers(
  resolveConfiguration: PasskeyConfigurationResolver,
): PasskeyHandlers {
  return {
    beginRegistration: (context) => beginRegistration(context, resolveConfiguration),
    finishRegistration: (context) => finishRegistration(context, resolveConfiguration),
    beginLogin: (context) => beginLogin(context, resolveConfiguration),
    finishLogin: (context) => finishLogin(context, resolveConfiguration),
    list: (context) => listCredentials(context),
    rename: (context) => renameCredential(context, resolveConfiguration),
    remove: (context) => removeCredential(context, resolveConfiguration),
  }
}

async function beginRegistration(
  context: Context<PasskeyBindings>,
  resolver: PasskeyConfigurationResolver,
): Promise<Response> {
  try {
    const configuration = await requireConfiguration(context.env, resolver)
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, MAX_PASSKEY_BODY_BYTES)
    await requireCurrentPassword(user, body.password)
    const userHandle = await ensureUserHandle(context.env, user.id)
    const existing = await context.env.DB.prepare(
      `SELECT credential_id_b64, transports_json FROM passkey_credentials
        WHERE user_id = ? ORDER BY id`,
    ).bind(user.id).all<{ credential_id_b64: string; transports_json: string }>()
    const ceremony = await createCeremony(
      context.env,
      'registration',
      configuration,
      {
        userId: user.id,
        userHandle,
        sessionId: user.session_id,
        authVersion: user.auth_version,
      },
    )
    return controlSuccess({
      session_token: ceremony.sessionToken,
      options: {
        publicKey: {
          challenge: ceremony.challenge,
          rp: { id: configuration.rpId, name: configuration.rpDisplayName },
          user: {
            id: userHandle,
            name: user.email,
            displayName: user.display_name || user.email,
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: CEREMONY_TTL_MS,
          attestation: 'none',
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
          excludeCredentials: existing.results.map((row) => ({
            type: 'public-key',
            id: row.credential_id_b64,
            transports: storedStringArray(row.transports_json),
          })),
          extensions: { credProps: true },
        },
      },
    })
  } catch (error) {
    return passkeyError(error)
  }
}

async function finishRegistration(
  context: Context<PasskeyBindings>,
  resolver: PasskeyConfigurationResolver,
): Promise<Response> {
  try {
    const configuration = await requireConfiguration(context.env, resolver)
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, MAX_PASSKEY_BODY_BYTES)
    const tokenHash = await sessionTokenDigest(body.session_token)
    const challenge = await findPendingChallenge(context.env, tokenHash, 'registration')
    if (
      challenge === null || challenge.user_id !== user.id || challenge.user_handle_b64 === null ||
      challenge.registration_session_id !== user.session_id ||
      challenge.registration_auth_version !== user.auth_version ||
      challenge.expires_at_ms <= Date.now() || !sameConfiguration(challenge, configuration)
    ) throw invalidPasskeySession()
    const now = Date.now()
    const consumeNonce = crypto.randomUUID()
    if (!(await consumeChallenge(
      context.env,
      challenge,
      tokenHash,
      consumeNonce,
      now,
      user.id,
    ))) throw invalidPasskeySession()
    const verified = await verifyRegistrationCredential(body.credential, {
      challenge: challenge.challenge_b64,
      rpId: challenge.rp_id,
      origins: parseOrigins(challenge.origins_json),
    })
    const persistenceNow = Date.now()
    let insert: D1Result<{ id: number }>
    try {
      insert = await context.env.DB.prepare(
          `INSERT INTO passkey_credentials (
             user_id, credential_id_b64, name, public_key_jwk, algorithm,
             sign_count, backup_eligible, backup_state, transports_json,
             created_at_ms, updated_at_ms
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM passkey_challenges
            WHERE id = ? AND user_id = ? AND status = 'consumed' AND consume_nonce = ?
              AND registration_session_id = ? AND registration_auth_version = ?
              AND EXISTS (
                SELECT 1 FROM passkey_user_handles
                 WHERE user_id = ? AND user_handle_b64 = ?
              )
              AND EXISTS (
                SELECT 1
                  FROM users u
                  JOIN user_sessions s ON s.user_id = u.id
                 WHERE u.id = ? AND u.status = 'active' AND u.auth_version = ?
                   AND s.id = ? AND s.auth_version = ? AND s.revoked_at_ms IS NULL
                   AND s.access_expires_at_ms > ?
              )
           RETURNING id`,
        ).bind(
          user.id,
          verified.credentialId,
          normalizeName(body.name),
          JSON.stringify(verified.publicKeyJwk),
          verified.algorithm,
          verified.signCount,
          verified.backupEligible ? 1 : 0,
          verified.backupState ? 1 : 0,
          JSON.stringify(verified.transports),
          now,
          now,
          challenge.id,
          user.id,
          consumeNonce,
          user.session_id,
          user.auth_version,
          user.id,
          challenge.user_handle_b64,
          user.id,
          user.auth_version,
          user.session_id,
          user.auth_version,
          persistenceNow,
        ).all<{ id: number }>()
    } catch (error) {
      if (/\bUNIQUE constraint failed:\s*(?:main\.)?passkey_credentials\.credential_id_b64\b/i.test(errorMessage(error))) {
        throw new GatewayError(409, 'PASSKEY_ALREADY_EXISTS', 'This passkey is already registered')
      }
      throw error
    }
    if (insert.results.length !== 1) throw invalidPasskeySession()
    const created = await context.env.DB.prepare(
      `SELECT id, user_id, credential_id_b64, name, public_key_jwk, algorithm,
              sign_count, backup_eligible, backup_state, transports_json, version,
              last_used_at_ms, created_at_ms
         FROM passkey_credentials WHERE credential_id_b64 = ? LIMIT 1`,
    ).bind(verified.credentialId).first<CredentialRow>()
    if (created === null) throw new Error('Created passkey was not found')
    return controlSuccess(publicCredential(created))
  } catch (error) {
    return passkeyError(error)
  }
}

async function beginLogin(
  context: Context<PasskeyBindings>,
  resolver: PasskeyConfigurationResolver,
): Promise<Response> {
  try {
    const configuration = await requireConfiguration(context.env, resolver)
    // The body is intentionally accepted for compatibility with action-captcha
    // proof fields; the integrating app performs that policy check.
    await readJsonObjectOrEmpty(context.req.raw)
    const ceremony = await createCeremony(context.env, 'login', configuration, null)
    return controlSuccess({
      session_token: ceremony.sessionToken,
      options: {
        publicKey: {
          challenge: ceremony.challenge,
          rpId: configuration.rpId,
          timeout: CEREMONY_TTL_MS,
          userVerification: 'required',
          allowCredentials: [],
        },
      },
    })
  } catch (error) {
    return passkeyError(error)
  }
}

async function finishLogin(
  context: Context<PasskeyBindings>,
  resolver: PasskeyConfigurationResolver,
): Promise<Response> {
  try {
    const configuration = await requireConfiguration(context.env, resolver)
    const body = await readJsonObject(context.req.raw, MAX_PASSKEY_BODY_BYTES)
    const tokenHash = await sessionTokenDigest(body.session_token)
    const challenge = await findPendingChallenge(context.env, tokenHash, 'login')
    if (
      challenge === null || challenge.expires_at_ms <= Date.now() ||
      !sameConfiguration(challenge, configuration)
    ) throw invalidPasskeySession()
    const now = Date.now()
    const consumeNonce = crypto.randomUUID()
    if (!(await consumeChallenge(
      context.env,
      challenge,
      tokenHash,
      consumeNonce,
      now,
      null,
    ))) throw invalidPasskeySession()
    const credentialId = credentialIdentifier(body.credential)
    const credential = await findLoginCredential(context.env, credentialId)
    if (credential === null || credential.status !== 'active') throw passkeyVerificationFailed()
    const publicKeyJwk = parsePublicKey(credential.public_key_jwk)
    const verified = await verifyAuthenticationCredential(body.credential, {
      challenge: challenge.challenge_b64,
      rpId: challenge.rp_id,
      origins: parseOrigins(challenge.origins_json),
      credentialId: credential.credential_id_b64,
      userHandle: credential.user_handle_b64,
      publicKeyJwk,
      algorithm: credential.algorithm,
    })
    if (
      credential.backup_eligible !== (verified.backupEligible ? 1 : 0) ||
      ((credential.sign_count !== 0 || verified.signCount !== 0) &&
        verified.signCount <= credential.sign_count)
    ) throw passkeyVerificationFailed()

    const issued = await issueSession(context.env, now)
    const emailHash = await sha256Hex(credential.email)
    const writes = await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE passkey_credentials
            SET sign_count = ?, backup_state = ?, version = version + 1,
                use_nonce = ?, last_used_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND user_id = ? AND credential_id_b64 = ?
            AND version = ? AND sign_count = ?
            AND EXISTS (
              SELECT 1 FROM passkey_challenges
               WHERE id = ? AND kind = 'login' AND status = 'consumed' AND consume_nonce = ?
            )
            AND EXISTS (
              SELECT 1 FROM users WHERE id = ? AND status = 'active' AND auth_version = ?
            )
          RETURNING id`,
      ).bind(
        verified.signCount,
        verified.backupState ? 1 : 0,
        consumeNonce,
        now,
        now,
        credential.credential_record_id,
        credential.user_id,
        credential.credential_id_b64,
        credential.version,
        credential.sign_count,
        challenge.id,
        consumeNonce,
        credential.user_id,
        credential.auth_version,
      ),
      conditionalPasskeySessionInsert(
        context.env,
        credential,
        issued,
        challenge.id,
        consumeNonce,
        requestUserAgent(context.req.raw),
        now,
      ),
      context.env.DB.prepare(
        `UPDATE users SET last_login_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'active' AND auth_version = ?
            AND EXISTS (
              SELECT 1 FROM user_sessions WHERE id = ? AND user_id = ?
            )
          RETURNING id`,
      ).bind(
        now, now, credential.user_id, credential.auth_version,
        issued.id, credential.user_id,
      ),
      context.env.DB.prepare(
        `INSERT INTO auth_audit_events (
           id, user_id, event_type, outcome, email_hash, ip_hash,
           session_id, metadata_json, occurred_at_ms
         )
         SELECT ?, ?, 'auth.login.passkey', 'succeeded', ?, NULL, ?, '{}', ?
          WHERE EXISTS (
            SELECT 1 FROM user_sessions WHERE id = ? AND user_id = ?
          )
         RETURNING id`,
      ).bind(
        crypto.randomUUID(), credential.user_id, emailHash, issued.id, now,
        issued.id, credential.user_id,
      ),
    ])
    if (writes.some((write) => write.results.length !== 1)) {
      throw passkeyVerificationFailed()
    }
    credential.last_login_at_ms = now
    credential.updated_at_ms = now
    return controlSuccess({
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_in: Math.floor(ACCESS_TTL_MS / 1_000),
      token_type: 'Bearer',
      user: publicUser(credential),
    })
  } catch (error) {
    return passkeyError(error)
  }
}

async function listCredentials(context: Context<PasskeyBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const rows = await context.env.DB.prepare(
      `SELECT id, user_id, credential_id_b64, name, public_key_jwk, algorithm,
              sign_count, backup_eligible, backup_state, transports_json, version,
              last_used_at_ms, created_at_ms
         FROM passkey_credentials WHERE user_id = ?
        ORDER BY created_at_ms DESC, id DESC`,
    ).bind(user.id).all<CredentialRow>()
    return controlSuccess(rows.results.map(publicCredential))
  } catch (error) {
    return passkeyError(error)
  }
}

async function renameCredential(
  context: Context<PasskeyBindings>,
  resolver: PasskeyConfigurationResolver,
): Promise<Response> {
  try {
    await requireConfiguration(context.env, resolver)
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const id = credentialRecordId(context.req.param('id'))
    const body = await readJsonObject(context.req.raw, MAX_PASSKEY_BODY_BYTES)
    const name = normalizeName(body.name, true)
    const result = await context.env.DB.prepare(
      `UPDATE passkey_credentials SET name = ?, version = version + 1, updated_at_ms = ?
        WHERE id = ? AND user_id = ? RETURNING id`,
    ).bind(name, Date.now(), id, user.id).all<{ id: number }>()
    if (result.results.length !== 1) throw passkeyNotFound()
    return controlSuccess({ success: true })
  } catch (error) {
    return passkeyError(error)
  }
}

async function removeCredential(
  context: Context<PasskeyBindings>,
  resolver: PasskeyConfigurationResolver,
): Promise<Response> {
  try {
    await requireConfiguration(context.env, resolver)
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const id = credentialRecordId(context.req.param('id'))
    const body = await readJsonObject(context.req.raw, MAX_PASSKEY_BODY_BYTES)
    await requireCurrentPassword(user, body.password)
    const result = await context.env.DB.prepare(
      `DELETE FROM passkey_credentials WHERE id = ? AND user_id = ? RETURNING id`,
    ).bind(id, user.id).all<{ id: number }>()
    if (result.results.length !== 1) throw passkeyNotFound()
    return controlSuccess({ success: true })
  } catch (error) {
    return passkeyError(error)
  }
}

async function requireConfiguration(
  env: Env,
  resolver: PasskeyConfigurationResolver,
): Promise<ResolvedConfiguration> {
  let source: PasskeyConfiguration
  try {
    source = await resolver(env)
  } catch {
    throw new GatewayError(503, 'PASSKEY_CONFIGURATION_UNAVAILABLE', 'Passkey configuration is unavailable', 'server_error')
  }
  if (source?.enabled !== true) {
    throw new GatewayError(403, 'PASSKEY_DISABLED', 'Passkey authentication is not enabled', 'permission_error')
  }
  const rpId = typeof source.rpId === 'string' ? source.rpId.trim().toLowerCase() : ''
  const displayName = typeof source.rpDisplayName === 'string' ? source.rpDisplayName.trim() : ''
  if (
    rpId.length < 1 || rpId.length > 253 || rpId.includes('://') ||
    rpId.includes('/') || rpId.includes(':') || /\s/.test(rpId) ||
    !Array.isArray(source.rpOrigins) || source.rpOrigins.length === 0 ||
    source.rpOrigins.length > 16
  ) throw passkeyNotConfigured()
  const origins: string[] = []
  for (const candidate of source.rpOrigins) {
    if (typeof candidate !== 'string' || candidate.length > 512) throw passkeyNotConfigured()
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      throw passkeyNotConfigured()
    }
    if (
      url.origin !== candidate || url.username !== '' || url.password !== '' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) ||
      (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`))
    ) throw passkeyNotConfigured()
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  return { rpId, rpOrigins: origins, rpDisplayName: displayName || 'Sub2API' }
}

async function ensureUserHandle(env: Env, userId: string): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT user_handle_b64 FROM passkey_user_handles WHERE user_id = ? LIMIT 1`,
  ).bind(userId).first<{ user_handle_b64: string }>()
  if (existing !== null) return existing.user_handle_b64
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = randomBase64Url(32)
    try {
      await env.DB.prepare(
        `INSERT INTO passkey_user_handles (user_id, user_handle_b64, created_at_ms)
         VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
      ).bind(userId, candidate, Date.now()).run()
    } catch (error) {
      if (!/\bUNIQUE constraint failed:\s*(?:main\.)?passkey_user_handles\.user_handle_b64\b/i.test(errorMessage(error))) {
        throw error
      }
      continue
    }
    const row = await env.DB.prepare(
      `SELECT user_handle_b64 FROM passkey_user_handles WHERE user_id = ? LIMIT 1`,
    ).bind(userId).first<{ user_handle_b64: string }>()
    if (row !== null) return row.user_handle_b64
  }
  throw new GatewayError(503, 'PASSKEY_CONFIGURATION_UNAVAILABLE', 'Passkey user state is unavailable', 'server_error')
}

async function createCeremony(
  env: Env,
  kind: 'registration' | 'login',
  configuration: ResolvedConfiguration,
  owner: RegistrationCeremonyOwner | null,
): Promise<{ sessionToken: string; challenge: string }> {
  const now = Date.now()
  const sessionToken = `${SESSION_TOKEN_PREFIX}${randomBase64Url(32)}`
  const challenge = randomBase64Url(32)
  await env.DB.prepare(
    `DELETE FROM passkey_challenges WHERE expires_at_ms <= ?`,
  ).bind(now).run()
  await env.DB.prepare(
    `INSERT INTO passkey_challenges (
       id, token_hash, kind, user_id, user_handle_b64,
       registration_session_id, registration_auth_version, challenge_b64,
       rp_id, origins_json, expires_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    await sha256Hex(sessionToken),
    kind,
    owner?.userId ?? null,
    owner?.userHandle ?? null,
    owner?.sessionId ?? null,
    owner?.authVersion ?? null,
    challenge,
    configuration.rpId,
    JSON.stringify(configuration.rpOrigins),
    now + CEREMONY_TTL_MS,
    now,
    now,
  ).run()
  return { sessionToken, challenge }
}

async function findPendingChallenge(
  env: Env,
  tokenHash: string,
  kind: 'registration' | 'login',
): Promise<ChallengeRow | null> {
  return env.DB.prepare(
    `SELECT id, token_hash, kind, user_id, user_handle_b64,
            registration_session_id, registration_auth_version, challenge_b64,
            rp_id, origins_json, status, version, expires_at_ms
       FROM passkey_challenges
      WHERE token_hash = ? AND kind = ? AND status = 'pending' LIMIT 1`,
  ).bind(tokenHash, kind).first<ChallengeRow>()
}

async function consumeChallenge(
  env: Env,
  challenge: ChallengeRow,
  tokenHash: string,
  consumeNonce: string,
  now: number,
  userId: string | null,
): Promise<boolean> {
  const ownerClause = userId === null ? 'user_id IS NULL' : 'user_id = ?'
  const result = await env.DB.prepare(
    `UPDATE passkey_challenges
        SET status = 'consumed', consumed_at_ms = ?, consume_nonce = ?,
            version = version + 1, updated_at_ms = ?
      WHERE id = ? AND token_hash = ? AND kind = ? AND ${ownerClause}
        AND status = 'pending' AND version = ? AND expires_at_ms > ?
      RETURNING id`,
  ).bind(
    now, consumeNonce, now, challenge.id, tokenHash, challenge.kind,
    ...(userId === null ? [] : [userId]),
    challenge.version, now,
  ).all<{ id: string }>()
  return result.results.length === 1
}

async function findLoginCredential(env: Env, credentialId: string): Promise<LoginCredentialRow | null> {
  return env.DB.prepare(
    `SELECT c.id AS credential_record_id, c.user_id,
            c.credential_id_b64, c.name, c.public_key_jwk,
            c.algorithm, c.sign_count, c.backup_eligible, c.backup_state,
            c.transports_json, c.version, c.last_used_at_ms,
            h.user_handle_b64,
            u.id, u.email, u.display_name, u.role, u.status,
            u.balance_micros, u.concurrency, u.rpm_limit, u.state_version,
            u.auth_version, u.password_credential, u.email_verified_at_ms,
            u.password_changed_at_ms, u.last_login_at_ms,
            u.avatar_object_key, u.avatar_content_type, u.avatar_updated_at_ms,
            u.created_at_ms, u.updated_at_ms
       FROM passkey_credentials c
       JOIN passkey_user_handles h ON h.user_id = c.user_id
       JOIN users u ON u.id = c.user_id
      WHERE c.credential_id_b64 = ? LIMIT 1`,
  ).bind(credentialId).first<LoginCredentialRow>()
}

async function issueSession(env: Env, now: number): Promise<IssuedSession> {
  const pepper = env.API_KEY_PEPPER
  if (typeof pepper !== 'string') {
    throw new GatewayError(503, 'auth_not_configured', 'Authentication is not configured', 'server_error')
  }
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  let accessHash: string
  let refreshHash: string
  try {
    [accessHash, refreshHash] = await Promise.all([
      tokenDigest(accessToken, pepper, 'access'),
      tokenDigest(refreshToken, pepper, 'refresh'),
    ])
  } catch {
    throw new GatewayError(503, 'auth_not_configured', 'Authentication is not configured', 'server_error')
  }
  return {
    id: crypto.randomUUID(),
    familyId: crypto.randomUUID(),
    accessToken,
    refreshToken,
    accessHash,
    refreshHash,
    accessExpiresAtMs: now + ACCESS_TTL_MS,
    refreshExpiresAtMs: now + REFRESH_TTL_MS,
  }
}

function conditionalPasskeySessionInsert(
  env: Env,
  user: LoginCredentialRow,
  issued: IssuedSession,
  challengeId: string,
  consumeNonce: string,
  userAgent: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version,
       access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms,
       previous_refresh_token_hash, rotated_at_ms, last_seen_at_ms,
       revoked_at_ms, revoke_reason, user_agent, ip_hash, step_up_expires_at_ms
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL
      WHERE EXISTS (
        SELECT 1 FROM passkey_challenges
         WHERE id = ? AND kind = 'login' AND status = 'consumed' AND consume_nonce = ?
      )
        AND EXISTS (
          SELECT 1 FROM passkey_credentials
           WHERE id = ? AND user_id = ? AND use_nonce = ?
        )
        AND EXISTS (
          SELECT 1 FROM users WHERE id = ? AND status = 'active' AND auth_version = ?
        )
     RETURNING id`,
  ).bind(
    issued.id,
    issued.familyId,
    user.user_id,
    user.auth_version,
    issued.accessHash,
    issued.refreshHash,
    now,
    issued.accessExpiresAtMs,
    issued.refreshExpiresAtMs,
    userAgent,
    challengeId,
    consumeNonce,
    user.credential_record_id,
    user.user_id,
    consumeNonce,
    user.user_id,
    user.auth_version,
  )
}

async function requireCurrentPassword(user: UserRow, candidate: unknown): Promise<void> {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new GatewayError(400, 'PASSWORD_REQUIRED', 'Current password is required')
  }
  if (
    typeof user.password_credential !== 'string' ||
    !(await verifyPassword(candidate, user.password_credential))
  ) throw new GatewayError(400, 'PASSWORD_INCORRECT', 'Current password is incorrect')
}

function normalizeName(value: unknown, required = false): string {
  if (value !== undefined && typeof value !== 'string') {
    throw new GatewayError(400, 'INVALID_PASSKEY_NAME', 'Passkey name is invalid')
  }
  let name = typeof value === 'string' ? value.trim() : ''
  if (required && name === '') {
    throw new GatewayError(400, 'INVALID_PASSKEY_NAME', 'Passkey name is required')
  }
  if (name === '') name = DEFAULT_PASSKEY_NAME
  return Array.from(name).slice(0, MAX_PASSKEY_NAME_CODE_POINTS).join('')
}

function credentialRecordId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new GatewayError(400, 'INVALID_PASSKEY_ID', 'Passkey ID is invalid')
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id)) {
    throw new GatewayError(400, 'INVALID_PASSKEY_ID', 'Passkey ID is invalid')
  }
  return id
}

function credentialIdentifier(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw passkeyVerificationFailed()
  }
  const credential = value as Record<string, unknown>
  if (
    typeof credential.rawId !== 'string' || credential.rawId.length > 1_366 ||
    !/^[A-Za-z0-9_-]+$/.test(credential.rawId)
  ) throw passkeyVerificationFailed()
  return credential.rawId
}

function publicCredential(row: CredentialRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    created_at: new Date(row.created_at_ms).toISOString(),
    ...(row.last_used_at_ms === null
      ? {}
      : { last_used_at: new Date(row.last_used_at_ms).toISOString() }),
    backup: row.backup_state === 1,
  }
}

function parsePublicKey(value: string): JsonWebKey {
  try {
    const parsed = JSON.parse(value) as JsonWebKey
    if (
      parsed.kty !== 'EC' || parsed.crv !== 'P-256' ||
      typeof parsed.x !== 'string' || typeof parsed.y !== 'string'
    ) throw new Error('invalid key')
    return parsed
  } catch {
    throw passkeyVerificationFailed()
  }
}

function parseOrigins(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.some((origin) => typeof origin !== 'string')) {
      throw new Error('invalid origins')
    }
    return parsed
  } catch {
    throw invalidPasskeySession()
  }
}

function sameConfiguration(
  challenge: ChallengeRow,
  configuration: ResolvedConfiguration,
): boolean {
  if (challenge.rp_id !== configuration.rpId) return false
  const origins = parseOrigins(challenge.origins_json)
  return origins.length === configuration.rpOrigins.length &&
    origins.every((origin) => configuration.rpOrigins.includes(origin))
}

function storedStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
  } catch {
    return []
  }
}

async function sessionTokenDigest(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !SESSION_TOKEN_PATTERN.test(value)) {
    throw invalidPasskeySession()
  }
  return sha256Hex(value)
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function readJsonObjectOrEmpty(request: Request): Promise<Record<string, unknown>> {
  return readOptionalJsonObject(request, MAX_PASSKEY_BODY_BYTES)
}

function requestUserAgent(request: Request): string {
  const value = request.headers.get('user-agent') ?? ''
  return Array.from(value).slice(0, 512).join('')
}

function invalidPasskeySession(): GatewayError {
  return new GatewayError(400, 'PASSKEY_SESSION_INVALID', 'Passkey session is invalid or expired')
}

function passkeyVerificationFailed(): GatewayError {
  return new GatewayError(401, 'PASSKEY_VERIFICATION_FAILED', 'Passkey verification failed', 'authentication_error')
}

function passkeyNotFound(): GatewayError {
  return new GatewayError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found')
}

function passkeyNotConfigured(): GatewayError {
  return new GatewayError(503, 'PASSKEY_NOT_CONFIGURED', 'Passkey relying-party configuration is invalid', 'server_error')
}

function passkeyError(error: unknown): Response {
  const normalized = error instanceof WebAuthnVerificationError
    ? passkeyVerificationFailed()
    : asGatewayError(error)
  return controlError(normalized)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
