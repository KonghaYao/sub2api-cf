import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { authenticateUserRequest } from '../auth/handler'
import { isOpaqueToken } from '../auth/tokens'
import { apiKeyDigest, constantTimeEqual, randomToken } from '../gateway/crypto'
import { asGatewayError, GatewayError, gatewayErrorResponse } from '../gateway/errors'

type AdminBindings = { Bindings: Env }

export interface AdminActor {
  user_id: string
  actor_email: string
  actor_role: 'admin'
  auth_method: 'jwt' | 'admin_api_key'
  credential_masked: string
  session_id: string
  session_type: 'user_access' | 'admin_recovery'
  step_up_expires_at_ms: number | null
}

const adminActorCache = new WeakMap<Request, Promise<AdminActor>>()

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
  try {
    await authenticateAdminSession(context.req.raw, context.env)
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
  await next()
}

/**
 * Protects browser-originated admin mutations and, when enabled in D1, requires
 * a recent TOTP grant on the exact signed-in user session. Safe reads and the
 * dedicated break-glass recovery boundary are intentionally unaffected.
 */
export const requireAdminMutationSecurity: MiddlewareHandler<AdminBindings> = async (
  context,
  next,
) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(context.req.method.toUpperCase())) {
    await next()
    return
  }
  try {
    requireTrustedAdminOrigin(context.req.raw)
    // Clearing the request-audit log has its own mandatory fresh-TOTP check. Do
    // not allow the generic step-up window (or recovery-session bypass) to stand
    // in for that per-request proof, while retaining the origin boundary above.
    if (new URL(context.req.url).pathname === '/api/v1/admin/audit-logs/clear') {
      await next()
      return
    }
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    // A recovery session is minted only after presenting the independent
    // break-glass Worker secret. Treat it as an emergency elevation so an
    // operator can recover even when the user's TOTP device is unavailable.
    if (actor.session_type === 'admin_recovery') {
      await next()
      return
    }
    const setting = await context.env.DB.prepare(
      "SELECT step_up_enabled FROM system_settings WHERE id = 'global'",
    ).first<{ step_up_enabled: number }>()
    if (setting === null || ![0, 1].includes(setting.step_up_enabled)) {
      throw new GatewayError(
        503,
        'STEP_UP_UNAVAILABLE',
        'Step-up verification service unavailable',
        'server_error',
      )
    }
    if (setting.step_up_enabled === 0) {
      await next()
      return
    }

    const totp = await context.env.DB.prepare(
      'SELECT 1 AS enabled FROM user_totp_credentials WHERE user_id = ? LIMIT 1',
    ).bind(actor.user_id).first<{ enabled: number }>()
    if (totp === null) {
      throw new GatewayError(
        403,
        'STEP_UP_TOTP_NOT_ENABLED',
        'This operation requires two-factor authentication; enable TOTP first',
        'permission_error',
      )
    }
    if (actor.step_up_expires_at_ms === null || actor.step_up_expires_at_ms <= Date.now()) {
      throw new GatewayError(
        403,
        'STEP_UP_REQUIRED',
        'This operation requires recent two-factor verification',
        'permission_error',
      )
    }
    await next()
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

/**
 * Authenticates an administrative session and returns its server-derived actor.
 * The break-glass ADMIN_TOKEN is deliberately not accepted here.
 */
export async function authenticateAdminSession(request: Request, env: Env): Promise<AdminActor> {
  const cached = adminActorCache.get(request)
  if (cached !== undefined) return cached
  const pending = authenticateAdminSessionUncached(request, env)
  adminActorCache.set(request, pending)
  return pending
}

/** Returns the immutable snapshot produced by the preceding admin auth middleware. */
export async function getAuthenticatedAdminActor(request: Request): Promise<AdminActor> {
  const actor = adminActorCache.get(request)
  if (actor === undefined) {
    throw new Error('admin actor snapshot is unavailable before authentication')
  }
  return actor
}

async function authenticateAdminSessionUncached(request: Request, env: Env): Promise<AdminActor> {
  const authorization = request.headers.get('authorization')?.trim() ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  if (match === null) {
    throw new GatewayError(
      401,
      'admin_session_required',
      'Admin session is required',
      'authentication_error',
    )
  }
  const pepper = env.API_KEY_PEPPER
  if (!pepper || pepper.length < 32) {
    throw new GatewayError(
      503,
      'admin_auth_not_configured',
      'Admin authentication is not configured',
      'server_error',
    )
  }
  if (isOpaqueToken(match[1], 'access')) {
    let user: Awaited<ReturnType<typeof authenticateUserRequest>>
    try {
      user = await authenticateUserRequest(request, env)
    } catch (error) {
      throw asGatewayError(error)
    }
    if (user.role !== 'admin') {
      throw new GatewayError(
        403,
        'admin_role_required',
        'Administrator role is required',
        'permission_error',
      )
    }
    return {
      user_id: user.id,
      actor_email: user.email,
      actor_role: 'admin',
      auth_method: 'jwt',
      credential_masked: maskAdminCredential(match[1]),
      session_id: user.session_id,
      session_type: 'user_access',
      step_up_expires_at_ms: user.step_up_expires_at_ms,
    }
  }
  const digest = await apiKeyDigest(`admin-session:v1:${match[1]}`, pepper)
  const session = await env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, u.email AS actor_email, u.role AS actor_role
       FROM admin_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
        AND u.status = 'active' AND u.role = 'admin'
      LIMIT 1`,
  )
    .bind(digest, Date.now())
    .first<{
      session_id: string
      user_id: string
      actor_email: string
      actor_role: 'admin'
    }>()
  if (session === null) {
    throw new GatewayError(
      401,
      'invalid_admin_session',
      'Invalid or expired admin session',
      'authentication_error',
    )
  }
  return {
    ...session,
    auth_method: 'admin_api_key',
    credential_masked: maskAdminCredential(match[1]),
    session_type: 'admin_recovery',
    step_up_expires_at_ms: null,
  }
}

function maskAdminCredential(token: string): string {
  if (token.length <= 8) return '[masked]'
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

function requireTrustedAdminOrigin(request: Request): void {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase()
  if (fetchSite === 'cross-site') {
    throw adminOriginForbidden()
  }
  if (origin === null) return
  let requestOrigin: string
  let suppliedOrigin: string
  try {
    requestOrigin = new URL(request.url).origin
    suppliedOrigin = new URL(origin).origin
  } catch {
    throw adminOriginForbidden()
  }
  if (
    origin === 'null' ||
    suppliedOrigin !== requestOrigin ||
    origin !== suppliedOrigin
  ) throw adminOriginForbidden()
}

function adminOriginForbidden(): GatewayError {
  return new GatewayError(
    403,
    'admin_origin_forbidden',
    'Cross-origin administrative mutations are not allowed',
    'permission_error',
  )
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
      `SELECT u.id
         FROM users AS u
         JOIN admin_user_roles AS assignment
           ON assignment.user_id = u.id AND assignment.active = 1
         JOIN admin_roles AS role
           ON role.id = assignment.role_id
          AND role.active = 1
          AND role.system_key = 'super_admin'
        WHERE u.role = 'admin' AND u.status = 'active'
        ORDER BY u.created_at_ms ASC, u.id ASC
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
