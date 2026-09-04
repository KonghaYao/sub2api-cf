import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { requireAdminSession } from '../../src/control/admin-auth'
import type { Env, PlatformEvent } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import {
  cancelAdminPaymentOrder,
  getAdminPaymentDashboard,
  getAdminPaymentOrder,
  listAdminPaymentOrders,
  retryAdminPaymentFulfillment,
} from '../../src/payment/admin'
import { paymentProviderCredentialAad } from '../../src/payment/config'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'payment-admin-test-pepper-at-least-32-bytes'
const MASTER_KEY = 'payment-admin-master-key-value-at-least-32-bytes'
const DAY_MS = 86_400_000
const NOW = Date.UTC(2026, 8, 4, 8, 30)
const ADMIN_ID = '00000000-0000-4000-8000-000000000001'
const BUYER_ID = '00000000-0000-4000-8000-000000000002'
const OTHER_ID = '00000000-0000-4000-8000-000000000003'
const GROUP_ID = '00000000-0000-4000-8000-000000000010'
const PLAN_ID = '00000000-0000-4000-8000-000000000020'
const PROVIDER_ID = '00000000-0000-4000-8000-000000000030'

interface Fixture {
  raw: any
  env: Env
  authorization: Record<'admin' | 'buyer', string>
  state: SubscriptionStateFake
  queue: CapturedQueue
}

class CapturedQueue {
  readonly events: PlatformEvent[] = []

  async send(event: PlatformEvent): Promise<void> {
    this.events.push(event)
  }

  queue(): Queue<PlatformEvent> {
    return this as unknown as Queue<PlatformEvent>
  }
}

class SubscriptionStateFake {
  readonly calls: Array<{ id: string; path: string }> = []

  namespace(): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (request: Request) => {
          this.calls.push({ id, path: new URL(request.url).pathname })
          return Response.json({ schema_version: 1, idempotent: false })
        },
      }),
    } as unknown as DurableObjectNamespace
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('payment admin HTTP contract', () => {
  it('uses the existing admin-session boundary', async () => {
    const test = await fixture()
    const unauthenticated = await request(test, '/dashboard')
    expect(unauthenticated.status).toBe(401)

    const ordinaryUser = await request(test, '/dashboard', {}, 'buyer')
    expect(ordinaryUser.status).toBe(403)

    const admin = await request(test, '/dashboard', {}, 'admin')
    expect(admin.status).toBe(200)
  })

  it('aggregates the dashboard by currency without mixing monetary units', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-usd-today',
      status: 'COMPLETED',
      payAmountMicros: 12_500_000,
      paidAt: NOW - 60_000,
    })
    insertOrder(test.raw, {
      id: 'order-usd-yesterday',
      status: 'PAID',
      payAmountMicros: 7_500_000,
      paidAt: NOW - DAY_MS,
      createdAt: NOW - DAY_MS,
    })
    insertOrder(test.raw, {
      id: 'order-eur-today',
      status: 'RECHARGING',
      currency: 'EUR',
      payAmountMicros: 5_000_000,
      paidAt: NOW - 30_000,
    })
    insertOrder(test.raw, { id: 'order-pending', status: 'PENDING' })

    const response = await request(test, '/dashboard?days=3', {}, 'admin')
    expect(response.status).toBe(200)
    const data = (await json(response)).data
    expect(data).toMatchObject({
      today_amount: { EUR: 5, USD: 12.5 },
      total_amount: { EUR: 5, USD: 20 },
      today_count: 2,
      total_count: 3,
      avg_amount: { EUR: 5, USD: 10 },
      pending_orders: 1,
      payment_methods: [{ type: 'stripe', amount: { EUR: 5, USD: 20 }, count: 3 }],
      top_users: {
        EUR: [{ user_id: BUYER_ID, email: 'buyer@example.test', amount: 5 }],
        USD: [{ user_id: BUYER_ID, email: 'buyer@example.test', amount: 20 }],
      },
    })
    expect(data.daily_series).toHaveLength(3)
    expect(data.daily_series.at(-1)).toEqual({
      date: '2026-09-04',
      amount: { EUR: 5, USD: 12.5 },
      count: 2,
    })
  })

  it('paginates and filters orders while exposing only safe owner/provider metadata', async () => {
    const test = await fixture()
    insertOrder(test.raw, { id: 'order-newer', status: 'COMPLETED', userId: BUYER_ID, createdAt: NOW - 1 })
    insertOrder(test.raw, { id: 'order-older', status: 'COMPLETED', userId: BUYER_ID, createdAt: NOW - 2 })
    insertOrder(test.raw, { id: 'order-other', status: 'PENDING', userId: OTHER_ID, createdAt: NOW - 3 })

    const response = await request(
      test,
      `/orders?page=1&page_size=1&status=COMPLETED&payment_type=stripe&user_id=${BUYER_ID}&keyword=buyer`,
      {},
      'admin',
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toMatchObject({ total: 2, page: 1, page_size: 1, pages: 2 })
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0]).toMatchObject({
      id: 'order-newer',
      user_id: BUYER_ID,
      user_email: 'buyer@example.test',
      user_name: 'Buyer',
      provider_key: 'stripe-primary',
      provider: {
        id: PROVIDER_ID,
        key: 'stripe-primary',
        type: 'stripe',
        name: 'Stripe production',
        enabled: true,
      },
    })
    expect(JSON.stringify(body)).not.toContain('encrypted-provider-secret')

    const invalidOwner = await request(test, '/orders?user_id=../buyer', {}, 'admin')
    expect(invalidOwner.status).toBe(400)
  })

  it('returns one order with safe owner/provider detail and audit events', async () => {
    const test = await fixture()
    insertOrder(test.raw, { id: 'order-detail', status: 'PAID', paidAt: NOW - 1_000 })
    test.raw.prepare(`
      INSERT INTO payment_events (
        id, order_id, event_type, source_type, source_id,
        payload_json, occurred_at_ms, created_at_ms
      ) VALUES ('event-detail', 'order-detail', 'order.paid', 'webhook', 'evt-safe',
                '{"verified":true}', ?, ?)
    `).run(NOW - 1_000, NOW - 1_000)

    const response = await request(test, '/orders/order-detail', {}, 'admin')
    expect(response.status).toBe(200)
    const data = (await json(response)).data
    expect(data.order).toMatchObject({
      id: 'order-detail',
      user_email: 'buyer@example.test',
      provider_key: 'stripe-primary',
      payment_trade_no: 'pi-order-detail',
    })
    expect(data.auditLogs).toEqual([expect.objectContaining({
      id: 'event-detail',
      action: 'order.paid',
      operator: 'webhook',
      detail: { verified: true },
    })])
    expect(JSON.stringify(data)).not.toContain('encrypted-provider-secret')

    expect((await request(test, '/orders/missing-order', {}, 'admin')).status).toBe(404)
    expect((await request(test, '/orders/not%20safe', {}, 'admin')).status).toBe(400)
  })

  it('cancels a pending order with a replay-safe CAS and one audit event', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-cancel',
      status: 'PENDING',
      version: 7,
      providerOrderId: null,
    })

    const [first, raced] = await Promise.all([
      request(test, '/orders/order-cancel/cancel', { method: 'POST' }, 'admin'),
      request(test, '/orders/order-cancel/cancel', { method: 'POST' }, 'admin'),
    ])
    expect(first.status).toBe(200)
    expect(raced.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT status, version FROM payment_orders WHERE id = 'order-cancel'`,
    ).get()).toEqual({ status: 'CANCELLED', version: 8 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_events
        WHERE order_id = 'order-cancel' AND event_type = 'order.cancelled'`,
    ).get()).toEqual({ count: 1 })

    const replay = await request(test, '/orders/order-cancel/cancel', { method: 'POST' }, 'admin')
    expect(replay.status).toBe(200)
    expect((await json(replay)).data).toMatchObject({
      message: 'order cancelled',
      idempotent: true,
      order: { status: 'CANCELLED' },
    })

    insertOrder(test.raw, { id: 'order-paid', status: 'PAID', paidAt: NOW - 1_000 })
    const invalid = await request(test, '/orders/order-paid/cancel', { method: 'POST' }, 'admin')
    expect(invalid.status).toBe(409)
    expect(test.raw.prepare(
      `SELECT status FROM payment_orders WHERE id = 'order-paid'`,
    ).get()).toEqual({ status: 'PAID' })
  })

  it('expires an unpaid historical Stripe Checkout before cancelling locally', async () => {
    const test = await fixture()
    test.raw.prepare(
      'UPDATE payment_provider_instances SET enabled = 0 WHERE id = ?',
    ).run(PROVIDER_ID)
    insertOrder(test.raw, {
      id: 'order-provider-unpaid',
      status: 'PENDING',
      providerOrderId: 'cs_admin_unpaid',
    })
    const stripeFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'https://api.stripe.com/v1/checkout/sessions/cs_admin_unpaid/expire',
      )
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_admin')
      return stripeJson({
        id: 'cs_admin_unpaid',
        object: 'checkout.session',
        status: 'expired',
        payment_status: 'unpaid',
        amount_total: 1250,
        currency: 'usd',
        url: null,
        payment_intent: null,
      })
    })
    vi.stubGlobal('fetch', stripeFetch)

    const response = await request(
      test,
      '/orders/order-provider-unpaid/cancel',
      { method: 'POST' },
      'admin',
    )

    expect(response.status).toBe(200)
    expect((await json(response)).data).toMatchObject({
      message: 'order cancelled',
      order: { status: 'CANCELLED' },
    })
    expect(stripeFetch).toHaveBeenCalledTimes(1)
    expect(test.queue.events).toHaveLength(0)
  })

  it('accepts and queues a payment that wins the administrator cancellation race', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-provider-paid',
      status: 'PENDING',
      providerOrderId: 'cs_admin_paid',
    })
    const stripeFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') {
        return stripeJson({ error: { message: 'session already complete' } }, 400)
      }
      expect(String(input)).toBe(
        'https://api.stripe.com/v1/checkout/sessions/cs_admin_paid',
      )
      return stripeJson({
        id: 'cs_admin_paid',
        object: 'checkout.session',
        status: 'complete',
        payment_status: 'paid',
        amount_total: 1250,
        currency: 'usd',
        url: null,
        payment_intent: 'pi-order-provider-paid',
      })
    })
    vi.stubGlobal('fetch', stripeFetch)

    const response = await request(
      test,
      '/orders/order-provider-paid/cancel',
      { method: 'POST' },
      'admin',
    )

    expect(response.status).toBe(200)
    expect((await json(response)).data).toMatchObject({
      message: 'order payment accepted',
      order: { status: 'PAID' },
    })
    expect(stripeFetch).toHaveBeenCalledTimes(2)
    expect(test.queue.events).toEqual([
      expect.objectContaining({
        event_type: 'payment.fulfillment.requested.v1',
        aggregate_id: 'order-provider-paid',
      }),
    ])
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_events
        WHERE order_id = 'order-provider-paid' AND event_type = 'order.cancelled'`,
    ).get()).toEqual({ count: 0 })
    expect(test.raw.prepare(
      `SELECT status FROM payment_fulfillments WHERE order_id = 'order-provider-paid'`,
    ).get()).toEqual({ status: 'pending' })
  })

  it('fails closed when a remote Checkout cannot be expired or verified', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-provider-unavailable',
      status: 'PENDING',
      providerOrderId: 'cs_admin_unavailable',
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new Error('provider offline')
    }))

    const response = await request(
      test,
      '/orders/order-provider-unavailable/cancel',
      { method: 'POST' },
      'admin',
    )

    expect(response.status).toBe(503)
    expect((await json(response)).code).toBe('stripe_unavailable')
    expect(test.raw.prepare(
      `SELECT status FROM payment_orders WHERE id = 'order-provider-unavailable'`,
    ).get()).toEqual({ status: 'PENDING' })
  })

  it('retries a paid failed fulfillment idempotently through the durable workflow', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-retry',
      status: 'FAILED',
      paidAt: NOW - 1_000,
      version: 3,
    })

    const first = await request(test, '/orders/order-retry/retry', { method: 'POST' }, 'admin')
    expect(first.status).toBe(200)
    const firstData = (await json(first)).data
    expect(firstData).toMatchObject({
      message: 'fulfillment retried',
      idempotent: false,
      order: { id: 'order-retry', status: 'COMPLETED' },
    })
    const subscriptionId = firstData.order.subscription_id as string
    const expiry = test.raw.prepare(
      'SELECT expires_at_ms FROM user_subscriptions WHERE id = ?',
    ).get(subscriptionId).expires_at_ms

    const replay = await request(test, '/orders/order-retry/retry', { method: 'POST' }, 'admin')
    expect(replay.status).toBe(200)
    expect((await json(replay)).data).toMatchObject({
      message: 'fulfillment already completed',
      idempotent: true,
      order: { status: 'COMPLETED', subscription_id: subscriptionId },
    })
    expect(test.raw.prepare(
      'SELECT expires_at_ms FROM user_subscriptions WHERE id = ?',
    ).get(subscriptionId)).toEqual({ expires_at_ms: expiry })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM subscription_events
        WHERE source_type = 'payment' AND source_id = 'order-retry'`,
    ).get()).toEqual({ count: 1 })
    expect(test.state.calls).toHaveLength(1)
  })
})

function adminApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.use('*', requireAdminSession)
  app.get('/dashboard', getAdminPaymentDashboard)
  app.get('/orders', listAdminPaymentOrders)
  app.get('/orders/:id', getAdminPaymentOrder)
  app.post('/orders/:id/cancel', cancelAdminPaymentOrder)
  app.post('/orders/:id/retry', retryAdminPaymentFulfillment)
  return app
}

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  for (const [id, email, displayName, role] of [
    [ADMIN_ID, 'admin@example.test', 'Admin', 'admin'],
    [BUYER_ID, 'buyer@example.test', 'Buyer', 'user'],
    [OTHER_ID, 'other@example.test', 'Other', 'user'],
  ] as const) {
    raw.prepare(`
      INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, email, displayName, role, NOW - DAY_MS, NOW - DAY_MS)
  }
  raw.prepare(`
    INSERT INTO "groups" (id, name, platform, enabled, group_type, created_at_ms, updated_at_ms)
    VALUES (?, 'Pro', 'openai', 1, 'subscription', ?, ?)
  `).run(GROUP_ID, NOW - DAY_MS, NOW - DAY_MS)
  raw.prepare(`
    INSERT INTO subscription_plans (
      id, group_id, name, validity_days, price_micros, currency,
      daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'Pro 30', 30, 12500000, 'USD', 5000000, 20000000, 60000000, ?, ?)
  `).run(PLAN_ID, GROUP_ID, NOW - DAY_MS, NOW - DAY_MS)
  const providerKeyId = 'key-v1'
  const encrypted = await encryptCredential({
    api_key: 'sk_test_admin',
    webhook_secret: 'whsec_test_admin',
    publishable_key: 'pk_test_admin',
  } as any, MASTER_KEY, paymentProviderCredentialAad(
    'test',
    PROVIDER_ID,
    providerKeyId,
    0,
  ))
  raw.prepare(`
    INSERT INTO payment_provider_instances (
      id, provider_key, provider_type, display_name,
      config_ciphertext, config_nonce, config_key_id,
      enabled, version, created_at_ms, updated_at_ms
    ) VALUES (?, 'stripe-primary', 'stripe', 'Stripe production', ?, ?, ?, 1, 0, ?, ?)
  `).run(
    PROVIDER_ID,
    encrypted.ciphertext_b64,
    encrypted.nonce_b64,
    providerKeyId,
    NOW - DAY_MS,
    NOW - DAY_MS,
  )

  const authorization = {} as Fixture['authorization']
  for (const [name, userId] of [['admin', ADMIN_ID], ['buyer', BUYER_ID]] as const) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(`
      INSERT INTO user_sessions (
        id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
        created_at_ms, access_expires_at_ms, refresh_expires_at_ms
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      `session-${name}`,
      `family-${name}`,
      userId,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      NOW - 1_000,
      NOW + DAY_MS,
      NOW + 30 * DAY_MS,
    )
    authorization[name] = `Bearer ${access}`
  }
  const state = new SubscriptionStateFake()
  const queue = new CapturedQueue()
  return {
    raw,
    authorization,
    state,
    queue,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      CREDENTIALS_MASTER_KEY: MASTER_KEY,
      ASSETS: {} as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: queue.queue(),
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: state.namespace(),
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function insertOrder(
  raw: any,
  input: {
    id: string
    status: string
    userId?: string
    currency?: string
    payAmountMicros?: number
    paidAt?: number | null
    createdAt?: number
    version?: number
    providerOrderId?: string | null
  },
): void {
  const userId = input.userId ?? BUYER_ID
  const currency = input.currency ?? 'USD'
  const amount = input.payAmountMicros ?? 12_500_000
  const paid = input.paidAt !== undefined
    ? input.paidAt
    : input.status === 'PENDING' ? null : NOW - 1_000
  const createdAt = input.createdAt ?? NOW - 1_000
  const providerOrderId = input.providerOrderId === undefined
    ? `cs-${input.id}`
    : input.providerOrderId
  const paymentIntentId = providerOrderId === null ? null : `pi-${input.id}`
  raw.prepare(`
    INSERT INTO payment_orders (
      id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
      idempotency_key_hash, request_hash, provider_order_id, payment_intent_id,
      payment_trade_no, order_type, status, amount_micros, pay_amount_micros,
      fee_ppm_snapshot, paid_amount_micros, refunded_amount_micros, currency,
      plan_id, plan_name_snapshot, plan_group_id_snapshot,
      plan_validity_days_snapshot, plan_price_micros_snapshot, plan_currency_snapshot,
      plan_daily_quota_micros_snapshot, plan_weekly_quota_micros_snapshot,
      plan_monthly_quota_micros_snapshot, version, expires_at_ms, paid_at_ms,
      completed_at_ms, failed_at_ms, failed_reason, created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, 'stripe-primary', ?, ?, ?, ?, ?, ?, 'subscription', ?, ?, ?,
      0, ?, 0, ?, ?, 'Pro 30', ?, 30, 12500000, ?, 5000000, 20000000, 60000000,
      ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    input.id,
    userId,
    PROVIDER_ID,
    `trade-${input.id}`,
    input.id.padEnd(64, 'x').slice(0, 64),
    'f'.repeat(64),
    providerOrderId,
    paymentIntentId,
    paymentIntentId,
    input.status,
    amount,
    amount,
    paid === null ? 0 : amount,
    currency,
    PLAN_ID,
    GROUP_ID,
    currency,
    input.version ?? 0,
    createdAt + 2 * DAY_MS,
    paid,
    input.status === 'COMPLETED' ? paid : null,
    input.status === 'FAILED' ? NOW - 500 : null,
    input.status === 'FAILED' ? 'fulfillment interrupted' : null,
    createdAt,
    createdAt,
  )
}

function insertPaymentEvent(raw: any, orderId: string): void {
  raw.prepare(`
    INSERT INTO payment_events (
      id, order_id, event_type, source_type, source_id,
      payload_json, occurred_at_ms, created_at_ms
    ) VALUES (?, ?, 'order.created', 'api', ?, '{}', ?, ?)
  `).run(`event-${orderId}`, orderId, `request-${orderId}`, NOW - 1_000, NOW - 1_000)
}

async function request(
  test: Fixture,
  path: string,
  init: RequestInit = {},
  actor?: keyof Fixture['authorization'],
): Promise<Response> {
  return adminApp().request(path, {
    ...init,
    headers: {
      ...(actor === undefined ? {} : { authorization: test.authorization[actor] }),
      ...init.headers,
    },
  }, test.env)
}

async function json(response: Response): Promise<any> {
  return response.json()
}

function stripeJson(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}
