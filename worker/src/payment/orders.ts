import type { Context } from 'hono'

import { authenticateUserRequest } from '../auth/handler'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
  requireString,
} from '../control/http'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { createPaymentFulfillmentEvent } from './fulfillment'
import { microsToMinorUnits, paymentAmountWithFee } from './currency'
import {
  requireActiveStripeProvider,
  requireStripeProviderForExistingOrder,
} from './config'
import {
  StripeAdapterError,
  StripeClient,
  type StripeCheckoutSession,
  verifyStripeWebhookSignature,
} from './stripe'

type PaymentBindings = { Bindings: Env }
type OrderStatus =
  | 'PENDING'
  | 'PAID'
  | 'RECHARGING'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED'
  | 'REFUND_REQUESTED'
  | 'REFUNDING'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'REFUND_FAILED'

const DAY_MS = 86_400_000
const RESUME_TOKEN_TTL_MS = 7 * DAY_MS
const STRIPE_MIN_CHECKOUT_EXPIRY_MS = 30 * 60_000
const LATE_PAYMENT_ERROR = 'late_payment_requires_refund'
const LATE_PAYMENT_REASON = 'Automatic refund required: payment received after order expiry'
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
const MAX_DATE_MS = 8_640_000_000_000_000
const FULFILLMENT_ACTION = 'subscription_entitlement'

interface PaymentPolicyRow {
  enabled: number
  min_amount_micros: number
  max_amount_micros: number
  daily_limit_micros: number
  order_timeout_minutes: number
  max_pending_orders: number
  recharge_fee_ppm: number
  product_name_prefix: string
  product_name_suffix: string
}

interface PlanRow {
  id: string
  group_id: string
  name: string
  description: string
  validity_days: number
  price_micros: number
  currency: string
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  enabled: number
  group_enabled: number
  group_type: string
}

export interface PaymentOrderRow {
  id: string
  user_id: string
  provider_instance_id: string
  provider_key_snapshot: string
  out_trade_no: string
  idempotency_key_hash: string
  request_hash: string
  provider_order_id: string | null
  payment_intent_id: string | null
  payment_trade_no: string | null
  pay_url: string | null
  order_type: 'balance' | 'subscription'
  status: OrderStatus
  amount_micros: number
  pay_amount_micros: number
  fee_ppm_snapshot: number
  paid_amount_micros: number
  refunded_amount_micros: number
  currency: string
  plan_id: string | null
  plan_name_snapshot: string | null
  plan_group_id_snapshot: string | null
  plan_validity_days_snapshot: number | null
  plan_price_micros_snapshot: number | null
  plan_currency_snapshot: string | null
  plan_daily_quota_micros_snapshot: number | null
  plan_weekly_quota_micros_snapshot: number | null
  plan_monthly_quota_micros_snapshot: number | null
  fulfillment_started_at_ms: number | null
  subscription_id: string | null
  subscription_fulfilled_at_ms: number | null
  refund_requested_at_ms: number | null
  refund_completed_at_ms: number | null
  source_url: string
  last_error: string | null
  version: number
  expires_at_ms: number
  paid_at_ms: number | null
  completed_at_ms: number | null
  failed_at_ms: number | null
  failed_reason: string | null
  created_at_ms: number
  updated_at_ms: number
  user_email?: string
  user_name?: string
}

interface StripeEvent {
  id: string
  type: string
  session: {
    id: string
    orderId: string
    paymentStatus: string
    status: string
    amountTotal: number
    currency: string
    paymentIntentId: string
  }
}

interface OrderInput {
  payment_type: 'stripe'
  order_type: 'subscription'
  plan_id: string
}

interface ProviderPaymentInput {
  providerEventId: string
  sourceType: 'provider' | 'webhook'
  providerOrderId: string
  paymentIntentId: string
  amountMinor: number
  currency: string
}

export async function createPaymentOrder(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const input = parseOrderInput(body)
    const requestHash = await sha256Hex(JSON.stringify(input))
    const idempotencyHash = await sha256Hex(
      `payment-order-idempotency:v1\0${user.id}\0${idempotencyKey}`,
    )

    let row = await findOrderByIdempotency(context.env, user.id, idempotencyHash)
    const replay = row !== null
    if (row !== null) {
      if (row.request_hash !== requestHash) throw idempotencyConflict()
    } else {
      row = await persistNewOrder(
        context.env,
        user.id,
        input,
        idempotencyKey,
        idempotencyHash,
        requestHash,
        new URL(context.req.url).origin,
      )
    }

    row = await ensureStripeCheckout(context.env, row, new URL(context.req.url).origin)
    return controlSuccess(await createOrderProjection(context.env, row), replay ? 200 : 201)
  } catch (error) {
    return controlError(paymentError(error))
  }
}

export async function listMyPaymentOrders(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const status = optionalStatus(context.req.query('status'))
    const where = status === undefined ? 'user_id = ?' : 'user_id = ? AND status = ?'
    const values = status === undefined ? [user.id] : [user.id, status]
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) AS total FROM payment_orders WHERE ${where}`).bind(...values),
      context.env.DB.prepare(
        `${orderSelect()} FROM payment_orders WHERE ${where}
         ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const total = requireCount((countResult.results[0] as { total?: unknown } | undefined)?.total)
    return controlSuccess({
      items: (rowsResult.results as unknown as PaymentOrderRow[]).map((row) => publicOrder(row, true)),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(paymentError(error))
  }
}

export async function getMyPaymentOrder(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'payment_order')
    const row = await findOrder(context.env, id, user.id)
    if (row === null) throw orderNotFound()
    return controlSuccess(publicOrder(row, true))
  } catch (error) {
    return controlError(paymentError(error))
  }
}

export async function cancelMyPaymentOrder(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'payment_order')
    let row = await findOrder(context.env, id, user.id)
    if (row === null) throw orderNotFound()
    if (row.status !== 'PENDING') return controlSuccess(publicOrder(row, true))

    if (row.provider_order_id !== null) {
      const providerOrderId = row.provider_order_id
      const provider = await requireStripeProviderForExistingOrder(
        context.env,
        row.provider_instance_id,
      )
      const stripe = new StripeClient({ secretKey: provider.secret_key })
      try {
        const session = await stripe.expireCheckoutSession(providerOrderId)
        if (session.paymentStatus === 'paid') {
          row = await acceptProviderPayment(context.env, row, {
            providerEventId: `verify-cancel:${providerOrderId}`,
            sourceType: 'provider',
            providerOrderId: session.id,
            paymentIntentId: requirePaymentIntent(session.paymentIntentId),
            amountMinor: session.amountTotal,
            currency: session.currency,
          })
          return controlSuccess(publicOrder(row, true))
        }
      } catch (error) {
        const session = await stripe.retrieveCheckoutSession(providerOrderId).catch(() => null)
        if (session?.paymentStatus === 'paid') {
          row = await acceptProviderPayment(context.env, row, {
            providerEventId: `verify-cancel:${providerOrderId}`,
            sourceType: 'provider',
            providerOrderId: session.id,
            paymentIntentId: requirePaymentIntent(session.paymentIntentId),
            amountMinor: session.amountTotal,
            currency: session.currency,
          })
          return controlSuccess(publicOrder(row, true))
        }
        if (session?.status === 'expired') {
          // A previous cancellation attempt may already have expired the
          // Checkout Session. Continue with the local CAS transition.
        } else {
          throw error
        }
      }
    }

    const now = Date.now()
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE payment_orders
            SET status = 'CANCELLED', version = version + 1, updated_at_ms = ?
          WHERE id = ? AND user_id = ? AND status = 'PENDING' AND version = ?`,
      ).bind(now, row.id, user.id, row.version),
      paymentEventInsertForStatuses(
        context.env,
        row.id,
        'order.cancelled',
        'api',
        `cancel:${row.id}:${row.version}`,
        {},
        now,
        ['CANCELLED'],
      ),
    ])
    row = await requireOrder(context.env, row.id)
    return controlSuccess(publicOrder(row, true))
  } catch (error) {
    return controlError(paymentError(error))
  }
}

export async function verifyMyPaymentOrder(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const outTradeNo = requireString(body, 'out_trade_no', 128)
    let row = await context.env.DB.prepare(
      `${orderSelect()} FROM payment_orders WHERE out_trade_no = ? AND user_id = ?`,
    ).bind(outTradeNo, user.id).first<PaymentOrderRow>()
    if (row === null) throw orderNotFound()
    if (row.status === 'PENDING' && row.provider_order_id !== null) {
      const provider = await requireStripeProviderForExistingOrder(
        context.env,
        row.provider_instance_id,
      )
      const session = await new StripeClient({ secretKey: provider.secret_key })
        .retrieveCheckoutSession(row.provider_order_id)
      if (session.paymentStatus === 'paid') {
        row = await acceptProviderPayment(context.env, row, {
          providerEventId: `verify:${row.provider_order_id}`,
          sourceType: 'provider',
          providerOrderId: session.id,
          paymentIntentId: requirePaymentIntent(session.paymentIntentId),
          amountMinor: session.amountTotal,
          currency: session.currency,
        })
      }
    }
    return controlSuccess(publicOrder(row, true))
  } catch (error) {
    return controlError(paymentError(error))
  }
}

export async function verifyPaymentOrderPublic(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const outTradeNo = requireString(body, 'out_trade_no', 128)
    const row = await context.env.DB.prepare(
      `${orderSelect()} FROM payment_orders WHERE out_trade_no = ?`,
    ).bind(outTradeNo).first<PaymentOrderRow>()
    if (row === null) throw orderNotFound()
    return controlSuccess(publicOrder(row, false))
  } catch (error) {
    return controlError(paymentError(error))
  }
}

export async function resolvePaymentOrderPublic(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const token = requireString(body, 'resume_token', 4_096)
    const orderId = await verifyResumeToken(context.env, token)
    const row = await findOrder(context.env, orderId)
    if (row === null) throw orderNotFound()
    return controlSuccess(publicOrder(row, false))
  } catch (error) {
    return controlError(paymentError(error))
  }
}

export async function handleStripeWebhook(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const declaredLength = Number(context.req.header('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
      throw new GatewayError(413, 'payment_webhook_too_large', 'Payment webhook body is too large')
    }
    const bytes = new Uint8Array(await context.req.raw.arrayBuffer())
    if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) {
      throw new GatewayError(413, 'payment_webhook_too_large', 'Payment webhook body is too large')
    }
    const rawBody = new TextDecoder().decode(bytes)
    const event = parseStripeEvent(rawBody)
    const order = event === null ? null : await findOrder(context.env, event.session.orderId)
    const provider = order === null
      ? await requireActiveStripeProvider(context.env)
      : await requireStripeProviderForExistingOrder(context.env, order.provider_instance_id)
    const signature = context.req.header('stripe-signature') ?? ''
    const verified = await verifyStripeWebhookSignature({
      rawBody: bytes,
      signatureHeader: signature,
      webhookSecret: provider.webhook_secret,
    })
    if (!verified) {
      throw new GatewayError(400, 'invalid_payment_webhook_signature', 'Payment webhook signature is invalid')
    }
    if (event === null || order === null) {
      // Stripe retries unknown or intentionally ignored events indefinitely
      // unless they are acknowledged. No financial state is created.
      return stripeWebhookAck()
    }
    if (order.provider_key_snapshot !== provider.provider_key) {
      throw new GatewayError(400, 'payment_provider_mismatch', 'Payment provider does not match the order')
    }

    const digest = await sha256Hex(rawBody)
    const existing = await findWebhook(context.env, provider.provider_key, event.id)
    if (existing !== null) {
      if (existing.payload_sha256 !== digest) {
        throw new GatewayError(409, 'payment_webhook_replay_conflict', 'Payment webhook replay does not match')
      }
      if (existing.status === 'processed' || existing.status === 'ignored') {
        const latest = await requireOrder(context.env, order.id)
        await enqueueOutstandingFulfillment(context.env, latest)
        return stripeWebhookAck()
      }
    }

    validateProviderPayment(order, event.session.amountTotal, event.session.currency)
    if (event.session.paymentStatus !== 'paid') return stripeWebhookAck()
    if (event.session.status !== 'complete') {
      throw new GatewayError(400, 'payment_session_incomplete', 'Payment checkout session is incomplete')
    }
    const objectKey = `payment-webhooks/stripe/${safeObjectPart(event.id)}.json`
    await context.env.OBJECTS.put(objectKey, rawBody, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { provider: 'stripe', event_id: event.id },
    })

    const now = Date.now()
    const inboxId = await deterministicUuid('payment.webhook.inbox.v1', `${provider.provider_key}\0${event.id}`)
    if (isLateProviderPayment(order, now)) {
      await reconcileLateWebhookPayment(context.env, order, event, {
        inboxId,
        providerKey: provider.provider_key,
        digest,
        objectKey,
        now,
      })
      return stripeWebhookAck()
    }
    const fulfillmentId = await deterministicUuid(
      'payment.fulfillment.v1',
      `${order.id}\0${FULFILLMENT_ACTION}`,
    )
    const paymentEventId = await deterministicUuid('payment.event.v1', `${order.id}\0paid\0${event.id}`)
    await context.env.DB.batch([
      context.env.DB.prepare(
          `INSERT OR IGNORE INTO payment_webhook_inbox (
             id, provider_key, provider_event_id, event_type, payload_sha256,
             payload_r2_key, status, attempts, available_at_ms,
             received_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?, ?, ?)`,
      ).bind(
          inboxId,
          provider.provider_key,
          event.id,
          event.type,
          digest,
          objectKey,
          now,
          now,
          now,
        ),
      paidOrderUpdate(
          context.env,
          order,
          event.session.id,
          event.session.paymentIntentId,
          event.session.amountTotal,
          event.session.currency,
          now,
      ),
      context.env.DB.prepare(
          `INSERT OR IGNORE INTO payment_fulfillments (
             id, order_id, action, status, attempts, available_at_ms, created_at_ms, updated_at_ms
           ) SELECT ?, id, ?, 'pending', 0, ?, ?, ?
               FROM payment_orders WHERE id = ? AND status IN ('PAID', 'RECHARGING')`,
      ).bind(fulfillmentId, FULFILLMENT_ACTION, now, now, now, order.id),
      context.env.DB.prepare(
          `INSERT OR IGNORE INTO payment_events (
             id, order_id, event_type, source_type, source_id,
             payload_json, occurred_at_ms, created_at_ms
           ) SELECT ?, id, 'order.paid', 'webhook', ?, ?, ?, ?
               FROM payment_orders
              WHERE id = ? AND status IN ('PAID', 'RECHARGING', 'COMPLETED')
                AND provider_order_id = ? AND payment_intent_id = ?`,
      ).bind(
          paymentEventId,
          event.id,
          JSON.stringify({ provider_order_id: event.session.id }),
          now,
          now,
          order.id,
          event.session.id,
          event.session.paymentIntentId,
      ),
      context.env.DB.prepare(
          `UPDATE payment_webhook_inbox
              SET status = 'processed', processed_at_ms = ?, updated_at_ms = ?
            WHERE id = ?
              AND EXISTS (
                SELECT 1 FROM payment_events
                 WHERE order_id = ? AND event_type = 'order.paid'
                   AND source_type = 'webhook' AND source_id = ?
              )`,
      ).bind(now, now, inboxId, order.id, event.id),
    ])

    let latest = await requireOrder(context.env, order.id)
    const handled = await findWebhook(context.env, provider.provider_key, event.id)
    if (handled?.status !== 'processed') {
      if (isLateProviderPayment(latest, Date.now())) {
        latest = await reconcileLateWebhookPayment(context.env, latest, event, {
          inboxId,
          providerKey: provider.provider_key,
          digest,
          objectKey,
          now: Date.now(),
        })
      } else {
        // Returning non-2xx asks Stripe to retry; the inbox remains recoverable
        // and is never falsely labelled processed.
        throw new GatewayError(409, 'payment_order_changed', 'Payment order changed during webhook processing')
      }
    }
    await enqueueOutstandingFulfillment(context.env, latest)
    return stripeWebhookAck()
  } catch (error) {
    return controlError(paymentError(error))
  }
}

async function persistNewOrder(
  env: Env,
  userId: string,
  input: OrderInput,
  idempotencyKey: string,
  idempotencyHash: string,
  requestHash: string,
  sourceOrigin: string,
): Promise<PaymentOrderRow> {
  const policy = await requirePaymentPolicy(env)
  if (policy.enabled !== 1) {
    throw new GatewayError(403, 'payment_disabled', 'Payment is disabled', 'permission_error')
  }
  const plan = await requirePurchasablePlan(env, input.plan_id)
  const provider = await requireActiveStripeProvider(env)
  const priced = paymentAmountWithFee(plan.price_micros, policy.recharge_fee_ppm, plan.currency)
  validatePaymentLimits(policy, plan.price_micros, priced.pay_amount_micros)
  const now = Date.now()
  const effectiveTimeoutMs = Math.max(
    policy.order_timeout_minutes * 60_000,
    STRIPE_MIN_CHECKOUT_EXPIRY_MS,
  )
  const expiresAt = checkedTimestampAdd(now, effectiveTimeoutMs)

  const orderId = await deterministicUuid('payment.order.v1', `${userId}\0${idempotencyKey}`)
  const tradeDigest = await sha256Hex(`payment-trade:v1\0${userId}\0${idempotencyKey}`)
  const outTradeNo = `sub2_${tradeDigest.slice(0, 40)}`
  const productName = `${policy.product_name_prefix}${plan.name}${policy.product_name_suffix}`.slice(0, 500)
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS
  let inserted: { id: string } | null
  try {
    // Both admission predicates are evaluated by the same D1 statement that
    // writes the order. Distinct idempotency keys therefore cannot both pass
    // stale application-level count/sum reads.
    const [insertResult] = await env.DB.batch([
      env.DB.prepare(
      `INSERT INTO payment_orders (
           id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
           idempotency_key_hash, request_hash, order_type, status,
           amount_micros, pay_amount_micros, fee_ppm_snapshot,
           paid_amount_micros, refunded_amount_micros, currency,
           plan_id, plan_name_snapshot, plan_group_id_snapshot,
           plan_validity_days_snapshot, plan_price_micros_snapshot, plan_currency_snapshot,
           plan_daily_quota_micros_snapshot, plan_weekly_quota_micros_snapshot,
           plan_monthly_quota_micros_snapshot, source_url, version,
           expires_at_ms, created_at_ms, updated_at_ms
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, 'subscription', 'PENDING', ?, ?, ?, 0, 0, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?
           FROM payment_config admission
          WHERE admission.id = 'global' AND admission.enabled = 1
            AND (
              SELECT COUNT(*) FROM payment_orders pending
               WHERE pending.user_id = ? AND pending.status = 'PENDING'
                 AND pending.expires_at_ms > ?
            ) < admission.max_pending_orders
            AND (
              admission.daily_limit_micros = 0 OR
              (
                SELECT COALESCE(SUM(existing.pay_amount_micros), 0)
                  FROM payment_orders existing
                 WHERE existing.user_id = ? AND existing.created_at_ms >= ?
                   AND existing.status NOT IN ('EXPIRED', 'CANCELLED', 'FAILED')
                   AND NOT (existing.status = 'PENDING' AND existing.expires_at_ms <= ?)
              ) <= admission.daily_limit_micros - ?
            )
         RETURNING id`,
      ).bind(
        orderId,
        userId,
        provider.id,
        provider.provider_key,
        outTradeNo,
        idempotencyHash,
        requestHash,
        plan.price_micros,
        priced.pay_amount_micros,
        policy.recharge_fee_ppm,
        plan.currency,
        plan.id,
        productName || plan.name,
        plan.group_id,
        plan.validity_days,
        plan.price_micros,
        plan.currency,
        plan.daily_quota_micros,
        plan.weekly_quota_micros,
        plan.monthly_quota_micros,
        sourceOrigin,
        expiresAt,
        now,
        now,
        userId,
        now,
        userId,
        dayStart,
        now,
        priced.pay_amount_micros,
      ),
      paymentEventInsertForStatuses(env, orderId, 'order.created', 'api', outTradeNo, {
        provider_key: provider.provider_key,
        plan_id: plan.id,
      }, now, ['PENDING']),
    ])
    inserted = (insertResult?.results[0] as { id?: unknown } | undefined)?.id === orderId
      ? { id: orderId }
      : null
  } catch (error) {
    const raced = await findOrderByIdempotency(env, userId, idempotencyHash)
    if (raced === null) throw error
    if (raced.request_hash !== requestHash) throw idempotencyConflict()
    return raced
  }
  if (inserted === null) {
    const raced = await findOrderByIdempotency(env, userId, idempotencyHash)
    if (raced !== null) {
      if (raced.request_hash !== requestHash) throw idempotencyConflict()
      return raced
    }
    await throwPaymentAdmissionError(env, userId, priced.pay_amount_micros, now)
  }
  return requireOrder(env, orderId)
}

async function ensureStripeCheckout(env: Env, row: PaymentOrderRow, origin: string): Promise<PaymentOrderRow> {
  if (row.provider_order_id !== null && row.pay_url !== null) return row
  if (row.status !== 'PENDING') return row
  const provider = await requireActiveStripeProvider(env, row.provider_instance_id)
  const resumeToken = await issueResumeToken(env, row.id, checkedTimestampAdd(row.expires_at_ms, RESUME_TOKEN_TTL_MS))
  const success = new URL('/payment/result', origin)
  success.searchParams.set('resume_token', resumeToken)
  success.searchParams.set('order_id', row.id)
  const cancel = new URL('/purchase', origin)
  cancel.searchParams.set('cancelled_order_id', row.id)
  const session = await new StripeClient({ secretKey: provider.secret_key }).createCheckoutSession({
    orderId: row.id,
    amountMinor: microsToMinorUnits(row.pay_amount_micros, row.currency),
    currency: row.currency,
    productName: row.plan_name_snapshot ?? 'Subscription',
    successUrl: success.toString(),
    cancelUrl: cancel.toString(),
    // Both D1 and Stripe use the same effective deadline; configured values
    // below Stripe's 30-minute minimum are raised at order creation.
    expiresAtSeconds: stripeCheckoutExpirySeconds(row.expires_at_ms, Date.now()),
  })
  validateProviderPayment(row, session.amountTotal, session.currency)
  if (session.url === null || session.status !== 'open') {
    throw new GatewayError(502, 'stripe_checkout_unavailable', 'Stripe checkout session is unavailable', 'server_error')
  }
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE payment_orders
        SET provider_order_id = ?, pay_url = ?, payment_intent_id = ?,
            version = version + 1, updated_at_ms = ?
      WHERE id = ? AND status = 'PENDING' AND provider_order_id IS NULL AND version = ?`,
  ).bind(session.id, session.url, session.paymentIntentId, now, row.id, row.version).run()
  if (result.meta.changes !== 1) {
    const raced = await requireOrder(env, row.id)
    if (raced.provider_order_id === null || raced.pay_url === null) {
      throw new GatewayError(409, 'payment_order_changed', 'Payment order changed during checkout creation')
    }
    return raced
  }
  return requireOrder(env, row.id)
}

export async function acceptProviderPayment(
  env: Env,
  order: PaymentOrderRow,
  input: ProviderPaymentInput,
): Promise<PaymentOrderRow> {
  validateProviderPayment(order, input.amountMinor, input.currency)
  validateProviderIdentity(order, input.providerOrderId, input.paymentIntentId)
  const now = Date.now()
  if (isLateProviderPayment(order, now)) {
    return reconcileLateProviderPayment(env, order, input, now)
  }
  const fulfillmentId = await deterministicUuid(
    'payment.fulfillment.v1',
    `${order.id}\0${FULFILLMENT_ACTION}`,
  )
  await env.DB.batch([
    paidOrderUpdate(
      env,
      order,
      input.providerOrderId,
      input.paymentIntentId,
      input.amountMinor,
      input.currency,
      now,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_fulfillments (
         id, order_id, action, status, attempts, available_at_ms, created_at_ms, updated_at_ms
       ) SELECT ?, id, ?, 'pending', 0, ?, ?, ?
           FROM payment_orders WHERE id = ? AND status IN ('PAID', 'RECHARGING')`,
    ).bind(fulfillmentId, FULFILLMENT_ACTION, now, now, now, order.id),
    paymentEventInsertForStatuses(
      env,
      order.id,
      'order.paid',
      input.sourceType,
      input.providerEventId,
      {},
      now,
      ['PAID', 'RECHARGING', 'COMPLETED'],
    ),
  ])
  const latest = await requireOrder(env, order.id)
  validateProviderIdentity(latest, input.providerOrderId, input.paymentIntentId)
  await enqueueOutstandingFulfillment(env, latest)
  return latest
}

function paidOrderUpdate(
  env: Env,
  order: PaymentOrderRow,
  providerOrderId: string,
  paymentIntentId: string,
  amountMinor: number,
  currency: string,
  now: number,
): D1PreparedStatement {
  validateProviderIdentity(order, providerOrderId, paymentIntentId)
  const paidMicros = validateProviderPayment(order, amountMinor, currency)
  return env.DB.prepare(
    `UPDATE payment_orders
        SET status = 'PAID', paid_amount_micros = ?,
            provider_order_id = COALESCE(provider_order_id, ?),
            payment_intent_id = COALESCE(payment_intent_id, ?),
            payment_trade_no = COALESCE(payment_trade_no, ?),
            paid_at_ms = COALESCE(paid_at_ms, ?), last_error = NULL,
            version = version + 1, updated_at_ms = ?
      WHERE id = ? AND provider_instance_id = ?
        AND status = 'PENDING' AND expires_at_ms > ?`,
  ).bind(
    paidMicros,
    providerOrderId,
    paymentIntentId,
    paymentIntentId,
    now,
    now,
    order.id,
    order.provider_instance_id,
    now,
  )
}

function isLateProviderPayment(order: PaymentOrderRow, now: number): boolean {
  if (['EXPIRED', 'CANCELLED', 'REFUND_REQUESTED'].includes(order.status)) return true
  return order.status === 'PENDING' && order.expires_at_ms <= now
}

async function reconcileLateWebhookPayment(
  env: Env,
  order: PaymentOrderRow,
  event: StripeEvent,
  inbox: {
    inboxId: string
    providerKey: string
    digest: string
    objectKey: string
    now: number
  },
): Promise<PaymentOrderRow> {
  const input: ProviderPaymentInput = {
    providerEventId: event.id,
    sourceType: 'webhook',
    providerOrderId: event.session.id,
    paymentIntentId: event.session.paymentIntentId,
    amountMinor: event.session.amountTotal,
    currency: event.session.currency,
  }
  const { statements, eventId } = await latePaymentStatements(env, order, input, inbox.now)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_webhook_inbox (
         id, provider_key, provider_event_id, event_type, payload_sha256,
         payload_r2_key, status, attempts, available_at_ms,
         received_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?, ?, ?)`,
    ).bind(
      inbox.inboxId,
      inbox.providerKey,
      event.id,
      event.type,
      inbox.digest,
      inbox.objectKey,
      inbox.now,
      inbox.now,
      inbox.now,
    ),
    ...statements,
    env.DB.prepare(
      `UPDATE payment_webhook_inbox
          SET status = 'processed', processed_at_ms = ?, updated_at_ms = ?, last_error = NULL
        WHERE id = ?
          AND EXISTS (
            SELECT 1 FROM payment_events
             WHERE id = ? AND order_id = ?
               AND event_type = 'order.late_payment_reconciliation_required'
          )`,
    ).bind(inbox.now, inbox.now, inbox.inboxId, eventId, order.id),
  ])
  const [latest, handled] = await Promise.all([
    requireOrder(env, order.id),
    findWebhook(env, inbox.providerKey, event.id),
  ])
  if (latest.status !== 'REFUND_REQUESTED' || handled?.status !== 'processed') {
    throw new GatewayError(
      409,
      'late_payment_reconciliation_failed',
      'Late payment could not be placed into refund reconciliation',
    )
  }
  return latest
}

async function reconcileLateProviderPayment(
  env: Env,
  order: PaymentOrderRow,
  input: ProviderPaymentInput,
  now: number,
): Promise<PaymentOrderRow> {
  const { statements } = await latePaymentStatements(env, order, input, now)
  await env.DB.batch(statements)
  const latest = await requireOrder(env, order.id)
  if (latest.status !== 'REFUND_REQUESTED') {
    throw new GatewayError(
      409,
      'late_payment_reconciliation_failed',
      'Late payment could not be placed into refund reconciliation',
    )
  }
  return latest
}

async function latePaymentStatements(
  env: Env,
  order: PaymentOrderRow,
  input: ProviderPaymentInput,
  now: number,
): Promise<{ statements: D1PreparedStatement[]; eventId: string }> {
  validateProviderIdentity(order, input.providerOrderId, input.paymentIntentId)
  const paidMicros = validateProviderPayment(order, input.amountMinor, input.currency)
  const refundId = await deterministicUuid('payment.refund.late.v1', order.id)
  const requestHash = await sha256Hex(`payment-refund-late:v1\0${order.id}`)
  const eventId = await deterministicUuid(
    'payment.event.late-payment.v1',
    `${order.id}\0${input.providerEventId}`,
  )
  return {
    eventId,
    statements: [
      env.DB.prepare(
        `UPDATE payment_orders
            SET status = 'REFUND_REQUESTED', paid_amount_micros = ?,
                provider_order_id = COALESCE(provider_order_id, ?),
                payment_intent_id = COALESCE(payment_intent_id, ?),
                payment_trade_no = COALESCE(payment_trade_no, ?),
                paid_at_ms = COALESCE(paid_at_ms, ?),
                refund_requested_at_ms = COALESCE(refund_requested_at_ms, ?),
                last_error = ?, version = version + 1, updated_at_ms = MAX(updated_at_ms, ?)
          WHERE id = ? AND provider_instance_id = ?
            AND (
              (status = 'PENDING' AND expires_at_ms <= ?)
              OR status IN ('EXPIRED', 'CANCELLED')
            )`,
      ).bind(
        paidMicros,
        input.providerOrderId,
        input.paymentIntentId,
        input.paymentIntentId,
        now,
        now,
        LATE_PAYMENT_ERROR,
        now,
        order.id,
        order.provider_instance_id,
        now,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_refunds (
           id, order_id, request_key_hash, provider_key, amount_micros,
           currency, status, reason, created_at_ms, updated_at_ms
         )
         SELECT ?, id, ?, provider_key_snapshot, amount_micros,
                currency, 'requested', ?, ?, ?
           FROM payment_orders
          WHERE id = ? AND status = 'REFUND_REQUESTED'
            AND payment_intent_id = ?`,
      ).bind(
        refundId,
        requestHash,
        LATE_PAYMENT_REASON,
        now,
        now,
        order.id,
        input.paymentIntentId,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_events (
           id, order_id, event_type, source_type, source_id,
           payload_json, occurred_at_ms, created_at_ms
         )
         SELECT ?, id, 'order.late_payment_reconciliation_required', ?, ?, ?, ?, ?
           FROM payment_orders
          WHERE id = ? AND status = 'REFUND_REQUESTED'
            AND EXISTS (SELECT 1 FROM payment_refunds WHERE id = ? AND status = 'requested')`,
      ).bind(
        eventId,
        input.sourceType,
        input.providerEventId,
        JSON.stringify({
          provider_order_id: input.providerOrderId,
          payment_intent_id: input.paymentIntentId,
          reason: LATE_PAYMENT_ERROR,
        }),
        now,
        now,
        order.id,
        refundId,
      ),
    ],
  }
}

async function enqueueOutstandingFulfillment(env: Env, row: PaymentOrderRow): Promise<void> {
  if (row.status !== 'PAID' && row.status !== 'RECHARGING') return
  const fulfillment = await env.DB.prepare(
    `SELECT status FROM payment_fulfillments WHERE order_id = ? AND action = ?`,
  ).bind(row.id, FULFILLMENT_ACTION).first<{ status: string }>()
  if (fulfillment?.status === 'applied') return
  await env.EVENTS_QUEUE.send(createPaymentFulfillmentEvent(row.id, Date.now()))
}

/** Bounded cron recovery for local deadlines and their remote Checkout Sessions. */
export async function recoverExpiredPaymentOrders(env: Env, requestedLimit = 25): Promise<number> {
  const normalizedLimit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 25
  const limit = Math.max(1, Math.min(100, normalizedLimit))
  const now = Date.now()
  const due = await env.DB.prepare(
    `${orderSelect()} FROM payment_orders
      WHERE status = 'PENDING' AND expires_at_ms <= ?
      ORDER BY expires_at_ms ASC, id ASC LIMIT ?`,
  ).bind(now, limit).all<PaymentOrderRow>()
  let recovered = 0

  for (const selected of due.results) {
    let row = await requireOrder(env, selected.id)
    if (row.status !== 'PENDING' || row.expires_at_ms > Date.now()) continue
    if (row.provider_order_id === null) {
      if (await markPaymentOrderExpired(env, row, Date.now())) recovered += 1
      continue
    }

    const provider = await requireStripeProviderForExistingOrder(env, row.provider_instance_id)
    const stripe = new StripeClient({ secretKey: provider.secret_key })
    let session: StripeCheckoutSession | null = null
    try {
      session = await stripe.expireCheckoutSession(row.provider_order_id)
    } catch {
      session = await stripe.retrieveCheckoutSession(row.provider_order_id).catch(() => null)
    }
    if (session === null) continue
    if (session.paymentStatus === 'paid') {
      row = await acceptProviderPayment(env, row, {
        providerEventId: `expiry-recovery:${row.provider_order_id}`,
        sourceType: 'provider',
        providerOrderId: session.id,
        paymentIntentId: requirePaymentIntent(session.paymentIntentId),
        amountMinor: session.amountTotal,
        currency: session.currency,
      })
      if (row.status === 'REFUND_REQUESTED') recovered += 1
      continue
    }
    if (session.status === 'expired' && await markPaymentOrderExpired(env, row, Date.now())) {
      recovered += 1
    }
  }
  return recovered
}

async function markPaymentOrderExpired(
  env: Env,
  order: PaymentOrderRow,
  now: number,
): Promise<boolean> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = 'EXPIRED', version = version + 1,
              last_error = NULL, updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND status = 'PENDING' AND expires_at_ms <= ?`,
    ).bind(now, order.id, now),
    paymentEventInsertForStatuses(
      env,
      order.id,
      'order.expired',
      'cron',
      `expiry:${order.id}:${order.expires_at_ms}`,
      { expires_at_ms: order.expires_at_ms },
      now,
      ['EXPIRED'],
    ),
  ])
  return (await requireOrder(env, order.id)).status === 'EXPIRED'
}

function validateProviderPayment(row: PaymentOrderRow, amountMinor: number, currency: string): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new GatewayError(400, 'invalid_payment_amount', 'Provider payment amount is invalid')
  }
  const normalizedCurrency = currency.toUpperCase()
  if (normalizedCurrency !== row.currency) {
    throw new GatewayError(400, 'payment_currency_mismatch', 'Provider payment currency does not match the order')
  }
  const expectedMinor = microsToMinorUnits(row.pay_amount_micros, row.currency)
  if (amountMinor !== expectedMinor) {
    throw new GatewayError(400, 'payment_amount_mismatch', 'Provider payment amount does not match the order')
  }
  return row.pay_amount_micros
}

function validateProviderIdentity(
  row: PaymentOrderRow,
  providerOrderId: string,
  paymentIntentId: string,
): void {
  if (row.provider_order_id !== null && row.provider_order_id !== providerOrderId) {
    throw new GatewayError(400, 'payment_provider_order_mismatch', 'Provider order does not match the order')
  }
  if (row.payment_intent_id !== null && row.payment_intent_id !== paymentIntentId) {
    throw new GatewayError(400, 'payment_intent_mismatch', 'Payment intent does not match the order')
  }
}

async function createOrderProjection(env: Env, row: PaymentOrderRow): Promise<Record<string, unknown>> {
  return {
    order_id: row.id,
    amount: major(row.amount_micros),
    pay_amount: major(row.pay_amount_micros),
    fee_rate: row.fee_ppm_snapshot / 10_000,
    currency: row.currency,
    payment_type: 'stripe',
    order_type: row.order_type,
    plan_id: row.plan_id,
    out_trade_no: row.out_trade_no,
    pay_url: row.pay_url ?? undefined,
    expires_at: iso(row.expires_at_ms),
    payment_mode: 'redirect',
    result_type: 'order_created',
    resume_token: await issueResumeToken(
      env,
      row.id,
      checkedTimestampAdd(row.expires_at_ms, RESUME_TOKEN_TTL_MS),
    ),
  }
}

export function publicOrder(row: PaymentOrderRow, includeOwner: boolean): Record<string, unknown> {
  const paid = ['PAID', 'RECHARGING', 'COMPLETED', 'REFUND_REQUESTED', 'REFUNDING',
    'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'].includes(row.status)
  return {
    id: row.id,
    ...(includeOwner ? { user_id: row.user_id } : {}),
    amount: major(row.amount_micros),
    pay_amount: major(row.pay_amount_micros),
    currency: row.currency,
    fee_rate: row.fee_ppm_snapshot / 10_000,
    payment_type: 'stripe',
    out_trade_no: row.out_trade_no,
    status: row.status,
    paid,
    order_type: row.order_type,
    plan_id: row.plan_id,
    ...(includeOwner ? { provider_instance_id: row.provider_instance_id } : {}),
    provider_order_id: row.provider_order_id,
    subscription_id: row.subscription_id,
    created_at: iso(row.created_at_ms),
    expires_at: iso(row.expires_at_ms),
    paid_at: nullableIso(row.paid_at_ms),
    completed_at: nullableIso(row.completed_at_ms),
    refund_amount: major(row.refunded_amount_micros),
    refund_requested_at: nullableIso(row.refund_requested_at_ms),
    refund_at: nullableIso(row.refund_completed_at_ms),
    failed_reason: row.failed_reason ?? row.last_error,
  }
}

export function orderSelect(alias = ''): string {
  const prefix = alias === '' ? '' : `${alias}.`
  const columns = [
    'id', 'user_id', 'provider_instance_id', 'provider_key_snapshot', 'out_trade_no',
    'idempotency_key_hash', 'request_hash', 'provider_order_id', 'payment_intent_id',
    'payment_trade_no', 'pay_url', 'order_type', 'status', 'amount_micros',
    'pay_amount_micros', 'fee_ppm_snapshot', 'paid_amount_micros', 'refunded_amount_micros',
    'currency', 'plan_id', 'plan_name_snapshot', 'plan_group_id_snapshot',
    'plan_validity_days_snapshot', 'plan_price_micros_snapshot', 'plan_currency_snapshot',
    'plan_daily_quota_micros_snapshot', 'plan_weekly_quota_micros_snapshot',
    'plan_monthly_quota_micros_snapshot', 'fulfillment_started_at_ms', 'subscription_id',
    'subscription_fulfilled_at_ms', 'refund_requested_at_ms', 'refund_completed_at_ms',
    'source_url', 'last_error', 'version', 'expires_at_ms', 'paid_at_ms', 'completed_at_ms',
    'failed_at_ms', 'failed_reason', 'created_at_ms', 'updated_at_ms',
  ]
  return `SELECT ${columns.map((column) => `${prefix}${column}`).join(', ')}`
}

export async function findOrder(env: Env, id: string, userId?: string): Promise<PaymentOrderRow | null> {
  const owner = userId === undefined ? '' : ' AND user_id = ?'
  return env.DB.prepare(`${orderSelect()} FROM payment_orders WHERE id = ?${owner}`)
    .bind(...(userId === undefined ? [id] : [id, userId]))
    .first<PaymentOrderRow>()
}

export async function requireOrder(env: Env, id: string): Promise<PaymentOrderRow> {
  const row = await findOrder(env, id)
  if (row === null) throw orderNotFound()
  return row
}

async function findOrderByIdempotency(
  env: Env,
  userId: string,
  idempotencyHash: string,
): Promise<PaymentOrderRow | null> {
  return env.DB.prepare(
    `${orderSelect()} FROM payment_orders WHERE user_id = ? AND idempotency_key_hash = ?`,
  ).bind(userId, idempotencyHash).first<PaymentOrderRow>()
}

async function requirePaymentPolicy(env: Env): Promise<PaymentPolicyRow> {
  const row = await env.DB.prepare(
    `SELECT enabled, min_amount_micros, max_amount_micros, daily_limit_micros,
            order_timeout_minutes, max_pending_orders, recharge_fee_ppm,
            product_name_prefix, product_name_suffix
       FROM payment_config WHERE id = 'global'`,
  ).first<PaymentPolicyRow>()
  if (row === null) {
    throw new GatewayError(503, 'payment_config_unavailable', 'Payment configuration is unavailable', 'server_error')
  }
  return row
}

async function throwPaymentAdmissionError(
  env: Env,
  userId: string,
  payAmountMicros: number,
  now: number,
): Promise<never> {
  const policy = await requirePaymentPolicy(env)
  if (policy.enabled !== 1) {
    throw new GatewayError(403, 'payment_disabled', 'Payment is disabled', 'permission_error')
  }
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM payment_orders
      WHERE user_id = ? AND status = 'PENDING' AND expires_at_ms > ?`,
  ).bind(userId, now).first<{ total: number }>()
  if (pending === null || requireCount(pending.total) >= policy.max_pending_orders) {
    throw new GatewayError(409, 'too_many_pending_orders', 'Too many pending payment orders')
  }
  if (policy.daily_limit_micros > 0) {
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS
    const daily = await env.DB.prepare(
      `SELECT COALESCE(SUM(pay_amount_micros), 0) AS total
         FROM payment_orders
        WHERE user_id = ? AND created_at_ms >= ?
          AND status NOT IN ('EXPIRED', 'CANCELLED', 'FAILED')
          AND NOT (status = 'PENDING' AND expires_at_ms <= ?)`,
    ).bind(userId, dayStart, now).first<{ total: number }>()
    const used = daily === null ? 0 : requireAmount(daily.total, 'daily payment total')
    if (used > policy.daily_limit_micros - payAmountMicros) {
      throw new GatewayError(409, 'daily_payment_limit_exceeded', 'Daily payment limit would be exceeded')
    }
  }
  throw new GatewayError(409, 'payment_order_admission_changed', 'Payment order admission changed')
}

async function requirePurchasablePlan(env: Env, id: string): Promise<PlanRow> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.group_id, p.name, p.description, p.validity_days,
            p.price_micros, p.currency, p.daily_quota_micros,
            p.weekly_quota_micros, p.monthly_quota_micros, p.enabled,
            g.enabled AS group_enabled, g.group_type
       FROM subscription_plans p
       JOIN "groups" g ON g.id = p.group_id
      WHERE p.id = ?`,
  ).bind(id).first<PlanRow>()
  if (row === null || row.enabled !== 1 || row.group_enabled !== 1 || row.group_type !== 'subscription') {
    throw new GatewayError(404, 'subscription_plan_not_found', 'Subscription plan was not found')
  }
  if (row.currency !== 'USD') {
    throw new GatewayError(
      409,
      'subscription_plan_currency_unsupported',
      'Only USD subscription plans are available for Stripe checkout in this release',
    )
  }
  requireAmount(row.price_micros, 'plan price')
  if (row.price_micros <= 0) throw new GatewayError(409, 'subscription_plan_not_payable', 'Subscription plan is not payable')
  return row
}

function parseOrderInput(body: Record<string, unknown>): OrderInput {
  if (body.payment_type !== 'stripe') {
    throw new GatewayError(400, 'unsupported_payment_type', 'Only Stripe payment is supported')
  }
  if (body.order_type !== 'subscription') {
    throw new GatewayError(400, 'unsupported_order_type', 'Only subscription payment orders are supported')
  }
  const planId = requireResourceId(
    typeof body.plan_id === 'string' ? body.plan_id : undefined,
    'plan',
  )
  if (body.amount !== undefined && (typeof body.amount !== 'number' || !Number.isFinite(body.amount))) {
    throw new GatewayError(400, 'invalid_amount', 'amount must be finite')
  }
  return { payment_type: 'stripe', order_type: 'subscription', plan_id: planId }
}

function validatePaymentLimits(policy: PaymentPolicyRow, amountMicros: number, payAmountMicros: number): void {
  requireAmount(amountMicros, 'payment amount')
  requireAmount(payAmountMicros, 'pay amount')
  if (amountMicros < policy.min_amount_micros) {
    throw new GatewayError(400, 'payment_amount_too_small', 'Payment amount is below the configured minimum')
  }
  if (policy.max_amount_micros > 0 && amountMicros > policy.max_amount_micros) {
    throw new GatewayError(400, 'payment_amount_too_large', 'Payment amount exceeds the configured maximum')
  }
}

function parseStripeEvent(rawBody: string): StripeEvent | null {
  let value: unknown
  try {
    value = JSON.parse(rawBody)
  } catch {
    throw new GatewayError(400, 'invalid_payment_webhook', 'Payment webhook body is invalid')
  }
  const event = record(value)
  const type = text(event.type, 'event.type', 200)
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(type)) {
    return null
  }
  const data = record(event.data)
  const session = record(data.object)
  const metadata = record(session.metadata)
  const reference = typeof session.client_reference_id === 'string' ? session.client_reference_id : ''
  const metadataOrder = typeof metadata.order_id === 'string' ? metadata.order_id : ''
  if (reference === '' || metadataOrder !== reference) {
    throw new GatewayError(400, 'payment_order_reference_mismatch', 'Payment order reference is invalid')
  }
  return {
    id: text(event.id, 'event.id', 255),
    type,
    session: {
      id: text(session.id, 'session.id', 200),
      orderId: text(reference, 'session.order_id', 200),
      paymentStatus: text(session.payment_status, 'session.payment_status', 64),
      status: text(session.status, 'session.status', 64),
      amountTotal: safeInteger(session.amount_total, 'session.amount_total'),
      currency: text(session.currency, 'session.currency', 3),
      paymentIntentId: text(session.payment_intent, 'session.payment_intent', 200),
    },
  }
}

async function findWebhook(
  env: Env,
  providerKey: string,
  eventId: string,
): Promise<{ payload_sha256: string; status: string } | null> {
  return env.DB.prepare(
    `SELECT payload_sha256, status FROM payment_webhook_inbox
      WHERE provider_key = ? AND provider_event_id = ?`,
  ).bind(providerKey, eventId).first<{ payload_sha256: string; status: string }>()
}

function paymentEventInsertForStatuses(
  env: Env,
  orderId: string,
  eventType: string,
  sourceType: 'api' | 'webhook' | 'provider' | 'queue' | 'cron' | 'admin' | 'system',
  sourceId: string,
  payload: Record<string, unknown>,
  now: number,
  statuses: OrderStatus[],
): D1PreparedStatement {
  const placeholders = statuses.map(() => '?').join(', ')
  return env.DB.prepare(
    `INSERT OR IGNORE INTO payment_events (
       id, order_id, event_type, source_type, source_id,
       payload_json, occurred_at_ms, created_at_ms
     ) SELECT ?, id, ?, ?, ?, ?, ?, ?
         FROM payment_orders WHERE id = ? AND status IN (${placeholders})`,
  ).bind(
    `${eventType}:${sourceType}:${sourceId}`.slice(0, 255),
    eventType,
    sourceType,
    sourceId.slice(0, 255),
    JSON.stringify(payload),
    now,
    now,
    orderId,
    ...statuses,
  )
}

async function issueResumeToken(env: Env, orderId: string, expiresAtMs: number): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify({ oid: orderId, exp: expiresAtMs }))
  return `payres1.${payload}.${await signResumePayload(env, payload)}`
}

async function verifyResumeToken(env: Env, token: string): Promise<string> {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'payres1') throw invalidResumeToken()
  const expected = await signResumePayload(env, parts[1]!)
  if (!constantTimeEqual(expected, parts[2]!)) throw invalidResumeToken()
  let value: unknown
  try {
    value = JSON.parse(base64UrlDecode(parts[1]!))
  } catch {
    throw invalidResumeToken()
  }
  const payload = record(value)
  const orderId = text(payload.oid, 'resume order', 200)
  const expiresAt = safeInteger(payload.exp, 'resume expiry')
  if (expiresAt <= Date.now() || expiresAt > MAX_DATE_MS) throw invalidResumeToken()
  return orderId
}

async function signResumePayload(env: Env, payload: string): Promise<string> {
  const secret = env.API_KEY_PEPPER
  if (typeof secret !== 'string' || new TextEncoder().encode(secret).byteLength < 32) {
    throw new GatewayError(503, 'payment_resume_not_configured', 'Payment recovery is not configured', 'server_error')
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`payment-resume:v1\0${payload}`)))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return base64Url(btoa(binary))
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return base64Url(btoa(binary))
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}

function base64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < size; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function paymentError(error: unknown): GatewayError {
  if (error instanceof StripeAdapterError) {
    return new GatewayError(error.status, error.code, error.message, 'server_error')
  }
  return asGatewayError(error)
}

function idempotencyConflict(): GatewayError {
  return new GatewayError(
    409,
    'idempotency_conflict',
    'Idempotency-Key was already used with different payment order data',
  )
}

function orderNotFound(): GatewayError {
  return new GatewayError(404, 'payment_order_not_found', 'Payment order was not found')
}

function invalidResumeToken(): GatewayError {
  return new GatewayError(404, 'payment_order_not_found', 'Payment order was not found')
}

function optionalStatus(value: string | undefined): OrderStatus | undefined {
  if (value === undefined || value === '') return undefined
  const statuses: OrderStatus[] = [
    'PENDING', 'PAID', 'RECHARGING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED',
    'REFUND_REQUESTED', 'REFUNDING', 'REFUND_PENDING', 'PARTIALLY_REFUNDED',
    'REFUNDED', 'REFUND_FAILED',
  ]
  if (!statuses.includes(value as OrderStatus)) {
    throw new GatewayError(400, 'invalid_payment_status', 'Payment status is invalid')
  }
  return value as OrderStatus
}

function requireCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(500, 'invalid_payment_count', 'Payment count is invalid', 'server_error')
  }
  return value as number
}

function requireAmount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(500, 'invalid_payment_amount', `${field} is invalid`, 'server_error')
  }
  return value as number
}

function requirePaymentIntent(value: string | null): string {
  if (value === null) throw new GatewayError(502, 'stripe_payment_intent_missing', 'Stripe payment intent is missing')
  return value
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(400, 'invalid_payment_webhook', `${field} is invalid`)
  }
  return value as number
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_payment_webhook', 'Payment webhook body is invalid')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new GatewayError(400, 'invalid_payment_webhook', `${field} is invalid`)
  }
  return value
}

function safeObjectPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 255)
}

function checkedTimestampAdd(value: number, delta: number): number {
  const result = value + delta
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_DATE_MS) {
    throw new GatewayError(500, 'invalid_payment_timestamp', 'Payment timestamp is invalid', 'server_error')
  }
  return result
}

function stripeCheckoutExpirySeconds(localExpiresAtMs: number, now: number): number {
  const providerMinimum = Math.ceil((now + STRIPE_MIN_CHECKOUT_EXPIRY_MS) / 1_000)
  return Math.max(Math.floor(localExpiresAtMs / 1_000), providerMinimum)
}

function major(micros: number): number {
  return micros / 1_000_000
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function nullableIso(value: number | null): string | null {
  return value === null ? null : iso(value)
}

function stripeWebhookAck(): Response {
  return new Response('', { status: 200 })
}
