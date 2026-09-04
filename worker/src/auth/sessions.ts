import type { Context } from 'hono'
import { controlError, controlSuccess, requireResourceId } from '../control/http'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateUserRequest } from './handler'

type AuthBindings = { Bindings: Env }

interface ManagedSessionRow {
  id: string
  created_at_ms: number
  access_expires_at_ms: number
  refresh_expires_at_ms: number
  rotated_at_ms: number | null
  last_seen_at_ms: number | null
  user_agent: string
}

interface OwnedSessionRow {
  id: string
  family_id: string
  revoked_at_ms: number | null
}

export async function listUserSessions(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const rows = await context.env.DB.prepare(
      `SELECT id, created_at_ms, access_expires_at_ms, refresh_expires_at_ms,
              rotated_at_ms, last_seen_at_ms, user_agent
         FROM user_sessions
        WHERE user_id = ? AND revoked_at_ms IS NULL
          AND refresh_expires_at_ms > ? AND auth_version = ?
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
                 COALESCE(last_seen_at_ms, rotated_at_ms, created_at_ms) DESC,
                 id ASC`,
    ).bind(user.id, Date.now(), user.auth_version, user.session_id).all<ManagedSessionRow>()
    const items = rows.results.map((row) => publicSession(row, user.session_id))
    return controlSuccess({ items, total: items.length })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function revokeUserSession(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const targetSessionId = requireResourceId(context.req.param('id'), 'session')
    const target = await context.env.DB.prepare(
      `SELECT id, family_id, revoked_at_ms
         FROM user_sessions
        WHERE id = ? AND user_id = ?
        LIMIT 1`,
    ).bind(targetSessionId, user.id).first<OwnedSessionRow>()
    if (target === null) throw sessionNotFound()

    const now = Date.now()
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = ?, revoke_reason = ?
          WHERE family_id = ? AND user_id = ? AND revoked_at_ms IS NULL`,
      ).bind(now, 'user_session_revoked', target.family_id, user.id),
      await sessionAuditInsert(
        context.env,
        user.id,
        user.email,
        user.session_id,
        'auth.session.revoke',
        { target_session_id: target.id },
        now,
      ),
    ])
    return controlSuccess({
      message: 'Session revoked',
      session_id: target.id,
      current: target.id === user.session_id,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function revokeOtherUserSessions(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const now = Date.now()
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE users
            SET auth_version = auth_version + 1, updated_at_ms = ?
          WHERE id = ?`,
      ).bind(now, user.id),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET auth_version = (SELECT auth_version FROM users WHERE id = ?)
          WHERE user_id = ? AND family_id = ? AND revoked_at_ms IS NULL`,
      ).bind(user.id, user.id, user.family_id),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = ?, revoke_reason = ?
          WHERE user_id = ? AND family_id <> ? AND revoked_at_ms IS NULL`,
      ).bind(now, 'user_revoked_other_sessions', user.id, user.family_id),
      await sessionAuditInsert(
        context.env,
        user.id,
        user.email,
        user.session_id,
        'auth.sessions.revoke_others',
        { retained_session_id: user.session_id },
        now,
      ),
    ])
    return controlSuccess({
      message: 'Other sessions revoked',
      current_session_id: user.session_id,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function revokeAllUserSessions(context: Context<AuthBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const now = Date.now()
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE users
            SET auth_version = auth_version + 1, updated_at_ms = ?
          WHERE id = ?`,
      ).bind(now, user.id),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = ?, revoke_reason = ?
          WHERE user_id = ? AND revoked_at_ms IS NULL`,
      ).bind(now, 'user_revoked_all_sessions', user.id),
      await sessionAuditInsert(
        context.env,
        user.id,
        user.email,
        user.session_id,
        'auth.sessions.revoke_all',
        { included_current_session: true },
        now,
      ),
    ])
    return controlSuccess({
      message: 'All sessions have been revoked. Please log in again.',
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function publicSession(row: ManagedSessionRow, currentSessionId: string): Record<string, unknown> {
  return {
    id: row.id,
    current: row.id === currentSessionId,
    created_at: new Date(row.created_at_ms).toISOString(),
    access_expires_at: new Date(row.access_expires_at_ms).toISOString(),
    refresh_expires_at: new Date(row.refresh_expires_at_ms).toISOString(),
    ...(row.last_seen_at_ms === null
      ? {}
      : { last_seen_at: new Date(row.last_seen_at_ms).toISOString() }),
    ...(row.user_agent === '' ? {} : { user_agent: row.user_agent }),
  }
}

async function sessionAuditInsert(
  env: Env,
  userId: string,
  email: string,
  actorSessionId: string,
  eventType: string,
  metadata: Record<string, unknown>,
  now: number,
): Promise<D1PreparedStatement> {
  return env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, 'succeeded', ?, NULL, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    userId,
    eventType,
    await sha256Hex(email),
    actorSessionId,
    JSON.stringify(metadata),
    now,
  )
}

function sessionNotFound(): GatewayError {
  return new GatewayError(404, 'session_not_found', 'Session was not found')
}
