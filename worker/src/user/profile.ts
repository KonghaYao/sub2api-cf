import type { Context } from 'hono'
import { controlError, controlSuccess, readJsonObject, requireResourceId } from '../control/http'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateUserRequest, publicUser, type UserRow } from '../auth/handler'
import { projectOAuthIdentityBindings } from '../auth/oauth-identities'
import { hashPassword, PasswordValidationError, validateNewPassword, verifyPassword } from '../auth/password'
import {
  prepareUserNotificationPreferencesUpdate,
  projectUserNotificationPreferences,
} from './notification-preferences'

type UserBindings = { Bindings: Env }

const MAX_AVATAR_BYTES = 32 * 1024
const MAX_AVATAR_DATA_URL_CHARS = 48 * 1024
const PROFILE_FIELDS = new Set(['username', 'display_name', 'avatar_url'])
const NOTIFICATION_FIELDS = new Set([
  'balance_notify_enabled',
  'balance_notify_threshold',
  'expected_version',
  'notification_preferences_version',
])

type AvatarAction =
  | { type: 'unchanged' }
  | { type: 'delete' }
  | { type: 'upload'; contentType: AvatarContentType; bytes: Uint8Array }

type AvatarContentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export async function getUserProfile(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const profile = await projectUserNotificationPreferences(
      context.env,
      user.id,
      publicUser(user),
    )
    return controlSuccess(await projectOAuthIdentityBindings(context.env, user, profile))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Atomically updates legacy profile fields and Worker-native notification preferences. */
export async function updateCurrentUser(context: Context<UserBindings>): Promise<Response> {
  let uploadedObjectKey: string | null = null
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    rejectUnsupportedUserFields(body)
    const fields = Object.keys(body)
    const hasProfileField = fields.some((field) => PROFILE_FIELDS.has(field))
    const hasNotificationField = fields.some((field) => NOTIFICATION_FIELDS.has(field))
    const displayName = parseDisplayName(body, user.display_name)
    const avatar = parseAvatarAction(body)
    const profileChanged = displayName !== user.display_name || avatar.type !== 'unchanged'
    if (!hasProfileField && !hasNotificationField) {
      throw new GatewayError(400, 'empty_profile_update', 'At least one profile field is required')
    }

    const now = Date.now()
    const notificationUpdate = hasNotificationField
      ? await prepareUserNotificationPreferencesUpdate(
        context.env,
        user.id,
        context.req.raw,
        body,
        now,
      )
      : null
    if (!hasNotificationField && !profileChanged) {
      throw new GatewayError(400, 'empty_profile_update', 'At least one profile field is required')
    }

    let avatarObjectKey = user.avatar_object_key
    let avatarContentType = user.avatar_content_type
    let avatarUpdatedAt = user.avatar_updated_at_ms
    if (avatar.type === 'upload') {
      uploadedObjectKey = avatarKey(user.id, avatar.contentType)
      await context.env.OBJECTS.put(uploadedObjectKey, avatar.bytes, {
        httpMetadata: { contentType: avatar.contentType },
      })
      avatarObjectKey = uploadedObjectKey
      avatarContentType = avatar.contentType
      avatarUpdatedAt = Math.max(now, (user.avatar_updated_at_ms ?? 0) + 1)
    } else if (avatar.type === 'delete') {
      avatarObjectKey = null
      avatarContentType = null
      avatarUpdatedAt = null
    }

    const statements: D1PreparedStatement[] = []
    if (profileChanged) {
      statements.push(context.env.DB.prepare(
        `UPDATE users
            SET display_name = ?, avatar_object_key = ?, avatar_content_type = ?, avatar_updated_at_ms = ?, updated_at_ms = ?
          WHERE id = ?`,
      ).bind(displayName, avatarObjectKey, avatarContentType, avatarUpdatedAt, now, user.id))
      statements.push(await profileAuditInsert(context.env, user, 'profile.update', {
        display_name_changed: displayName !== user.display_name,
        avatar_changed: avatar.type !== 'unchanged',
      }, now))
    }
    if (notificationUpdate?.statement) {
      statements.push(notificationUpdate.statement)
    }
    if (statements.length > 0) await context.env.DB.batch(statements)

    const next = profileChanged ? {
      ...user,
      display_name: displayName,
      avatar_object_key: avatarObjectKey,
      avatar_content_type: avatarContentType,
      avatar_updated_at_ms: avatarUpdatedAt,
      updated_at_ms: now,
    } : user
    if (profileChanged && user.avatar_object_key !== null && user.avatar_object_key !== avatarObjectKey) {
      await deleteAvatarObject(context.env, user.avatar_object_key)
    }
    const profile = await projectUserNotificationPreferences(
      context.env,
      next.id,
      publicUser(next),
    )
    return controlSuccess(await projectOAuthIdentityBindings(context.env, next, profile))
  } catch (error) {
    if (uploadedObjectKey !== null) await deleteAvatarObject(context.env, uploadedObjectKey)
    return controlError(normalizeProfileError(error))
  }
}

export async function changeUserPassword(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const oldPassword = requirePasswordField(body, 'old_password')
    const newPassword = requirePasswordField(body, 'new_password')
    validateNewPassword(newPassword)
    if (user.password_credential === null) {
      throw new GatewayError(409, 'password_not_set', 'A password is not configured for this account')
    }
    if (!(await verifyPassword(oldPassword, user.password_credential))) {
      await recordPasswordAudit(context.env, user, 'failed', { reason: 'invalid_current_password' })
      throw new GatewayError(401, 'invalid_current_password', 'Current password is incorrect', 'authentication_error')
    }
    if (newPassword === oldPassword) {
      throw new GatewayError(400, 'password_unchanged', 'New password must differ from current password')
    }

    const credential = await hashPassword(newPassword)
    const now = Date.now()
    const nextVersion = user.auth_version + 1
    if (!Number.isSafeInteger(nextVersion)) {
      throw new GatewayError(409, 'auth_version_exhausted', 'Session security version is exhausted')
    }
    // The CASE deliberately violates the CHECK constraint if a concurrent
    // password/session mutation advanced auth_version after authentication.
    // D1 batch rolls the user, session, and audit writes back together.
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE users
            SET password_credential = ?, password_changed_at_ms = ?, updated_at_ms = ?,
                auth_version = CASE WHEN auth_version = ? THEN ? ELSE 0 END
          WHERE id = ?`,
      ).bind(credential, now, now, user.auth_version, nextVersion, user.id),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET auth_version = ?
          WHERE user_id = ? AND family_id = ? AND revoked_at_ms IS NULL`,
      ).bind(nextVersion, user.id, user.family_id),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = ?, revoke_reason = ?
          WHERE user_id = ? AND family_id <> ? AND revoked_at_ms IS NULL`,
      ).bind(now, 'password_changed', user.id, user.family_id),
      await profileAuditInsert(context.env, user, 'auth.password.change', {
        retained_family_id: user.family_id,
        retained_session_id: user.session_id,
      }, now),
    ])
    return controlSuccess({ message: 'Password changed successfully' })
  } catch (error) {
    return controlError(normalizeProfileError(error))
  }
}

/** Stable, versioned public avatar URL. Avatar data itself is always served from R2. */
export async function getUserAvatar(context: Context<UserBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const row = await context.env.DB.prepare(
      `SELECT avatar_object_key, avatar_content_type, avatar_updated_at_ms FROM users WHERE id = ?`,
    ).bind(userId).first<{
      avatar_object_key: string | null
      avatar_content_type: AvatarContentType | null
      avatar_updated_at_ms: number | null
    }>()
    const version = context.req.query('v')
    if (
      row === null || row.avatar_object_key === null || row.avatar_content_type === null ||
      !Number.isSafeInteger(row.avatar_updated_at_ms) || version !== String(row.avatar_updated_at_ms)
    ) {
      throw new GatewayError(404, 'avatar_not_found', 'Avatar was not found')
    }
    const object = await context.env.OBJECTS.get(row.avatar_object_key)
    if (object === null) throw new GatewayError(404, 'avatar_not_found', 'Avatar was not found')
    return new Response(object.body, {
      headers: {
        'content-type': row.avatar_content_type,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    return controlError(normalizeProfileError(error))
  }
}

function parseDisplayName(body: Record<string, unknown>, fallback: string): string {
  const username = parseOptionalDisplayName(body, 'username')
  const displayName = parseOptionalDisplayName(body, 'display_name')
  if (username !== undefined && displayName !== undefined && username !== displayName) {
    throw new GatewayError(400, 'display_name_mismatch', 'username and display_name disagree')
  }
  return username ?? displayName ?? fallback
}

function parseOptionalDisplayName(body: Record<string, unknown>, field: 'username' | 'display_name'): string | undefined {
  if (body[field] === undefined) return undefined
  if (typeof body[field] !== 'string') throw new GatewayError(400, `invalid_${field}`, `${field} must be a string`)
  const value = body[field].trim()
  if (value.length === 0 || Array.from(value).length > 128 || new TextEncoder().encode(value).byteLength > 512) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must contain between 1 and 128 characters`)
  }
  return value
}

function parseAvatarAction(body: Record<string, unknown>): AvatarAction {
  if (body.avatar_url === undefined) return { type: 'unchanged' }
  if (body.avatar_url === null || body.avatar_url === '') return { type: 'delete' }
  if (typeof body.avatar_url !== 'string') throw new GatewayError(400, 'invalid_avatar_url', 'avatar_url must be a data URL or empty')
  if (body.avatar_url.length > MAX_AVATAR_DATA_URL_CHARS) {
    throw new GatewayError(413, 'avatar_too_large', 'Avatar upload is too large')
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(body.avatar_url.trim())
  if (match === null) throw new GatewayError(400, 'invalid_avatar_url', 'avatar_url must be a supported image data URL')
  let binary: string
  try {
    binary = atob(match[2])
  } catch {
    throw new GatewayError(400, 'invalid_avatar_url', 'avatar_url has invalid base64 data')
  }
  if (binary.length === 0 || binary.length > MAX_AVATAR_BYTES) {
    throw new GatewayError(413, 'avatar_too_large', 'Avatar upload is too large')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return { type: 'upload', contentType: match[1].toLowerCase() as AvatarContentType, bytes }
}

function rejectUnsupportedUserFields(body: Record<string, unknown>): void {
  const allowed = new Set([...PROFILE_FIELDS, ...NOTIFICATION_FIELDS])
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) {
      throw new GatewayError(400, 'unsupported_profile_field', `${field} is not supported by this profile endpoint`)
    }
  }
}

function requirePasswordField(body: Record<string, unknown>, field: 'old_password' | 'new_password'): string {
  if (typeof body[field] !== 'string') throw new GatewayError(400, 'invalid_password', 'Password is invalid')
  return body[field]
}

function avatarKey(userId: string, contentType: AvatarContentType): string {
  const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length)
  return `avatars/${userId}/${crypto.randomUUID()}.${extension}`
}

async function profileAuditInsert(
  env: Env,
  user: { id: string; email: string; session_id: string },
  eventType: string,
  metadata: Record<string, unknown>,
  now: number,
): Promise<D1PreparedStatement> {
  return env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash, session_id, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, 'succeeded', ?, NULL, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), user.id, eventType, await sha256Hex(user.email), user.session_id,
    JSON.stringify(metadata), now,
  )
}

async function recordPasswordAudit(
  env: Env,
  user: { id: string; email: string; session_id: string },
  outcome: 'failed',
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO auth_audit_events (
         id, user_id, event_type, outcome, email_hash, ip_hash, session_id, metadata_json, occurred_at_ms
       ) VALUES (?, ?, 'auth.password.change', ?, ?, NULL, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), user.id, outcome, await sha256Hex(user.email), user.session_id,
      JSON.stringify(metadata), now,
    ).run()
  } catch (error) {
    console.error('failed to record password audit event', error instanceof Error ? error.name : 'unknown')
  }
}

async function deleteAvatarObject(env: Env, key: string): Promise<void> {
  try {
    await env.OBJECTS.delete(key)
  } catch (error) {
    console.error('failed to delete old avatar object', error instanceof Error ? error.name : 'unknown')
  }
}

function normalizeProfileError(error: unknown): GatewayError {
  if (error instanceof PasswordValidationError) return new GatewayError(400, error.code, error.message)
  const message = error instanceof Error ? error.message : ''
  if (message.includes('CHECK constraint failed: auth_version')) {
    return new GatewayError(409, 'concurrent_security_update', 'Security settings changed; retry with a new session')
  }
  if (/CHECK constraint failed: version >= 0|user_notification_preferences\.version/i.test(message)) {
    return new GatewayError(
      409,
      'notification_preferences_version_conflict',
      'Notification preferences changed; reload and retry',
    )
  }
  return asGatewayError(error)
}
