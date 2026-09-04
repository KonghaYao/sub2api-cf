import type { Context } from 'hono'

import { authenticateUserRequest } from '../auth/handler'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  optionalBoolean,
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
  requireString,
} from '../control/http'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  decryptPaymentProviderConfig,
  type PaymentProviderRow,
} from './config'
import { microsToMinorUnits, minorUnitsToMicros } from './currency'
import { findOrder, requireOrder, type PaymentOrderRow } from './orders'
import { StripeAdapterError, StripeClient, type StripeRefund } from './stripe'

type PaymentBindings = { Bindings: Env }

const PROVIDER_COLUMNS = `id, schema_version, provider_key, provider_type, display_name,
  config_ciphertext, config_nonce, config_key_id, enabled, version, created_at_ms, updated_at_ms`

export async function getRefundEligibleProviders(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    await authenticateUserRequest(context.req.raw, context.env)
    const result = await context.env.DB.prepare(
      `SELECT ${PROVIDER_COLUMNS}
       FROM payment_provider_instances
        WHERE provider_type = 'stripe' AND enabled = 1
        ORDER BY created_at_ms ASC, id ASC`,
    ).all<PaymentProviderRow>()
    const eligible: string[] = []
    for (const row of result.results) {
      const credential = await decryptPaymentProviderConfig(context.env, row)
      if (credential.refund_enabled && credential.allow_user_refund) eligible.push(row.id)
    }
    return controlSuccess({ provider_instance_ids: eligible })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function requestPaymentRefund(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    const body = await readJsonObject(context.req.raw)
    const reason = requireString(body, 'reason', 1_000)
    const refundId = await deterministicUuid('payment-refund-user-request:v1', `${orderId}\0${user.id}`)
    const requestHash = await sha256Hex(
      `payment-refund-user-request:v2\0${orderId}\0${user.id}\0${reason}`,
    )
    const existing = await findRefund(context.env, refundId)
    if (existing !== null) {
      if (
        existing.order_id !== orderId ||
        existing.requested_by_user_id !== user.id ||
        existing.request_key_hash !== requestHash ||
        existing.reason !== reason
      ) {
        throw new GatewayError(409, 'refund_request_conflict', 'Refund request conflicts with existing state')
      }
      return controlSuccess({ message: 'refund requested' })
    }

    const order = await findOrder(context.env, orderId, user.id)
    if (order === null) throw refundOrderNotFound()
    validateUserRefundOrder(order, user.balance_micros)
    const provider = await requireRefundProvider(context.env, order)
    if (!provider.credential.refund_enabled || !provider.credential.allow_user_refund) {
      throw new GatewayError(403, 'user_refund_disabled', 'User refund is not enabled for this provider', 'permission_error')
    }
    throw refundClawbackUnavailable()
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function processAdminRefund(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const input = parseAdminRefundInput(body)
    requireCourtesyRefund(input.deductBalance)
    const order = await requireOrder(context.env, orderId)
    const amountMicros = exactMajorMicros(input.amount, 'amount')
    gatewayRefundMicros(order, amountMicros)
    const requestKeyHash = await sha256Hex(
      `payment-refund-admin-idempotency:v1\0${order.id}\0${idempotencyKey}`,
    )

    let refund = await findRefundByRequest(context.env, order.id, requestKeyHash)
    if (refund !== null) {
      assertRefundReplay(refund, order, amountMicros, input.reason)
      const replay = completedRefundResult(refund)
      if (replay !== null) return controlSuccess(replay)
      if (refund.status === 'pending') return controlSuccess(pendingRefundResult())
    } else {
      const existing = await findOrderRefund(context.env, order.id)
      if (existing !== null) {
        assertRefundReplay(existing, order, amountMicros, input.reason, false)
        const replay = completedRefundResult(existing)
        if (replay !== null) return controlSuccess(replay)
        if (existing.status === 'pending') return controlSuccess(pendingRefundResult())
        refund = existing
      }
    }

    validateAdminRefundOrder(order, amountMicros, input.deductBalance)
    const provider = await requireRefundProvider(context.env, order)
    if (!provider.credential.refund_enabled) {
      throw new GatewayError(403, 'refund_disabled', 'Refunds are not enabled for this provider', 'permission_error')
    }
    if (!order.payment_intent_id) {
      throw new GatewayError(409, 'stripe_payment_intent_missing', 'Stripe payment intent is missing')
    }

    refund = await claimAdminRefund(context.env, order, {
      refund,
      requestKeyHash,
      amountMicros,
      reason: input.reason,
    })
    const claimedOrder = await requireOrder(context.env, order.id)
    const stripe = new StripeClient({ secretKey: provider.credential.api_key })
    let providerRefund: StripeRefund
    try {
      providerRefund = await stripe.createRefund({
        orderId: order.id,
        paymentIntentId: order.payment_intent_id,
        amountMinor: microsToMinorUnits(
          gatewayRefundMicros(order, refund.amount_micros),
          refund.currency,
        ),
      })
      validateProviderRefund(providerRefund, order, refund)
    } catch (error) {
      await markRefundFailure(context.env, claimedOrder, refund, error, providerRefund!)
      throw error
    }

    if (providerRefund.status === 'succeeded') {
      const finalized = await finalizeRefundSuccess(
        context.env,
        claimedOrder,
        refund,
        providerRefund,
      )
      return controlSuccess(finalized)
    }
    if (providerRefund.status === 'pending' || providerRefund.status === 'requires_action') {
      await markRefundPending(context.env, claimedOrder, refund, providerRefund)
      return controlSuccess(pendingRefundResult())
    }

    await markRefundFailure(
      context.env,
      claimedOrder,
      refund,
      new Error(`Stripe refund ${providerRefund.status}`),
      providerRefund,
    )
    return controlSuccess({ success: false, warning: `Stripe refund ${providerRefund.status}` })
  } catch (error) {
    return controlError(refundError(error))
  }
}

export async function queryAdminRefund(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    const order = await requireOrder(context.env, orderId)
    const refund = await findOrderRefund(context.env, order.id)
    if (refund === null) {
      throw new GatewayError(404, 'payment_refund_not_found', 'Payment refund was not found')
    }
    const replay = completedRefundResult(refund)
    if (replay !== null) return controlSuccess(replay)
    if (!['REFUNDING', 'REFUND_PENDING', 'REFUND_FAILED'].includes(order.status)) {
      throw new GatewayError(409, 'invalid_refund_status', `Order status ${order.status} cannot be queried`)
    }
    const provider = await requireRefundProvider(context.env, order)
    const stripe = new StripeClient({ secretKey: provider.credential.api_key })
    let activeOrder = order
    let activeRefund = refund
    let providerRefund: StripeRefund
    if (refund.provider_refund_id) {
      providerRefund = await stripe.retrieveRefund(refund.provider_refund_id)
      validateProviderRefund(providerRefund, activeOrder, activeRefund)
    } else {
      if (
        order.status !== 'REFUND_FAILED' ||
        (refund.status !== 'failed' && refund.status !== 'cancelled')
      ) {
        throw new GatewayError(
          409,
          'stripe_refund_id_missing',
          'Stripe refund id is unavailable and the persisted refund cannot be retried',
        )
      }
      if (!order.payment_intent_id) {
        throw new GatewayError(409, 'stripe_payment_intent_missing', 'Stripe payment intent is missing')
      }
      activeRefund = await claimAdminRefund(context.env, order, {
        refund,
        requestKeyHash: refund.request_key_hash,
        amountMicros: refund.amount_micros,
        reason: refund.reason,
      })
      activeOrder = await requireOrder(context.env, order.id)
      try {
        providerRefund = await stripe.createRefund({
          orderId: activeOrder.id,
          paymentIntentId: order.payment_intent_id,
          amountMinor: microsToMinorUnits(
            gatewayRefundMicros(activeOrder, activeRefund.amount_micros),
            activeRefund.currency,
          ),
        })
        validateProviderRefund(providerRefund, activeOrder, activeRefund)
      } catch (error) {
        await markRefundFailure(context.env, activeOrder, activeRefund, error, providerRefund!)
        throw error
      }
    }
    if (providerRefund.status === 'succeeded') {
      return controlSuccess(
        await finalizeRefundSuccess(context.env, activeOrder, activeRefund, providerRefund),
      )
    }
    if (providerRefund.status === 'pending' || providerRefund.status === 'requires_action') {
      if (activeOrder.status === 'REFUNDING') {
        await markRefundPending(context.env, activeOrder, activeRefund, providerRefund)
      }
      return controlSuccess(pendingRefundResult())
    }
    await markRefundFailure(
      context.env,
      activeOrder,
      activeRefund,
      new Error(`Stripe refund ${providerRefund.status}`),
      providerRefund,
    )
    return controlSuccess({ success: false, warning: `Stripe refund ${providerRefund.status}` })
  } catch (error) {
    return controlError(refundError(error))
  }
}

interface RefundRow {
  id: string
  order_id: string
  request_key_hash: string
  provider_key: string
  provider_refund_id: string | null
  amount_micros: number
  settled_amount_micros: number
  currency: string
  status: 'requested' | 'processing' | 'pending' | 'partially_refunded' | 'refunded' | 'failed' | 'cancelled'
  reason: string
  requested_by_user_id: string | null
  last_error: string | null
  created_at_ms: number
  updated_at_ms: number
  completed_at_ms: number | null
}

interface RefundProvider {
  row: PaymentProviderRow
  credential: Awaited<ReturnType<typeof decryptPaymentProviderConfig>>
}

async function findRefund(env: Env, id: string): Promise<RefundRow | null> {
  return env.DB.prepare(
    `SELECT id, order_id, request_key_hash, provider_key, provider_refund_id,
            amount_micros, settled_amount_micros, currency, status, reason,
            requested_by_user_id, last_error, created_at_ms, updated_at_ms, completed_at_ms
       FROM payment_refunds WHERE id = ?`,
  ).bind(id).first<RefundRow>()
}

async function requireRefundProvider(env: Env, order: PaymentOrderRow): Promise<RefundProvider> {
  const row = await env.DB.prepare(
    `SELECT ${PROVIDER_COLUMNS}
       FROM payment_provider_instances
      WHERE id = ? AND provider_type = 'stripe'`,
  ).bind(order.provider_instance_id).first<PaymentProviderRow>()
  if (row === null || row.provider_key !== order.provider_key_snapshot) {
    throw new GatewayError(409, 'refund_provider_mismatch', 'Refund provider does not match the order snapshot')
  }
  return { row, credential: await decryptPaymentProviderConfig(env, row) }
}

function validateUserRefundOrder(order: PaymentOrderRow, balanceMicros: number): void {
  if (order.order_type !== 'balance') {
    throw new GatewayError(400, 'invalid_order_type', 'Only balance orders can request a refund')
  }
  if (order.status !== 'COMPLETED') {
    throw new GatewayError(400, 'invalid_status', 'Only completed orders can request a refund')
  }
  if (!Number.isSafeInteger(order.paid_amount_micros) || order.paid_amount_micros <= 0) {
    throw new GatewayError(409, 'invalid_paid_amount', 'Payment order paid amount is invalid')
  }
  if (!Number.isSafeInteger(balanceMicros) || balanceMicros < order.amount_micros) {
    throw new GatewayError(400, 'balance_not_enough', 'Refund amount exceeds available balance')
  }
}

function refundOrderNotFound(): GatewayError {
  return new GatewayError(404, 'payment_order_not_found', 'Payment order was not found')
}

interface AdminRefundInput {
  amount: number
  reason: string
  deductBalance: boolean
  force: boolean
}

interface ClaimRefundInput {
  refund: RefundRow | null
  requestKeyHash: string
  amountMicros: number
  reason: string
}

function parseAdminRefundInput(body: Record<string, unknown>): AdminRefundInput {
  const amount = body.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new GatewayError(400, 'invalid_amount', 'amount must be a positive number')
  }
  return {
    amount,
    reason: requireString(body, 'reason', 1_000),
    deductBalance: optionalBoolean(body, 'deduct_balance') ?? true,
    force: optionalBoolean(body, 'force') ?? false,
  }
}

function exactMajorMicros(value: number, field: string): number {
  const micros = value * 1_000_000
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must have at most six decimal places`)
  }
  return micros
}

function gatewayRefundMicros(order: PaymentOrderRow, principalMicros: number): number {
  if (
    !Number.isSafeInteger(order.amount_micros) || order.amount_micros <= 0 ||
    !Number.isSafeInteger(order.paid_amount_micros) || order.paid_amount_micros <= 0 ||
    !Number.isSafeInteger(order.refunded_amount_micros) || order.refunded_amount_micros < 0
  ) {
    throw new GatewayError(409, 'invalid_payment_amount', 'Payment order amount is invalid')
  }
  if (principalMicros > order.amount_micros) {
    throw new GatewayError(400, 'refund_amount_too_large', 'Refund amount exceeds the order amount')
  }
  try {
    const paidMinor = microsToMinorUnits(order.paid_amount_micros, order.currency)
    const numerator = BigInt(paidMinor) * BigInt(principalMicros)
    const providerMinor = Number(
      (numerator + BigInt(order.amount_micros) / 2n) / BigInt(order.amount_micros),
    )
    if (!Number.isSafeInteger(providerMinor) || providerMinor <= 0) {
      throw new Error('refund amount is below the provider minimum unit')
    }
    return minorUnitsToMicros(providerMinor, order.currency)
  } catch (error) {
    throw new GatewayError(
      400,
      'invalid_refund_amount',
      error instanceof Error ? error.message : 'Refund amount is invalid',
    )
  }
}

async function findRefundByRequest(
  env: Env,
  orderId: string,
  requestKeyHash: string,
): Promise<RefundRow | null> {
  return env.DB.prepare(
    `SELECT id, order_id, request_key_hash, provider_key, provider_refund_id,
            amount_micros, settled_amount_micros, currency, status, reason,
            requested_by_user_id, last_error, created_at_ms, updated_at_ms, completed_at_ms
       FROM payment_refunds WHERE order_id = ? AND request_key_hash = ?`,
  ).bind(orderId, requestKeyHash).first<RefundRow>()
}

async function findOrderRefund(env: Env, orderId: string): Promise<RefundRow | null> {
  return env.DB.prepare(
    `SELECT id, order_id, request_key_hash, provider_key, provider_refund_id,
            amount_micros, settled_amount_micros, currency, status, reason,
            requested_by_user_id, last_error, created_at_ms, updated_at_ms, completed_at_ms
       FROM payment_refunds WHERE order_id = ?
      ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
  ).bind(orderId).first<RefundRow>()
}

function assertRefundReplay(
  refund: RefundRow,
  order: PaymentOrderRow,
  amountMicros: number,
  reason: string,
  requireReason = true,
): void {
  if (
    refund.order_id !== order.id ||
    refund.provider_key !== order.provider_key_snapshot ||
    refund.currency !== order.currency ||
    refund.amount_micros !== amountMicros ||
    (requireReason && refund.reason !== reason)
  ) {
    throw new GatewayError(409, 'refund_idempotency_conflict', 'Refund request conflicts with existing state')
  }
}

function completedRefundResult(refund: RefundRow): Record<string, unknown> | null {
  if (refund.status !== 'refunded' && refund.status !== 'partially_refunded') return null
  return { success: true, balance_deducted: 0, subscription_days_deducted: 0 }
}

function pendingRefundResult(): Record<string, unknown> {
  return { success: false, warning: 'Stripe refund is pending' }
}

function validateAdminRefundOrder(
  order: PaymentOrderRow,
  principalMicros: number,
  deductBalance: boolean,
): void {
  if (!['COMPLETED', 'REFUND_REQUESTED', 'REFUNDING', 'REFUND_FAILED'].includes(order.status)) {
    throw new GatewayError(409, 'invalid_refund_status', `Order status ${order.status} cannot be refunded`)
  }
  if (principalMicros > order.amount_micros) {
    throw new GatewayError(400, 'refund_amount_too_large', 'Refund amount exceeds the order amount')
  }
  if (order.refunded_amount_micros !== 0) {
    throw new GatewayError(409, 'additional_partial_refund_unsupported', 'Only one refund per order is supported')
  }
  requireCourtesyRefund(deductBalance)
}

function requireCourtesyRefund(deductBalance: boolean): void {
  if (deductBalance) throw refundClawbackUnavailable()
}

function refundClawbackUnavailable(): GatewayError {
  return new GatewayError(
    409,
    'refund_clawback_unavailable',
    'Refunds requiring balance or entitlement clawback are not available',
  )
}

async function claimAdminRefund(
  env: Env,
  order: PaymentOrderRow,
  input: ClaimRefundInput,
): Promise<RefundRow> {
  if (input.refund?.status === 'processing' && order.status === 'REFUNDING') return input.refund
  const now = Date.now()
  const refundId = input.refund?.id ?? await deterministicUuid(
    'payment-refund-admin:v1',
    `${order.id}\0${input.requestKeyHash}`,
  )
  const validPair = input.refund === null
    ? order.status === 'COMPLETED'
    : input.refund.status === 'requested'
      ? order.status === 'REFUND_REQUESTED'
      : ['failed', 'cancelled'].includes(input.refund.status) && order.status === 'REFUND_FAILED'
  if (!validPair) throw new GatewayError(409, 'payment_order_conflict', 'Payment order status changed')
  const eventId = await deterministicUuid('payment-event-refund-processing:v1', refundId)
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = 'REFUNDING', refund_requested_at_ms = COALESCE(refund_requested_at_ms, ?),
              last_error = NULL, version = version + 1, updated_at_ms = ?
        WHERE id = ? AND status = ? AND version = ?`,
    ).bind(now, now, order.id, order.status, order.version),
  ]
  if (input.refund === null) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO payment_refunds (
         id, order_id, request_key_hash, provider_key, amount_micros,
         currency, status, reason, created_at_ms, updated_at_ms
       )
       SELECT ?, id, ?, provider_key_snapshot, ?, currency, 'processing', ?, ?, ?
         FROM payment_orders
        WHERE id = ? AND status = 'REFUNDING' AND version = ?`,
    ).bind(refundId, input.requestKeyHash, input.amountMicros, input.reason, now, now,
      order.id, order.version + 1))
  } else {
    statements.push(env.DB.prepare(
      `UPDATE payment_refunds
          SET status = 'processing', reason = ?, last_error = NULL, updated_at_ms = ?
        WHERE id = ? AND status IN ('requested', 'failed', 'cancelled')
          AND EXISTS (
            SELECT 1 FROM payment_orders
             WHERE id = ? AND status = 'REFUNDING' AND version = ?
          )`,
    ).bind(input.reason, now, refundId, order.id, order.version + 1))
  }
  statements.push(env.DB.prepare(
    `INSERT OR IGNORE INTO payment_events (
       id, order_id, event_type, source_type, source_id,
       payload_json, occurred_at_ms, created_at_ms
     )
     SELECT ?, id, 'REFUND_PROCESSING', 'admin', ?, ?, ?, ?
       FROM payment_orders
      WHERE id = ? AND status = 'REFUNDING' AND version = ?
        AND EXISTS (SELECT 1 FROM payment_refunds WHERE id = ? AND status = 'processing')`,
  ).bind(eventId, refundId,
    JSON.stringify({
      refund_id: refundId,
      amount_micros: input.amountMicros,
      currency: order.currency,
      deduct_balance: false,
      courtesy_refund_without_clawback: true,
    }),
    now, now, order.id, order.version + 1, refundId))
  await env.DB.batch(statements)
  const claimed = await findRefund(env, refundId)
  const claimedOrder = await findOrder(env, order.id)
  if (claimed === null || claimed.status !== 'processing' || claimedOrder?.status !== 'REFUNDING') {
    throw new GatewayError(409, 'payment_order_conflict', 'Payment order status changed')
  }
  return claimed
}

function validateProviderRefund(
  providerRefund: StripeRefund,
  order: PaymentOrderRow,
  refund: RefundRow,
): void {
  let amountMicros: number
  try {
    amountMicros = minorUnitsToMicros(providerRefund.amount, providerRefund.currency)
  } catch {
    throw new GatewayError(502, 'stripe_refund_mismatch', 'Stripe returned an invalid refund amount', 'server_error')
  }
  if (
    providerRefund.paymentIntentId !== order.payment_intent_id ||
    providerRefund.currency.toUpperCase() !== refund.currency ||
    amountMicros !== gatewayRefundMicros(order, refund.amount_micros)
  ) {
    throw new GatewayError(502, 'stripe_refund_mismatch', 'Stripe refund does not match the payment order', 'server_error')
  }
}

async function finalizeRefundSuccess(
  env: Env,
  order: PaymentOrderRow,
  refund: RefundRow,
  providerRefund: StripeRefund,
): Promise<Record<string, unknown>> {
  const total = order.refunded_amount_micros + refund.amount_micros
  if (!Number.isSafeInteger(total) || total > order.amount_micros) {
    throw new GatewayError(409, 'refund_amount_conflict', 'Refunded amount exceeds the order amount')
  }
  const orderStatus = total === order.amount_micros ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  const now = Date.now()
  const eventId = await deterministicUuid('payment-event-refund-succeeded:v1', refund.id)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = ?, refunded_amount_micros = ?, refund_completed_at_ms = ?,
              last_error = NULL, version = version + 1, updated_at_ms = ?
        WHERE id = ? AND status IN ('REFUNDING', 'REFUND_PENDING', 'REFUND_FAILED')
          AND version = ?
          AND EXISTS (SELECT 1 FROM payment_refunds WHERE id = ? AND status IN ('processing', 'pending', 'failed'))`,
    ).bind(orderStatus, total, now, now, order.id, order.version, refund.id),
    env.DB.prepare(
      `UPDATE payment_refunds
          SET provider_refund_id = ?, status = 'refunded', settled_amount_micros = amount_micros,
              last_error = NULL, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status IN ('processing', 'pending', 'failed')
          AND EXISTS (
            SELECT 1 FROM payment_orders
             WHERE id = ? AND status = ? AND version = ? AND refunded_amount_micros = ?
          )`,
    ).bind(providerRefund.id, now, now, refund.id, order.id, orderStatus, order.version + 1, total),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_events (
         id, order_id, event_type, source_type, source_id,
         payload_json, occurred_at_ms, created_at_ms
       )
       SELECT ?, id, 'REFUND_SUCCEEDED', 'provider', ?, ?, ?, ?
         FROM payment_orders
        WHERE id = ? AND status = ? AND version = ?
          AND EXISTS (SELECT 1 FROM payment_refunds WHERE id = ? AND status = 'refunded')`,
    ).bind(eventId, providerRefund.id,
      JSON.stringify({ refund_id: refund.id, amount_micros: refund.amount_micros, currency: refund.currency }),
      now, now, order.id, orderStatus, order.version + 1, refund.id),
  ])
  const current = await findRefund(env, refund.id)
  const result = current === null ? null : completedRefundResult(current)
  if (result === null) throw new GatewayError(409, 'payment_order_conflict', 'Payment order status changed')
  return result
}

async function markRefundPending(
  env: Env,
  order: PaymentOrderRow,
  refund: RefundRow,
  providerRefund: StripeRefund,
): Promise<void> {
  const now = Date.now()
  const eventId = await deterministicUuid('payment-event-refund-pending:v1', refund.id)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = 'REFUND_PENDING', last_error = NULL, version = version + 1, updated_at_ms = ?
        WHERE id = ? AND status = 'REFUNDING' AND version = ?`,
    ).bind(now, order.id, order.version),
    env.DB.prepare(
      `UPDATE payment_refunds
          SET provider_refund_id = ?, status = 'pending', last_error = NULL, updated_at_ms = ?
        WHERE id = ? AND status = 'processing'
          AND EXISTS (SELECT 1 FROM payment_orders WHERE id = ? AND status = 'REFUND_PENDING' AND version = ?)`,
    ).bind(providerRefund.id, now, refund.id, order.id, order.version + 1),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_events (
         id, order_id, event_type, source_type, source_id,
         payload_json, occurred_at_ms, created_at_ms
       )
       SELECT ?, id, 'REFUND_PENDING', 'provider', ?, ?, ?, ?
         FROM payment_orders
        WHERE id = ? AND status = 'REFUND_PENDING' AND version = ?
          AND EXISTS (SELECT 1 FROM payment_refunds WHERE id = ? AND status = 'pending')`,
    ).bind(eventId, providerRefund.id, JSON.stringify({ refund_id: refund.id }), now, now,
      order.id, order.version + 1, refund.id),
  ])
}

async function markRefundFailure(
  env: Env,
  order: PaymentOrderRow,
  refund: RefundRow,
  error: unknown,
  providerRefund?: StripeRefund,
): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Stripe refund failed'
  const status = providerRefund?.status === 'canceled' ? 'cancelled' : 'failed'
  const now = Date.now()
  const eventId = await deterministicUuid('payment-event-refund-failed:v1', refund.id)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = 'REFUND_FAILED', last_error = ?, version = version + 1, updated_at_ms = ?
        WHERE id = ? AND status IN ('REFUNDING', 'REFUND_PENDING') AND version = ?`,
    ).bind(message, now, order.id, order.version),
    env.DB.prepare(
      `UPDATE payment_refunds
          SET provider_refund_id = COALESCE(?, provider_refund_id), status = ?, last_error = ?, updated_at_ms = ?
        WHERE id = ? AND status IN ('processing', 'pending')
          AND EXISTS (SELECT 1 FROM payment_orders WHERE id = ? AND status = 'REFUND_FAILED' AND version = ?)`,
    ).bind(providerRefund?.id ?? null, status, message, now, refund.id, order.id, order.version + 1),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_events (
         id, order_id, event_type, source_type, source_id,
         payload_json, occurred_at_ms, created_at_ms
       )
       SELECT ?, id, 'REFUND_FAILED', 'provider', ?, ?, ?, ?
         FROM payment_orders
        WHERE id = ? AND status = 'REFUND_FAILED' AND version = ?`,
    ).bind(eventId, providerRefund?.id ?? refund.id,
      JSON.stringify({ refund_id: refund.id, error: message }), now, now,
      order.id, order.version + 1),
  ])
}

function refundError(error: unknown): GatewayError {
  if (error instanceof StripeAdapterError) {
    return new GatewayError(error.status, error.code, error.message, 'server_error')
  }
  return asGatewayError(error)
}
