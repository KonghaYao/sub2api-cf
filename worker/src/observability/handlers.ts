import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { authenticateAdminSession } from '../control/admin-auth'
import {
  controlError,
  controlSuccess,
  queryInteger,
  requireResourceId,
} from '../control/http'
import { apiKeyDigest, constantTimeEqual, sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  addCalendarDays,
  parseDate as parseCalendarDate,
  parseTimezone,
  zonedDayStart,
} from '../gateway/info'
import { observabilityBucket } from './recorder'
import type { ObservationRow, ObservabilityEnv, PayloadProjection } from './types'

type Bindings = { Bindings: ObservabilityEnv }
type View = 'owner' | 'admin'
type Family = 'all' | 'errors' | 'upstream'

const COLUMNS = `id, request_id, client_request_id, bucket_day, occurred_at_ms, completed_at_ms,
  lifecycle, user_id, api_key_id, account_id, group_id, method, request_path,
  inbound_endpoint, upstream_endpoint, client_ip, user_agent, platform, requested_model, upstream_model, request_type, stream,
  status_code, duration_ms, outcome, input_tokens, output_tokens, cache_read_tokens,
  amount_micros, error_phase, error_type, error_owner, error_source, severity,
  error_message, upstream_status_code, is_business_limited, resolved, resolved_at_ms,
  resolved_by_user_id, payload_state, payload_object_key, payload_sha256, payload_bytes,
  payload_content_type, payload_attempts, payload_retry_after_ms, payload_lease_id,
  payload_lease_expires_at_ms, payload_last_error, updated_at_ms,
  (SELECT COUNT(*) FROM request_observation_resolution_audit AS resolution_event
    WHERE resolution_event.observation_id = request_observations.id) AS resolution_version`
const ADMIN_COLUMNS = `${COLUMNS},
  (SELECT email FROM users WHERE users.id=request_observations.user_id) AS user_email,
  (SELECT name FROM api_keys WHERE api_keys.id=request_observations.api_key_id) AS api_key_name,
  (SELECT key_prefix FROM api_keys WHERE api_keys.id=request_observations.api_key_id) AS api_key_prefix,
  CASE WHEN request_observations.api_key_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM api_keys WHERE api_keys.id=request_observations.api_key_id AND api_keys.revoked_at_ms IS NULL)
    THEN 1 ELSE 0 END AS api_key_deleted,
  (SELECT name FROM accounts WHERE accounts.id=request_observations.account_id) AS account_name,
  (SELECT name FROM "groups" WHERE "groups".id=request_observations.group_id) AS group_name`
const OWNER_COLUMNS = `${COLUMNS},
  (SELECT name FROM api_keys WHERE api_keys.id=request_observations.api_key_id) AS api_key_name,
  CASE WHEN request_observations.api_key_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM api_keys WHERE api_keys.id=request_observations.api_key_id AND api_keys.revoked_at_ms IS NULL)
    THEN 1 ELSE 0 END AS api_key_deleted,
  (SELECT name FROM "groups" WHERE "groups".id=request_observations.group_id) AS group_name`

interface ListFilters {
  limit: number
  page?: number
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
  errorPhase?: string
  errorCategory?: string
  errorOwner?: string
  errorSource?: string
  resolved?: boolean
  view?: 'errors' | 'excluded' | 'all'
  query?: string
  statusCodes?: number[]
  statusCodesOther?: boolean
  requestKind?: 'all' | 'success' | 'error'
  minDurationMs?: number
  maxDurationMs?: number
  sortColumn?: 'occurred_at_ms' | 'status_code' | 'COALESCE(upstream_status_code,status_code)' | 'requested_model' | 'duration_ms'
  sortDirection?: 'ASC' | 'DESC'
  modelFuzzy?: boolean
  family: Family
}

interface Cursor {
  occurred_at_ms: number
  id: string
  filter_hash: string
  start_ms?: number
  end_ms?: number
}

interface ResolutionAuditRow {
  id: string
  actor_user_id: string
  resolved: number
  occurred_at_ms: number
}

export const listOwnerRequests = (context: Context<Bindings>) => listFor(context, 'owner', 'all', 'usage')
export const listOwnerErrors = (context: Context<Bindings>) => listFor(
  context, 'owner', 'errors', 'usage', true, true,
)
export const listAdminUsage = (context: Context<Bindings>) => {
  if (context.req.query('page') !== undefined || context.req.query('page_size') !== undefined) {
    return listAdminUsageProjection(context)
  }
  return listFor(context, 'admin', 'all', 'usage')
}
export const listAdminRequests = (context: Context<Bindings>) => listFor(context, 'admin', 'all', 'ops', true)
export const listAdminRequestErrors = (context: Context<Bindings>) => listFor(context, 'admin', 'errors', 'ops', true)
export const listAdminUpstreamErrors = (context: Context<Bindings>) => listFor(context, 'admin', 'upstream', 'ops', true)

export async function getAdminUsageStats(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const { clauses, values } = adminUsageClauses(context)
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const [summary, endpoints] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) total_requests,
        COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
        COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
        COALESCE(SUM(COALESCE(standard_cost_micros,amount_micros)),0) standard_micros,
        COALESCE(SUM(amount_micros),0) amount_micros,
        COALESCE(SUM(COALESCE(account_cost_micros,account_stats_cost_micros,amount_micros)),0) account_micros,
        CAST(ROUND(AVG(duration_ms)) AS INTEGER) average_duration_ms
        FROM usage_projection u ${where}`).bind(...values),
      context.env.DB.prepare(`SELECT inbound_endpoint endpoint,COUNT(*) requests,
        COALESCE(SUM(input_tokens+output_tokens),0) tokens,
        COALESCE(SUM(COALESCE(standard_cost_micros,amount_micros)),0) standard_micros,
        COALESCE(SUM(amount_micros),0) amount_micros
        FROM usage_projection u ${where}${where === '' ? 'WHERE' : ' AND'} inbound_endpoint <> ''
        GROUP BY inbound_endpoint ORDER BY amount_micros DESC,inbound_endpoint ASC LIMIT 100`).bind(...values),
    ])
    const row = (summary.results[0] ?? {}) as Record<string, unknown>
    const input = safeInteger(row.input_tokens)
    const output = safeInteger(row.output_tokens)
    const cache = safeInteger(row.cache_read_tokens)
    return controlSuccess({
      total_requests: safeInteger(row.total_requests),
      total_input_tokens: Math.max(0, input - cache - safeInteger(row.cache_write_tokens)),
      total_output_tokens: output,
      total_cache_tokens: safeSum(cache, safeInteger(row.cache_write_tokens)),
      total_cache_creation_tokens: safeInteger(row.cache_write_tokens),
      total_cache_read_tokens: cache,
      total_tokens: safeSum(input, output),
      total_cost: usdValue(row.standard_micros),
      total_actual_cost: usdValue(row.amount_micros),
      total_account_cost: usdValue(row.account_micros),
      average_duration_ms: safeInteger(row.average_duration_ms),
      endpoints: endpoints.results.map((item: any) => ({
        endpoint: item.endpoint,
        requests: safeInteger(item.requests),
        total_tokens: safeInteger(item.tokens),
        cost: usdValue(item.standard_micros),
        actual_cost: usdValue(item.amount_micros),
      })),
    })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function getAdminUsageModels(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const source = context.req.query('model_source')?.trim() || 'requested'
    const expressions: Record<string, string> = {
      requested: `COALESCE(NULLIF(TRIM(u.requested_model),''),u.model)`,
      upstream: `COALESCE(NULLIF(TRIM(u.upstream_model),''),COALESCE(NULLIF(TRIM(u.requested_model),''),u.model))`,
      mapping: `(COALESCE(NULLIF(TRIM(u.requested_model),''),u.model) || ' -> ' || COALESCE(NULLIF(TRIM(u.upstream_model),''),COALESCE(NULLIF(TRIM(u.requested_model),''),u.model)))`,
    }
    if (!Object.hasOwn(expressions, source)) {
      throw new GatewayError(400, 'invalid_model_source', 'model_source must be requested, upstream, or mapping')
    }
    const { clauses, values } = adminUsageClauses(context)
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const model = expressions[source]!
    const rows = await context.env.DB.prepare(`SELECT ${model} model,COUNT(*) requests,
      COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
      COALESCE(SUM(cache_write_tokens),0) cache_creation_tokens,COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
      COALESCE(SUM(input_tokens+output_tokens),0) total_tokens,
      COALESCE(SUM(COALESCE(standard_cost_micros,amount_micros)),0) standard_micros,
      COALESCE(SUM(amount_micros),0) amount_micros,
      COALESCE(SUM(COALESCE(account_cost_micros,account_stats_cost_micros,amount_micros)),0) account_micros
      FROM usage_projection u ${where}
      GROUP BY ${model} ORDER BY total_tokens DESC,model ASC LIMIT 500`).bind(...values).all<any>()
    return controlSuccess({
      models: rows.results.map((row) => ({
        model: row.model,
        requests: safeInteger(row.requests),
        input_tokens: Math.max(0, safeInteger(row.input_tokens) - safeInteger(row.cache_read_tokens) - safeInteger(row.cache_write_tokens)),
        output_tokens: safeInteger(row.output_tokens),
        cache_creation_tokens: safeInteger(row.cache_write_tokens),
        cache_read_tokens: safeInteger(row.cache_read_tokens),
        total_tokens: safeInteger(row.total_tokens),
        cost: usdValue(row.standard_micros),
        actual_cost: usdValue(row.amount_micros),
        account_cost: usdValue(row.account_micros),
      })),
      start_date: context.req.query('start_date') ?? '',
      end_date: context.req.query('end_date') ?? '',
    })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function searchAdminUsageUsers(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const query = searchQuery(context.req.query('q'))
    const rows = await context.env.DB.prepare(
      `SELECT id,email,status FROM users WHERE email LIKE ? ESCAPE '\\' ORDER BY email COLLATE NOCASE,id LIMIT 30`,
    ).bind(`%${query}%`).all<any>()
    return controlSuccess(rows.results.map((row) => ({ id: row.id, email: row.email, deleted: false })))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function searchAdminUsageApiKeys(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const clauses: string[] = []
    const values: unknown[] = []
    const userId = context.req.query('user_id')?.trim()
    if (userId) { clauses.push('user_id = ?'); values.push(userId) }
    const query = searchQuery(context.req.query('q'), true)
    if (query !== '') { clauses.push(`name LIKE ? ESCAPE '\\'`); values.push(`%${query}%`) }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const rows = await context.env.DB.prepare(
      `SELECT id,name,user_id FROM api_keys ${where} ORDER BY name COLLATE NOCASE,id LIMIT 30`,
    ).bind(...values).all<any>()
    return controlSuccess(rows.results.map((row) => ({ id: row.id, name: row.name, user_id: row.user_id })))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function unsupportedAdminUsageCleanup(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    throw new GatewayError(501, 'usage_cleanup_not_migrated', 'Usage cleanup is not available on the Worker yet')
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function unsupportedAdminUsageAnalytics(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    throw new GatewayError(501, 'admin_usage_analytics_not_migrated', 'Admin usage analytics are not available on the Worker yet')
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function unsupportedAdminOps(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    throw new GatewayError(
      501,
      'admin_ops_contract_not_migrated',
      `Ops contract is not available on the Worker yet: ${context.req.method} ${context.req.path}`,
    )
  } catch (error) { return controlError(asGatewayError(error)) }
}

function searchQuery(value: string | undefined, allowEmpty = false): string {
  const query = value?.trim() ?? ''
  if ((!allowEmpty && query === '') || query.length > 200) throw new GatewayError(400, 'invalid_search_query', 'Search query is invalid')
  return query.replace(/[\\%_]/g, (character) => `\\${character}`)
}

export const getOwnerRequestDetail = (context: Context<Bindings>) => ownerDetail(context, 'all')
export const getOwnerErrorDetail = (context: Context<Bindings>) => ownerDetail(context, 'errors')
export const getAdminRequestDetail = (context: Context<Bindings>) => adminDetail(context, 'all')
export const getAdminRequestErrorDetail = (context: Context<Bindings>) => adminDetail(context, 'errors')
export const getAdminUpstreamErrorDetail = (context: Context<Bindings>) => adminDetail(context, 'upstream')

async function requireOwnerErrorVisibility(env:ObservabilityEnv):Promise<void>{
 const row=await env.DB.prepare("SELECT public_json FROM system_settings WHERE id='global'").first<{public_json:string}>()
 if(!row||JSON.parse(row.public_json).allow_user_view_error_requests!==true)throw new GatewayError(403,'user_error_requests_disabled','User error request visibility is disabled','permission_error')
}

async function ownerDetail(context: Context<Bindings>, family: Family): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    if(family==='errors')await requireOwnerErrorVisibility(context.env)
    const row = await findObservation(context.env, requireResourceId(context.req.param('id'), 'observation'), user.id)
    if (row === null || !rowMatchesFamily(row, family)) throw notFound()
    const payload = await projectPayload(context.env, row)
    const legacy = legacyPayloadProjection(payload)
    return controlSuccess({
      ...projectRow(row, 'owner'),
      upstream_status_code: row.upstream_status_code ?? undefined,
      error_body: typeof legacy.error_body === 'string' ? legacy.error_body : '',
      payload,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function adminDetail(context: Context<Bindings>, family: Family): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const row = await findAdminObservation(context.env, requireResourceId(context.req.param('id'), 'observation'))
    if (row === null || !rowMatchesFamily(row, family)) throw notFound()
    const audit = await context.env.DB.prepare(
      `SELECT id, actor_user_id, resolved, occurred_at_ms
         FROM request_observation_resolution_audit
        WHERE observation_id = ?
        ORDER BY occurred_at_ms DESC, id DESC
        LIMIT 101`,
    ).bind(row.id).all<ResolutionAuditRow>()
    const payload = await projectPayload(context.env, row)
    const response = controlSuccess({
      ...projectRow(row, 'admin'),
      payload,
      ...legacyPayloadProjection(payload),
      resolution_audit: audit.results.slice(0, 100).map(projectResolutionAudit),
      resolution_audit_truncated: audit.results.length > 100,
    })
    response.headers.set('etag', `"${row.resolution_version}"`)
    return response
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
    const filters = await parseFilters(context, 'upstream', 'ops', undefined, false, true)
    const includeDetail = parseOptionalBoolean(context.req.query('include_detail'), 'include_detail') ?? false
    const clauses = [
      `id <> ?`,
      `lifecycle = 'failed'`,
      `error_phase IN ('upstream', 'account_auth', 'network')`,
      `error_owner = 'provider'`,
      `request_id = ?`,
    ]
    const values: unknown[] = [id, source.request_id]
    addSharedClauses(filters, clauses, values)
    return await listResponse(context.env, filters, clauses, values, 'admin', includeDetail)
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
  legacyOffset = false,
  ownerErrorContract = false,
): Promise<Response> {
  try {
    let owner: string | undefined
    if (view === 'owner') owner = (await authenticateUserRequest(context.req.raw, context.env)).id
    else await authenticateAdminSession(context.req.raw, context.env)
    if(view==='owner'&&family==='errors')await requireOwnerErrorVisibility(context.env)
    const filters = await parseFilters(
      context, family, timeContract, owner, true, legacyOffset, ownerErrorContract,
    )
    const clauses: string[] = []
    const values: unknown[] = []
    addFamilyClause(family, clauses)
    if (family === 'all' && timeContract === 'ops') clauses.push(`lifecycle IN ('completed','failed')`)
    if (ownerErrorContract) {
      // The original user view deliberately includes business/quota failures and
      // excludes internal count-token probes from the user's request history.
      filters.view = 'all'
      filters.modelFuzzy = true
      clauses.push(`request_path NOT LIKE '%/count_tokens' COLLATE NOCASE`)
    }
    addSharedClauses(filters, clauses, values)
    return await listResponse(context.env, filters, clauses, values, view)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

const ADMIN_USAGE_COLUMNS = `u.event_id,u.request_id,u.user_id,u.api_key_id,u.account_id,
  COALESCE(u.requested_model,u.model) model,u.upstream_model,u.group_id,u.subscription_id,
  u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens,u.cache_write_5m_tokens,u.cache_write_1h_tokens,u.input_amount_micros,u.output_amount_micros,
  u.cache_amount_micros,u.base_amount_micros,u.amount_micros,u.billing_type,u.outcome,u.stream,
  u.duration_ms,u.occurred_at_ms,u.platform,u.request_type,u.inbound_endpoint,u.upstream_endpoint,
  u.billing_mode,u.native_compaction_v2,u.dimensions_version,u.image_count,u.image_size,
  u.image_input_size,u.image_output_size,u.image_size_source,u.image_size_breakdown,
  u.standard_cost_micros,u.account_stats_cost_micros,u.account_rate_multiplier_ppm,u.account_cost_micros,
  users.email user_email,api_keys.name api_key_name,accounts.name account_name,"groups".name group_name`

async function listAdminUsageProjection(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    if (context.req.query('cursor') !== undefined || context.req.query('limit') !== undefined) {
      throw new GatewayError(400, 'pagination_mode_conflict', 'Offset pagination cannot be combined with a cursor')
    }
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const { clauses, values } = adminUsageClauses(context)
    const order = adminUsageOrder(context)
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const [count, rows] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) total FROM usage_projection u ${where}`).bind(...values),
      context.env.DB.prepare(`SELECT ${ADMIN_USAGE_COLUMNS}
        FROM usage_projection u
        LEFT JOIN users ON users.id=u.user_id
        LEFT JOIN api_keys ON api_keys.id=u.api_key_id
        LEFT JOIN accounts ON accounts.id=u.account_id
        LEFT JOIN "groups" ON "groups".id=u.group_id
        ${where}
        ORDER BY ${order.column} ${order.direction}, u.event_id ${order.direction}
        LIMIT ? OFFSET ?`).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const total = safeInteger((count.results[0] as Record<string, unknown> | undefined)?.total)
    return controlSuccess({
      items: rows.results.map(adminUsageRow),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export function adminUsageClauses(context: Context<Bindings>): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = []
  const values: unknown[] = []
  const exact = (name: string, column: string) => {
    const value = context.req.query(name)?.trim()
    if (!value) return
    if (value.length > 200) throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
    clauses.push(`${column} = ?`)
    values.push(value)
  }
  exact('user_id', 'u.user_id')
  exact('api_key_id', 'u.api_key_id')
  exact('account_id', 'u.account_id')
  exact('group_id', 'u.group_id')
  const model = context.req.query('model')?.trim()
  if (model) {
    if (model.length > 200) throw new GatewayError(400, 'invalid_model', 'model is invalid')
    clauses.push('COALESCE(u.requested_model,u.model) = ?')
    values.push(model)
  }
  const timezone = parseTimezone(context.req.query('timezone'))
  const start = parseUsageDate(context.req.query('start_date'), timezone, false)
  const end = parseUsageDate(context.req.query('end_date'), timezone, true)
  if (start !== undefined) { clauses.push('u.occurred_at_ms >= ?'); values.push(start) }
  if (end !== undefined) { clauses.push('u.occurred_at_ms < ?'); values.push(end) }
  if (start !== undefined && end !== undefined && start >= end) {
    throw new GatewayError(400, 'invalid_time_range', 'Time range is invalid')
  }
  const requestType = context.req.query('request_type')?.trim()
  const stream = context.req.query('stream')?.trim()
  if (requestType) {
    const requestTypes: Record<string, number> = { unknown: 0, sync: 1, stream: 2, ws_v2: 3, cyber: 4, live: 5 }
    if (!Object.hasOwn(requestTypes, requestType)) throw new GatewayError(400, 'invalid_request_type', 'request_type is invalid')
    const value = requestTypes[requestType]!
    if (value === 1 || value === 2) {
      clauses.push('(u.request_type = ? OR (u.request_type = 0 AND u.dimensions_version = 0 AND u.stream = ?))')
      values.push(value, value === 2 ? 1 : 0)
    } else {
      clauses.push('u.request_type = ?')
      values.push(value)
    }
  } else if (stream) {
    const value = queryBooleanValue(stream, 'stream')
    clauses.push('u.stream = ?')
    values.push(value ? 1 : 0)
  }
  const compact = context.req.query('native_compaction_v2')?.trim()
  if (compact) {
    clauses.push('u.native_compaction_v2 = ?')
    values.push(queryBooleanValue(compact, 'native_compaction_v2') ? 1 : 0)
  }
  const billingType = context.req.query('billing_type')?.trim()
  if (billingType) {
    if (!['0', '1', 'balance', 'subscription'].includes(billingType)) throw new GatewayError(400, 'invalid_billing_type', 'billing_type is invalid')
    clauses.push('u.billing_type = ?')
    values.push(billingType === '1' ? 'subscription' : billingType === '0' ? 'balance' : billingType)
  }
  const billingMode = context.req.query('billing_mode')?.trim()
  if (billingMode) {
    if (!['token', 'per_request', 'image', 'video'].includes(billingMode)) throw new GatewayError(400, 'invalid_billing_mode', 'billing_mode is invalid')
    clauses.push('u.billing_mode = ?')
    values.push(billingMode)
  }
  const mismatch = context.req.query('upstream_model_mismatch')?.trim()
  if (mismatch && queryBooleanValue(mismatch, 'upstream_model_mismatch')) {
    throw new GatewayError(501, 'upstream_model_audit_not_migrated', 'Upstream response model evidence is not retained by this Worker')
  }
  const exactTotal = context.req.query('exact_total')?.trim()
  if (exactTotal) queryBooleanValue(exactTotal, 'exact_total')
  return { clauses, values }
}

function adminUsageOrder(context: Context<Bindings>): { column: string; direction: 'ASC' | 'DESC' } {
  const key = context.req.query('sort_by') ?? 'created_at'
  const direction = context.req.query('sort_order') ?? 'desc'
  const columns: Record<string, string> = {
    created_at: 'u.occurred_at_ms',
    model: 'COALESCE(u.requested_model,u.model)',
  }
  if (!Object.hasOwn(columns, key)) throw new GatewayError(400, 'unsupported_usage_sort', 'sort_by is not supported')
  if (direction !== 'asc' && direction !== 'desc') throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
  return { column: columns[key]!, direction: direction.toUpperCase() as 'ASC' | 'DESC' }
}

function queryBooleanValue(value: string, name: string): boolean {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
}

function adminUsageRow(value: unknown): Record<string, unknown> {
  const row = value as Record<string, any>
  const amountMicros = safeInteger(row.amount_micros)
  const standardMicros = row.standard_cost_micros == null ? amountMicros : safeInteger(row.standard_cost_micros)
  const requestedModel = String(row.model ?? '')
  const upstreamModel = typeof row.upstream_model === 'string' && row.upstream_model !== '' ? row.upstream_model : requestedModel
  return {
    id: row.event_id,
    user_id: row.user_id,
    api_key_id: row.api_key_id,
    account_id: row.account_id,
    request_id: row.request_id,
    model: requestedModel,
    upstream_model: upstreamModel,
    upstream_response_model: null,
    upstream_model_mismatch: null,
    group_id: row.group_id,
    subscription_id: row.subscription_id,
    input_tokens: Math.max(0, safeInteger(row.input_tokens) - safeInteger(row.cache_read_tokens) - safeInteger(row.cache_write_tokens)),
    output_tokens: safeInteger(row.output_tokens),
    cache_creation_tokens: safeInteger(row.cache_write_tokens),
    cache_read_tokens: safeInteger(row.cache_read_tokens),
    cache_creation_5m_tokens: safeInteger(row.cache_write_5m_tokens),
    cache_creation_1h_tokens: safeInteger(row.cache_write_1h_tokens),
    input_cost: usdValue(row.input_amount_micros),
    output_cost: usdValue(row.output_amount_micros),
    cache_creation_cost: 0,
    cache_read_cost: usdValue(row.cache_amount_micros),
    total_cost: standardMicros / 1_000_000,
    actual_cost: amountMicros / 1_000_000,
    rate_multiplier: standardMicros === 0 ? 1 : amountMicros / standardMicros,
    account_rate_multiplier: row.account_rate_multiplier_ppm == null ? null : safeInteger(row.account_rate_multiplier_ppm) / 1_000_000,
    account_stats_cost: row.account_stats_cost_micros == null ? null : usdValue(row.account_stats_cost_micros),
    long_context_billing_applied: false,
    billing_type: row.billing_type === 'subscription' ? 1 : 0,
    request_type: requestTypeName(row.request_type, row.stream, row.dimensions_version),
    stream: row.stream === 1,
    native_compaction_v2: row.native_compaction_v2 === 1,
    duration_ms: row.duration_ms,
    first_token_ms: null,
    image_count: safeInteger(row.image_count),
    image_size: nullableText(row.image_size),
    image_input_size: nullableText(row.image_input_size),
    image_output_size: nullableText(row.image_output_size),
    image_size_source: nullableText(row.image_size_source),
    image_size_breakdown: imageBreakdown(row.image_size_breakdown),
    image_input_tokens: 0,
    image_input_cost: 0,
    image_output_tokens: 0,
    image_output_cost: 0,
    user_agent: null,
    ip_address: null,
    cache_ttl_overridden: false,
    billing_mode: row.billing_mode || 'token',
    inbound_endpoint: nullableText(row.inbound_endpoint),
    upstream_endpoint: nullableText(row.upstream_endpoint),
    created_at: new Date(safeInteger(row.occurred_at_ms)).toISOString(),
    user: row.user_id == null ? undefined : { id: row.user_id, email: row.user_email ?? '', deleted: false },
    api_key: row.api_key_id == null ? undefined : { id: row.api_key_id, name: row.api_key_name ?? '', user_id: row.user_id },
    account: row.account_id == null ? undefined : { id: row.account_id, name: row.account_name ?? '' },
    group: row.group_id == null ? undefined : { id: row.group_id, name: row.group_name ?? '' },
  }
}

function safeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function safeSum(...values: unknown[]): number {
  const sum = values.reduce<number>((total, value) => total + safeInteger(value), 0)
  if (!Number.isSafeInteger(sum)) throw new GatewayError(503, 'invalid_usage_projection', 'Usage information is unavailable', 'server_error')
  return sum
}

function usdValue(value: unknown): number { return safeInteger(value) / 1_000_000 }
function nullableText(value: unknown): string | null { return typeof value === 'string' && value !== '' ? value : null }
function requestTypeName(value: unknown, stream: unknown, dimensionsVersion: unknown): string {
  const names = ['unknown', 'sync', 'stream', 'ws_v2', 'cyber', 'live']
  if (value === 0 && dimensionsVersion === 0) return stream === 1 ? 'stream' : 'sync'
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < names.length ? names[Number(value)]! : 'unknown'
}
function imageBreakdown(value: unknown): Record<string, number> | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const result: Record<string, number> = {}
    for (const tier of ['1K', '2K', '4K']) if (Number.isSafeInteger(parsed[tier]) && Number(parsed[tier]) > 0) result[tier] = Number(parsed[tier])
    return Object.keys(result).length === 0 ? null : result
  } catch { return null }
}

async function listResponse(
  env: ObservabilityEnv,
  filters: ListFilters,
  clauses: string[],
  values: unknown[],
  view: View,
  includeDetail = false,
): Promise<Response> {
  const columns = view === 'admin' ? ADMIN_COLUMNS : OWNER_COLUMNS
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  if (filters.page !== undefined) {
    const sortColumn = filters.sortColumn ?? 'occurred_at_ms'
    const sortDirection = filters.sortDirection ?? 'DESC'
    const orderBy = sortColumn === 'duration_ms'
      ? 'duration_ms DESC, occurred_at_ms DESC, id DESC'
      : `${sortColumn} ${sortDirection}, id ${sortDirection}`
    const [count, rows] = await env.DB.batch([
      env.DB.prepare(`SELECT COUNT(*) AS total FROM request_observations ${where}`).bind(...values),
      env.DB.prepare(`SELECT ${columns} FROM request_observations ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(...values, filters.limit, (filters.page - 1) * filters.limit),
    ])
    const total = Number((count.results[0] as { total?: unknown } | undefined)?.total ?? 0)
    return controlSuccess({
      items: await projectRows(env, rows.results as ObservationRow[], view, includeDetail),
      total,
      page: filters.page,
      page_size: filters.limit,
      pages: total === 0 ? 0 : Math.ceil(total / filters.limit),
    })
  }
  const result = await env.DB.prepare(
    `SELECT ${columns} FROM request_observations ${where}
      ORDER BY occurred_at_ms DESC, id DESC LIMIT ?`,
  ).bind(...values, filters.limit + 1).all<ObservationRow>()
  const hasMore = result.results.length > filters.limit
  const page = result.results.slice(0, filters.limit)
  const last = page.at(-1)
  return controlSuccess({
    items: await projectRows(env, page, view, includeDetail),
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
  legacyOffset = false,
  ownerErrorContract = false,
): Promise<ListFilters> {
  validateOpsQueryParameters(context, family, timeContract)
  const offsetRequested =
    legacyOffset && (context.req.query('page') !== undefined || context.req.query('page_size') !== undefined)
  if (offsetRequested && (context.req.query('cursor') !== undefined || context.req.query('limit') !== undefined)) {
    throw new GatewayError(400, 'pagination_mode_conflict', 'Offset pagination cannot be combined with a cursor')
  }
  for (const legacy of ['page', 'page_size', 'sort_by', 'sort_order', 'q', 'user_query', 'kind', 'sort', 'min_duration_ms', 'max_duration_ms']) {
    if (offsetRequested && context.req.query(legacy) !== undefined) continue
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
  if (offsetRequested) {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    filters.limit = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    if (!ownerErrorContract && (page - 1) * filters.limit > 10_000) {
      throw new GatewayError(400, 'ops_offset_too_deep', 'Ops offset pagination is limited to 10,000 rows')
    }
    filters.page = page
    const sortBy = context.req.query('sort_by') ?? 'created_at'
    const sortOrder = context.req.query('sort_order') ?? 'desc'
    const sortColumns: Record<string, ListFilters['sortColumn']> = {
      created_at: 'occurred_at_ms', status: 'COALESCE(upstream_status_code,status_code)', status_code: 'COALESCE(upstream_status_code,status_code)', model: 'requested_model',
    }
    if (!Object.hasOwn(sortColumns, sortBy) && !ownerErrorContract) {
      throw new GatewayError(400, 'unsupported_error_sort', 'sort_by is not supported')
    }
    if (sortOrder !== 'asc' && sortOrder !== 'desc' && !ownerErrorContract) {
      throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
    }
    filters.sortColumn = sortColumns[sortBy] ?? 'occurred_at_ms'
    filters.sortDirection = sortOrder === 'asc' ? 'ASC' : 'DESC'
  }
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
  filters.errorPhase = exact('phase', 32)
  filters.errorCategory = exact('category', 32)
  filters.errorOwner = exact('error_owner', 32)?.toLowerCase()
  filters.errorSource = exact('error_source', 32)?.toLowerCase()
  filters.query = exact('q', 200)
  filters.resolved = parseOptionalBoolean(context.req.query('resolved'), 'resolved')
  const view = exact('view', 16)?.toLowerCase()
  if (view !== undefined) {
    if (view !== 'errors' && view !== 'excluded' && view !== 'all') {
      throw new GatewayError(400, 'invalid_view', 'view must be errors, excluded, or all')
    }
    filters.view = view
  }
  filters.statusCodes = parseStatusCodes(context.req.query('status_codes'))
  filters.statusCodesOther = parseOptionalBoolean(context.req.query('status_codes_other'), 'status_codes_other')
  if (filters.statusCodes !== undefined && filters.statusCodesOther === true) {
    throw new GatewayError(400, 'invalid_status_filter', 'status_codes and status_codes_other cannot be combined')
  }
  if (family === 'all' && timeContract === 'ops') {
    const kind = exact('kind', 16)?.toLowerCase() ?? 'all'
    if (kind !== 'all' && kind !== 'success' && kind !== 'error') {
      throw new GatewayError(400, 'invalid_request_kind', 'kind must be all, success, or error')
    }
    filters.requestKind = kind
    filters.minDurationMs = optionalBoundedInteger(context.req.query('min_duration_ms'), 'min_duration_ms', 0, 86_400_000)
    filters.maxDurationMs = optionalBoundedInteger(context.req.query('max_duration_ms'), 'max_duration_ms', 0, 86_400_000)
    if (filters.minDurationMs !== undefined && filters.maxDurationMs !== undefined && filters.minDurationMs > filters.maxDurationMs) {
      throw new GatewayError(400, 'invalid_duration_range', 'Duration range is invalid')
    }
    const requestSort = exact('sort', 32) ?? 'created_at_desc'
    if (requestSort !== 'created_at_desc' && requestSort !== 'duration_desc') {
      throw new GatewayError(400, 'invalid_request_sort', 'sort must be created_at_desc or duration_desc')
    }
    filters.sortColumn = requestSort === 'duration_desc' ? 'duration_ms' : 'occurred_at_ms'
    filters.sortDirection = 'DESC'
  }
  if (forcedUserId !== undefined) filters.userId = forcedUserId
  const status = exact('status_code', 3)
  if (status !== undefined) {
    if (!/^\d{3}$/.test(status) || Number(status) < 100 || Number(status) > 599) {
      throw new GatewayError(400, 'invalid_status_code', 'status_code is invalid')
    }
    filters.statusCode = Number(status)
  }
  if (timeContract === 'usage') {
    const timezone = parseTimezone(context.req.query('timezone'))
    const startDate = context.req.query('start_date')
    const endDate = context.req.query('end_date')
    filters.startMs = (startDate === undefined || startDate === ''
      ? undefined
      : zonedDayStart(parseCalendarDate(startDate), timezone)) ?? cursor?.start_ms
    filters.endMs = (endDate === undefined || endDate === ''
      ? undefined
      : zonedDayStart(addCalendarDays(parseCalendarDate(endDate), 1), timezone)) ?? cursor?.end_ms
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
  if (
    filters.query !== undefined && filters.startMs !== undefined && filters.endMs !== undefined &&
    filters.endMs - filters.startMs > 24 * 60 * 60 * 1_000
  ) {
    throw new GatewayError(422, 'ops_search_window_too_wide', 'Ops fuzzy search is limited to a 24 hour window')
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
    ['platform', filters.platform],
    ['request_id', filters.requestId],
  ]
  for (const [column, value] of equality) {
    if (value === undefined) continue
    clauses.push(`${column} = ?`)
    values.push(value)
  }
  if (filters.model !== undefined) {
    if (filters.modelFuzzy) {
      clauses.push(`requested_model LIKE ? ESCAPE '\\' COLLATE NOCASE`)
      values.push(`%${escapeLike(filters.model)}%`)
    } else {
      clauses.push('requested_model = ?')
      values.push(filters.model)
    }
  }
  if (filters.statusCode !== undefined) {
    clauses.push('COALESCE(upstream_status_code,status_code) = ?')
    values.push(filters.statusCode)
  }
  if (filters.errorPhase !== undefined) {
    clauses.push('error_phase = ?')
    values.push(filters.errorPhase)
  }
  if (filters.errorCategory !== undefined) addErrorCategoryClause(filters.errorCategory, clauses)
  if (filters.errorOwner !== undefined) {
    clauses.push('LOWER(error_owner) = ?')
    values.push(filters.errorOwner)
  }
  if (filters.errorSource !== undefined) {
    clauses.push('LOWER(error_source) = ?')
    values.push(filters.errorSource)
  }
  if (filters.resolved !== undefined) {
    clauses.push('resolved = ?')
    values.push(filters.resolved ? 1 : 0)
  }
  if (filters.family !== 'all') {
    const view = filters.view ?? 'errors'
    if (view === 'errors') clauses.push('is_business_limited = 0')
    else if (view === 'excluded') clauses.push('is_business_limited = 1')
  }
  if (filters.statusCodes !== undefined) {
    clauses.push(`COALESCE(upstream_status_code,status_code,0) IN (${filters.statusCodes.map(() => '?').join(',')})`)
    values.push(...filters.statusCodes)
  } else if (filters.statusCodesOther === true) {
    const known = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504, 529]
    clauses.push(`COALESCE(upstream_status_code,status_code,0) NOT IN (${known.map(() => '?').join(',')})`)
    values.push(...known)
  }
  if (filters.query !== undefined) {
    const like = `%${escapeLike(filters.query)}%`
    clauses.push(`(
      request_id LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      COALESCE(client_request_id,'') LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      requested_model LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      error_message LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      COALESCE(user_id,'') LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      EXISTS (SELECT 1 FROM users WHERE users.id=request_observations.user_id AND users.email LIKE ? ESCAPE '\\' COLLATE NOCASE)
    )`)
    values.push(like, like, like, like, like, like)
  }
  if (filters.requestKind === 'error') clauses.push(`lifecycle = 'failed'`)
  if (filters.requestKind === 'success') clauses.push(`lifecycle <> 'failed'`)
  if (filters.minDurationMs !== undefined) { clauses.push('duration_ms >= ?'); values.push(filters.minDurationMs) }
  if (filters.maxDurationMs !== undefined) { clauses.push('duration_ms <= ?'); values.push(filters.maxDurationMs) }
  if (filters.startMs !== undefined) { clauses.push('occurred_at_ms >= ?'); values.push(filters.startMs) }
  if (filters.endMs !== undefined) { clauses.push('occurred_at_ms < ?'); values.push(filters.endMs) }
  if (filters.cursor !== undefined) {
    clauses.push('(occurred_at_ms < ? OR (occurred_at_ms = ? AND id < ?))')
    values.push(filters.cursor.occurred_at_ms, filters.cursor.occurred_at_ms, filters.cursor.id)
  }
}

function addErrorCategoryClause(category: string, clauses: string[]): void {
  const categoryClauses: Record<string, string> = {
    auth: `error_phase = 'auth'`,
    rate_limit: `error_phase = 'request' AND error_type = 'rate_limit_error'`,
    quota: `error_phase = 'request' AND error_type IN ('billing_error','subscription_error')`,
    invalid_request: `error_phase = 'request' AND error_type = 'invalid_request_error'`,
    service_unavailable: `error_phase = 'routing'`,
    upstream: `error_phase IN ('account_auth','upstream','network')`,
    internal: `error_phase = 'internal'`,
    cyber: `error_phase = 'request' AND error_type = 'cyber_policy'`,
  }
  const clause = categoryClauses[category]
  if (clause === undefined) throw new GatewayError(400, 'invalid_category', 'category is invalid')
  clauses.push(clause)
}

async function findObservation(
  env: ObservabilityEnv,
  id: string,
  userId?: string,
): Promise<ObservationRow | null> {
  const columns = userId === undefined ? COLUMNS : OWNER_COLUMNS
  return env.DB.prepare(
    `SELECT ${columns} FROM request_observations WHERE id = ?${userId === undefined ? '' : ' AND user_id = ?'}`,
  ).bind(id, ...(userId === undefined ? [] : [userId])).first<ObservationRow>()
}

async function findAdminObservation(
  env: ObservabilityEnv,
  id: string,
): Promise<ObservationRow | null> {
  return env.DB.prepare(
    `SELECT ${ADMIN_COLUMNS} FROM request_observations WHERE id = ?`,
  ).bind(id).first<ObservationRow>()
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
    error_id: row.lifecycle === 'failed' ? row.id : undefined,
    kind: row.lifecycle === 'failed' ? 'error' : 'success',
    created_at: new Date(row.occurred_at_ms).toISOString(),
    request_id: row.request_id,
    client_request_id: row.client_request_id,
    method: row.method,
    request_path: row.request_path,
    inbound_endpoint: row.inbound_endpoint,
    upstream_endpoint: row.upstream_endpoint,
    client_ip: row.client_ip,
    user_agent: row.user_agent,
    platform: row.platform,
    model: row.requested_model,
    requested_model: row.requested_model,
    status_code: row.upstream_status_code ?? row.status_code,
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
    resolved_at: row.resolved_at_ms === null ? null : new Date(row.resolved_at_ms).toISOString(),
    resolved_by_user_id: row.resolved_by_user_id,
    control_version: row.resolution_version,
    user_email: (row as any).user_email ?? undefined,
    api_key_name: (row as any).api_key_name ?? undefined,
    api_key_prefix: (row as any).api_key_prefix ?? undefined,
    api_key_deleted: (row as any).api_key_deleted === 1,
    account_name: (row as any).account_name ?? undefined,
    group_name: (row as any).group_name ?? undefined,
  })
  else Object.assign(base, {
    key_name: (row as any).api_key_name ?? '',
    key_deleted: (row as any).api_key_deleted === 1,
    ...((row as any).group_name == null ? {} : { group_name: (row as any).group_name }),
  })
  return base
}

async function projectRows(
  env: ObservabilityEnv,
  rows: ObservationRow[],
  view: View,
  includeDetail: boolean,
): Promise<Record<string, unknown>[]> {
  if (!includeDetail) return rows.map((row) => projectRow(row, view))
  return Promise.all(rows.map(async (row) => {
    const fullPayload = await projectPayload(env, row)
    const payload = boundedRelatedPayload(fullPayload)
    return {
      ...projectRow(row, view),
      payload,
      ...legacyPayloadProjection(fullPayload, 16_384),
    }
  }))
}

function boundedRelatedPayload(payload: PayloadProjection): PayloadProjection {
  if (payload.state !== 'available' || typeof payload.body !== 'string' || payload.body.length <= 16_384) return payload
  return {
    ...payload,
    body: `${payload.body.slice(0, 16_384)}\n…[truncated]`,
  }
}

function legacyPayloadProjection(payload: PayloadProjection, maximum?: number): Record<string, unknown> {
  if (payload.state !== 'available' || payload.body === null) return {}
  try {
    const decoded = JSON.parse(payload.body) as Record<string, unknown>
    const error = recordValue(decoded.error)
    const response = recordValue(decoded.response)
    return compactObject({
      error_body: boundedDiagnostic(diagnosticJson(error?.body), maximum),
      upstream_error_message: boundedDiagnostic(
        typeof error?.message === 'string' ? error.message : undefined,
        maximum,
      ),
      upstream_error_detail: boundedDiagnostic(diagnosticJson(response?.body), maximum),
      upstream_errors: boundedDiagnostic(diagnosticJson(response?.errors), maximum),
    })
  } catch {
    return {}
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function diagnosticJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function boundedDiagnostic(value: string | undefined, maximum: number | undefined): string | undefined {
  if (value === undefined || maximum === undefined || value.length <= maximum) return value
  return `${value.slice(0, maximum)}\n…[truncated]`
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function projectResolutionAudit(row: ResolutionAuditRow): Record<string, unknown> {
  return {
    id: row.id,
    resolved: row.resolved === 1,
    actor_user_id: row.actor_user_id,
    occurred_at: new Date(row.occurred_at_ms).toISOString(),
  }
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
    errorPhase: filters.errorPhase ?? null, errorCategory: filters.errorCategory ?? null,
    errorOwner: filters.errorOwner ?? null, errorSource: filters.errorSource ?? null,
    resolved: filters.resolved ?? null, view: filters.view ?? null,
    statusCodes: filters.statusCodes ?? null, statusCodesOther: filters.statusCodesOther ?? null,
    query: filters.query ?? null, requestKind: filters.requestKind ?? null,
    minDurationMs: filters.minDurationMs ?? null, maxDurationMs: filters.maxDurationMs ?? null,
    sortColumn: filters.sortColumn ?? null, sortDirection: filters.sortDirection ?? null,
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

function validateOpsQueryParameters(
  context: Context<Bindings>,
  family: Family,
  timeContract: 'usage' | 'ops',
): void {
  if (timeContract !== 'ops') return
  const common = new Set([
    'limit', 'cursor', 'page', 'page_size', 'start_time', 'end_time',
    'platform', 'group_id', 'account_id', 'user_id', 'api_key_id', 'model',
    'request_id', 'status_code',
  ])
  const allowed = family === 'all'
    ? new Set([...common, 'kind', 'sort', 'min_duration_ms', 'max_duration_ms', 'q'])
    : new Set([
        ...common, 'phase', 'category', 'error_owner', 'error_source', 'resolved',
        'view', 'q', 'status_codes', 'status_codes_other', 'sort_by', 'sort_order',
      ])
  if (/\/request-errors\/[^/]+\/upstream-errors$/.test(context.req.path)) allowed.add('include_detail')
  for (const name of new URL(context.req.url).searchParams.keys()) {
    if (name === 'time_range') {
      throw new GatewayError(501, 'ops_time_range_not_migrated', 'Use explicit start_time and end_time on the Worker')
    }
    if (!allowed.has(name)) {
      throw new GatewayError(400, 'unsupported_ops_parameter', `Ops query parameter is not supported: ${name}`)
    }
  }
}

function optionalBoundedInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^\d+$/.test(value)) throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
  }
  return parsed
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === '') return undefined
  const normalized = value.toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
}

function parseStatusCodes(value: string | undefined): number[] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 50) {
    throw new GatewayError(400, 'invalid_status_codes', 'status_codes is invalid')
  }
  const codes = parts.map((part) => optionalBoundedInteger(part, 'status_codes', 100, 599))
  if (codes.some((code) => code === undefined)) {
    throw new GatewayError(400, 'invalid_status_codes', 'status_codes is invalid')
  }
  return [...new Set(codes as number[])]
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
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

function parseUsageDate(raw: string | undefined, timezone: string, endExclusive: boolean): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const date = parseCalendarDate(raw)
  return zonedDayStart(endExclusive ? addCalendarDays(date, 1) : date, timezone)
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
