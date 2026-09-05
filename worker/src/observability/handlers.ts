import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { authenticateAdminSession } from '../control/admin-auth'
import { controlError, controlSuccess, queryInteger, requireResourceId } from '../control/http'
import { apiKeyDigest, constantTimeEqual, sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { observabilityBucket } from './recorder'
import type { ObservationRow, ObservabilityEnv, PayloadProjection } from './types'

type Bindings = { Bindings: ObservabilityEnv }
type View = 'owner' | 'admin'
type Family = 'all' | 'errors' | 'upstream'

const COLUMNS = `id, request_id, client_request_id, bucket_day, occurred_at_ms, completed_at_ms,
  lifecycle, user_id, api_key_id, account_id, group_id, method, request_path,
  inbound_endpoint, platform, requested_model, upstream_model, request_type, stream,
  status_code, duration_ms, outcome, input_tokens, output_tokens, cache_read_tokens,
  amount_micros, error_phase, error_type, error_owner, error_source, severity,
  error_message, upstream_status_code, is_business_limited, resolved, resolved_at_ms,
  resolved_by_user_id, payload_state, payload_object_key, payload_sha256, payload_bytes,
  payload_content_type, payload_attempts, payload_retry_after_ms, payload_lease_id,
  payload_lease_expires_at_ms, payload_last_error, updated_at_ms`

interface ListFilters {
  limit: number
  cursor?: Cursor
  startMs?: number
  endMs?: number
  userId?: string
  apiKeyId?: string
  accountId?: string
  groupId?: string
  platform?: string
  model?: string
  statusCode?: number
  requestId?: string
  family: Family
}

interface Cursor {
  occurred_at_ms: number
  id: string
  filter_hash: string
  start_ms?: number
  end_ms?: number
}

export const listOwnerRequests = (context: Context<Bindings>) => listFor(context, 'owner', 'all', 'usage')
export const listOwnerErrors = (context: Context<Bindings>) => listFor(context, 'owner', 'errors', 'usage')
export const listAdminUsage = (context: Context<Bindings>) => listFor(context, 'admin', 'all', 'usage')
export const listAdminRequests = (context: Context<Bindings>) => listFor(context, 'admin', 'all', 'ops')
export const listAdminRequestErrors = (context: Context<Bindings>) => listFor(context, 'admin', 'errors', 'ops')
export const listAdminUpstreamErrors = (context: Context<Bindings>) => listFor(context, 'admin', 'upstream', 'ops')

export const getOwnerRequestDetail = (context: Context<Bindings>) => ownerDetail(context, 'all')
export const getOwnerErrorDetail = (context: Context<Bindings>) => ownerDetail(context, 'errors')
export const getAdminRequestDetail = (context: Context<Bindings>) => adminDetail(context, 'all')
export const getAdminRequestErrorDetail = (context: Context<Bindings>) => adminDetail(context, 'errors')
export const getAdminUpstreamErrorDetail = (context: Context<Bindings>) => adminDetail(context, 'upstream')

async function ownerDetail(context: Context<Bindings>, family: Family): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const row = await findObservation(context.env, requireResourceId(context.req.param('id'), 'observation'), user.id)
    if (row === null || !rowMatchesFamily(row, family)) throw notFound()
    return controlSuccess({ ...projectRow(row, 'owner'), payload: await projectPayload(context.env, row) })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function adminDetail(context: Context<Bindings>, family: Family): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const row = await findObservation(context.env, requireResourceId(context.req.param('id'), 'observation'))
    if (row === null || !rowMatchesFamily(row, family)) throw notFound()
    return controlSuccess({ ...projectRow(row, 'admin'), payload: await projectPayload(context.env, row) })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function rowMatchesFamily(row: ObservationRow, family: Family): boolean {
  if (family === 'all') return true
  if (row.lifecycle !== 'failed') return false
  return family === 'errors' || (
    ['upstream', 'account_auth', 'network'].includes(row.error_phase) && row.error_owner === 'provider'
  )
}

export async function listRelatedUpstreamErrors(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'observation')
    const source = await findObservation(context.env, id)
    if (source === null || !rowMatchesFamily(source, 'errors')) throw notFound()
    // The source observation already provides an indexed correlation key. Do
    // not apply the general Explorer's moving one-hour default here: operators
    // must still be able to inspect retries related to an older request.
    const filters = await parseFilters(context, 'upstream', 'ops', undefined, false)
    const clauses = [
      `id <> ?`,
      `lifecycle = 'failed'`,
      `error_phase IN ('upstream', 'account_auth', 'network')`,
      `error_owner = 'provider'`,
      `(request_id = ? OR (? <> '' AND client_request_id = ?))`,
    ]
    const values: unknown[] = [id, source.request_id, source.client_request_id ?? '', source.client_request_id ?? '']
    addSharedClauses(filters, clauses, values)
    return await listResponse(context.env, filters, clauses, values, 'admin')
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminErrorAggregation(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const filters = await parseFilters(context, 'errors', 'ops')
    const clauses = [`lifecycle = 'failed'`]
    const values: unknown[] = []
    addSharedClauses({ ...filters, cursor: undefined }, clauses, values)
    const result = await context.env.DB.prepare(
      `SELECT status_code, error_phase AS phase, error_type AS type, COUNT(*) AS count
         FROM request_observations
        WHERE ${clauses.join(' AND ')}
        GROUP BY status_code, error_phase, error_type
        ORDER BY count DESC, status_code ASC, error_phase ASC, error_type ASC
        LIMIT 100`,
    ).bind(...values).all<{ status_code: number; phase: string; type: string; count: number }>()
    const items = result.results
    return controlSuccess({
      total: items.reduce((sum, item) => sum + Number(item.count), 0),
      items,
      truncated: items.length === 100,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function listFor(
  context: Context<Bindings>,
  view: View,
  family: Family,
  timeContract: 'usage' | 'ops',
): Promise<Response> {
  try {
    let owner: string | undefined
    if (view === 'owner') owner = (await authenticateUserRequest(context.req.raw, context.env)).id
    else await authenticateAdminSession(context.req.raw, context.env)
    const filters = await parseFilters(context, family, timeContract, owner)
    const clauses: string[] = []
    const values: unknown[] = []
    addFamilyClause(family, clauses)
    addSharedClauses(filters, clauses, values)
    return await listResponse(context.env, filters, clauses, values, view)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function listResponse(
  env: ObservabilityEnv,
  filters: ListFilters,
  clauses: string[],
  values: unknown[],
  view: View,
): Promise<Response> {
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  const result = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM request_observations ${where}
      ORDER BY occurred_at_ms DESC, id DESC LIMIT ?`,
  ).bind(...values, filters.limit + 1).all<ObservationRow>()
  const hasMore = result.results.length > filters.limit
  const page = result.results.slice(0, filters.limit)
  const last = page.at(-1)
  return controlSuccess({
    items: page.map((row) => projectRow(row, view)),
    has_more: hasMore,
    next_cursor: hasMore && last !== undefined
      ? await encodeCursor(
          env, last.occurred_at_ms, last.id, await filterHash(filters),
          filters.startMs, filters.endMs,
        )
      : null,
  })
}

async function parseFilters(
  context: Context<Bindings>,
  family: Family,
  timeContract: 'usage' | 'ops',
  forcedUserId?: string,
  defaultOpsRange = true,
): Promise<ListFilters> {
  for (const legacy of ['page', 'page_size', 'sort_by', 'sort_order', 'q', 'user_query']) {
    if (context.req.query(legacy) !== undefined) {
      throw new GatewayError(
        400,
        'unsupported_pagination_or_search',
        'Request Explorer supports only bounded cursor pagination and exact filters',
      )
    }
  }
  const limit = queryInteger(context.req.query('limit'), 'limit', 20, 1, 100)
  const filters: ListFilters = { limit, family }
  const rawCursor = context.req.query('cursor')
  const cursor = rawCursor === undefined ? undefined : await decodeCursor(context.env, rawCursor)
  const exact = (name: string, maximum = 200): string | undefined => {
    const value = context.req.query(name)?.trim()
    if (!value) return undefined
    if (value.length > maximum) throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
    return value
  }
  filters.userId = exact('user_id', 128)
  filters.apiKeyId = exact('api_key_id', 128)
  filters.accountId = exact('account_id', 128)
  filters.groupId = exact('group_id', 128)
  filters.platform = exact('platform', 64)
  filters.model = exact('model', 200)
  filters.requestId = exact('request_id', 128)
  if (forcedUserId !== undefined) filters.userId = forcedUserId
  const status = exact('status_code', 3)
  if (status !== undefined) {
    if (!/^\d{3}$/.test(status) || Number(status) < 100 || Number(status) > 599) {
      throw new GatewayError(400, 'invalid_status_code', 'status_code is invalid')
    }
    filters.statusCode = Number(status)
  }
  if (timeContract === 'usage') {
    filters.startMs = parseDate(context.req.query('start_date'), false) ?? cursor?.start_ms
    filters.endMs = parseDate(context.req.query('end_date'), true) ?? cursor?.end_ms
  } else {
    const explicitStart = parseTimestamp(context.req.query('start_time')) ?? cursor?.start_ms
    const explicitEnd = parseTimestamp(context.req.query('end_time')) ?? cursor?.end_ms
    if (defaultOpsRange || explicitStart !== undefined || explicitEnd !== undefined) {
      const end = explicitEnd ?? Date.now()
      const start = explicitStart ?? end - 60 * 60 * 1_000
      if (start > end || end - start > 30 * 86_400_000) {
        throw new GatewayError(400, 'invalid_time_range', 'Time range must be ordered and no longer than 30 days')
      }
      filters.startMs = start
      filters.endMs = end
    }
  }
  if (filters.startMs !== undefined && filters.endMs !== undefined && filters.startMs >= filters.endMs) {
    throw new GatewayError(400, 'invalid_time_range', 'Time range is invalid')
  }
  if (cursor !== undefined) {
    const expected = await filterHash(filters)
    if (cursor.filter_hash !== expected) throw invalidCursor()
    filters.cursor = cursor
  }
  return filters
}

function addFamilyClause(family: Family, clauses: string[]): void {
  if (family === 'errors') clauses.push(`lifecycle = 'failed'`)
  if (family === 'upstream') {
    clauses.push(`lifecycle = 'failed'`)
    clauses.push(`error_phase IN ('upstream', 'account_auth', 'network')`)
    clauses.push(`error_owner = 'provider'`)
  }
}

function addSharedClauses(filters: ListFilters, clauses: string[], values: unknown[]): void {
  const equality: Array<[string, unknown]> = [
    ['user_id', filters.userId], ['api_key_id', filters.apiKeyId],
    ['account_id', filters.accountId], ['group_id', filters.groupId],
    ['platform', filters.platform], ['requested_model', filters.model],
    ['status_code', filters.statusCode], ['request_id', filters.requestId],
  ]
  for (const [column, value] of equality) {
    if (value === undefined) continue
    clauses.push(`${column} = ?`)
    values.push(value)
  }
  if (filters.startMs !== undefined) { clauses.push('occurred_at_ms >= ?'); values.push(filters.startMs) }
  if (filters.endMs !== undefined) { clauses.push('occurred_at_ms < ?'); values.push(filters.endMs) }
  if (filters.cursor !== undefined) {
    clauses.push('(occurred_at_ms < ? OR (occurred_at_ms = ? AND id < ?))')
    values.push(filters.cursor.occurred_at_ms, filters.cursor.occurred_at_ms, filters.cursor.id)
  }
}

async function findObservation(
  env: ObservabilityEnv,
  id: string,
  userId?: string,
): Promise<ObservationRow | null> {
  return env.DB.prepare(
    `SELECT ${COLUMNS} FROM request_observations WHERE id = ?${userId === undefined ? '' : ' AND user_id = ?'}`,
  ).bind(id, ...(userId === undefined ? [] : [userId])).first<ObservationRow>()
}

async function projectPayload(env: ObservabilityEnv, row: ObservationRow): Promise<PayloadProjection> {
  if (row.payload_state === 'deleted') return payloadProjection('expired')
  if (row.payload_state === 'pending' || row.payload_state === 'retry') return payloadProjection('pending_recovery')
  if (row.payload_state !== 'stored' || row.payload_object_key === null) return payloadProjection('missing')
  try {
    const object = await observabilityBucket(env).get(row.payload_object_key)
    if (object === null) return payloadProjection('missing')
    const body = await object.text()
    if (row.payload_sha256 === null || !constantTimeEqual(await sha256Hex(body), row.payload_sha256)) {
      return payloadProjection('missing')
    }
    return {
      state: 'available', body, content_type: 'application/json', redacted: true,
    }
  } catch {
    return payloadProjection('pending_recovery')
  }
}

function payloadProjection(state: PayloadProjection['state']): PayloadProjection {
  return { state, body: null, content_type: null, redacted: true }
}

function projectRow(row: ObservationRow, view: View): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    kind: row.lifecycle === 'failed' ? 'error' : 'success',
    created_at: new Date(row.occurred_at_ms).toISOString(),
    request_id: row.request_id,
    client_request_id: row.client_request_id,
    method: row.method,
    request_path: row.request_path,
    inbound_endpoint: row.inbound_endpoint,
    platform: row.platform,
    model: row.requested_model,
    requested_model: row.requested_model,
    status_code: row.status_code,
    duration_ms: row.duration_ms,
    request_type: row.request_type,
    stream: row.stream === 1,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    amount_micros: row.amount_micros,
    phase: row.error_phase,
    type: row.error_type,
    category: errorCategory(row.error_phase, row.error_type),
    severity: row.severity,
    message: row.error_message,
    resolved: row.resolved === 1,
  }
  if (view === 'admin') Object.assign(base, {
    user_id: row.user_id,
    api_key_id: row.api_key_id,
    account_id: row.account_id,
    group_id: row.group_id,
    upstream_model: row.upstream_model,
    error_owner: row.error_owner,
    error_source: row.error_source,
    upstream_status_code: row.upstream_status_code,
    is_business_limited: row.is_business_limited === 1,
    payload_state: row.payload_state,
  })
  return base
}

function errorCategory(phase: string, type: string): string {
  if (phase === 'auth') return 'auth'
  if (phase === 'routing') return 'service_unavailable'
  if (['account_auth', 'upstream', 'network'].includes(phase)) return 'upstream'
  if (phase === 'internal') return 'internal'
  if (type === 'rate_limit_error') return 'rate_limit'
  if (['billing_error', 'subscription_error'].includes(type)) return 'quota'
  if (type === 'invalid_request_error') return 'invalid_request'
  if (type === 'cyber_policy') return 'cyber'
  return 'other'
}

async function filterHash(filters: ListFilters): Promise<string> {
  return sha256Hex(JSON.stringify({
    family: filters.family,
    startMs: filters.startMs ?? null, endMs: filters.endMs ?? null,
    userId: filters.userId ?? null, apiKeyId: filters.apiKeyId ?? null,
    accountId: filters.accountId ?? null, groupId: filters.groupId ?? null,
    platform: filters.platform ?? null, model: filters.model ?? null,
    statusCode: filters.statusCode ?? null, requestId: filters.requestId ?? null,
  }))
}

async function encodeCursor(
  env: ObservabilityEnv,
  time: number,
  id: string,
  filterHashValue: string,
  startMs?: number,
  endMs?: number,
): Promise<string> {
  const unsigned = JSON.stringify({ v: 1, t: time, id, f: filterHashValue, a: startMs, z: endMs })
  const signature = await apiKeyDigest(`observability-cursor:v1\0${unsigned}`, cursorPepper(env))
  return base64UrlEncode(JSON.stringify({ v: 1, t: time, id, f: filterHashValue, a: startMs, z: endMs, s: signature }))
}

async function decodeCursor(env: ObservabilityEnv, raw: string): Promise<Cursor> {
  try {
    const parsed = JSON.parse(base64UrlDecode(raw)) as Record<string, unknown>
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.t) || typeof parsed.id !== 'string' ||
        typeof parsed.f !== 'string' || typeof parsed.s !== 'string') throw invalidCursor()
    if ((parsed.a !== undefined && !Number.isSafeInteger(parsed.a)) ||
        (parsed.z !== undefined && !Number.isSafeInteger(parsed.z))) throw invalidCursor()
    const unsigned = JSON.stringify({ v: 1, t: parsed.t, id: parsed.id, f: parsed.f, a: parsed.a, z: parsed.z })
    const expected = await apiKeyDigest(`observability-cursor:v1\0${unsigned}`, cursorPepper(env))
    if (!constantTimeEqual(expected, parsed.s)) throw invalidCursor()
    return {
      occurred_at_ms: parsed.t as number,
      id: parsed.id,
      filter_hash: parsed.f,
      ...(parsed.a === undefined ? {} : { start_ms: parsed.a as number }),
      ...(parsed.z === undefined ? {} : { end_ms: parsed.z as number }),
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw invalidCursor()
  }
}

function cursorPepper(env: ObservabilityEnv): string {
  if (!env.API_KEY_PEPPER || env.API_KEY_PEPPER.length < 32) {
    throw new GatewayError(503, 'observability_cursor_unavailable', 'Cursor signing is unavailable', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 2_048) throw invalidCursor()
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, (entry) => entry.charCodeAt(0)))
}

function parseDate(raw: string | undefined, endExclusive: boolean): number | undefined {
  if (raw === undefined || raw === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new GatewayError(400, 'invalid_date', 'Date must use YYYY-MM-DD')
  const value = Date.parse(`${raw}T00:00:00.000Z`)
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== raw) {
    throw new GatewayError(400, 'invalid_date', 'Date is invalid')
  }
  return endExclusive ? value + 86_400_000 : value
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const value = Date.parse(raw)
  if (!Number.isFinite(value)) throw new GatewayError(400, 'invalid_timestamp', 'Timestamp must use RFC3339')
  return value
}

function invalidCursor(): GatewayError {
  return new GatewayError(400, 'invalid_cursor', 'Cursor is invalid')
}

function notFound(): GatewayError {
  return new GatewayError(404, 'observation_not_found', 'Request observation was not found')
}
