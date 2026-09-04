import type { Env } from '../env'
import type { PlatformEvent, UsageSettledPayload } from '../env'
import { GatewayError } from './errors'
import { sha256Hex } from './crypto'
import type { AccountCandidate, GatewayEndpoint, GatewayPrincipal } from './types'

export const STATE_SCHEMA_VERSION = 1
export const RESERVATION_TTL_MS = 10 * 60_000
export const LEASE_TTL_MS = 60_000
export const RENEW_AFTER_MS = 20_000

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
  const stub = env.API_KEY_LIMIT_STATE.get(
    env.API_KEY_LIMIT_STATE.idFromName(`user:${principal.user_id}`),
  )
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
        priority: account.priority,
        weight: account.weight,
      })))),
      accounts: candidates.map((account) => ({
        account_id: account.account_id,
        max_concurrency: account.max_concurrency,
        priority: account.priority,
        weight: account.weight,
      })),
    }),
  )
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
): Promise<string> {
  const response = await requireStateOk(
    post(stub, '/reserve', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: leaseId,
      lease_ttl_ms: LEASE_TTL_MS,
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
    env.POOL_STATE.idFromName(
      `group:${groupId}:platform:openai:model:${modelId}:endpoint:${endpoint}:shard:0`,
    ),
  )
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
