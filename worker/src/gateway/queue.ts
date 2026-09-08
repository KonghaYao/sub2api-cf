import { isAccountInitializationEvent, consumeAccountInitialization } from '../control/account-initialization'
import { consumeRiskModeration } from './risk-moderation'
import { consumeOpsSystemLog } from '../control/ops-system-logs'
import { consumeSettingsMaintenance } from '../maintenance/queue'
import type {
  Env,
  PlatformEvent,
  UsageSettledPayload,
  UserStateChangedPayload,
  UserFinancialEventPayload,
  SubscriptionStateChangedPayload,
} from '../env'
import { fulfillPaymentOrder, isPaymentFulfillmentEvent } from '../payment/fulfillment'
import {
  consumeEmailChallengeDelivery,
  isEmailChallengeDeliveryEvent,
} from '../auth/email-challenges'
import {
  consumeNotificationEmailVerificationDelivery,
  isNotificationEmailVerificationEvent,
} from '../user/notification-preferences'
import {
  consumeTotpEmailVerificationDelivery,
  isTotpEmailVerificationEvent,
} from '../user/totp'
import { sha256Hex } from './crypto'
import {
  consumeSettlementCommand,
  isSettlementCommandEvent,
  settleRecoveryRequest,
} from './recovery'
import {
  consumeAccountHealthProbe,
  isAccountHealthProbeEvent,
} from '../control/account-lifecycle'
import {
  consumeAccountSyntheticProbe,
  isAccountSyntheticProbeEvent,
} from '../control/account-synthetic-probes'
import {
  consumeObservabilityPayloadRetry,
  isObservabilityPayloadRetryMessage,
} from '../observability/recorder'
import { consumeMediaTaskExecute, isMediaTaskExecuteEvent } from '../media/queue'
import {
  consumeMediaProviderJobAdvance,
  isMediaProviderJobAdvanceEvent,
} from '../media/provider-job'
import { consumeImageTaskExecute, isImageTaskExecuteEvent } from '../media/image-task'
import { financialSourceForMutation } from '../shared/user-financial-event'
import { accountQuotaAccrual, accountQuotaCost } from './account-quota-accrual'

const CONSUMER = 'usage-projection-v1'
const USER_STATE_CONSUMER = 'user-state-projection-v1'
const SUBSCRIPTION_STATE_CONSUMER = 'subscription-state-projection-v1'
const MAX_CUSTOMER_PRICING_SNAPSHOT_BYTES = 65_536

export function createUsageEvent(
  payload: UsageSettledPayload,
  occurredAtMs: number,
): PlatformEvent<UsageSettledPayload> {
  return {
    schema_version: 1,
    event_id: `usage:${payload.request_id}`,
    event_type: 'usage.settled.v1',
    occurred_at_ms: occurredAtMs,
    aggregate_type: 'user',
    aggregate_id: payload.user_id,
    payload,
  }
}

export function createUserStateEvent(
  payload: UserStateChangedPayload,
): PlatformEvent<UserStateChangedPayload> {
  return {
    schema_version: 1,
    event_id: `user-state:${payload.user_id}:${payload.state_version}`,
    event_type: 'user.state.changed.v1',
    occurred_at_ms: payload.updated_at_ms,
    aggregate_type: 'user',
    aggregate_id: payload.user_id,
    payload,
  }
}

export async function consumeEvents(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (isAccountInitializationEvent(message.body)) {
        await consumeAccountInitialization(env, message.body)
        message.ack()
        continue
      }
      if (await consumeRiskModeration(message.body, env) || await consumeOpsSystemLog(message.body, env) || await consumeSettingsMaintenance(message.body, env)) { message.ack(); continue }
      if (isMediaProviderJobAdvanceEvent(message.body)) {
        await consumeMediaProviderJobAdvance(message.body, env)
        message.ack()
        continue
      }
      if (isImageTaskExecuteEvent(message.body)) {
        await consumeImageTaskExecute(message.body, env)
        message.ack()
        continue
      }
      if (isMediaTaskExecuteEvent(message.body)) {
        await consumeMediaTaskExecute(message.body, env)
        message.ack()
        continue
      }
      if (isEmailChallengeDeliveryEvent(message.body)) {
        await consumeEmailChallengeDelivery(message.body, env)
        message.ack()
        continue
      }
      if (isNotificationEmailVerificationEvent(message.body)) {
        await consumeNotificationEmailVerificationDelivery(message.body, env)
        message.ack()
        continue
      }
      if (isTotpEmailVerificationEvent(message.body)) {
        await consumeTotpEmailVerificationDelivery(message.body, env)
        message.ack()
        continue
      }
      if (isPaymentFulfillmentEvent(message.body)) {
        await fulfillPaymentOrder(env, message.body.payload.order_id)
        message.ack()
        continue
      }
      if (isAccountHealthProbeEvent(message.body)) {
        await consumeAccountHealthProbe(message.body, env)
        message.ack()
        continue
      }
      if (isAccountSyntheticProbeEvent(message.body)) {
        await consumeAccountSyntheticProbe(message.body, env)
        message.ack()
        continue
      }
      if (isObservabilityPayloadRetryMessage(message.body)) {
        // A successful delayed requeue is safe to acknowledge. If enqueueing
        // fails, Cloudflare retries this original payload and can send it to DLQ.
        if (await consumeObservabilityPayloadRetry(
          env,
          message.body,
          { requeueOnFailure: true },
        )) message.ack()
        else message.retry()
        continue
      }
      if (isSettlementRetryEvent(message.body)) {
        await settleRecoveryRequest(env, message.body.payload.request_id)
        message.ack()
        continue
      }
      if (isSettlementCommandEvent(message.body)) {
        await consumeSettlementCommand(env, message.body)
        message.ack()
        continue
      }
      if (isUserStateEvent(message.body)) {
        await projectUserStateEvent(message.body, env)
        message.ack()
        continue
      }
      if (isSubscriptionStateEvent(message.body)) {
        await projectSubscriptionStateEvent(message.body, env)
        message.ack()
        continue
      }
      const event = requireUsageEvent(message.body)
      const digests = await usageReplayDigests(message.body, event)
      const existing = await env.DB.prepare(
        'SELECT result_digest FROM inbox WHERE consumer = ? AND event_id = ?',
      )
        .bind(CONSUMER, event.event_id)
        .first<{ result_digest: string | null }>()
      if (existing !== null) {
        if (existing.result_digest === null || !digests.accepted.has(existing.result_digest)) {
          throw new Error(`Conflicting replay for usage event ${event.event_id}`)
        }
        message.ack()
        continue
      }

      const payload = event.payload
      const quotaUpdates = await accountQuotaAccrual(env, payload.account_id,
        accountQuotaCost(payload.standard_cost_micros!, payload.account_rate_multiplier_ppm!), Date.now(), event.occurred_at_ms)
      await env.DB.batch([
        ...quotaUpdates,
        env.DB.prepare(
          `INSERT INTO usage_projection (
             event_id, request_id, user_id, api_key_id, account_id, model,
             input_tokens, output_tokens, amount_micros,
             standard_cost_micros, account_stats_cost_micros,
             account_rate_multiplier_ppm, account_cost_micros,
             customer_pricing_snapshot_json,
             occurred_at_ms, projected_at_ms,
             group_id, price_id, requested_model, upstream_model, cache_read_tokens,
             input_amount_micros, output_amount_micros, cache_amount_micros,
             base_amount_micros, outcome, stream, duration_ms
             , billing_type, subscription_id, platform, request_type,
             inbound_endpoint, upstream_endpoint, billing_mode, native_compaction_v2,
             dimensions_version, image_count, image_size, image_input_size,
             image_output_size, image_size_source, image_size_breakdown,
             account_stats_rollup_version, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_write_amount_micros
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE(NULLIF(?, ''), (SELECT platform FROM "groups" WHERE id = ?), ''),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        ).bind(
          event.event_id,
          payload.request_id,
          payload.user_id,
          payload.api_key_id,
          payload.account_id,
          payload.requested_model,
          payload.input_tokens,
          payload.output_tokens,
          payload.amount_micros,
          payload.standard_cost_micros,
          payload.account_stats_cost_micros,
          payload.account_rate_multiplier_ppm,
          payload.account_cost_micros,
          payload.customer_pricing_snapshot_json,
          event.occurred_at_ms,
          Date.now(),
          payload.group_id,
          payload.price_id,
          payload.requested_model,
          payload.upstream_model,
          payload.cache_read_tokens,
          payload.input_amount_micros,
          payload.output_amount_micros,
          payload.cache_amount_micros,
          payload.base_amount_micros,
          payload.outcome,
          payload.stream ? 1 : 0,
          payload.duration_ms,
          payload.billing_type,
          payload.subscription_id,
          payload.platform,
          payload.group_id,
          payload.request_type,
          payload.inbound_endpoint,
          payload.upstream_endpoint,
          payload.billing_mode,
          payload.native_compaction_v2 ? 1 : 0,
          1,
          payload.image_count,
          payload.image_size,
          payload.image_input_size,
          payload.image_output_size,
          payload.image_size_source,
          payload.image_size_breakdown === null ? null : JSON.stringify(payload.image_size_breakdown),
          payload.cache_write_tokens ?? 0,
          payload.cache_write_5m_tokens ?? 0,
          payload.cache_write_1h_tokens ?? 0,
          payload.cache_write_amount_micros ?? 0,
        ),
        env.DB.prepare(
          `INSERT INTO inbox (consumer, event_id, processed_at_ms, result_digest)
           VALUES (?, ?, ?, ?)`,
        ).bind(CONSUMER, event.event_id, Date.now(), digests.stored),
        env.DB.prepare(
          `UPDATE api_keys
              SET last_used_at_ms = CASE
                    WHEN last_used_at_ms IS NULL OR last_used_at_ms < ? THEN ?
                    ELSE last_used_at_ms
                  END
            WHERE id = ?`,
        ).bind(event.occurred_at_ms, event.occurred_at_ms, payload.api_key_id),
        env.DB.prepare(
          `INSERT INTO account_usage_15m_rollup (
             account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint,
             requests, input_tokens, output_tokens, cache_read_tokens,
             standard_cost_micros, account_cost_micros, user_cost_micros,
             duration_total_ms, duration_count, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint)
           DO UPDATE SET
             cache_write_tokens = account_usage_15m_rollup.cache_write_tokens + excluded.cache_write_tokens,
             cache_write_5m_tokens = account_usage_15m_rollup.cache_write_5m_tokens + excluded.cache_write_5m_tokens,
             cache_write_1h_tokens = account_usage_15m_rollup.cache_write_1h_tokens + excluded.cache_write_1h_tokens,
             requests = account_usage_15m_rollup.requests + excluded.requests,
             input_tokens = account_usage_15m_rollup.input_tokens + excluded.input_tokens,
             output_tokens = account_usage_15m_rollup.output_tokens + excluded.output_tokens,
             cache_read_tokens = account_usage_15m_rollup.cache_read_tokens + excluded.cache_read_tokens,
             standard_cost_micros = account_usage_15m_rollup.standard_cost_micros + excluded.standard_cost_micros,
             account_cost_micros = account_usage_15m_rollup.account_cost_micros + excluded.account_cost_micros,
             user_cost_micros = account_usage_15m_rollup.user_cost_micros + excluded.user_cost_micros,
             duration_total_ms = account_usage_15m_rollup.duration_total_ms + excluded.duration_total_ms,
             duration_count = account_usage_15m_rollup.duration_count + excluded.duration_count`,
        ).bind(
          payload.account_id,
          Math.floor(event.occurred_at_ms / 900_000) * 900_000,
          payload.requested_model,
          payload.inbound_endpoint,
          payload.upstream_endpoint,
          payload.input_tokens,
          payload.output_tokens,
          payload.cache_read_tokens,
          payload.standard_cost_micros,
          payload.account_cost_micros,
          payload.amount_micros,
          payload.duration_ms,
          payload.cache_write_tokens ?? 0,
          payload.cache_write_5m_tokens ?? 0,
          payload.cache_write_1h_tokens ?? 0,
        ),
      ])
      message.ack()
    } catch (error) {
      console.error('event projection failed', {
        message_id: message.id,
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : 'unknown',
      })
      message.retry()
    }
  }
}

async function usageReplayDigests(
  wireEvent: unknown,
  normalizedEvent: PlatformEvent<UsageSettledPayload>,
): Promise<{ stored: string; accepted: Set<string> }> {
  const wire = stringifyQueueEvent(wireEvent)
  const v019 = stringifyQueueEvent(normalizeUsageEventForV019Digest(wireEvent))
  const normalized = stringifyQueueEvent(normalizedEvent)
  const [wireDigest, v019Digest, normalizedDigest] = await Promise.all([
    sha256Hex(wire),
    sha256Hex(v019),
    sha256Hex(normalized),
  ])
  return {
    // Persist the immutable queue wire representation. Projection defaults may
    // evolve again without changing the identity of a previously seen event.
    stored: wireDigest,
    accepted: new Set([wireDigest, v019Digest, normalizedDigest]),
  }
}

function normalizeUsageEventForV019Digest(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const event = value as Record<string, unknown>
  if (event.payload === null || typeof event.payload !== 'object') return value
  const payload = event.payload as Record<string, unknown>
  if (Object.hasOwn(payload, 'billing_type') || Object.hasOwn(payload, 'subscription_id')) {
    return value
  }
  const { request_id, user_id, api_key_id, group_id, ...legacyFields } = payload
  return {
    ...event,
    payload: {
      request_id,
      user_id,
      api_key_id,
      group_id,
      billing_type: 'balance',
      subscription_id: null,
      ...legacyFields,
    },
  }
}

function stringifyQueueEvent(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Unsupported queue event')
  return serialized
}

async function projectSubscriptionStateEvent(
  event: PlatformEvent<SubscriptionStateChangedPayload>,
  env: Env,
): Promise<void> {
  const digest = await sha256Hex(JSON.stringify(event))
  const existing = await env.DB.prepare(
    'SELECT result_digest FROM inbox WHERE consumer = ? AND event_id = ?',
  ).bind(SUBSCRIPTION_STATE_CONSUMER, event.event_id).first<{ result_digest: string | null }>()
  if (existing !== null) {
    if (existing.result_digest !== digest) {
      throw new Error(`Conflicting replay for subscription state event ${event.event_id}`)
    }
    return
  }
  const payload = event.payload
  const windowAssignments = (start: number) => [
    start,
    payload.amount_micros,
    start,
    payload.amount_micros,
    start,
    start,
  ] as const
  const dailyWindowAssignments = [
    payload.quota_reset_epoch,
    payload.daily_window_start_ms,
    payload.amount_micros,
    payload.daily_window_start_ms,
    payload.amount_micros,
    payload.quota_reset_epoch,
    payload.daily_window_start_ms,
    payload.daily_window_start_ms,
  ] as const
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE user_subscriptions
          SET daily_used_micros = CASE
                WHEN quota_reset_epoch <> ? THEN daily_used_micros
                WHEN daily_window_start_ms IS NULL OR daily_window_start_ms < ? THEN ?
                WHEN daily_window_start_ms = ? THEN daily_used_micros + ?
                ELSE daily_used_micros END,
              daily_window_start_ms = CASE
                WHEN quota_reset_epoch <> ? THEN daily_window_start_ms
                WHEN daily_window_start_ms IS NULL OR daily_window_start_ms < ? THEN ?
                ELSE daily_window_start_ms END,
              weekly_used_micros = CASE
                WHEN weekly_window_start_ms IS NULL OR weekly_window_start_ms < ? THEN ?
                WHEN weekly_window_start_ms = ? THEN weekly_used_micros + ?
                ELSE weekly_used_micros END,
              weekly_window_start_ms = CASE
                WHEN weekly_window_start_ms IS NULL OR weekly_window_start_ms < ? THEN ?
                ELSE weekly_window_start_ms END,
              monthly_used_micros = CASE
                WHEN monthly_window_start_ms IS NULL OR monthly_window_start_ms < ? THEN ?
                WHEN monthly_window_start_ms = ? THEN monthly_used_micros + ?
                ELSE monthly_used_micros END,
              monthly_window_start_ms = CASE
                WHEN monthly_window_start_ms IS NULL OR monthly_window_start_ms < ? THEN ?
                ELSE monthly_window_start_ms END,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND user_id = ? AND group_id = ?`,
    ).bind(
      ...dailyWindowAssignments,
      ...windowAssignments(payload.weekly_window_start_ms),
      ...windowAssignments(payload.monthly_window_start_ms),
      payload.updated_at_ms,
      payload.subscription_id,
      payload.user_id,
      payload.group_id,
    ),
    env.DB.prepare(
      `INSERT INTO inbox (consumer, event_id, processed_at_ms, result_digest)
       VALUES (?, ?, ?, ?)`,
    ).bind(SUBSCRIPTION_STATE_CONSUMER, event.event_id, Date.now(), digest),
  ])
}

async function projectUserStateEvent(
  event: PlatformEvent<UserStateChangedPayload>,
  env: Env,
): Promise<void> {
  const digest = await sha256Hex(JSON.stringify(event))
  const existing = await env.DB.prepare(
    'SELECT result_digest FROM inbox WHERE consumer = ? AND event_id = ?',
  )
    .bind(USER_STATE_CONSUMER, event.event_id)
    .first<{ result_digest: string | null }>()
  if (existing !== null) {
    if (existing.result_digest !== digest) {
      throw new Error(`Conflicting replay for user state event ${event.event_id}`)
    }
    return
  }
  const payload = event.payload
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE users
          SET balance_micros = ?,
              spend_debt_micros = COALESCE(?, spend_debt_micros),
              status = ?, state_version = ?,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND state_version <= ?`,
    ).bind(
      payload.balance_micros,
      payload.spend_debt_micros ?? null,
      payload.enabled ? 'active' : 'disabled',
      payload.state_version,
      payload.updated_at_ms,
      payload.user_id,
      payload.state_version,
    ),
  ]
  if (payload.financial_event !== undefined) {
    const financial = payload.financial_event
    statements.push(env.DB.prepare(
      `INSERT INTO user_financial_events (
         event_id, user_id, state_version, event_type, source_type, source_id,
         request_id, actor_user_id, actor_session_id,
         amount_delta_micros, gross_amount_micros,
         spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
         occurred_at_ms, projected_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      event.event_id,
      payload.user_id,
      payload.state_version,
      financial.event_type,
      financial.source_type,
      financial.source_id,
      financial.request_id,
      financial.actor_user_id,
      financial.actor_session_id,
      financial.amount_delta_micros,
      financial.gross_amount_micros,
      financial.spend_debt_delta_micros,
      financial.balance_after_micros,
      financial.spend_debt_after_micros,
      event.occurred_at_ms,
      Date.now(),
    ))
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO inbox (consumer, event_id, processed_at_ms, result_digest)
       VALUES (?, ?, ?, ?)`,
    ).bind(USER_STATE_CONSUMER, event.event_id, Date.now(), digest),
  )
  await env.DB.batch(statements)
}

function requireUsageEvent(value: unknown): PlatformEvent<UsageSettledPayload> {
  let event = value as PlatformEvent | null
  if (
    event === null ||
    typeof event !== 'object' ||
    event.schema_version !== 1 ||
    event.event_type !== 'usage.settled.v1' ||
    typeof event.event_id !== 'string' ||
    event.event_id !== `usage:${(event.payload as Partial<UsageSettledPayload> | undefined)?.request_id ?? ''}` ||
    event.aggregate_type !== 'user' ||
    event.payload === null ||
    typeof event.payload !== 'object'
  ) {
    throw new Error('Unsupported queue event')
  }
  let payload = event.payload as Partial<UsageSettledPayload>
  const hasBillingType = Object.hasOwn(payload, 'billing_type')
  const hasSubscriptionId = Object.hasOwn(payload, 'subscription_id')
  if (!hasBillingType && !hasSubscriptionId) {
    const { request_id, user_id, api_key_id, group_id, ...legacyFields } = payload
    payload = {
      request_id,
      user_id,
      api_key_id,
      group_id,
      billing_type: 'balance',
      subscription_id: null,
      ...legacyFields,
    }
    event = { ...event, payload }
  } else if (hasBillingType !== hasSubscriptionId) {
    throw new Error('Incomplete usage billing reference')
  }
  const accountCostFields = [
    'standard_cost_micros',
    'account_stats_cost_micros',
    'account_rate_multiplier_ppm',
    'account_cost_micros',
  ] as const
  const accountCostFieldCount = accountCostFields
    .filter((field) => Object.hasOwn(payload, field)).length
  if (accountCostFieldCount === 0) {
    payload = {
      ...payload,
      standard_cost_micros: payload.amount_micros,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_000_000,
      account_cost_micros: payload.amount_micros,
    }
  } else if (accountCostFieldCount !== accountCostFields.length) {
    throw new Error('Incomplete usage account-cost snapshot')
  }
  payload = {
    ...payload,
    platform: payload.platform ?? '',
    request_type: payload.request_type ?? (payload.stream === true ? 2 : 1),
    inbound_endpoint: payload.inbound_endpoint ?? '',
    upstream_endpoint: payload.upstream_endpoint ?? '',
    billing_mode: payload.billing_mode ?? 'token',
    native_compaction_v2: payload.native_compaction_v2 ?? false,
    image_count: payload.image_count ?? 0,
    image_size: payload.image_size ?? null,
    image_input_size: payload.image_input_size ?? null,
    image_output_size: payload.image_output_size ?? null,
    image_size_source: payload.image_size_source ?? null,
    image_size_breakdown: normalizeImageBreakdown(payload.image_size_breakdown ?? null),
    customer_pricing_snapshot_json: normalizeCustomerPricingSnapshot(
      payload.customer_pricing_snapshot_json ?? null,
    ),
  }
  event = { ...event, payload }
  if (event.aggregate_id !== payload.user_id) throw new Error('Usage aggregate does not match user')
  for (const field of [
    'request_id',
    'user_id',
    'api_key_id',
    'group_id',
    'account_id',
    'price_id',
    'requested_model',
    'upstream_model',
  ] as const) {
    if (typeof payload[field] !== 'string' || payload[field] === '') {
      throw new Error(`Invalid usage payload field ${field}`)
    }
  }
  if (!['balance', 'subscription'].includes(payload.billing_type ?? '')) {
    throw new Error('Invalid usage billing type')
  }
  if (
    (payload.billing_type === 'balance' && payload.subscription_id !== null) ||
    (payload.billing_type === 'subscription' &&
      (typeof payload.subscription_id !== 'string' || payload.subscription_id === ''))
  ) {
    throw new Error('Invalid usage subscription reference')
  }
  for (const field of ['cache_write_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_amount_micros'] as const) {
    const value = payload[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid usage payload field ${field}`)
  }
  for (const field of [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'input_amount_micros',
    'output_amount_micros',
    'cache_amount_micros',
    'base_amount_micros',
    'amount_micros',
    'standard_cost_micros',
    'account_rate_multiplier_ppm',
    'account_cost_micros',
    'duration_ms',
  ] as const) {
    if (!Number.isSafeInteger(payload[field]) || (payload[field] as number) < 0) {
      throw new Error(`Invalid usage payload field ${field}`)
    }
  }
  if (
    payload.account_stats_cost_micros !== null &&
    (!Number.isSafeInteger(payload.account_stats_cost_micros) || payload.account_stats_cost_micros! < 0)
  ) {
    throw new Error('Invalid usage payload field account_stats_cost_micros')
  }
  if (!['completed', 'failed', 'cancelled'].includes(payload.outcome ?? '')) {
    throw new Error('Invalid usage outcome')
  }
  if (typeof payload.stream !== 'boolean' || typeof payload.estimated !== 'boolean') {
    throw new Error('Invalid usage flags')
  }
  if (
    typeof payload.platform !== 'string' || payload.platform.length > 64 ||
    !Number.isSafeInteger(payload.request_type) || payload.request_type! < 0 || payload.request_type! > 5 ||
    typeof payload.inbound_endpoint !== 'string' || payload.inbound_endpoint.length > 128 ||
    typeof payload.upstream_endpoint !== 'string' || payload.upstream_endpoint.length > 128 ||
    !['token', 'per_request', 'image', 'video'].includes(payload.billing_mode ?? '') ||
    typeof payload.native_compaction_v2 !== 'boolean'
  ) {
    throw new Error('Invalid usage dimensions')
  }
  if (
    !Number.isSafeInteger(payload.image_count) || payload.image_count! < 0 || payload.image_count! > 100 ||
    (payload.image_size !== null && !['1K', '2K', '4K', 'mixed'].includes(payload.image_size ?? '')) ||
    (payload.image_input_size !== null &&
      (typeof payload.image_input_size !== 'string' || payload.image_input_size.length > 32)) ||
    (payload.image_output_size !== null &&
      (typeof payload.image_output_size !== 'string' || payload.image_output_size.length > 32)) ||
    (payload.image_size_source !== null &&
      !['output', 'input', 'default', 'legacy'].includes(payload.image_size_source ?? '')) ||
    (payload.image_count! > 0 && (payload.image_size === null || payload.image_size_source === null))
  ) {
    throw new Error('Invalid usage image dimensions')
  }
  if (payload.image_size_breakdown != null) {
    const total = Object.values(payload.image_size_breakdown)
      .reduce<number>((sum, count) => sum + (count ?? 0), 0)
    if (total !== payload.image_count) throw new Error('Image size breakdown does not match image count')
  }
  if (
    payload.amount_micros !==
    payload.input_amount_micros! +
      payload.output_amount_micros! +
      payload.cache_amount_micros! +
      (payload.cache_write_amount_micros ?? 0) +
      payload.base_amount_micros!
  ) {
    throw new Error('Usage amount does not match its cost components')
  }
  const accountCostBasis = payload.account_stats_cost_micros ?? payload.standard_cost_micros!
  const expectedAccountCost = Number(
    (BigInt(accountCostBasis) * BigInt(payload.account_rate_multiplier_ppm!) + 999_999n) / 1_000_000n,
  )
  if (!Number.isSafeInteger(expectedAccountCost) || payload.account_cost_micros !== expectedAccountCost) {
    throw new Error('Usage account cost does not match its snapshot')
  }
  return event as PlatformEvent<UsageSettledPayload>
}

function normalizeCustomerPricingSnapshot(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > MAX_CUSTOMER_PRICING_SNAPSHOT_BYTES
  ) {
    throw new Error('Invalid usage customer pricing snapshot')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Invalid usage customer pricing snapshot')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid usage customer pricing snapshot')
  }
  return value
}

function normalizeImageBreakdown(
  value: UsageSettledPayload['image_size_breakdown'],
): Partial<Record<'1K' | '2K' | '4K', number>> | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage image size breakdown')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some((key) => !['1K', '2K', '4K'].includes(key))) {
    throw new Error('Invalid usage image size breakdown')
  }
  const result: Partial<Record<'1K' | '2K' | '4K', number>> = {}
  for (const tier of ['1K', '2K', '4K'] as const) {
    const count = source[tier]
    if (count === undefined) continue
    if (!Number.isSafeInteger(count) || (count as number) <= 0 || (count as number) > 100) {
      throw new Error('Invalid usage image size breakdown')
    }
    result[tier] = count as number
  }
  return Object.keys(result).length === 0 ? null : result
}

function isSubscriptionStateEvent(
  value: unknown,
): value is PlatformEvent<SubscriptionStateChangedPayload> {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<PlatformEvent<Partial<SubscriptionStateChangedPayload>>>
  const payload = event.payload
  if (
    event.schema_version !== 1 ||
    event.event_type !== 'subscription.usage.settled.v1' ||
    event.aggregate_type !== 'subscription' ||
    typeof event.aggregate_id !== 'string' ||
    typeof event.event_id !== 'string' ||
    payload === null || typeof payload !== 'object'
  ) return false
  for (const field of ['request_id', 'subscription_id', 'user_id', 'group_id'] as const) {
    if (typeof payload[field] !== 'string' || payload[field] === '') return false
  }
  for (const field of [
    'amount_micros',
    'daily_window_start_ms',
    'weekly_window_start_ms',
    'monthly_window_start_ms',
    'quota_reset_epoch',
    'updated_at_ms',
  ] as const) {
    if (!Number.isSafeInteger(payload[field]) || (payload[field] as number) < 0) return false
  }
  return event.aggregate_id === payload.subscription_id &&
    event.event_id === `subscription-usage:${payload.request_id}` &&
    event.occurred_at_ms === payload.updated_at_ms
}

function isSettlementRetryEvent(
  value: unknown,
): value is PlatformEvent<{ request_id: string }> {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<PlatformEvent<{ request_id?: unknown }>>
  return (
    event.schema_version === 1 &&
    event.event_type === 'settlement.retry.v1' &&
    event.aggregate_type === 'gateway_request' &&
    typeof event.aggregate_id === 'string' &&
    event.payload !== null &&
    typeof event.payload === 'object' &&
    typeof event.payload.request_id === 'string' &&
    event.payload.request_id === event.aggregate_id
  )
}

function isUserStateEvent(
  value: unknown,
): value is PlatformEvent<UserStateChangedPayload> {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<PlatformEvent<Partial<UserStateChangedPayload>>>
  const payload = event.payload
  return (
    event.schema_version === 1 &&
    event.event_type === 'user.state.changed.v1' &&
    event.aggregate_type === 'user' &&
    typeof event.aggregate_id === 'string' &&
    typeof event.event_id === 'string' &&
    Number.isSafeInteger(event.occurred_at_ms) &&
    payload !== null &&
    typeof payload === 'object' &&
    typeof payload.user_id === 'string' &&
    payload.user_id === event.aggregate_id &&
    Number.isSafeInteger(payload.state_version) &&
    (payload.state_version as number) >= 0 &&
    Number.isSafeInteger(payload.balance_micros) &&
    (payload.balance_micros as number) >= 0 &&
    (payload.spend_debt_micros === undefined || (
      Number.isSafeInteger(payload.spend_debt_micros) &&
      (payload.spend_debt_micros as number) >= 0
    )) &&
    typeof payload.enabled === 'boolean' &&
    Number.isSafeInteger(payload.updated_at_ms) &&
    (payload.updated_at_ms as number) >= 0 &&
    payload.updated_at_ms === event.occurred_at_ms &&
    typeof payload.mutation_id === 'string' &&
    event.event_id === `user-state:${payload.user_id}:${payload.state_version}` &&
    (payload.financial_event === undefined || isUserFinancialEvent(
      payload.financial_event,
      payload,
    ))
  )
}

function isUserFinancialEvent(
  value: unknown,
  state: Partial<UserStateChangedPayload>,
): value is UserFinancialEventPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<UserFinancialEventPayload>
  if (
    !['opening_balance', 'balance_adjustment', 'settlement'].includes(event.event_type ?? '') ||
    ![
      'opening_balance', 'admin_adjustment', 'redeem_code',
      'affiliate_transfer', 'affiliate_refund_clawback',
      'auth_source_entitlement', 'usage_settlement', 'other_adjustment',
    ].includes(event.source_type ?? '') ||
    typeof event.source_id !== 'string' || event.source_id.length === 0 ||
    event.source_id.length > 256 ||
    (event.request_id !== null && (
      typeof event.request_id !== 'string' || event.request_id.length === 0 ||
      event.request_id.length > 256
    )) ||
    !isNullableIdentifier(event.actor_user_id, 128) ||
    !isNullableIdentifier(event.actor_session_id, 128) ||
    ((event.actor_user_id === null) !== (event.actor_session_id === null))
  ) return false
  for (const field of [
    'amount_delta_micros',
    'gross_amount_micros',
    'spend_debt_delta_micros',
    'balance_after_micros',
    'spend_debt_after_micros',
  ] as const) {
    if (!Number.isSafeInteger(event[field])) return false
  }
  if (
    event.balance_after_micros! < 0 || event.spend_debt_after_micros! < 0 ||
    event.balance_after_micros !== state.balance_micros ||
    (state.spend_debt_micros !== undefined &&
      event.spend_debt_after_micros !== state.spend_debt_micros)
  ) return false

  const expectedSource = financialSourceForMutation(
    state.mutation_id ?? '',
    event.event_type!,
    event.request_id,
  )
  if (
    event.source_type !== expectedSource.source_type ||
    event.source_id !== expectedSource.source_id
  ) return false

  if (event.event_type === 'settlement') {
    return event.request_id !== null &&
      event.source_type === 'usage_settlement' &&
      event.amount_delta_micros! <= 0 &&
      event.gross_amount_micros! >= 0 &&
      event.spend_debt_delta_micros! >= 0 &&
      event.gross_amount_micros ===
        -event.amount_delta_micros! + event.spend_debt_delta_micros!
  }
  if (event.event_type === 'opening_balance') {
    return event.request_id === null &&
      event.source_type === 'opening_balance' &&
      event.actor_user_id === null && event.actor_session_id === null &&
      event.amount_delta_micros! >= 0 &&
      event.amount_delta_micros === event.balance_after_micros &&
      event.gross_amount_micros === event.amount_delta_micros &&
      event.spend_debt_delta_micros === event.spend_debt_after_micros
  }
  return event.request_id === null &&
    event.gross_amount_micros !== 0 &&
    event.spend_debt_delta_micros! <= 0 &&
    event.gross_amount_micros ===
      event.amount_delta_micros! - event.spend_debt_delta_micros!
}

function isNullableIdentifier(value: unknown, maximum: number): value is string | null {
  return value === null || (
    typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}
