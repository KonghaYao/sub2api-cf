import { createUsageEvent } from '../gateway/queue'
import { persistSettlementRecovery, settleRecoveryRequest, signalSettlementRecovery } from '../gateway/recovery'
import {
  cancelApiKeyMonetaryReservation,
  cancelBillingReservation,
  cancelPlatformQuotaReservation,
  prepareApiKeyMonetaryReservation,
  prepareBillingReservation,
  preparePlatformQuotaReservation,
  renewApiKeyMonetaryReservation,
  renewBillingReservation,
  renewPlatformQuotaReservation,
} from '../gateway/state-client'
import type { MediaBilling, MediaTaskRow } from './types'

export const durableObjectMediaBilling: MediaBilling = {
  async reserve({ env, principal, requestId, amountMicros }) {
    try {
      await prepareBillingReservation(env, principal, requestId, amountMicros)
      await prepareApiKeyMonetaryReservation(env, principal, requestId, amountMicros)
      await preparePlatformQuotaReservation(env, principal, requestId, amountMicros)
    } catch (error) {
      await cancelReservations(env, principal, requestId)
      throw error
    }
  },

  async renew({ env, task, sequence }) {
    const reference = taskReference(task)
    const requestId = mediaBillingRequestId(task.id)
    const results = await Promise.allSettled([
      renewBillingReservation(env, reference, requestId, sequence),
      renewApiKeyMonetaryReservation(env, reference, requestId, sequence),
      renewPlatformQuotaReservation(env, reference, requestId, sequence),
    ])
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  },

  async settle({ env, task, amountMicros, occurredAtMs }) {
    if (task.provider_account_id === null) {
      throw new Error('Media settlement requires a provider account')
    }
    const requestId = mediaBillingRequestId(task.id)
    const reference = {
      user_id: task.user_id,
      api_key_id: task.api_key_id,
      billing: task.billing_type === 'subscription'
        ? { type: 'subscription' as const, subscription_id: requireSubscription(task) }
        : { type: 'balance' as const },
      platform_quota: task.platform_quota_platform === null
        ? null
        : { platform: task.platform_quota_platform as 'gemini' },
    }
    const event = createUsageEvent({
      request_id: requestId,
      user_id: task.user_id,
      api_key_id: task.api_key_id,
      group_id: task.group_id,
      billing_type: task.billing_type,
      subscription_id: task.subscription_id,
      account_id: task.provider_account_id,
      price_id: task.price_id,
      requested_model: task.model,
      upstream_model: task.upstream_model,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      input_amount_micros: 0,
      output_amount_micros: 0,
      cache_amount_micros: 0,
      base_amount_micros: amountMicros,
      amount_micros: amountMicros,
      outcome: task.status === 'cancelled' ? 'cancelled' : 'completed',
      stream: false,
      platform: 'gemini',
      request_type: 1,
      inbound_endpoint: '/v1/images/batches',
      upstream_endpoint: '/v1beta/models:generateContent',
      billing_mode: 'image',
      native_compaction_v2: false,
      duration_ms: Math.max(0, occurredAtMs - (task.started_at_ms ?? task.created_at_ms)),
      estimated: false,
    }, occurredAtMs)
    await persistSettlementRecovery(env, reference, requestId, amountMicros, event)
    if (!await settleRecoveryRequest(env, requestId, true)) {
      await signalSettlementRecovery(env, requestId)
      throw new Error('Media settlement is pending recovery')
    }
  },

  async cancel({ env, task }) {
    const reference = taskReference(task)
    const requestId = mediaBillingRequestId(task.id)
    const results = await Promise.allSettled([
      cancelBillingReservation(env, reference, requestId),
      cancelApiKeyMonetaryReservation(env, reference, requestId),
      cancelPlatformQuotaReservation(env, reference, requestId),
    ])
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  },
}

export function mediaBilling(env: { MEDIA_BILLING?: MediaBilling }): MediaBilling {
  return env.MEDIA_BILLING ?? durableObjectMediaBilling
}

export function mediaBillingRequestId(taskId: string): string {
  return `media:${taskId}`
}

function taskReference(task: MediaTaskRow) {
  return {
    user_id: task.user_id,
    api_key_id: task.api_key_id,
    billing: task.billing_type === 'subscription'
      ? { type: 'subscription' as const, subscription_id: requireSubscription(task) }
      : { type: 'balance' as const },
    platform_quota: task.platform_quota_platform === null
      ? null
      : { platform: task.platform_quota_platform as 'gemini' },
  }
}

async function cancelReservations(
  env: Parameters<typeof prepareBillingReservation>[0],
  principal: Parameters<typeof prepareBillingReservation>[1],
  requestId: string,
): Promise<void> {
  await Promise.allSettled([
    cancelBillingReservation(env, principal, requestId),
    cancelApiKeyMonetaryReservation(env, principal, requestId),
    cancelPlatformQuotaReservation(env, principal, requestId),
  ])
}

function requireSubscription(task: MediaTaskRow): string {
  if (task.subscription_id === null) throw new Error('Media task subscription reference is missing')
  return task.subscription_id
}
