import type { Context } from 'hono'
import type { Env } from '../env'
import { decryptCredential, encryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  buildProviderHealthRequest,
  providerContract,
  type ProviderAccount,
  type ProviderAuthScheme,
  type ProviderConfig,
  type ProviderPlatform,
  type ProviderProtocol,
} from '../gateway/providers'
import { credentialAad, validateBaseUrl } from '../gateway/repository'
import type { AccountCredentialKind, AccountImageAdapter, UpstreamCredential } from '../gateway/types'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from './http'

type ControlBindings = { Bindings: Env }

interface AccountRow {
  id: string
  platform: ProviderPlatform
  name: string
  credential_ref: string
  enabled: number
  max_concurrency: number
  protocol: ProviderProtocol
  base_url: string
  auth_scheme: ProviderAuthScheme
  image_adapter: AccountImageAdapter
  credential_kind: AccountCredentialKind
  provider_config_json: string
  config_version: number
  control_version: number
  health_status: 'unknown' | 'healthy' | 'unhealthy'
  last_checked_at_ms: number | null
  last_latency_ms: number | null
  last_health_error: string | null
  created_at_ms: number
  updated_at_ms: number
  billing_rate_multiplier_ppm: number
  ui_config_json: string
  secret_id: string
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
  group_links_json: string
  model_capabilities_json: string
}

interface GroupLink {
  group_id: string
  priority: number
  weight: number
  control_version: number
}

interface ModelCapability {
  model_id: string
  chat_completions: boolean
  responses: boolean
  embeddings: boolean
  image_generation: boolean
  control_version: number
}

interface CreateAccountInput {
  name: string
  platform: ProviderPlatform
  protocol: ProviderProtocol
  base_url: string
  auth_scheme: ProviderAuthScheme
  image_adapter: AccountImageAdapter
  credential_kind: AccountCredentialKind
  provider_config: ProviderConfig
  credential: StoredAccountCredential
  enabled: boolean
  max_concurrency: number
  billing_rate_multiplier_ppm: number
  group_links: GroupLinkInput[]
  model_capabilities: ModelCapabilityInput[]
  ui_config: Record<string, unknown>
}

interface GroupLinkInput {
  group_id: string
  priority: number
  weight: number
}

interface ModelCapabilityInput {
  model_id: string
  chat_completions: boolean
  responses: boolean
  embeddings?: boolean
  image_generation?: boolean
}

interface AccountPatch {
  name?: string
  base_url?: string
  credential_patch?: Record<string, unknown>
  provider_config?: ProviderConfig
  enabled?: boolean
  max_concurrency?: number
  group_links?: GroupLinkInput[]
  model_capabilities?: ModelCapabilityInput[]
  image_adapter?: AccountImageAdapter
  credential_kind?: AccountCredentialKind
  billing_rate_multiplier_ppm?: number
  ui_config?: Record<string, unknown>
}

type StoredAccountCredential = UpstreamCredential & Record<string, unknown>

const ACCOUNT_PROJECTION = `
  SELECT a.id, a.platform, a.name, a.credential_ref, a.enabled,
         a.max_concurrency, a.protocol, a.base_url, a.auth_scheme,
         a.provider_config_json, a.image_adapter, a.credential_kind,
         a.config_version, a.control_version, a.health_status,
         a.last_checked_at_ms, a.last_latency_ms, a.last_health_error,
         a.created_at_ms, a.updated_at_ms, a.billing_rate_multiplier_ppm,
         a.ui_config_json,
         s.id AS secret_id, s.key_version, s.nonce_b64, s.ciphertext_b64,
         COALESCE((
           SELECT json_group_array(json_object(
             'group_id', links.group_id,
             'priority', links.priority,
             'weight', links.weight,
             'control_version', links.control_version
           ))
             FROM (
               SELECT group_id, priority, weight, control_version
                 FROM account_groups
                WHERE account_id = a.id
                ORDER BY priority ASC, group_id ASC
             ) AS links
         ), '[]') AS group_links_json,
         COALESCE((
           SELECT json_group_array(json_object(
             'model_id', capabilities.model_id,
             'chat_completions', capabilities.chat_completions,
             'responses', capabilities.responses,
             'embeddings', capabilities.embeddings,
             'image_generation', capabilities.image_generation,
             'control_version', capabilities.control_version
           ))
             FROM (
               SELECT model_id, chat_completions, responses, embeddings, image_generation,
                      control_version
                 FROM account_models
                WHERE account_id = a.id
                ORDER BY model_id ASC
             ) AS capabilities
         ), '[]') AS model_capabilities_json
    FROM accounts a
    JOIN account_secrets s
      ON s.id = a.credential_ref AND s.account_id = a.id
`

export async function listAdminAccounts(context: Context<ControlBindings>): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const conditions = [
      `(
        (a.platform = 'openai' AND a.protocol = 'openai' AND a.auth_scheme = 'bearer')
        OR (a.platform = 'anthropic' AND a.protocol = 'anthropic' AND a.auth_scheme = 'x-api-key')
        OR (a.platform = 'gemini' AND a.protocol = 'gemini' AND a.auth_scheme = 'x-goog-api-key')
        OR (a.platform = 'codex' AND a.protocol = 'codex' AND a.auth_scheme = 'bearer')
      )`,
      'a.base_url IS NOT NULL',
    ]
    const values: unknown[] = []
    const platform = context.req.query('platform')
    if (platform !== undefined && platform !== '') {
      const supportedPlatform = requireProviderPlatform(platform)
      conditions.push('a.platform = ?')
      values.push(supportedPlatform)
    }
    const enabled = parseEnabledQuery(context.req.query('enabled'), context.req.query('status'))
    if (enabled !== undefined) {
      conditions.push('a.enabled = ?')
      values.push(enabled ? 1 : 0)
    }
    const accountType = context.req.query('type')
    if (accountType) {
      if (!['apikey', 'oauth', 'setup-token', 'upstream', 'bedrock'].includes(accountType)) {
        throw new GatewayError(400, 'invalid_type', 'type is invalid')
      }
      conditions.push(`COALESCE(json_extract(a.ui_config_json, '$.type'),
        CASE a.credential_kind WHEN 'api_key' THEN 'apikey'
          WHEN 'setup_token' THEN 'setup-token' ELSE 'oauth' END) = ?`)
      values.push(accountType)
    }
    const privacyMode = context.req.query('privacy_mode')
    if (privacyMode) {
      if (privacyMode.length > 128) {
        throw new GatewayError(400, 'invalid_privacy_mode', 'privacy_mode must not exceed 128 characters')
      }
      const privacyColumn = "CASE WHEN json_type(a.ui_config_json, '$.extra.privacy_mode') = 'text' " +
        "THEN json_extract(a.ui_config_json, '$.extra.privacy_mode') ELSE '' END"
      if (privacyMode === '__unset__') conditions.push(`trim(${privacyColumn}) = ''`)
      else {
        conditions.push(`(${privacyColumn}) = ?`)
        values.push(privacyMode)
      }
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 256) throw new GatewayError(400, 'invalid_search', 'search must not exceed 256 characters')
      conditions.push(`a.name LIKE ? ESCAPE '\\'`)
      values.push(`%${escapeLike(search)}%`)
    }
    const group = context.req.query('group')
    if (group !== undefined && group !== '') {
      if (group === 'ungrouped') {
        conditions.push('NOT EXISTS (SELECT 1 FROM account_groups ag WHERE ag.account_id = a.id)')
      } else {
        const groupId = requireResourceId(group, 'group')
        conditions.push('EXISTS (SELECT 1 FROM account_groups ag WHERE ag.account_id = a.id AND ag.group_id = ?)')
        values.push(groupId)
      }
    }
    const sortBy = context.req.query('sort_by') ?? 'updated_at'
    const sortColumns: Record<string, string> = {
      id: 'a.id',
      name: 'a.name',
      platform: 'a.platform',
      platform_type: 'a.platform',
      status: 'a.enabled',
      rate_multiplier: 'a.billing_rate_multiplier_ppm',
      max_concurrency: 'a.max_concurrency',
      schedulable: 'a.enabled',
      priority: "COALESCE(json_extract(a.ui_config_json, '$.priority'), 0)",
      expires_at: "json_extract(a.ui_config_json, '$.expires_at')",
      created_at: 'a.created_at_ms',
      updated_at: 'a.updated_at_ms',
    }
    const sortColumn = sortColumns[sortBy]
    if (sortColumn === undefined) {
      throw new GatewayError(400, 'invalid_sort_by', 'sort_by is invalid')
    }
    const defaultSortOrder = sortBy === 'updated_at' ? 'desc' : 'asc'
    const sortOrder = context.req.query('sort_order') ?? defaultSortOrder
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
      throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
    }
    const direction = sortOrder.toUpperCase()
    const orderBy = sortBy === 'id'
      ? `${sortColumn} ${direction}`
      : `${sortColumn} ${direction}, a.id ${direction}`
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total
           FROM accounts a
           JOIN account_secrets s
             ON s.id = a.credential_ref AND s.account_id = a.id
          ${where}`,
      ).bind(...values),
      context.env.DB.prepare(
        `${ACCOUNT_PROJECTION} ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const totalValue = (countResult.results[0] as { total?: unknown } | undefined)?.total
    if (!Number.isSafeInteger(totalValue) || (totalValue as number) < 0) {
      throw new GatewayError(500, 'invalid_account_count', 'Account count projection is invalid', 'server_error')
    }
    const total = totalValue as number
    return controlSuccess({
      items: (rowsResult.results as unknown as AccountRow[]).map(publicAccount),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    return controlSuccess(publicAccount(account))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

interface AccountStatsRow {
  date?: string
  model?: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  standard_cost_micros: number
  account_cost_micros: number
  user_cost_micros: number
}

interface AccountEndpointStatsRow extends AccountStatsRow { endpoint: string }

type AccountStatsProjectionKind = 'daily' | 'model' | 'endpoint' | 'upstream_endpoint' | 'summary' | 'overflow'

interface AccountStatsProjectionRow extends AccountStatsRow {
  kind: AccountStatsProjectionKind
  dimension: string | null
  duration_total_ms: number
  duration_count: number
}

interface AccountStatsTimezone {
  formatter: Intl.DateTimeFormat
}

interface AccountStatsRollupReadState {
  migration_started_at_ms: number
  legacy_write_grace_until_ms: number
  cutoff_ms: number | null
  cursor_occurred_at_ms: number | null
  cursor_event_id: string | null
  status: 'active' | 'complete' | null
}

const ACCOUNT_STATS_DAY_MS = 86_400_000

export async function getAdminAccountStats(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    const days = queryInteger(context.req.query('days'), 'days', 30, 1, 90)
    const timezone = parseAccountStatsTimezone(context.req.query('timezone'))
    const todayDate = accountStatsLocalDate(Date.now(), timezone.formatter)
    const firstDate = addAccountStatsCalendarDays(todayDate, -(days - 1))
    const dates = Array.from(
      { length: days + 1 },
      (_, index) => addAccountStatsCalendarDays(firstDate, index),
    )
    const boundaries = dates.map((date) => accountStatsZonedDayStart(date, timezone.formatter))
    const buckets = dates.slice(0, -1).map((date, index) => ({
      date,
      start_ms: boundaries[index]!,
      end_ms: boundaries[index + 1]!,
    }))
    const start = buckets[0]!.start_ms
    const end = buckets.at(-1)!.end_ms
    const rollupState = await context.env.DB.prepare(
      `SELECT maintenance.migration_started_at_ms,
              maintenance.legacy_write_grace_until_ms,
              progress.cutoff_ms, progress.cursor_occurred_at_ms,
              progress.cursor_event_id, progress.status
         FROM account_stats_rollup_maintenance maintenance
         LEFT JOIN account_stats_rollup_progress progress ON progress.account_id = ?
        WHERE maintenance.id = 'global'`,
    ).bind(account.id).first<AccountStatsRollupReadState>()
    if (rollupState === null) {
      throw new GatewayError(500, 'invalid_account_stats_projection', 'Account statistics rollup state is missing', 'server_error')
    }
    const aggregate = `COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(standard_cost_micros), 0) AS standard_cost_micros,
      COALESCE(SUM(account_cost_micros), 0) AS account_cost_micros,
      COALESCE(SUM(user_cost_micros), 0) AS user_cost_micros,
      COALESCE(SUM(duration_total_ms), 0) AS duration_total_ms,
      COALESCE(SUM(duration_count), 0) AS duration_count`
    const rawMode = boundaries.some((boundary) => boundary % 900_000 !== 0) ? 1 : 0
    const rawPredicateValues: unknown[] = []
    let rawVersionPredicate = ''
    if (rawMode === 0) {
      if (account.created_at_ms >= rollupState.legacy_write_grace_until_ms || rollupState.status === 'complete') {
        rawVersionPredicate = 'AND 1 = 0'
      } else if (
        rollupState.status === 'active' &&
        rollupState.cursor_occurred_at_ms !== null && rollupState.cursor_event_id !== null
      ) {
        rawVersionPredicate = `AND account_stats_rollup_version = 0
          AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND event_id < ?))`
        rawPredicateValues.push(
          rollupState.cursor_occurred_at_ms,
          rollupState.cursor_occurred_at_ms,
          rollupState.cursor_event_id,
        )
      } else {
        rawVersionPredicate = 'AND account_stats_rollup_version = 0'
      }
    }
    const rollupPredicate = rawMode === 0 ? '1 = 1' : '1 = 0'
    const projection = await context.env.DB.prepare(
      `WITH buckets(local_date, start_ms, end_ms) AS MATERIALIZED (
         SELECT json_extract(value, '$.date'),
                CAST(json_extract(value, '$.start_ms') AS INTEGER),
                CAST(json_extract(value, '$.end_ms') AS INTEGER)
           FROM json_each(?)
       ),
       raw_rows AS MATERIALIZED (
         SELECT event_id, model, inbound_endpoint, upstream_endpoint, occurred_at_ms,
                input_tokens, output_tokens, cache_read_tokens,
                COALESCE(standard_cost_micros, amount_micros) AS standard_cost_micros,
                COALESCE(account_cost_micros, account_stats_cost_micros,
                  standard_cost_micros, amount_micros) AS account_cost_micros,
                amount_micros AS user_cost_micros, duration_ms
          FROM usage_projection
          WHERE account_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
            ${rawVersionPredicate}
          ORDER BY occurred_at_ms, event_id
          LIMIT 10001
       ),
       source AS MATERIALIZED (
         SELECT bucket.local_date, raw.model, raw.inbound_endpoint, raw.upstream_endpoint,
                1 AS requests, raw.input_tokens, raw.output_tokens, raw.cache_read_tokens,
                raw.standard_cost_micros, raw.account_cost_micros, raw.user_cost_micros,
                raw.duration_ms AS duration_total_ms, 1 AS duration_count
           FROM raw_rows raw
           JOIN buckets bucket
             ON raw.occurred_at_ms >= bucket.start_ms AND raw.occurred_at_ms < bucket.end_ms
         UNION ALL
         SELECT bucket.local_date, rollup.model, rollup.inbound_endpoint, rollup.upstream_endpoint,
                rollup.requests, rollup.input_tokens, rollup.output_tokens, rollup.cache_read_tokens,
                rollup.standard_cost_micros, rollup.account_cost_micros, rollup.user_cost_micros,
                rollup.duration_total_ms, rollup.duration_count
           FROM account_usage_15m_rollup rollup
           JOIN buckets bucket
             ON rollup.bucket_start_ms >= bucket.start_ms
            AND rollup.bucket_start_ms < bucket.end_ms
          WHERE ${rollupPredicate} AND rollup.account_id = ?
            AND rollup.bucket_start_ms >= ? AND rollup.bucket_start_ms < ?
       )
       SELECT 'daily' AS kind, local_date AS dimension, ${aggregate}
         FROM source GROUP BY local_date
       UNION ALL
       SELECT 'model', model, ${aggregate}
         FROM source GROUP BY model
       UNION ALL
       SELECT 'endpoint', inbound_endpoint, ${aggregate}
         FROM source WHERE trim(inbound_endpoint) <> '' GROUP BY inbound_endpoint
       UNION ALL
       SELECT 'upstream_endpoint', upstream_endpoint, ${aggregate}
         FROM source WHERE trim(upstream_endpoint) <> '' GROUP BY upstream_endpoint
       UNION ALL
       SELECT 'summary', NULL, ${aggregate} FROM source
       UNION ALL
       SELECT 'overflow', NULL, COUNT(*), 0, 0, 0, 0, 0, 0, 0, 0
         FROM raw_rows HAVING COUNT(*) > 10000`,
    ).bind(
      JSON.stringify(buckets), account.id, start, end,
      ...rawPredicateValues,
      account.id, start, end,
    ).all<AccountStatsProjectionRow>()
    const rows = projection.results
    if (rows.some((row) => row.kind === 'overflow')) {
      throw new GatewayError(
        503,
        'account_stats_history_not_rolled_up',
        'Historical account statistics exceed the bounded compatibility window',
        'server_error',
      )
    }
    const dailyRows = rows
      .filter((row) => row.kind === 'daily')
      .map((row) => validateAccountStatsRow({ ...row, date: requireStatsString(row.dimension ?? undefined, 'date') }))
      .sort((left, right) => requireStatsString(left.date, 'date').localeCompare(requireStatsString(right.date, 'date')))
    const modelRows = rows
      .filter((row) => row.kind === 'model')
      .map((row) => validateAccountStatsRow({ ...row, model: requireStatsString(row.dimension ?? undefined, 'model') }))
      .sort((left, right) =>
        (right.input_tokens + right.output_tokens) - (left.input_tokens + left.output_tokens) ||
        requireStatsString(left.model, 'model').localeCompare(requireStatsString(right.model, 'model')))
    const endpointRows = rows
      .filter((row) => row.kind === 'endpoint')
      .map((row) => validateEndpointStatsRow({ ...row, endpoint: requireStatsString(row.dimension ?? undefined, 'endpoint') }))
      .sort(compareEndpointStats)
    const upstreamEndpointRows = rows
      .filter((row) => row.kind === 'upstream_endpoint')
      .map((row) => validateEndpointStatsRow({ ...row, endpoint: requireStatsString(row.dimension ?? undefined, 'endpoint') }))
      .sort(compareEndpointStats)
    const summaryRow = rows.find((row) => row.kind === 'summary')
    if (summaryRow === undefined) {
      throw new GatewayError(500, 'invalid_account_stats_projection', 'Account statistics summary is missing', 'server_error')
    }
    requireStatsInteger(summaryRow.duration_total_ms, 'duration_total_ms')
    requireStatsInteger(summaryRow.duration_count, 'duration_count')
    const averageDuration = summaryRow.duration_count === 0
      ? 0
      : summaryRow.duration_total_ms / summaryRow.duration_count
    if (!Number.isFinite(averageDuration) || averageDuration < 0) {
      throw new GatewayError(500, 'invalid_account_stats_projection', 'Account statistics duration is invalid', 'server_error')
    }
    const history = dailyRows.map((row) => ({
      date: requireStatsString(row.date, 'date'),
      label: requireStatsString(row.date, 'date').slice(5).replace('-', '/'),
      requests: row.requests,
      tokens: row.input_tokens + row.output_tokens,
      cost: microsToUsd(row.standard_cost_micros),
      actual_cost: microsToUsd(row.account_cost_micros),
      user_cost: microsToUsd(row.user_cost_micros),
    }))
    const total = dailyRows.reduce((value, row) => ({
      requests: value.requests + row.requests,
      tokens: value.tokens + row.input_tokens + row.output_tokens,
      standard: value.standard + row.standard_cost_micros,
      account: value.account + row.account_cost_micros,
      user: value.user + row.user_cost_micros,
    }), { requests: 0, tokens: 0, standard: 0, account: 0, user: 0 })
    for (const [field, value] of Object.entries(total)) requireStatsInteger(value, field)
    const divisor = history.length === 0 ? 1 : history.length
    const highestCostDay = history.reduce<typeof history[number] | null>(
      (highest, row) => highest === null || row.actual_cost > highest.actual_cost ? row : highest,
      null,
    )
    const highestRequestDay = history.reduce<typeof history[number] | null>(
      (highest, row) => highest === null || row.requests > highest.requests ? row : highest,
      null,
    )
    const today = history.find((row) => row.date === todayDate)
    return controlSuccess({
      history,
      summary: {
        days,
        actual_days_used: divisor,
        total_cost: microsToUsd(total.account),
        total_user_cost: microsToUsd(total.user),
        total_standard_cost: microsToUsd(total.standard),
        total_requests: total.requests,
        total_tokens: total.tokens,
        avg_daily_cost: microsToUsd(total.account) / divisor,
        avg_daily_user_cost: microsToUsd(total.user) / divisor,
        avg_daily_requests: total.requests / divisor,
        avg_daily_tokens: total.tokens / divisor,
        avg_duration_ms: averageDuration,
        today: today === undefined ? null : {
          date: today.date, cost: today.actual_cost, user_cost: today.user_cost,
          requests: today.requests, tokens: today.tokens,
        },
        highest_cost_day: highestCostDay === null ? null : {
          date: highestCostDay.date, label: highestCostDay.label,
          cost: highestCostDay.actual_cost, user_cost: highestCostDay.user_cost,
          requests: highestCostDay.requests,
        },
        highest_request_day: highestRequestDay === null ? null : {
          date: highestRequestDay.date, label: highestRequestDay.label,
          requests: highestRequestDay.requests, cost: highestRequestDay.actual_cost,
          user_cost: highestRequestDay.user_cost,
        },
      },
      models: modelRows.map((row) => ({
        model: requireStatsString(row.model, 'model'),
        requests: row.requests,
        input_tokens: row.input_tokens - row.cache_read_tokens,
        output_tokens: row.output_tokens,
        cache_creation_tokens: 0,
        cache_read_tokens: row.cache_read_tokens,
        total_tokens: row.input_tokens + row.output_tokens,
        cost: microsToUsd(row.standard_cost_micros),
        actual_cost: microsToUsd(row.account_cost_micros),
        account_cost: microsToUsd(row.account_cost_micros),
      })),
      endpoints: endpointRows.map(publicEndpointStats),
      upstream_endpoints: upstreamEndpointRows.map(publicEndpointStats),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseAccountStatsTimezone(raw: string | undefined): AccountStatsTimezone {
  const timezone = raw?.trim() || 'UTC'
  if (timezone.length > 64) {
    throw new GatewayError(400, 'invalid_timezone', 'timezone is invalid')
  }
  try {
    return {
      formatter: new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23',
      }),
    }
  } catch {
    throw new GatewayError(400, 'invalid_timezone', 'timezone is invalid')
  }
}

function accountStatsCalendarDayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return Math.floor(Date.UTC(year, month - 1, day) / ACCOUNT_STATS_DAY_MS)
}

function addAccountStatsCalendarDays(date: string, days: number): string {
  return new Date((accountStatsCalendarDayNumber(date) + days) * ACCOUNT_STATS_DAY_MS)
    .toISOString().slice(0, 10)
}

function accountStatsLocalDate(timestamp: number, formatter: Intl.DateTimeFormat): string {
  const parts = accountStatsDateParts(timestamp, formatter)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function accountStatsZonedDayStart(date: string, formatter: Intl.DateTimeFormat): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const target = Date.UTC(year, month - 1, day)
  // Some zones advance their clocks at midnight, so 00:00 may not exist.
  // Local dates are monotonic in this narrow window: binary-search the first
  // instant whose rendered local date is at least the requested date.
  let low = target - 36 * 60 * 60 * 1000
  let high = target + 36 * 60 * 60 * 1000
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (accountStatsLocalDate(middle, formatter) < date) low = middle + 1
    else high = middle
  }
  if (accountStatsLocalDate(low, formatter) !== date) {
    throw new GatewayError(400, 'invalid_timezone', 'timezone has no valid local day boundary')
  }
  return low
}

function accountStatsDateParts(timestamp: number, formatter: Intl.DateTimeFormat): {
  year: number; month: number; day: number
} {
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>
  return {
    year: values.year!, month: values.month!, day: values.day!,
  }
}

function validateEndpointStatsRow(row: AccountEndpointStatsRow): AccountEndpointStatsRow {
  validateAccountStatsRow(row)
  requireStatsString(row.endpoint, 'endpoint')
  return row
}

function compareEndpointStats(left: AccountEndpointStatsRow, right: AccountEndpointStatsRow): number {
  return (right.input_tokens + right.output_tokens) - (left.input_tokens + left.output_tokens) ||
    left.endpoint.localeCompare(right.endpoint)
}

function publicEndpointStats(row: AccountEndpointStatsRow) {
  return {
    endpoint: row.endpoint,
    requests: row.requests,
    total_tokens: row.input_tokens + row.output_tokens,
    cost: microsToUsd(row.standard_cost_micros),
    actual_cost: microsToUsd(row.account_cost_micros),
  }
}

function validateAccountStatsRow(row: AccountStatsRow): AccountStatsRow {
  for (const field of [
    'requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'standard_cost_micros',
    'account_cost_micros', 'user_cost_micros',
  ] as const) requireStatsInteger(row[field], field)
  if (row.cache_read_tokens > row.input_tokens) {
    throw new GatewayError(500, 'invalid_account_stats_projection', 'Account statistics cache tokens exceed input tokens', 'server_error')
  }
  return row
}

function requireStatsInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'invalid_account_stats_projection', `Account statistics ${field} is invalid`, 'server_error')
  }
  return value
}

function requireStatsString(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new GatewayError(500, 'invalid_account_stats_projection', `Account statistics ${field} is invalid`, 'server_error')
  }
  return value
}

function microsToUsd(value: number): number {
  return value / 1_000_000
}

export async function createAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const input = parseCreateAccount(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency('admin.accounts.create.v1', idempotencyKey, input)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = safeIdempotentAccount(previous)
      return controlSuccess(replay)
    }

    const accountId = await deterministicUuid('admin.accounts.create.v1', idempotencyKey)
    const secretId = await deterministicUuid('admin.account-secrets.create.v1', idempotencyKey)
    if ((await findAccount(context.env, accountId)) !== null) {
      throw new GatewayError(409, 'idempotency_record_missing', 'Account exists without its idempotency record')
    }
    await validateLinks(context.env, input.platform, input.group_links, input.model_capabilities)
    const masterKey = requireCredentialsMasterKey(context.env)
    const encrypted = await encryptCredential(
      input.credential,
      masterKey,
      credentialAad(context.env.ENVIRONMENT, accountId, secretId, 1),
    )
    const now = Date.now()
    const safe = accountResponse({
      id: accountId,
      platform: input.platform,
      name: input.name,
      enabled: input.enabled,
      max_concurrency: input.max_concurrency,
      billing_rate_multiplier_ppm: input.billing_rate_multiplier_ppm,
      protocol: input.protocol,
      base_url: input.base_url,
      auth_scheme: input.auth_scheme,
      image_adapter: input.image_adapter,
      credential_kind: input.credential_kind,
      provider_config: input.provider_config,
      config_version: 1,
      control_version: 0,
      health_status: 'unknown',
      last_checked_at_ms: null,
      last_latency_ms: null,
      last_health_error: null,
      created_at_ms: now,
      updated_at_ms: now,
      credential_key_version: 1,
      ui_config: input.ui_config,
      group_links: input.group_links.map((value) => ({ ...value, control_version: 0 })),
      model_capabilities: input.model_capabilities.map((value) => ({
        ...value,
        embeddings: value.embeddings ?? false,
        image_generation: value.image_generation ?? false,
        control_version: 0,
      })),
    })
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO accounts (
           id, platform, name, credential_ref, enabled, max_concurrency,
           created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
           provider_config_json, image_adapter, credential_kind, config_version,
           billing_rate_multiplier_ppm, ui_config_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        accountId,
        input.platform,
        input.name,
        secretId,
        input.enabled ? 1 : 0,
        input.max_concurrency,
        now,
        now,
        input.protocol,
        input.base_url,
        input.auth_scheme,
        JSON.stringify(input.provider_config),
        input.image_adapter,
        input.credential_kind,
        input.billing_rate_multiplier_ppm,
        JSON.stringify(input.ui_config),
      ),
      context.env.DB.prepare(
        `INSERT INTO account_secrets (
           id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).bind(secretId, accountId, encrypted.nonce_b64, encrypted.ciphertext_b64, now, now),
      ...groupInsertStatements(context.env, accountId, input.group_links, now),
      ...capabilityInsertStatements(context.env, accountId, input.model_capabilities, now),
      controlIdempotencyInsert(context.env, idempotency, 'account', accountId, safe, now),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        const replay = safeIdempotentAccount(recovered)
        return controlSuccess(replay)
      }
      throw mapAccountWriteError(error)
    }
    return controlSuccess(safe, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const patch = parseAccountPatch(body, account)
    await validateLinks(
      context.env,
      account.platform,
      patch.group_links ?? [],
      patch.model_capabilities ?? [],
    )
    const nextControlVersion = incrementVersion(account.control_version, 'control_version')
    const nextConfigVersion = incrementVersion(account.config_version, 'config_version')
    const now = Date.now()
    const baseUrl = patch.base_url ?? account.base_url
    const providerConfig = patch.provider_config ?? parseProviderConfigProjection(account.provider_config_json)
    const resetHealth = patch.base_url !== undefined ||
      patch.credential_patch !== undefined ||
      patch.provider_config !== undefined ||
      patch.image_adapter !== undefined ||
      patch.credential_kind !== undefined
    let nextUiConfig = patch.ui_config ?? parseUiConfig(account.ui_config_json)
    let nextCredential: StoredAccountCredential | undefined
    if (patch.credential_patch !== undefined) {
      const currentCredential = await decryptCredential(
        account.nonce_b64,
        account.ciphertext_b64,
        requireCredentialsMasterKey(context.env),
        credentialAad(context.env.ENVIRONMENT, account.id, account.secret_id, account.key_version),
      )
      nextCredential = mergeCredentialPatch(currentCredential as StoredAccountCredential, patch.credential_patch)
      const nextCredentialStatus = credentialStatus(nextCredential)
      const previousCredentialStatus = nextUiConfig.credentials_status
      if (previousCredentialStatus !== null && typeof previousCredentialStatus === 'object' && !Array.isArray(previousCredentialStatus)) {
        for (const key of Object.keys(previousCredentialStatus as Record<string, unknown>)) {
          if (key.startsWith('has_') && nextCredentialStatus[key] === undefined) nextCredentialStatus[key] = false
        }
      }
      nextUiConfig = {
        ...nextUiConfig,
        credentials: publicCredentials(nextCredential),
        credentials_status: nextCredentialStatus,
      }
    }
    const statements: D1PreparedStatement[] = [
      accountCasStatement(context.env, account.id, account.control_version, {
        name: patch.name ?? account.name,
        enabled: patch.enabled ?? account.enabled === 1,
        max_concurrency: patch.max_concurrency ?? account.max_concurrency,
        base_url: baseUrl,
        provider_config: providerConfig,
        image_adapter: patch.image_adapter ?? account.image_adapter,
        credential_kind: patch.credential_kind ?? account.credential_kind,
        billing_rate_multiplier_ppm: patch.billing_rate_multiplier_ppm ?? account.billing_rate_multiplier_ppm,
        ui_config: nextUiConfig,
        config_version: nextConfigVersion,
        control_version: nextControlVersion,
        now,
        reset_health: resetHealth,
      }),
    ]
    let nextKeyVersion = account.key_version
    if (nextCredential !== undefined) {
      nextKeyVersion = incrementVersion(account.key_version, 'credential_key_version')
      const encrypted = await encryptCredential(
        nextCredential,
        requireCredentialsMasterKey(context.env),
        credentialAad(context.env.ENVIRONMENT, account.id, account.secret_id, nextKeyVersion),
      )
      statements.push(
        context.env.DB.prepare(
          `UPDATE account_secrets
              SET key_version = CASE WHEN key_version = ? THEN ? ELSE 0 END,
                  nonce_b64 = ?, ciphertext_b64 = ?, updated_at_ms = ?
            WHERE id = ? AND account_id = ?`,
        ).bind(
          account.key_version,
          nextKeyVersion,
          encrypted.nonce_b64,
          encrypted.ciphertext_b64,
          now,
          account.secret_id,
          account.id,
        ),
      )
    }
    if (patch.group_links !== undefined) {
      statements.push(
        context.env.DB.prepare('DELETE FROM account_groups WHERE account_id = ?').bind(account.id),
        ...groupInsertStatements(context.env, account.id, patch.group_links, now),
      )
    }
    if (patch.model_capabilities !== undefined) {
      statements.push(
        context.env.DB.prepare('DELETE FROM account_models WHERE account_id = ?').bind(account.id),
        ...capabilityInsertStatements(context.env, account.id, patch.model_capabilities, now),
      )
    }
    await runAccountBatch(context.env, statements, account.id, account.control_version)
    const updated = await requireAccount(context.env, account.id)
    if (updated.control_version !== nextControlVersion || updated.config_version !== nextConfigVersion) {
      throw new GatewayError(503, 'account_projection_failed', 'Account update could not be read', 'server_error')
    }
    if (updated.key_version !== nextKeyVersion) {
      throw new GatewayError(503, 'account_projection_failed', 'Credential update could not be read', 'server_error')
    }
    return controlSuccess(publicAccount(updated))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const expectedVersion = requireExpectedControlVersion(context.req.raw, {})
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    if (account.enabled === 0) return controlSuccess(publicAccount(account))
    const now = Date.now()
    await runAccountBatch(
      context.env,
      [accountCasStatement(context.env, account.id, account.control_version, {
        name: account.name,
        enabled: false,
        max_concurrency: account.max_concurrency,
        base_url: account.base_url,
        provider_config: parseProviderConfigProjection(account.provider_config_json),
        image_adapter: account.image_adapter,
        credential_kind: account.credential_kind,
        billing_rate_multiplier_ppm: account.billing_rate_multiplier_ppm,
        ui_config: parseUiConfig(account.ui_config_json),
        config_version: incrementVersion(account.config_version, 'config_version'),
        control_version: incrementVersion(account.control_version, 'control_version'),
        now,
        reset_health: false,
      })],
      account.id,
      account.control_version,
    )
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function putAdminAccountGroupLink(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const groupId = requireResourceId(context.req.param('group_id') || context.req.param('groupId'), 'group')
    const link = parseGroupLink(body, groupId)
    await validateLinks(context.env, account.platform, [link], [])
    const now = Date.now()
    await mutateAccountRelation(context.env, account, context.env.DB.prepare(
      `INSERT INTO account_groups (
         account_id, group_id, priority, weight, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, group_id) DO UPDATE SET
         priority = excluded.priority,
         weight = excluded.weight,
         control_version = account_groups.control_version + 1,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(account.id, groupId, link.priority, link.weight, now, now), now)
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminAccountGroupLink(context: Context<ControlBindings>): Promise<Response> {
  return deleteRelation(context, 'group')
}

export async function putAdminAccountModelCapability(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const modelId = requireResourceId(context.req.param('model_id') || context.req.param('modelId'), 'model')
    const capability = parseModelCapability(body, modelId)
    await validateLinks(context.env, account.platform, [], [capability])
    const now = Date.now()
    await mutateAccountRelation(context.env, account, context.env.DB.prepare(
      `INSERT INTO account_models (
         account_id, model_id, chat_completions, responses, embeddings, image_generation,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, model_id) DO UPDATE SET
         chat_completions = excluded.chat_completions,
         responses = excluded.responses,
         embeddings = excluded.embeddings,
         image_generation = excluded.image_generation,
         control_version = account_models.control_version + 1,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(
      account.id,
      modelId,
      capability.chat_completions ? 1 : 0,
      capability.responses ? 1 : 0,
      capability.embeddings ? 1 : 0,
      capability.image_generation ? 1 : 0,
      now,
      now,
    ), now)
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminAccountModelCapability(context: Context<ControlBindings>): Promise<Response> {
  return deleteRelation(context, 'model')
}

export async function testAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    requireSupportedAccount(account)
    const credential = await decryptCredential(
      account.nonce_b64,
      account.ciphertext_b64,
      requireCredentialsMasterKey(context.env),
      credentialAad(context.env.ENVIRONMENT, account.id, account.secret_id, account.key_version),
    )
    const plan = buildProviderHealthRequest({
      account: providerAccount(account),
      credential,
    })
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), plan.timeout_ms)
    let status: 'healthy' | 'unhealthy' = 'unhealthy'
    let healthError: string | null = null
    try {
      const response = await fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (response.ok) status = 'healthy'
      else healthError = `Upstream returned HTTP ${response.status}`
      try {
        await response.body?.cancel()
      } catch {
        // The result has already been observed; body cleanup is best effort.
      }
    } catch (error) {
      healthError = error instanceof DOMException && error.name === 'AbortError'
        ? 'Upstream probe timed out'
        : 'Upstream probe failed'
    } finally {
      clearTimeout(timer)
    }
    const checkedAt = Date.now()
    const latency = Math.max(0, checkedAt - started)
    const result = await context.env.DB.prepare(
      `UPDATE accounts
          SET health_status = ?, last_checked_at_ms = ?, last_latency_ms = ?, last_health_error = ?
        WHERE id = ? AND config_version = ? AND credential_ref = ?`,
    ).bind(
      status,
      checkedAt,
      latency,
      healthError,
      account.id,
      account.config_version,
      account.credential_ref,
    ).run()
    return controlSuccess({
      id: account.id,
      health_status: status,
      last_checked_at_ms: checkedAt,
      last_latency_ms: latency,
      last_health_error: healthError,
      config_version: account.config_version,
      control_version: account.control_version,
      persisted: result.meta.changes === 1,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function deleteRelation(context: Context<ControlBindings>, type: 'group' | 'model'): Promise<Response> {
  try {
    const expectedVersion = requireExpectedControlVersion(context.req.raw, {})
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const resourceId = requireResourceId(
      context.req.param(type === 'group' ? 'group_id' : 'model_id') ||
        context.req.param(type === 'group' ? 'groupId' : 'modelId'),
      type,
    )
    const table = type === 'group' ? 'account_groups' : 'account_models'
    const column = type === 'group' ? 'group_id' : 'model_id'
    const existing = await context.env.DB.prepare(
      `SELECT ${column} AS id FROM ${table} WHERE account_id = ? AND ${column} = ?`,
    ).bind(account.id, resourceId).first<{ id: string }>()
    if (existing === null) return controlSuccess(publicAccount(account))
    const now = Date.now()
    await mutateAccountRelation(
      context.env,
      account,
      context.env.DB.prepare(`DELETE FROM ${table} WHERE account_id = ? AND ${column} = ?`).bind(account.id, resourceId),
      now,
    )
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function mutateAccountRelation(
  env: Env,
  account: AccountRow,
  relationStatement: D1PreparedStatement,
  now: number,
): Promise<void> {
  await runAccountBatch(env, [
    accountCasStatement(env, account.id, account.control_version, {
      name: account.name,
      enabled: account.enabled === 1,
      max_concurrency: account.max_concurrency,
      base_url: account.base_url,
      provider_config: parseProviderConfigProjection(account.provider_config_json),
      image_adapter: account.image_adapter,
      credential_kind: account.credential_kind,
      billing_rate_multiplier_ppm: account.billing_rate_multiplier_ppm,
      ui_config: parseUiConfig(account.ui_config_json),
      config_version: incrementVersion(account.config_version, 'config_version'),
      control_version: incrementVersion(account.control_version, 'control_version'),
      now,
      reset_health: false,
    }),
    relationStatement,
  ], account.id, account.control_version)
}

function accountCasStatement(
  env: Env,
  accountId: string,
  expectedControlVersion: number,
  value: {
    name: string
    enabled: boolean
    max_concurrency: number
    base_url: string
    provider_config: ProviderConfig
    image_adapter: AccountImageAdapter
    credential_kind: AccountCredentialKind
    billing_rate_multiplier_ppm: number
    ui_config: Record<string, unknown>
    config_version: number
    control_version: number
    now: number
    reset_health: boolean
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE accounts
        SET name = ?, enabled = ?, max_concurrency = ?, base_url = ?, provider_config_json = ?,
            image_adapter = ?, credential_kind = ?, billing_rate_multiplier_ppm = ?,
            ui_config_json = ?,
            config_version = ?,
            control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
            health_status = CASE WHEN ? = 1 THEN 'unknown' ELSE health_status END,
            last_checked_at_ms = CASE WHEN ? = 1 THEN NULL ELSE last_checked_at_ms END,
            last_latency_ms = CASE WHEN ? = 1 THEN NULL ELSE last_latency_ms END,
            last_health_error = CASE WHEN ? = 1 THEN NULL ELSE last_health_error END,
            updated_at_ms = ?
      WHERE id = ?`,
  ).bind(
    value.name,
    value.enabled ? 1 : 0,
    value.max_concurrency,
    value.base_url,
    JSON.stringify(value.provider_config),
    value.image_adapter,
    value.credential_kind,
    value.billing_rate_multiplier_ppm,
    JSON.stringify(value.ui_config),
    value.config_version,
    expectedControlVersion,
    value.control_version,
    value.reset_health ? 1 : 0,
    value.reset_health ? 1 : 0,
    value.reset_health ? 1 : 0,
    value.reset_health ? 1 : 0,
    value.now,
    accountId,
  )
}

async function runAccountBatch(
  env: Env,
  statements: D1PreparedStatement[],
  accountId: string,
  expectedControlVersion: number,
): Promise<void> {
  try {
    await env.DB.batch(statements)
  } catch (error) {
    const current = await findAccount(env, accountId)
    if (current !== null && current.control_version !== expectedControlVersion) {
      throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
    }
    throw mapAccountWriteError(error)
  }
}

function parseCreateAccount(body: Record<string, unknown>): CreateAccountInput {
  rejectUnknownFields(body, CREATE_ACCOUNT_FIELDS)
  const platform = body.platform === undefined ? 'openai' : requireProviderPlatform(body.platform)
  const contract = providerContract(platform)
  const protocol = body.protocol === undefined
    ? contract.protocol
    : requireProviderProtocol(body.protocol)
  const authScheme = body.auth_scheme === undefined
    ? contract.auth_scheme
    : requireProviderAuthScheme(body.auth_scheme)
  if (protocol !== contract.protocol || authScheme !== contract.auth_scheme) {
    throw new GatewayError(
      409,
      'provider_contract_mismatch',
      'platform, protocol, and auth_scheme must use a supported provider contract',
    )
  }
  const submittedCredentials = body.credentials === undefined
    ? {}
    : requireCredentialObject(body.credentials, 'credentials', true)
  const rawBaseUrl = body.base_url ?? submittedCredentials.base_url
  const baseUrl = normalizeBaseUrl(requireString({ base_url: rawBaseUrl }, 'base_url', 2_048))
  const enabled = parseEnabledBody(body, true)
  const imageAdapter = body.image_adapter === undefined
    ? defaultImageAdapter(platform)
    : requireAccountImageAdapter(body.image_adapter)
  const credentialKind = body.credential_kind === undefined
    ? credentialKindForType(body.type, platform)
    : requireAccountCredentialKind(body.credential_kind)
  validateAccountExecution(platform, imageAdapter, credentialKind)
  validateAccountType(body, platform, credentialKind)
  const rawApiKey = body.api_key ?? submittedCredentials.api_key
  const apiKey = requireProviderCredential({ api_key: rawApiKey }, 'api_key')
  const credential = {
    ...submittedCredentials,
    ...(body.credentials === undefined ? {} : { base_url: baseUrl }),
    api_key: apiKey,
  } as StoredAccountCredential
  const maxConcurrencyField = body.max_concurrency === undefined ? 'concurrency' : 'max_concurrency'
  const maxConcurrencyValue = body.max_concurrency ?? body.concurrency
  const priority = body.priority === undefined ? 0 : requireSafeInteger(body, 'priority', -1_000, 1_000)
  const groupLinks = body.group_links === undefined
    ? parseLegacyGroupIds(body.group_ids, priority)
    : parseGroupLinks(body.group_links)
  const uiConfig = createUiConfig(body, credential, credentialKind)
  return {
    name: requireString(body, 'name', 128),
    platform,
    protocol,
    base_url: baseUrl,
    auth_scheme: authScheme,
    provider_config: parseProviderConfig(body.provider_config, platform),
    image_adapter: imageAdapter,
    credential_kind: credentialKind,
    credential,
    enabled,
    max_concurrency: maxConcurrencyValue === undefined
      ? 4
      : requireSafeInteger({ [maxConcurrencyField]: maxConcurrencyValue }, maxConcurrencyField, 1, 1_000),
    billing_rate_multiplier_ppm: parseRateMultiplier(body.rate_multiplier ?? 1),
    group_links: groupLinks,
    model_capabilities: parseModelCapabilities(body.model_capabilities),
    ui_config: uiConfig,
  }
}

function parseAccountPatch(body: Record<string, unknown>, account: AccountRow): AccountPatch {
  rejectUnknownFields(body, UPDATE_ACCOUNT_FIELDS)
  validateAccountType(body, account.platform, account.credential_kind)
  assertImmutableProviderField(body.platform, account.platform, 'platform', requireProviderPlatform)
  assertImmutableProviderField(body.protocol, account.protocol, 'protocol', requireProviderProtocol)
  assertImmutableProviderField(
    body.auth_scheme,
    account.auth_scheme,
    'auth_scheme',
    requireProviderAuthScheme,
  )
  const patch: AccountPatch = {}
  const currentUiConfig = parseUiConfig(account.ui_config_json)
  if (body.name !== undefined) patch.name = requireString(body, 'name', 128)
  if (body.base_url !== undefined) patch.base_url = normalizeBaseUrl(requireString(body, 'base_url', 2_048))
  if (body.credentials !== undefined) {
    patch.credential_patch = requireCredentialObject(body.credentials, 'credentials', false)
    if (Object.prototype.hasOwnProperty.call(patch.credential_patch, 'base_url')) {
      patch.base_url = normalizeBaseUrl(requireString(patch.credential_patch, 'base_url', 2_048))
      patch.credential_patch.base_url = patch.base_url
    }
  }
  if (body.api_key !== undefined) {
    patch.credential_patch = { ...patch.credential_patch, api_key: requireProviderCredential(body, 'api_key') }
  }
  if (body.provider_config !== undefined) {
    patch.provider_config = parseProviderConfig(body.provider_config, account.platform)
  }
  if (body.image_adapter !== undefined) {
    patch.image_adapter = requireAccountImageAdapter(body.image_adapter)
  }
  if (body.credential_kind !== undefined) {
    patch.credential_kind = requireAccountCredentialKind(body.credential_kind)
  }
  validateAccountExecution(
    account.platform,
    patch.image_adapter ?? account.image_adapter,
    patch.credential_kind ?? account.credential_kind,
  )
  if (body.enabled !== undefined || body.status !== undefined || body.schedulable !== undefined) {
    if (body.status === 'error') {
      throw new GatewayError(409, 'status_not_supported', 'Worker accounts cannot be placed in error status manually')
    }
    const enabledBody = body.enabled === undefined && body.schedulable !== undefined
      ? { ...body, enabled: body.schedulable }
      : body
    patch.enabled = parseEnabledBody(enabledBody, true)
  }
  if (body.max_concurrency !== undefined || body.concurrency !== undefined) {
    const field = body.max_concurrency === undefined ? 'concurrency' : 'max_concurrency'
    patch.max_concurrency = requireSafeInteger({ [field]: body.max_concurrency ?? body.concurrency }, field, 1, 1_000)
  }
  if (body.rate_multiplier !== undefined) {
    patch.billing_rate_multiplier_ppm = parseRateMultiplier(body.rate_multiplier)
  }
  if (body.group_links !== undefined) patch.group_links = parseGroupLinks(body.group_links)
  else if (body.group_ids !== undefined) {
    const priority = body.priority === undefined
      ? (typeof currentUiConfig.priority === 'number' ? currentUiConfig.priority : 0)
      : requireSafeInteger(body, 'priority', -1_000, 1_000)
    patch.group_links = parseLegacyGroupIds(body.group_ids, priority)
  }
  if (body.model_capabilities !== undefined) {
    patch.model_capabilities = parseModelCapabilities(body.model_capabilities)
  }
  const uiPatch = updateUiConfig(currentUiConfig, body)
  if (uiPatch !== undefined) patch.ui_config = uiPatch
  if (Object.keys(patch).length === 0) {
    throw new GatewayError(400, 'empty_account_update', 'Provide at least one account field to update')
  }
  return patch
}

const CREATE_ACCOUNT_FIELDS = new Set([
  'name', 'platform', 'protocol', 'base_url', 'auth_scheme', 'provider_config',
  'api_key', 'enabled', 'status', 'max_concurrency', 'group_links',
  'model_capabilities', 'image_adapter', 'credential_kind', 'type',
  'rate_multiplier', 'credentials', 'notes', 'extra', 'proxy_id', 'concurrency',
  'load_factor', 'priority', 'group_ids', 'expires_at', 'auto_pause_on_expired',
  'upstream_billing_probe_enabled', 'upstream_billing_rate_sync_enabled',
  'schedulable', 'confirm_mixed_channel_risk',
])
const UPDATE_ACCOUNT_FIELDS = new Set([
  ...CREATE_ACCOUNT_FIELDS,
  'control_version',
])

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unsupported = Object.keys(body).find((key) => !allowed.has(key))
  if (unsupported !== undefined) {
    throw new GatewayError(400, 'unsupported_account_field', `Field '${unsupported}' is not supported`)
  }
}

function validateAccountType(
  body: Record<string, unknown>,
  platform: ProviderPlatform,
  credentialKind: AccountCredentialKind,
): void {
  if (body.type === undefined) return
  const expected = credentialKind === 'api_key'
    ? 'apikey'
    : credentialKind === 'setup_token' ? 'setup-token' : 'oauth'
  if (body.type !== expected || (platform !== 'codex' && body.type !== 'apikey')) {
    throw new GatewayError(409, 'type_not_supported', 'Account type does not select a supported Worker executor')
  }
}

function credentialKindForType(value: unknown, platform: ProviderPlatform): AccountCredentialKind {
  if (value === undefined) return defaultCredentialKind(platform)
  if (value === 'apikey') return 'api_key'
  if (platform === 'codex' && value === 'oauth') return 'oauth'
  if (platform === 'codex' && value === 'setup-token') return 'setup_token'
  throw new GatewayError(409, 'type_not_supported', 'Account type does not select a supported Worker executor')
}

const UI_CONFIG_VERSION = 1
const UI_COMPAT_FIELDS = [
  'notes', 'extra', 'proxy_id', 'load_factor', 'priority', 'expires_at',
  'auto_pause_on_expired', 'upstream_billing_probe_enabled',
  'upstream_billing_rate_sync_enabled',
] as const
const SECRET_CREDENTIAL_FIELDS = new Set([
  'api_key', 'access_token', 'refresh_token', 'id_token', 'session_key', 'cookie',
  'aws_secret_access_key', 'aws_session_token', 'service_account_json',
  'service_account', 'private_key', 'client_secret', 'password',
])

function requireCredentialObject(value: unknown, field: string, requireApiKeyShape: boolean): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be an object`)
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be JSON serializable`)
  }
  if (serialized.length > 65_536) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must not exceed 65536 characters`)
  }
  const result = JSON.parse(serialized) as Record<string, unknown>
  if (requireApiKeyShape && result.api_key !== undefined && typeof result.api_key !== 'string') {
    throw new GatewayError(400, 'invalid_api_key', 'api_key must be a string')
  }
  return result
}

function parseLegacyGroupIds(value: unknown, priority: number): GroupLinkInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new GatewayError(400, 'invalid_group_ids', 'group_ids must be an array with at most 100 entries')
  }
  return value.map((groupId) => ({
    group_id: requireResourceId(typeof groupId === 'number' ? String(groupId) : groupId as string, 'group'),
    priority,
    weight: 1,
  }))
}

function createUiConfig(
  body: Record<string, unknown>,
  credential: StoredAccountCredential,
  credentialKind: AccountCredentialKind,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    schema_version: UI_CONFIG_VERSION,
    type: body.type ?? (credentialKind === 'api_key'
      ? 'apikey'
      : credentialKind === 'setup_token' ? 'setup-token' : 'oauth'),
    credentials: publicCredentials(credential),
    credentials_status: credentialStatus(credential),
  }
  for (const field of UI_COMPAT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      assertNoSensitiveUiFields(body[field], field)
      config[field] = cloneJsonValue(body[field])
    }
  }
  return config
}

function updateUiConfig(
  current: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let changed = false
  const next: Record<string, unknown> = { ...current, schema_version: UI_CONFIG_VERSION }
  for (const field of UI_COMPAT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      assertNoSensitiveUiFields(body[field], field)
      next[field] = cloneJsonValue(body[field])
      changed = true
    }
  }
  return changed ? next : undefined
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    throw new GatewayError(400, 'invalid_account_field', 'Account form field must be JSON serializable')
  }
}

function assertNoSensitiveUiFields(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveUiFields(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('has_') && typeof entry === 'boolean') continue
    if (isSensitiveCredentialField(key)) {
      throw new GatewayError(
        400,
        'secret_outside_credentials',
        `Secret field '${path}.${key}' must be submitted inside credentials`,
      )
    }
    assertNoSensitiveUiFields(entry, `${path}.${key}`)
  }
}

function isSensitiveCredentialField(key: string): boolean {
  const normalized = key.toLowerCase()
  return SECRET_CREDENTIAL_FIELDS.has(normalized) ||
    normalized.endsWith('_token') || normalized.endsWith('_secret') ||
    normalized.endsWith('_password') || normalized.endsWith('_cookie') ||
    normalized.endsWith('_private_key')
}

function publicCredentials(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveCredentialField(key)) continue
    result[key] = publicCredentialValue(entry)
  }
  return result
}

function publicCredentialValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicCredentialValue)
  if (value !== null && typeof value === 'object') {
    return publicCredentials(value as Record<string, unknown>)
  }
  return value
}

function credentialStatus(value: Record<string, unknown>): Record<string, boolean> {
  const status: Record<string, boolean> = { has_api_key: isPresentSecret(value.api_key) }
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveCredentialField(key)) status[`has_${key}`] = isPresentSecret(entry)
  }
  return status
}

function isPresentSecret(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function mergeCredentialPatch(
  current: StoredAccountCredential,
  patch: Record<string, unknown>,
): StoredAccountCredential {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') delete next[key]
    else next[key] = value
  }
  const apiKey = requireProviderCredential({ api_key: next.api_key }, 'api_key')
  next.api_key = apiKey
  return next as StoredAccountCredential
}

function requireProviderCredential(body: Record<string, unknown>, field: string): string {
  const value = requireString(body, field, 8_192)
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} contains an invalid control character`)
  }
  return value
}

function requireProviderPlatform(value: unknown): ProviderPlatform {
  if (value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'codex') {
    return value
  }
  throw new GatewayError(409, 'platform_not_supported', 'Supported platforms are openai, anthropic, gemini, and codex')
}

function requireProviderProtocol(value: unknown): ProviderProtocol {
  if (value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'codex') {
    return value
  }
  throw new GatewayError(409, 'protocol_not_supported', 'Provider protocol is not supported')
}

function requireProviderAuthScheme(value: unknown): ProviderAuthScheme {
  if (value === 'bearer' || value === 'x-api-key' || value === 'x-goog-api-key') return value
  throw new GatewayError(409, 'auth_scheme_not_supported', 'Provider authentication scheme is not supported')
}

function requireAccountImageAdapter(value: unknown): AccountImageAdapter {
  if (value === 'direct_images' || value === 'responses_image_tool') return value
  throw new GatewayError(
    400,
    'invalid_image_adapter',
    'image_adapter must be direct_images or responses_image_tool',
  )
}

function requireAccountCredentialKind(value: unknown): AccountCredentialKind {
  if (value === 'api_key' || value === 'oauth' || value === 'setup_token') return value
  throw new GatewayError(
    400,
    'invalid_credential_kind',
    'credential_kind must be api_key, oauth, or setup_token',
  )
}

function defaultImageAdapter(platform: ProviderPlatform): AccountImageAdapter {
  return platform === 'codex' ? 'responses_image_tool' : 'direct_images'
}

function defaultCredentialKind(platform: ProviderPlatform): AccountCredentialKind {
  return platform === 'codex' ? 'oauth' : 'api_key'
}

function validateAccountExecution(
  platform: ProviderPlatform,
  imageAdapter: AccountImageAdapter,
  credentialKind: AccountCredentialKind,
): void {
  const supported = platform === 'codex'
    ? imageAdapter === 'responses_image_tool' &&
      (credentialKind === 'oauth' || credentialKind === 'setup_token')
    : imageAdapter === 'direct_images' && credentialKind === 'api_key'
  if (!supported) {
    throw new GatewayError(
      409,
      'account_execution_mismatch',
      'platform, image_adapter, and credential_kind do not select a supported runtime executor',
    )
  }
}

function assertImmutableProviderField<T extends string>(
  raw: unknown,
  current: T,
  field: string,
  parse: (value: unknown) => T,
): void {
  if (raw !== undefined && parse(raw) !== current) {
    throw new GatewayError(409, 'provider_contract_immutable', `${field} cannot be changed after account creation`)
  }
}

function parseProviderConfig(value: unknown, platform: ProviderPlatform): ProviderConfig {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_provider_config', 'provider_config must be an object')
  }
  const raw = value as Record<string, unknown>
  const unsupported = Object.keys(raw).find((key) => key !== 'account_id')
  if (unsupported !== undefined) {
    throw new GatewayError(400, 'invalid_provider_config', `provider_config field '${unsupported}' is not supported`)
  }
  if (raw.account_id === undefined) return {}
  if (platform !== 'codex') {
    throw new GatewayError(400, 'invalid_provider_config', 'account_id is supported only for Codex')
  }
  const accountId = requireString(raw, 'account_id', 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(accountId)) {
    throw new GatewayError(400, 'invalid_provider_config', 'Codex account_id is invalid')
  }
  return { account_id: accountId }
}

function parseEnabledBody(body: Record<string, unknown>, fallback: boolean): boolean {
  if (body.enabled !== undefined && body.status !== undefined) {
    throw new GatewayError(400, 'ambiguous_status', 'Provide enabled or status, not both')
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new GatewayError(400, 'invalid_enabled', 'enabled must be a boolean')
    return body.enabled
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'inactive') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
    }
    return body.status === 'active'
  }
  return fallback
}

function parseEnabledQuery(enabled: string | undefined, status: string | undefined): boolean | undefined {
  enabled = enabled === '' ? undefined : enabled
  status = status === '' ? undefined : status
  if (enabled !== undefined && status !== undefined) {
    throw new GatewayError(400, 'ambiguous_status', 'Provide enabled or status, not both')
  }
  if (enabled !== undefined) {
    if (enabled !== 'true' && enabled !== 'false') {
      throw new GatewayError(400, 'invalid_enabled', 'enabled must be true or false')
    }
    return enabled === 'true'
  }
  if (status !== undefined) {
    if (status !== 'active' && status !== 'inactive') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
    }
    return status === 'active'
  }
  return undefined
}

function parseGroupLinks(value: unknown): GroupLinkInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 40) {
    throw new GatewayError(400, 'invalid_group_links', 'group_links must be an array with at most 40 entries')
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GatewayError(400, 'invalid_group_links', 'Each group link must be an object')
    }
    const link = parseGroupLink(entry as Record<string, unknown>)
    if (seen.has(link.group_id)) throw new GatewayError(400, 'duplicate_group_link', 'group_links contains a duplicate group')
    seen.add(link.group_id)
    return link
  })
}

function parseGroupLink(body: Record<string, unknown>, resourceId?: string): GroupLinkInput {
  const groupId = resourceId ?? requireResourceId(requireString(body, 'group_id', 128), 'group')
  return {
    group_id: groupId,
    priority: body.priority === undefined ? 0 : requireSafeInteger(body, 'priority', 0, 1_000_000),
    weight: body.weight === undefined ? 1 : requireSafeInteger(body, 'weight', 1, 1_000_000),
  }
}

function parseModelCapabilities(value: unknown): ModelCapabilityInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 40) {
    throw new GatewayError(400, 'invalid_model_capabilities', 'model_capabilities must be an array with at most 40 entries')
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GatewayError(400, 'invalid_model_capabilities', 'Each model capability must be an object')
    }
    const capability = parseModelCapability(entry as Record<string, unknown>)
    if (seen.has(capability.model_id)) {
      throw new GatewayError(400, 'duplicate_model_capability', 'model_capabilities contains a duplicate model')
    }
    seen.add(capability.model_id)
    return capability
  })
}

function parseModelCapability(body: Record<string, unknown>, resourceId?: string): ModelCapabilityInput {
  const modelId = resourceId ?? requireResourceId(requireString(body, 'model_id', 128), 'model')
  const chatCompletions = optionalBoolean(body, 'chat_completions') ?? true
  const responses = optionalBoolean(body, 'responses') ?? true
  const embeddings = optionalBoolean(body, 'embeddings')
  const imageGeneration = optionalBoolean(body, 'image_generation')
  if (!chatCompletions && !responses && !embeddings && !imageGeneration) {
    throw new GatewayError(400, 'invalid_model_capability', 'At least one endpoint capability must be enabled')
  }
  return {
    model_id: modelId,
    chat_completions: chatCompletions,
    responses,
    ...(embeddings === undefined ? {} : { embeddings }),
    ...(imageGeneration === undefined ? {} : { image_generation: imageGeneration }),
  }
}

function optionalBoolean(body: Record<string, unknown>, field: string, fallback?: boolean): boolean | undefined {
  if (body[field] === undefined) return fallback
  if (typeof body[field] !== 'boolean') throw new GatewayError(400, `invalid_${field}`, `${field} must be a boolean`)
  return body[field] as boolean
}

async function validateLinks(
  env: Env,
  platform: ProviderPlatform,
  groupLinks: GroupLinkInput[],
  modelCapabilities: ModelCapabilityInput[],
): Promise<void> {
  const groups = groupLinks.map((link) => link.group_id)
  const models = modelCapabilities.map((capability) => capability.model_id)
  const [groupCheck, modelCheck] = await Promise.all([
    groups.length === 0
      ? null
      : env.DB.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN platform = ? THEN 0 ELSE 1 END), 0) AS mismatched
           FROM "groups"
          WHERE id IN (${groups.map(() => '?').join(', ')})`,
      ).bind(platform, ...groups).first<{ total: number; mismatched: number }>(),
    models.length === 0
      ? null
      : env.DB.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN platform = ? THEN 0 ELSE 1 END), 0) AS mismatched
           FROM models
          WHERE id IN (${models.map(() => '?').join(', ')})`,
      ).bind(platform, ...models).first<{ total: number; mismatched: number }>(),
  ])
  assertLinkCheck(groupCheck, groups.length, 'group')
  assertLinkCheck(modelCheck, models.length, 'model')
}

function assertLinkCheck(
  result: { total: number; mismatched: number } | null,
  expected: number,
  resource: 'group' | 'model',
): void {
  if (expected === 0) return
  if (result === null || !Number.isSafeInteger(result.total) || !Number.isSafeInteger(result.mismatched)) {
    throw new GatewayError(500, `invalid_${resource}_link_projection`, `${resource} link validation is invalid`, 'server_error')
  }
  if (result.total !== expected) {
    throw new GatewayError(404, `${resource}_not_found`, `One or more ${resource} links were not found`)
  }
  if (result.mismatched !== 0) {
    throw new GatewayError(409, `${resource}_platform_mismatch`, `Account and ${resource} platforms must match`)
  }
}

function groupInsertStatements(env: Env, accountId: string, links: GroupLinkInput[], now: number): D1PreparedStatement[] {
  return links.map((link) => env.DB.prepare(
    `INSERT INTO account_groups (
       account_id, group_id, priority, weight, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(accountId, link.group_id, link.priority, link.weight, now, now))
}

function capabilityInsertStatements(
  env: Env,
  accountId: string,
  capabilities: ModelCapabilityInput[],
  now: number,
): D1PreparedStatement[] {
  return capabilities.map((capability) => env.DB.prepare(
    `INSERT INTO account_models (
       account_id, model_id, chat_completions, responses, embeddings, image_generation,
       created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    accountId,
    capability.model_id,
    capability.chat_completions ? 1 : 0,
    capability.responses ? 1 : 0,
    capability.embeddings ? 1 : 0,
    capability.image_generation ? 1 : 0,
    now,
    now,
  ))
}

async function requireAccount(env: Env, rawId: string | undefined): Promise<AccountRow> {
  const id = requireResourceId(rawId, 'account')
  const account = await findAccount(env, id)
  if (account === null) throw new GatewayError(404, 'account_not_found', 'Account was not found')
  requireSupportedAccount(account)
  return account
}

async function findAccount(env: Env, id: string): Promise<AccountRow | null> {
  return env.DB.prepare(`${ACCOUNT_PROJECTION} WHERE a.id = ?`).bind(id).first<AccountRow>()
}

function requireSupportedAccount(account: AccountRow): void {
  const platform = requireProviderPlatform(account.platform)
  const contract = providerContract(platform)
  if (account.protocol !== contract.protocol || account.auth_scheme !== contract.auth_scheme) {
    throw new GatewayError(409, 'account_not_supported', 'Account provider contract is not supported')
  }
  validateBaseUrl(account.base_url)
  parseProviderConfig(accountProviderConfig(account), platform)
  const imageAdapter = requireAccountImageAdapter(account.image_adapter)
  const credentialKind = requireAccountCredentialKind(account.credential_kind)
  validateAccountExecution(platform, imageAdapter, credentialKind)
}

function providerAccount(row: AccountRow): ProviderAccount {
  return {
    platform: row.platform,
    protocol: row.protocol,
    auth_scheme: row.auth_scheme,
    base_url: row.base_url,
    provider_config: accountProviderConfig(row),
  }
}

function accountProviderConfig(row: AccountRow): ProviderConfig {
  return parseProviderConfigProjection(row.provider_config_json)
}

function publicAccount(row: AccountRow) {
  const groups = parseProjectionArray<Record<string, unknown>>(row.group_links_json, 'group links')
    .map((value) => ({
      group_id: String(value.group_id),
      priority: Number(value.priority),
      weight: Number(value.weight),
      control_version: Number(value.control_version),
    }))
  const capabilities = parseProjectionArray<Record<string, unknown>>(row.model_capabilities_json, 'model capabilities')
    .map((value) => ({
      model_id: String(value.model_id),
      chat_completions: Number(value.chat_completions) === 1,
      responses: Number(value.responses) === 1,
      embeddings: Number(value.embeddings) === 1,
      image_generation: Number(value.image_generation) === 1,
      control_version: Number(value.control_version),
    }))
  return accountResponse({
    id: row.id,
    platform: row.platform,
    name: row.name,
    enabled: row.enabled === 1,
    max_concurrency: row.max_concurrency,
    billing_rate_multiplier_ppm: row.billing_rate_multiplier_ppm,
    protocol: row.protocol,
    base_url: row.base_url,
    auth_scheme: row.auth_scheme,
    image_adapter: row.image_adapter,
    credential_kind: row.credential_kind,
    provider_config: accountProviderConfig(row),
    config_version: row.config_version,
    control_version: row.control_version,
    health_status: row.health_status,
    last_checked_at_ms: row.last_checked_at_ms,
    last_latency_ms: row.last_latency_ms,
    last_health_error: row.last_health_error,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
    credential_key_version: row.key_version,
    ui_config: parseUiConfig(row.ui_config_json),
    group_links: groups,
    model_capabilities: capabilities,
  })
}

function accountResponse(value: {
  id: string
  platform: ProviderPlatform
  name: string
  enabled: boolean
  max_concurrency: number
  billing_rate_multiplier_ppm: number
  protocol: ProviderProtocol
  base_url: string
  auth_scheme: ProviderAuthScheme
  image_adapter: AccountImageAdapter
  credential_kind: AccountCredentialKind
  provider_config: ProviderConfig
  config_version: number
  control_version: number
  health_status: 'unknown' | 'healthy' | 'unhealthy'
  last_checked_at_ms: number | null
  last_latency_ms: number | null
  last_health_error: string | null
  created_at_ms: number
  updated_at_ms: number
  credential_key_version: number
  ui_config: Record<string, unknown>
  group_links: GroupLink[]
  model_capabilities: ModelCapability[]
}) {
  const { billing_rate_multiplier_ppm: multiplierPpm, ui_config: uiConfig, ...publicValue } = value
  const compatibility = compatibilityProjection(uiConfig, value)
  return {
    ...publicValue,
    ...compatibility,
    rate_multiplier: multiplierPpm / 1_000_000,
    enabled: value.enabled,
    status: value.enabled ? 'active' as const : 'inactive' as const,
    credentials_status: compatibility.credentials_status ?? { has_api_key: true },
    provider_account_metadata: {
      quota: { status: 'unsupported' as const, value: null },
      tier: { status: 'unsupported' as const, value: null },
      privacy: { status: 'unsupported' as const, value: null },
    },
  }
}

function parseUiConfig(raw: unknown): Record<string, unknown> {
  // Rows created before migration 0064 (and lightweight test adapters that
  // model that schema) have no compatibility projection yet.
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw !== 'string') {
    throw new GatewayError(500, 'invalid_account_projection', 'Account UI projection is invalid', 'server_error')
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    assertNoSensitiveUiFields(value, 'ui_config_json')
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError(500, 'invalid_account_projection', 'Account UI projection is invalid', 'server_error')
  }
}

function compatibilityProjection(
  uiConfig: Record<string, unknown>,
  value: {
    base_url: string
    credential_kind: AccountCredentialKind
    max_concurrency: number
    group_links: GroupLink[]
  },
): Record<string, unknown> {
  const { schema_version: _schemaVersion, credentials: storedCredentials, ...stored } = uiConfig
  const credentials = storedCredentials !== null && typeof storedCredentials === 'object' && !Array.isArray(storedCredentials)
    ? storedCredentials as Record<string, unknown>
    : {}
  return {
    ...stored,
    type: uiConfig.type ?? (value.credential_kind === 'api_key'
      ? 'apikey'
      : value.credential_kind === 'setup_token' ? 'setup-token' : 'oauth'),
    credentials: { ...credentials, base_url: value.base_url },
    concurrency: value.max_concurrency,
    group_ids: value.group_links.map((link) => link.group_id),
  }
}

function parseRateMultiplier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GatewayError(400, 'invalid_rate_multiplier', 'rate_multiplier must be a non-negative exact decimal')
  }
  const ppm = value * 1_000_000
  if (!Number.isSafeInteger(ppm) || ppm > 10_000_000) {
    throw new GatewayError(400, 'invalid_rate_multiplier', 'rate_multiplier must be an exact decimal between 0 and 10')
  }
  return ppm
}

function parseProjectionArray<T>(raw: string, description: string): T[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('not an array')
    return value as T[]
  } catch {
    throw new GatewayError(500, 'invalid_account_projection', `Account ${description} projection is invalid`, 'server_error')
  }
}

function parseProviderConfigProjection(raw: string): ProviderConfig {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as ProviderConfig
  } catch {
    throw new GatewayError(500, 'invalid_account_projection', 'Account provider config projection is invalid', 'server_error')
  }
}

function assertVersion(account: AccountRow, expected: number): void {
  if (account.control_version !== expected) {
    throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
  }
}

function incrementVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, `${field}_exhausted`, `${field} is exhausted`)
  }
  return value + 1
}

function requireCredentialsMasterKey(env: Env): string {
  if (!env.CREDENTIALS_MASTER_KEY || env.CREDENTIALS_MASTER_KEY.length < 32) {
    throw new GatewayError(503, 'credential_secret_not_configured', 'Credential encryption secret is not configured', 'server_error')
  }
  return env.CREDENTIALS_MASTER_KEY
}

function normalizeBaseUrl(value: string): string {
  return validateBaseUrl(value).toString().replace(/\/$/, '')
}

function mapAccountWriteError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/UNIQUE constraint failed: accounts\.platform, accounts\.name/i.test(message)) {
    return new GatewayError(409, 'account_name_exists', 'An account with this name already exists')
  }
  if (/FOREIGN KEY constraint failed|invalid_account_(?:group|model)/i.test(message)) {
    return new GatewayError(409, 'account_link_conflict', 'Account links changed or are incompatible')
  }
  if (/CHECK constraint failed:.*control_version/i.test(message)) {
    return new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
  }
  return asGatewayError(error)
}

function invalidIdempotencyRecord(): GatewayError {
  return new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
}

function safeIdempotentAccount(
  row: Parameters<typeof parseIdempotentResponse>[0],
): ReturnType<typeof publicAccount> {
  const replay = parseIdempotentResponse<ReturnType<typeof publicAccount>>(row, 'account')
  if (row.resource_id !== replay.id || containsSensitiveCredentialField(replay)) {
    throw invalidIdempotencyRecord()
  }
  return replay
}

function containsSensitiveCredentialField(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSensitiveCredentialField)
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (['api_key', 'credential_ref', 'secret_id', 'nonce_b64', 'ciphertext_b64'].includes(key)) {
      return true
    }
    if (containsSensitiveCredentialField(nested)) return true
  }
  return false
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
