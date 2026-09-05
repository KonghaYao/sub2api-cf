import { deterministicUuid } from '../control/http'
import { synchronizeSubscriptionState } from '../control/subscriptions'
import { accrueAffiliateRebateForPaymentOrder } from '../commercial/affiliate'
import type { Env, PlatformEvent } from '../env'

const DAY_MS = 86_400_000
const MAX_DATE_MS = 8_640_000_000_000_000
const MAX_SAFE_INTEGER = 9_007_199_254_740_991
const FULFILLMENT_ACTION = 'subscription_entitlement'
const LEASE_MS = 60_000
const DEFAULT_RECOVERY_LIMIT = 10

export interface PaymentFulfillmentPayload {
  order_id: string
}

export interface PaymentFulfillmentResult {
  order_id: string
  subscription_id: string
  status: 'applied'
  idempotent: boolean
}

interface PaymentOrderRow {
  id: string
  user_id: string
  order_type: 'balance' | 'subscription'
  status: string
  plan_id: string | null
  plan_group_id_snapshot: string | null
  plan_validity_days_snapshot: number | null
  plan_daily_quota_micros_snapshot: number | null
  plan_weekly_quota_micros_snapshot: number | null
  plan_monthly_quota_micros_snapshot: number | null
  version: number
  subscription_id: string | null
}

interface SubscriptionEntitlementRow {
  id: string
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  starts_at_ms: number
  expires_at_ms: number
  control_version: number
}

interface SubscriptionEventRow {
  subscription_id: string
  event_type: 'assigned' | 'extended'
}

interface FulfillmentRow {
  id: string
  status: 'pending' | 'processing' | 'applied' | 'failed' | 'dead_letter'
  result_resource_id: string | null
  lease_owner: string | null
  lease_expires_at_ms: number | null
}

export function createPaymentFulfillmentEvent(
  orderId: string,
  now: number,
): PlatformEvent<PaymentFulfillmentPayload> {
  const normalizedOrderId = requireIdentifier(orderId, 'order_id')
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) {
    throw new TypeError('occurred_at_ms must be a safe timestamp')
  }
  return {
    schema_version: 1,
    event_id: `payment-fulfillment:${normalizedOrderId}`,
    event_type: 'payment.fulfillment.requested.v1',
    occurred_at_ms: now,
    aggregate_type: 'payment_order',
    aggregate_id: normalizedOrderId,
    payload: { order_id: normalizedOrderId },
  }
}

export function isPaymentFulfillmentEvent(
  value: unknown,
): value is PlatformEvent<PaymentFulfillmentPayload> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<PlatformEvent<Partial<PaymentFulfillmentPayload>>>
  const orderId = event.payload?.order_id
  return event.schema_version === 1 &&
    event.event_type === 'payment.fulfillment.requested.v1' &&
    event.aggregate_type === 'payment_order' &&
    typeof orderId === 'string' && orderId.length > 0 && orderId.length <= 200 &&
    event.aggregate_id === orderId &&
    event.event_id === `payment-fulfillment:${orderId}` &&
    typeof event.occurred_at_ms === 'number' &&
    Number.isSafeInteger(event.occurred_at_ms) &&
    event.occurred_at_ms >= 0 && event.occurred_at_ms <= MAX_DATE_MS
}

/**
 * Applies one paid subscription order. D1 owns the durable workflow; the
 * SubscriptionStateDO call happens after its replayable synchronization intent
 * commits, so a Worker interruption cannot grant the order twice.
 */
export async function fulfillPaymentOrder(
  env: Env,
  orderId: string,
): Promise<PaymentFulfillmentResult> {
  const normalizedOrderId = requireIdentifier(orderId, 'order_id')
  const initialOrder = await requireOrder(env, normalizedOrderId)
  const completedEvent = await findPaymentSubscriptionEvent(env, normalizedOrderId)
  if (initialOrder.status === 'COMPLETED') {
    if (completedEvent === null) {
      throw new Error('Completed payment order has no subscription fulfillment event')
    }
    await tryAccrueAffiliateRebate(env, normalizedOrderId)
    return appliedResult(normalizedOrderId, completedEvent.subscription_id, true)
  }
  assertFulfillableOrder(initialOrder)

  const startedAt = Date.now()
  await ensureFulfillment(env, normalizedOrderId, startedAt)
  const leaseOwner = crypto.randomUUID()
  const claimed = await claimFulfillment(env, normalizedOrderId, leaseOwner, startedAt)
  if (claimed === null) {
    const current = await findFulfillment(env, normalizedOrderId)
    if (current?.status === 'applied' && current.result_resource_id !== null) {
      return appliedResult(normalizedOrderId, current.result_resource_id, true)
    }
    if (current?.status === 'processing') {
      throw new Error('Payment fulfillment is already being processed')
    }
    throw new Error('Payment fulfillment could not be claimed')
  }

  try {
    const order = await requireOrder(env, normalizedOrderId)
    if (order.status === 'COMPLETED') {
      const event = await findPaymentSubscriptionEvent(env, normalizedOrderId)
      if (event === null) throw new Error('Completed payment order has no subscription fulfillment event')
      await tryAccrueAffiliateRebate(env, normalizedOrderId)
      return appliedResult(normalizedOrderId, event.subscription_id, true)
    }
    assertFulfillableOrder(order)

    let event = await findPaymentSubscriptionEvent(env, normalizedOrderId)
    const alreadyGranted = event !== null
    if (event === null) {
      event = await applySubscriptionEntitlement(env, order, claimed.id, leaseOwner, startedAt)
    }

    await synchronizeSubscriptionState(env, event.subscription_id)
    await finishFulfillment(env, normalizedOrderId, event.subscription_id, leaseOwner, Date.now())
    await tryAccrueAffiliateRebate(env, normalizedOrderId)
    return appliedResult(normalizedOrderId, event.subscription_id, alreadyGranted)
  } catch (error) {
    await recordFulfillmentFailure(env, normalizedOrderId, leaseOwner, error, Date.now())
    throw error
  }
}

async function tryAccrueAffiliateRebate(env: Env, orderId: string): Promise<void> {
  try {
    await accrueAffiliateRebateForPaymentOrder(env, orderId)
  } catch (error) {
    // The entitlement is already committed. Cron retries the idempotent rebate
    // projection without turning a successful purchase into a failed order.
    console.error('affiliate rebate accrual deferred', {
      order_id: orderId,
      name: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/** Reclaims due failed work and processing rows whose Worker lease expired. */
export async function recoverPendingPaymentFulfillments(
  env: Env,
  limit = DEFAULT_RECOVERY_LIMIT,
): Promise<number> {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 100)
    : DEFAULT_RECOVERY_LIMIT
  const now = Date.now()
  const rows = await env.DB.prepare(
    `SELECT order_id
       FROM payment_fulfillments
      WHERE action = ?
        AND (
          (status IN ('pending', 'failed') AND available_at_ms <= ?)
          OR (status = 'processing' AND lease_expires_at_ms <= ?)
        )
      ORDER BY available_at_ms ASC, updated_at_ms ASC, id ASC
      LIMIT ?`,
  ).bind(FULFILLMENT_ACTION, now, now, boundedLimit).all<{ order_id: string }>()

  let recovered = 0
  for (const row of rows.results) {
    try {
      await fulfillPaymentOrder(env, row.order_id)
      recovered += 1
    } catch (error) {
      console.error('payment fulfillment recovery deferred', {
        order_id: row.order_id,
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return recovered
}

async function applySubscriptionEntitlement(
  env: Env,
  order: PaymentOrderRow,
  fulfillmentId: string,
  leaseOwner: string,
  now: number,
): Promise<SubscriptionEventRow> {
  const snapshot = requireSubscriptionSnapshot(order)
  const existing = await env.DB.prepare(
    `SELECT id, status, starts_at_ms, expires_at_ms, control_version
       FROM user_subscriptions
      WHERE user_id = ? AND group_id = ? LIMIT 1`,
  ).bind(order.user_id, snapshot.groupId).first<SubscriptionEntitlementRow>()
  if (existing?.status === 'suspended' || existing?.status === 'revoked') {
    throw new Error(`Cannot fulfill payment into a ${existing.status} subscription`)
  }

  const durationMs = checkedDuration(snapshot.validityDays)
  const extending = existing?.status === 'active' && existing.expires_at_ms > now
  if (extending) checkedTimestampAdd(existing.expires_at_ms, durationMs)
  const subscriptionId = existing?.id ?? await deterministicUuid(
    'user.subscription.entitlement.v1',
    `${order.user_id}\0${snapshot.groupId}`,
  )
  const startsAtMs = extending ? existing.starts_at_ms : now
  const expiresAtMs = extending
    ? checkedTimestampAdd(existing.expires_at_ms, durationMs)
    : checkedTimestampAdd(now, durationMs)
  const dailyAnchorMs = expiresAtMs - startsAtMs <= DAY_MS ? startsAtMs : 0
  const dailyWindowStartMs = dailyAnchorMs + Math.floor((now - dailyAnchorMs) / DAY_MS) * DAY_MS
  const expectedControlVersion = existing?.control_version ?? -1
  const targetControlVersion = existing === null ? 0 : checkedIncrement(existing.control_version)
  const targetOrderVersion = order.status === 'PAID' ? checkedIncrement(order.version) : order.version
  const eventType = extending ? 'extended' : 'assigned'
  const eventId = await deterministicUuid('payment.subscription.event.v1', order.id)
  const intentId = await deterministicUuid(
    'subscription.state.sync.v1',
    `payment:${order.id}\0${subscriptionId}`,
  )
  const requestId = `payment:${order.id}`

  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE payment_orders
            SET status = 'RECHARGING',
                fulfillment_started_at_ms = COALESCE(fulfillment_started_at_ms, ?),
                last_error = NULL,
                version = CASE WHEN status = 'PAID' THEN version + 1 ELSE version END,
                updated_at_ms = MAX(updated_at_ms, ?)
          WHERE id = ? AND version = ? AND status IN ('PAID', 'RECHARGING')
            AND EXISTS (
              SELECT 1 FROM payment_fulfillments fulfillment
               WHERE fulfillment.id = ? AND fulfillment.status = 'processing'
                 AND fulfillment.lease_owner = ?
            )`,
      ).bind(now, now, order.id, order.version, fulfillmentId, leaseOwner),
      env.DB.prepare(
        `INSERT INTO user_subscriptions (
           id, user_id, group_id, plan_id, status, starts_at_ms, expires_at_ms,
           daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
           daily_used_micros, weekly_used_micros, monthly_used_micros,
           daily_anchor_ms, daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
           quota_reset_epoch, quota_reset_generation,
           source_type, source_id, notes, control_version, created_at_ms, updated_at_ms
         )
         SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 0, 0,
                'payment', ?, '', 0, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM payment_orders payment_order
            JOIN payment_fulfillments fulfillment ON fulfillment.order_id = payment_order.id
             AND fulfillment.action = ?
           WHERE payment_order.id = ? AND payment_order.status = 'RECHARGING'
             AND payment_order.version = ?
             AND fulfillment.id = ? AND fulfillment.status = 'processing'
             AND fulfillment.lease_owner = ?
          )
         ON CONFLICT(user_id, group_id) DO UPDATE SET
           plan_id = excluded.plan_id,
           status = 'active',
           starts_at_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.starts_at_ms
             ELSE excluded.starts_at_ms
           END,
           expires_at_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.expires_at_ms + ?
             ELSE excluded.expires_at_ms
           END,
           daily_quota_micros = excluded.daily_quota_micros,
           weekly_quota_micros = excluded.weekly_quota_micros,
           monthly_quota_micros = excluded.monthly_quota_micros,
           daily_used_micros = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.daily_used_micros ELSE 0 END,
           weekly_used_micros = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.weekly_used_micros ELSE 0 END,
           monthly_used_micros = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.monthly_used_micros ELSE 0 END,
           daily_anchor_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.daily_anchor_ms ELSE excluded.daily_anchor_ms END,
           daily_window_start_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.daily_window_start_ms ELSE excluded.daily_window_start_ms END,
           weekly_window_start_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.weekly_window_start_ms ELSE excluded.weekly_window_start_ms END,
           monthly_window_start_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.monthly_window_start_ms ELSE excluded.monthly_window_start_ms END,
           quota_reset_epoch = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.quota_reset_epoch ELSE user_subscriptions.quota_reset_epoch + 1 END,
           source_type = 'payment', source_id = excluded.source_id,
           control_version = user_subscriptions.control_version + 1,
           updated_at_ms = MAX(user_subscriptions.updated_at_ms, excluded.updated_at_ms)
         WHERE user_subscriptions.control_version = ?
           AND user_subscriptions.status NOT IN ('suspended', 'revoked')`,
      ).bind(
        subscriptionId,
        order.user_id,
        snapshot.groupId,
        snapshot.planId,
        startsAtMs,
        expiresAtMs,
        snapshot.dailyQuotaMicros,
        snapshot.weeklyQuotaMicros,
        snapshot.monthlyQuotaMicros,
        dailyAnchorMs,
        dailyWindowStartMs,
        now,
        now,
        order.id,
        now,
        now,
        FULFILLMENT_ACTION,
        order.id,
        targetOrderVersion,
        fulfillmentId,
        leaseOwner,
        now,
        now,
        durationMs,
        now,
        now,
        now,
        now,
        now,
        now,
        now,
        now,
        expectedControlVersion,
      ),
      env.DB.prepare(
        `INSERT INTO subscription_events (
           id, subscription_id, user_id, group_id, event_type,
           source_type, source_id, validity_days, occurred_at_ms
         )
         SELECT ?, subscription.id, subscription.user_id, subscription.group_id, ?,
                'payment', ?, ?, ?
           FROM user_subscriptions subscription
           JOIN payment_orders payment_order ON payment_order.id = ?
           JOIN payment_fulfillments fulfillment ON fulfillment.id = ?
          WHERE subscription.id = ?
            AND subscription.source_type = 'payment' AND subscription.source_id = ?
            AND subscription.control_version = ?
            AND payment_order.status = 'RECHARGING' AND payment_order.version = ?
            AND fulfillment.status = 'processing' AND fulfillment.lease_owner = ?`,
      ).bind(
        eventId,
        eventType,
        order.id,
        snapshot.validityDays,
        now,
        order.id,
        fulfillmentId,
        subscriptionId,
        order.id,
        targetControlVersion,
        targetOrderVersion,
        leaseOwner,
      ),
      subscriptionStateSyncStatement(
        env,
        requestId,
        intentId,
        eventId,
        subscriptionId,
        targetControlVersion,
        now,
      ),
      env.DB.prepare(
        `UPDATE payment_fulfillments
            SET result_resource_type = 'subscription', result_resource_id = ?,
                updated_at_ms = MAX(updated_at_ms, ?)
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
            AND EXISTS (SELECT 1 FROM subscription_events WHERE id = ?)`,
      ).bind(subscriptionId, now, fulfillmentId, leaseOwner, eventId),
    ])
  } catch (error) {
    const committed = await findPaymentSubscriptionEvent(env, order.id)
    if (committed !== null) return committed
    throw error
  }

  const committed = await findPaymentSubscriptionEvent(env, order.id)
  if (committed === null || committed.subscription_id !== subscriptionId) {
    throw new Error('Subscription entitlement CAS did not commit')
  }
  return committed
}

function subscriptionStateSyncStatement(
  env: Env,
  requestId: string,
  intentId: string,
  eventId: string,
  subscriptionId: string,
  controlVersion: number,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO subscription_state_sync (
       id, request_id, subscription_id, operation, control_version,
       payload_json, status, attempts, created_at_ms, updated_at_ms
     )
     SELECT ?, ?, subscription.id, 'configure', subscription.control_version,
            json_object(
              'configuration', json_object(
                'schema_version', 1,
                'subscription_id', subscription.id,
                'user_id', subscription.user_id,
                'group_id', subscription.group_id,
                'starts_at_ms', subscription.starts_at_ms,
                'expires_at_ms', subscription.expires_at_ms,
                'daily_quota_micros', subscription.daily_quota_micros,
                'weekly_quota_micros', subscription.weekly_quota_micros,
                'monthly_quota_micros', subscription.monthly_quota_micros,
                'daily_used_micros', subscription.daily_used_micros,
                'weekly_used_micros', subscription.weekly_used_micros,
                'monthly_used_micros', subscription.monthly_used_micros,
                'daily_anchor_ms', subscription.daily_anchor_ms,
                'daily_window_start_ms', subscription.daily_window_start_ms,
                'weekly_window_start_ms', subscription.weekly_window_start_ms,
                'monthly_window_start_ms', subscription.monthly_window_start_ms,
                'quota_reset_epoch', subscription.quota_reset_epoch,
                'quota_reset_generation', subscription.quota_reset_generation,
                'control_version', subscription.control_version,
                'enabled', json('true')
              )
            ),
            'pending', 0, ?, ?
       FROM user_subscriptions subscription
      WHERE subscription.id = ? AND subscription.control_version = ?
        AND EXISTS (SELECT 1 FROM subscription_events WHERE id = ?)`,
  ).bind(
    intentId,
    requestId,
    now,
    now,
    subscriptionId,
    controlVersion,
    eventId,
  )
}

async function ensureFulfillment(env: Env, orderId: string, now: number): Promise<void> {
  const id = await deterministicUuid('payment.fulfillment.v1', `${orderId}\0${FULFILLMENT_ACTION}`)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_fulfillments (
       id, order_id, action, status, attempts, available_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).bind(id, orderId, FULFILLMENT_ACTION, now, now, now).run()
}

async function claimFulfillment(
  env: Env,
  orderId: string,
  leaseOwner: string,
  now: number,
): Promise<Pick<FulfillmentRow, 'id' | 'result_resource_id'> | null> {
  return env.DB.prepare(
    `UPDATE payment_fulfillments
        SET status = 'processing', attempts = attempts + 1,
            lease_owner = ?, lease_expires_at_ms = ?, last_error = NULL,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE order_id = ? AND action = ?
        AND (
          (status IN ('pending', 'failed') AND available_at_ms <= ?)
          OR (status = 'processing' AND lease_expires_at_ms <= ?)
        )
      RETURNING id, result_resource_id`,
  ).bind(
    leaseOwner,
    checkedTimestampAdd(now, LEASE_MS),
    now,
    orderId,
    FULFILLMENT_ACTION,
    now,
    now,
  ).first<Pick<FulfillmentRow, 'id' | 'result_resource_id'>>()
}

async function finishFulfillment(
  env: Env,
  orderId: string,
  subscriptionId: string,
  leaseOwner: string,
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = 'COMPLETED', subscription_id = ?,
              subscription_fulfilled_at_ms = COALESCE(subscription_fulfilled_at_ms, ?),
              completed_at_ms = COALESCE(completed_at_ms, ?),
              last_error = NULL, version = version + 1,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND status = 'RECHARGING'
          AND EXISTS (
            SELECT 1 FROM payment_fulfillments fulfillment
             WHERE fulfillment.order_id = payment_orders.id
               AND fulfillment.action = ? AND fulfillment.status = 'processing'
               AND fulfillment.lease_owner = ?
          )`,
    ).bind(
      subscriptionId,
      now,
      now,
      now,
      orderId,
      FULFILLMENT_ACTION,
      leaseOwner,
    ),
    env.DB.prepare(
      `UPDATE payment_fulfillments
          SET status = 'applied', result_resource_type = 'subscription',
              result_resource_id = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
              last_error = NULL, applied_at_ms = COALESCE(applied_at_ms, ?),
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE order_id = ? AND action = ? AND status = 'processing'
          AND lease_owner = ?
          AND EXISTS (
            SELECT 1 FROM payment_orders payment_order
             WHERE payment_order.id = ? AND payment_order.status = 'COMPLETED'
               AND payment_order.subscription_id = ?
          )`,
    ).bind(
      subscriptionId,
      now,
      now,
      orderId,
      FULFILLMENT_ACTION,
      leaseOwner,
      orderId,
      subscriptionId,
    ),
  ])
  const completed = await env.DB.prepare(
    `SELECT fulfillment.status AS fulfillment_status,
            payment_order.status AS order_status
       FROM payment_fulfillments fulfillment
       JOIN payment_orders payment_order ON payment_order.id = fulfillment.order_id
      WHERE fulfillment.order_id = ? AND fulfillment.action = ?
        AND fulfillment.result_resource_id = ?`,
  ).bind(orderId, FULFILLMENT_ACTION, subscriptionId).first<{
    fulfillment_status: string
    order_status: string
  }>()
  if (completed?.fulfillment_status !== 'applied' || completed.order_status !== 'COMPLETED') {
    throw new Error('Payment fulfillment completion CAS did not commit')
  }
}

async function recordFulfillmentFailure(
  env: Env,
  orderId: string,
  leaseOwner: string,
  error: unknown,
  now: number,
): Promise<void> {
  const message = errorMessage(error).slice(0, 500)
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE payment_fulfillments
            SET status = 'failed', lease_owner = NULL, lease_expires_at_ms = NULL,
                last_error = ?, available_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
          WHERE order_id = ? AND action = ? AND status = 'processing'
            AND lease_owner = ?`,
      ).bind(message, now, now, orderId, FULFILLMENT_ACTION, leaseOwner),
      env.DB.prepare(
        `UPDATE payment_orders
            SET last_error = ?, updated_at_ms = MAX(updated_at_ms, ?)
          WHERE id = ? AND status IN ('PAID', 'RECHARGING')`,
      ).bind(message, now, orderId),
    ])
  } catch (recordError) {
    console.error('failed to record payment fulfillment failure', {
      order_id: orderId,
      name: recordError instanceof Error ? recordError.name : 'unknown',
    })
  }
}

async function requireOrder(env: Env, orderId: string): Promise<PaymentOrderRow> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, order_type, status, plan_id, plan_group_id_snapshot,
            plan_validity_days_snapshot, plan_daily_quota_micros_snapshot,
            plan_weekly_quota_micros_snapshot, plan_monthly_quota_micros_snapshot,
            version, subscription_id
       FROM payment_orders WHERE id = ?`,
  ).bind(orderId).first<PaymentOrderRow>()
  if (row === null) throw new Error('Payment order was not found')
  return row
}

async function findFulfillment(env: Env, orderId: string): Promise<FulfillmentRow | null> {
  return env.DB.prepare(
    `SELECT id, status, result_resource_id, lease_owner, lease_expires_at_ms
       FROM payment_fulfillments WHERE order_id = ? AND action = ?`,
  ).bind(orderId, FULFILLMENT_ACTION).first<FulfillmentRow>()
}

async function findPaymentSubscriptionEvent(
  env: Env,
  orderId: string,
): Promise<SubscriptionEventRow | null> {
  return env.DB.prepare(
    `SELECT subscription_id, event_type
       FROM subscription_events
      WHERE source_type = 'payment' AND source_id = ?
        AND event_type IN ('assigned', 'extended')
      ORDER BY occurred_at_ms ASC, id ASC LIMIT 1`,
  ).bind(orderId).first<SubscriptionEventRow>()
}

function assertFulfillableOrder(order: PaymentOrderRow): void {
  if (order.order_type !== 'subscription') {
    throw new Error('Only subscription payment orders can use subscription fulfillment')
  }
  if (order.status !== 'PAID' && order.status !== 'RECHARGING') {
    throw new Error(`Payment order status ${order.status} cannot be fulfilled`)
  }
}

function requireSubscriptionSnapshot(order: PaymentOrderRow): {
  planId: string
  groupId: string
  validityDays: number
  dailyQuotaMicros: number | null
  weeklyQuotaMicros: number | null
  monthlyQuotaMicros: number | null
} {
  const planId = requireIdentifier(order.plan_id, 'plan_id')
  const groupId = requireIdentifier(order.plan_group_id_snapshot, 'plan_group_id_snapshot')
  const validityDays = order.plan_validity_days_snapshot
  if (!Number.isSafeInteger(validityDays) || validityDays === null || validityDays < 1 || validityDays > 36_500) {
    throw new Error('Payment order has an invalid plan validity snapshot')
  }
  for (const [name, value] of [
    ['daily quota', order.plan_daily_quota_micros_snapshot],
    ['weekly quota', order.plan_weekly_quota_micros_snapshot],
    ['monthly quota', order.plan_monthly_quota_micros_snapshot],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_INTEGER)) {
      throw new Error(`Payment order has an invalid ${name} snapshot`)
    }
  }
  return {
    planId,
    groupId,
    validityDays,
    dailyQuotaMicros: order.plan_daily_quota_micros_snapshot,
    weeklyQuotaMicros: order.plan_weekly_quota_micros_snapshot,
    monthlyQuotaMicros: order.plan_monthly_quota_micros_snapshot,
  }
}

function checkedDuration(validityDays: number): number {
  const duration = validityDays * DAY_MS
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('Subscription duration is invalid')
  return duration
}

function checkedTimestampAdd(timestamp: number, delta: number): number {
  const result = timestamp + delta
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_DATE_MS) {
    throw new Error('Subscription timestamp exceeds the supported range')
  }
  return result
}

function checkedIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_SAFE_INTEGER) {
    throw new Error('Control version exceeds the supported range')
  }
  return value + 1
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TypeError(`${field} must be a non-empty identifier`)
  }
  return value
}

function appliedResult(
  orderId: string,
  subscriptionId: string,
  idempotent: boolean,
): PaymentFulfillmentResult {
  return { order_id: orderId, subscription_id: subscriptionId, status: 'applied', idempotent }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
