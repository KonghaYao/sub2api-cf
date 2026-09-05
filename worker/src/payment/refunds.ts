import type { Context } from 'hono'

import { authenticateUserRequest } from '../auth/handler'
import { clawbackAffiliateRebateForRefund } from '../commercial/affiliate'
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
import { synchronizeSubscriptionState } from '../control/subscriptions'
import {
  decryptPaymentProviderConfig,
  type PaymentProviderRow,
} from './config'
import { microsToMinorUnits, minorUnitsToMicros } from './currency'
import { findOrder, requireOrder, type PaymentOrderRow } from './orders'
import { StripeAdapterError, StripeClient, type StripeRefund } from './stripe'

type PaymentBindings = { Bindings: Env }
const DAY_MS = 86_400_000
const MAX_SQLITE_TIMESTAMP_MS = 8_640_000_000_000_000

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
    const order = await requireOrder(context.env, orderId)
    const amountMicros = exactMajorMicros(input.amount, 'amount')
    gatewayRefundMicros(order, amountMicros)
    const requestKeyHash = await sha256Hex(
      `payment-refund-admin-idempotency:v1\0${order.id}\0${idempotencyKey}`,
    )

    let refund = await findRefundByRequest(context.env, order.id, requestKeyHash)
    if (refund !== null) {
      assertRefundReplay(refund, order, amountMicros, input.reason, input, true)
      refund = await reconcilePendingRefundRollback(context.env, order, refund)
      const replay = completedRefundResult(refund)
      if (replay !== null) {
        await bestEffortAffiliateRefundClawback(context.env, refund.id)
        return controlSuccess(replay)
      }
      if (refund.status === 'pending') return controlSuccess(pendingRefundResult())
    } else {
      const existing = await findOrderRefund(context.env, order.id)
      if (existing !== null) {
        assertRefundReplay(existing, order, amountMicros, input.reason, input, false)
        const reconciled = await reconcilePendingRefundRollback(context.env, order, existing)
        const replay = completedRefundResult(reconciled)
        if (replay !== null) {
          await bestEffortAffiliateRefundClawback(context.env, reconciled.id)
          return controlSuccess(replay)
        }
        if (reconciled.status === 'pending') return controlSuccess(pendingRefundResult())
        refund = reconciled
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
    const prepared = refund === null
      ? await prepareRefundClawback(context.env, order, amountMicros, input)
      : { clawback: clawbackPlanFromRefund(refund) }
    if (prepared.earlyResult !== undefined) return controlSuccess(prepared.earlyResult)

    refund = await claimAdminRefund(context.env, order, {
      refund,
      requestKeyHash,
      amountMicros,
      reason: input.reason,
      clawback: prepared.clawback,
    })
    const claimedOrder = await requireOrder(context.env, order.id)
    refund = await ensureRefundClawbackApplied(context.env, claimedOrder, refund)
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
      const rolledBack = await rollbackRefundClawback(context.env, claimedOrder, refund)
      await markRefundFailure(context.env, claimedOrder, refund, error, providerRefund!)
      if (!rolledBack) throw refundRollbackPending()
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
      const rolledBack = await rollbackRefundClawback(context.env, claimedOrder, refund)
      await markRefundPending(context.env, claimedOrder, refund, providerRefund)
      if (!rolledBack) throw refundRollbackPending()
      return controlSuccess(pendingRefundResult())
    }

    const rolledBack = await rollbackRefundClawback(context.env, claimedOrder, refund)
    await markRefundFailure(
      context.env,
      claimedOrder,
      refund,
      new Error(`Stripe refund ${providerRefund.status}`),
      providerRefund,
    )
    if (!rolledBack) throw refundRollbackPending()
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
    const foundRefund = await findOrderRefund(context.env, order.id)
    if (foundRefund === null) {
      throw new GatewayError(404, 'payment_refund_not_found', 'Payment refund was not found')
    }
    const refund = await reconcilePendingRefundRollback(context.env, order, foundRefund)
    const replay = completedRefundResult(refund)
    if (replay !== null) {
      await bestEffortAffiliateRefundClawback(context.env, refund.id)
      return controlSuccess(replay)
    }
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
        clawback: clawbackPlanFromRefund(refund),
      })
      activeOrder = await requireOrder(context.env, order.id)
      activeRefund = await ensureRefundClawbackApplied(context.env, activeOrder, activeRefund)
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
        const rolledBack = await rollbackRefundClawback(context.env, activeOrder, activeRefund)
        await markRefundFailure(context.env, activeOrder, activeRefund, error, providerRefund!)
        if (!rolledBack) throw refundRollbackPending()
        throw error
      }
    }
    if (providerRefund.status === 'succeeded') {
      activeRefund = await ensureRefundClawbackApplied(context.env, activeOrder, activeRefund)
      return controlSuccess(
        await finalizeRefundSuccess(context.env, activeOrder, activeRefund, providerRefund),
      )
    }
    if (providerRefund.status === 'pending' || providerRefund.status === 'requires_action') {
      const rolledBack = await rollbackRefundClawback(context.env, activeOrder, activeRefund)
      if (activeOrder.status === 'REFUNDING') {
        await markRefundPending(context.env, activeOrder, activeRefund, providerRefund)
      }
      if (!rolledBack) throw refundRollbackPending()
      return controlSuccess(pendingRefundResult())
    }
    const rolledBack = await rollbackRefundClawback(context.env, activeOrder, activeRefund)
    await markRefundFailure(
      context.env,
      activeOrder,
      activeRefund,
      new Error(`Stripe refund ${providerRefund.status}`),
      providerRefund,
    )
    if (!rolledBack) throw refundRollbackPending()
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
  clawback_kind: 'none' | 'balance' | 'subscription'
  clawback_status: ClawbackStatus
  clawback_resource_id: string | null
  clawback_amount_micros: number
  clawback_days: number
  clawback_forced: number
  clawback_previous_status: 'active' | 'suspended' | 'revoked' | 'expired' | null
  clawback_previous_expires_at_ms: number | null
  clawback_applied_control_version: number | null
  clawback_applied_at_ms: number | null
  clawback_rolled_back_at_ms: number | null
  clawback_recovery_attempts: number
  clawback_recovery_after_ms: number | null
  clawback_last_error: string | null
}

const REFUND_COLUMNS = `id, order_id, request_key_hash, provider_key, provider_refund_id,
  amount_micros, settled_amount_micros, currency, status, reason,
  requested_by_user_id, last_error, created_at_ms, updated_at_ms, completed_at_ms,
  clawback_kind, clawback_status, clawback_resource_id, clawback_amount_micros,
  clawback_days, clawback_forced, clawback_previous_status,
  clawback_previous_expires_at_ms, clawback_applied_control_version,
  clawback_applied_at_ms, clawback_rolled_back_at_ms,
  clawback_recovery_attempts, clawback_recovery_after_ms, clawback_last_error`

interface RefundProvider {
  row: PaymentProviderRow
  credential: Awaited<ReturnType<typeof decryptPaymentProviderConfig>>
}

async function findRefund(env: Env, id: string): Promise<RefundRow | null> {
  return env.DB.prepare(
    `SELECT ${REFUND_COLUMNS} FROM payment_refunds WHERE id = ?`,
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
  clawback: ClawbackPlan
}

type ClawbackStatus =
  | 'not_required'
  | 'pending'
  | 'applied'
  | 'rollback_pending'
  | 'rolled_back'
  | 'skipped'

interface ClawbackPlan {
  kind: 'none' | 'balance' | 'subscription'
  status: ClawbackStatus
  resourceId: string | null
  amountMicros: number
  days: number
  forced: boolean
}

interface SubscriptionClawbackRow {
  id: string
  user_id: string
  group_id: string
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  starts_at_ms: number
  expires_at_ms: number
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_anchor_ms: number | null
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  quota_reset_epoch: number
  quota_reset_generation: number
  control_version: number
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
    `SELECT ${REFUND_COLUMNS}
       FROM payment_refunds WHERE order_id = ? AND request_key_hash = ?`,
  ).bind(orderId, requestKeyHash).first<RefundRow>()
}

async function findOrderRefund(env: Env, orderId: string): Promise<RefundRow | null> {
  return env.DB.prepare(
    `SELECT ${REFUND_COLUMNS} FROM payment_refunds WHERE order_id = ?
      ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
  ).bind(orderId).first<RefundRow>()
}

function assertRefundReplay(
  refund: RefundRow,
  order: PaymentOrderRow,
  amountMicros: number,
  reason: string,
  input: AdminRefundInput,
  requireReason = true,
): void {
  const expectedKind = input.deductBalance ? order.order_type : 'none'
  if (
    refund.order_id !== order.id ||
    refund.provider_key !== order.provider_key_snapshot ||
    refund.currency !== order.currency ||
    refund.amount_micros !== amountMicros ||
    refund.clawback_kind !== expectedKind ||
    refund.clawback_forced !== Number(input.force) ||
    (requireReason && refund.reason !== reason)
  ) {
    throw new GatewayError(409, 'refund_idempotency_conflict', 'Refund request conflicts with existing state')
  }
}

function completedRefundResult(refund: RefundRow): Record<string, unknown> | null {
  if (refund.status !== 'refunded' && refund.status !== 'partially_refunded') return null
  return {
    success: true,
    balance_deducted: refund.clawback_kind === 'balance' && refund.clawback_status === 'applied'
      ? refund.clawback_amount_micros / 1_000_000
      : 0,
    subscription_days_deducted:
      refund.clawback_kind === 'subscription' && refund.clawback_status === 'applied'
        ? refund.clawback_days
        : 0,
  }
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
  if (deductBalance && order.order_type === 'balance') throw refundClawbackUnavailable()
}

function refundClawbackUnavailable(): GatewayError {
  return new GatewayError(
    409,
    'refund_clawback_unavailable',
    'Refunds requiring balance or entitlement clawback are not available',
  )
}

async function prepareRefundClawback(
  env: Env,
  order: PaymentOrderRow,
  amountMicros: number,
  input: AdminRefundInput,
): Promise<{ clawback: ClawbackPlan; earlyResult?: Record<string, unknown> }> {
  if (!input.deductBalance) {
    return {
      clawback: {
        kind: 'none', status: 'not_required', resourceId: null,
        amountMicros: 0, days: 0, forced: input.force,
      },
    }
  }
  if (order.order_type === 'balance') throw refundClawbackUnavailable()
  const days = order.plan_validity_days_snapshot
  const groupId = order.plan_group_id_snapshot
  if (!Number.isSafeInteger(days) || days === null || days <= 0 || groupId === null) {
    throw new GatewayError(
      409,
      'refund_entitlement_snapshot_missing',
      'The payment order has no valid subscription entitlement snapshot',
    )
  }
  const now = Date.now()
  const subscription = await env.DB.prepare(
    `SELECT ${SUBSCRIPTION_CLAWBACK_COLUMNS}
       FROM user_subscriptions
      WHERE user_id = ? AND group_id = ? AND status = 'active'
        AND starts_at_ms <= ? AND expires_at_ms > ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, expires_at_ms DESC, id ASC
      LIMIT 1`,
  ).bind(order.user_id, groupId, now, now, order.subscription_id ?? '').first<SubscriptionClawbackRow>()
  if (subscription === null) {
    if (!input.force) {
      return {
        clawback: {
          kind: 'subscription', status: 'skipped', resourceId: null,
          amountMicros: 0, days, forced: false,
        },
        earlyResult: {
          success: false,
          warning: 'Cannot find an active subscription for deduction; retry with force',
          require_force: true,
        },
      }
    }
    return {
      clawback: {
        kind: 'subscription', status: 'skipped', resourceId: null,
        amountMicros: 0, days, forced: true,
      },
    }
  }
  return {
    clawback: {
      kind: 'subscription', status: 'pending', resourceId: subscription.id,
      amountMicros, days, forced: input.force,
    },
  }
}

function clawbackPlanFromRefund(refund: RefundRow): ClawbackPlan {
  return {
    kind: refund.clawback_kind,
    status: refund.clawback_status,
    resourceId: refund.clawback_resource_id,
    amountMicros: refund.clawback_amount_micros,
    days: refund.clawback_days,
    forced: refund.clawback_forced === 1,
  }
}

const SUBSCRIPTION_CLAWBACK_COLUMNS = `id, user_id, group_id, status, starts_at_ms, expires_at_ms,
  daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
  daily_used_micros, weekly_used_micros, monthly_used_micros,
  daily_anchor_ms, daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
  quota_reset_epoch, quota_reset_generation, control_version`

async function ensureRefundClawbackApplied(
  env: Env,
  order: PaymentOrderRow,
  original: RefundRow,
): Promise<RefundRow> {
  let refund = original
  if (refund.clawback_kind === 'none' || refund.clawback_status === 'not_required' ||
      refund.clawback_status === 'skipped') return refund
  if (refund.clawback_kind === 'balance') throw refundClawbackUnavailable()
  const resourceId = refund.clawback_resource_id
  if (resourceId === null || refund.clawback_days <= 0) {
    if (refund.clawback_forced === 1) return markRefundClawbackSkipped(env, refund)
    throw new GatewayError(409, 'refund_clawback_target_missing', 'Refund clawback target is missing')
  }

  if (refund.clawback_status === 'applied') {
    await synchronizeSubscriptionState(env, resourceId)
    return refund
  }
  if (refund.clawback_status === 'rolled_back') {
    await synchronizeSubscriptionState(env, resourceId)
    await env.DB.prepare(
      `UPDATE payment_refunds
          SET clawback_status = 'pending', updated_at_ms = ?
        WHERE id = ? AND clawback_status = 'rolled_back'`,
    ).bind(Date.now(), refund.id).run()
    refund = await requireRefund(env, refund.id)
  }
  if (refund.clawback_status !== 'pending') {
    throw new GatewayError(409, 'refund_clawback_conflict', 'Refund clawback is not ready to apply')
  }

  const subscription = await findSubscriptionClawback(env, resourceId)
  const now = Date.now()
  if (
    subscription === null || subscription.user_id !== order.user_id ||
    subscription.group_id !== order.plan_group_id_snapshot || subscription.status !== 'active' ||
    subscription.starts_at_ms > now || subscription.expires_at_ms <= now
  ) {
    if (refund.clawback_forced === 1) return markRefundClawbackSkipped(env, refund)
    throw new GatewayError(
      409,
      'refund_clawback_target_changed',
      'The active subscription changed before its refund entitlement could be deducted',
    )
  }

  const durationMs = refund.clawback_days * DAY_MS
  const revoke = subscription.expires_at_ms - durationMs <= Math.max(now, subscription.starts_at_ms)
  const nextStatus = revoke ? 'revoked' : 'active'
  const nextExpiresAt = revoke ? subscription.expires_at_ms : subscription.expires_at_ms - durationMs
  const nextControlVersion = subscription.control_version + 1
  if (!Number.isSafeInteger(nextExpiresAt) || !Number.isSafeInteger(nextControlVersion)) {
    throw new GatewayError(409, 'refund_clawback_overflow', 'Refund entitlement deduction is outside the supported range')
  }
  const eventId = await deterministicUuid(
    'payment-event-refund-clawback-applied:v1',
    `${refund.id}\0${nextControlVersion}`,
  )
  const intentId = await deterministicUuid(
    'subscription-state-refund-clawback:v1',
    `${refund.id}\0apply\0${nextControlVersion}`,
  )
  const requestId = `payment-refund-clawback:${refund.id}:${nextControlVersion}`
  const configuration = subscriptionConfiguration(
    subscription,
    nextStatus,
    nextExpiresAt,
    nextControlVersion,
    now,
  )
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE user_subscriptions
          SET status = ?, expires_at_ms = ?, control_version = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'active' AND control_version = ?
          AND EXISTS (
            SELECT 1
              FROM payment_refunds refund
              JOIN payment_orders payment_order ON payment_order.id = refund.order_id
             WHERE refund.id = ? AND refund.clawback_status = 'pending'
               AND refund.clawback_kind = 'subscription'
               AND refund.clawback_resource_id = user_subscriptions.id
               AND payment_order.user_id = user_subscriptions.user_id
               AND payment_order.plan_group_id_snapshot = user_subscriptions.group_id
          )`,
    ).bind(
      nextStatus,
      nextExpiresAt,
      nextControlVersion,
      now,
      subscription.id,
      subscription.control_version,
      refund.id,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_events (
         id, order_id, event_type, source_type, source_id,
         payload_json, occurred_at_ms, created_at_ms
       )
       SELECT ?, payment_order.id, 'REFUND_CLAWBACK_APPLIED', 'system', ?, ?, ?, ?
         FROM payment_orders payment_order
         JOIN user_subscriptions subscription ON subscription.id = ?
        WHERE payment_order.id = ? AND subscription.control_version = ?
          AND subscription.status = ? AND subscription.expires_at_ms = ?`,
    ).bind(
      eventId,
      `${refund.id}:${nextControlVersion}`,
      JSON.stringify({
        refund_id: refund.id,
        subscription_id: subscription.id,
        days: refund.clawback_days,
        previous_status: subscription.status,
        previous_expires_at_ms: subscription.expires_at_ms,
        status: nextStatus,
        expires_at_ms: nextExpiresAt,
        control_version: nextControlVersion,
      }),
      now,
      now,
      subscription.id,
      order.id,
      nextControlVersion,
      nextStatus,
      nextExpiresAt,
    ),
    subscriptionSyncStatement(
      env,
      intentId,
      requestId,
      subscription.id,
      nextControlVersion,
      configuration,
      nextStatus,
      nextExpiresAt,
      eventId,
      now,
    ),
    env.DB.prepare(
      `UPDATE payment_refunds
          SET clawback_status = 'applied', clawback_previous_status = ?,
              clawback_previous_expires_at_ms = ?, clawback_applied_control_version = ?,
              clawback_applied_at_ms = ?, clawback_rolled_back_at_ms = NULL,
              clawback_recovery_attempts = 0, clawback_recovery_after_ms = NULL,
              clawback_last_error = NULL,
              updated_at_ms = ?
        WHERE id = ? AND clawback_status = 'pending'
          AND EXISTS (SELECT 1 FROM subscription_state_sync WHERE id = ?)
          AND EXISTS (
            SELECT 1 FROM user_subscriptions
             WHERE id = ? AND control_version = ? AND status = ? AND expires_at_ms = ?
          )`,
    ).bind(
      subscription.status,
      subscription.expires_at_ms,
      nextControlVersion,
      now,
      now,
      refund.id,
      intentId,
      subscription.id,
      nextControlVersion,
      nextStatus,
      nextExpiresAt,
    ),
  ])
  const applied = await requireRefund(env, refund.id)
  if (applied.clawback_status !== 'applied') {
    throw new GatewayError(409, 'refund_clawback_conflict', 'Refund entitlement changed concurrently')
  }
  await synchronizeSubscriptionState(env, subscription.id)
  return applied
}

async function rollbackRefundClawback(
  env: Env,
  order: PaymentOrderRow,
  original: RefundRow,
): Promise<boolean> {
  const refund = await requireRefund(env, original.id)
  if (refund.status === 'refunded' || refund.status === 'partially_refunded') return true
  if (refund.clawback_kind !== 'subscription' || refund.clawback_status === 'rolled_back') return true
  if (refund.clawback_status !== 'applied' && refund.clawback_status !== 'rollback_pending') {
    return true
  }
  if (
    refund.clawback_resource_id === null || refund.clawback_previous_status === null ||
    refund.clawback_previous_expires_at_ms === null ||
    refund.clawback_applied_control_version === null
  ) {
    await deferRefundClawbackRollback(env, refund, 'Refund clawback rollback metadata is incomplete')
    return false
  }
  const subscription = await findSubscriptionClawback(env, refund.clawback_resource_id)
  if (subscription === null || !subscriptionStillHasClawback(subscription, refund)) {
    await deferRefundClawbackRollback(
      env,
      refund,
      subscription === null
        ? 'Refund clawback subscription is missing'
        : 'Refund clawback subscription changed and requires manual reconciliation',
    )
    return false
  }
  const now = Date.now()
  const nextControlVersion = subscription.control_version + 1
  const eventId = await deterministicUuid(
    'payment-event-refund-clawback-rolled-back:v1',
    `${refund.id}\0${nextControlVersion}`,
  )
  const intentId = await deterministicUuid(
    'subscription-state-refund-clawback:v1',
    `${refund.id}\0rollback\0${nextControlVersion}`,
  )
  const requestId = `payment-refund-clawback-rollback:${refund.id}:${nextControlVersion}`
  const configuration = subscriptionConfiguration(
    subscription,
    refund.clawback_previous_status,
    refund.clawback_previous_expires_at_ms,
    nextControlVersion,
    now,
  )
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE user_subscriptions
            SET status = ?, expires_at_ms = ?, control_version = ?, updated_at_ms = ?
          WHERE id = ? AND control_version = ?
            AND EXISTS (
              SELECT 1 FROM payment_refunds
               WHERE id = ? AND clawback_status IN ('applied', 'rollback_pending')
                 AND status IN ('processing', 'pending', 'failed', 'cancelled')
                 AND clawback_applied_control_version = ?
            )`,
      ).bind(
        refund.clawback_previous_status,
        refund.clawback_previous_expires_at_ms,
        nextControlVersion,
        now,
        subscription.id,
        subscription.control_version,
        refund.id,
        refund.clawback_applied_control_version,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_events (
           id, order_id, event_type, source_type, source_id,
           payload_json, occurred_at_ms, created_at_ms
         )
         SELECT ?, id, 'REFUND_CLAWBACK_ROLLED_BACK', 'system', ?, ?, ?, ?
           FROM payment_orders
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM user_subscriptions
               WHERE id = ? AND control_version = ? AND status = ? AND expires_at_ms = ?
            )`,
      ).bind(
        eventId,
        `${refund.id}:${nextControlVersion}`,
        JSON.stringify({
          refund_id: refund.id,
          subscription_id: subscription.id,
          restored_status: refund.clawback_previous_status,
          restored_expires_at_ms: refund.clawback_previous_expires_at_ms,
          control_version: nextControlVersion,
        }),
        now,
        now,
        order.id,
        subscription.id,
        nextControlVersion,
        refund.clawback_previous_status,
        refund.clawback_previous_expires_at_ms,
      ),
      subscriptionSyncStatement(
        env,
        intentId,
        requestId,
        subscription.id,
        nextControlVersion,
        configuration,
        refund.clawback_previous_status,
        refund.clawback_previous_expires_at_ms,
        eventId,
        now,
      ),
      env.DB.prepare(
        `UPDATE payment_refunds
            SET clawback_status = 'rolled_back', clawback_applied_control_version = NULL,
                clawback_rolled_back_at_ms = ?, clawback_recovery_attempts = 0,
                clawback_recovery_after_ms = NULL, clawback_last_error = NULL,
                updated_at_ms = ?
          WHERE id = ? AND clawback_status IN ('applied', 'rollback_pending')
            AND status IN ('processing', 'pending', 'failed', 'cancelled')
            AND EXISTS (SELECT 1 FROM subscription_state_sync WHERE id = ?)`,
      ).bind(now, now, refund.id, intentId),
    ])
    const rolledBack = await requireRefund(env, refund.id)
    if (rolledBack.status === 'refunded' || rolledBack.status === 'partially_refunded') return true
    if (rolledBack.clawback_status !== 'rolled_back') {
      await deferRefundClawbackRollback(
        env,
        rolledBack,
        'Refund entitlement changed while its rollback was being committed',
      )
      return false
    }
    try {
      await synchronizeSubscriptionState(env, subscription.id)
    } catch (error) {
      console.error('refund entitlement rollback projection deferred', {
        refund_id: refund.id,
        subscription_id: subscription.id,
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
    return true
  } catch (error) {
    console.error('refund entitlement rollback deferred', {
      refund_id: refund.id,
      subscription_id: subscription.id,
      name: error instanceof Error ? error.name : 'unknown',
    })
    await deferRefundClawbackRollback(env, refund, error)
    return false
  }
}

function subscriptionStillHasClawback(
  subscription: SubscriptionClawbackRow,
  refund: RefundRow,
): boolean {
  if (
    refund.clawback_previous_expires_at_ms === null || refund.clawback_applied_at_ms === null ||
    refund.clawback_applied_control_version === null ||
    subscription.control_version < refund.clawback_applied_control_version
  ) return false
  const durationMs = refund.clawback_days * DAY_MS
  const revoked = refund.clawback_previous_expires_at_ms - durationMs <= Math.max(
    refund.clawback_applied_at_ms,
    subscription.starts_at_ms,
  )
  const expectedStatus = revoked ? 'revoked' : 'active'
  const expectedExpiresAt = revoked
    ? refund.clawback_previous_expires_at_ms
    : refund.clawback_previous_expires_at_ms - durationMs
  return subscription.status === expectedStatus && subscription.expires_at_ms === expectedExpiresAt
}

async function deferRefundClawbackRollback(
  env: Env,
  refund: RefundRow,
  error: unknown,
): Promise<void> {
  const nextAttempt = refund.clawback_recovery_attempts + 1
  const exhausted = nextAttempt >= 20
  const now = Date.now()
  const retryAt = exhausted
    ? MAX_SQLITE_TIMESTAMP_MS
    : now + Math.min(300_000, 1_000 * 2 ** Math.min(refund.clawback_recovery_attempts, 8))
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  await env.DB.prepare(
    `UPDATE payment_refunds
        SET clawback_status = 'rollback_pending', clawback_recovery_attempts = ?,
            clawback_recovery_after_ms = ?, clawback_last_error = ?, updated_at_ms = ?
      WHERE id = ? AND clawback_status IN ('applied', 'rollback_pending')
        AND status IN ('processing', 'pending', 'failed', 'cancelled')`,
  ).bind(
    nextAttempt,
    retryAt,
    `${exhausted ? 'manual_review: ' : ''}${detail}`.slice(0, 500),
    now,
    refund.id,
  ).run()
}

function subscriptionSyncStatement(
  env: Env,
  intentId: string,
  requestId: string,
  subscriptionId: string,
  controlVersion: number,
  configuration: Record<string, unknown>,
  expectedStatus: SubscriptionClawbackRow['status'],
  expectedExpiresAtMs: number,
  eventId: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO subscription_state_sync (
       id, request_id, subscription_id, operation, control_version,
       payload_json, status, attempts, created_at_ms, updated_at_ms
     )
     SELECT ?, ?, id, 'configure', control_version, ?, 'pending', 0, ?, ?
       FROM user_subscriptions
      WHERE id = ? AND control_version = ? AND status = ? AND expires_at_ms = ?
        AND EXISTS (SELECT 1 FROM payment_events WHERE id = ?)`,
  ).bind(
    intentId,
    requestId,
    JSON.stringify({ configuration }),
    now,
    now,
    subscriptionId,
    controlVersion,
    expectedStatus,
    expectedExpiresAtMs,
    eventId,
  )
}

function subscriptionConfiguration(
  row: SubscriptionClawbackRow,
  status: SubscriptionClawbackRow['status'],
  expiresAtMs: number,
  controlVersion: number,
  now: number,
): Record<string, unknown> {
  return {
    schema_version: 1,
    subscription_id: row.id,
    user_id: row.user_id,
    group_id: row.group_id,
    starts_at_ms: row.starts_at_ms,
    expires_at_ms: expiresAtMs,
    daily_quota_micros: row.daily_quota_micros,
    weekly_quota_micros: row.weekly_quota_micros,
    monthly_quota_micros: row.monthly_quota_micros,
    daily_used_micros: row.daily_used_micros,
    weekly_used_micros: row.weekly_used_micros,
    monthly_used_micros: row.monthly_used_micros,
    daily_anchor_ms: row.daily_anchor_ms,
    daily_window_start_ms: row.daily_window_start_ms,
    weekly_window_start_ms: row.weekly_window_start_ms,
    monthly_window_start_ms: row.monthly_window_start_ms,
    quota_reset_epoch: row.quota_reset_epoch,
    quota_reset_generation: row.quota_reset_generation,
    control_version: controlVersion,
    enabled: status === 'active' && row.starts_at_ms <= now && expiresAtMs > now,
  }
}

async function findSubscriptionClawback(
  env: Env,
  subscriptionId: string,
): Promise<SubscriptionClawbackRow | null> {
  return env.DB.prepare(
    `SELECT ${SUBSCRIPTION_CLAWBACK_COLUMNS}
       FROM user_subscriptions WHERE id = ?`,
  ).bind(subscriptionId).first<SubscriptionClawbackRow>()
}

async function markRefundClawbackSkipped(env: Env, refund: RefundRow): Promise<RefundRow> {
  await env.DB.prepare(
    `UPDATE payment_refunds
        SET clawback_status = 'skipped', updated_at_ms = ?
      WHERE id = ? AND clawback_status IN ('pending', 'rolled_back') AND clawback_forced = 1`,
  ).bind(Date.now(), refund.id).run()
  return requireRefund(env, refund.id)
}

async function requireRefund(env: Env, refundId: string): Promise<RefundRow> {
  const refund = await findRefund(env, refundId)
  if (refund === null) throw new GatewayError(409, 'payment_refund_conflict', 'Payment refund state is missing')
  return refund
}

async function reconcilePendingRefundRollback(
  env: Env,
  order: PaymentOrderRow,
  refund: RefundRow,
): Promise<RefundRow> {
  if (refund.clawback_status !== 'rollback_pending') return refund
  if (!await rollbackRefundClawback(env, order, refund)) throw refundRollbackPending()
  return requireRefund(env, refund.id)
}

function refundRollbackPending(): GatewayError {
  return new GatewayError(
    503,
    'refund_clawback_rollback_pending',
    'Refund provider state was saved, but entitlement restoration is still pending',
    'server_error',
  )
}

/** Bounded Cron recovery for refund entitlement rollbacks left by transient D1 races. */
export async function recoverPendingRefundClawbacks(
  env: Env,
  requestedLimit = 25,
): Promise<number> {
  const normalizedLimit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 25
  const limit = Math.max(1, Math.min(100, normalizedLimit))
  const due = await env.DB.prepare(
    `SELECT id, order_id
       FROM payment_refunds
      WHERE clawback_status = 'rollback_pending' AND clawback_recovery_after_ms <= ?
      ORDER BY clawback_recovery_after_ms ASC, id ASC
      LIMIT ?`,
  ).bind(Date.now(), limit).all<{ id: string; order_id: string }>()
  let recovered = 0
  for (const row of due.results) {
    const [order, refund] = await Promise.all([
      requireOrder(env, row.order_id),
      requireRefund(env, row.id),
    ])
    if (await rollbackRefundClawback(env, order, refund)) recovered += 1
  }
  const affiliateLimit = Math.max(0, limit - recovered)
  if (affiliateLimit === 0) return recovered
  const affiliateDue = await env.DB.prepare(
    `SELECT refund.id
       FROM payment_refunds refund
       JOIN affiliate_rebates rebate ON rebate.source_order_id = refund.order_id
       LEFT JOIN affiliate_rebate_adjustments adjustment ON adjustment.refund_id = refund.id
      WHERE refund.status IN ('partially_refunded', 'refunded')
        AND refund.settled_amount_micros > 0
        AND (adjustment.id IS NULL OR adjustment.status = 'processing')
      ORDER BY refund.completed_at_ms ASC, refund.id ASC
      LIMIT ?`,
  ).bind(affiliateLimit).all<{ id: string }>()
  for (const row of affiliateDue.results) {
    try {
      const result = await clawbackAffiliateRebateForRefund(env, row.id)
      if (result.applied && result.status === 'completed') recovered += 1
    } catch (error) {
      console.error('affiliate refund clawback recovery deferred', {
        refund_id: row.id,
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return recovered
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
      `INSERT OR IGNORE INTO payment_refund_claims(order_id, refund_id, claimed_at_ms)
       VALUES (?, ?, ?)`,
    ).bind(order.id, refundId, now),
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = 'REFUNDING', refund_requested_at_ms = COALESCE(refund_requested_at_ms, ?),
              last_error = NULL, version = version + 1, updated_at_ms = ?
        WHERE id = ? AND status = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM payment_refund_claims
             WHERE order_id = payment_orders.id AND refund_id = ?
          )`,
    ).bind(now, now, order.id, order.status, order.version, refundId),
  ]
  if (input.refund === null) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO payment_refunds (
         id, order_id, request_key_hash, provider_key, amount_micros,
         currency, status, reason, clawback_kind, clawback_status,
         clawback_resource_id, clawback_amount_micros, clawback_days,
         clawback_forced, created_at_ms, updated_at_ms
       )
       SELECT ?, id, ?, provider_key_snapshot, ?, currency, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM payment_orders
        WHERE id = ? AND status = 'REFUNDING' AND version = ?
          AND EXISTS (
            SELECT 1 FROM payment_refund_claims
             WHERE order_id = payment_orders.id AND refund_id = ?
          )`,
    ).bind(
      refundId,
      input.requestKeyHash,
      input.amountMicros,
      input.reason,
      input.clawback.kind,
      input.clawback.status,
      input.clawback.resourceId,
      input.clawback.amountMicros,
      input.clawback.days,
      Number(input.clawback.forced),
      now,
      now,
      order.id,
      order.version + 1,
      refundId,
    ))
  } else {
    statements.push(env.DB.prepare(
      `UPDATE payment_refunds
          SET status = 'processing', reason = ?, last_error = NULL, updated_at_ms = ?
        WHERE id = ? AND status IN ('requested', 'failed', 'cancelled')
          AND EXISTS (
            SELECT 1 FROM payment_orders
             WHERE id = ? AND status = 'REFUNDING' AND version = ?
               AND EXISTS (
                 SELECT 1 FROM payment_refund_claims
                  WHERE order_id = payment_orders.id AND refund_id = ?
               )
          )`,
    ).bind(input.reason, now, refundId, order.id, order.version + 1, refundId))
  }
  statements.push(env.DB.prepare(
    `INSERT OR IGNORE INTO payment_events (
       id, order_id, event_type, source_type, source_id,
       payload_json, occurred_at_ms, created_at_ms
     )
     SELECT ?, id, 'REFUND_PROCESSING', 'admin', ?, ?, ?, ?
       FROM payment_orders
      WHERE id = ? AND status = 'REFUNDING' AND version = ?
        AND EXISTS (SELECT 1 FROM payment_refunds WHERE id = ? AND status = 'processing')
        AND EXISTS (
          SELECT 1 FROM payment_refund_claims
           WHERE order_id = payment_orders.id AND refund_id = ?
        )`,
  ).bind(eventId, refundId,
    JSON.stringify({
      refund_id: refundId,
      amount_micros: input.amountMicros,
      currency: order.currency,
      deduct_balance: input.clawback.kind !== 'none',
      courtesy_refund_without_clawback: input.clawback.kind === 'none',
      clawback_kind: input.clawback.kind,
      clawback_status: input.clawback.status,
      clawback_resource_id: input.clawback.resourceId,
      clawback_days: input.clawback.days,
      force: input.clawback.forced,
    }),
    now, now, order.id, order.version + 1, refundId, refundId))
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
          AND EXISTS (
            SELECT 1 FROM payment_refunds
             WHERE id = ? AND status IN ('processing', 'pending', 'failed')
               AND (clawback_kind <> 'subscription' OR clawback_status = 'applied')
          )`,
    ).bind(orderStatus, total, now, now, order.id, order.version, refund.id),
    env.DB.prepare(
      `UPDATE payment_refunds
          SET provider_refund_id = ?, status = 'refunded', settled_amount_micros = amount_micros,
              last_error = NULL, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status IN ('processing', 'pending', 'failed')
          AND (clawback_kind <> 'subscription' OR clawback_status = 'applied')
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
  await bestEffortAffiliateRefundClawback(env, refund.id)
  return result
}

async function bestEffortAffiliateRefundClawback(env: Env, refundId: string): Promise<void> {
  try {
    await clawbackAffiliateRebateForRefund(env, refundId)
  } catch (error) {
    // The provider refund and D1 refund fact are already committed. Leave an
    // adjustment in processing (or no adjustment yet) for the bounded Cron
    // recovery seam; affiliate post-processing must never rewrite that result.
    console.error('affiliate refund clawback deferred', {
      refund_id: refundId,
      name: error instanceof Error ? error.name : 'unknown',
    })
  }
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
