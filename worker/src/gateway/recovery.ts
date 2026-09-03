import type { Env, PlatformEvent, UsageSettledPayload } from '../env'
import { settleUserReservation } from './state-client'

interface SettlementRecoveryRow {
  request_id: string
  user_id: string
  amount_micros: number
  usage_event_json: string
  attempts: number
}

const MAX_AUTOMATIC_ATTEMPTS = 20

export async function persistSettlementRecovery(
  env: Env,
  userId: string,
  requestId: string,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settlement_recovery (
       request_id, user_id, amount_micros, usage_event_json,
       attempts, available_at_ms, created_at_ms, last_error
     ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
     ON CONFLICT(request_id) DO NOTHING`,
  )
    .bind(requestId, userId, amountMicros, JSON.stringify(usageEvent), Date.now(), Date.now())
    .run()
  const row = await env.DB.prepare(
    `SELECT user_id, amount_micros, usage_event_json
       FROM settlement_recovery
      WHERE request_id = ?`,
  )
    .bind(requestId)
    .first<{ user_id: string; amount_micros: number; usage_event_json: string }>()
  if (
    row === null ||
    row.user_id !== userId ||
    row.amount_micros !== amountMicros ||
    row.usage_event_json !== JSON.stringify(usageEvent)
  ) {
    throw new Error('Settlement recovery idempotency conflict')
  }
}

export async function settleRecoveryRequest(env: Env, requestId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT request_id, user_id, amount_micros, usage_event_json, attempts
       FROM settlement_recovery
      WHERE request_id = ? AND available_at_ms <= ?`,
  )
    .bind(requestId, Date.now())
    .first<SettlementRecoveryRow>()
  if (row === null) return false
  return settleRecoveryRow(env, row)
}

export async function recoverPendingSettlements(env: Env, limit = 25): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT request_id, user_id, amount_micros, usage_event_json, attempts
       FROM settlement_recovery
      WHERE available_at_ms <= ?
      ORDER BY available_at_ms, request_id
      LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<SettlementRecoveryRow>()
  let recovered = 0
  for (const row of result.results) {
    if (await settleRecoveryRow(env, row)) recovered += 1
  }
  return recovered
}

export async function signalSettlementRecovery(env: Env, requestId: string): Promise<void> {
  const event: PlatformEvent<{ request_id: string }> = {
    schema_version: 1,
    event_id: `settlement-retry:${requestId}:${crypto.randomUUID()}`,
    event_type: 'settlement.retry.v1',
    occurred_at_ms: Date.now(),
    aggregate_type: 'gateway_request',
    aggregate_id: requestId,
    payload: { request_id: requestId },
  }
  await env.EVENTS_QUEUE.send(event)
}

async function settleRecoveryRow(env: Env, row: SettlementRecoveryRow): Promise<boolean> {
  try {
    const event = JSON.parse(row.usage_event_json) as PlatformEvent<UsageSettledPayload>
    await settleUserReservation(env, row.user_id, row.request_id, row.amount_micros, event)
    await env.DB.prepare('DELETE FROM settlement_recovery WHERE request_id = ?')
      .bind(row.request_id)
      .run()
    return true
  } catch (error) {
    const nextAttempt = row.attempts + 1
    const exhausted = nextAttempt >= MAX_AUTOMATIC_ATTEMPTS
    const retryAt = exhausted
      ? Number.MAX_SAFE_INTEGER
      : Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 6))
    const errorText = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'
    await env.DB.prepare(
      `UPDATE settlement_recovery
          SET attempts = attempts + 1, available_at_ms = ?, last_error = ?
        WHERE request_id = ?`,
    )
      .bind(
        retryAt,
        `${exhausted ? 'manual_review: ' : ''}${errorText}`.slice(0, 500),
        row.request_id,
      )
      .run()
    return false
  }
}
