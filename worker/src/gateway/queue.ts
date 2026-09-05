import type {
  Env,
  PlatformEvent,
  UsageSettledPayload,
  UserStateChangedPayload,
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
import { settleRecoveryRequest } from './recovery'
import {
  consumeAccountHealthProbe,
  isAccountHealthProbeEvent,
} from '../control/account-lifecycle'
import {
  consumeObservabilityPayloadRetry,
  isObservabilityPayloadRetryMessage,
} from '../observability/recorder'
import { consumeMediaTaskExecute, isMediaTaskExecuteEvent } from '../media/queue'

const CONSUMER = 'usage-projection-v1'
const USER_STATE_CONSUMER = 'user-state-projection-v1'
const SUBSCRIPTION_STATE_CONSUMER = 'subscription-state-projection-v1'

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
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO usage_projection (
             event_id, request_id, user_id, api_key_id, account_id, model,
             input_tokens, output_tokens, amount_micros, occurred_at_ms, projected_at_ms,
             group_id, price_id, requested_model, upstream_model, cache_read_tokens,
             input_amount_micros, output_amount_micros, cache_amount_micros,
             base_amount_micros, outcome, stream, duration_ms
             , billing_type, subscription_id, platform, request_type,
             inbound_endpoint, upstream_endpoint, billing_mode, native_compaction_v2,
             dimensions_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE(NULLIF(?, ''), (SELECT platform FROM "groups" WHERE id = ?), ''),
             ?, ?, ?, ?, ?, ?)`,
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
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
          SET balance_micros = ?, status = ?, state_version = ?,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND state_version < ?`,
    ).bind(
      payload.balance_micros,
      payload.enabled ? 'active' : 'disabled',
      payload.state_version,
      payload.updated_at_ms,
      payload.user_id,
      payload.state_version,
    ),
    env.DB.prepare(
      `INSERT INTO inbox (consumer, event_id, processed_at_ms, result_digest)
       VALUES (?, ?, ?, ?)`,
    ).bind(USER_STATE_CONSUMER, event.event_id, Date.now(), digest),
  ])
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
  payload = {
    ...payload,
    platform: payload.platform ?? '',
    request_type: payload.request_type ?? (payload.stream === true ? 2 : 1),
    inbound_endpoint: payload.inbound_endpoint ?? '',
    upstream_endpoint: payload.upstream_endpoint ?? '',
    billing_mode: payload.billing_mode ?? 'token',
    native_compaction_v2: payload.native_compaction_v2 ?? false,
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
  for (const field of [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'input_amount_micros',
    'output_amount_micros',
    'cache_amount_micros',
    'base_amount_micros',
    'amount_micros',
    'duration_ms',
  ] as const) {
    if (!Number.isSafeInteger(payload[field]) || (payload[field] as number) < 0) {
      throw new Error(`Invalid usage payload field ${field}`)
    }
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
    payload.amount_micros !==
    payload.input_amount_micros! +
      payload.output_amount_micros! +
      payload.cache_amount_micros! +
      payload.base_amount_micros!
  ) {
    throw new Error('Usage amount does not match its cost components')
  }
  return event as PlatformEvent<UsageSettledPayload>
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
    typeof payload.enabled === 'boolean' &&
    Number.isSafeInteger(payload.updated_at_ms) &&
    (payload.updated_at_ms as number) >= 0 &&
    payload.updated_at_ms === event.occurred_at_ms &&
    typeof payload.mutation_id === 'string' &&
    event.event_id === `user-state:${payload.user_id}:${payload.state_version}`
  )
}
