import type { Env, PlatformEvent, UsageSettledPayload } from '../env'
import { sha256Hex } from './crypto'
import { settleRecoveryRequest } from './recovery'

const CONSUMER = 'usage-projection-v1'

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

export async function consumeEvents(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (isSettlementRetryEvent(message.body)) {
        await settleRecoveryRequest(env, message.body.payload.request_id)
        message.ack()
        continue
      }
      const event = requireUsageEvent(message.body)
      const digest = await sha256Hex(JSON.stringify(event))
      const existing = await env.DB.prepare(
        'SELECT result_digest FROM inbox WHERE consumer = ? AND event_id = ?',
      )
        .bind(CONSUMER, event.event_id)
        .first<{ result_digest: string | null }>()
      if (existing !== null) {
        if (existing.result_digest !== digest) {
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ),
        env.DB.prepare(
          `INSERT INTO inbox (consumer, event_id, processed_at_ms, result_digest)
           VALUES (?, ?, ?, ?)`,
        ).bind(CONSUMER, event.event_id, Date.now(), digest),
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

function requireUsageEvent(value: unknown): PlatformEvent<UsageSettledPayload> {
  const event = value as PlatformEvent | null
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
  const payload = event.payload as Partial<UsageSettledPayload>
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
