import type { Env } from '../env'
import type { PlatformEvent, UsageSettledPayload } from '../env'
import { GatewayError } from './errors'
import { sha256Hex } from './crypto'
import type {
  AccountCandidate,
  ApiKeyMonetaryUsageSnapshot,
  ApiKeyMonetaryWindowSnapshot,
  GatewayEndpoint,
  GatewayPrincipal,
  PlatformQuotaPolicy,
  PlatformQuotaUsageSnapshot,
} from './types'

export const STATE_SCHEMA_VERSION = 1
export const RESERVATION_TTL_MS = 10 * 60_000
export const LEASE_TTL_MS = 60_000
export const RENEW_AFTER_MS = 20_000
export const POOL_AFFINITY_TTL_MS = 60 * 60_000

export interface ApiKeyAdmissionLease {
  stub: DurableObjectStub
  requestId: string
}

interface StateErrorBody {
  error?: { code?: string; message?: string }
}

interface PoolLeaseBody {
  lease?: { account_id?: string; status?: string }
}

interface AdmissionLeaseBody {
  admitted?: boolean
  lease?: { request_id?: string; status?: string }
}

export async function acquireApiKeyAdmission(
  env: Env,
  principal: GatewayPrincipal,
  requestId: string,
): Promise<ApiKeyAdmissionLease | null> {
  // Fixtures authored before migration 0022 have no projection discriminator.
  // Real D1 rows always return version 1, including when every limit is zero.
  if (principal.limit_config_version !== 1) return null
  if (env.API_KEY_LIMIT_STATE === undefined) {
    throw new GatewayError(503, 'api_key_limits_unavailable', 'API key admission state is unavailable', 'server_error')
  }
  const stub = apiKeyLimitStub(env, principal.user_id)
  let response: Response
  try {
    response = await post(stub, '/admit', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      api_key_id: principal.api_key_id,
      group_id: principal.group_id,
      concurrency_limit: principal.concurrency_limit,
      user_rpm_limit: principal.user_rpm_limit,
      group_rpm_limit: principal.group_rpm_limit,
      lease_ttl_ms: LEASE_TTL_MS,
    })
  } catch {
    throw new GatewayError(503, 'api_key_limits_unavailable', 'API key admission state is unavailable', 'server_error')
  }
  const accepted = await requireStateOk(Promise.resolve(response))
  let body: AdmissionLeaseBody
  try {
    body = await accepted.json() as AdmissionLeaseBody
  } catch {
    throw new GatewayError(503, 'api_key_limits_unavailable', 'API key admission state returned an invalid response', 'server_error')
  }
  if (
    body.admitted !== true ||
    body.lease?.request_id !== requestId ||
    body.lease.status !== 'active'
  ) {
    throw new GatewayError(503, 'api_key_limits_unavailable', 'API key admission state returned an invalid lease', 'server_error')
  }
  return { stub, requestId }
}

export async function renewApiKeyAdmission(
  lease: ApiKeyAdmissionLease | null,
  renewalSequence: number,
): Promise<void> {
  if (lease === null) return
  await requireStateOk(post(lease.stub, '/renew', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: lease.requestId,
    renewal_sequence: renewalSequence,
    lease_ttl_ms: LEASE_TTL_MS,
  }))
}

export async function releaseApiKeyAdmission(
  lease: ApiKeyAdmissionLease | null,
): Promise<void> {
  if (lease === null) return
  await requireStateOk(post(lease.stub, '/release', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: lease.requestId,
  }))
}

export interface BillingReference {
  user_id: string
  billing: { type: 'balance' } | { type: 'subscription'; subscription_id: string }
}

export interface ApiKeyMonetaryReference {
  user_id: string
  api_key_id: string
}

export interface PlatformQuotaReference {
  user_id: string
  platform_quota?: Pick<PlatformQuotaPolicy, 'platform'> | null
  billing: BillingReference['billing']
}

export async function preparePlatformQuotaReservation(
  env: Env,
  principal: GatewayPrincipal,
  requestId: string,
  amountMicros: number,
): Promise<void> {
  const policy = principal.platform_quota
  // Platform limits are a user balance policy. Subscription products own
  // their independent windows and must not consume the standard allowance.
  if (principal.billing.type !== 'balance' || policy == null) return
  const stub = apiKeyLimitStub(env, principal.user_id)
  await requireStateOk(post(stub, '/platform-quota/configure', {
    schema_version: STATE_SCHEMA_VERSION,
    user_id: principal.user_id,
    platform: policy.platform,
    enabled: true,
    control_version: policy.control_version,
    daily_limit_micros: policy.daily_limit_micros,
    weekly_limit_micros: policy.weekly_limit_micros,
    monthly_limit_micros: policy.monthly_limit_micros,
    daily_used_micros: policy.daily_used_micros,
    weekly_used_micros: policy.weekly_used_micros,
    monthly_used_micros: policy.monthly_used_micros,
    daily_window_start_ms: policy.daily_window_start_ms,
    weekly_window_start_ms: policy.weekly_window_start_ms,
    monthly_window_start_ms: policy.monthly_window_start_ms,
    daily_reset_epoch: policy.daily_reset_epoch,
    weekly_reset_epoch: policy.weekly_reset_epoch,
    monthly_reset_epoch: policy.monthly_reset_epoch,
  }))
  await requireStateOk(post(stub, '/platform-quota/reserve', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    user_id: principal.user_id,
    platform: policy.platform,
    control_version: policy.control_version,
    amount_micros: amountMicros,
    reservation_ttl_ms: RESERVATION_TTL_MS,
  }))
}

export async function ensurePlatformQuotaReservation(
  env: Env,
  reference: PlatformQuotaReference,
  requestId: string,
  targetAmountMicros: number,
): Promise<void> {
  const policy = reference.platform_quota
  if (reference.billing.type !== 'balance' || policy == null) return
  await requireStateOk(post(apiKeyLimitStub(env, reference.user_id), '/platform-quota/ensure', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    user_id: reference.user_id,
    platform: policy.platform,
    target_amount_micros: targetAmountMicros,
  }))
}

export async function settlePlatformQuotaReservation(
  env: Env,
  reference: PlatformQuotaReference,
  requestId: string,
  amountMicros: number,
): Promise<PlatformQuotaUsageSnapshot | null> {
  const policy = reference.platform_quota
  if (reference.billing.type !== 'balance' || policy == null) return null
  const response = await requireStateOk(post(
    apiKeyLimitStub(env, reference.user_id),
    '/platform-quota/settle',
    {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      user_id: reference.user_id,
      platform: policy.platform,
      amount_micros: amountMicros,
    },
  ))
  let body: { usage?: unknown }
  try {
    body = await response.json() as { usage?: unknown }
  } catch {
    throw invalidPlatformQuotaUsage()
  }
  return parsePlatformQuotaUsage(body.usage, reference.user_id, policy.platform)
}

export async function renewPlatformQuotaReservation(
  env: Env,
  reference: PlatformQuotaReference,
  requestId: string,
  renewalSequence: number,
): Promise<void> {
  const policy = reference.platform_quota
  if (reference.billing.type !== 'balance' || policy == null) return
  await requireStateOk(post(apiKeyLimitStub(env, reference.user_id), '/platform-quota/renew', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    user_id: reference.user_id,
    platform: policy.platform,
    renewal_sequence: renewalSequence,
    reservation_ttl_ms: RESERVATION_TTL_MS,
  }))
}

export async function cancelPlatformQuotaReservation(
  env: Env,
  reference: PlatformQuotaReference,
  requestId: string,
): Promise<void> {
  const policy = reference.platform_quota
  if (reference.billing.type !== 'balance' || policy == null) return
  const response = await post(apiKeyLimitStub(env, reference.user_id), '/platform-quota/cancel', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    user_id: reference.user_id,
    platform: policy.platform,
  })
  if (!response.ok && (await stateErrorCode(response)) !== 'platform_quota_invalid_transition') {
    throw await stateResponseError(response)
  }
}

export async function projectPlatformQuotaUsage(
  env: Env,
  snapshot: PlatformQuotaUsageSnapshot,
): Promise<void> {
  const now = Date.now()
  const projection = (kind: 'daily' | 'weekly' | 'monthly') => {
    const window = snapshot[kind]
    return env.DB.prepare(
      `UPDATE user_platform_quotas
          SET ${kind}_used_micros = CASE
                WHEN ${kind}_reset_epoch < ? THEN ?
                WHEN ${kind}_reset_epoch = ?
                 AND (${kind}_window_start_ms IS NULL OR ${kind}_window_start_ms < ?) THEN ?
                WHEN ${kind}_reset_epoch = ? AND ${kind}_window_start_ms = ?
                  THEN MAX(${kind}_used_micros, ?)
                ELSE ${kind}_used_micros END,
              ${kind}_window_start_ms = CASE
                WHEN ${kind}_reset_epoch < ? THEN ?
                WHEN ${kind}_reset_epoch = ?
                 AND (${kind}_window_start_ms IS NULL OR ${kind}_window_start_ms < ?) THEN ?
                ELSE ${kind}_window_start_ms END,
              ${kind}_reset_epoch = MAX(${kind}_reset_epoch, ?),
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE user_id = ? AND platform = ? AND ${kind}_reset_epoch <= ?`,
    ).bind(
      window.reset_epoch, window.settled_micros,
      window.reset_epoch, window.window_start_ms, window.settled_micros,
      window.reset_epoch, window.window_start_ms, window.settled_micros,
      window.reset_epoch, window.window_start_ms,
      window.reset_epoch, window.window_start_ms, window.window_start_ms,
      window.reset_epoch, now, snapshot.user_id, snapshot.platform, window.reset_epoch,
    )
  }
  await env.DB.batch([projection('daily'), projection('weekly'), projection('monthly')])
}

export async function prepareApiKeyMonetaryReservation(
  env: Env,
  principal: GatewayPrincipal,
  requestId: string,
  amountMicros: number,
): Promise<void> {
  const stub = apiKeyLimitStub(env, principal.user_id)
  const policy = principal.api_key_monetary
  await requireStateOk(post(stub, '/monetary/configure', {
    schema_version: STATE_SCHEMA_VERSION,
    api_key_id: principal.api_key_id,
    control_version: policy.control_version,
    total_limit_micros: policy.quota_micros,
    limit_5h_micros: policy.rate_limit_5h_micros,
    limit_1d_micros: policy.rate_limit_1d_micros,
    limit_7d_micros: policy.rate_limit_7d_micros,
    total_used_micros: policy.quota_used_micros,
    usage_5h_micros: policy.usage_5h_micros,
    usage_1d_micros: policy.usage_1d_micros,
    usage_7d_micros: policy.usage_7d_micros,
    window_5h_start_ms: policy.window_5h_start_ms,
    window_1d_start_ms: policy.window_1d_start_ms,
    window_7d_start_ms: policy.window_7d_start_ms,
    quota_reset_epoch: policy.quota_reset_epoch,
    rate_limit_reset_epoch: policy.rate_limit_reset_epoch,
  }))
  await requireStateOk(post(stub, '/monetary/reserve', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    api_key_id: principal.api_key_id,
    control_version: policy.control_version,
    amount_micros: amountMicros,
    reservation_ttl_ms: RESERVATION_TTL_MS,
  }))
}

export async function ensureApiKeyMonetaryReservation(
  env: Env,
  reference: ApiKeyMonetaryReference,
  requestId: string,
  targetAmountMicros: number,
): Promise<void> {
  await requireStateOk(post(apiKeyLimitStub(env, reference.user_id), '/monetary/ensure', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    api_key_id: reference.api_key_id,
    target_amount_micros: targetAmountMicros,
  }))
}

export async function renewApiKeyMonetaryReservation(
  env: Env,
  reference: ApiKeyMonetaryReference,
  requestId: string,
  renewalSequence: number,
): Promise<void> {
  await requireStateOk(post(apiKeyLimitStub(env, reference.user_id), '/monetary/renew', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    api_key_id: reference.api_key_id,
    renewal_sequence: renewalSequence,
    reservation_ttl_ms: RESERVATION_TTL_MS,
  }))
}

/** Settles only the API-key Durable Object. D1 projection is a separate recovery stage. */
export async function settleApiKeyMonetaryReservation(
  env: Env,
  reference: ApiKeyMonetaryReference,
  requestId: string,
  amountMicros: number,
): Promise<ApiKeyMonetaryUsageSnapshot> {
  const response = await requireStateOk(post(
    apiKeyLimitStub(env, reference.user_id),
    '/monetary/settle',
    {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      api_key_id: reference.api_key_id,
      amount_micros: amountMicros,
    },
  ))
  let body: { usage?: unknown }
  try {
    body = await response.json() as { usage?: unknown }
  } catch {
    throw new GatewayError(503, 'invalid_api_key_monetary_state', 'API key monetary state returned invalid usage', 'server_error')
  }
  return parseApiKeyMonetaryUsage(body.usage, reference.api_key_id)
}

/** Monotonically projects an authoritative DO snapshot without crossing an admin reset epoch. */
export async function projectApiKeyMonetaryUsage(
  env: Env,
  snapshot: ApiKeyMonetaryUsageSnapshot,
): Promise<void> {
  const windows = Object.fromEntries(snapshot.windows.map((window) => [window.kind, window])) as Record<
    ApiKeyMonetaryWindowSnapshot['kind'],
    ApiKeyMonetaryWindowSnapshot
  >
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE api_keys
          SET quota_used_micros = CASE
                WHEN quota_reset_epoch < ? THEN ?
                WHEN quota_reset_epoch = ? THEN MAX(quota_used_micros, ?)
                ELSE quota_used_micros END,
              quota_reset_epoch = MAX(quota_reset_epoch, ?),
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND quota_reset_epoch <= ?`,
    ).bind(
      snapshot.quota_reset_epoch,
      snapshot.total_settled_micros,
      snapshot.quota_reset_epoch,
      snapshot.total_settled_micros,
      snapshot.quota_reset_epoch,
      now,
      snapshot.api_key_id,
      snapshot.quota_reset_epoch,
    ),
    env.DB.prepare(
      `UPDATE api_keys
          SET usage_5h_micros = ${windowUsageProjection('5h')},
              window_5h_start_ms = ${windowStartProjection('5h')},
              usage_1d_micros = ${windowUsageProjection('1d')},
              window_1d_start_ms = ${windowStartProjection('1d')},
              usage_7d_micros = ${windowUsageProjection('7d')},
              window_7d_start_ms = ${windowStartProjection('7d')},
              rate_limit_reset_epoch = MAX(rate_limit_reset_epoch, ?),
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND rate_limit_reset_epoch <= ?`,
    ).bind(
      ...windowProjectionBindings(snapshot.rate_limit_reset_epoch, windows['5h']),
      ...windowProjectionBindings(snapshot.rate_limit_reset_epoch, windows['1d']),
      ...windowProjectionBindings(snapshot.rate_limit_reset_epoch, windows['7d']),
      snapshot.rate_limit_reset_epoch,
      now,
      snapshot.api_key_id,
      snapshot.rate_limit_reset_epoch,
    ),
  ])
}

export async function cancelApiKeyMonetaryReservation(
  env: Env,
  reference: ApiKeyMonetaryReference,
  requestId: string,
): Promise<void> {
  const response = await post(apiKeyLimitStub(env, reference.user_id), '/monetary/cancel', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    api_key_id: reference.api_key_id,
  })
  if (!response.ok) {
    const code = await stateErrorCode(response)
    if (code !== 'api_key_monetary_invalid_transition') {
      throw await stateResponseError(response)
    }
  }
}

export async function prepareBillingReservation(
  env: Env,
  principal: GatewayPrincipal,
  requestId: string,
  amountMicros: number,
): Promise<void> {
  if (principal.billing.type === 'subscription') {
    const stub = subscriptionStub(env, principal.billing.subscription_id)
    await requireStateOk(post(stub, '/configure', {
      schema_version: STATE_SCHEMA_VERSION,
      subscription_id: principal.billing.subscription_id,
      user_id: principal.user_id,
      group_id: principal.group_id,
      starts_at_ms: principal.billing.starts_at_ms,
      expires_at_ms: principal.billing.expires_at_ms,
      daily_quota_micros: principal.billing.daily_quota_micros,
      weekly_quota_micros: principal.billing.weekly_quota_micros,
      monthly_quota_micros: principal.billing.monthly_quota_micros,
      daily_used_micros: principal.billing.daily_used_micros,
      weekly_used_micros: principal.billing.weekly_used_micros,
      monthly_used_micros: principal.billing.monthly_used_micros,
      daily_anchor_ms: principal.billing.daily_anchor_ms,
      daily_window_start_ms: principal.billing.daily_window_start_ms,
      weekly_window_start_ms: principal.billing.weekly_window_start_ms,
      monthly_window_start_ms: principal.billing.monthly_window_start_ms,
      quota_reset_epoch: principal.billing.quota_reset_epoch,
      quota_reset_generation: principal.billing.quota_reset_generation,
      control_version: principal.billing.control_version,
    }))
    await requireStateOk(post(stub, '/authorize', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      subscription_id: principal.billing.subscription_id,
      user_id: principal.user_id,
      group_id: principal.group_id,
      api_key_id: principal.api_key_id,
      api_key_auth_version: principal.api_key_auth_version,
    }))
    await requireStateOk(post(stub, '/reserve', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      amount_micros: amountMicros,
      reservation_ttl_ms: RESERVATION_TTL_MS,
    }))
    return
  }
  const stub = userStub(env, principal.user_id)
  const configured = await post(stub, '/configure', {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_id: `d1-user:${principal.user_state_version}`,
    user_id: principal.user_id,
    balance_micros: principal.balance_micros,
    enabled: true,
    initial_state_version: principal.user_state_version,
  })
  if (!configured.ok && (await stateErrorCode(configured)) !== 'user_already_configured') {
    throw await stateResponseError(configured)
  }
  await requireStateOk(
    post(stub, '/authorize', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      user_id: principal.user_id,
      api_key_id: principal.api_key_id,
      api_key_auth_version: principal.api_key_auth_version,
    }),
  )
  await requireStateOk(
    post(stub, '/reserve', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      amount_micros: amountMicros,
      reservation_ttl_ms: RESERVATION_TTL_MS,
    }),
  )
}

export async function renewBillingReservation(
  env: Env,
  billing: BillingReference,
  requestId: string,
  renewalSequence: number,
): Promise<void> {
  await requireStateOk(
    post(billingStub(env, billing), '/renew', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      renewal_sequence: renewalSequence,
      reservation_ttl_ms: RESERVATION_TTL_MS,
    }),
  )
}

export async function ensureBillingReservation(
  env: Env,
  billing: BillingReference,
  requestId: string,
  targetAmountMicros: number,
): Promise<void> {
  await requireStateOk(post(billingStub(env, billing), '/ensure', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
    target_amount_micros: targetAmountMicros,
  }))
}

export async function settleBillingReservation(
  env: Env,
  billing: BillingReference,
  requestId: string,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): Promise<void> {
  const response = await requireStateOk(
    post(billingStub(env, billing), '/settle', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      amount_micros: amountMicros,
      usage_event: usageEvent,
    }),
  )
  if (billing.billing.type === 'subscription') return
  const body = (await response.json()) as {
    profile?: { balance_micros?: number; settled_micros?: number }
  }
  if (
    !Number.isSafeInteger(body.profile?.balance_micros) ||
    !Number.isSafeInteger(body.profile?.settled_micros)
  ) {
    throw new GatewayError(500, 'invalid_user_state', 'User state returned an invalid settlement', 'server_error')
  }
}

export async function cancelBillingReservation(
  env: Env,
  billing: BillingReference,
  requestId: string,
): Promise<void> {
  const response = await post(billingStub(env, billing), '/cancel', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: requestId,
  })
  if (!response.ok) {
    const code = await stateErrorCode(response)
    if (code !== 'invalid_transition' && code !== 'request_not_authorized') {
      throw await stateResponseError(response)
    }
  }
}

export async function syncPoolAccounts(
  env: Env,
  groupId: string,
  modelId: string,
  endpoint: GatewayEndpoint,
  candidates: AccountCandidate[],
): Promise<DurableObjectStub> {
  const stub = poolStub(env, groupId, modelId, endpoint)
  const configRevision = candidates[0]?.config_revision
  if (
    !Number.isSafeInteger(configRevision) ||
    (configRevision as number) <= 0 ||
    candidates.some((account) => account.config_revision !== configRevision)
  ) {
    throw new GatewayError(500, 'invalid_config_revision', 'Routing config revision is invalid', 'server_error')
  }
  await requireStateOk(
    post(stub, '/accounts/sync', {
      schema_version: STATE_SCHEMA_VERSION,
      config_revision: configRevision,
      config_fingerprint: await sha256Hex(JSON.stringify(candidates.map((account) => ({
        account_id: account.account_id,
        max_concurrency: account.max_concurrency,
        load_factor: account.load_factor,
        priority: account.priority,
        weight: account.weight,
        recovery_revision: account.recovery_revision,
      })))),
      accounts: candidates.map((account) => ({
        account_id: account.account_id,
        max_concurrency: account.max_concurrency,
        load_factor: account.load_factor,
        priority: account.priority,
        weight: account.weight,
        recovery_revision: account.recovery_revision,
      })),
    }),
  )
  // Observability must not make a gateway request fail. A missing row simply
  // causes the admin capacity endpoint to report an explicit unknown later.
  await env.DB.prepare(`INSERT INTO pool_state_registry
    (group_id, model_id, endpoint, config_revision, last_synced_at_ms) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id, model_id, endpoint) DO UPDATE SET
      config_revision = excluded.config_revision, last_synced_at_ms = excluded.last_synced_at_ms`
  ).bind(groupId, modelId, endpoint, configRevision, Date.now()).run().catch(() => undefined)
  return stub
}

export async function disablePoolAccount(
  stub: DurableObjectStub,
  accountId: string,
): Promise<void> {
  await requireStateOk(
    post(stub, '/accounts/upsert', {
      schema_version: STATE_SCHEMA_VERSION,
      account_id: accountId,
      enabled: false,
      max_concurrency: 1,
    }),
  )
}

export async function reservePoolAccount(
  stub: DurableObjectStub,
  leaseId: string,
  affinityKey?: string,
  excludedAccountIds?: readonly string[],
): Promise<string> {
  const response = await requireStateOk(
    post(stub, '/reserve', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: leaseId,
      lease_ttl_ms: LEASE_TTL_MS,
      ...(excludedAccountIds === undefined || excludedAccountIds.length === 0
        ? {}
        : { excluded_account_ids: excludedAccountIds }),
      ...(affinityKey === undefined
        ? {}
        : {
            affinity_key: affinityKey,
            affinity_ttl_ms: POOL_AFFINITY_TTL_MS,
          }),
    }),
  )
  const body = (await response.json()) as PoolLeaseBody
  const accountId = body.lease?.account_id
  if (typeof accountId !== 'string' || body.lease?.status !== 'active') {
    throw new GatewayError(500, 'invalid_pool_state', 'Account pool returned an invalid lease', 'server_error')
  }
  return accountId
}

export async function renewPoolLease(
  stub: DurableObjectStub,
  leaseId: string,
  renewalSequence: number,
): Promise<void> {
  await requireStateOk(
    post(stub, '/renew', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: leaseId,
      renewal_sequence: renewalSequence,
      lease_ttl_ms: LEASE_TTL_MS,
    }),
  )
}

export async function releasePoolLease(stub: DurableObjectStub, leaseId: string): Promise<void> {
  const response = await post(stub, '/release', {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: leaseId,
  })
  if (!response.ok && (await stateErrorCode(response)) !== 'lease_not_found') {
    throw await stateResponseError(response)
  }
}

export async function recordPoolFailure(
  stub: DurableObjectStub,
  accountId: string,
  eventId: string,
  cooldownMs: number,
): Promise<void> {
  await requireStateOk(
    post(stub, '/failure', {
      schema_version: STATE_SCHEMA_VERSION,
      event_id: eventId,
      account_id: accountId,
      cooldown_ms: cooldownMs,
    }),
  )
}

function userStub(env: Env, userId: string): DurableObjectStub {
  return env.USER_STATE.get(env.USER_STATE.idFromName(userId))
}

function apiKeyLimitStub(env: Env, userId: string): DurableObjectStub {
  if (env.API_KEY_LIMIT_STATE === undefined) {
    throw new GatewayError(503, 'api_key_limits_unavailable', 'API key limit state is unavailable', 'server_error')
  }
  return env.API_KEY_LIMIT_STATE.get(env.API_KEY_LIMIT_STATE.idFromName(`user:${userId}`))
}

function subscriptionStub(env: Env, subscriptionId: string): DurableObjectStub {
  if (env.SUBSCRIPTION_STATE === undefined) {
    throw new GatewayError(503, 'subscription_billing_unavailable', 'Subscription billing state is unavailable', 'server_error')
  }
  return env.SUBSCRIPTION_STATE.get(env.SUBSCRIPTION_STATE.idFromName(subscriptionId))
}

function billingStub(env: Env, reference: BillingReference): DurableObjectStub {
  return reference.billing.type === 'subscription'
    ? subscriptionStub(env, reference.billing.subscription_id)
    : userStub(env, reference.user_id)
}

function poolStub(
  env: Env,
  groupId: string,
  modelId: string,
  endpoint: GatewayEndpoint,
): DurableObjectStub {
  return env.POOL_STATE.get(
    env.POOL_STATE.idFromName(poolStateName(groupId, modelId, endpoint)),
  )
}

export function poolStateName(
  groupId: string,
  modelId: string,
  endpoint: GatewayEndpoint,
): string {
  // Keep the legacy namespace stable. Model IDs are globally unique and the
  // current production pools were created with this historical platform tag.
  return `group:${groupId}:platform:openai:model:${modelId}:endpoint:${endpoint}:shard:0`
}

function post(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const request = new Request(`https://state.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return stub.fetch(request)
}

export function parseApiKeyMonetaryUsage(
  value: unknown,
  apiKeyId: string,
): ApiKeyMonetaryUsageSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidApiKeyMonetaryUsage()
  }
  const candidate = value as Partial<ApiKeyMonetaryUsageSnapshot>
  if (
    candidate.api_key_id !== apiKeyId ||
    !nonNegativeSafeInteger(candidate.quota_reset_epoch) ||
    !nonNegativeSafeInteger(candidate.rate_limit_reset_epoch) ||
    !nonNegativeSafeInteger(candidate.total_settled_micros) ||
    !nonNegativeSafeInteger(candidate.active_reserved_micros) ||
    !Array.isArray(candidate.windows) ||
    candidate.windows.length !== 3
  ) return invalidApiKeyMonetaryUsage()
  const byKind = new Map<ApiKeyMonetaryWindowSnapshot['kind'], ApiKeyMonetaryWindowSnapshot>()
  for (const raw of candidate.windows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return invalidApiKeyMonetaryUsage()
    }
    const window = raw as Partial<ApiKeyMonetaryWindowSnapshot>
    if (
      window.api_key_id !== apiKeyId ||
      (window.kind !== '5h' && window.kind !== '1d' && window.kind !== '7d') ||
      !nonNegativeSafeInteger(window.window_started_at_ms) ||
      !nonNegativeSafeInteger(window.settled_micros) ||
      !nonNegativeSafeInteger(window.updated_at_ms) ||
      byKind.has(window.kind)
    ) return invalidApiKeyMonetaryUsage()
    byKind.set(window.kind, window as ApiKeyMonetaryWindowSnapshot)
  }
  const window5h = byKind.get('5h')
  const window1d = byKind.get('1d')
  const window7d = byKind.get('7d')
  if (window5h === undefined || window1d === undefined || window7d === undefined) {
    return invalidApiKeyMonetaryUsage()
  }
  return {
    api_key_id: candidate.api_key_id,
    quota_reset_epoch: candidate.quota_reset_epoch,
    rate_limit_reset_epoch: candidate.rate_limit_reset_epoch,
    total_settled_micros: candidate.total_settled_micros,
    active_reserved_micros: candidate.active_reserved_micros,
    windows: [window5h, window1d, window7d],
  }
}

export function parsePlatformQuotaUsage(
  value: unknown,
  userId: string,
  platform: PlatformQuotaPolicy['platform'],
): PlatformQuotaUsageSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidPlatformQuotaUsage()
  }
  const candidate = value as Partial<PlatformQuotaUsageSnapshot>
  if (
    candidate.user_id !== userId || candidate.platform !== platform ||
    !nonNegativeSafeInteger(candidate.control_version)
  ) return invalidPlatformQuotaUsage()
  for (const kind of ['daily', 'weekly', 'monthly'] as const) {
    const window = candidate[kind]
    if (
      window === null || typeof window !== 'object' ||
      !nonNegativeSafeInteger(window.reset_epoch) ||
      !nonNegativeSafeInteger(window.window_start_ms) ||
      !nonNegativeSafeInteger(window.settled_micros) ||
      !nonNegativeSafeInteger(window.active_reserved_micros) ||
      !nonNegativeSafeInteger(window.updated_at_ms)
    ) return invalidPlatformQuotaUsage()
  }
  return candidate as PlatformQuotaUsageSnapshot
}

function invalidPlatformQuotaUsage(): never {
  throw new GatewayError(
    503,
    'invalid_platform_quota_state',
    'Platform quota state returned invalid usage',
    'server_error',
  )
}

function invalidApiKeyMonetaryUsage(): never {
  throw new GatewayError(
    503,
    'invalid_api_key_monetary_state',
    'API key monetary state returned invalid usage',
    'server_error',
  )
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function windowUsageProjection(kind: ApiKeyMonetaryWindowSnapshot['kind']): string {
  const usage = `usage_${kind}_micros`
  const start = `window_${kind}_start_ms`
  return `CASE
    WHEN rate_limit_reset_epoch < ? THEN ?
    WHEN rate_limit_reset_epoch = ? AND (${start} IS NULL OR ${start} < ?) THEN ?
    WHEN rate_limit_reset_epoch = ? AND ${start} = ? THEN MAX(${usage}, ?)
    ELSE ${usage} END`
}

function windowStartProjection(kind: ApiKeyMonetaryWindowSnapshot['kind']): string {
  const start = `window_${kind}_start_ms`
  return `CASE
    WHEN rate_limit_reset_epoch < ? THEN ?
    WHEN rate_limit_reset_epoch = ? AND (${start} IS NULL OR ${start} < ?) THEN ?
    ELSE ${start} END`
}

function windowProjectionBindings(
  epoch: number,
  window: ApiKeyMonetaryWindowSnapshot,
): readonly number[] {
  return [
    epoch,
    window.settled_micros,
    epoch,
    window.window_started_at_ms,
    window.settled_micros,
    epoch,
    window.window_started_at_ms,
    window.settled_micros,
    epoch,
    window.window_started_at_ms,
    epoch,
    window.window_started_at_ms,
    window.window_started_at_ms,
  ]
}

async function requireStateOk(responsePromise: Promise<Response>): Promise<Response> {
  const response = await responsePromise
  if (!response.ok) throw await stateResponseError(response)
  return response
}

async function stateErrorCode(response: Response): Promise<string | undefined> {
  const clone = response.clone()
  try {
    return ((await clone.json()) as StateErrorBody).error?.code
  } catch {
    return undefined
  }
}

async function stateResponseError(response: Response): Promise<GatewayError> {
  let body: StateErrorBody = {}
  try {
    body = (await response.json()) as StateErrorBody
  } catch {
    // Durable Object returned a malformed internal response.
  }
  const code = body.error?.code ?? 'state_operation_failed'
  const message = body.error?.message ?? 'Internal state operation failed'
  const status = response.status >= 400 && response.status < 500 ? response.status : 503
  const type = status === 403
    ? 'permission_error'
    : status === 429
      ? 'rate_limit_error'
      : 'server_error'
  return new GatewayError(status, code, message, type, response.headers.get('retry-after') ?? undefined)
}
