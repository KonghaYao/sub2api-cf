import { resolveAccountRequestAuthentication } from './account-request-authentication'
import { importAgentIdentitySigningKey } from '../gateway/openai-agent-assertion'
import { claimAccountOAuthRefresh, releaseAccountOAuthRefresh, accountOAuthRefreshLeaseGuard } from './account-oauth-refresh-lock'
import { refreshAnthropicOAuthToken } from './anthropic-oauth-refresh'
import { accountInitializationInsert, accountInitializationReset, dispatchAccountInitializations, initializeAccountNow } from './account-initialization'
import { applyOpenAIAccountPrivacy } from './account-privacy'
import { effectiveProviderAccount } from './provider-runtime'
import { readGrokSettings } from './grok-runtime'
import { grokBaseURLs, resolveGrokModel } from './grok-settings'
import { enrichAccountOllamaUsage } from './ollama-cloud-usage'
import { accountFetcher, accountProxyId, type AccountFetcher } from '../proxy/account-fetch'
import { validateAccountProxy } from './proxies'
import type { Context } from 'hono'
import type { Env } from '../env'
import { decryptCredential, decryptCredentialPayload, encryptCredential } from '../gateway/crypto'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { accountModelPolicy } from '../gateway/account-model-policy'
import { diagnosticUsesResponses, accountTextDiagnostic } from './account-text-diagnostic'
import { openAICompactDiagnostic } from './openai-compact-diagnostic'
import { accountNotRateLimitedSql, accountNotTemporarilyBlockedSql } from '../gateway/account-rate-limit'
import { persistOpenAIRateLimit } from '../gateway/openai-rate-limit-persistence'
import { accountQuotaProjection } from './account-quota-projection'
import { OPENAI_OAUTH_CLIENT_ID, OpenAITokenEndpointError, requestOpenAITokens } from './openai-oauth-http'
import { enrichOpenAITokenInfo, openAITokenInfo, type OpenAITokenInfo } from './openai-oauth-profile'
import { normalizeHeaderOverrideCredentials } from '../gateway/account-header-overrides'
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
  type ControlIdempotency,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  readOptionalJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from './http'

import { testAccountModel } from './account-model-test'
import { fetchUpstreamModels } from './upstream-models'

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
  proxy_summary_json?: string | null
  proxy_fallback_origin_name?: string | null
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
  subscription_plan?: string | null
}

interface BatchDeleteTarget {
  id: string
  expected_control_version: number
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
         (SELECT json_object('id', p.id, 'name', COALESCE(json_extract(p.config_json,'$.name'),p.name), 'protocol', p.protocol,
           'host', p.host, 'port', p.port, 'status', p.status,
           'expires_at', CASE WHEN p.expires_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', p.expires_at, 'unixepoch') END,
           'fallback_mode', p.fallback_mode, 'backup_proxy_id', p.backup_proxy_id,
           'expiry_warn_days', p.expiry_warn_days)
          FROM proxies p WHERE p.id=CAST(json_extract(a.ui_config_json, '$.proxy_id') AS TEXT)) AS proxy_summary_json,
         (SELECT COALESCE(json_extract(p.config_json,'$.name'),p.name) FROM proxies p WHERE p.id=CAST(json_extract(a.ui_config_json, '$.proxy_fallback_origin_id') AS TEXT)) AS proxy_fallback_origin_name,
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
        OR (a.platform = 'grok' AND a.protocol = 'openai' AND a.auth_scheme = 'bearer')
        OR (a.platform = 'antigravity' AND a.protocol = 'gemini' AND a.auth_scheme = 'bearer')
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
    appendAccountStatusCondition(
      conditions,
      values,
      context.req.query('enabled'),
      context.req.query('status'),
    )
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
      schedulable: "COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1)",
      priority: "COALESCE(json_extract(a.ui_config_json, '$.priority'), 50)",
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
    const rows = rowsResult.results as unknown as AccountRow[]
    const ollama = await enrichAccountOllamaUsage(context.env, rows)
    return controlSuccess({
      items: rows.map(row => ({ ...publicAccount(row), ...(ollama.has(row.id) ? { ollama_cloud_usage: ollama.get(row.id) } : {}) })),
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
    const ollama = await enrichAccountOllamaUsage(context.env, [account])
    return controlSuccess({ ...publicAccount(account), ...(ollama.has(account.id) ? { ollama_cloud_usage: ollama.get(account.id) } : {}) })
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
    const result = await executeAccountCreate(context.env, await readJsonObject(context.req.raw), requireIdempotencyKey(context.req.raw))
    try { await dispatchAccountInitializations(context.env, result.account.id) } catch { /* Cron recovers pending initialization. */ }
    return controlSuccess(result.account, result.created ? 201 : 200)
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function executeAccountCreate(env: Env, body: Record<string, unknown>, idempotencyKey: string, initializeAccount = false, receipt?: (id: string) => D1PreparedStatement) {
    const input = parseCreateAccount(body)
    if(input.credential.auth_mode==='agentIdentity') await importAgentIdentitySigningKey(input.credential.agent_private_key as string)
    const idempotency = await controlIdempotency('admin.accounts.create.v1', idempotencyKey, input)
    const previous = await findControlIdempotency(env, idempotency)
    if (previous !== null) {
      const replay = safeIdempotentAccount(previous)
      return { account: replay, created: false }
    }

    const accountId = await deterministicUuid('admin.accounts.create.v1', idempotencyKey)
    const secretId = await deterministicUuid('admin.account-secrets.create.v1', idempotencyKey)
    if ((await findAccount(env, accountId)) !== null) {
      throw new GatewayError(409, 'idempotency_record_missing', 'Account exists without its idempotency record')
    }
    await validateAccountProxy(env, input.ui_config.proxy_id)
    await validateLinks(env, input.platform, input.group_links, input.model_capabilities)
    const masterKey = requireCredentialsMasterKey(env)
    const encrypted = await encryptCredential(
      input.credential,
      masterKey,
      credentialAad(env.ENVIRONMENT, accountId, secretId, 1),
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
      env.DB.prepare(
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
      env.DB.prepare(
        `INSERT INTO account_secrets (
           id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).bind(secretId, accountId, encrypted.nonce_b64, encrypted.ciphertext_b64, now, now),
      ...groupInsertStatements(env, accountId, input.group_links, now),
      ...capabilityInsertStatements(env, accountId, input.model_capabilities, now),
      ...(input.platform === 'openai' && (input.credential_kind === 'api_key' || input.credential_kind === 'oauth') ? [accountInitializationInsert(env, accountId, now, input.credential_kind === 'oauth' ? 'openai_privacy' : 'openai_responses')] : []),
      controlIdempotencyInsert(env, idempotency, 'account', accountId, safe, now),
      ...(receipt ? [receipt(accountId)] : []),
    ]
    try {
      await env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(env, idempotency)
      if (recovered !== null) {
        const replay = safeIdempotentAccount(recovered)
        return { account: replay, created: false }
      }
      throw mapAccountWriteError(error)
    }
    if (!initializeAccount && input.platform === 'openai' && input.credential_kind === 'oauth') {
      try { await initializeAccountNow(env, accountId, false) } catch { /* The durable job recovers an interrupted initialization. */ }
      const initialized = publicAccount(await requireAccount(env, accountId))
      await env.DB.prepare('UPDATE control_idempotency SET response_json=? WHERE scope=? AND key_hash=?')
        .bind(JSON.stringify(initialized), idempotency.scope, idempotency.key_hash).run()
      return { account: initialized, created: true }
    }
    return { account: safe, created: true }
 }

export async function batchCreateAdminAccounts(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    if (!Array.isArray(body.accounts) || body.accounts.length === 0 || body.accounts.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new GatewayError(400, 'invalid_accounts', 'accounts must be a non-empty array of account objects')
    }
    const items = body.accounts as Record<string, unknown>[]
    // Original validation happens before creating any account, including later rows.
    for (const item of items) {
      const extra = item.extra
      if (item.platform === 'openai' && extra && typeof extra === 'object' && !Array.isArray(extra) &&
          Object.hasOwn(extra, 'openai_long_context_billing_enabled') && typeof (extra as Record<string, unknown>).openai_long_context_billing_enabled !== 'boolean') {
        throw new GatewayError(400, 'OPENAI_LONG_CONTEXT_BILLING_INVALID', 'openai_long_context_billing_enabled must be a boolean')
      }
    }
    const key = context.req.header('idempotency-key') === undefined ? crypto.randomUUID() : requireIdempotencyKey(context.req.raw)
    const idempotency = await controlIdempotency('admin.accounts.batch-create.v1', key, { accounts: items })
    let previous = await findControlIdempotency(context.env, idempotency)
    if (previous === null) {
      try { await controlIdempotencyInsert(context.env, idempotency, 'account_batch_pending', idempotency.key_hash, {}, Date.now()).run() }
      catch (error) { if (!await findControlIdempotency(context.env, idempotency)) throw error }
      previous = await findControlIdempotency(context.env, idempotency)
    }
    if (previous?.resource_type === 'account_batch') return controlSuccess(parseIdempotentResponse(previous, 'account_batch'))
    const results: Array<{ name: string; id?: string; success: boolean; error?: string }> = []
    for (const [index, item] of items.entries()) {
      const name = typeof item.name === 'string' ? item.name : ''
      try {
        let input = item
        const extra = item.extra
        if (extra && typeof extra === 'object' && !Array.isArray(extra) && Object.hasOwn(extra, 'base_rpm')) {
          const raw = (extra as Record<string, unknown>).base_rpm
          const rpm = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw)
            : typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0
          input = { ...item, extra: { ...extra, base_rpm: Math.min(10000, Math.max(0, rpm)) } }
        }
        const result = await executeAccountCreate(context.env, input, `batch-account-${idempotency.key_hash}-${index}`, true)
        results.push({ name, id: result.account.id, success: true })
        try { await dispatchAccountInitializations(context.env, result.account.id) } catch { /* Cron recovers the committed outbox. */ }
      } catch (error) { results.push({ name, success: false, error: asGatewayError(error).message }) }
    }
    const result = { success: results.filter(row => row.success).length, failed: results.filter(row => !row.success).length, results }
    await context.env.DB.prepare(`UPDATE control_idempotency SET resource_type = 'account_batch', response_json = ?
      WHERE scope = ? AND key_hash = ? AND request_hash = ? AND resource_type = 'account_batch_pending'`)
      .bind(JSON.stringify(result), idempotency.scope, idempotency.key_hash, idempotency.request_hash).run()
    const completed = await findControlIdempotency(context.env, idempotency)
    return controlSuccess(completed?.resource_type === 'account_batch' ? parseIdempotentResponse(completed, 'account_batch') : result)
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function updateAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    if (new URL(context.req.url).pathname.endsWith('/schedulable')) {
      rejectUnknownFields(body, new Set(['schedulable', 'control_version']))
      if (typeof body.schedulable !== 'boolean') {
        throw new GatewayError(400, 'invalid_schedulable', 'schedulable must be a boolean')
      }
    }
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const initializeResponses = !new URL(context.req.url).pathname.endsWith('/schedulable')
    const updated = await executeAccountUpdate(context.env, context.req.param('id')!, body, expectedVersion, undefined, { initializeResponses })
    if (initializeResponses) try { await dispatchAccountInitializations(context.env, updated.id) } catch { /* Durable edit outbox. */ }
    return controlSuccess(updated)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Persist tokens returned by the original re-authorization modal. */
export async function applyAdminAccountOAuthCredentials(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    rejectUnknownFields(body, new Set(['type', 'credentials', 'extra']))
    if (body.type !== 'oauth' && body.type !== 'setup-token') {
      throw new GatewayError(400, 'invalid_oauth_type', 'type must be oauth or setup-token')
    }
    const credentials = requireCredentialObject(body.credentials, 'credentials', false)
    if (body.extra != null && (typeof body.extra !== 'object' || Array.isArray(body.extra))) {
      throw new GatewayError(400, 'invalid_extra', 'extra must be an object')
    }
    const account = await requireAccount(context.env, context.req.param('id'))
    if (account.credential_kind !== 'oauth' && account.credential_kind !== 'setup_token') {
      throw new GatewayError(400, 'NOT_OAUTH', 'Cannot apply OAuth credentials to a non-OAuth account')
    }
    if (parseUiConfig(account.ui_config_json).parent_account_id != null) {
      throw new GatewayError(400, 'SPARK_SHADOW_CREDENTIALS_READ_ONLY', 'Re-authorize the parent account instead')
    }
    const extra = body.extra as Record<string, unknown> | null | undefined
    if (account.platform === 'openai' && extra && Object.hasOwn(extra, 'openai_long_context_billing_enabled') &&
        typeof extra.openai_long_context_billing_enabled !== 'boolean') {
      throw new GatewayError(400, 'OPENAI_LONG_CONTEXT_BILLING_INVALID', 'openai_long_context_billing_enabled must be a boolean')
    }
    const expected = context.req.header('if-match') === undefined ? account.control_version
      : requireExpectedControlVersion(context.req.raw, {})
    return controlSuccess(await executeAccountUpdate(context.env, account.id, {
      credentials, credential_kind: body.type === 'oauth' ? 'oauth' : 'setup_token',
      ...(extra == null ? {} : { extra }),
    }, expected, undefined, { mergeExtra: true, reauthorize: true }))
  } catch (error) { return controlError(asGatewayError(error)) }
}

/** Original batch-field update: validate every account before writing; report individual write failures. */
export async function batchUpdateAdminAccountCredentials(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    if (!Array.isArray(body.account_ids) || body.account_ids.length === 0) {
      throw new GatewayError(400, 'invalid_account_ids', 'account_ids must be a non-empty array')
    }
    const field = body.field
    if (typeof field !== 'string' || !['account_uuid', 'org_uuid', 'intercept_warmup_requests'].includes(field)) {
      throw new GatewayError(400, 'invalid_credential_field', 'field must be account_uuid, org_uuid or intercept_warmup_requests')
    }
    const value = body.value ?? null
    if (field === 'intercept_warmup_requests' ? typeof value !== 'boolean' : value !== null && typeof value !== 'string') {
      throw new GatewayError(400, 'invalid_credential_value', field === 'intercept_warmup_requests' ? 'intercept_warmup_requests must be boolean' : `${field} must be string or null`)
    }
    const ids = body.account_ids.map(id => requireResourceId(typeof id === 'number' ? String(id) : id, 'account'))
    const versions = new Map<string, number>()
    for (const id of ids) if (!versions.has(id)) versions.set(id, (await requireAccount(context.env, id)).control_version)
    const results: Array<{ account_id: string; success: boolean; error?: string }> = []
    const successIds: string[] = [], failedIds: string[] = []
    for (const id of ids) {
      try {
        const updated = await executeAccountUpdate(context.env, id, { credentials: { [field]: value } }, versions.get(id)!, undefined, { fieldUpdate: true })
        versions.set(id, updated.control_version)
        successIds.push(id); results.push({ account_id: id, success: true })
      } catch (error) {
        failedIds.push(id); results.push({ account_id: id, success: false, error: asGatewayError(error).message })
      }
    }
    return controlSuccess({ success: successIds.length, failed: failedIds.length, success_ids: successIds, failed_ids: failedIds, results })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function executeAccountUpdate(env: Env, id: string, body: Record<string, unknown>, expectedVersion: number,
  idempotency?: ControlIdempotency, options: { mergeExtra?: boolean; reauthorize?: boolean; fieldUpdate?: boolean; initializeResponses?: boolean; receipt?: (id: string) => D1PreparedStatement } = {}) {
    const { mergeExtra = false, reauthorize = false, fieldUpdate = false, initializeResponses = false } = options
    const account = await requireAccount(env, id)
    assertVersion(account, expectedVersion)
    if (fieldUpdate && parseUiConfig(account.ui_config_json).parent_account_id != null) {
      throw new GatewayError(400, 'SPARK_SHADOW_NO_CREDENTIALS', 'Update credential fields on the parent account instead')
    }
    if (mergeExtra && body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra)) {
      const previous = parseUiConfig(account.ui_config_json).extra
      body = { ...body, extra: { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), ...body.extra } }
    }
    const patch = parseAccountPatch(body, account)
    await validateLinks(
      env,
      account.platform,
      patch.group_links ?? [],
      patch.model_capabilities ?? [],
    )
    const nextControlVersion = incrementVersion(account.control_version, 'control_version')
    const nextConfigVersion = incrementVersion(account.config_version, 'config_version')
    const now = Date.now()
    const baseUrl = patch.base_url ?? account.base_url
    const providerConfig = applySubscriptionPlan(
      patch.provider_config ?? parseProviderConfigProjection(account.provider_config_json),
      patch.subscription_plan,
      account.platform,
      patch.credential_kind ?? account.credential_kind,
    )
    const resetHealth = !fieldUpdate && (patch.base_url !== undefined ||
      patch.credential_patch !== undefined ||
      patch.provider_config !== undefined ||
      patch.image_adapter !== undefined ||
      patch.credential_kind !== undefined ||
      (patch.ui_config !== undefined && patch.ui_config.proxy_id !== accountProxyId(account.ui_config_json)))
    let nextUiConfig = patch.ui_config ?? parseUiConfig(account.ui_config_json)
    if (patch.ui_config !== undefined) await validateAccountProxy(env, nextUiConfig.proxy_id)
    const billingProbeExtra = nextUiConfig.extra as Record<string,unknown> | undefined
    if (patch.billing_rate_multiplier_ppm !== undefined && patch.billing_rate_multiplier_ppm !== account.billing_rate_multiplier_ppm && billingProbeExtra?.upstream_billing_probe_enabled === true && billingProbeExtra?.upstream_billing_rate_sync_enabled === true) {
      throw new GatewayError(409,'upstream_billing_rate_sync_conflict','Disable upstream billing rate sync before manually changing the account rate')
    }
    let nextCredential: StoredAccountCredential | undefined
    let credentialIdentityChanged = false
    if (patch.credential_patch !== undefined) {
      const currentCredential = await decryptCredentialPayload(
        account.nonce_b64,
        account.ciphertext_b64,
        requireCredentialsMasterKey(env),
        credentialAad(env.ENVIRONMENT, account.id, account.secret_id, account.key_version),
      )
      nextCredential = reauthorize
        ? mergeReauthorizedCredential(currentCredential as StoredAccountCredential, patch.credential_patch)
        : mergeCredentialPatch(currentCredential as StoredAccountCredential, patch.credential_patch)
      // Original batch field assignment preserves explicit null/empty non-secret values.
      if (fieldUpdate) Object.assign(nextCredential, patch.credential_patch)
      if(String(nextCredential.auth_mode).trim().toLowerCase()==='agentidentity') {
        if(account.platform!=='openai' || (patch.credential_kind??account.credential_kind)!=='oauth') throw new GatewayError(400,'invalid_agent_identity','Agent Identity requires an OpenAI OAuth account')
        for(const field of ['agent_runtime_id','agent_private_key','chatgpt_account_id','chatgpt_user_id']) requireString(nextCredential,field,field==='agent_private_key'?16384:2048)
        await importAgentIdentitySigningKey(nextCredential.agent_private_key as string)
        nextCredential.auth_mode='agentIdentity'
      }

      credentialIdentityChanged = JSON.stringify(nextCredential) !== JSON.stringify(currentCredential)
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
    if (reauthorize) {
      nextUiConfig = { ...nextUiConfig, type: patch.credential_kind === 'setup_token' ? 'setup-token' : 'oauth' }
      delete nextUiConfig.rate_limited_at
      delete nextUiConfig.rate_limit_reset_at
    }
    const oldUiConfig = parseUiConfig(account.ui_config_json)
    const proxyIdentity = (value: unknown) => value == null || String(value) === '0' ? null : String(value)
    if (baseUrl !== account.base_url || credentialIdentityChanged ||
        (patch.credential_kind !== undefined && patch.credential_kind !== account.credential_kind) ||
        proxyIdentity(nextUiConfig.proxy_id) !== proxyIdentity(oldUiConfig.proxy_id) ||
        JSON.stringify(providerConfig) !== JSON.stringify(parseProviderConfigProjection(account.provider_config_json))) {
      const extra = nextUiConfig.extra
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        const cleaned = { ...extra } as Record<string, unknown>
        delete cleaned.upstream_billing_probe
        nextUiConfig = { ...nextUiConfig, extra: cleaned }
      }
    }
    const statements: D1PreparedStatement[] = [
      accountCasStatement(env, account.id, account.control_version, {
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
    if (reauthorize) {
      statements.push(env.DB.prepare(`UPDATE accounts SET consecutive_health_failures = 0,
        health_probe_generation = health_probe_generation + 1, health_probe_lease_until_ms = NULL,
        next_health_probe_at_ms = ?, recovery_revision = recovery_revision + 1 WHERE id = ?`).bind(now, account.id))
    }
    if (nextCredential !== undefined) {
      nextKeyVersion = incrementVersion(account.key_version, 'credential_key_version')
      const encrypted = await encryptCredential(
        nextCredential,
        requireCredentialsMasterKey(env),
        credentialAad(env.ENVIRONMENT, account.id, account.secret_id, nextKeyVersion),
      )
      statements.push(
        env.DB.prepare(
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
    if (body.priority !== undefined && patch.group_links === undefined) {
      statements.push(env.DB.prepare(`UPDATE account_groups SET priority = ?,
        control_version = control_version + 1, updated_at_ms = ? WHERE account_id = ?`)
        .bind(requireSafeInteger(body, 'priority', -1000, 1000), now, account.id))
    }
    if (patch.group_links !== undefined) {
      statements.push(
        env.DB.prepare('DELETE FROM account_groups WHERE account_id = ?').bind(account.id),
        ...groupInsertStatements(env, account.id, patch.group_links, now),
      )
    }
    if (patch.model_capabilities !== undefined) {
      statements.push(
        env.DB.prepare('DELETE FROM account_models WHERE account_id = ?').bind(account.id),
        ...capabilityInsertStatements(env, account.id, patch.model_capabilities, now),
      )
    }
    if (initializeResponses && account.platform === 'openai' && (patch.credential_kind ?? account.credential_kind) === 'api_key') {
      statements.push(accountInitializationReset(env, account.id, nextKeyVersion, now))
    }
    if (options.receipt) statements.push(options.receipt(account.id))
    if (idempotency) statements.push(controlIdempotencyInsert(env, idempotency, 'account_bulk_edit', account.id,
      { account_id: account.id, success: true, control_version: nextControlVersion }, now))
    await runAccountBatch(env, statements, account.id, account.control_version)
    const updated = await requireAccount(env, account.id)
    if (updated.control_version !== nextControlVersion || updated.config_version !== nextConfigVersion) {
      throw new GatewayError(503, 'account_projection_failed', 'Account update could not be read', 'server_error')
    }
    if (updated.key_version !== nextKeyVersion) {
      throw new GatewayError(503, 'account_projection_failed', 'Credential update could not be read', 'server_error')
    }
    return publicAccount(updated)
}

export async function refreshAdminAccountCredentials(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, 'invalid_oauth_refresh_request', 'OAuth refresh does not accept a request body')
    }
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const accountId = requireResourceId(context.req.param('id'), 'account')
    const idempotency = await controlIdempotency('admin.accounts.oauth-refresh.v1', requireIdempotencyKey(context.req.raw), {
      account_id: accountId, expected_control_version: expectedVersion,
    })
    return controlSuccess(await refreshOAuthAccount(
      context.env, accountId, expectedVersion, idempotency,
    ))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

interface OAuthRefreshTarget {
  id: string
  expected_control_version: number
}

interface OAuthRefreshBatchResult {
  account_id: string
  success: boolean
  control_version?: number
  error?: { code: string; message: string }
}

export async function batchRefreshAdminAccountCredentials(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    if (Object.keys(body).some((key) => key !== 'accounts')) {
      throw new GatewayError(400, 'invalid_oauth_refresh_request', 'OAuth batch refresh accepts only accounts')
    }
    const accounts = parseOAuthRefreshTargets(body.accounts)
    const idempotency = await controlIdempotency(
      'admin.accounts.oauth-refresh-batch.v1', requireIdempotencyKey(context.req.raw), { accounts },
    )
    const existing = await findControlIdempotency(context.env, idempotency)
    if (existing !== null) return controlSuccess(parseIdempotentResponse(existing, 'account_batch_refresh'))

    const results = await runWithConcurrency(accounts, 5, async (target, index): Promise<OAuthRefreshBatchResult> => {
      const itemIdempotency = await controlIdempotency(
        'admin.accounts.oauth-refresh-batch.item.v1', `${idempotency.key_hash}:${index}`,
        { parent_request_hash: idempotency.request_hash, target },
      )
      try {
        const account = await refreshOAuthAccount(
          context.env, target.id, target.expected_control_version, itemIdempotency,
        )
        return { account_id: target.id, success: true, control_version: account.control_version }
      } catch (error) {
        const mapped = asGatewayError(error)
        return { account_id: target.id, success: false, error: { code: mapped.code, message: mapped.message } }
      }
    })
    const response = {
      total: results.length,
      success: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success).length,
      success_ids: results.filter((result) => result.success).map((result) => result.account_id),
      failed_ids: results.filter((result) => !result.success).map((result) => result.account_id),
      errors: results.filter((result) => !result.success).map((result) => ({
        account_id: result.account_id,
        error: result.error!.message,
      })),
      results,
    }
    try {
      await controlIdempotencyInsert(
        context.env, idempotency, 'account_batch_refresh', idempotency.key_hash, response, Date.now(),
      ).run()
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'account_batch_refresh'))
      throw error
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function refreshOAuthAccount(
  env: Env, accountId: string, expectedVersion: number,
  idempotency: Awaited<ReturnType<typeof controlIdempotency>>,
): Promise<ReturnType<typeof accountResponse>> {
  const existing = await findControlIdempotency(env, idempotency)
  if (existing !== null) return parseIdempotentResponse(existing, 'account')
  assertVersion(await requireAccount(env, accountId), expectedVersion)
  const lease = await claimAccountOAuthRefresh(env, accountId, expectedVersion)
  let errorCode: string | null = null
  try { return await executeOAuthAccountRefresh(env, accountId, expectedVersion, idempotency, lease) }
  catch (error) { errorCode = asGatewayError(error).code; throw error }
  finally {
    // A release outage cannot turn a committed rotation into an apparent failure.
    // The durable lease expires and remains fenced at credential commit time.
    try { await releaseAccountOAuthRefresh(env, accountId, lease, errorCode) } catch { /* recovered by lease expiry */ }
  }
}

async function executeOAuthAccountRefresh(
  env: Env,
  accountId: string,
  expectedVersion: number,
  idempotency: Awaited<ReturnType<typeof controlIdempotency>>,
  leaseToken: string,
): Promise<ReturnType<typeof accountResponse>> {
    const existing = await findControlIdempotency(env, idempotency)
    if (existing !== null) return parseIdempotentResponse(existing, 'account')
    let account = await requireAccount(env, accountId)
    assertVersion(account, expectedVersion)
    const refreshable = account.platform === 'openai' && account.credential_kind === 'oauth' ||
      account.platform === 'anthropic' && ['oauth', 'setup_token'].includes(account.credential_kind)
    if (!refreshable) {
      throw new GatewayError(409, 'oauth_refresh_not_supported', 'Credential refresh is currently supported for OpenAI and Claude OAuth accounts')
    }
    if (parseUiConfig(account.ui_config_json).parent_account_id != null) {
      throw new GatewayError(400, 'SPARK_SHADOW_NO_REFRESH', 'Refresh the parent account instead')
    }
    const currentCredential = await decryptCredential(
      account.nonce_b64, account.ciphertext_b64, requireCredentialsMasterKey(env),
      credentialAad(env.ENVIRONMENT, account.id, account.secret_id, account.key_version),
    ) as StoredAccountCredential
    const refreshToken = typeof currentCredential.refresh_token === 'string' ? currentCredential.refresh_token.trim() : ''
    if (!refreshToken) {
      throw new GatewayError(409, 'oauth_refresh_token_missing', 'OAuth account has no refresh token; re-authorize the account')
    }
    const proxyId = parseUiConfig(account.ui_config_json).proxy_id
    const refreshed = account.platform === 'anthropic' ? null
      : await refreshOpenAIOAuthToken(env, refreshToken, currentCredential.client_id, proxyId)
    const claude = account.platform === 'anthropic' ? await refreshAnthropicOAuthToken(env, refreshToken, proxyId) : null
    const nextCredential: StoredAccountCredential = claude ? {
      ...currentCredential, api_key: claude.access_token, access_token: claude.access_token,
      token_type: claude.token_type, expires_in: String(claude.expires_in), expires_at: String(claude.expires_at),
      ...(claude.refresh_token?.trim() ? { refresh_token: claude.refresh_token } : {}),
      ...(claude.scope.trim() ? { scope: claude.scope } : {}),
    } : mergeOpenAIRefreshCredential(currentCredential, refreshed!)
    // Refresh tokens can rotate upstream: retry only the local transaction, never
    // the provider request, when ordinary usage observations advance config_version.
    const originalSecretId = account.secret_id
    const originalKeyVersion = account.key_version
    for (let attempt = 0; attempt < 3; attempt++) {
      account = await requireAccount(env, accountId)
      assertVersion(account, expectedVersion)
      if (account.secret_id !== originalSecretId || account.key_version !== originalKeyVersion) {
        throw new GatewayError(412, 'control_version_conflict', 'Account credentials changed during refresh')
      }
      const nextKeyVersion = incrementVersion(account.key_version, 'credential_key_version')
      const nextConfigVersion = incrementVersion(account.config_version, 'config_version')
      const nextControlVersion = incrementVersion(account.control_version, 'control_version')
      const now = Date.now()
      const encrypted = await encryptCredential(
        nextCredential, requireCredentialsMasterKey(env),
        credentialAad(env.ENVIRONMENT, account.id, account.secret_id, nextKeyVersion),
      )
      const previousUi = parseUiConfig(account.ui_config_json)
      const previousExtra = previousUi.extra && typeof previousUi.extra === 'object' && !Array.isArray(previousUi.extra)
        ? previousUi.extra as Record<string, unknown> : {}
      const previousPrivacy = typeof previousExtra.privacy_mode === 'string' ? previousExtra.privacy_mode.trim() : ''
      const ensurePrivacy = !Object.hasOwn(previousExtra, 'privacy_mode') ||
        previousPrivacy === 'training_set_failed' || previousPrivacy === 'training_set_cf_blocked'
      const uiConfig = {
        ...previousUi,
        extra: { ...previousExtra, ...(ensurePrivacy && refreshed?.privacy_mode ? { privacy_mode: refreshed.privacy_mode } : {}) },
        credentials: publicCredentials(nextCredential),
        credentials_status: credentialStatus(nextCredential),
      }
      const safe = accountResponse({
        id: account.id, platform: account.platform, name: account.name, enabled: account.enabled === 1,
        max_concurrency: account.max_concurrency, billing_rate_multiplier_ppm: account.billing_rate_multiplier_ppm,
        protocol: account.protocol, base_url: account.base_url, auth_scheme: account.auth_scheme,
        image_adapter: account.image_adapter, credential_kind: account.credential_kind,
        provider_config: accountProviderConfig(account), config_version: nextConfigVersion,
        control_version: nextControlVersion, health_status: 'unknown', last_checked_at_ms: null,
        last_latency_ms: null, last_health_error: null, created_at_ms: account.created_at_ms,
        updated_at_ms: now, credential_key_version: nextKeyVersion, ui_config: uiConfig,
        group_links: parseGroupLinksProjection(account.group_links_json),
        model_capabilities: parseModelCapabilitiesProjection(account.model_capabilities_json),
      })
      try {
        await runAccountBatch(env, [
          accountOAuthRefreshLeaseGuard(env, account.id, leaseToken, nextKeyVersion),
          accountCasStatement(env, account.id, account.control_version, {
            name: account.name, enabled: account.enabled === 1, max_concurrency: account.max_concurrency,
            base_url: account.base_url, provider_config: accountProviderConfig(account), image_adapter: account.image_adapter,
            credential_kind: account.credential_kind, billing_rate_multiplier_ppm: account.billing_rate_multiplier_ppm,
            ui_config: uiConfig, config_version: nextConfigVersion, control_version: nextControlVersion, now, reset_health: true,
            expected_config_version: account.config_version,
          }),
          env.DB.prepare(
            `UPDATE account_secrets SET key_version = CASE WHEN key_version = ? THEN ? ELSE 0 END,
               nonce_b64 = ?, ciphertext_b64 = ?, updated_at_ms = ? WHERE id = ? AND account_id = ?`,
          ).bind(account.key_version, nextKeyVersion, encrypted.nonce_b64, encrypted.ciphertext_b64, now, account.secret_id, account.id),
          controlIdempotencyInsert(env, idempotency, 'account', account.id, safe, now),
        ], account.id, account.control_version)
      } catch (error) {
        const recovered = await findControlIdempotency(env, idempotency)
        if (recovered !== null) return parseIdempotentResponse(recovered, 'account')
        const latest = await requireAccount(env, accountId)
        if (attempt < 2 && latest.control_version === expectedVersion && latest.secret_id === originalSecretId &&
          latest.key_version === originalKeyVersion && latest.config_version !== account.config_version) continue
        throw mapAccountWriteError(error)
      }
      return safe
    }
    throw new GatewayError(412, 'control_version_conflict', 'Account changed during refresh')
}

function parseOAuthRefreshTargets(value: unknown): OAuthRefreshTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 25) {
    throw new GatewayError(400, 'invalid_accounts', 'accounts must contain between 1 and 25 entries')
  }
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new GatewayError(400, 'invalid_accounts', `accounts[${index}] must be an object`)
    }
    const row = item as Record<string, unknown>
    if (Object.keys(row).some((key) => key !== 'id' && key !== 'expected_control_version')) {
      throw new GatewayError(400, 'invalid_accounts', `accounts[${index}] has an unknown field`)
    }
    const id = requireResourceId(typeof row.id === 'string' ? row.id : undefined, 'account')
    if (seen.has(id)) throw new GatewayError(400, 'duplicate_account_id', 'accounts contains a duplicate id')
    seen.add(id)
    if (!Number.isSafeInteger(row.expected_control_version) || (row.expected_control_version as number) < 0) {
      throw new GatewayError(400, 'invalid_expected_control_version', `accounts[${index}] has an invalid control version`)
    }
    return { id, expected_control_version: row.expected_control_version as number }
  })
}

async function runWithConcurrency<T, R>(
  values: T[], limit: number, task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(values[index]!, index)
    }
  }))
  return results
}

export async function duplicateAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const source = await requireAccount(context.env, context.req.param('id'))
    const idempotency = await controlIdempotency('admin.accounts.duplicate.v1', idempotencyKey, { source_id: source.id })
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) return controlSuccess(safeIdempotentAccount(previous))
    await validateAccountProxy(context.env, accountProxyId(source.ui_config_json))

    const accountId = await deterministicUuid('admin.accounts.duplicate.v1', idempotencyKey)
    const secretId = await deterministicUuid('admin.account-secrets.duplicate.v1', idempotencyKey)
    if ((await findAccount(context.env, accountId)) !== null) {
      throw new GatewayError(409, 'idempotency_record_missing', 'Duplicated account exists without its idempotency record')
    }
    const credential = await decryptCredential(
      source.nonce_b64, source.ciphertext_b64, requireCredentialsMasterKey(context.env),
      credentialAad(context.env.ENVIRONMENT, source.id, source.secret_id, source.key_version),
    ) as StoredAccountCredential
    const encrypted = await encryptCredential(
      credential, requireCredentialsMasterKey(context.env), credentialAad(context.env.ENVIRONMENT, accountId, secretId, 1),
    )
    const groups = parseProjectionArray<GroupLink>(source.group_links_json, 'group links')
    const capabilities = parseProjectionArray<ModelCapability>(source.model_capabilities_json, 'model capabilities')
    const now = Date.now()
    const name = `${source.name.slice(0, 92)} copy ${accountId.slice(0, 8)}`
    const safe = accountResponse({
      id: accountId, platform: source.platform, name, enabled: source.enabled === 1,
      max_concurrency: source.max_concurrency, billing_rate_multiplier_ppm: source.billing_rate_multiplier_ppm,
      protocol: source.protocol, base_url: source.base_url, auth_scheme: source.auth_scheme,
      image_adapter: source.image_adapter, credential_kind: source.credential_kind,
      provider_config: accountProviderConfig(source), config_version: 1, control_version: 0,
      health_status: 'unknown', last_checked_at_ms: null, last_latency_ms: null, last_health_error: null,
      created_at_ms: now, updated_at_ms: now, credential_key_version: 1, ui_config: parseUiConfig(source.ui_config_json),
      group_links: groups.map(({ group_id, priority, weight }) => ({ group_id, priority, weight, control_version: 0 })),
      model_capabilities: capabilities.map((capability) => ({ ...capability, control_version: 0 })),
    })
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO accounts (id, platform, name, credential_ref, enabled, max_concurrency, created_at_ms, updated_at_ms,
           protocol, base_url, auth_scheme, provider_config_json, image_adapter, credential_kind, config_version,
           billing_rate_multiplier_ppm, ui_config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(accountId, source.platform, name, secretId, source.enabled, source.max_concurrency, now, now,
        source.protocol, source.base_url, source.auth_scheme, source.provider_config_json, source.image_adapter,
        source.credential_kind, source.billing_rate_multiplier_ppm, source.ui_config_json),
      context.env.DB.prepare(
        `INSERT INTO account_secrets (id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms)
         VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).bind(secretId, accountId, encrypted.nonce_b64, encrypted.ciphertext_b64, now, now),
      ...groupInsertStatements(context.env, accountId, groups, now),
      ...capabilityInsertStatements(context.env, accountId, capabilities, now),
      controlIdempotencyInsert(context.env, idempotency, 'account', accountId, safe, now),
    ])
    return controlSuccess(safe, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const expectedVersion = requireExpectedControlVersion(context.req.raw, {})
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const target = { id: account.id, expected_control_version: account.control_version }
    const now = Date.now()
    try {
      await context.env.DB.batch([
        batchDeleteVersionGuard(context.env, [target], now),
        deleteAccountSyntheticProbeJobs(context.env, [target]),
        detachMediaProviderAccounts(context.env, [target]),
        deleteMediaProviderJobs(context.env, [target]),
        deleteAccountsStatement(context.env, [target]),
      ])
    } catch (error) {
      const current = await findAccount(context.env, account.id)
      if (current === null) throw new GatewayError(404, 'account_not_found', 'Account was not found')
      if (current.control_version !== expectedVersion) {
        throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
      }
      throw error
    }
    return controlSuccess({ message: 'Account deleted successfully' })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/**
 * Deletes an explicitly versioned set of accounts as one D1 transaction.  The
 * account DELETE relies on the schema's cascading foreign keys for vault,
 * group/model and health state; the two durable outboxes without account FKs
 * are cleared first.  Pool registry rows identify group/model pools rather
 * than accounts, so they remain valid and the account-delete trigger advances
 * gateway_config_revision for their next sync.
 */
export async function batchDeleteAdminAccounts(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const targets = parseBatchDeleteTargets(body)
    const idempotency = await controlIdempotency('admin.accounts.batch-delete.v1', requireIdempotencyKey(context.req.raw), {
      accounts: targets,
    })
    const existing = await findControlIdempotency(context.env, idempotency)
    if (existing !== null) {
      return controlSuccess(parseIdempotentResponse(existing, 'account_batch_delete'))
    }

    const accounts = await Promise.all(targets.map(async (target) => {
      const account = await requireAccount(context.env, target.id)
      assertVersion(account, target.expected_control_version)
      return account
    }))
    const now = Date.now()
    const result = {
      total: targets.length,
      success: targets.length,
      failed: 0,
      success_ids: targets.map((target) => target.id),
      failed_ids: [],
    }
    try {
      await context.env.DB.batch([
        batchDeleteVersionGuard(context.env, targets, now),
        deleteAccountSyntheticProbeJobs(context.env, targets),
        detachMediaProviderAccounts(context.env, targets),
        deleteMediaProviderJobs(context.env, targets),
        deleteAccountsStatement(context.env, targets),
        controlIdempotencyInsert(context.env, idempotency, 'account_batch_delete', accounts[0]!.id, result, now),
      ])
    } catch (error) {
      // The version guard aborts the entire transaction. Re-read to surface a
      // stable typed conflict rather than a SQLite constraint implementation detail.
      for (const target of targets) {
        const current = await findAccount(context.env, target.id)
        if (current === null) throw new GatewayError(404, 'account_not_found', 'Account was not found')
        if (current.control_version !== target.expected_control_version) {
          throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
        }
      }
      throw error
    }
    return controlSuccess(result)
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

export async function previewAdminUpstreamModels(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const platform = requireProviderPlatform(body.platform)
    const defaults = { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com', codex: 'https://chatgpt.com/backend-api/codex', grok: grokBaseURLs.cli, antigravity: 'https://cloudcode-pa.googleapis.com' }
    const baseUrl = body.base_url === undefined || body.base_url === '' ? defaults[platform] : requireString(body, 'base_url', 2048)
    const account: ProviderAccount = { platform, ...providerContract(platform), base_url: baseUrl, provider_config: platform === 'grok' && (body.base_url === undefined || body.base_url === '') ? {use_default_base_url:true} : platform === 'antigravity' ? parseProviderConfig(body.provider_config ?? { project_id: body.project_id }, platform) : {} }
    const credential = { api_key: requireProviderCredential({...body,api_key:body.api_key ?? body.access_token}, 'api_key') }
    return controlSuccess(await fetchUpstreamModels(await effectiveProviderAccount(context.env, account), credential, accountFetcher(context.env, body.proxy_id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function syncAdminUpstreamModels(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    requireSupportedAccount(account)
    const credential = await decryptCredential(
      account.nonce_b64, account.ciphertext_b64, requireCredentialsMasterKey(context.env),
      credentialAad(context.env.ENVIRONMENT, account.id, account.secret_id, account.key_version),
    )
    return controlSuccess(await fetchUpstreamModels(await effectiveProviderAccount(context.env, providerAccount(account)), credential, accountFetcher(context.env, accountProxyId(account.ui_config_json), account)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminAccountTestModels(context: Context<ControlBindings>): Promise<Response> {
  const response = await syncAdminUpstreamModels(context)
  if (!response.ok) return response
  const { data } = await response.json() as { data: { models: string[]; metadata: Record<string, { display_name?: string }> } }
  return controlSuccess(data.models.map(id => ({ id, display_name: data.metadata[id]?.display_name ?? id })))
}

export async function clearAdminAccountRateLimit(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    const saved = await context.env.DB.prepare(`UPDATE accounts
      SET ui_config_json = json_remove(ui_config_json, '$.rate_limited_at', '$.rate_limit_reset_at'),
          config_version = config_version + 1, control_version = control_version + 1,
          recovery_revision = recovery_revision + 1, updated_at_ms = ?
      WHERE id = ? AND config_version = ? AND control_version = ? AND ui_config_json = ? RETURNING id`)
      .bind(Date.now(), account.id, account.config_version, account.control_version, account.ui_config_json).first()
    if (!saved) throw new GatewayError(409, 'account_version_conflict', 'Account changed; reload it and retry')
    return getAdminAccount(context)
  } catch (error) { return controlError(asGatewayError(error)) }
}

/** Original quota reset preserves unrelated scheduling blockers. */
export async function resetAdminAccountQuota(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    const ui = parseUiConfig(account.ui_config_json)
    if (ui.parent_account_id != null) {
      throw new GatewayError(400, 'SPARK_SHADOW_NO_QUOTA_RESET', 'Cannot reset quota for a shadow account; manage it on the parent account')
    }
    const extra = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? { ...ui.extra } as Record<string, unknown> : {}
    for (const key of ['quota_used', 'quota_daily_used', 'quota_weekly_used']) extra[key] = 0
    for (const key of ['quota_daily_start', 'quota_weekly_start', 'quota_daily_reset_at', 'quota_weekly_reset_at']) delete extra[key]
    ui.extra = extra
    ui._worker_account_quota_reset_at_ms = Date.now()
    delete ui.rate_limited_at; delete ui.rate_limit_reset_at
    const saved = await context.env.DB.prepare(`UPDATE accounts SET ui_config_json = ?,
      config_version = config_version + 1, control_version = control_version + 1, updated_at_ms = ?
      WHERE id = ? AND config_version = ? AND control_version = ? AND ui_config_json = ? RETURNING id`)
      .bind(JSON.stringify(ui), Date.now(), account.id, account.config_version, account.control_version, account.ui_config_json).first()
    if (!saved) throw new GatewayError(409, 'account_version_conflict', 'Account changed; reload it and retry')
    return getAdminAccount(context)
  } catch (error) { return controlError(asGatewayError(error)) }
}

/** Original single-account recovery action; invalidate stale probes and pool failures. */
export async function recoverAdminAccountState(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    const now = Date.now()
    const saved = await context.env.DB.prepare(`UPDATE accounts SET
      ui_config_json = json_remove(ui_config_json, '$.rate_limited_at', '$.rate_limit_reset_at',
        '$.overload_until', '$.temp_unschedulable_until', '$.temp_unschedulable_reason', '$.extra.model_rate_limits', '$.extra.antigravity_quota_scopes'),
      health_status = 'unknown', last_checked_at_ms = NULL, last_latency_ms = NULL, last_health_error = NULL,
      consecutive_health_failures = 0, health_probe_generation = health_probe_generation + 1,
      health_probe_lease_until_ms = NULL, next_health_probe_at_ms = ?,
      config_version = config_version + 1, control_version = control_version + 1,
      recovery_revision = recovery_revision + 1, updated_at_ms = ?
      WHERE id = ? AND config_version = ? AND control_version = ? AND ui_config_json = ? RETURNING id`)
      .bind(now, now, account.id, account.config_version, account.control_version, account.ui_config_json).first()
    if (!saved) throw new GatewayError(409, 'account_version_conflict', 'Account changed; reload it and retry')
    return getAdminAccount(context)
  } catch (error) { return controlError(asGatewayError(error)) }
}

/** The original detail endpoint reports account-wide state, not model-scoped cooldowns. */
export async function getAdminAccountTempUnschedulable(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    const ui = parseUiConfig(account.ui_config_json)
    const until = typeof ui.temp_unschedulable_until === 'string' ? Math.floor(Date.parse(ui.temp_unschedulable_until) / 1000) : 0
    const now = Math.floor(Date.now() / 1000)
    if (!Number.isFinite(until) || until <= now) return controlSuccess({ active: false })
    const reason = typeof ui.temp_unschedulable_reason === 'string' ? ui.temp_unschedulable_reason : ''
    const state: Record<string, unknown> = { until_unix: until, triggered_at_unix: 0, status_code: 0, matched_keyword: '', rule_index: 0, error_message: '' }
    try {
      const parsed = JSON.parse(reason) ?? {}
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid reason')
      const integerKeys = ['until_unix', 'triggered_at_unix', 'status_code', 'rule_index', 'trigger_count', 'trigger_threshold', 'trigger_window_minutes']
      for (const key of [...Object.keys(state), 'trigger_count', 'trigger_threshold', 'trigger_window_minutes']) {
        if (parsed[key] == null) continue
        if (integerKeys.includes(key) ? !Number.isSafeInteger(parsed[key]) : typeof parsed[key] !== 'string') throw new Error('invalid state field')
      }
      for (const key of [...Object.keys(state), 'trigger_count', 'trigger_threshold', 'trigger_window_minutes']) {
        if (parsed[key] != null) state[key] = parsed[key]
      }
      if (!state.until_unix) state.until_unix = until
    } catch { state.error_message = reason }
    return controlSuccess(Number(state.until_unix) > now ? { active: true, state } : { active: false })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function clearAdminAccountTempUnschedulable(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    const saved = await context.env.DB.prepare(`UPDATE accounts SET
      ui_config_json = json_remove(ui_config_json, '$.temp_unschedulable_until', '$.temp_unschedulable_reason', '$.extra.model_rate_limits'),
      config_version = config_version + 1, control_version = control_version + 1,
      recovery_revision = recovery_revision + 1, updated_at_ms = ?
      WHERE id = ? AND config_version = ? AND control_version = ? AND ui_config_json = ? RETURNING id`)
      .bind(Date.now(), account.id, account.config_version, account.control_version, account.ui_config_json).first()
    if (!saved) throw new GatewayError(409, 'account_version_conflict', 'Account changed; reload it and retry')
    return controlSuccess({ message: 'Temp unschedulable cleared successfully' })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function setAdminAccountPrivacy(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    await applyOpenAIAccountPrivacy(context.env, account)
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function testAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const input = await readOptionalJsonObject(context.req.raw, 128 * 1024)
    let account = await requireAccount(context.env, context.req.param('id'))
    requireSupportedAccount(account)
    const authentication=await resolveAccountRequestAuthentication(context.env,{...account,account_id:account.id})
    const credential=authentication.credential
    if(authentication.authorization) account=await requireAccount(context.env,account.id)
    if(authentication.authorization && (typeof input.model_id!=='string' || !input.model_id.trim())) input.model_id='gpt-5.4'
    const recoverAgent=authentication.authorization ? async(taskId:string)=>{
      const fresh=await resolveAccountRequestAuthentication(context.env,{...account,account_id:account.id},taskId)
      if(!fresh.authorization) throw new GatewayError(409,'agent_identity_changed','Agent Identity credentials changed during diagnostic')
      account=await requireAccount(context.env,account.id)
      return {credential:fresh.credential,authorization:fresh.authorization}
    } : undefined

    if ((account.platform === 'openai' || account.platform === 'codex' || account.platform === 'anthropic' || (account.platform === 'gemini' && account.credential_kind === 'api_key')) &&
        typeof input.model_id === 'string' && input.model_id.trim() &&
        (input.mode === undefined || input.mode === '' || input.mode === 'default' ||
          (input.mode === 'compact' && ['openai', 'codex'].includes(account.platform)))) {
      const model = accountModelPolicy(account.ui_config_json, input.model_id.trim(), account.platform, account.credential_kind)
      if (!model.allowed) throw new GatewayError(400, 'model_not_supported', 'The account does not support this model')
      if (input.mode === 'compact') {
        return openAICompactDiagnostic(context.env, providerAccount(account), credential, model.upstream || input.model_id.trim(),
          account.credential_kind !== 'api_key', account.id, parseUiConfig(account.ui_config_json).proxy_id, context.req.raw.signal,
          async (updates, rateLimitReset) => {
            const ui = parseUiConfig(account.ui_config_json)
            const extra = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? ui.extra : {}
            const authenticationFailed = updates.openai_compact_last_status === 401
            const rateLimited = rateLimitReset !== null
            if (rateLimited) {
              ui.rate_limited_at = new Date().toISOString()
              ui.rate_limit_reset_at = new Date(rateLimitReset).toISOString()
            }
            const saved = await context.env.DB.prepare(`UPDATE accounts SET ui_config_json = ?,
              config_version = config_version + 1, control_version = control_version + 1, updated_at_ms = ?
              , health_status = CASE WHEN ? THEN 'unhealthy' WHEN ? THEN 'unknown' ELSE health_status END
              , last_health_error = CASE WHEN ? THEN 'Authentication failed (401)' WHEN ? THEN NULL ELSE last_health_error END
              , last_checked_at_ms = CASE WHEN ? THEN ? ELSE last_checked_at_ms END
              WHERE id = ? AND credential_ref = ? AND config_version = ? AND control_version = ?
                AND ui_config_json = ? RETURNING id`).bind(
              JSON.stringify({ ...ui, extra: { ...extra, ...updates } }), Date.now(),
              authenticationFailed ? 1 : 0, rateLimited ? 1 : 0, authenticationFailed ? 1 : 0, rateLimited ? 1 : 0,
              authenticationFailed ? 1 : 0, Date.now(), account.id, account.credential_ref,
              account.config_version, account.control_version, account.ui_config_json,
            ).first()
            return saved !== null
          },authentication.authorization,recoverAgent)
      }
      return accountTextDiagnostic(context.env, providerAccount(account), credential, model.upstream || input.model_id.trim(),
        parseUiConfig(account.ui_config_json).proxy_id, context.req.raw.signal, {
          authorization:authentication.authorization,
          recoverAgent,
          responses: diagnosticUsesResponses(parseUiConfig(account.ui_config_json).extra),
          onResponse: async response => {
            if (response.status !== 429) return
            try {
              await persistOpenAIRateLimit(context.env, { account_id: account.id, secret_id: account.secret_id, platform: account.platform,
                runtime_snapshot: { config_version: account.config_version, control_version: account.control_version, ui_config_json: account.ui_config_json } }, response)
            } catch { /* Preserve the provider's failure result if runtime persistence is unavailable. */ }
          },
          prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          oauth: account.credential_kind !== 'api_key',
          anthropicCredentialKind: account.platform === 'anthropic' ? account.credential_kind : undefined,
          anthropicBearer: (parseUiConfig(account.ui_config_json).extra as Record<string, unknown> | undefined)?.anthropic_apikey_auth_scheme === 'authorization_bearer',
        })
    }
    if (['grok', 'antigravity'].includes(account.platform) && typeof input.model_id === 'string' && input.model_id.trim()) {
      const extra = parseUiConfig(account.ui_config_json).extra
      return testAccountModel(context, await effectiveProviderAccount(context.env, providerAccount(account)), credential,
        account.platform === 'grok' ? { ...input, model_id: resolveGrokModel(await readGrokSettings(context.env), input.model_id) } : input,
        extra && typeof extra === 'object' && !Array.isArray(extra) ? extra as Record<string, unknown> : {},
        accountFetcher(context.env, accountProxyId(account.ui_config_json), account))
    }
    const plan = buildProviderHealthRequest({
      account: await effectiveProviderAccount(context.env, providerAccount(account)),
      credential,
    })
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), plan.timeout_ms)
    let status: 'healthy' | 'unhealthy' = 'unhealthy'
    let healthError: string | null = null
    try {
      const init: RequestInit = {
        method: plan.method,
        headers: plan.headers,
        body: plan.body === undefined ? undefined : JSON.stringify(plan.body),
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      }
      const proxyId = parseUiConfig(account.ui_config_json).proxy_id
      const response = proxyId != null && String(proxyId) !== '0'
        ? await fetchAccountProxy(context.env, String(proxyId), new URL(plan.url), init, context.req.raw.signal)
        : await fetch(plan.url, init)
      if (response.ok) status = 'healthy'
      else healthError = `Upstream returned HTTP ${response.status}`
      try {
        await response.body?.cancel()
      } catch {
        // The result has already been observed; body cleanup is best effort.
      }
    } catch (error) {
      healthError = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
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
        WHERE id = ? AND config_version = ? AND credential_ref = ? RETURNING id`,
    ).bind(
      status,
      checkedAt,
      latency,
      healthError,
      account.id,
      account.config_version,
      account.credential_ref,
    ).first<{ id: string }>()
    return controlSuccess({
      id: account.id,
      health_status: status,
      last_checked_at_ms: checkedAt,
      last_latency_ms: latency,
      last_health_error: healthError,
      config_version: account.config_version,
      control_version: account.control_version,
      persisted: result?.id === account.id,
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
    expected_config_version?: number
    reset_health: boolean
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE accounts
        SET name = ?, enabled = ?, max_concurrency = ?, base_url = ?, provider_config_json = ?,
            image_adapter = ?, credential_kind = ?, billing_rate_multiplier_ppm = ?,
            ui_config_json = ?,
            config_version = ?,
            control_version = CASE WHEN control_version = ?${value.expected_config_version === undefined ? '' : ' AND config_version = ?'} THEN ? ELSE -1 END,
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
    ...(value.expected_config_version === undefined ? [] : [value.expected_config_version]),
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
  if (body.schedulable !== undefined && typeof body.schedulable !== 'boolean') {
    throw new GatewayError(400, 'invalid_schedulable', 'schedulable must be a boolean')
  }
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
  const credentialKind = body.credential_kind === undefined
    ? credentialKindForType(body.type, platform)
    : requireAccountCredentialKind(body.credential_kind)
  const oauth = credentialKind === 'oauth' || credentialKind === 'setup_token'
  const rawBaseUrl = body.base_url ?? submittedCredentials.base_url ??
    (oauth && platform === 'openai' ? 'https://api.openai.com' : oauth && platform === 'codex' ? 'https://chatgpt.com' : oauth && platform === 'anthropic' ? 'https://api.anthropic.com' : undefined)
  const useDefaultGrok = platform === 'grok' && (rawBaseUrl === undefined || rawBaseUrl === '')
  const baseUrl = normalizeBaseUrl(requireString({ base_url: useDefaultGrok ? grokBaseURLs.cli : platform === 'antigravity' && !rawBaseUrl ? 'https://cloudcode-pa.googleapis.com' : rawBaseUrl }, 'base_url', 2_048))
  const enabled = parseEnabledBody(body, true)
  const imageAdapter = body.image_adapter === undefined
    ? defaultImageAdapter(platform)
    : requireAccountImageAdapter(body.image_adapter)
  validateAccountExecution(platform, imageAdapter, credentialKind)
  validateAccountType(body, platform, credentialKind)
  const rawApiKey = body.api_key ?? submittedCredentials.api_key ?? (oauth || ['antigravity','grok'].includes(platform) ? submittedCredentials.access_token : undefined)
  const agentIdentity=platform==='openai' && credentialKind==='oauth' && String(submittedCredentials.auth_mode).trim().toLowerCase()==='agentidentity'
  if(agentIdentity) {
    for(const field of ['agent_runtime_id','agent_private_key','chatgpt_account_id','chatgpt_user_id']) requireString(submittedCredentials,field,field==='agent_private_key'?16384:2048)
  }
  const apiKey = agentIdentity ? undefined : requireProviderCredential({ api_key: rawApiKey }, 'api_key')
  const credential = {
    ...submittedCredentials,
    ...(body.credentials === undefined ? {} : { base_url: baseUrl }),
    ...(agentIdentity ? {auth_mode:'agentIdentity'} : {api_key:apiKey}),
  } as StoredAccountCredential
  if (oauth) {
    for (const key of ['password', 'sso_token', 'sso', 'sso-rw', 'clearTextPassword', 'cookie']) delete credential[key]
  }
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
    provider_config: applySubscriptionPlan(
      assertProviderConfigSubscriptionPlanEligible(
        parseProviderConfig(useDefaultGrok ? {...requireObjectOrEmpty(body.provider_config),use_default_base_url:true} : platform === 'antigravity' ? {...requireObjectOrEmpty(body.provider_config),project_id:requireObjectOrEmpty(body.provider_config).project_id ?? submittedCredentials.project_id ?? submittedCredentials.antigravity_project_id} : body.provider_config, platform),
        platform,
        credentialKind,
      ),
      body.subscription_plan,
      platform,
      credentialKind,
    ),
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
  if (body.base_url !== undefined) patch.base_url = ['grok','antigravity'].includes(account.platform) && body.base_url === '' ? (account.platform === 'grok' ? grokBaseURLs.cli : 'https://cloudcode-pa.googleapis.com') : normalizeBaseUrl(requireString(body, 'base_url', 2_048))
  if (body.credentials !== undefined) {
    patch.credential_patch = requireCredentialObject(body.credentials, 'credentials', false)
    if (['grok','antigravity'].includes(account.platform) && patch.credential_patch.access_token !== undefined) {
      if (patch.credential_patch.access_token === '') delete patch.credential_patch.access_token
      else patch.credential_patch.api_key = requireProviderCredential(patch.credential_patch, 'access_token')
    }
    if (Object.prototype.hasOwnProperty.call(patch.credential_patch, 'base_url')) {
      patch.base_url = ['grok','antigravity'].includes(account.platform) && patch.credential_patch.base_url === '' ? (account.platform === 'grok' ? grokBaseURLs.cli : 'https://cloudcode-pa.googleapis.com') : normalizeBaseUrl(requireString(patch.credential_patch, 'base_url', 2_048))
      patch.credential_patch.base_url = patch.base_url
    }
  }
  if (body.api_key !== undefined) {
    patch.credential_patch = { ...patch.credential_patch, api_key: requireProviderCredential(body, 'api_key') }
  }
  if (body.provider_config !== undefined) {
    patch.provider_config = parseProviderConfig(body.provider_config, account.platform)
  }
  if (account.platform === 'antigravity' && patch.credential_patch && (Object.hasOwn(patch.credential_patch, 'project_id') || Object.hasOwn(patch.credential_patch, 'antigravity_project_id'))) {
    patch.provider_config = parseProviderConfig({...accountProviderConfig(account),...patch.provider_config,project_id:patch.credential_patch.project_id ?? patch.credential_patch.antigravity_project_id}, account.platform)
  }
  if (account.platform === 'grok' && (body.base_url !== undefined || (body.credentials && typeof body.credentials === 'object' && Object.hasOwn(body.credentials, 'base_url')))) {
    const raw = body.base_url ?? (body.credentials as Record<string,unknown>).base_url
    patch.provider_config = {...accountProviderConfig(account),...patch.provider_config,use_default_base_url:raw === ''}
  }
  if (body.image_adapter !== undefined) {
    patch.image_adapter = requireAccountImageAdapter(body.image_adapter)
  }
  if (body.credential_kind !== undefined) {
    patch.credential_kind = requireAccountCredentialKind(body.credential_kind)
  }
  if (body.subscription_plan !== undefined) {
    patch.subscription_plan = parseSubscriptionPlan(body.subscription_plan)
  }
  validateAccountExecution(
    account.platform,
    patch.image_adapter ?? account.image_adapter,
    patch.credential_kind ?? account.credential_kind,
  )
  if (patch.subscription_plan !== undefined) {
    assertSubscriptionPlanEligible(account.platform, patch.credential_kind ?? account.credential_kind)
  }
  if (patch.provider_config?.subscription_plan !== undefined) {
    assertSubscriptionPlanEligible(account.platform, patch.credential_kind ?? account.credential_kind)
  }
  if (body.schedulable !== undefined && typeof body.schedulable !== 'boolean') {
    throw new GatewayError(400, 'invalid_schedulable', 'schedulable must be a boolean')
  }
  if (body.enabled !== undefined || body.status !== undefined) {
    if (body.status === 'error') {
      throw new GatewayError(409, 'status_not_supported', 'Worker accounts cannot be placed in error status manually')
    }
    patch.enabled = parseEnabledBody(body, true)
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
  if (body.priority !== undefined) requireSafeInteger(body, 'priority', -1000, 1000)
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
  'schedulable', 'confirm_mixed_channel_risk', 'subscription_plan',
])
const UPDATE_ACCOUNT_FIELDS = new Set([
  ...CREATE_ACCOUNT_FIELDS,
  'control_version',
])

function parseBatchDeleteTargets(body: Record<string, unknown>): BatchDeleteTarget[] {
  const unsupported = Object.keys(body).find((key) => key !== 'accounts')
  if (unsupported !== undefined) {
    throw new GatewayError(400, 'unsupported_batch_delete_field', `Field '${unsupported}' is not supported`)
  }
  if (!Array.isArray(body.accounts) || body.accounts.length === 0 || body.accounts.length > 500) {
    throw new GatewayError(400, 'invalid_batch_delete_accounts', 'accounts must contain between 1 and 500 targets')
  }
  const byId = new Map<string, BatchDeleteTarget>()
  for (const rawTarget of body.accounts) {
    if (rawTarget === null || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
      throw new GatewayError(400, 'invalid_batch_delete_accounts', 'accounts must contain objects')
    }
    const target = rawTarget as Record<string, unknown>
    const unsupportedTarget = Object.keys(target).find((key) => key !== 'id' && key !== 'expected_control_version')
    if (unsupportedTarget !== undefined) {
      throw new GatewayError(400, 'invalid_batch_delete_accounts', `accounts.${unsupportedTarget} is not supported`)
    }
    const id = requireResourceId(typeof target.id === 'number' ? String(target.id) : target.id as string | undefined, 'account')
    const expectedControlVersion = requireSafeInteger(target, 'expected_control_version', 0, Number.MAX_SAFE_INTEGER)
    const existing = byId.get(id)
    if (existing !== undefined && existing.expected_control_version !== expectedControlVersion) {
      throw new GatewayError(409, 'duplicate_account_target', 'Duplicate account targets must use the same control version')
    }
    byId.set(id, { id, expected_control_version: expectedControlVersion })
  }
  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id))
}

function batchDeleteVersionGuard(
  env: Env,
  targets: readonly BatchDeleteTarget[],
  now: number,
): D1PreparedStatement {
  const conditions = targets.map(() => '(id = ? AND control_version = ?)').join(' OR ')
  const bindings = targets.flatMap((target) => [target.id, target.expected_control_version])
  // revision has a strict positive CHECK. A missing or concurrently changed
  // target sets it to zero, aborting the whole D1 batch before any delete runs.
  return env.DB.prepare(
    `UPDATE gateway_config_revision
        SET revision = CASE WHEN (
          SELECT COUNT(*) FROM accounts WHERE ${conditions}
        ) = ? THEN revision ELSE 0 END,
            updated_at_ms = ?
      WHERE singleton = 1`,
  ).bind(...bindings, targets.length, now)
}

function deleteAccountSyntheticProbeJobs(env: Env, targets: readonly BatchDeleteTarget[]): D1PreparedStatement {
  return accountTargetDeleteStatement(env, 'account_synthetic_probe_jobs', targets)
}

function detachMediaProviderAccounts(env: Env, targets: readonly BatchDeleteTarget[]): D1PreparedStatement {
  const placeholders = targets.map(() => '?').join(', ')
  return env.DB.prepare(`UPDATE media_tasks SET provider_account_id = NULL WHERE provider_account_id IN (${placeholders})`)
    .bind(...targets.map((target) => target.id))
}

function deleteMediaProviderJobs(env: Env, targets: readonly BatchDeleteTarget[]): D1PreparedStatement {
  const placeholders = targets.map(() => '?').join(', ')
  return env.DB.prepare(`DELETE FROM media_provider_jobs WHERE provider_account_id IN (${placeholders})`)
    .bind(...targets.map((target) => target.id))
}

function deleteAccountsStatement(env: Env, targets: readonly BatchDeleteTarget[]): D1PreparedStatement {
  const conditions = targets.map(() => '(id = ? AND control_version = ?)').join(' OR ')
  return env.DB.prepare(`DELETE FROM accounts WHERE ${conditions}`)
    .bind(...targets.flatMap((target) => [target.id, target.expected_control_version]))
}

function accountTargetDeleteStatement(
  env: Env,
  table: 'account_synthetic_probe_jobs',
  targets: readonly BatchDeleteTarget[],
): D1PreparedStatement {
  const placeholders = targets.map(() => '?').join(', ')
  return env.DB.prepare(`DELETE FROM ${table} WHERE account_id IN (${placeholders})`)
    .bind(...targets.map((target) => target.id))
}

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
  if (body.type !== expected || (!['codex','openai','grok','antigravity','anthropic'].includes(platform) && body.type !== 'apikey')) {
    throw new GatewayError(409, 'type_not_supported', 'Account type does not select a supported Worker executor')
  }
}

function credentialKindForType(value: unknown, platform: ProviderPlatform): AccountCredentialKind {
  if (value === undefined) return defaultCredentialKind(platform)
  if (value === 'apikey') return 'api_key'
  if (['codex','openai','grok','antigravity','anthropic'].includes(platform) && value === 'oauth') return 'oauth'
  if ((platform === 'codex' || platform === 'anthropic') && value === 'setup-token') return 'setup_token'
  throw new GatewayError(409, 'type_not_supported', 'Account type does not select a supported Worker executor')
}

const UI_CONFIG_VERSION = 1
function validateAccountSchedulingFields(body: Record<string, unknown>): void {
  if (body.load_factor !== undefined && body.load_factor !== null &&
      (typeof body.load_factor !== 'number' || !Number.isSafeInteger(body.load_factor) || body.load_factor > 10000)) {
    throw new GatewayError(400, 'invalid_load_factor', 'load_factor must be an integer at most 10000 or null; nonpositive values clear it')
  }
  if (body.auto_pause_on_expired !== undefined && typeof body.auto_pause_on_expired !== 'boolean') {
    throw new GatewayError(400, 'invalid_auto_pause_on_expired', 'auto_pause_on_expired must be a boolean')
  }
  if (body.expires_at !== undefined && body.expires_at !== null &&
      (typeof body.expires_at !== 'number' || !Number.isSafeInteger(body.expires_at))) {
    throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be an integer Unix timestamp in seconds or null')
  }
}
const UI_COMPAT_FIELDS = [
  'schedulable',
  'notes', 'extra', 'proxy_id', 'load_factor', 'priority', 'expires_at',
  'auto_pause_on_expired', 'upstream_billing_probe_enabled',
  'upstream_billing_rate_sync_enabled', 'schedulable',
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
  normalizeHeaderOverrideCredentials(result)
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
  validateAccountSchedulingFields(body)
  const config: Record<string, unknown> = {
    schema_version: UI_CONFIG_VERSION,
    auto_pause_on_expired: true,
    original_model_routing: body.credentials !== undefined && body.model_capabilities === undefined,
    type: body.type ?? (credentialKind === 'api_key'
      ? 'apikey'
      : credentialKind === 'setup_token' ? 'setup-token' : 'oauth'),
    credentials: publicCredentials(credential),
    credentials_status: credentialStatus(credential),
  }
  for (const field of UI_COMPAT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      if (field === 'schedulable' && typeof body[field] !== 'boolean') {
        throw new GatewayError(400, 'invalid_schedulable', 'schedulable must be a boolean')
      }
      assertNoSensitiveUiFields(body[field], field)
      config[field] = (field === 'expires_at' || field === 'load_factor') && typeof body[field] === 'number' && body[field] <= 0
        ? null : field === 'proxy_id' && (body[field] === 0 || body[field] === '0') ? null : cloneJsonValue(body[field])
    }
  }
  return config
}

function updateUiConfig(
  current: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  validateAccountSchedulingFields(body)
  let changed = false
  const next: Record<string, unknown> = { ...current, schema_version: UI_CONFIG_VERSION }
  if (body.model_capabilities !== undefined) { next.original_model_routing = false; changed = true }
  else if (body.credentials && typeof body.credentials === 'object' && Object.hasOwn(body.credentials, 'model_mapping')) {
    next.original_model_routing = true
    changed = true
  }

  for (const field of UI_COMPAT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      if (field === 'schedulable' && typeof body[field] !== 'boolean') {
        throw new GatewayError(400, 'invalid_schedulable', 'schedulable must be a boolean')
      }
      assertNoSensitiveUiFields(body[field], field)
      next[field] = (field === 'expires_at' || field === 'load_factor') && typeof body[field] === 'number' && body[field] <= 0
        ? null : field === 'proxy_id' && (body[field] === 0 || body[field] === '0') ? null : cloneJsonValue(body[field])
      changed = true
    }
  }
  // Operational snapshots belong to their writers, not an already-open editor.
  // Do not let stale forms replace newer observations or resurrect cleared ones.
  if (changed) {
    const currentExtra = current.extra && typeof current.extra === 'object' && !Array.isArray(current.extra)
      ? current.extra as Record<string, unknown> : {}
    const submittedExtra = next.extra && typeof next.extra === 'object' && !Array.isArray(next.extra)
      ? { ...next.extra } as Record<string, unknown> : {}
    for (const key of ['upstream_model_metadata', 'upstream_billing_probe']) {
      if (Object.hasOwn(currentExtra, key)) submittedExtra[key] = currentExtra[key]
      else delete submittedExtra[key]
    }
    if (next.extra !== undefined || Object.keys(submittedExtra).length) next.extra = submittedExtra
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
  if(String(next.auth_mode).trim().toLowerCase()!=='agentidentity') next.api_key = requireProviderCredential({api_key:next.api_key},'api_key')
  return next as StoredAccountCredential
}

function mergeReauthorizedCredential(current: StoredAccountCredential, incoming: Record<string, unknown>): StoredAccountCredential {
  // Go MergePreservingSensitiveCreds replaces non-secret metadata while keeping
  // omitted secrets. Sanitize both incoming and legacy stored SSO residue.
  const next: Record<string, unknown> = Object.keys(incoming).length ? { ...incoming } : { ...current }
  for (const key of Object.keys(current)) {
    if (isSensitiveCredentialField(key) && !Object.hasOwn(incoming, key)) next[key] = current[key]
  }
  for (const key of ['password', 'sso_token', 'sso', 'sso-rw', 'clearTextPassword', 'cookie']) delete next[key]
  if (Object.hasOwn(incoming, 'access_token') && typeof incoming.access_token === 'string' && incoming.access_token.length) {
    next.api_key = requireProviderCredential(incoming, 'access_token')
  }
  if(String(next.auth_mode).trim().toLowerCase()!=='agentidentity') next.api_key = requireProviderCredential(next, 'api_key')
  normalizeHeaderOverrideCredentials(next)
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
  if (value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'codex' || value === 'grok' || value === 'antigravity') {
    return value
  }
  throw new GatewayError(409, 'platform_not_supported', 'Supported platforms are openai, anthropic, gemini, codex, grok, and antigravity')
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
  return platform === 'codex' || platform === 'antigravity' ? 'oauth' : 'api_key'
}

function validateAccountExecution(
  platform: ProviderPlatform,
  imageAdapter: AccountImageAdapter,
  credentialKind: AccountCredentialKind,
): void {
  const supported = platform === 'codex'
    ? imageAdapter === 'responses_image_tool' &&
      (credentialKind === 'oauth' || credentialKind === 'setup_token')
    : platform === 'antigravity'
      ? imageAdapter === 'direct_images' && credentialKind === 'oauth'
    : platform === 'openai' || platform === 'grok'
      ? imageAdapter === 'direct_images' && (credentialKind === 'api_key' || credentialKind === 'oauth')
      : platform === 'anthropic' ? imageAdapter === 'direct_images' && ['api_key','oauth','setup_token'].includes(credentialKind)
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
  const unsupported = Object.keys(raw).find((key) => key !== 'account_id' && key !== 'subscription_plan' && key !== 'use_default_base_url' && key !== 'project_id')
  if (unsupported !== undefined) {
    throw new GatewayError(400, 'invalid_provider_config', `provider_config field '${unsupported}' is not supported`)
  }
  if (raw.account_id !== undefined && platform !== 'codex') {
    throw new GatewayError(400, 'invalid_provider_config', 'account_id is supported only for Codex')
  }
  const config: ProviderConfig = {}
  if (raw.project_id !== undefined) {
    if (platform !== 'antigravity' || typeof raw.project_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(raw.project_id)) throw new GatewayError(400, 'invalid_provider_config', 'Antigravity project_id is invalid')
    config.project_id = raw.project_id
  }
  if (platform === 'antigravity' && !config.project_id) throw new GatewayError(400, 'invalid_provider_config', 'Antigravity project_id is required')
  if (raw.use_default_base_url !== undefined) {
    if (platform !== 'grok' || typeof raw.use_default_base_url !== 'boolean') throw new GatewayError(400, 'invalid_provider_config', 'use_default_base_url is supported only for Grok')
    config.use_default_base_url = raw.use_default_base_url
  }
  if (raw.account_id !== undefined) {
    const accountId = requireString(raw, 'account_id', 256)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(accountId)) {
      throw new GatewayError(400, 'invalid_provider_config', 'Codex account_id is invalid')
    }
    config.account_id = accountId
  }
  if (raw.subscription_plan !== undefined) {
    if (platform !== 'openai') {
      throw new GatewayError(400, 'invalid_provider_config', 'subscription_plan is supported only for OpenAI')
    }
    config.subscription_plan = parseSubscriptionPlan(raw.subscription_plan) ?? undefined
  }
  return config
}

function parseSubscriptionPlan(value: unknown): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new GatewayError(400, 'invalid_subscription_plan', 'subscription_plan must be a string or null')
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new GatewayError(400, 'invalid_subscription_plan', 'subscription_plan is invalid')
  }
  return normalized === 'chatgptpro' ? 'pro' : normalized
}

function assertSubscriptionPlanEligible(platform: ProviderPlatform, credentialKind: AccountCredentialKind): void {
  if (platform !== 'openai' || credentialKind !== 'oauth') {
    throw new GatewayError(409, 'subscription_plan_not_supported', 'subscription_plan is supported only for OpenAI OAuth accounts')
  }
}

function assertProviderConfigSubscriptionPlanEligible(
  providerConfig: ProviderConfig,
  platform: ProviderPlatform,
  credentialKind: AccountCredentialKind,
): ProviderConfig {
  if (providerConfig.subscription_plan !== undefined) {
    assertSubscriptionPlanEligible(platform, credentialKind)
  }
  return providerConfig
}

function applySubscriptionPlan(
  providerConfig: ProviderConfig,
  value: unknown,
  platform: ProviderPlatform,
  credentialKind: AccountCredentialKind,
): ProviderConfig {
  if (value === undefined) return providerConfig
  assertSubscriptionPlanEligible(platform, credentialKind)
  const subscriptionPlan = parseSubscriptionPlan(value)
  const next = { ...providerConfig }
  if (subscriptionPlan === null) delete next.subscription_plan
  else next.subscription_plan = subscriptionPlan
  return next
}

async function refreshOpenAIOAuthToken(env: Env, refreshToken: string, clientId: unknown, proxyId: unknown): Promise<OpenAITokenInfo> {
  const client = typeof clientId === 'string' && clientId.trim() ? clientId.trim() : OPENAI_OAUTH_CLIENT_ID
  const proxy = proxyId != null && String(proxyId) !== '0' ? String(proxyId) : null
  let tokens
  try {
    tokens = await requestOpenAITokens(env, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: client, scope: 'openid profile email' }), proxy)
  } catch (error) {
    if (error instanceof OpenAITokenEndpointError) {
      throw new GatewayError(error.upstreamStatus >= 500 ? 502 : 401,
        error.upstreamStatus >= 500 ? 'oauth_refresh_upstream_error' : 'oauth_refresh_rejected',
        'OpenAI OAuth token refresh was rejected by the provider', 'api_error')
    }
    const code = error instanceof GatewayError ? error.code : ''
    if (code === 'OPENAI_OAUTH_TIMEOUT') throw new GatewayError(504, 'oauth_refresh_timeout', 'OpenAI OAuth token refresh timed out', 'api_error')
    if (code === 'OPENAI_OAUTH_INVALID_RESPONSE') throw new GatewayError(502, 'oauth_refresh_invalid_response', 'OpenAI OAuth token refresh returned invalid token data', 'api_error')
    throw new GatewayError(502, 'oauth_refresh_transport_failed', 'OpenAI OAuth token refresh could not reach the provider', 'api_error')
  }
  const info = openAITokenInfo(tokens, client)
  await enrichOpenAITokenInfo(env, info, proxy)
  return info
}

function mergeOpenAIRefreshCredential(current: StoredAccountCredential, refreshed: OpenAITokenInfo): StoredAccountCredential {
  // Original BuildAccountCredentials overwrites newly returned identity fields,
  // then preserves every existing key absent from the refresh result.
  const next: StoredAccountCredential = { ...current, api_key: refreshed.access_token, access_token: refreshed.access_token }
  for (const key of ['refresh_token', 'id_token', 'email', 'chatgpt_account_id', 'chatgpt_user_id',
    'organization_id', 'plan_type', 'subscription_expires_at', 'client_id', 'token_type'] as const) {
    const value = refreshed[key]
    if (typeof value === 'string' && value.trim()) next[key] = value
  }
  if (refreshed.expires_at > 0) next.expires_at = new Date(refreshed.expires_at * 1000).toISOString()
  for (const key of ['password', 'sso_token', 'sso', 'sso-rw', 'clearTextPassword', 'cookie']) delete next[key]
  return next
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

function appendAccountStatusCondition(
  conditions: string[],
  values: unknown[],
  enabled: string | undefined,
  status: string | undefined,
): void {
  enabled = enabled === '' ? undefined : enabled
  status = status === '' ? undefined : status
  if (enabled !== undefined && status !== undefined) {
    throw new GatewayError(400, 'ambiguous_status', 'Provide enabled or status, not both')
  }
  if (enabled !== undefined) {
    if (enabled !== 'true' && enabled !== 'false') {
      throw new GatewayError(400, 'invalid_enabled', 'enabled must be true or false')
    }
    conditions.push('a.enabled = ?')
    values.push(enabled === 'true' ? 1 : 0)
    return
  }
  if (status === undefined) return
  if (status === 'active') {
    conditions.push("a.enabled = 1 AND a.health_status <> 'unhealthy' AND COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1) = 1")
    conditions.push(accountNotRateLimitedSql(), accountNotTemporarilyBlockedSql())
    return
  }
  if (status === 'inactive') {
    conditions.push('a.enabled = 0')
    return
  }
  if (status === 'error') {
    conditions.push("a.health_status = 'unhealthy'")
    return
  }
  if (status === 'unschedulable') {
    conditions.push("a.enabled = 1 AND a.health_status <> 'unhealthy' AND json_extract(a.ui_config_json, '$.schedulable') = 0")
    return
  }
  if (status === 'rate_limited') {
    conditions.push(`a.enabled = 1 AND a.health_status <> 'unhealthy' AND NOT ${accountNotRateLimitedSql()}`)
    return
  }
  if (status === 'temp_unschedulable') {
    conditions.push("a.enabled = 1 AND a.health_status <> 'unhealthy' AND COALESCE(unixepoch(json_extract(a.ui_config_json, '$.temp_unschedulable_until'), 'subsec'), 0) > unixepoch('subsec')")
    return
  }
  throw new GatewayError(400, 'invalid_status', 'status is invalid')
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
          WHERE id IN (SELECT value FROM json_each(?))`,
      ).bind(platform, JSON.stringify(groups)).first<{ total: number; mismatched: number }>(),
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
  if (!links.length) return []
  return [env.DB.prepare(
    `INSERT INTO account_groups (
       account_id, group_id, priority, weight, created_at_ms, updated_at_ms
     ) SELECT ?, json_extract(value, '$.group_id'), json_extract(value, '$.priority'),
              json_extract(value, '$.weight'), ?, ? FROM json_each(?)`,
  ).bind(accountId, now, now, JSON.stringify(links))]
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
  return { ...accountResponse({
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
  }), proxy: row.proxy_summary_json ? JSON.parse(row.proxy_summary_json) as Record<string, unknown> : null,
    proxy_fallback_origin_name: row.proxy_fallback_origin_name ?? null }
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
  const quotaExtra = uiConfig.extra && typeof uiConfig.extra === 'object' && !Array.isArray(uiConfig.extra) ? uiConfig.extra as Record<string, unknown> : {}
  const quotaFields = value.credential_kind === 'api_key' || uiConfig.type === 'bedrock' ? accountQuotaProjection(quotaExtra) : {}
  return {
    ...publicValue,
    ...compatibility,
    ...quotaFields,
    rate_multiplier: multiplierPpm / 1_000_000,
    enabled: value.enabled,
    schedulable: uiConfig.schedulable !== false,
    auto_pause_on_expired: uiConfig.auto_pause_on_expired !== false,
    error_message: value.last_health_error ?? '',
    status: !value.enabled
      ? 'inactive' as const
      : value.health_status === 'unhealthy'
        ? 'error' as const
        : 'active' as const,
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
    platform: ProviderPlatform
    provider_config: ProviderConfig
    credential_kind: AccountCredentialKind
    max_concurrency: number
    group_links: GroupLink[]
  },
): Record<string, unknown> {
  const { schema_version: _schemaVersion, credentials: storedCredentials, _worker_account_quota_reset_at_ms: _quotaResetAt, ...stored } = uiConfig
  const credentials = storedCredentials !== null && typeof storedCredentials === 'object' && !Array.isArray(storedCredentials)
    ? storedCredentials as Record<string, unknown>
    : {}
  return {
    ...stored,
    type: uiConfig.type ?? (value.credential_kind === 'api_key'
      ? 'apikey'
      : value.credential_kind === 'setup_token' ? 'setup-token' : 'oauth'),
    credentials: { ...credentials, base_url: value.base_url, ...(value.platform === 'antigravity' ? {project_id:value.provider_config.project_id,antigravity_project_id:value.provider_config.project_id} : {}) },
    concurrency: value.max_concurrency,
    // Account priority is distinct from group membership priority. The original
    // account schema defaults to 50; a missing field must not become form-invalid 0.
    priority: uiConfig.priority ?? 50,
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

function parseGroupLinksProjection(raw: string): GroupLink[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('not an array')
    return value.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('not an object')
      const row = item as Record<string, unknown>
      return {
        group_id: requireResourceId(row.group_id as string | undefined, 'group'),
        priority: requireSafeInteger(row, 'priority', -1_000, 1_000),
        weight: requireSafeInteger(row, 'weight', 1, 1_000),
        control_version: requireSafeInteger(row, 'control_version', 0, Number.MAX_SAFE_INTEGER),
      }
    })
  } catch {
    throw new GatewayError(500, 'invalid_account_projection', 'Account group projection is invalid', 'server_error')
  }
}

function parseModelCapabilitiesProjection(raw: string): ModelCapability[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('not an array')
    return value.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('not an object')
      const row = item as Record<string, unknown>
      return {
        model_id: requireResourceId(row.model_id as string | undefined, 'model'),
        chat_completions: row.chat_completions === true,
        responses: row.responses === true,
        embeddings: row.embeddings === true,
        image_generation: row.image_generation === true,
        control_version: requireSafeInteger(row, 'control_version', 0, Number.MAX_SAFE_INTEGER),
      }
    })
  } catch {
    throw new GatewayError(500, 'invalid_account_projection', 'Account model projection is invalid', 'server_error')
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
  if (message.includes('account_group_oauth_only')) {
    return new GatewayError(400, 'account_group_oauth_only', 'Selected group only allows OAuth accounts; API key accounts cannot be associated')
  }
  if (message.includes('upstream_billing_rate_sync_conflict')) return new GatewayError(409,'upstream_billing_rate_sync_conflict','Disable upstream billing rate sync before manually changing the account rate')
  if (/UNIQUE constraint failed: accounts\.platform, accounts\.name/i.test(message)) {
    return new GatewayError(409, 'account_name_exists', 'An account with this name already exists')
  }
  if (/FOREIGN KEY constraint failed|invalid_account_(?:group|model|proxy)/i.test(message)) {
    return new GatewayError(409, 'account_link_conflict', 'Account links changed or are incompatible')
  }
  if (/CHECK constraint failed:.*lease_until_ms/i.test(message)) {
    return new GatewayError(412, 'oauth_refresh_lease_lost', 'Account token refresh lease expired or changed; reload the account')
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

function requireObjectOrEmpty(value:unknown):Record<string,unknown>{if(value===undefined)return {};if(!value||typeof value!=='object'||Array.isArray(value))throw new GatewayError(400,'invalid_provider_config','provider_config must be an object');return value as Record<string,unknown>}
