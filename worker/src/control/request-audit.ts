import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import {
  claimTotpVerificationAttempt,
  findTotpCredential,
  verifyStoredTotpCode,
  verifyTotpCode,
} from '../auth/totp'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { requestIdFor } from '../request-id'
import { getAuthenticatedAdminActor } from './admin-auth'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
} from './http'
import {
  controlIdempotency,
  findControlIdempotency,
  parseIdempotentResponse,
} from './idempotency'
import {
  captureAdminRequestBody,
  REQUEST_BODY_PLACEHOLDERS,
} from './request-audit-body'

export type RequestAuditBindings = {
  Bindings: Env
}

interface AuditRow {
  id: number
  event_key: string
  created_at_ms: number
  actor_user_id: string
  actor_email: string
  actor_role: string
  auth_method: 'jwt' | 'admin_api_key'
  credential_masked: string
  action: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  route_template: string
  request_id: string
  client_ip: string
  user_agent: string
  status_code: number
  latency_ms: number
  request_body?: string
  extra_json: string
}

const AUDITED_MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const SENSITIVE_GET_ROUTES = [
  /^\/api\/v1\/admin\/audit-logs(?:\/\d+)?$/,
  /^\/api\/v1\/admin\/audit\/events(?:\/[^/]+\/[^/]+)?$/,
  /^\/api\/v1\/admin\/settings$/,
  /^\/api\/v1\/admin\/users\/[^/]+$/,
  /^\/api\/v1\/admin\/accounts\/[^/]+$/,
  /^\/api\/v1\/admin\/api-keys\/[^/]+$/,
  /^\/api\/v1\/admin\/rbac\/users\/[^/]+\/roles$/,
]
const REQUEST_BODY_PLACEHOLDER = REQUEST_BODY_PLACEHOLDERS.notCaptured
const CLEAR_IDEMPOTENCY_SCOPE = 'admin.audit-logs.clear.v1'
const CLEAR_IDEMPOTENCY_RESOURCE = 'admin_request_audit_clear'
const CLEAR_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const DUMMY_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'

interface ClearAuditResponse {
  deleted: number
}

/**
 * Records authenticated management-plane requests after authentication, RBAC,
 * and mutation security have admitted the request. Audit persistence is
 * deliberately best effort so a logging outage cannot rewrite business truth.
 */
export const auditAdminRequest: MiddlewareHandler<RequestAuditBindings> = async (context, next) => {
  const method = context.req.method.toUpperCase()
  const url = new URL(context.req.url)
  if (!shouldAudit(method, url.pathname)) {
    await next()
    return
  }

  const startedAt = Date.now()
  let actor: Awaited<ReturnType<typeof getAuthenticatedAdminActor>> | undefined
  try {
    actor = await getAuthenticatedAdminActor(context.req.raw)
  } catch (error) {
    console.error('admin request audit actor resolution failed', error)
  }

  const bodyCapture = actor !== undefined && AUDITED_MUTATIONS.has(method)
    ? await captureAdminRequestBody(context.req.raw, url.pathname)
    : { body: REQUEST_BODY_PLACEHOLDER, kind: 'not_applicable' }

  let handlerError: unknown
  try {
    await next()
  } catch (error) {
    handlerError = error
  }

  const completedAt = Date.now()
  const routeTemplate = boundedRouteTemplate(context.req.routePath, url.pathname)
  const requestId = requestIdFor(context.req.raw)
  const statusCode = handlerError === undefined ? normalizeStatus(context.res.status) : 500
  try {
    if (actor === undefined) throw new Error('authenticated audit actor snapshot is unavailable')
    await context.env.DB.prepare(
      `INSERT INTO admin_request_audit_logs (
         event_key, created_at_ms, actor_user_id, actor_email, actor_role,
         auth_method, credential_masked, action, method, path, route_template,
         request_id, client_ip, user_agent, status_code, latency_ms,
         request_body, extra_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), completedAt, actor.user_id,
      bounded(actor.actor_email, 320), bounded(actor.actor_role, 128),
      actor.auth_method, actor.credential_masked,
      bounded(`${method} ${routeTemplate}`, 512), method,
      bounded(url.pathname, 2_048), routeTemplate, bounded(requestId, 128),
      trustedClientIp(context.req.raw), bounded(context.req.header('user-agent') ?? '', 1_024),
      statusCode, Math.min(Math.max(0, completedAt - startedAt), 86_400_000),
      bodyCapture.body,
      JSON.stringify({ request_body_capture: bodyCapture.kind }),
    ).run()
  } catch (error) {
    console.error('admin request audit write failed', error)
  }
  if (handlerError !== undefined) throw handlerError
}

export async function listAdminRequestAuditLogs(
  context: Context<RequestAuditBindings>,
): Promise<Response> {
  try {
    const query = context.req.query()
    const page = queryInteger(query.page, 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(query.page_size, 'page_size', 20, 1, 100)
    const filters = parseFilters(query)
    const { clause, bindings } = buildWhere(filters)
    const [countResult, dataResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM admin_request_audit_logs${clause}`,
      ).bind(...bindings),
      context.env.DB.prepare(
        `SELECT id, event_key, created_at_ms, actor_user_id, actor_email, actor_role,
                auth_method, credential_masked, action, method, path, route_template,
                request_id, client_ip, user_agent, status_code, latency_ms, extra_json
           FROM admin_request_audit_logs${clause}
          ORDER BY created_at_ms DESC, id DESC
          LIMIT ? OFFSET ?`,
      ).bind(...bindings, pageSize, (page - 1) * pageSize),
    ])
    const total = Number((countResult.results[0] as { total?: number } | undefined)?.total ?? 0)
    const items = (dataResult.results as unknown as AuditRow[]).map(publicAuditRow)
    return controlSuccess({
      items,
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminRequestAuditLog(
  context: Context<RequestAuditBindings>,
): Promise<Response> {
  try {
    const id = requireNumericId(context.req.param('id'))
    const row = await context.env.DB.prepare(
      `SELECT id, event_key, created_at_ms, actor_user_id, actor_email, actor_role,
              auth_method, credential_masked, action, method, path, route_template,
              request_id, client_ip, user_agent, status_code, latency_ms,
              request_body, extra_json
         FROM admin_request_audit_logs WHERE id = ?`,
    ).bind(id).first<AuditRow>()
    if (row === null) {
      throw new GatewayError(404, 'audit_log_not_found', 'Audit log not found', 'not_found_error')
    }
    return controlSuccess(publicAuditRow(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function clearAdminRequestAuditLogs(
  context: Context<RequestAuditBindings>,
): Promise<Response> {
  try {
    const startedAt = Date.now()
    const actor = await getAuthenticatedAdminActor(context.req.raw)
    if (actor.session_type !== 'user_access') {
      throw new GatewayError(
        403,
        'audit_log_clear_user_access_required',
        'Audit logs can only be cleared from an authenticated user session',
        'permission_error',
      )
    }

    const idempotency = await controlIdempotency(
      CLEAR_IDEMPOTENCY_SCOPE,
      requireIdempotencyKey(context.req.raw),
      { actor_user_id: actor.user_id },
    )
    const body = await readJsonObject(context.req.raw, 1_024)
    const totpCode = body.totp_code
    const verifiedAt = Date.now()
    const credential = await findTotpCredential(context.env, actor.user_id)
    const validTotp = credential === null
      ? await verifyTotpCode(totpCode, DUMMY_TOTP_SECRET, verifiedAt)
      : await verifyStoredTotpCode(context.env, credential, totpCode, verifiedAt)
    if (credential === null || !validTotp) {
      await claimTotpVerificationAttempt(context.env, actor.user_id, verifiedAt)
      throw new GatewayError(
        403,
        'audit_log_clear_totp_invalid',
        'A valid current TOTP code is required to clear audit logs',
        'permission_error',
      )
    }

    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return controlSuccess(parseIdempotentResponse<ClearAuditResponse>(
        replay,
        CLEAR_IDEMPOTENCY_RESOURCE,
      ))
    }

    const completedAt = Date.now()
    const eventKey = await deterministicUuid('admin-request-audit-clear-trace:v1', idempotency.key_hash)
    const requestId = bounded(requestIdFor(context.req.raw), 128)
    const path = '/api/v1/admin/audit-logs/clear'
    let statements: D1Result<unknown>[]
    try {
      statements = await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO admin_request_audit_logs (
           event_key, created_at_ms, actor_user_id, actor_email, actor_role,
           auth_method, credential_masked, action, method, path, route_template,
           request_id, client_ip, user_agent, status_code, latency_ms,
           request_body, extra_json
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'POST', ?, ?, ?, ?, ?, 200, ?, ?,
                json_object(
                  'kind', 'clear_trace',
                  'deleted_rows', (SELECT COUNT(*) FROM admin_request_audit_logs),
                  'idempotency_key_hash', ?
                )
          WHERE NOT EXISTS (
            SELECT 1 FROM control_idempotency WHERE scope = ? AND key_hash = ?
          )
         RETURNING CAST(json_extract(extra_json, '$.deleted_rows') AS INTEGER) AS deleted_rows`,
        ).bind(
          eventKey,
          completedAt,
          actor.user_id,
          bounded(actor.actor_email, 320),
          bounded(actor.actor_role, 128),
          actor.auth_method,
          actor.credential_masked,
          'POST /api/v1/admin/audit-logs/clear',
          path,
          path,
          requestId,
          trustedClientIp(context.req.raw),
          bounded(context.req.header('user-agent') ?? '', 1_024),
          Math.min(Math.max(0, completedAt - startedAt), 86_400_000),
          REQUEST_BODY_PLACEHOLDERS.sensitive,
          idempotency.key_hash,
          idempotency.scope,
          idempotency.key_hash,
        ),
        context.env.DB.prepare(
          `DELETE FROM admin_request_audit_logs
          WHERE event_key <> ?
            AND NOT EXISTS (
              SELECT 1 FROM control_idempotency WHERE scope = ? AND key_hash = ?
            )`,
        ).bind(eventKey, idempotency.scope, idempotency.key_hash),
        context.env.DB.prepare(
          `INSERT INTO control_idempotency (
           scope, key_hash, request_hash, resource_type, resource_id,
           response_json, created_at_ms, expires_at_ms
         )
         SELECT ?, ?, ?, ?, ?,
                json_object(
                  'deleted', CAST(json_extract(extra_json, '$.deleted_rows') AS INTEGER)
                ),
                ?, ?
           FROM admin_request_audit_logs
          WHERE event_key = ?
            AND NOT EXISTS (
              SELECT 1 FROM control_idempotency WHERE scope = ? AND key_hash = ?
            )`,
        ).bind(
          idempotency.scope,
          idempotency.key_hash,
          idempotency.request_hash,
          CLEAR_IDEMPOTENCY_RESOURCE,
          eventKey,
          completedAt,
          completedAt + CLEAR_IDEMPOTENCY_TTL_MS,
          eventKey,
          idempotency.scope,
          idempotency.key_hash,
        ),
        context.env.DB.prepare(
          'DELETE FROM user_totp_verification_budgets WHERE user_id = ?',
        ).bind(actor.user_id),
      ])
    } catch (error) {
      try {
        const concurrent = await findControlIdempotency(context.env, idempotency)
        if (concurrent !== null) {
          return controlSuccess(parseIdempotentResponse<ClearAuditResponse>(
            concurrent,
            CLEAR_IDEMPOTENCY_RESOURCE,
          ))
        }
      } catch {
        // A D1 outage can fail both the transaction and the recovery read. The
        // caller still receives the stable retryable clear-specific boundary.
      }
      console.error('admin request audit clear transaction failed', {
        name: error instanceof Error ? error.name : 'unknown',
      })
      throw invalidClearTransaction()
    }
    const inserted = statements[0]?.results[0] as { deleted_rows?: number } | undefined
    if (inserted !== undefined) {
      const deleted = Number(inserted.deleted_rows)
      if (!Number.isSafeInteger(deleted) || deleted < 0) throw invalidClearTransaction()
      return controlSuccess({ deleted })
    }

    const concurrent = await findControlIdempotency(context.env, idempotency)
    if (concurrent !== null) {
      return controlSuccess(parseIdempotentResponse<ClearAuditResponse>(
        concurrent,
        CLEAR_IDEMPOTENCY_RESOURCE,
      ))
    }
    throw invalidClearTransaction()
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function invalidClearTransaction(): GatewayError {
  return new GatewayError(
    503,
    'audit_log_clear_unavailable',
    'Audit log clearing is temporarily unavailable',
    'server_error',
  )
}

function shouldAudit(method: string, pathname: string): boolean {
  if (pathname === '/api/v1/admin/audit-logs/clear') return false
  if (AUDITED_MUTATIONS.has(method)) return true
  return method === 'GET' && SENSITIVE_GET_ROUTES.some((pattern) => pattern.test(pathname))
}

function boundedRouteTemplate(routePath: string, pathname: string): string {
  const candidate = routePath && routePath !== '*' && !routePath.endsWith('/*')
    ? routePath
    : pathname
  return bounded(candidate, 512)
}

function bounded(value: string, maximum: number): string {
  return value.trim().slice(0, maximum)
}

function normalizeStatus(value: number): number {
  return Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : 500
}

function trustedClientIp(request: Request): string {
  const value = request.headers.get('cf-connecting-ip')?.trim() ?? ''
  return value.length <= 64 ? value : ''
}

interface AuditFilters {
  startAtMs?: number
  endAtMs?: number
  actorUserId?: string
  actorEmail?: string
  authMethod?: 'jwt' | 'admin_api_key'
  action?: string
  method?: AuditRow['method']
  clientIp?: string
  success?: boolean
  q?: string
}

function parseFilters(query: Record<string, string>): AuditFilters {
  const startAtMs = optionalTimestamp(query.start_time, 'start_time')
  const endAtMs = optionalTimestamp(query.end_time, 'end_time')
  if (startAtMs !== undefined && endAtMs !== undefined && startAtMs > endAtMs) {
    throw new GatewayError(400, 'invalid_time_range', 'start_time must not be after end_time')
  }
  const actorUserId = optionalText(query.actor_user_id, 'actor_user_id', 128)
  if (actorUserId !== undefined) requireResourceId(actorUserId, 'actor_user')
  const authMethod = optionalEnum(query.auth_method, 'auth_method', ['jwt', 'admin_api_key'] as const)
  const method = optionalEnum(
    query.method?.toUpperCase(),
    'method',
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const,
  )
  const success = optionalEnum(query.success?.toLowerCase(), 'success', ['true', 'false'] as const)
  return {
    startAtMs,
    endAtMs,
    actorUserId,
    actorEmail: optionalText(query.actor_email, 'actor_email', 320),
    authMethod,
    action: optionalText(query.action, 'action', 256),
    method,
    clientIp: optionalText(query.client_ip, 'client_ip', 64),
    success: success === undefined ? undefined : success === 'true',
    q: optionalText(query.q, 'q', 256),
  }
}

function optionalTimestamp(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be an RFC3339 timestamp`)
  }
  return timestamp
}

function optionalText(value: string | undefined, field: string, maximum: number): string | undefined {
  if (value === undefined || value === '') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  }
  return normalized
}

function optionalEnum<const T extends readonly string[]>(
  value: string | undefined,
  field: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined || value === '') return undefined
  if (!allowed.includes(value)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  }
  return value as T[number]
}

function buildWhere(filters: AuditFilters): { clause: string; bindings: unknown[] } {
  const conditions: string[] = []
  const bindings: unknown[] = []
  const add = (sql: string, ...values: unknown[]) => {
    conditions.push(sql)
    bindings.push(...values)
  }
  if (filters.startAtMs !== undefined) add('created_at_ms >= ?', filters.startAtMs)
  if (filters.endAtMs !== undefined) add('created_at_ms <= ?', filters.endAtMs)
  if (filters.actorUserId !== undefined) add('actor_user_id = ?', filters.actorUserId)
  if (filters.actorEmail !== undefined) add("actor_email LIKE ? ESCAPE '\\' COLLATE NOCASE", contains(filters.actorEmail))
  if (filters.authMethod !== undefined) add('auth_method = ?', filters.authMethod)
  if (filters.action !== undefined) add("action LIKE ? ESCAPE '\\' COLLATE NOCASE", contains(filters.action))
  if (filters.method !== undefined) add('method = ?', filters.method)
  if (filters.clientIp !== undefined) add('client_ip = ?', filters.clientIp)
  if (filters.success !== undefined) add(filters.success ? 'status_code < 400' : 'status_code >= 400')
  if (filters.q !== undefined) {
    const value = contains(filters.q)
    add("(path LIKE ? ESCAPE '\\' COLLATE NOCASE OR action LIKE ? ESCAPE '\\' COLLATE NOCASE OR actor_email LIKE ? ESCAPE '\\' COLLATE NOCASE)", value, value, value)
  }
  return {
    clause: conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`,
    bindings,
  }
}

function contains(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

function requireNumericId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new GatewayError(400, 'invalid_audit_log_id', 'Audit log id is invalid')
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id)) {
    throw new GatewayError(400, 'invalid_audit_log_id', 'Audit log id is invalid')
  }
  return id
}

function publicAuditRow(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    event_key: row.event_key,
    created_at: new Date(row.created_at_ms).toISOString(),
    created_at_ms: row.created_at_ms,
    actor_user_id: row.actor_user_id,
    actor_email: row.actor_email,
    actor_role: row.actor_role,
    auth_method: row.auth_method,
    credential_masked: row.credential_masked,
    action: row.action,
    method: row.method,
    path: row.path,
    route_template: row.route_template,
    request_id: row.request_id,
    client_ip: row.client_ip,
    user_agent: row.user_agent,
    ...(row.request_body === undefined ? {} : { request_body: row.request_body }),
    status_code: row.status_code,
    latency_ms: row.latency_ms,
    extra: parseExtra(row.extra_json),
  }
}

function parseExtra(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
