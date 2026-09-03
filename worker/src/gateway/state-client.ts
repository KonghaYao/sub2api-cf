import type { Env } from '../env'
import type { PlatformEvent, UsageSettledPayload } from '../env'
import { GatewayError } from './errors'
import { sha256Hex } from './crypto'
import type { AccountCandidate, GatewayEndpoint, GatewayPrincipal } from './types'

export const STATE_SCHEMA_VERSION = 1
export const RESERVATION_TTL_MS = 10 * 60_000
export const LEASE_TTL_MS = 60_000
export const RENEW_AFTER_MS = 20_000

interface StateErrorBody {
  error?: { code?: string; message?: string }
}

interface PoolLeaseBody {
  lease?: { account_id?: string; status?: string }
}

export async function prepareUserReservation(
  env: Env,
  principal: GatewayPrincipal,
  requestId: string,
  amountMicros: number,
): Promise<void> {
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

export async function renewUserReservation(
  env: Env,
  userId: string,
  requestId: string,
  renewalSequence: number,
): Promise<void> {
  await requireStateOk(
    post(userStub(env, userId), '/renew', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      renewal_sequence: renewalSequence,
      reservation_ttl_ms: RESERVATION_TTL_MS,
    }),
  )
}

export async function settleUserReservation(
  env: Env,
  userId: string,
  requestId: string,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): Promise<{ balance_micros: number; settled_micros: number }> {
  const response = await requireStateOk(
    post(userStub(env, userId), '/settle', {
      schema_version: STATE_SCHEMA_VERSION,
      request_id: requestId,
      amount_micros: amountMicros,
      usage_event: usageEvent,
    }),
  )
  const body = (await response.json()) as {
    profile?: { balance_micros?: number; settled_micros?: number }
  }
  if (
    !Number.isSafeInteger(body.profile?.balance_micros) ||
    !Number.isSafeInteger(body.profile?.settled_micros)
  ) {
    throw new GatewayError(500, 'invalid_user_state', 'User state returned an invalid settlement', 'server_error')
  }
  return {
    balance_micros: body.profile!.balance_micros!,
    settled_micros: body.profile!.settled_micros!,
  }
}

export async function cancelUserReservation(env: Env, userId: string, requestId: string): Promise<void> {
  const response = await post(userStub(env, userId), '/cancel', {
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
  return new GatewayError(status, code, message, status === 403 ? 'permission_error' : 'server_error')
}
