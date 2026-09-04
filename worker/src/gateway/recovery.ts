import type { Env, PlatformEvent, UsageSettledPayload } from '../env'
import {
  parseApiKeyMonetaryUsage,
  projectApiKeyMonetaryUsage,
  settleApiKeyMonetaryReservation,
  settleBillingReservation,
  type ApiKeyMonetaryReference,
  type BillingReference,
} from './state-client'

interface SettlementRecoveryRow {
  request_id: string
  user_id: string
  billing_type: 'balance' | 'subscription'
  subscription_id: string | null
  api_key_id: string | null
  amount_micros: number
  usage_event_json: string
  attempts: number
  billing_settled: number
  api_key_settled: number
  api_key_usage_json: string | null
  api_key_projected: number
}

const MAX_AUTOMATIC_ATTEMPTS = 20

export async function persistSettlementRecovery(
  env: Env,
  reference: BillingReference & ApiKeyMonetaryReference,
  requestId: string,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settlement_recovery (
       request_id, user_id, billing_type, subscription_id, api_key_id,
       amount_micros, usage_event_json, billing_settled, api_key_settled,
       api_key_usage_json, api_key_projected,
       attempts, available_at_ms, created_at_ms, last_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, 0, ?, ?, NULL)
     ON CONFLICT(request_id) DO NOTHING`,
  )
    .bind(
      requestId,
      reference.user_id,
      reference.billing.type,
      reference.billing.type === 'subscription' ? reference.billing.subscription_id : null,
      reference.api_key_id,
      amountMicros,
      JSON.stringify(usageEvent),
      Date.now(),
      Date.now(),
    )
    .run()
  const row = await env.DB.prepare(
    `SELECT user_id, billing_type, subscription_id, api_key_id, amount_micros, usage_event_json
       FROM settlement_recovery
      WHERE request_id = ?`,
  )
    .bind(requestId)
    .first<{
      user_id: string
      billing_type: 'balance' | 'subscription'
      subscription_id: string | null
      api_key_id: string | null
      amount_micros: number
      usage_event_json: string
    }>()
  if (
    row === null ||
    row.user_id !== reference.user_id ||
    row.billing_type !== reference.billing.type ||
    row.subscription_id !== (reference.billing.type === 'subscription' ? reference.billing.subscription_id : null) ||
    row.api_key_id !== reference.api_key_id ||
    row.amount_micros !== amountMicros ||
    row.usage_event_json !== JSON.stringify(usageEvent)
  ) {
    throw new Error('Settlement recovery idempotency conflict')
  }
}

export async function settleRecoveryRequest(
  env: Env,
  requestId: string,
  force = false,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT request_id, user_id, billing_type, subscription_id, api_key_id,
            amount_micros, usage_event_json, attempts, billing_settled,
            api_key_settled, api_key_usage_json, api_key_projected
       FROM settlement_recovery
      WHERE request_id = ? AND (available_at_ms <= ? OR ? = 1)`,
  )
    .bind(requestId, Date.now(), force ? 1 : 0)
    .first<SettlementRecoveryRow>()
  if (row === null) return false
  return settleRecoveryRow(env, row)
}

export async function recoverPendingSettlements(env: Env, limit = 25): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT request_id, user_id, billing_type, subscription_id, api_key_id,
            amount_micros, usage_event_json, attempts, billing_settled,
            api_key_settled, api_key_usage_json, api_key_projected
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
    const billing: BillingReference = row.billing_type === 'subscription'
      ? {
          user_id: row.user_id,
          billing: { type: 'subscription', subscription_id: requireSubscriptionId(row) },
        }
      : { user_id: row.user_id, billing: { type: 'balance' } }
    if (row.billing_settled !== 1) {
      await settleBillingReservation(env, billing, row.request_id, row.amount_micros, event)
      await markRecoveryStage(env, row.request_id, 'billing_settled')
      row.billing_settled = 1
    }
    if (row.api_key_settled !== 1 || row.api_key_projected !== 1) {
      const apiKeyId = requireApiKeyId(row, event)
      let usage = row.api_key_usage_json === null
        ? null
        : parseApiKeyMonetaryUsage(JSON.parse(row.api_key_usage_json), apiKeyId)
      if (row.api_key_settled !== 1 || usage === null) {
        usage = await settleApiKeyMonetaryReservation(
          env,
          { user_id: row.user_id, api_key_id: apiKeyId },
          row.request_id,
          row.amount_micros,
        )
        await env.DB.prepare(
          `UPDATE settlement_recovery
              SET api_key_settled = 1, api_key_usage_json = ?
            WHERE request_id = ?`,
        ).bind(JSON.stringify(usage), row.request_id).run()
        row.api_key_settled = 1
        row.api_key_usage_json = JSON.stringify(usage)
      }
      if (row.api_key_projected !== 1) {
        await projectApiKeyMonetaryUsage(env, usage)
        await markRecoveryStage(env, row.request_id, 'api_key_projected')
        row.api_key_projected = 1
      }
    }
    if (
      row.billing_settled !== 1 ||
      row.api_key_settled !== 1 ||
      row.api_key_projected !== 1
    ) return false
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

async function markRecoveryStage(
  env: Env,
  requestId: string,
  field: 'billing_settled' | 'api_key_projected',
): Promise<void> {
  await env.DB.prepare(
    `UPDATE settlement_recovery SET ${field} = 1 WHERE request_id = ?`,
  ).bind(requestId).run()
}

function requireSubscriptionId(row: SettlementRecoveryRow): string {
  if (typeof row.subscription_id !== 'string' || row.subscription_id === '') {
    throw new Error('Subscription settlement recovery is missing subscription_id')
  }
  return row.subscription_id
}

function requireApiKeyId(
  row: SettlementRecoveryRow,
  event: PlatformEvent<UsageSettledPayload>,
): string {
  const eventApiKeyId = event?.payload?.api_key_id
  const apiKeyId = row.api_key_id ?? eventApiKeyId
  if (
    typeof apiKeyId !== 'string' ||
    apiKeyId === '' ||
    typeof eventApiKeyId !== 'string' ||
    eventApiKeyId !== apiKeyId
  ) {
    throw new Error('Settlement recovery is missing a consistent API key identity')
  }
  return apiKeyId
}
