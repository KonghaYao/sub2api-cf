import type { Env, UsageSettledPayload } from '../env'
import { createUsageEvent } from '../gateway/queue'
import {
  enqueueSettlementCommand,
  persistSettlementRecovery,
  settleRecoveryRequest,
  signalSettlementRecovery,
} from '../gateway/recovery'
import {
  cancelApiKeyMonetaryReservation,
  cancelBillingReservation,
  cancelPlatformQuotaReservation,
  prepareApiKeyMonetaryReservation,
  prepareBillingReservation,
  preparePlatformQuotaReservation,
} from '../gateway/state-client'
import type { GatewayPrincipal } from '../gateway/types'
import type { SyncImageOperation } from './sync-domain'

interface UsagePrincipal {
  user_id: string
  api_key_id: string
  group_id: string
  platform: string
  billing: { type: 'balance' } | { type: 'subscription'; subscription_id: string }
}

export interface SyncImageUsageInput {
  requestId: string
  principal: UsagePrincipal
  accountId: string
  priceId: string
  requestedModel: string
  upstreamModel: string
  amountMicros: number
  operation: SyncImageOperation
  imageCount?: number
  imageSize?: '1K' | '2K' | '4K'
  imageInputSize?: string | null
  imageOutputSize?: string | null
  imageSizeSource?: 'output' | 'input' | 'default'
  imageSizeBreakdown?: Partial<Record<'1K' | '2K' | '4K', number>>
  stream?: boolean
  outcome?: 'completed' | 'failed' | 'cancelled'
  upstreamEndpoint?: string
  startedAt: number
  occurredAt: number
}

export interface SyncImageBilling {
  reserve(input: {
    env: Env
    principal: GatewayPrincipal
    requestId: string
    amountMicros: number
  }): Promise<void>
  settle(input: {
    env: Env
    principal: GatewayPrincipal
    usage: Omit<SyncImageUsageInput, 'principal' | 'occurredAt'>
  }): Promise<void>
  cancel(input: {
    env: Env
    principal: GatewayPrincipal
    requestId: string
  }): Promise<void>
}

export const durableObjectSyncImageBilling: SyncImageBilling = {
  reserve: ({ env, principal, requestId, amountMicros }) =>
    reserveSyncImageBilling(env, principal, requestId, amountMicros),
  settle: ({ env, principal, usage }) => settleSyncImageBilling(env, principal, usage),
  cancel: ({ env, principal, requestId }) => cancelSyncImageBilling(env, principal, requestId),
}

export function syncImageBilling(env: { SYNC_IMAGE_BILLING?: SyncImageBilling }): SyncImageBilling {
  return env.SYNC_IMAGE_BILLING ?? durableObjectSyncImageBilling
}

export async function reserveSyncImageBilling(
  env: Env,
  principal: GatewayPrincipal,
  requestId: string,
  amountMicros: number,
): Promise<void> {
  try {
    await prepareBillingReservation(env, principal, requestId, amountMicros)
    await prepareApiKeyMonetaryReservation(env, principal, requestId, amountMicros)
    await preparePlatformQuotaReservation(env, principal, requestId, amountMicros)
  } catch (error) {
    await cancelSyncImageBilling(env, principal, requestId)
    throw error
  }
}

export async function cancelSyncImageBilling(
  env: Env,
  principal: GatewayPrincipal,
  requestId: string,
): Promise<void> {
  await Promise.allSettled([
    cancelBillingReservation(env, principal, requestId),
    cancelApiKeyMonetaryReservation(env, principal, requestId),
    cancelPlatformQuotaReservation(env, principal, requestId),
  ])
}

export async function settleSyncImageBilling(
  env: Env,
  principal: GatewayPrincipal,
  input: Omit<SyncImageUsageInput, 'principal' | 'occurredAt'>,
): Promise<void> {
  const occurredAt = Date.now()
  const payload = buildSyncImageUsagePayload({ ...input, principal, occurredAt })
  const event = createUsageEvent(payload, occurredAt)
  // Once the provider has produced an image this hold represents real cost.
  // A persistence outage must retain the hold so the caller can retry this
  // idempotent settlement; cancelling it would silently make paid work free.
  try {
    await persistSettlementRecovery(env, principal, input.requestId, input.amountMicros, event)
  } catch {
    // Queue stores the complete immutable command, not merely a D1 row id, so
    // settlement remains recoverable even while D1 itself is unavailable.
    await enqueueSettlementCommand(env, principal, input.requestId, input.amountMicros, event)
    return
  }
  let completed = false
  try {
    completed = await settleRecoveryRequest(env, input.requestId, true)
  } catch {
    // The durable D1 command already owns recovery. Do not cancel or surface a
    // retry that could repeat a paid upstream image generation.
  }
  if (!completed) {
    await signalSettlementRecovery(env, input.requestId)
  }
}

export function buildSyncImageUsagePayload(input: SyncImageUsageInput): UsageSettledPayload {
  const endpoint = `/v1/images/${input.operation}`
  return {
    request_id: input.requestId,
    user_id: input.principal.user_id,
    api_key_id: input.principal.api_key_id,
    group_id: input.principal.group_id,
    billing_type: input.principal.billing.type,
    subscription_id: input.principal.billing.type === 'subscription'
      ? input.principal.billing.subscription_id
      : null,
    account_id: input.accountId,
    price_id: input.priceId,
    requested_model: input.requestedModel,
    upstream_model: input.upstreamModel,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    input_amount_micros: 0,
    output_amount_micros: 0,
    cache_amount_micros: 0,
    base_amount_micros: input.amountMicros,
    amount_micros: input.amountMicros,
    outcome: input.outcome ?? 'completed',
    stream: input.stream ?? false,
    platform: input.principal.platform,
    request_type: input.stream === true ? 2 : 1,
    inbound_endpoint: endpoint,
    upstream_endpoint: input.upstreamEndpoint ?? endpoint,
    billing_mode: 'image',
    native_compaction_v2: false,
    image_count: input.imageCount ?? 0,
    image_size: input.imageSize ?? null,
    image_input_size: input.imageInputSize ?? null,
    image_output_size: input.imageOutputSize ?? null,
    image_size_source: input.imageSizeSource ?? null,
    image_size_breakdown: input.imageSizeBreakdown ?? null,
    duration_ms: Math.max(0, input.occurredAt - input.startedAt),
    estimated: false,
  }
}
