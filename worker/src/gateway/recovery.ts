import type { Env, PlatformEvent, UsageSettledPayload } from '../env'
import {
  ensureApiKeyMonetaryReservation,
  ensureBillingReservation,
  ensurePlatformQuotaReservation,
  parseApiKeyMonetaryUsage,
  parsePlatformQuotaUsage,
  projectApiKeyMonetaryUsage,
  projectPlatformQuotaUsage,
  settleApiKeyMonetaryReservation,
  settleBillingReservation,
  settlePlatformQuotaReservation,
  type ApiKeyMonetaryReference,
  type BillingReference,
  type PlatformQuotaReference,
} from './state-client'
import type { PlatformQuotaPolicy } from './types'

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
  platform_quota_platform: PlatformQuotaPolicy['platform'] | null
  platform_quota_settled: number
  platform_quota_usage_json: string | null
  platform_quota_projected: number
  initial_reserved_micros: number | null
  reservations_ensured: number
}

const MAX_AUTOMATIC_ATTEMPTS = 20

export interface SettlementCommandPayload {
  request_id: string
  user_id: string
  billing_type: 'balance' | 'subscription'
  subscription_id: string | null
  api_key_id: string
  platform_quota_platform: PlatformQuotaPolicy['platform'] | null
  amount_micros: number
  usage_event: PlatformEvent<UsageSettledPayload>
}

export interface SettlementCommandV2Payload extends SettlementCommandPayload {
  initial_reserved_micros: number
}

export type SettlementCommandEvent =
  | PlatformEvent<SettlementCommandPayload>
  | PlatformEvent<SettlementCommandV2Payload>

export function createSettlementCommandEvent(
  reference: BillingReference & ApiKeyMonetaryReference & PlatformQuotaReference,
  requestId: string,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): PlatformEvent<SettlementCommandPayload> {
  const payload: SettlementCommandPayload = {
    request_id: requestId,
    user_id: reference.user_id,
    billing_type: reference.billing.type,
    subscription_id: reference.billing.type === 'subscription' ? reference.billing.subscription_id : null,
    api_key_id: reference.api_key_id,
    platform_quota_platform: reference.billing.type === 'balance'
      ? reference.platform_quota?.platform ?? null
      : null,
    amount_micros: amountMicros,
    usage_event: usageEvent,
  }
  return {
    schema_version: 1,
    event_id: `settlement-command:${requestId}`,
    event_type: 'settlement.command.v1',
    occurred_at_ms: Date.now(),
    aggregate_type: 'gateway_request',
    aggregate_id: requestId,
    payload,
  }
}

export function createSettlementCommandEventV2(
  reference: BillingReference & ApiKeyMonetaryReference & PlatformQuotaReference,
  requestId: string,
  initialReservedMicros: number,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): PlatformEvent<SettlementCommandV2Payload> {
  const legacy = createSettlementCommandEvent(reference, requestId, amountMicros, usageEvent)
  return {
    ...legacy,
    event_type: 'settlement.command.v2',
    payload: {
      ...legacy.payload,
      initial_reserved_micros: initialReservedMicros,
    },
  }
}

export function isSettlementCommandEvent(value: unknown): value is SettlementCommandEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<PlatformEvent<Partial<SettlementCommandV2Payload>>>
  const payload = event.payload
  const versionMatches = (
    event.schema_version === 1 && event.event_type === 'settlement.command.v1' &&
    payload?.initial_reserved_micros === undefined
  ) || (
    event.schema_version === 1 && event.event_type === 'settlement.command.v2' &&
    Number.isSafeInteger(payload?.initial_reserved_micros) &&
    (payload?.initial_reserved_micros as number) >= 0
  )
  return versionMatches &&
    typeof event.event_id === 'string' && typeof event.aggregate_id === 'string' &&
    payload !== null && typeof payload === 'object' &&
    event.event_id === `settlement-command:${payload.request_id ?? ''}` &&
    event.aggregate_id === payload.request_id &&
    typeof payload.user_id === 'string' && typeof payload.api_key_id === 'string' &&
    (payload.billing_type === 'balance' || payload.billing_type === 'subscription') &&
    (payload.billing_type === 'balance' ? payload.subscription_id === null : typeof payload.subscription_id === 'string') &&
    Number.isSafeInteger(payload.amount_micros) && (payload.amount_micros as number) >= 0 &&
    payload.usage_event !== null && typeof payload.usage_event === 'object' &&
    payload.usage_event.event_type === 'usage.settled.v1' &&
    payload.usage_event.payload?.request_id === payload.request_id
}

export async function enqueueSettlementCommand(
  env: Env,
  reference: BillingReference & ApiKeyMonetaryReference & PlatformQuotaReference,
  requestId: string,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): Promise<void> {
  await env.EVENTS_QUEUE.send(createSettlementCommandEvent(reference, requestId, amountMicros, usageEvent))
}

export async function enqueueSettlementCommandV2(
  env: Env,
  reference: BillingReference & ApiKeyMonetaryReference & PlatformQuotaReference,
  requestId: string,
  initialReservedMicros: number,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
): Promise<void> {
  await env.EVENTS_QUEUE.send(createSettlementCommandEventV2(
    reference,
    requestId,
    initialReservedMicros,
    amountMicros,
    usageEvent,
  ))
}

export async function consumeSettlementCommand(
  env: Env,
  event: SettlementCommandEvent,
): Promise<void> {
  const payload = event.payload
  const reference: BillingReference & ApiKeyMonetaryReference & PlatformQuotaReference = {
    user_id: payload.user_id,
    api_key_id: payload.api_key_id,
    billing: payload.billing_type === 'subscription'
      ? { type: 'subscription', subscription_id: payload.subscription_id as string }
      : { type: 'balance' },
    platform_quota: payload.platform_quota_platform === null
      ? null
      : { platform: payload.platform_quota_platform },
  }
  await persistSettlementRecovery(
    env,
    reference,
    payload.request_id,
    payload.amount_micros,
    payload.usage_event,
    event.event_type === 'settlement.command.v2'
      ? (payload as SettlementCommandV2Payload).initial_reserved_micros
      : undefined,
  )
  if (!await settleRecoveryRequest(env, payload.request_id, true)) {
    throw new Error('Queued settlement command did not complete')
  }
}

export async function persistSettlementRecovery(
  env: Env,
  reference: BillingReference & ApiKeyMonetaryReference & PlatformQuotaReference,
  requestId: string,
  amountMicros: number,
  usageEvent: PlatformEvent<UsageSettledPayload>,
  initialReservedMicros?: number,
): Promise<void> {
  const platform = reference.billing.type === 'balance'
    ? reference.platform_quota?.platform ?? null
    : null
  if (initialReservedMicros !== undefined) {
    const now = Date.now()
    const reservationsEnsured = initialReservedMicros >= amountMicros ? 1 : 0
    await env.DB.prepare(
      `INSERT INTO settlement_recovery (
         request_id, user_id, billing_type, subscription_id, api_key_id,
         amount_micros, usage_event_json, billing_settled, api_key_settled,
         api_key_usage_json, api_key_projected, platform_quota_platform,
         platform_quota_settled, platform_quota_usage_json, platform_quota_projected,
         initial_reserved_micros, reservations_ensured,
         attempts, available_at_ms, created_at_ms, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?, NULL, ?, ?, ?, 0, ?, ?, NULL)
       ON CONFLICT(request_id) DO NOTHING`,
    ).bind(
      requestId,
      reference.user_id,
      reference.billing.type,
      reference.billing.type === 'subscription' ? reference.billing.subscription_id : null,
      reference.api_key_id,
      amountMicros,
      JSON.stringify(usageEvent),
      platform,
      platform !== null ? 0 : 1,
      platform !== null ? 0 : 1,
      initialReservedMicros,
      reservationsEnsured,
      reservationsEnsured === 1 ? now : Number.MAX_SAFE_INTEGER,
      now,
    ).run()
  } else try {
    await env.DB.prepare(
    `INSERT INTO settlement_recovery (
       request_id, user_id, billing_type, subscription_id, api_key_id,
       amount_micros, usage_event_json, billing_settled, api_key_settled,
       api_key_usage_json, api_key_projected, platform_quota_platform,
       platform_quota_settled, platform_quota_usage_json, platform_quota_projected,
       attempts, available_at_ms, created_at_ms, last_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?, NULL, ?, 0, ?, ?, NULL)
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
      platform,
      platform !== null ? 0 : 1,
      platform !== null ? 0 : 1,
      Date.now(),
      Date.now(),
    )
    .run()
  } catch (error) {
    // Expand/contract compatibility for an older D1 schema during a rolling
    // deploy. Such a row has no platform reservation and remains complete for
    // the two platform stages once migration 0031 supplies their defaults.
    if (!missingSettlementExpansionColumn(error)) throw error
    await env.DB.prepare(
      `INSERT INTO settlement_recovery (
         request_id, user_id, billing_type, subscription_id, api_key_id,
         amount_micros, usage_event_json, billing_settled, api_key_settled,
         api_key_usage_json, api_key_projected,
         attempts, available_at_ms, created_at_ms, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, 0, ?, ?, NULL)
       ON CONFLICT(request_id) DO NOTHING`,
    ).bind(
      requestId, reference.user_id, reference.billing.type,
      reference.billing.type === 'subscription' ? reference.billing.subscription_id : null,
      reference.api_key_id, amountMicros, JSON.stringify(usageEvent), Date.now(), Date.now(),
    ).run()
  }
  type IdentityRow = {
      user_id: string
      billing_type: 'balance' | 'subscription'
      subscription_id: string | null
      api_key_id: string | null
      amount_micros: number
      usage_event_json: string
      platform_quota_platform: string | null
      initial_reserved_micros: number | null
      reservations_ensured: number
  }
  let row: IdentityRow | null
  try {
    row = await env.DB.prepare(
      `SELECT user_id, billing_type, subscription_id, api_key_id, amount_micros,
              usage_event_json, platform_quota_platform,
              initial_reserved_micros, reservations_ensured
         FROM settlement_recovery WHERE request_id = ?`,
    ).bind(requestId).first<IdentityRow>()
  } catch (error) {
    if (!missingSettlementExpansionColumn(error)) throw error
    row = await env.DB.prepare(
      `SELECT user_id, billing_type, subscription_id, api_key_id, amount_micros,
              usage_event_json, NULL AS platform_quota_platform,
              NULL AS initial_reserved_micros, 1 AS reservations_ensured
         FROM settlement_recovery WHERE request_id = ?`,
    ).bind(requestId).first<IdentityRow>()
  }
  if (
    row === null ||
    row.user_id !== reference.user_id ||
    row.billing_type !== reference.billing.type ||
    row.subscription_id !== (reference.billing.type === 'subscription' ? reference.billing.subscription_id : null) ||
    row.api_key_id !== reference.api_key_id ||
    row.amount_micros !== amountMicros ||
    row.usage_event_json !== JSON.stringify(usageEvent) ||
    (row.platform_quota_platform ?? null) !== platform ||
    (initialReservedMicros !== undefined && (
      row.initial_reserved_micros !== initialReservedMicros
    ))
  ) {
    throw new Error('Settlement recovery idempotency conflict')
  }
}

export async function settleRecoveryRequest(
  env: Env,
  requestId: string,
  force = false,
): Promise<boolean> {
  let row: SettlementRecoveryRow | null
  try {
    row = await env.DB.prepare(
      `SELECT request_id, user_id, billing_type, subscription_id, api_key_id,
            amount_micros, usage_event_json, attempts, billing_settled,
            api_key_settled, api_key_usage_json, api_key_projected,
            platform_quota_platform, platform_quota_settled,
            platform_quota_usage_json, platform_quota_projected,
            initial_reserved_micros, reservations_ensured
       FROM settlement_recovery
      WHERE request_id = ? AND (available_at_ms <= ? OR ? = 1)`,
    ).bind(requestId, Date.now(), force ? 1 : 0).first<SettlementRecoveryRow>()
  } catch (error) {
    if (!missingSettlementExpansionColumn(error)) throw error
    row = await env.DB.prepare(
      `SELECT request_id, user_id, billing_type, subscription_id, api_key_id,
              amount_micros, usage_event_json, attempts, billing_settled,
              api_key_settled, api_key_usage_json, api_key_projected,
              NULL AS platform_quota_platform, 1 AS platform_quota_settled,
              NULL AS platform_quota_usage_json, 1 AS platform_quota_projected,
              NULL AS initial_reserved_micros, 1 AS reservations_ensured
         FROM settlement_recovery
        WHERE request_id = ? AND (available_at_ms <= ? OR ? = 1)`,
    ).bind(requestId, Date.now(), force ? 1 : 0).first<SettlementRecoveryRow>()
  }
  if (row === null) return false
  return settleRecoveryRow(env, row)
}

export async function recoverPendingSettlements(env: Env, limit = 25): Promise<number> {
  let rows: SettlementRecoveryRow[]
  try {
    const result = await env.DB.prepare(
      `SELECT request_id, user_id, billing_type, subscription_id, api_key_id,
            amount_micros, usage_event_json, attempts, billing_settled,
            api_key_settled, api_key_usage_json, api_key_projected,
            platform_quota_platform, platform_quota_settled,
            platform_quota_usage_json, platform_quota_projected,
            initial_reserved_micros, reservations_ensured
       FROM settlement_recovery
      WHERE (reservations_ensured = 0 AND attempts < ?)
         OR (reservations_ensured = 1 AND available_at_ms <= ?)
      ORDER BY reservations_ensured, available_at_ms, request_id
      LIMIT ?`,
    ).bind(MAX_AUTOMATIC_ATTEMPTS, Date.now(), limit).all<SettlementRecoveryRow>()
    rows = result.results
  } catch (error) {
    if (!missingSettlementExpansionColumn(error)) throw error
    const result = await env.DB.prepare(
      `SELECT request_id, user_id, billing_type, subscription_id, api_key_id,
              amount_micros, usage_event_json, attempts, billing_settled,
              api_key_settled, api_key_usage_json, api_key_projected,
              NULL AS platform_quota_platform, 1 AS platform_quota_settled,
              NULL AS platform_quota_usage_json, 1 AS platform_quota_projected,
              NULL AS initial_reserved_micros, 1 AS reservations_ensured
         FROM settlement_recovery WHERE available_at_ms <= ?
        ORDER BY available_at_ms, request_id LIMIT ?`,
    ).bind(Date.now(), limit).all<SettlementRecoveryRow>()
    rows = result.results
  }
  let recovered = 0
  for (const row of rows) {
    if (await settleRecoveryRow(env, row)) recovered += 1
  }
  return recovered
}

function missingSettlementExpansionColumn(error: unknown): boolean {
  return error instanceof Error &&
    /(?:no such column|has no column named)[: ]+(?:platform_quota_|initial_reserved_micros|reservations_ensured)/i.test(error.message)
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
    // Pre-0048 rows (and rolling-deploy readers) have no barrier column and
    // already reserved their final amount. Only an explicit v2 zero may enter
    // the multi-authority ensure phase.
    if (row.reservations_ensured === 0) {
      const apiKeyId = requireApiKeyId(row, event)
      await ensureBillingReservation(env, billing, row.request_id, row.amount_micros)
      await ensureApiKeyMonetaryReservation(
        env,
        { user_id: row.user_id, api_key_id: apiKeyId },
        row.request_id,
        row.amount_micros,
      )
      await ensurePlatformQuotaReservation(
        env,
        {
          ...billing,
          platform_quota: row.platform_quota_platform == null
            ? null
            : { platform: row.platform_quota_platform },
        },
        row.request_id,
        row.amount_micros,
      )
      await markRecoveryStage(env, row.request_id, 'reservations_ensured')
      row.reservations_ensured = 1
    }
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
    if (row.platform_quota_platform !== null && row.platform_quota_platform !== undefined) {
      let usage = row.platform_quota_usage_json == null
        ? null
        : parsePlatformQuotaUsage(
            JSON.parse(row.platform_quota_usage_json),
            row.user_id,
            row.platform_quota_platform,
          )
      if (row.platform_quota_settled !== 1 || usage === null) {
        usage = await settlePlatformQuotaReservation(
          env,
          {
            user_id: row.user_id,
            billing: { type: 'balance' },
            platform_quota: { platform: row.platform_quota_platform },
          },
          row.request_id,
          row.amount_micros,
        )
        if (usage === null) throw new Error('Platform quota settlement returned no usage')
        await env.DB.prepare(
          `UPDATE settlement_recovery
              SET platform_quota_settled = 1, platform_quota_usage_json = ?
            WHERE request_id = ?`,
        ).bind(JSON.stringify(usage), row.request_id).run()
        row.platform_quota_settled = 1
        row.platform_quota_usage_json = JSON.stringify(usage)
      }
      if (row.platform_quota_projected !== 1) {
        await projectPlatformQuotaUsage(env, usage)
        await markRecoveryStage(env, row.request_id, 'platform_quota_projected')
        row.platform_quota_projected = 1
      }
    }
    if (
      row.billing_settled !== 1 ||
      row.api_key_settled !== 1 ||
      row.api_key_projected !== 1 ||
      (row.platform_quota_platform != null && (
        row.platform_quota_settled !== 1 || row.platform_quota_projected !== 1
      ))
    ) return false
    await env.DB.prepare('DELETE FROM settlement_recovery WHERE request_id = ?')
      .bind(row.request_id)
      .run()
    return true
  } catch (error) {
    const nextAttempt = row.attempts + 1
    const exhausted = nextAttempt >= MAX_AUTOMATIC_ATTEMPTS
    const retryAt = row.reservations_ensured === 0
      ? Number.MAX_SAFE_INTEGER
      : exhausted
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
  field: 'reservations_ensured' | 'billing_settled' | 'api_key_projected' | 'platform_quota_projected',
): Promise<void> {
  if (field === 'reservations_ensured') {
    await env.DB.prepare(
      `UPDATE settlement_recovery
          SET reservations_ensured = 1, available_at_ms = ?
        WHERE request_id = ?`,
    ).bind(Date.now(), requestId).run()
    return
  }
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
