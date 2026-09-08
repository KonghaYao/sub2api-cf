import { accountOpenAIEndpointAllowed } from './account-openai-protocol'
import { accountModelRateLimited } from './account-model-rate-limit'
import { accountNotRateLimitedSql, accountNotTemporarilyBlockedSql } from './account-rate-limit'
import { accountQuotaExceeded } from './account-quota-policy'
import { accountNotExpiredSql } from './account-expiry'
import { accountGroupPrivacyAllowedSql } from './account-group-policy'
import { accountModelPolicy, accountModelAllowedSql, modelCapabilityCompatibleSql } from './account-model-policy'
import { effectiveProviderAccount } from '../control/provider-runtime'
import { normalizeSecuritySettings, securityDefaults } from '../control/gateway-security-settings'
import type { Env } from '../env'
import { resolveCompositeRoute } from '../control/composite-routes'
import { groupAccessPredicate } from '../user/group-access'
import { apiKeyDigest } from './crypto'
import type {
  FrozenPricingInterval,
  FrozenPricingPlan,
  FrozenTimePricing,
} from './customer-pricing'
import { GatewayError } from './errors'
import { isSourceIpAllowed, parseStoredIpPolicy, configuredSourceIp } from './ip-policy'
import { isProviderPlatform } from './platform'
import type {
  AccountCandidate,
  AccountCredentialKind,
  AccountCredential,
  AccountImageAdapter,
  GatewayEndpoint,
  GatewayPrincipal,
  ModelRoute,
} from './types'
import type {
  ProviderAuthScheme,
  ProviderConfig,
  ProviderPlatform,
  ProviderProtocol,
} from './providers'

interface PrincipalRow {
  api_key_id: string
  api_key_auth_version: number
  api_key_enabled: number
  expires_at_ms: number | null
  revoked_at_ms: number | null
  user_id: string
  user_status: string
  balance_micros: number
  user_state_version: number
  limit_config_version?: number
  concurrency_limit?: number
  user_rpm_limit?: number
  group_rpm_limit?: number
  api_key_control_version?: number
  quota_micros?: number
  quota_used_micros?: number
  rate_limit_5h_micros?: number
  rate_limit_1d_micros?: number
  rate_limit_7d_micros?: number
  usage_5h_micros?: number
  usage_1d_micros?: number
  usage_7d_micros?: number
  window_5h_start_ms?: number | null
  window_1d_start_ms?: number | null
  window_7d_start_ms?: number | null
  api_key_quota_reset_epoch?: number
  api_key_rate_limit_reset_epoch?: number
  platform_quota_platform?: string | null
  platform_quota_enabled?: number | null
  platform_quota_control_version?: number | null
  platform_daily_limit_micros?: number | null
  platform_weekly_limit_micros?: number | null
  platform_monthly_limit_micros?: number | null
  platform_daily_used_micros?: number | null
  platform_weekly_used_micros?: number | null
  platform_monthly_used_micros?: number | null
  platform_daily_window_start_ms?: number | null
  platform_weekly_window_start_ms?: number | null
  platform_monthly_window_start_ms?: number | null
  platform_daily_reset_epoch?: number | null
  platform_weekly_reset_epoch?: number | null
  platform_monthly_reset_epoch?: number | null
  group_id: string
  group_enabled: number
  group_accessible: number
  platform: string
  group_type: 'standard' | 'subscription'
  subscription_id: string | null
  subscription_starts_at_ms: number | null
  subscription_expires_at_ms: number | null
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  daily_used_micros: number | null
  weekly_used_micros: number | null
  monthly_used_micros: number | null
  daily_anchor_ms: number | null
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  quota_reset_epoch: number | null
  quota_reset_generation: number | null
  subscription_control_version: number | null
  ip_allowlist_json?: string
  ip_denylist_json?: string
}

export async function authenticateGatewayRequest(
  request: Request,
  env: Env,
): Promise<GatewayPrincipal> {
  // D1 is deliberately consulted on every authentication. We do not cache
  // token or IP-policy rows in isolate memory/KV, so a CAS update that bumps
  // auth_version is visible to the very next request without invalidation lag.
  const url = new URL(request.url)
  if (url.searchParams.has('key') || url.searchParams.has('api_key')) {
    throw new GatewayError(
      400,
      'api_key_in_query_deprecated',
      'API key in query parameters is not supported; use Authorization: Bearer instead',
    )
  }

  const rawKey = readApiKey(request.headers)
  if (!env.API_KEY_PEPPER) {
    throw new GatewayError(503, 'gateway_not_configured', 'Gateway API key secret is not configured', 'server_error')
  }
  const digest = await apiKeyDigest(rawKey, env.API_KEY_PEPPER)
  const now = Date.now()
  const row = await env.DB.prepare(
    `SELECT k.id AS api_key_id, k.auth_version AS api_key_auth_version,
            k.enabled AS api_key_enabled, k.expires_at_ms, k.revoked_at_ms,
            u.id AS user_id, u.status AS user_status, u.balance_micros,
            u.state_version AS user_state_version,
            1 AS limit_config_version,
            u.concurrency AS concurrency_limit,
            u.rpm_limit AS user_rpm_limit,
            COALESCE(rpm_override.rpm_override, g.rpm_limit) AS group_rpm_limit,
            k.control_version AS api_key_control_version,
            k.quota_micros, k.quota_used_micros,
            k.rate_limit_5h_micros, k.rate_limit_1d_micros,
            k.rate_limit_7d_micros, k.usage_5h_micros,
            k.usage_1d_micros, k.usage_7d_micros,
            k.window_5h_start_ms, k.window_1d_start_ms,
            k.window_7d_start_ms,
            k.quota_reset_epoch AS api_key_quota_reset_epoch,
            k.rate_limit_reset_epoch AS api_key_rate_limit_reset_epoch,
            k.ip_allowlist_json, k.ip_denylist_json,
            platform_quota.platform AS platform_quota_platform,
            platform_quota.enabled AS platform_quota_enabled,
            platform_quota.control_version AS platform_quota_control_version,
            platform_quota.daily_limit_micros AS platform_daily_limit_micros,
            platform_quota.weekly_limit_micros AS platform_weekly_limit_micros,
            platform_quota.monthly_limit_micros AS platform_monthly_limit_micros,
            platform_quota.daily_used_micros AS platform_daily_used_micros,
            platform_quota.weekly_used_micros AS platform_weekly_used_micros,
            platform_quota.monthly_used_micros AS platform_monthly_used_micros,
            platform_quota.daily_window_start_ms AS platform_daily_window_start_ms,
            platform_quota.weekly_window_start_ms AS platform_weekly_window_start_ms,
            platform_quota.monthly_window_start_ms AS platform_monthly_window_start_ms,
            platform_quota.daily_reset_epoch AS platform_daily_reset_epoch,
            platform_quota.weekly_reset_epoch AS platform_weekly_reset_epoch,
            platform_quota.monthly_reset_epoch AS platform_monthly_reset_epoch,
            g.id AS group_id, g.enabled AS group_enabled, g.platform, g.group_type,
            subscription.id AS subscription_id,
            subscription.starts_at_ms AS subscription_starts_at_ms,
            subscription.expires_at_ms AS subscription_expires_at_ms,
            subscription.daily_quota_micros, subscription.weekly_quota_micros,
            subscription.monthly_quota_micros, subscription.daily_used_micros,
            subscription.weekly_used_micros, subscription.monthly_used_micros,
            subscription.daily_anchor_ms, subscription.daily_window_start_ms,
            subscription.weekly_window_start_ms,
            subscription.monthly_window_start_ms,
            subscription.quota_reset_epoch, subscription.quota_reset_generation,
            subscription.control_version AS subscription_control_version,
            CASE WHEN ${groupAccessPredicate('g', 'u.id')}
                 THEN 1 ELSE 0 END AS group_accessible
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       JOIN "groups" g ON g.id = k.group_id
       LEFT JOIN user_group_rpm_overrides rpm_override
         ON rpm_override.user_id = u.id AND rpm_override.group_id = g.id
       LEFT JOIN user_platform_quotas platform_quota
         ON platform_quota.user_id = u.id
        AND platform_quota.platform = CASE WHEN g.platform = 'codex' THEN 'openai' ELSE g.platform END
       LEFT JOIN user_subscriptions subscription
         ON subscription.user_id = u.id AND subscription.group_id = g.id
        AND subscription.status = 'active'
        AND subscription.starts_at_ms <= ? AND subscription.expires_at_ms > ?
      WHERE k.key_hash = ?
      LIMIT 1`,
  )
    .bind(now, now, now, now, digest)
    .first<PrincipalRow>()

  if (
    row === null ||
    row.api_key_enabled !== 1 ||
    row.revoked_at_ms !== null ||
    (row.expires_at_ms !== null && row.expires_at_ms <= now)
  ) {
    throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API key', 'authentication_error')
  }
  await enforceApiKeyIpPolicy(request, env, row)
  if (row.user_status !== 'active') {
    throw new GatewayError(403, 'user_disabled', 'User account is disabled', 'permission_error')
  }
  if (row.group_enabled !== 1 || (!isProviderPlatform(row.platform) && row.platform !== 'composite')) {
    throw new GatewayError(403, 'group_unavailable', 'API key group is unavailable', 'permission_error')
  }
  if (row.group_accessible !== 1) {
    throw new GatewayError(403, 'group_access_denied', 'API key group access is no longer valid', 'permission_error')
  }
  const legacyLimitFixture = [
    row.limit_config_version,
    row.concurrency_limit,
    row.user_rpm_limit,
    row.group_rpm_limit,
  ].every((value) => value === undefined)
  const limitConfigVersion = legacyLimitFixture ? 0 : row.limit_config_version
  const concurrencyLimit = legacyLimitFixture ? 0 : row.concurrency_limit
  const userRpmLimit = legacyLimitFixture ? 0 : row.user_rpm_limit
  const groupRpmLimit = legacyLimitFixture ? 0 : row.group_rpm_limit
  for (const [field, value] of [
    ['limit_config_version', limitConfigVersion],
    ['concurrency_limit', concurrencyLimit],
    ['user_rpm_limit', userRpmLimit],
    ['group_rpm_limit', groupRpmLimit],
  ] as const) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new GatewayError(500, 'invalid_api_key_limits', `Gateway ${field} is invalid`, 'server_error')
    }
  }
  // Hand-written pre-0022 unit fixtures omit every projection field. Partial
  // or malformed projections still fail closed; deployed D1 always emits v1.
  if (limitConfigVersion !== 0 && limitConfigVersion !== 1) {
    throw new GatewayError(500, 'invalid_api_key_limits', 'Gateway limit projection version is invalid', 'server_error')
  }

  const billing = subscriptionBilling(row)
  return {
    api_key_id: row.api_key_id,
    api_key_auth_version: row.api_key_auth_version,
    user_id: row.user_id,
    group_id: row.group_id,
    platform: row.platform,
    balance_micros: row.balance_micros,
    user_state_version: row.user_state_version,
    limit_config_version: limitConfigVersion!,
    concurrency_limit: concurrencyLimit!,
    user_rpm_limit: userRpmLimit!,
    group_rpm_limit: groupRpmLimit!,
    api_key_monetary: apiKeyMonetaryPolicy(row, now),
    platform_quota: platformQuotaPolicy(row),
    billing,
  }
}

async function enforceApiKeyIpPolicy(request: Request, env: Env, row: PrincipalRow): Promise<void> {
  // Compatibility for hand-written pre-0059 unit fixtures only. A partial
  // projection is never accepted; deployed D1 always returns both columns.
  if (row.ip_allowlist_json === undefined && row.ip_denylist_json === undefined) return
  if (row.ip_allowlist_json === undefined || row.ip_denylist_json === undefined) {
    throw new GatewayError(500, 'invalid_api_key_ip_policy', 'API key IP policy is incomplete', 'server_error')
  }
  const allowlist = parseStoredIpPolicy(row.ip_allowlist_json, 'ip_allowlist_json')
  const denylist = parseStoredIpPolicy(row.ip_denylist_json, 'ip_denylist_json')
  if (allowlist.length === 0 && denylist.length === 0) return
  const stored=await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<{gateway_json:string}>()
  const raw=stored?JSON.parse(stored.gateway_json):{}
  const config=normalizeSecuritySettings(Object.fromEntries(Object.entries(raw).filter(([key])=>Object.hasOwn(securityDefaults,key))))
  if (!isSourceIpAllowed(configuredSourceIp(request, env.ENVIRONMENT,config.api_key_acl_trust_forwarded_ip,config.forwarded_client_ip_headers), allowlist, denylist)) {
    throw new GatewayError(
      403,
      'api_key_ip_restricted',
      'Access is not permitted for this API key',
      'permission_error',
    )
  }
}

function platformQuotaPolicy(row: PrincipalRow): GatewayPrincipal['platform_quota'] {
  // Hand-written fixtures and users without a configured policy both project
  // no platform quota. Disabled D1 tombstones are synchronized by the admin
  // mutation before success and intentionally stop participating in admission.
  if (row.platform_quota_platform == null || row.platform_quota_enabled !== 1) return null
  if (!['anthropic', 'openai', 'gemini', 'antigravity', 'grok'].includes(row.platform_quota_platform)) {
    throw new GatewayError(500, 'invalid_platform_quota', 'Platform quota has an invalid platform', 'server_error')
  }
  const required = [
    row.platform_quota_control_version,
    row.platform_daily_used_micros,
    row.platform_weekly_used_micros,
    row.platform_monthly_used_micros,
    row.platform_daily_reset_epoch,
    row.platform_weekly_reset_epoch,
    row.platform_monthly_reset_epoch,
  ]
  const nullable = [
    row.platform_daily_limit_micros,
    row.platform_weekly_limit_micros,
    row.platform_monthly_limit_micros,
    row.platform_daily_window_start_ms,
    row.platform_weekly_window_start_ms,
    row.platform_monthly_window_start_ms,
  ]
  if (
    required.some((value) => !Number.isSafeInteger(value) || (value as number) < 0) ||
    nullable.some((value) => value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))
  ) {
    throw new GatewayError(500, 'invalid_platform_quota', 'Platform quota state is invalid', 'server_error')
  }
  return {
    platform: row.platform_quota_platform as NonNullable<GatewayPrincipal['platform_quota']>['platform'],
    control_version: row.platform_quota_control_version!,
    daily_limit_micros: row.platform_daily_limit_micros!,
    weekly_limit_micros: row.platform_weekly_limit_micros!,
    monthly_limit_micros: row.platform_monthly_limit_micros!,
    daily_used_micros: row.platform_daily_used_micros!,
    weekly_used_micros: row.platform_weekly_used_micros!,
    monthly_used_micros: row.platform_monthly_used_micros!,
    daily_window_start_ms: row.platform_daily_window_start_ms!,
    weekly_window_start_ms: row.platform_weekly_window_start_ms!,
    monthly_window_start_ms: row.platform_monthly_window_start_ms!,
    daily_reset_epoch: row.platform_daily_reset_epoch!,
    weekly_reset_epoch: row.platform_weekly_reset_epoch!,
    monthly_reset_epoch: row.platform_monthly_reset_epoch!,
  }
}

function apiKeyMonetaryPolicy(
  row: PrincipalRow,
  now: number,
): GatewayPrincipal['api_key_monetary'] {
  const integerFields = [
    'api_key_control_version',
    'quota_micros',
    'quota_used_micros',
    'rate_limit_5h_micros',
    'rate_limit_1d_micros',
    'rate_limit_7d_micros',
    'usage_5h_micros',
    'usage_1d_micros',
    'usage_7d_micros',
    'api_key_quota_reset_epoch',
    'api_key_rate_limit_reset_epoch',
  ] as const
  const windowFields = [
    ['window_5h_start_ms', 'usage_5h_micros'],
    ['window_1d_start_ms', 'usage_1d_micros'],
    ['window_7d_start_ms', 'usage_7d_micros'],
  ] as const
  if (
    integerFields.some((field) => !Number.isSafeInteger(row[field]) || (row[field] as number) < 0) ||
    windowFields.some(([startField, usageField]) => {
      const start = row[startField]
      return start !== null && (!Number.isSafeInteger(start) || (start as number) < 0 || (start as number) > now) ||
        (start === null && row[usageField] !== 0)
    })
  ) {
    throw new GatewayError(
      500,
      'invalid_api_key_monetary_limits',
      'API key monetary limit projection is invalid',
      'server_error',
    )
  }
  return {
    control_version: row.api_key_control_version!,
    quota_micros: row.quota_micros!,
    quota_used_micros: row.quota_used_micros!,
    rate_limit_5h_micros: row.rate_limit_5h_micros!,
    rate_limit_1d_micros: row.rate_limit_1d_micros!,
    rate_limit_7d_micros: row.rate_limit_7d_micros!,
    usage_5h_micros: row.usage_5h_micros!,
    usage_1d_micros: row.usage_1d_micros!,
    usage_7d_micros: row.usage_7d_micros!,
    window_5h_start_ms: row.window_5h_start_ms!,
    window_1d_start_ms: row.window_1d_start_ms!,
    window_7d_start_ms: row.window_7d_start_ms!,
    quota_reset_epoch: row.api_key_quota_reset_epoch!,
    rate_limit_reset_epoch: row.api_key_rate_limit_reset_epoch!,
  }
}

function subscriptionBilling(row: PrincipalRow): GatewayPrincipal['billing'] {
  if (row.group_type !== 'subscription' || row.subscription_id === null) return { type: 'balance' }
  const required = [
    row.subscription_starts_at_ms,
    row.subscription_expires_at_ms,
    row.daily_used_micros,
    row.weekly_used_micros,
    row.monthly_used_micros,
    row.daily_anchor_ms,
    row.quota_reset_epoch,
    row.quota_reset_generation,
    row.subscription_control_version,
  ]
  const nullable = [
    row.daily_quota_micros,
    row.weekly_quota_micros,
    row.monthly_quota_micros,
    row.daily_window_start_ms,
    row.weekly_window_start_ms,
    row.monthly_window_start_ms,
  ]
  if (
    required.some((value) => !Number.isSafeInteger(value) || (value as number) < 0) ||
    nullable.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0)) ||
    row.subscription_expires_at_ms! <= row.subscription_starts_at_ms!
  ) {
    throw new GatewayError(500, 'invalid_subscription_state', 'Subscription billing state is invalid', 'server_error')
  }
  return {
    type: 'subscription',
    subscription_id: row.subscription_id,
    starts_at_ms: row.subscription_starts_at_ms!,
    expires_at_ms: row.subscription_expires_at_ms!,
    daily_quota_micros: row.daily_quota_micros,
    weekly_quota_micros: row.weekly_quota_micros,
    monthly_quota_micros: row.monthly_quota_micros,
    daily_used_micros: row.daily_used_micros!,
    weekly_used_micros: row.weekly_used_micros!,
    monthly_used_micros: row.monthly_used_micros!,
    daily_anchor_ms: row.daily_anchor_ms!,
    daily_window_start_ms: row.daily_window_start_ms,
    weekly_window_start_ms: row.weekly_window_start_ms,
    monthly_window_start_ms: row.monthly_window_start_ms,
    quota_reset_epoch: row.quota_reset_epoch!,
    quota_reset_generation: row.quota_reset_generation!,
    control_version: row.subscription_control_version!,
  }
}

// OpenAI-compatible text protocols are bridged by the gateway. A catalog's
// upstream endpoint must not hide the model from the other public protocol.
// Account capability/policy checks still decide which wire endpoint is usable.
function textModelCapabilitySql(alias = 'm', endpoint = '?'): string {
  return `(${alias}.endpoint = ${endpoint} OR ${alias}.endpoint = 'both' OR
    (${alias}.platform = 'openai' AND ${alias}.endpoint IN ('responses', 'chat_completions')))`
}

export async function listModels(env: Env, groupId: string): Promise<ModelRoute[]> {
  const result = await env.DB.prepare(
    `${modelSelect()}
      WHERE gm.group_id = ? AND gm.enabled = 1 AND m.enabled = 1 AND p.active = 1
        AND (g.catalog_mode = 'all_routable' OR gm.catalog_visible = 1)
        AND EXISTS (
          SELECT 1
            FROM account_groups ag
            JOIN accounts a ON a.id = ag.account_id
            LEFT JOIN account_models am ON am.account_id = a.id AND am.model_id = m.id
           WHERE ag.group_id = gm.group_id AND a.enabled = 1 AND COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1) = 1 AND ${accountNotExpiredSql()} AND ${accountNotRateLimitedSql()} AND ${accountNotTemporarilyBlockedSql()}
             AND a.health_status <> 'unhealthy'
             AND a.platform = m.platform
             AND ${accountModelAllowedSql()}
             AND (m.platform = g.platform OR g.platform = 'composite')
             AND (json_extract(a.ui_config_json, '$.original_model_routing') = 1 OR
               ${modelCapabilityCompatibleSql()}
             )
        )
      ORDER BY gm.sort_order ASC, m.public_name ASC`,
  )
    .bind(groupId)
    .all<ModelListRow>()
  return applyModelsListConfig(result.results)
}

type GroupConfiguredModelRoute = ModelRoute & { ui_config_json: string | null }
type ModelListRow = GroupConfiguredModelRoute

function applyModelsListConfig(models: ModelListRow[]): ModelRoute[] {
  const config = parseModelsListConfig(models[0]?.ui_config_json)
  const clean = withoutGroupUiConfig
  if (config === null || !config.enabled) return models.map(clean)

  const byName = new Map(models.map(model => [model.public_name, model]))
  return config.models.flatMap(name => {
    const model = byName.get(name)
    return model === undefined ? [] : [clean(model)]
  })
}

function withoutGroupUiConfig(model: GroupConfiguredModelRoute): ModelRoute {
  const { ui_config_json: _uiConfig, ...route } = model
  return route
}

function parseGroupUiConfig(value: string | null | undefined): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  try {
    const config = JSON.parse(value)
    return typeof config === 'object' && config !== null && !Array.isArray(config)
      ? config as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parseModelsListConfig(value: string | null | undefined): { enabled: boolean; models: string[] } | null {
  const list = parseGroupUiConfig(value).models_list_config
  if (typeof list !== 'object' || list === null || Array.isArray(list)) return null
  const { enabled, models } = list as { enabled?: unknown; models?: unknown }
  if (enabled !== true || !Array.isArray(models)) return null
  const names = models.filter((model): model is string => typeof model === 'string')
  return names.length === models.length ? { enabled, models: names } : null
}

function resolveModelRouting(
  value: string | null | undefined,
  publicName: string,
): Set<string> | null {
  const config = parseGroupUiConfig(value)
  if (config.model_routing_enabled !== true || typeof config.model_routing !== 'object' || config.model_routing === null || Array.isArray(config.model_routing)) {
    return null
  }
  const matches = Object.entries(config.model_routing as Record<string, unknown>)
    .filter(([pattern, accounts]) => Array.isArray(accounts) && (
      pattern === publicName || (pattern.endsWith('*') && publicName.startsWith(pattern.slice(0, -1)))))
    .sort(([left], [right]) => {
      const leftExact = left === publicName
      const rightExact = right === publicName
      if (leftExact !== rightExact) return leftExact ? -1 : 1
      return right.length - left.length || left.localeCompare(right)
    })
  const selected = matches[0]?.[1]
  if (!Array.isArray(selected)) return null
  return new Set(selected.filter((account): account is string => typeof account === 'string'))
}

function filterModelRoutingCandidates(
  candidates: AccountCandidate[],
  selectedAccounts: Set<string> | null,
): AccountCandidate[] {
  return selectedAccounts === null
    ? candidates
    : candidates.filter(candidate => selectedAccounts.has(candidate.account_id))
}

export async function resolveGatewayRoute(
  env: Env,
  groupId: string,
  publicName: string,
  endpoint: GatewayEndpoint,
  userId: string,
  fallbackEndpoint?: GatewayEndpoint,
  combineProtocolCandidates = false,
): Promise<{
  model: ModelRoute
  candidates: AccountCandidate[]
  upstream_endpoint: GatewayEndpoint
  platform_quota: GatewayPrincipal['platform_quota']
  customer_pricing?: FrozenPricingPlan
}> {
  const compositeRoute = await resolveCompositeRoute(env, groupId, publicName, endpoint as never)
  const compositePlatform = compositeRoute?.target_platform ?? null
  const compositeUpstream = compositeRoute === null ? null : (compositeRoute.upstream_model || (compositeRoute.match_type === 'prefix' ? publicName : compositeRoute.public_model))
  const capabilityColumn = accountCapabilityColumn(endpoint)
  const modelCapability = endpoint === 'embeddings'
    ? 'm.embeddings = 1'
    : endpoint === 'images'
      ? 'm.image_generation = 1'
      : textModelCapabilitySql()
  const routeBindings = endpoint === 'embeddings' || endpoint === 'images'
    ? [groupId, publicName, compositePlatform, compositePlatform]
    : [groupId, publicName, compositePlatform, compositePlatform, endpoint]
  const modelBindings = [userId, ...routeBindings]
  const statements = [
    env.DB.prepare(
      `${modelSelect(true)}
        WHERE gm.group_id = ? AND m.public_name = ?
          AND gm.enabled = 1 AND m.enabled = 1 AND p.active = 1
          AND g.enabled = 1
          AND (m.platform = g.platform OR g.platform = 'composite')
          AND (? IS NULL OR m.platform = ?)
          AND ${modelCapability}
        ORDER BY gm.sort_order ASC, m.platform ASC, m.id ASC
        LIMIT 1`,
    ).bind(...modelBindings),
    channelModelPolicyStatement(env, groupId, publicName, endpoint),
    accountCandidatesStatement(env, groupId, publicName, endpoint, capabilityColumn, undefined, compositePlatform),
    platformQuotaStatement(env, userId, groupId, publicName, endpoint),
  ]
  if (
    (endpoint === 'responses' && fallbackEndpoint === 'chat_completions') ||
    (endpoint === 'chat_completions' && fallbackEndpoint === 'responses')
  ) {
    statements.push(accountCandidatesStatement(
      env,
      groupId,
      publicName,
      endpoint,
      accountCapabilityColumn(fallbackEndpoint),
      endpoint === 'chat_completions' ? 'openai_or_codex' : 'openai', compositePlatform,
    ))
  }
  const [modelResult, channelResult, candidateResult, quotaResult, fallbackCandidateResult] =
    await env.DB.batch(statements)
  const modelRow = modelResult.results[0] as unknown as GroupConfiguredModelRoute | undefined
  if (modelRow === undefined) {
    return resolveExternalChannelAlias(
      env,
      groupId,
      publicName,
      endpoint,
      userId,
      fallbackEndpoint,
      combineProtocolCandidates,
    )
  }
  const modelRouting = resolveModelRouting(modelRow.ui_config_json, publicName)
  const model = withoutGroupUiConfig(modelRow)
  const channelPolicy = channelResult.results[0] as unknown as ChannelModelPolicyRow | undefined
  const routedModel = applyChannelModelPolicy(publicName, compositeUpstream === null ? model : { ...model, upstream_name: compositeUpstream }, channelPolicy)
  const customerPricing = channelPolicy === undefined
    ? undefined
    : frozenPricingPlan(channelPolicy, routedModel.platform)

  // Account eligibility and customer billing remain attached to the requested
  // catalog model. The channel policy may independently snapshot a uniquely
  // resolved mapped model's base price for provider-account cost reporting.
  let candidates = filterModelRoutingCandidates(candidateResult.results.filter(row => accountOpenAIEndpointAllowed(row, endpoint) && !accountQuotaExceeded((row as { ui_config_json?: string }).ui_config_json, String((row as { credential_kind?: string }).credential_kind)) && !accountModelRateLimited((row as { ui_config_json?: string }).ui_config_json, routedModel.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)) && accountModelPolicy((row as { ui_config_json?: string }).ui_config_json, routedModel.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)).allowed).map(parseAccountCandidate), modelRouting)
  let upstreamEndpoint = endpoint
  if (
    (combineProtocolCandidates || candidates.length === 0) &&
    fallbackEndpoint !== undefined &&
    fallbackCandidateResult !== undefined
  ) {
    const alternate = filterModelRoutingCandidates(fallbackCandidateResult.results.filter(row => accountOpenAIEndpointAllowed(row, fallbackEndpoint!) && !accountQuotaExceeded((row as { ui_config_json?: string }).ui_config_json, String((row as { credential_kind?: string }).credential_kind)) && !accountModelRateLimited((row as { ui_config_json?: string }).ui_config_json, routedModel.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)) && accountModelPolicy((row as { ui_config_json?: string }).ui_config_json, routedModel.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)).allowed).map(parseAccountCandidate), modelRouting)
    if (combineProtocolCandidates) {
      const seen = new Set(candidates.map(candidate => candidate.account_id))
      candidates = [...candidates.map(candidate => ({ ...candidate, upstream_endpoint: endpoint })),
        ...alternate.filter(candidate => !seen.has(candidate.account_id)).map(candidate => ({ ...candidate, upstream_endpoint: fallbackEndpoint }))]
        .sort((a, b) => a.priority - b.priority || a.account_id.localeCompare(b.account_id))
    } else { candidates = alternate; upstreamEndpoint = fallbackEndpoint }
  }
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => candidate.config_revision !== routedModel.config_revision)
  ) {
    throw new GatewayError(503, 'no_upstream_accounts', 'No upstream account is configured', 'server_error')
  }
  const quotaRow = quotaResult.results[0] as unknown as PrincipalRow | undefined
  return {
    model: routedModel,
    candidates,
    upstream_endpoint: upstreamEndpoint,
    platform_quota: quotaRow === undefined ? null : platformQuotaPolicy(quotaRow),
    ...(customerPricing === undefined ? {} : { customer_pricing: customerPricing }),
  }
}

interface PricingProjectionRow {
  channel_id: string
  channel_control_version: number
  billing_model: string
  pricing_match_count: number
  pricing_id: string | null
  pricing_control_version: number | null
  pricing_billing_mode: string | null
  pricing_model_pattern: string | null
  pricing_input_micros_per_million: number | null
  pricing_output_micros_per_million: number | null
  pricing_cache_read_micros_per_million: number | null
  pricing_per_request_micros: number | null
  pricing_fast_multiplier_ppm: number | null
  pricing_flex_multiplier_ppm: number | null
  pricing_time_pricing_json: string | null
  pricing_intervals_json: string | null
}

interface ExternalAliasModelRow extends ModelRoute, PricingProjectionRow {
  billing_model_source: string
  match_count: number
}

function externalAliasRouteModel(row: ExternalAliasModelRow): ModelRoute {
  const copy = { ...row } as unknown as Record<string, unknown>
  for (const key of [
    'billing_model_source', 'match_count', 'channel_id', 'channel_control_version',
    'billing_model', 'pricing_match_count', 'pricing_id', 'pricing_control_version',
    'pricing_billing_mode', 'pricing_model_pattern',
    'pricing_input_micros_per_million', 'pricing_output_micros_per_million',
    'pricing_cache_read_micros_per_million', 'pricing_per_request_micros',
    'pricing_fast_multiplier_ppm', 'pricing_flex_multiplier_ppm',
    'pricing_time_pricing_json', 'pricing_intervals_json',
  ]) delete copy[key]
  return copy as unknown as ModelRoute
}

function frozenPricingPlan(
  row: PricingProjectionRow & { billing_model_source?: string },
  platform: ProviderPlatform,
): FrozenPricingPlan | undefined {
  if (!Number.isSafeInteger(row.pricing_match_count) || row.pricing_match_count < 0) {
    return invalidChannelPricing('Channel pricing match count is invalid')
  }
  if (row.pricing_match_count > 1) {
    throw new GatewayError(
      409,
      'ambiguous_channel_pricing',
      `Channel pricing for model '${row.billing_model}' is ambiguous`,
      'invalid_request_error',
    )
  }
  if (row.pricing_match_count === 0) return undefined
  if (!['token', 'per_request', 'image', 'video'].includes(row.pricing_billing_mode ?? '')) {
    return invalidChannelPricing('Channel billing mode is invalid')
  }
  if (
    !nonemptyPricingText(row.channel_id) ||
    !nonemptyPricingText(row.pricing_id) ||
    !nonemptyPricingText(row.pricing_model_pattern) ||
    !nonemptyPricingText(row.billing_model) ||
    !Number.isSafeInteger(row.channel_control_version) || row.channel_control_version < 0 ||
    !Number.isSafeInteger(row.pricing_control_version) || (row.pricing_control_version as number) < 0
  ) {
    return invalidChannelPricing('Channel pricing identity is invalid')
  }
  const nullablePrices = [
    row.pricing_input_micros_per_million,
    row.pricing_output_micros_per_million,
    row.pricing_cache_read_micros_per_million,
    row.pricing_per_request_micros,
    row.pricing_fast_multiplier_ppm,
    row.pricing_flex_multiplier_ppm,
  ]
  if (nullablePrices.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
    return invalidChannelPricing('Channel pricing value is invalid')
  }

  return {
    version: 1,
    channel_id: row.channel_id,
    channel_control_version: row.channel_control_version,
    pricing_id: row.pricing_id!,
    matched_model_pattern: row.pricing_model_pattern!,
    platform,
    billing_model: row.pricing_billing_mode as FrozenPricingPlan['billing_model'],
    input_micros_per_million: row.pricing_input_micros_per_million,
    output_micros_per_million: row.pricing_output_micros_per_million,
    cache_read_micros_per_million: row.pricing_cache_read_micros_per_million,
    per_request_micros: row.pricing_per_request_micros,
    fast_multiplier_ppm: row.pricing_fast_multiplier_ppm,
    flex_multiplier_ppm: row.pricing_flex_multiplier_ppm,
    intervals: parseFrozenPricingIntervals(row.pricing_intervals_json),
    time_pricing: parseFrozenTimePricing(row.pricing_time_pricing_json),
    ...(row.billing_model_source === 'response_model' ? { response_model_billing: true } : {}),
  }
}

/**
 * Resolves a channel price for a model declared by a completed upstream response.
 * The declaration is never used for routing; it only replaces the already-reserved
 * channel price while the request is still in its idempotent settlement transition.
 */
export async function resolveResponseModelPricing(
  env: Env,
  baseline: FrozenPricingPlan,
  responseModel: string,
): Promise<FrozenPricingPlan | undefined> {
  const model = responseModel.trim()
  if (
    model === '' || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model) ||
    !isProviderPlatform(baseline.platform)
  ) return undefined
  const row = await env.DB.prepare(
    `WITH response_input AS (SELECT ? AS model),
          pricing_pattern_matches AS (
       SELECT pricing.id AS pricing_id,
              pricing.control_version AS pricing_control_version,
              pricing.billing_mode AS pricing_billing_mode,
              allowed.model_pattern AS pricing_model_pattern,
              pricing.input_micros_per_million AS pricing_input_micros_per_million,
              pricing.output_micros_per_million AS pricing_output_micros_per_million,
              pricing.cache_read_micros_per_million AS pricing_cache_read_micros_per_million,
              pricing.per_request_micros AS pricing_per_request_micros,
              pricing.fast_multiplier_ppm AS pricing_fast_multiplier_ppm,
              pricing.flex_multiplier_ppm AS pricing_flex_multiplier_ppm,
              pricing.time_pricing_json AS pricing_time_pricing_json,
              ${channelPricingMatchPhaseSql('response.model')} AS match_phase,
              allowed.is_wildcard,
              CASE WHEN allowed.is_wildcard = 1
                THEN length(allowed.model_pattern) ELSE 0 END AS wildcard_length
         FROM channels channel
         JOIN channel_model_pricing pricing
           ON pricing.channel_id = channel.id AND pricing.platform = ?
         JOIN channel_pricing_models allowed ON allowed.pricing_id = pricing.id
         CROSS JOIN response_input response
        WHERE channel.id = ? AND channel.status = 'active'
          AND ${channelPricingMatchPhaseSql('response.model')} IS NOT NULL
     ), best_pricing AS (
       SELECT matched.*, COUNT(*) OVER () AS pricing_match_count
         FROM pricing_pattern_matches matched
        WHERE matched.match_phase = (SELECT MIN(match_phase) FROM pricing_pattern_matches)
          AND matched.wildcard_length = (
            SELECT MAX(wildcard_length) FROM pricing_pattern_matches
             WHERE match_phase = (SELECT MIN(match_phase) FROM pricing_pattern_matches)
          )
     )
     SELECT channel.id AS channel_id,
            channel.control_version AS channel_control_version,
            response.model AS billing_model,
            COALESCE(pricing.pricing_match_count, 0) AS pricing_match_count,
            pricing.pricing_id,
            pricing.pricing_control_version,
            pricing.pricing_billing_mode,
            pricing.pricing_model_pattern,
            pricing.pricing_input_micros_per_million,
            pricing.pricing_output_micros_per_million,
            pricing.pricing_cache_read_micros_per_million,
            pricing.pricing_per_request_micros,
            pricing.pricing_fast_multiplier_ppm,
            pricing.pricing_flex_multiplier_ppm,
            pricing.pricing_time_pricing_json,
            channel.billing_model_source,
            (
              SELECT json_group_array(json_object(
                'id', interval.id, 'min_tokens', interval.min_tokens,
                'max_tokens', interval.max_tokens, 'tier_label', interval.tier_label,
                'input_micros_per_million', interval.input_micros_per_million,
                'output_micros_per_million', interval.output_micros_per_million,
                'cache_read_micros_per_million', interval.cache_read_micros_per_million,
                'input_multiplier_ppm', interval.input_multiplier_ppm,
                'output_multiplier_ppm', interval.output_multiplier_ppm,
                'cache_read_multiplier_ppm', interval.cache_read_multiplier_ppm,
                'per_request_micros', interval.per_request_micros
              ))
                FROM (
                  SELECT * FROM channel_pricing_intervals interval
                   WHERE interval.pricing_id = pricing.pricing_id
                   ORDER BY interval.sort_order ASC, interval.id ASC
                   LIMIT 101
                ) interval
            ) AS pricing_intervals_json
       FROM channels channel
       CROSS JOIN response_input response
       LEFT JOIN best_pricing pricing ON 1 = 1
      WHERE channel.id = ? AND channel.status = 'active'`,
  ).bind(model, baseline.platform, baseline.channel_id, baseline.channel_id)
    .first<PricingProjectionRow & { billing_model_source: string }>()
  return row === null ? undefined : frozenPricingPlan(row, baseline.platform)
}

function parseFrozenPricingIntervals(value: string | null): FrozenPricingInterval[] {
  if (value === null || value.length > 131_072) {
    return invalidChannelPricing('Channel pricing intervals are invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return invalidChannelPricing('Channel pricing intervals are invalid')
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    return invalidChannelPricing('Channel pricing intervals are invalid')
  }
  return parsed.map((value) => parseFrozenPricingInterval(value))
}

function parseFrozenPricingInterval(value: unknown): FrozenPricingInterval {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidChannelPricing('Channel pricing interval is invalid')
  }
  const row = value as Record<string, unknown>
  if (
    !nonemptyPricingText(row.id) ||
    typeof row.tier_label !== 'string' ||
    !safePricingInteger(row.min_tokens) ||
    !(row.max_tokens === null || safePricingInteger(row.max_tokens)) ||
    (typeof row.max_tokens === 'number' && row.max_tokens <= (row.min_tokens as number))
  ) {
    return invalidChannelPricing('Channel pricing interval is invalid')
  }
  const nullableKeys = [
    'input_micros_per_million', 'output_micros_per_million',
    'cache_read_micros_per_million', 'input_multiplier_ppm',
    'output_multiplier_ppm', 'cache_read_multiplier_ppm', 'per_request_micros',
  ] as const
  if (nullableKeys.some((key) => row[key] !== null && !safePricingInteger(row[key]))) {
    return invalidChannelPricing('Channel pricing interval is invalid')
  }
  return {
    id: row.id as string,
    min_tokens: row.min_tokens as number,
    max_tokens: row.max_tokens as number | null,
    tier_label: row.tier_label,
    input_micros_per_million: row.input_micros_per_million as number | null,
    output_micros_per_million: row.output_micros_per_million as number | null,
    cache_read_micros_per_million: row.cache_read_micros_per_million as number | null,
    input_multiplier_ppm: row.input_multiplier_ppm as number | null,
    output_multiplier_ppm: row.output_multiplier_ppm as number | null,
    cache_read_multiplier_ppm: row.cache_read_multiplier_ppm as number | null,
    per_request_micros: row.per_request_micros as number | null,
  }
}

function parseFrozenTimePricing(value: string | null): FrozenTimePricing | null {
  if (value === null) return null
  if (value.length > 65_536) return invalidChannelPricing('Channel time pricing is invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return invalidChannelPricing('Channel time pricing is invalid')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidChannelPricing('Channel time pricing is invalid')
  }
  const row = parsed as Record<string, unknown>
  if (
    !nonemptyPricingText(row.timezone) ||
    typeof row.weekdays_only !== 'boolean' ||
    !Array.isArray(row.periods) || row.periods.length > 48
  ) {
    return invalidChannelPricing('Channel time pricing is invalid')
  }
  const periods = row.periods.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return invalidChannelPricing('Channel time pricing period is invalid')
    }
    const period = value as Record<string, unknown>
    if (
      typeof period.start_time !== 'string' ||
      typeof period.end_time !== 'string' ||
      !safePricingInteger(period.multiplier_ppm)
    ) {
      return invalidChannelPricing('Channel time pricing period is invalid')
    }
    return {
      start_time: period.start_time,
      end_time: period.end_time,
      multiplier_ppm: period.multiplier_ppm,
    }
  })
  return { timezone: row.timezone, weekdays_only: row.weekdays_only, periods }
}

function safePricingInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function nonemptyPricingText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function invalidChannelPricing(message: string): never {
  throw new GatewayError(500, 'invalid_channel_pricing', message, 'server_error')
}

function normalizedChannelPricingModelSql(expression: string): string {
  return `(CASE WHEN lower(${expression}) LIKE 'claude-%'
    THEN replace(lower(${expression}), '.', '-') ELSE lower(${expression}) END)`
}

function channelPricingMatchSql(candidate: string): string {
  const normalizedCandidate = normalizedChannelPricingModelSql(candidate)
  const normalizedPattern = normalizedChannelPricingModelSql('allowed.model_pattern')
  const normalizedPrefix = normalizedChannelPricingModelSql(
    'substr(allowed.model_pattern, 1, length(allowed.model_pattern) - 1)',
  )
  return `(
    (allowed.is_wildcard = 0 AND ${normalizedPattern} = ${normalizedCandidate})
    OR
    (allowed.is_wildcard = 1 AND
      substr(${normalizedCandidate}, 1, length(allowed.model_pattern) - 1) = ${normalizedPrefix})
  )`
}

function normalizedOpenAICodexPricingBaseSql(expression: string): string {
  const value = `lower(replace(replace(replace(trim(${expression}), '_', '-'), ' ', '-'), 'gpt5', 'gpt-5'))`
  return `(CASE
    WHEN ${value} LIKE '%gpt-5.6-sol%' THEN 'gpt-5.6-sol'
    WHEN ${value} LIKE '%gpt-5.6-terra%' THEN 'gpt-5.6-terra'
    WHEN ${value} LIKE '%gpt-5.6-luna%' THEN 'gpt-5.6-luna'
    WHEN ${value} = 'gpt-5.6' OR ${value} LIKE '%/gpt-5.6' THEN 'gpt-5.6-sol'
    WHEN ${value} LIKE '%gpt-5.6-none' OR ${value} LIKE '%gpt-5.6-minimal'
      OR ${value} LIKE '%gpt-5.6-low' OR ${value} LIKE '%gpt-5.6-medium'
      OR ${value} LIKE '%gpt-5.6-high' OR ${value} LIKE '%gpt-5.6-xhigh'
      OR ${value} LIKE '%gpt-5.6-max'
      OR ${value} GLOB '*gpt-5.6-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      THEN 'gpt-5.6-sol'
    WHEN ${value} LIKE '%gpt-5.5-pro%' THEN 'gpt-5.5-pro'
    WHEN ${value} LIKE '%gpt-5.5%' THEN 'gpt-5.5'
    WHEN ${value} LIKE '%gpt-5.4-mini%' OR ${value} LIKE '%gpt-5.4mini%' THEN 'gpt-5.4-mini'
    WHEN ${value} LIKE '%gpt-5.4-nano%' OR ${value} LIKE '%gpt-5.4nano%' THEN 'gpt-5.4-nano'
    WHEN ${value} LIKE '%gpt-5.4%' THEN 'gpt-5.4'
    WHEN ${value} LIKE '%gpt-5.2%' THEN 'gpt-5.2'
    WHEN ${value} LIKE '%gpt-5.3-codex-spark%' OR ${value} LIKE '%gpt-5.3codexspark%'
      THEN 'gpt-5.3-codex-spark'
    WHEN ${value} LIKE '%gpt-5.3-codex%' OR ${value} LIKE '%gpt-5.3codex%'
      THEN 'gpt-5.3-codex'
    WHEN ${value} LIKE '%gpt-5.3%' THEN 'gpt-5.3-codex'
    WHEN ${value} LIKE '%codex%' THEN 'gpt-5.3-codex'
    WHEN ${value} LIKE '%gpt-5%' THEN 'gpt-5.4'
    ELSE NULL
  END)`
}

/** Literal channel patterns always win; known OpenAI/Codex base names are fallback-only. */
function channelPricingMatchPhaseSql(candidate: string): string {
  const normalizedBase = normalizedOpenAICodexPricingBaseSql(candidate)
  return `(CASE
    WHEN ${channelPricingMatchSql(candidate)} THEN 0
    WHEN ${normalizedBase} IS NOT NULL AND ${channelPricingMatchSql(normalizedBase)} THEN 1
    ELSE NULL
  END)`
}

async function resolveExternalChannelAlias(
  env: Env,
  groupId: string,
  publicName: string,
  endpoint: GatewayEndpoint,
  userId: string,
  fallbackEndpoint?: GatewayEndpoint,
  combineProtocolCandidates = false,
): Promise<{
  model: ModelRoute
  candidates: AccountCandidate[]
  upstream_endpoint: GatewayEndpoint
  platform_quota: GatewayPrincipal['platform_quota']
  customer_pricing?: FrozenPricingPlan
}> {
  const capabilityColumn = accountCapabilityColumn(endpoint)
  const statements = [
    externalAliasModelStatement(env, groupId, publicName, endpoint, userId),
    externalAliasCandidatesStatement(env, groupId, publicName, endpoint, capabilityColumn),
    externalAliasQuotaStatement(env, groupId, publicName, endpoint, userId),
  ]
  if (
    (endpoint === 'responses' && fallbackEndpoint === 'chat_completions') ||
    (endpoint === 'chat_completions' && fallbackEndpoint === 'responses')
  ) {
    statements.push(externalAliasCandidatesStatement(
      env,
      groupId,
      publicName,
      endpoint,
      accountCapabilityColumn(fallbackEndpoint),
      endpoint === 'chat_completions' ? 'openai_or_codex' : 'openai',
    ))
  }

  const [modelResult, candidateResult, quotaResult, fallbackCandidateResult] =
    await env.DB.batch(statements)
  const modelRows = modelResult.results as unknown as ExternalAliasModelRow[]
  if (modelRows.length === 0) {
    throw new GatewayError(404, 'model_not_found', `Model '${publicName}' is not available`, 'invalid_request_error')
  }
  if (modelRows.length !== 1 || modelRows[0].match_count !== 1) {
    throw new GatewayError(
      409,
      'ambiguous_model_alias',
      `Model alias '${publicName}' resolves to more than one provider`,
      'invalid_request_error',
    )
  }
  const aliasModel = modelRows[0]
  assertSupportedChannelBillingSource(aliasModel.billing_model_source)
  const customerPricing = frozenPricingPlan(aliasModel, aliasModel.platform)
  const model = externalAliasRouteModel(aliasModel)
  let candidates = candidateResult.results.filter(row => accountOpenAIEndpointAllowed(row, endpoint) && !accountQuotaExceeded((row as { ui_config_json?: string }).ui_config_json, String((row as { credential_kind?: string }).credential_kind)) && !accountModelRateLimited((row as { ui_config_json?: string }).ui_config_json, model.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)) && accountModelPolicy((row as { ui_config_json?: string }).ui_config_json, model.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)).allowed).map(parseAccountCandidate)
  let upstreamEndpoint = endpoint
  if (
    (combineProtocolCandidates || candidates.length === 0) &&
    fallbackEndpoint !== undefined &&
    fallbackCandidateResult !== undefined
  ) {
    const alternate = fallbackCandidateResult.results.filter(row => accountOpenAIEndpointAllowed(row, fallbackEndpoint!) && !accountQuotaExceeded((row as { ui_config_json?: string }).ui_config_json, String((row as { credential_kind?: string }).credential_kind)) && !accountModelRateLimited((row as { ui_config_json?: string }).ui_config_json, model.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)) && accountModelPolicy((row as { ui_config_json?: string }).ui_config_json, model.upstream_name, String((row as { platform?: string }).platform), String((row as { credential_kind?: string }).credential_kind)).allowed).map(parseAccountCandidate)
    if (combineProtocolCandidates) {
      const seen = new Set(candidates.map(candidate => candidate.account_id))
      candidates = [...candidates.map(candidate => ({ ...candidate, upstream_endpoint: endpoint })),
        ...alternate.filter(candidate => !seen.has(candidate.account_id)).map(candidate => ({ ...candidate, upstream_endpoint: fallbackEndpoint }))]
        .sort((a, b) => a.priority - b.priority || a.account_id.localeCompare(b.account_id))
    } else { candidates = alternate; upstreamEndpoint = fallbackEndpoint }
  }
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => candidate.config_revision !== model.config_revision)
  ) {
    throw new GatewayError(503, 'no_upstream_accounts', 'No upstream account is configured', 'server_error')
  }
  const quotaRow = quotaResult.results[0] as unknown as PrincipalRow | undefined
  return {
    model,
    candidates,
    upstream_endpoint: upstreamEndpoint,
    platform_quota: quotaRow === undefined ? null : platformQuotaPolicy(quotaRow),
    ...(customerPricing === undefined ? {} : { customer_pricing: customerPricing }),
  }
}

function externalAliasCte(
  groupId: string,
  publicName: string,
  endpoint: GatewayEndpoint,
): { sql: string; bindings: unknown[] } {
  const modelCapability = endpoint === 'embeddings'
    ? 'm.embeddings = 1'
    : endpoint === 'images'
      ? 'm.image_generation = 1'
      : textModelCapabilitySql()
  const bindings: unknown[] = [publicName, groupId, groupId]
  if (endpoint !== 'embeddings' && endpoint !== 'images') bindings.push(endpoint)
  return {
    sql: `WITH request_input(requested_model) AS (VALUES (?)),
      matching_mappings AS (
        SELECT c.id AS channel_id, c.control_version AS channel_control_version,
               c.restrict_models, c.billing_model_source, mapping.platform,
               mapping.source_pattern, mapping.target_pattern,
               mapping.source_is_wildcard, mapping.target_is_wildcard,
               mapping.sort_order,
               ROW_NUMBER() OVER (
                 PARTITION BY mapping.platform
                 ORDER BY mapping.source_is_wildcard ASC, mapping.sort_order ASC,
                          length(mapping.source_pattern) DESC, mapping.source_pattern ASC
               ) AS mapping_rank
          FROM channel_groups cg
          JOIN channels c ON c.id = cg.channel_id
          JOIN "groups" channel_group ON channel_group.id = cg.group_id
          JOIN channel_model_mappings mapping ON mapping.channel_id = c.id
          CROSS JOIN request_input request
         WHERE cg.group_id = ? AND c.status = 'active' AND channel_group.enabled = 1
           AND (channel_group.platform = 'composite' OR mapping.platform = channel_group.platform)
           AND (
             (mapping.source_is_wildcard = 0 AND mapping.source_pattern = request.requested_model COLLATE NOCASE)
             OR
             (mapping.source_is_wildcard = 1 AND
               substr(lower(request.requested_model), 1, length(mapping.source_pattern) - 1) =
                 lower(substr(mapping.source_pattern, 1, length(mapping.source_pattern) - 1)))
           )
      ), selected_mappings AS (
        SELECT channel_id, channel_control_version, restrict_models,
               billing_model_source, platform, source_pattern, target_pattern,
               source_is_wildcard, target_is_wildcard,
               CASE WHEN target_is_wildcard = 1
                 THEN substr(target_pattern, 1, length(target_pattern) - 1) ||
                      CASE WHEN source_is_wildcard = 1
                        THEN substr(request.requested_model, length(source_pattern))
                        ELSE ''
                      END
                 ELSE target_pattern
               END AS expanded_target
          FROM matching_mappings
          CROSS JOIN request_input request
         WHERE mapping_rank = 1 AND target_pattern <> ''
      ), backing_matches AS (
        SELECT mapping.channel_id, mapping.channel_control_version,
               mapping.restrict_models, mapping.billing_model_source,
               mapping.expanded_target,
               COALESCE(gm.upstream_name_override, m.upstream_name) AS backing_upstream_name,
               gm.group_id, gm.model_id, gm.max_output_tokens, gm.default_max_output_tokens,
               g.rate_multiplier_ppm AS group_rate_multiplier_ppm,
               m.platform, m.endpoint, m.embeddings, m.image_generation,
               p.id AS price_id, p.version AS price_version,
               p.input_micros_per_million, p.output_micros_per_million,
               p.cache_read_micros_per_million, p.per_request_micros,
               p.minimum_reservation_micros
          FROM selected_mappings mapping
          JOIN group_models gm ON gm.group_id = ?
          JOIN "groups" g ON g.id = gm.group_id
          JOIN models m ON m.id = gm.model_id AND m.platform = mapping.platform
          JOIN model_prices p ON p.group_id = gm.group_id AND p.model_id = gm.model_id
         WHERE gm.enabled = 1 AND m.enabled = 1 AND p.active = 1 AND g.enabled = 1
           AND ${modelCapability}
           AND (
             m.public_name = mapping.expanded_target COLLATE NOCASE OR
             COALESCE(gm.upstream_name_override, m.upstream_name) = mapping.expanded_target COLLATE NOCASE
           )
      ), resolved_alias AS (
        SELECT backing.*,
               CASE backing.billing_model_source
                 WHEN 'requested' THEN request.requested_model
                 WHEN 'upstream' THEN backing.backing_upstream_name
                 ELSE backing.expanded_target
               END AS billing_model,
               COUNT(*) OVER () AS match_count
          FROM backing_matches backing
          CROSS JOIN request_input request
      )`,
    bindings,
  }
}

function externalAliasModelStatement(
  env: Env,
  groupId: string,
  publicName: string,
  endpoint: GatewayEndpoint,
  userId: string,
): D1PreparedStatement {
  const cte = externalAliasCte(groupId, publicName, endpoint)
  return env.DB.prepare(
    `${cte.sql}, pricing_pattern_matches AS (
       SELECT pricing.id AS pricing_id,
              pricing.control_version AS pricing_control_version,
              pricing.billing_mode AS pricing_billing_mode,
              pricing.input_micros_per_million AS pricing_input_micros_per_million,
              pricing.output_micros_per_million AS pricing_output_micros_per_million,
              pricing.cache_read_micros_per_million AS pricing_cache_read_micros_per_million,
              pricing.per_request_micros AS pricing_per_request_micros,
              pricing.fast_multiplier_ppm AS pricing_fast_multiplier_ppm,
              pricing.flex_multiplier_ppm AS pricing_flex_multiplier_ppm,
              pricing.time_pricing_json AS pricing_time_pricing_json,
              allowed.model_pattern AS pricing_model_pattern,
              ${channelPricingMatchPhaseSql('alias.billing_model')} AS match_phase,
              DENSE_RANK() OVER (
                ORDER BY ${channelPricingMatchPhaseSql('alias.billing_model')} ASC,
                         allowed.is_wildcard ASC,
                         CASE WHEN allowed.is_wildcard = 1
                           THEN length(allowed.model_pattern) ELSE 0 END DESC
              ) AS specificity_rank
         FROM resolved_alias alias
         JOIN channel_model_pricing pricing
           ON pricing.channel_id = alias.channel_id AND pricing.platform = alias.platform
         JOIN channel_pricing_models allowed ON allowed.pricing_id = pricing.id
        WHERE alias.match_count = 1
          AND ${channelPricingMatchPhaseSql('alias.billing_model')} IS NOT NULL
     ), best_pricing AS (
       SELECT matched.*, COUNT(*) OVER () AS pricing_match_count
         FROM pricing_pattern_matches matched
        WHERE matched.specificity_rank = 1
     )
     SELECT revision.revision AS config_revision,
            alias.model_id, alias.platform, ? AS public_name,
            alias.backing_upstream_name AS upstream_name,
            alias.endpoint, alias.embeddings, alias.image_generation,
            alias.price_id, alias.price_version,
            alias.input_micros_per_million, alias.output_micros_per_million,
            alias.cache_read_micros_per_million, alias.per_request_micros,
            alias.minimum_reservation_micros,
            alias.price_id AS account_cost_base_price_id,
            alias.price_version AS account_cost_base_price_version,
            alias.input_micros_per_million AS account_cost_base_input_micros_per_million,
            alias.output_micros_per_million AS account_cost_base_output_micros_per_million,
            alias.cache_read_micros_per_million AS account_cost_base_cache_read_micros_per_million,
            alias.per_request_micros AS account_cost_base_per_request_micros,
            alias.group_rate_multiplier_ppm,
            user_rate.rate_multiplier_ppm AS user_rate_multiplier_ppm,
            COALESCE(user_rate.rate_multiplier_ppm, alias.group_rate_multiplier_ppm) AS rate_multiplier_ppm,
            alias.max_output_tokens, alias.default_max_output_tokens,
            alias.channel_id, alias.channel_control_version,
            alias.billing_model,
            COALESCE(pricing.pricing_match_count, 0) AS pricing_match_count,
            pricing.pricing_id, pricing.pricing_control_version,
            pricing.pricing_billing_mode, pricing.pricing_model_pattern,
            pricing.pricing_input_micros_per_million,
            pricing.pricing_output_micros_per_million,
            pricing.pricing_cache_read_micros_per_million,
            pricing.pricing_per_request_micros,
            pricing.pricing_fast_multiplier_ppm,
            pricing.pricing_flex_multiplier_ppm,
            pricing.pricing_time_pricing_json,
            CASE WHEN pricing.pricing_id IS NULL THEN NULL ELSE (
              SELECT json_group_array(json_object(
                'id', interval.id,
                'min_tokens', interval.min_tokens,
                'max_tokens', interval.max_tokens,
                'tier_label', interval.tier_label,
                'input_micros_per_million', interval.input_micros_per_million,
                'output_micros_per_million', interval.output_micros_per_million,
                'cache_read_micros_per_million', interval.cache_read_micros_per_million,
                'input_multiplier_ppm', interval.input_multiplier_ppm,
                'output_multiplier_ppm', interval.output_multiplier_ppm,
                'cache_read_multiplier_ppm', interval.cache_read_multiplier_ppm,
                'per_request_micros', interval.per_request_micros
              ))
                FROM (
                  SELECT * FROM channel_pricing_intervals bounded
                   WHERE bounded.pricing_id = pricing.pricing_id
                   ORDER BY bounded.sort_order ASC, bounded.id ASC
                   LIMIT 101
                ) interval
            ) END AS pricing_intervals_json,
            alias.billing_model_source, alias.match_count
       FROM resolved_alias alias
       LEFT JOIN best_pricing pricing ON 1 = 1
       LEFT JOIN user_group_rate_overrides user_rate
         ON user_rate.group_id = alias.group_id AND user_rate.user_id = ?
       CROSS JOIN gateway_config_revision revision
      ORDER BY alias.platform ASC, alias.model_id ASC
      LIMIT 2`,
  ).bind(...cte.bindings, publicName, userId)
}

function externalAliasCandidatesStatement(
  env: Env,
  groupId: string,
  publicName: string,
  modelEndpoint: GatewayEndpoint,
  capabilityColumn: 'am.chat_completions' | 'am.responses' | 'am.embeddings' | 'am.image_generation',
  platformConstraint?: 'openai' | 'openai_or_codex',
  compositePlatform?: string | null,
): D1PreparedStatement {
  const cte = externalAliasCte(groupId, publicName, modelEndpoint)
  const platformPredicate = platformConstraint === 'openai'
    ? "AND a.platform IN ('openai', 'grok', 'antigravity')"
    : platformConstraint === 'openai_or_codex'
      ? "AND a.platform IN ('openai', 'codex', 'grok', 'antigravity')"
      : ''
  return env.DB.prepare(
    `${cte.sql}
     SELECT a.id AS account_id, a.platform, a.protocol, a.auth_scheme,
            a.image_adapter, a.credential_kind,
            a.provider_config_json, a.ui_config_json, a.base_url, a.max_concurrency, a.billing_rate_multiplier_ppm,
            CASE WHEN json_extract(a.ui_config_json, '$.extra.upstream_billing_probe.identity.credential_ref') = a.credential_ref
                   AND json_extract(a.ui_config_json, '$.extra.upstream_billing_probe.identity.base_url') = a.base_url
                   AND json_extract(a.ui_config_json, '$.extra.upstream_billing_probe.identity.platform') = a.platform
                 THEN json_extract(a.ui_config_json, '$.extra.upstream_billing_probe') END AS upstream_billing_probe_json,
            CASE WHEN json_extract(settings.public_json, '$.openai_advanced_scheduler_subscription_priority_enabled') = 1
                    AND a.platform = 'openai' AND a.credential_kind = 'oauth'
                    AND lower(trim(COALESCE(json_extract(a.provider_config_json, '$.subscription_plan'), ''))) NOT IN ('', 'free', 'abnormal')
                 THEN ag.priority + 1000 ELSE ag.priority + 3001 END AS priority, ag.weight, a.config_version,
            a.recovery_revision,
            revision.revision AS config_revision, resolved.model_id
       FROM resolved_alias resolved
       JOIN accounts a ON a.platform = resolved.platform
       LEFT JOIN account_models am ON am.model_id = resolved.model_id AND am.account_id = a.id
       JOIN account_groups ag ON ag.account_id = a.id AND ag.group_id = resolved.group_id
       JOIN "groups" g ON g.id = ag.group_id
       CROSS JOIN gateway_config_revision revision
       CROSS JOIN system_settings settings
      WHERE resolved.match_count = 1 AND a.enabled = 1 AND COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1) = 1 AND ${accountNotExpiredSql()} AND ${accountNotRateLimitedSql()} AND ${accountNotTemporarilyBlockedSql()} AND ${accountGroupPrivacyAllowedSql()} AND a.base_url IS NOT NULL
        AND a.health_status <> 'unhealthy'
        AND (g.platform = a.platform OR g.platform = 'composite')
        AND (${capabilityColumn} = 1 OR json_extract(a.ui_config_json, '$.original_model_routing') = 1)
        ${platformPredicate}
      ORDER BY priority ASC, a.id ASC`,
  ).bind(...cte.bindings)
}

function externalAliasQuotaStatement(
  env: Env,
  groupId: string,
  publicName: string,
  endpoint: GatewayEndpoint,
  userId: string,
): D1PreparedStatement {
  const cte = externalAliasCte(groupId, publicName, endpoint)
  return env.DB.prepare(
    `${cte.sql}
     SELECT quota.platform AS platform_quota_platform,
            quota.enabled AS platform_quota_enabled,
            quota.control_version AS platform_quota_control_version,
            quota.daily_limit_micros AS platform_daily_limit_micros,
            quota.weekly_limit_micros AS platform_weekly_limit_micros,
            quota.monthly_limit_micros AS platform_monthly_limit_micros,
            quota.daily_used_micros AS platform_daily_used_micros,
            quota.weekly_used_micros AS platform_weekly_used_micros,
            quota.monthly_used_micros AS platform_monthly_used_micros,
            quota.daily_window_start_ms AS platform_daily_window_start_ms,
            quota.weekly_window_start_ms AS platform_weekly_window_start_ms,
            quota.monthly_window_start_ms AS platform_monthly_window_start_ms,
            quota.daily_reset_epoch AS platform_daily_reset_epoch,
            quota.weekly_reset_epoch AS platform_weekly_reset_epoch,
            quota.monthly_reset_epoch AS platform_monthly_reset_epoch
       FROM resolved_alias resolved
       JOIN user_platform_quotas quota
         ON quota.user_id = ?
        AND quota.platform = CASE
          WHEN resolved.platform = 'codex' THEN 'openai'
          ELSE resolved.platform
        END
      WHERE resolved.match_count = 1
      LIMIT 1`,
  ).bind(...cte.bindings, userId)
}

function platformQuotaStatement(
  env: Env,
  userId: string,
  groupId: string,
  publicName: string,
  endpoint: GatewayEndpoint,
): D1PreparedStatement {
  const modelCapability = endpoint === 'embeddings'
    ? 'm.embeddings = 1'
    : endpoint === 'images'
      ? 'm.image_generation = 1'
      : textModelCapabilitySql()
  const bindings = endpoint === 'embeddings' || endpoint === 'images'
    ? [groupId, publicName, userId]
    : [groupId, publicName, endpoint, userId]
  return env.DB.prepare(
    `WITH resolved_model AS (
       SELECT m.platform
         FROM group_models gm
         JOIN "groups" g ON g.id = gm.group_id
         JOIN models m ON m.id = gm.model_id
         JOIN model_prices p ON p.group_id = gm.group_id AND p.model_id = gm.model_id
        WHERE gm.group_id = ? AND m.public_name = ?
          AND gm.enabled = 1 AND m.enabled = 1 AND p.active = 1
          AND g.enabled = 1
          AND (m.platform = g.platform OR g.platform = 'composite')
          AND ${modelCapability}
        ORDER BY gm.sort_order ASC, m.platform ASC, m.id ASC
        LIMIT 1
     )
     SELECT quota.platform AS platform_quota_platform,
            quota.enabled AS platform_quota_enabled,
            quota.control_version AS platform_quota_control_version,
            quota.daily_limit_micros AS platform_daily_limit_micros,
            quota.weekly_limit_micros AS platform_weekly_limit_micros,
            quota.monthly_limit_micros AS platform_monthly_limit_micros,
            quota.daily_used_micros AS platform_daily_used_micros,
            quota.weekly_used_micros AS platform_weekly_used_micros,
            quota.monthly_used_micros AS platform_monthly_used_micros,
            quota.daily_window_start_ms AS platform_daily_window_start_ms,
            quota.weekly_window_start_ms AS platform_weekly_window_start_ms,
            quota.monthly_window_start_ms AS platform_monthly_window_start_ms,
            quota.daily_reset_epoch AS platform_daily_reset_epoch,
            quota.weekly_reset_epoch AS platform_weekly_reset_epoch,
            quota.monthly_reset_epoch AS platform_monthly_reset_epoch
       FROM resolved_model resolved
       JOIN user_platform_quotas quota
         ON quota.user_id = ?
        AND quota.platform = CASE
          WHEN resolved.platform = 'codex' THEN 'openai'
          ELSE resolved.platform
        END
      LIMIT 1`,
  ).bind(...bindings)
}

interface ChannelModelPolicyRow extends PricingProjectionRow {
  billing_model_source: string
  restrict_models: number
  source_pattern: string | null
  target_pattern: string | null
  source_is_wildcard: number | null
  target_is_wildcard: number | null
  account_cost_base_match_count: number | null
  account_cost_base_price_id: string | null
  account_cost_base_price_version: number | null
  account_cost_base_input_micros_per_million: number | null
  account_cost_base_output_micros_per_million: number | null
  account_cost_base_cache_read_micros_per_million: number | null
  account_cost_base_per_request_micros: number | null
}

function assertSupportedChannelBillingSource(value: string): void {
  if (!['channel_mapped', 'requested', 'upstream', 'response_model'].includes(value)) {
    throw new GatewayError(
      409,
      'unsupported_billing_model_source',
      `Channel billing model source '${value}' is not supported by the Worker gateway`,
      'invalid_request_error',
    )
  }
}

function channelModelPolicyStatement(
  env: Env,
  groupId: string,
  requestedModel: string,
  endpoint: GatewayEndpoint,
): D1PreparedStatement {
  const modelCapability = endpoint === 'embeddings'
    ? 'resolved.embeddings = 1'
    : endpoint === 'images'
      ? 'resolved.image_generation = 1'
      : textModelCapabilitySql('resolved')
  const accountCostModelCapability = endpoint === 'embeddings'
    ? 'account_cost_model.embeddings = 1'
    : endpoint === 'images'
      ? 'account_cost_model.image_generation = 1'
      : textModelCapabilitySql('account_cost_model', `'${endpoint}'`)
  const routeBindings = endpoint === 'embeddings' || endpoint === 'images'
    ? [groupId, requestedModel]
    : [groupId, requestedModel, endpoint]
  // Keep pricing_policy materialized: inlining its computed billing model into
  // repeated pricing normalization expressions exceeds D1 statement memory.
  return env.DB.prepare(
    `WITH active_channel AS (
       SELECT c.id, c.control_version, c.billing_model_source, c.restrict_models,
              gm.group_id,
              resolved.platform AS target_platform,
              COALESCE(gm.upstream_name_override, resolved.upstream_name) AS upstream_model
         FROM channel_groups cg
         JOIN channels c ON c.id = cg.channel_id
         JOIN "groups" g ON g.id = cg.group_id
         JOIN group_models gm ON gm.group_id = g.id
         JOIN models resolved ON resolved.id = gm.model_id
         JOIN model_prices price ON price.group_id = gm.group_id AND price.model_id = gm.model_id
        WHERE cg.group_id = ? AND resolved.public_name = ?
          AND c.status = 'active' AND g.enabled = 1
          AND gm.enabled = 1 AND resolved.enabled = 1 AND price.active = 1
          AND (resolved.platform = g.platform OR g.platform = 'composite')
          AND ${modelCapability}
        ORDER BY gm.sort_order ASC, resolved.platform ASC, resolved.id ASC
        LIMIT 1
     ), matched_mapping AS (
       SELECT mapping.channel_id, mapping.source_pattern, mapping.target_pattern,
              mapping.source_is_wildcard, mapping.target_is_wildcard
         FROM channel_model_mappings mapping
         JOIN active_channel channel ON channel.id = mapping.channel_id
        WHERE mapping.platform = channel.target_platform AND (
          (mapping.source_is_wildcard = 0 AND mapping.source_pattern = ? COLLATE NOCASE)
          OR
          (mapping.source_is_wildcard = 1 AND
            substr(lower(?), 1, length(mapping.source_pattern) - 1) =
              lower(substr(mapping.source_pattern, 1, length(mapping.source_pattern) - 1)))
        )
        ORDER BY mapping.source_is_wildcard ASC, mapping.sort_order ASC,
                 length(mapping.source_pattern) DESC, mapping.source_pattern ASC
        LIMIT 1
     ), route_policy AS (
       SELECT channel.group_id, channel.target_platform,
              CASE WHEN mapping.target_is_wildcard = 1
                THEN substr(mapping.target_pattern, 1, length(mapping.target_pattern) - 1) ||
                     CASE WHEN mapping.source_is_wildcard = 1
                       THEN substr(?, length(mapping.source_pattern))
                       ELSE ''
                     END
                ELSE mapping.target_pattern
              END AS expanded_target
         FROM active_channel channel
         LEFT JOIN matched_mapping mapping ON mapping.channel_id = channel.id
     ), pricing_policy AS MATERIALIZED (
       SELECT target.*,
              CASE channel.billing_model_source
                WHEN 'requested' THEN ?
                WHEN 'upstream' THEN COALESCE(target.expanded_target, channel.upstream_model)
                ELSE COALESCE(target.expanded_target, ?)
              END AS billing_model
         FROM route_policy target
         JOIN active_channel channel ON 1 = 1
     ), account_cost_matches AS (
       SELECT account_cost_price.id AS price_id,
              account_cost_price.version AS price_version,
              account_cost_price.input_micros_per_million,
              account_cost_price.output_micros_per_million,
              account_cost_price.cache_read_micros_per_million,
              account_cost_price.per_request_micros,
              COUNT(*) OVER () AS match_count
         FROM pricing_policy target
         JOIN group_models account_cost_group_model
           ON account_cost_group_model.group_id = target.group_id
         JOIN models account_cost_model
           ON account_cost_model.id = account_cost_group_model.model_id
          AND account_cost_model.platform = target.target_platform
         JOIN model_prices account_cost_price
           ON account_cost_price.group_id = account_cost_group_model.group_id
          AND account_cost_price.model_id = account_cost_group_model.model_id
        WHERE account_cost_group_model.enabled = 1
          AND account_cost_model.enabled = 1
          AND account_cost_price.active = 1
          AND target.expanded_target IS NOT NULL AND target.expanded_target <> ''
          AND ${accountCostModelCapability}
          AND (
            account_cost_model.public_name = target.expanded_target COLLATE NOCASE OR
            COALESCE(account_cost_group_model.upstream_name_override, account_cost_model.upstream_name) =
              target.expanded_target COLLATE NOCASE
          )
     ), pricing_pattern_matches AS (
       SELECT pricing.id AS pricing_id,
              pricing.control_version AS pricing_control_version,
              pricing.billing_mode AS pricing_billing_mode,
              pricing.input_micros_per_million AS pricing_input_micros_per_million,
              pricing.output_micros_per_million AS pricing_output_micros_per_million,
              pricing.cache_read_micros_per_million AS pricing_cache_read_micros_per_million,
              pricing.per_request_micros AS pricing_per_request_micros,
              pricing.fast_multiplier_ppm AS pricing_fast_multiplier_ppm,
              pricing.flex_multiplier_ppm AS pricing_flex_multiplier_ppm,
              pricing.time_pricing_json AS pricing_time_pricing_json,
              allowed.model_pattern AS pricing_model_pattern,
              ${channelPricingMatchPhaseSql('target.billing_model')} AS match_phase,
              DENSE_RANK() OVER (
                ORDER BY ${channelPricingMatchPhaseSql('target.billing_model')} ASC,
                         allowed.is_wildcard ASC,
                         CASE WHEN allowed.is_wildcard = 1
                           THEN length(allowed.model_pattern) ELSE 0 END DESC
              ) AS specificity_rank
         FROM pricing_policy target
         JOIN active_channel channel ON 1 = 1
         JOIN channel_model_pricing pricing
           ON pricing.channel_id = channel.id AND pricing.platform = target.target_platform
         JOIN channel_pricing_models allowed ON allowed.pricing_id = pricing.id
        WHERE ${channelPricingMatchPhaseSql('target.billing_model')} IS NOT NULL
     ), best_pricing AS (
       SELECT matched.*, COUNT(*) OVER () AS pricing_match_count
         FROM pricing_pattern_matches matched
        WHERE matched.specificity_rank = 1
     )
     SELECT channel.id AS channel_id, channel.billing_model_source,
            channel.control_version AS channel_control_version, channel.restrict_models,
            mapping.source_pattern, mapping.target_pattern,
            mapping.source_is_wildcard, mapping.target_is_wildcard,
            policy.billing_model,
            COALESCE(pricing.pricing_match_count, 0) AS pricing_match_count,
            pricing.pricing_id, pricing.pricing_control_version,
            pricing.pricing_billing_mode, pricing.pricing_model_pattern,
            pricing.pricing_input_micros_per_million,
            pricing.pricing_output_micros_per_million,
            pricing.pricing_cache_read_micros_per_million,
            pricing.pricing_per_request_micros,
            pricing.pricing_fast_multiplier_ppm,
            pricing.pricing_flex_multiplier_ppm,
            pricing.pricing_time_pricing_json,
            CASE WHEN pricing.pricing_id IS NULL THEN NULL ELSE (
              SELECT json_group_array(json_object(
                'id', interval.id,
                'min_tokens', interval.min_tokens,
                'max_tokens', interval.max_tokens,
                'tier_label', interval.tier_label,
                'input_micros_per_million', interval.input_micros_per_million,
                'output_micros_per_million', interval.output_micros_per_million,
                'cache_read_micros_per_million', interval.cache_read_micros_per_million,
                'input_multiplier_ppm', interval.input_multiplier_ppm,
                'output_multiplier_ppm', interval.output_multiplier_ppm,
                'cache_read_multiplier_ppm', interval.cache_read_multiplier_ppm,
                'per_request_micros', interval.per_request_micros
              ))
                FROM (
                  SELECT * FROM channel_pricing_intervals bounded
                   WHERE bounded.pricing_id = pricing.pricing_id
                   ORDER BY bounded.sort_order ASC, bounded.id ASC
                   LIMIT 101
                ) interval
            ) END AS pricing_intervals_json,
            account_cost.match_count AS account_cost_base_match_count,
            CASE WHEN account_cost.match_count = 1 THEN account_cost.price_id END
              AS account_cost_base_price_id,
            CASE WHEN account_cost.match_count = 1 THEN account_cost.price_version END
              AS account_cost_base_price_version,
            CASE WHEN account_cost.match_count = 1 THEN account_cost.input_micros_per_million END
              AS account_cost_base_input_micros_per_million,
            CASE WHEN account_cost.match_count = 1 THEN account_cost.output_micros_per_million END
              AS account_cost_base_output_micros_per_million,
            CASE WHEN account_cost.match_count = 1 THEN account_cost.cache_read_micros_per_million END
              AS account_cost_base_cache_read_micros_per_million,
            CASE WHEN account_cost.match_count = 1 THEN account_cost.per_request_micros END
              AS account_cost_base_per_request_micros
       FROM active_channel channel
      LEFT JOIN matched_mapping mapping ON mapping.channel_id = channel.id
      JOIN pricing_policy policy ON 1 = 1
      LEFT JOIN account_cost_matches account_cost ON 1 = 1
      LEFT JOIN best_pricing pricing ON 1 = 1
      LIMIT 1`,
  )
    .bind(
      ...routeBindings,
      requestedModel,
      requestedModel,
      requestedModel,
      requestedModel,
      requestedModel,
    )
}

function applyChannelModelPolicy(
  requestedModel: string,
  model: ModelRoute,
  row: ChannelModelPolicyRow | undefined,
): ModelRoute {
  // An unlinked or inactive channel deliberately preserves pre-channel routing.
  if (row === undefined) return model
  assertSupportedChannelBillingSource(row.billing_model_source)

  const mapped = row.target_pattern !== null && row.target_pattern !== ''
  if (!mapped) {
    if (row.restrict_models === 1 && row.pricing_match_count === 0) {
      throw new GatewayError(
        404,
        'model_not_found',
        `Model '${requestedModel}' is not available`,
        'invalid_request_error',
      )
    }
    return model
  }

  return {
    ...model,
    upstream_name: expandChannelMappingTarget(requestedModel, row),
    ...(row.account_cost_base_match_count === 1 &&
      row.account_cost_base_price_id !== null &&
      row.account_cost_base_price_version !== null &&
      row.account_cost_base_input_micros_per_million !== null &&
      row.account_cost_base_output_micros_per_million !== null &&
      row.account_cost_base_cache_read_micros_per_million !== null &&
      row.account_cost_base_per_request_micros !== null
      ? {
          account_cost_base_price_id: row.account_cost_base_price_id,
          account_cost_base_price_version: row.account_cost_base_price_version,
          account_cost_base_input_micros_per_million:
            row.account_cost_base_input_micros_per_million,
          account_cost_base_output_micros_per_million:
            row.account_cost_base_output_micros_per_million,
          account_cost_base_cache_read_micros_per_million:
            row.account_cost_base_cache_read_micros_per_million,
          account_cost_base_per_request_micros: row.account_cost_base_per_request_micros,
        }
      : {}),
  }
}

function expandChannelMappingTarget(
  requestedModel: string,
  row: Pick<ChannelModelPolicyRow,
    'source_pattern' | 'target_pattern' | 'source_is_wildcard' | 'target_is_wildcard'>,
): string {
  const target = row.target_pattern!
  if (row.target_is_wildcard !== 1) return target
  const sourcePrefixLength = row.source_is_wildcard === 1
    ? row.source_pattern!.length - 1
    : requestedModel.length
  return `${target.slice(0, -1)}${requestedModel.slice(sourcePrefixLength)}`
}

function accountCandidatesStatement(
  env: Env,
  groupId: string,
  publicName: string,
  modelEndpoint: GatewayEndpoint,
  capabilityColumn: 'am.chat_completions' | 'am.responses' | 'am.embeddings' | 'am.image_generation',
  platformConstraint?: 'openai' | 'openai_or_codex',
  compositePlatform?: string | null,
): D1PreparedStatement {
  const platformPredicate = platformConstraint === 'openai'
    ? "AND a.platform IN ('openai', 'grok', 'antigravity')"
    : platformConstraint === 'openai_or_codex'
      ? "AND a.platform IN ('openai', 'codex', 'grok', 'antigravity')"
      : ''
  const modelCapability = modelEndpoint === 'embeddings'
    ? 'm.embeddings = 1'
    : modelEndpoint === 'images'
      ? 'm.image_generation = 1'
      : textModelCapabilitySql()
  const modelBindings = modelEndpoint === 'embeddings' || modelEndpoint === 'images'
    ? [groupId, publicName, compositePlatform ?? null, compositePlatform ?? null]
    : [groupId, publicName, compositePlatform ?? null, compositePlatform ?? null, modelEndpoint]
  return env.DB.prepare(
    `WITH resolved_model AS (
       SELECT m.id AS model_id, m.platform
         FROM group_models AS gm
         JOIN "groups" g ON g.id = gm.group_id
         JOIN models m ON m.id = gm.model_id
         JOIN model_prices p ON p.group_id = gm.group_id AND p.model_id = gm.model_id
        WHERE gm.group_id = ? AND m.public_name = ?
          AND gm.enabled = 1 AND m.enabled = 1 AND p.active = 1
          AND g.enabled = 1
          AND (m.platform = g.platform OR g.platform = 'composite')
          AND (? IS NULL OR m.platform = ?)
          AND ${modelCapability}
        ORDER BY gm.sort_order ASC, m.platform ASC, m.id ASC
        LIMIT 1
     )
     SELECT a.id AS account_id, a.platform, a.protocol, a.auth_scheme,
            a.image_adapter, a.credential_kind,
            a.provider_config_json, a.ui_config_json, a.base_url, a.max_concurrency, a.billing_rate_multiplier_ppm,
            CASE WHEN json_extract(a.ui_config_json, '$.extra.upstream_billing_probe.identity.credential_ref') = a.credential_ref
                   AND json_extract(a.ui_config_json, '$.extra.upstream_billing_probe.identity.base_url') = a.base_url
                   AND json_extract(a.ui_config_json, '$.extra.upstream_billing_probe.identity.platform') = a.platform
                 THEN json_extract(a.ui_config_json, '$.extra.upstream_billing_probe') END AS upstream_billing_probe_json,
            CASE WHEN json_extract(settings.public_json, '$.openai_advanced_scheduler_subscription_priority_enabled') = 1
                    AND a.platform = 'openai' AND a.credential_kind = 'oauth'
                    AND lower(trim(COALESCE(json_extract(a.provider_config_json, '$.subscription_plan'), ''))) NOT IN ('', 'free', 'abnormal')
                 THEN ag.priority + 1000 ELSE ag.priority + 3001 END AS priority, ag.weight, a.config_version,
            a.recovery_revision,
            revision.revision AS config_revision, resolved.model_id
       FROM account_groups ag
       JOIN accounts a ON a.id = ag.account_id
       JOIN resolved_model resolved ON resolved.platform = a.platform
       LEFT JOIN account_models am ON am.account_id = a.id AND am.model_id = resolved.model_id
       JOIN "groups" g ON g.id = ag.group_id
       CROSS JOIN gateway_config_revision revision
       CROSS JOIN system_settings settings
      WHERE ag.group_id = ? AND a.enabled = 1 AND COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1) = 1 AND ${accountNotExpiredSql()} AND ${accountNotRateLimitedSql()} AND ${accountNotTemporarilyBlockedSql()} AND ${accountGroupPrivacyAllowedSql()} AND a.base_url IS NOT NULL
        AND a.health_status <> 'unhealthy'
        AND (g.platform = a.platform OR g.platform = 'composite')
        AND (${capabilityColumn} = 1 OR json_extract(a.ui_config_json, '$.original_model_routing') = 1)
        ${platformPredicate}
      ORDER BY priority ASC, a.id ASC`,
  )
    .bind(...modelBindings, groupId)
}

export async function getAccountCredential(
  env: Env,
  groupId: string,
  modelId: string,
  endpoint: GatewayEndpoint,
  accountId: string,
  requestedModel?: string,
): Promise<AccountCredential> {
  const capabilityColumn = accountCapabilityColumn(endpoint)
  const row = await env.DB.prepare(
    `SELECT a.id AS account_id, a.platform, a.protocol, a.base_url, a.auth_scheme,
            json_extract(a.ui_config_json, '$.proxy_id') AS proxy_id,
            json_extract(a.ui_config_json, '$.extra.codex_cli_only') AS codex_cli_only,
            json_extract(a.ui_config_json, '$.extra.codex_cli_only_allow_app_server') AS codex_cli_only_allow_app_server,
            a.image_adapter, a.credential_kind,
            a.provider_config_json, a.ui_config_json, a.config_version, a.control_version, m.upstream_name AS policy_model,
            s.id AS secret_id, s.key_version, s.nonce_b64, s.ciphertext_b64
       FROM accounts a
       JOIN account_groups ag ON ag.account_id = a.id
       JOIN "groups" g ON g.id = ag.group_id
       JOIN models m ON m.platform = a.platform
       LEFT JOIN account_models am ON am.model_id = m.id AND am.account_id = a.id
       JOIN account_secrets s ON s.id = a.credential_ref AND s.account_id = a.id
      WHERE a.id = ? AND ag.group_id = ? AND m.id = ?
        AND (g.platform = a.platform OR g.platform = 'composite')
        AND (${capabilityColumn} = 1 OR json_extract(a.ui_config_json, '$.original_model_routing') = 1) AND g.enabled = 1 AND a.enabled = 1 AND COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1) = 1 AND ${accountNotExpiredSql()} AND ${accountNotRateLimitedSql()} AND ${accountNotTemporarilyBlockedSql()} AND ${accountGroupPrivacyAllowedSql()}
        AND a.health_status <> 'unhealthy'
        AND a.base_url IS NOT NULL
      LIMIT 1`,
  )
    .bind(accountId, groupId, modelId)
    .first<AccountCredentialRow & { ui_config_json?: string; policy_model?: string; config_version?: number; control_version?: number }>()
  if (row === null) {
    throw new GatewayError(503, 'credential_unavailable', 'Upstream account credential is unavailable', 'server_error')
  }
  if (!accountOpenAIEndpointAllowed(row, endpoint)) throw new GatewayError(503, 'credential_unavailable', 'Account upstream protocol changed; retry the request', 'server_error')
  const policy = accountModelPolicy(row.ui_config_json, requestedModel ?? row.policy_model ?? '', row.platform, row.credential_kind)
  if (accountModelRateLimited(row.ui_config_json, requestedModel ?? row.policy_model ?? '', row.platform, row.credential_kind)) {
    throw new GatewayError(503, 'credential_unavailable', 'Upstream account is temporarily unavailable for this model', 'server_error')
  }
  if (accountQuotaExceeded(row.ui_config_json, row.credential_kind)) {
    throw new GatewayError(503, 'credential_unavailable', 'Upstream account quota is exhausted', 'server_error')
  }
  if (!policy.allowed) throw new GatewayError(503, 'credential_unavailable', 'Account no longer supports the requested model', 'server_error')
  const uiConfig = row.ui_config_json ? JSON.parse(row.ui_config_json) as { proxy_id?: unknown; extra?: { anthropic_apikey_auth_scheme?: unknown } } : {}
  const proxyId = uiConfig.proxy_id
  return effectiveProviderAccount(env, { ...parseAccountCredential(row), upstream_model_name: policy.upstream || requestedModel || row.policy_model,
    ...(typeof row.config_version === 'number' && typeof row.control_version === 'number' && typeof row.ui_config_json === 'string'
      ? { runtime_snapshot: { config_version: row.config_version, control_version: row.control_version, ui_config_json: row.ui_config_json } } : {}),
    ...(row.platform === 'anthropic' && row.credential_kind === 'api_key' && uiConfig.extra?.anthropic_apikey_auth_scheme === 'authorization_bearer'
      ? { anthropic_auth_scheme: 'authorization_bearer' as const } : {}),
    ...(proxyId == null || proxyId === 0 || proxyId === '0' ? {} : { proxy_id: String(proxyId) }) })
}

export function credentialAad(
  environment: string,
  accountId: string,
  secretId: string,
  keyVersion: number,
): string {
  return `${environment}/${accountId}/${secretId}/${keyVersion}`
}

export function validateBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GatewayError(400, 'invalid_base_url', 'Upstream base_url must be a valid HTTPS URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    url.port !== ''
  ) {
    throw new GatewayError(400, 'invalid_base_url', 'Upstream base_url must be HTTPS on port 443 without credentials, query, or fragment')
  }
  const hostname = url.hostname.toLowerCase()
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.includes(':')
  ) {
    throw new GatewayError(400, 'invalid_base_url', 'Private or local upstream hosts are not allowed')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

function readApiKey(headers: Headers): string {
  const authorization = headers.get('authorization')?.trim() ?? ''
  const alternate = headers.get('x-api-key')?.trim() ?? ''
  const google = headers.get('x-goog-api-key')?.trim() ?? ''
  let bearer = ''
  if (authorization !== '') {
    if (authorization.length > 8_320) {
      throw new GatewayError(401, 'invalid_api_key', 'Invalid API key', 'authentication_error')
    }
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
    if (match === null) {
      throw new GatewayError(401, 'invalid_auth_header', "Authorization header must use the Bearer scheme", 'authentication_error')
    }
    bearer = match[1]
  }
  const credentials = [bearer, alternate, google].filter((value) => value !== '')
  if (new Set(credentials).size > 1) {
    throw new GatewayError(400, 'conflicting_api_keys', 'API key credentials conflict')
  }
  const value = credentials[0] ?? ''
  if (value === '' || value.length > 8_192) {
    throw new GatewayError(401, 'api_key_required', 'API key is required', 'authentication_error')
  }
  return value
}

function modelSelect(includeUserRate = false): string {
  const userRate = includeUserRate ? 'user_rate.rate_multiplier_ppm' : 'NULL'
  return `SELECT revision.revision AS config_revision,
                 m.id AS model_id, m.platform, m.public_name,
                 COALESCE(gm.upstream_name_override, m.upstream_name) AS upstream_name,
                 m.endpoint, m.embeddings, m.image_generation,
                 p.id AS price_id, p.version AS price_version,
                 p.input_micros_per_million, p.output_micros_per_million,
                 p.cache_read_micros_per_million, p.per_request_micros,
                 p.minimum_reservation_micros,
                 p.id AS account_cost_base_price_id,
                 p.version AS account_cost_base_price_version,
                 p.input_micros_per_million AS account_cost_base_input_micros_per_million,
                 p.output_micros_per_million AS account_cost_base_output_micros_per_million,
                 p.cache_read_micros_per_million AS account_cost_base_cache_read_micros_per_million,
                 p.per_request_micros AS account_cost_base_per_request_micros,
                 g.rate_multiplier_ppm AS group_rate_multiplier_ppm,
                 g.ui_config_json,
                 ${userRate} AS user_rate_multiplier_ppm,
                 COALESCE(${userRate}, g.rate_multiplier_ppm) AS rate_multiplier_ppm,
                 gm.max_output_tokens, gm.default_max_output_tokens
            FROM group_models gm
            JOIN "groups" g ON g.id = gm.group_id
            JOIN models m ON m.id = gm.model_id
            JOIN model_prices p ON p.group_id = gm.group_id AND p.model_id = gm.model_id
            ${includeUserRate
              ? `LEFT JOIN user_group_rate_overrides user_rate
                   ON user_rate.group_id = gm.group_id AND user_rate.user_id = ?`
              : ''}
            CROSS JOIN gateway_config_revision revision`
}

interface ProviderAccountProjection {
  platform: string
  protocol: string
  auth_scheme: string
  image_adapter: string
  credential_kind: string
  provider_config_json: string
}

type AccountCandidateRow = Omit<AccountCandidate, 'platform' | 'protocol' | 'auth_scheme' | 'provider_config'> &
  ProviderAccountProjection

type AccountCredentialRow = Omit<AccountCredential, 'platform' | 'protocol' | 'auth_scheme' | 'provider_config'> &
  ProviderAccountProjection

function parseAccountCandidate(value: unknown): AccountCandidate {
  const row = value as AccountCandidateRow
  const { provider_config_json: _providerConfigJson, ui_config_json: _uiConfig, ...candidate } = row as AccountCandidateRow & { ui_config_json?: string }
  const factor = _uiConfig ? (JSON.parse(_uiConfig) as { load_factor?: unknown }).load_factor : undefined
  const loadFactor = typeof factor === 'number' && Number.isSafeInteger(factor) && factor > 0 ? factor : undefined
  return { ...candidate, ...(loadFactor === undefined ? {} : { load_factor: loadFactor }), ...parseProviderAccountProjection(row) }
}

function parseAccountCredential(row: AccountCredentialRow): AccountCredential {
  const { provider_config_json: _providerConfigJson, ...credential } = row
  return { ...credential, ...parseProviderAccountProjection(row) }
}

function parseProviderAccountProjection(row: ProviderAccountProjection): {
  platform: ProviderPlatform
  protocol: ProviderProtocol
  auth_scheme: ProviderAuthScheme
  image_adapter: AccountImageAdapter
  credential_kind: AccountCredentialKind
  provider_config: ProviderConfig
} {
  if (!isProviderPlatform(row.platform)) return invalidProviderAccount()
  const expected = row.platform
  const valid = row.protocol === (expected === 'grok' ? 'openai' : expected === 'antigravity' ? 'gemini' : expected) && (
    ((expected === 'openai' || expected === 'grok' || expected === 'antigravity') && row.auth_scheme === 'bearer') ||
    (expected === 'anthropic' && row.auth_scheme === 'x-api-key') ||
    (expected === 'gemini' && row.auth_scheme === 'x-goog-api-key') ||
    (expected === 'codex' && row.auth_scheme === 'bearer')
  )
  if (!valid) return invalidProviderAccount()
  if (row.image_adapter !== 'direct_images' && row.image_adapter !== 'responses_image_tool') {
    return invalidProviderAccount()
  }
  if (
    row.credential_kind !== 'api_key' &&
    row.credential_kind !== 'oauth' &&
    row.credential_kind !== 'setup_token'
  ) {
    return invalidProviderAccount()
  }
  let config: unknown
  try {
    config = JSON.parse(row.provider_config_json)
  } catch {
    return invalidProviderAccount()
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return invalidProviderAccount()
  }
  return {
    platform: row.platform,
    protocol: row.protocol as ProviderProtocol,
    auth_scheme: row.auth_scheme as ProviderAuthScheme,
    image_adapter: row.image_adapter,
    credential_kind: row.credential_kind,
    provider_config: config as ProviderConfig,
  }
}

function invalidProviderAccount(): never {
  throw new GatewayError(
    500,
    'invalid_provider_account',
    'Upstream provider account configuration is invalid',
    'server_error',
  )
}

function accountCapabilityColumn(
  endpoint: GatewayEndpoint,
): 'am.chat_completions' | 'am.responses' | 'am.embeddings' | 'am.image_generation' {
  switch (endpoint) {
    case 'chat_completions': return 'am.chat_completions'
    case 'responses': return 'am.responses'
    case 'embeddings': return 'am.embeddings'
    case 'images': return 'am.image_generation'
  }
}
