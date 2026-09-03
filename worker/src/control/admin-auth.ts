import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { authenticateUserRequest } from '../auth/handler'
import { isOpaqueToken } from '../auth/tokens'
import { apiKeyDigest, constantTimeEqual, randomToken } from '../gateway/crypto'
import { asGatewayError, GatewayError, gatewayErrorResponse } from '../gateway/errors'

type AdminBindings = { Bindings: Env }

export const requireAdminToken: MiddlewareHandler<AdminBindings> = async (context, next) => {
  const configured = context.env.ADMIN_TOKEN
  if (!configured || configured.length < 24) {
    return gatewayErrorResponse(
      new GatewayError(503, 'admin_auth_not_configured', 'Admin authentication is not configured', 'server_error'),
    )
  }

  const authorization = context.req.header('authorization')?.trim() ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  if (match === null) {
    return gatewayErrorResponse(
      new GatewayError(401, 'admin_token_required', 'Admin Bearer token is required', 'authentication_error'),
    )
  }
  if (!constantTimeEqual(match[1], configured)) {
    return gatewayErrorResponse(
      new GatewayError(401, 'invalid_admin_token', 'Invalid admin token', 'authentication_error'),
    )
  }

  await next()
}

export const requireAdminSession: MiddlewareHandler<AdminBindings> = async (context, next) => {
  const authorization = context.req.header('authorization')?.trim() ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  if (match === null) {
    return gatewayErrorResponse(
      new GatewayError(401, 'admin_session_required', 'Admin session is required', 'authentication_error'),
    )
  }
  const pepper = context.env.API_KEY_PEPPER
  if (!pepper || pepper.length < 32) {
    return gatewayErrorResponse(
      new GatewayError(503, 'admin_auth_not_configured', 'Admin authentication is not configured', 'server_error'),
    )
  }
  if (isOpaqueToken(match[1], 'access')) {
    let user: Awaited<ReturnType<typeof authenticateUserRequest>>
    try {
      user = await authenticateUserRequest(context.req.raw, context.env)
    } catch (error) {
      return gatewayErrorResponse(asGatewayError(error))
    }
    if (user.role !== 'admin') {
      return gatewayErrorResponse(
        new GatewayError(403, 'admin_role_required', 'Administrator role is required', 'permission_error'),
      )
    }
    await next()
    return
  }
  const digest = await apiKeyDigest(`admin-session:v1:${match[1]}`, pepper)
  const session = await context.env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id
       FROM admin_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
        AND u.status = 'active' AND u.role = 'admin'
      LIMIT 1`,
  )
    .bind(digest, Date.now())
    .first<{ session_id: string; user_id: string }>()
  if (session === null) {
    return gatewayErrorResponse(
      new GatewayError(401, 'invalid_admin_session', 'Invalid or expired admin session', 'authentication_error'),
    )
  }
  await next()
}

export async function recoverAdminSession(context: Context<AdminBindings>): Promise<Response> {
  try {
    const pepper = context.env.API_KEY_PEPPER
    if (!pepper || pepper.length < 32) {
      throw new GatewayError(
        503,
        'admin_auth_not_configured',
        'Admin authentication is not configured',
        'server_error',
      )
    }
    const admin = await context.env.DB.prepare(
      `SELECT id
         FROM users
        WHERE role = 'admin' AND status = 'active'
        ORDER BY created_at_ms ASC, id ASC
        LIMIT 1`,
    ).first<{ id: string }>()
    if (admin === null) {
      throw new GatewayError(409, 'active_admin_not_found', 'No active admin is available for recovery')
    }

    const now = Date.now()
    const expiresAtMs = now + 12 * 60 * 60 * 1_000
    const session = `adm-sub2api-${randomToken(36)}`
    const sessionHash = await apiKeyDigest(`admin-session:v1:${session}`, pepper)
    await context.env.DB.prepare(
      `INSERT INTO admin_sessions (
         id, user_id, token_hash, created_at_ms, expires_at_ms,
         revoked_at_ms, last_seen_at_ms
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
      .bind(crypto.randomUUID(), admin.id, sessionHash, now, expiresAtMs)
      .run()

    return Response.json(
      {
        code: 0,
        data: {
          admin_session: session,
          admin_session_expires_at_ms: expiresAtMs,
          warning: 'The admin session is shown only once.',
        },
      },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}
