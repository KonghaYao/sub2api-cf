import type { Context } from 'hono'

import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  requireResourceId,
} from '../control/http'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { requireStripeProviderForExistingOrder } from './config'
import { fulfillPaymentOrder } from './fulfillment'
import {
  acceptProviderPayment,
  findOrder,
  orderSelect,
  publicOrder,
  type PaymentOrderRow,
} from './orders'
import {
  StripeAdapterError,
  StripeClient,
  type StripeCheckoutSession,
} from './stripe'

type PaymentAdminBindings = { Bindings: Env }

const DAY_MS = 86_400_000
const MAX_DATE_MS = 8_640_000_000_000_000
const MAX_SAFE_INTEGER = 9_007_199_254_740_991
const TOP_USERS_LIMIT = 10
const FULFILLMENT_ACTION = 'subscription_entitlement'
const PAID_STATUSES = ['PAID', 'RECHARGING', 'COMPLETED'] as const
const ORDER_STATUSES = [
  'PENDING',
  'PAID',
  'RECHARGING',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
  'REFUND_REQUESTED',
  'REFUNDING',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REFUND_FAILED',
] as const
const PROVIDER_TYPES = [
  'alipay',
  'wxpay',
  'alipay_direct',
  'wxpay_direct',
  'stripe',
  'easypay',
  'airwallex',
] as const

interface CurrencyAggregateRow {
  currency: string
  total_micros: number
  order_count: number
  today_micros: number
  today_count: number
}

interface DailyAggregateRow {
  day: string
  currency: string
  amount_micros: number
  order_count: number
}

interface MethodAggregateRow {
  payment_type: string
  currency: string
  amount_micros: number
  order_count: number
}

interface TopUserRow {
  currency: string
  user_id: string
  email: string
  amount_micros: number
}

interface AdminOrderListRow extends PaymentOrderRow {
  owner_email: string
  owner_name: string
  provider_type: string
  provider_name: string
  provider_enabled: number
}

interface OwnerRow {
  id: string
  email: string
  display_name: string
  status: string
}

interface ProviderSummaryRow {
  id: string
  provider_key: string
  provider_type: string
  display_name: string
  enabled: number
  version: number
}

interface PaymentEventRow {
  id: string
  event_type: string
  source_type: string
  source_id: string
  payload_json: string
  occurred_at_ms: number
}

/** GET /api/v1/admin/payment/dashboard */
export async function getAdminPaymentDashboard(
  context: Context<PaymentAdminBindings>,
): Promise<Response> {
  try {
    const days = queryInteger(context.req.query('days'), 'days', 30, 1, 365)
    const now = Date.now()
    const todayStart = startOfUtcDay(now)
    const rangeStart = todayStart - (days - 1) * DAY_MS
    const paidStatusSql = PAID_STATUSES.map(() => '?').join(', ')
    const amountExpression = `CASE
      WHEN paid_amount_micros > 0 THEN paid_amount_micros
      ELSE pay_amount_micros END`
    const statusValues = [...PAID_STATUSES]

    const [currencyResult, dailyResult, methodResult, topUsersResult, pendingResult] =
      await context.env.DB.batch([
        context.env.DB.prepare(
          `SELECT currency,
                  SUM(${amountExpression}) AS total_micros,
                  COUNT(*) AS order_count,
                  SUM(CASE WHEN paid_at_ms >= ? THEN ${amountExpression} ELSE 0 END) AS today_micros,
                  SUM(CASE WHEN paid_at_ms >= ? THEN 1 ELSE 0 END) AS today_count
             FROM payment_orders
            WHERE status IN (${paidStatusSql})
              AND paid_at_ms >= ? AND paid_at_ms <= ?
            GROUP BY currency ORDER BY currency ASC`,
        ).bind(todayStart, todayStart, ...statusValues, rangeStart, now),
        context.env.DB.prepare(
          `SELECT strftime('%Y-%m-%d', paid_at_ms / 1000.0, 'unixepoch') AS day,
                  currency, SUM(${amountExpression}) AS amount_micros,
                  COUNT(*) AS order_count
             FROM payment_orders
            WHERE status IN (${paidStatusSql})
              AND paid_at_ms >= ? AND paid_at_ms <= ?
            GROUP BY day, currency ORDER BY day ASC, currency ASC`,
        ).bind(...statusValues, rangeStart, now),
        context.env.DB.prepare(
          `SELECT provider.provider_type AS payment_type, payment_order.currency,
                  SUM(CASE WHEN payment_order.paid_amount_micros > 0
                           THEN payment_order.paid_amount_micros
                           ELSE payment_order.pay_amount_micros END) AS amount_micros,
                  COUNT(*) AS order_count
             FROM payment_orders payment_order
             JOIN payment_provider_instances provider
               ON provider.id = payment_order.provider_instance_id
            WHERE payment_order.status IN (${paidStatusSql})
              AND payment_order.paid_at_ms >= ? AND payment_order.paid_at_ms <= ?
            GROUP BY provider.provider_type, payment_order.currency
            ORDER BY provider.provider_type ASC, payment_order.currency ASC`,
        ).bind(...statusValues, rangeStart, now),
        context.env.DB.prepare(
          `WITH user_totals AS (
             SELECT payment_order.currency, payment_order.user_id, owner.email,
                    SUM(CASE WHEN payment_order.paid_amount_micros > 0
                             THEN payment_order.paid_amount_micros
                             ELSE payment_order.pay_amount_micros END) AS amount_micros
               FROM payment_orders payment_order
               JOIN users owner ON owner.id = payment_order.user_id
              WHERE payment_order.status IN (${paidStatusSql})
                AND payment_order.paid_at_ms >= ? AND payment_order.paid_at_ms <= ?
              GROUP BY payment_order.currency, payment_order.user_id, owner.email
           ), ranked AS (
             SELECT currency, user_id, email, amount_micros,
                    ROW_NUMBER() OVER (
                      PARTITION BY currency ORDER BY amount_micros DESC, user_id ASC
                    ) AS position
               FROM user_totals
           )
           SELECT currency, user_id, email, amount_micros
             FROM ranked WHERE position <= ?
            ORDER BY currency ASC, position ASC`,
        ).bind(...statusValues, rangeStart, now, TOP_USERS_LIMIT),
        context.env.DB.prepare(
          `SELECT COUNT(*) AS pending_orders FROM payment_orders WHERE status = 'PENDING'`,
        ),
      ])

    const currencyRows = currencyResult.results as unknown as CurrencyAggregateRow[]
    const dailyRows = dailyResult.results as unknown as DailyAggregateRow[]
    const methodRows = methodResult.results as unknown as MethodAggregateRow[]
    const topUserRows = topUsersResult.results as unknown as TopUserRow[]
    const pending = requireCount(
      (pendingResult.results[0] as { pending_orders?: unknown } | undefined)?.pending_orders,
      'pending order count',
    )

    const todayAmount: Record<string, number> = {}
    const totalAmount: Record<string, number> = {}
    const averageAmount: Record<string, number> = {}
    let todayCount = 0
    let totalCount = 0
    for (const row of currencyRows) {
      const totalMicros = requireMicros(row.total_micros, 'total payment amount')
      const count = requireCount(row.order_count, 'payment count')
      const todayMicros = requireMicros(row.today_micros, 'today payment amount')
      const currentTodayCount = requireCount(row.today_count, 'today payment count')
      totalAmount[row.currency] = major(totalMicros)
      todayAmount[row.currency] = major(todayMicros)
      averageAmount[row.currency] = count === 0 ? 0 : roundMajor(totalMicros / count)
      totalCount = checkedSum(totalCount, count)
      todayCount = checkedSum(todayCount, currentTodayCount)
    }

    const daily = new Map<string, { amount: Record<string, number>; count: number }>()
    for (const row of dailyRows) {
      const value = daily.get(row.day) ?? { amount: {}, count: 0 }
      value.amount[row.currency] = major(requireMicros(row.amount_micros, 'daily payment amount'))
      value.count = checkedSum(value.count, requireCount(row.order_count, 'daily payment count'))
      daily.set(row.day, value)
    }

    const methods = new Map<string, { amount: Record<string, number>; count: number }>()
    for (const row of methodRows) {
      const value = methods.get(row.payment_type) ?? { amount: {}, count: 0 }
      value.amount[row.currency] = major(requireMicros(row.amount_micros, 'method payment amount'))
      value.count = checkedSum(value.count, requireCount(row.order_count, 'method payment count'))
      methods.set(row.payment_type, value)
    }

    const topUsers: Record<string, Array<{ user_id: string; email: string; amount: number }>> = {}
    for (const row of topUserRows) {
      const users = topUsers[row.currency] ?? []
      users.push({
        user_id: row.user_id,
        email: row.email,
        amount: major(requireMicros(row.amount_micros, 'user payment amount')),
      })
      topUsers[row.currency] = users
    }

    return controlSuccess({
      today_amount: todayAmount,
      total_amount: totalAmount,
      today_count: todayCount,
      total_count: totalCount,
      avg_amount: averageAmount,
      pending_orders: pending,
      daily_series: Array.from({ length: days }, (_, index) => {
        const date = utcDate(rangeStart + index * DAY_MS)
        const value = daily.get(date)
        return { date, amount: value?.amount ?? {}, count: value?.count ?? 0 }
      }),
      payment_methods: [...methods].map(([type, value]) => ({ type, ...value })),
      top_users: topUsers,
    })
  } catch (error) {
    return controlError(adminPaymentError(error))
  }
}

/** GET /api/v1/admin/payment/orders */
export async function listAdminPaymentOrders(
  context: Context<PaymentAdminBindings>,
): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const clauses: string[] = []
    const values: unknown[] = []
    const status = optionalOrderStatus(context.req.query('status'))
    if (status !== undefined) {
      clauses.push('payment_order.status = ?')
      values.push(status)
    }
    const orderType = optionalOrderType(context.req.query('order_type'))
    if (orderType !== undefined) {
      clauses.push('payment_order.order_type = ?')
      values.push(orderType)
    }
    const providerType = optionalProviderType(context.req.query('payment_type'))
    if (providerType !== undefined) {
      clauses.push('provider.provider_type = ?')
      values.push(providerType)
    }
    const rawUserId = context.req.query('user_id')
    if (rawUserId !== undefined && rawUserId !== '') {
      clauses.push('payment_order.user_id = ?')
      values.push(requireResourceId(rawUserId, 'user'))
    }
    const keyword = optionalKeyword(context.req.query('keyword'))
    if (keyword !== undefined) {
      clauses.push(`(
        payment_order.out_trade_no LIKE ? ESCAPE '\\'
        OR COALESCE(payment_order.payment_trade_no, '') LIKE ? ESCAPE '\\'
        OR owner.email LIKE ? ESCAPE '\\'
        OR owner.display_name LIKE ? ESCAPE '\\'
      )`)
      const pattern = `%${escapeLike(keyword)}%`
      values.push(pattern, pattern, pattern, pattern)
    }
    const start = optionalDateBoundary(context.req.query('start_date'), 'start_date', false)
    const end = optionalDateBoundary(context.req.query('end_date'), 'end_date', true)
    if (start !== undefined) {
      clauses.push('payment_order.created_at_ms >= ?')
      values.push(start)
    }
    if (end !== undefined) {
      clauses.push('payment_order.created_at_ms < ?')
      values.push(end)
    }
    if (start !== undefined && end !== undefined && start >= end) {
      throw new GatewayError(400, 'invalid_payment_date_range', 'start_date must be before end_date')
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const from = `FROM payment_orders payment_order
      JOIN users owner ON owner.id = payment_order.user_id
      JOIN payment_provider_instances provider ON provider.id = payment_order.provider_instance_id`
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) AS total ${from} ${where}`).bind(...values),
      context.env.DB.prepare(
        `${orderSelect('payment_order')},
                owner.email AS owner_email, owner.display_name AS owner_name,
                provider.provider_type AS provider_type,
                provider.display_name AS provider_name,
                provider.enabled AS provider_enabled
           ${from} ${where}
          ORDER BY payment_order.created_at_ms DESC, payment_order.id DESC
          LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const total = requireCount(
      (countResult.results[0] as { total?: unknown } | undefined)?.total,
      'payment order count',
    )
    return controlSuccess({
      items: (rowsResult.results as unknown as AdminOrderListRow[]).map(adminOrder),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(adminPaymentError(error))
  }
}

/** GET /api/v1/admin/payment/orders/:id */
export async function getAdminPaymentOrder(
  context: Context<PaymentAdminBindings>,
): Promise<Response> {
  try {
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    const order = await findOrder(context.env, orderId)
    if (order === null) throw paymentOrderNotFound()
    const [ownerResult, providerResult, eventsResult, fulfillmentResult, refundsResult] =
      await context.env.DB.batch([
        context.env.DB.prepare(
          `SELECT id, email, display_name, status FROM users WHERE id = ?`,
        ).bind(order.user_id),
        context.env.DB.prepare(
          `SELECT id, provider_key, provider_type, display_name, enabled, version
             FROM payment_provider_instances WHERE id = ?`,
        ).bind(order.provider_instance_id),
        context.env.DB.prepare(
          `SELECT id, event_type, source_type, source_id, payload_json, occurred_at_ms
             FROM payment_events WHERE order_id = ?
            ORDER BY occurred_at_ms ASC, id ASC LIMIT 200`,
        ).bind(order.id),
        context.env.DB.prepare(
          `SELECT status, attempts, result_resource_type, result_resource_id,
                  last_error, created_at_ms, updated_at_ms, applied_at_ms
             FROM payment_fulfillments WHERE order_id = ?
            ORDER BY created_at_ms ASC, id ASC`,
        ).bind(order.id),
        context.env.DB.prepare(
          `SELECT id, provider_refund_id, amount_micros, settled_amount_micros,
                  currency, status, reason, last_error,
                  created_at_ms, updated_at_ms, completed_at_ms
             FROM payment_refunds WHERE order_id = ?
            ORDER BY created_at_ms ASC, id ASC`,
        ).bind(order.id),
      ])
    const owner = ownerResult.results[0] as OwnerRow | undefined
    const provider = providerResult.results[0] as ProviderSummaryRow | undefined
    const events = eventsResult.results as unknown as PaymentEventRow[]
    return controlSuccess({
      order: adminOrder({
        ...order,
        owner_email: owner?.email ?? '',
        owner_name: owner?.display_name ?? '',
        provider_type: provider?.provider_type ?? '',
        provider_name: provider?.display_name ?? '',
        provider_enabled: provider?.enabled ?? 0,
      }),
      owner: owner === undefined ? null : {
        id: owner.id,
        email: owner.email,
        name: owner.display_name,
        status: owner.status,
      },
      provider: provider === undefined ? null : publicProvider(provider),
      auditLogs: events.map((event) => ({
        id: event.id,
        action: event.event_type,
        operator: event.source_type,
        source_id: event.source_id,
        detail: parseEventPayload(event.payload_json),
        created_at: iso(event.occurred_at_ms),
      })),
      fulfillment: fulfillmentResult.results,
      refunds: (refundsResult.results as Array<Record<string, unknown>>).map((refund) => ({
        ...refund,
        amount: major(requireMicros(refund.amount_micros, 'refund amount')),
        settled_amount: major(requireMicros(refund.settled_amount_micros, 'settled refund amount')),
        created_at: iso(requireTimestamp(refund.created_at_ms, 'refund creation timestamp')),
        updated_at: iso(requireTimestamp(refund.updated_at_ms, 'refund update timestamp')),
        completed_at: nullableIso(refund.completed_at_ms),
      })),
    })
  } catch (error) {
    return controlError(adminPaymentError(error))
  }
}

/** POST /api/v1/admin/payment/orders/:id/cancel */
export async function cancelAdminPaymentOrder(
  context: Context<PaymentAdminBindings>,
): Promise<Response> {
  try {
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    const order = await findOrder(context.env, orderId)
    if (order === null) throw paymentOrderNotFound()
    if (order.status === 'CANCELLED') {
      return controlSuccess({
        message: 'order cancelled',
        idempotent: true,
        order: publicOrder(order, true),
      })
    }
    if (order.status !== 'PENDING') {
      throw new GatewayError(
        409,
        'payment_order_not_cancellable',
        'Only a pending payment order can be cancelled',
      )
    }
    if (order.provider_order_id !== null) {
      const paid = await expireProviderCheckout(context.env, order)
      if (paid !== null) {
        return controlSuccess({
          message: 'order payment accepted',
          idempotent: paid.status === 'COMPLETED',
          order: publicOrder(paid, true),
        })
      }
    }
    const now = Date.now()
    const targetVersion = checkedIncrement(order.version)
    const eventId = await deterministicUuid('payment.admin.cancel.v1', order.id)
    const sourceId = `admin-cancel:${order.id}`
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE payment_orders
            SET status = 'CANCELLED', version = version + 1,
                last_error = NULL, updated_at_ms = MAX(updated_at_ms, ?)
          WHERE id = ? AND status = 'PENDING' AND version = ?`,
      ).bind(now, order.id, order.version),
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO payment_events (
           id, order_id, event_type, source_type, source_id,
           payload_json, occurred_at_ms, created_at_ms
         )
         SELECT ?, id, 'order.cancelled', 'admin', ?,
                '{"detail":"admin cancelled order"}', ?, ?
           FROM payment_orders
          WHERE id = ? AND status = 'CANCELLED' AND version = ?`,
      ).bind(eventId, sourceId, now, now, order.id, targetVersion),
    ])
    const latest = await findOrder(context.env, order.id)
    if (latest === null) throw paymentOrderNotFound()
    if (latest.status !== 'CANCELLED') {
      throw new GatewayError(409, 'payment_order_changed', 'Payment order changed while it was being cancelled')
    }
    return controlSuccess({
      message: 'order cancelled',
      idempotent: latest.version !== targetVersion,
      order: publicOrder(latest, true),
    })
  } catch (error) {
    return controlError(adminPaymentError(error))
  }
}

async function expireProviderCheckout(
  env: Env,
  order: PaymentOrderRow,
): Promise<PaymentOrderRow | null> {
  const providerOrderId = order.provider_order_id
  if (providerOrderId === null) return null
  const provider = await requireStripeProviderForExistingOrder(
    env,
    order.provider_instance_id,
  )
  const stripe = new StripeClient({ secretKey: provider.secret_key })
  let session: StripeCheckoutSession
  try {
    session = await stripe.expireCheckoutSession(providerOrderId)
  } catch (expireError) {
    const recovered = await stripe.retrieveCheckoutSession(providerOrderId).catch(() => null)
    if (recovered === null || (
      recovered.paymentStatus !== 'paid' && recovered.status !== 'expired'
    )) {
      throw expireError
    }
    session = recovered
  }
  if (session.paymentStatus !== 'paid') return null
  return acceptProviderPayment(env, order, {
    providerEventId: `admin-cancel:${providerOrderId}`,
    sourceType: 'provider',
    providerOrderId: session.id,
    paymentIntentId: requirePaidPaymentIntent(session.paymentIntentId),
    amountMinor: session.amountTotal,
    currency: session.currency,
  })
}

function requirePaidPaymentIntent(value: string | null): string {
  if (value === null) {
    throw new GatewayError(
      502,
      'stripe_payment_intent_missing',
      'Stripe payment intent is missing',
      'server_error',
    )
  }
  return value
}

/** POST /api/v1/admin/payment/orders/:id/retry */
export async function retryAdminPaymentFulfillment(
  context: Context<PaymentAdminBindings>,
): Promise<Response> {
  try {
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    let order = await findOrder(context.env, orderId)
    if (order === null) throw paymentOrderNotFound()
    if (order.status === 'COMPLETED') {
      return controlSuccess({
        message: 'fulfillment already completed',
        idempotent: true,
        order: publicOrder(order, true),
      })
    }
    if (order.status === 'FAILED') {
      if (order.paid_at_ms === null || order.paid_amount_micros <= 0) {
        throw new GatewayError(
          409,
          'payment_order_not_paid',
          'An unpaid failed order cannot retry fulfillment',
        )
      }
      await reopenFailedOrder(context.env, order)
      order = await findOrder(context.env, order.id)
      if (order === null) throw paymentOrderNotFound()
    }
    if (order.status !== 'PAID' && order.status !== 'RECHARGING') {
      throw new GatewayError(
        409,
        'payment_fulfillment_not_retryable',
        'Only paid or recoverable fulfillment orders can be retried',
      )
    }
    const now = Date.now()
    await context.env.DB.prepare(
      `UPDATE payment_fulfillments
          SET status = 'failed', available_at_ms = ?, last_error = NULL,
              lease_owner = NULL, lease_expires_at_ms = NULL,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE order_id = ? AND action = ?
          AND status IN ('failed', 'dead_letter')`,
    ).bind(now, now, order.id, FULFILLMENT_ACTION).run()
    const result = await fulfillPaymentOrder(context.env, order.id)
    const completed = await findOrder(context.env, order.id)
    if (completed === null) throw paymentOrderNotFound()
    return controlSuccess({
      message: 'fulfillment retried',
      idempotent: result.idempotent,
      order: publicOrder(completed, true),
    })
  } catch (error) {
    return controlError(adminPaymentError(error))
  }
}

async function reopenFailedOrder(env: Env, order: PaymentOrderRow): Promise<void> {
  const now = Date.now()
  const targetVersion = checkedIncrement(order.version)
  const eventId = await deterministicUuid('payment.admin.retry.v1', order.id)
  const sourceId = `admin-retry:${order.id}`
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = 'PAID', failed_at_ms = NULL, failed_reason = NULL,
              last_error = NULL, version = version + 1,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND status = 'FAILED' AND version = ?
          AND paid_at_ms IS NOT NULL AND paid_amount_micros > 0`,
    ).bind(now, order.id, order.version),
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_events (
         id, order_id, event_type, source_type, source_id,
         payload_json, occurred_at_ms, created_at_ms
       )
       SELECT ?, id, 'fulfillment.retry.requested', 'admin', ?, '{}', ?, ?
         FROM payment_orders
        WHERE id = ? AND status = 'PAID' AND version = ?`,
    ).bind(eventId, sourceId, now, now, order.id, targetVersion),
  ])
}

function adminOrder(row: AdminOrderListRow): Record<string, unknown> {
  return {
    ...publicOrder(row, true),
    user_email: row.owner_email,
    user_name: row.owner_name,
    provider_key: row.provider_key_snapshot,
    provider: {
      id: row.provider_instance_id,
      key: row.provider_key_snapshot,
      type: row.provider_type,
      name: row.provider_name,
      enabled: row.provider_enabled === 1,
    },
    payment_trade_no: row.payment_trade_no,
    payment_intent_id: row.payment_intent_id,
    pay_url: row.pay_url,
    source_url: row.source_url,
    last_error: row.last_error,
    version: row.version,
  }
}

function publicProvider(row: ProviderSummaryRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.provider_key,
    type: row.provider_type,
    name: row.display_name,
    enabled: row.enabled === 1,
    version: row.version,
  }
}

function optionalOrderStatus(value: string | undefined): typeof ORDER_STATUSES[number] | undefined {
  if (value === undefined || value === '') return undefined
  if (!ORDER_STATUSES.includes(value as typeof ORDER_STATUSES[number])) {
    throw new GatewayError(400, 'invalid_payment_status', 'Payment status is invalid')
  }
  return value as typeof ORDER_STATUSES[number]
}

function optionalOrderType(value: string | undefined): 'balance' | 'subscription' | undefined {
  if (value === undefined || value === '') return undefined
  if (value !== 'balance' && value !== 'subscription') {
    throw new GatewayError(400, 'invalid_payment_order_type', 'Payment order type is invalid')
  }
  return value
}

function optionalProviderType(value: string | undefined): typeof PROVIDER_TYPES[number] | undefined {
  if (value === undefined || value === '') return undefined
  if (!PROVIDER_TYPES.includes(value as typeof PROVIDER_TYPES[number])) {
    throw new GatewayError(400, 'invalid_payment_type', 'Payment type is invalid')
  }
  return value as typeof PROVIDER_TYPES[number]
}

function optionalKeyword(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim()
  if (normalized.length > 200) {
    throw new GatewayError(400, 'invalid_keyword', 'keyword must contain at most 200 characters')
  }
  return normalized
}

function optionalDateBoundary(
  value: string | undefined,
  field: string,
  exclusiveEnd: boolean,
): number | undefined {
  if (value === undefined || value === '') return undefined
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const timestamp = Date.parse(dateOnly ? `${value}T00:00:00.000Z` : value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a valid ISO date`)
  }
  return dateOnly && exclusiveEnd ? timestamp + DAY_MS : timestamp
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function parseEventPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function paymentOrderNotFound(): GatewayError {
  return new GatewayError(404, 'payment_order_not_found', 'Payment order was not found')
}

function adminPaymentError(error: unknown): GatewayError {
  if (error instanceof Error && error.message === 'Payment fulfillment is already being processed') {
    return new GatewayError(409, 'payment_fulfillment_in_progress', error.message)
  }
  if (error instanceof StripeAdapterError) {
    return new GatewayError(error.status, error.code, error.message, 'server_error')
  }
  return asGatewayError(error)
}

function checkedIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'payment_order_version_exhausted', 'Payment order version is exhausted')
  }
  return value + 1
}

function checkedSum(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new GatewayError(500, 'invalid_payment_aggregate', 'Payment aggregate is invalid', 'server_error')
  }
  return total
}

function requireMicros(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(500, 'invalid_payment_aggregate', `${field} is invalid`, 'server_error')
  }
  return value as number
}

function requireCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(500, 'invalid_payment_aggregate', `${field} is invalid`, 'server_error')
  }
  return value as number
}

function requireTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_DATE_MS) {
    throw new GatewayError(500, 'invalid_payment_timestamp', `${field} is invalid`, 'server_error')
  }
  return value as number
}

function major(micros: number): number {
  return micros / 1_000_000
}

function roundMajor(micros: number): number {
  return Math.round(micros) / 1_000_000
}

function startOfUtcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS) * DAY_MS
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : iso(requireTimestamp(value, 'timestamp'))
}
