import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env, PlatformEvent } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { consumeEvents } from '../../src/gateway/queue'
import { recoverExpiredPaymentOrders } from '../../src/payment/orders'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'payment-order-test-pepper-value-at-least-32-bytes'
const MASTER_KEY = 'payment-order-master-key-value-at-least-32-bytes'
const WEBHOOK_SECRET = 'whsec_payment_order_test'
const NOW = 1_778_241_600_000
const DAY_MS = 86_400_000

interface Fixture {
  raw: any
  env: Env
  authorization: Record<'alice' | 'bob' | 'admin', string>
  queue: CapturedQueue
  objects: CapturedBucket
  subscriptionState: SubscriptionStateFake
  stripeFetch: ReturnType<typeof vi.fn<typeof fetch>>
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

class CapturedBucket {
  readonly objects = new Map<string, string>()

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<unknown> {
    if (typeof value === 'string') this.objects.set(key, value)
    else if (value instanceof ArrayBuffer) this.objects.set(key, new TextDecoder().decode(value))
    else if (ArrayBuffer.isView(value)) this.objects.set(key, new TextDecoder().decode(value))
    else this.objects.set(key, '[stream]')
    return {}
  }

  bucket(): R2Bucket {
    return this as unknown as R2Bucket
  }
}

class SubscriptionStateFake {
  readonly calls: Array<{ id: string; path: string; body: Record<string, unknown> }> = []

  namespace(): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (request: Request) => {
          const body = await request.json() as Record<string, unknown>
          this.calls.push({ id, path: new URL(request.url).pathname, body })
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
  vi.restoreAllMocks()
})

describe('Stripe subscription order HTTP contract', () => {
  it('creates one server-priced hosted checkout and replays the durable idempotent response', async () => {
    const test = await fixture()
    const checkout = await userRequest(test, 'alice', '/api/v1/payment/checkout-info')
    expect(checkout.status).toBe(200)
    expect(await json(checkout)).toMatchObject({
      code: 0,
      data: {
        balance_disabled: true,
        methods: {
          stripe: { currency: 'USD', available: true },
        },
        plans: [expect.objectContaining({ id: 'plan-pro', price: 12.5 })],
      },
    })

    const request = {
      amount: 0.01,
      payment_type: 'stripe',
      order_type: 'subscription',
      plan_id: 'plan-pro',
      return_url: 'https://ignored.example/redirect',
      payment_source: 'hosted_redirect',
      is_mobile: false,
    }
    const first = await userRequest(test, 'alice', '/api/v1/payment/orders', {
      method: 'POST',
      headers: mutationHeaders('payment-create-alice-pro'),
      body: JSON.stringify(request),
    })
    expect(first.status).toBe(201)
    const firstBody = await json(first)
    expect(firstBody).toMatchObject({
      code: 0,
      data: {
        order_id: expect.any(String),
        amount: 12.5,
        pay_amount: 12.5,
        currency: 'USD',
        payment_type: 'stripe',
        order_type: 'subscription',
        plan_id: 'plan-pro',
        pay_url: 'https://checkout.stripe.com/c/pay/cs_order_test',
        payment_mode: 'redirect',
        resume_token: expect.any(String),
      },
    })
    expect(firstBody.data.resume_token).not.toContain(firstBody.data.order_id)

    test.raw.prepare(
      `UPDATE subscription_plans SET price_micros = 99000000, updated_at_ms = ? WHERE id = 'plan-pro'`,
    ).run(NOW + 1)
    const replay = await userRequest(test, 'alice', '/api/v1/payment/orders', {
      method: 'POST',
      headers: mutationHeaders('payment-create-alice-pro'),
      body: JSON.stringify(request),
    })
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(firstBody)
    expect(test.stripeFetch).toHaveBeenCalledTimes(1)
    expect(test.raw.prepare(
      `SELECT amount_micros, plan_price_micros_snapshot, status
         FROM payment_orders WHERE id = ?`,
    ).get(firstBody.data.order_id)).toEqual({
      amount_micros: 12_500_000,
      plan_price_micros_snapshot: 12_500_000,
      status: 'PENDING',
    })

    const stripeRequest = test.stripeFetch.mock.calls[0]
    const stripeForm = new URLSearchParams(String(stripeRequest?.[1]?.body))
    expect(stripeForm.get('line_items[0][price_data][unit_amount]')).toBe('1250')
    expect(stripeForm.get('success_url')).toContain('/payment/result?')
    expect(stripeForm.get('success_url')).not.toContain('ignored.example')
    expect(stripeForm.get('expires_at')).toBe(String(NOW / 1_000 + 30 * 60))

    const conflict = await userRequest(test, 'alice', '/api/v1/payment/orders', {
      method: 'POST',
      headers: mutationHeaders('payment-create-alice-pro'),
      body: JSON.stringify({ ...request, plan_id: 'a-different-plan' }),
    })
    expect(conflict.status).toBe(409)
    expect((await json(conflict)).code).toBe('idempotency_conflict')
  })

  it('rejects forged callbacks and fulfills a paid order exactly once through the queue seam', async () => {
    const test = await fixture()
    const created = await createOrder(test, 'payment-create-webhook')
    const orderId = created.data.order_id as string

    const event = stripeCheckoutEvent(orderId)
    const rawBody = JSON.stringify(event)
    const forged = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${NOW / 1_000},v1=${'0'.repeat(64)}`,
      },
      body: rawBody,
    }, test.env)
    expect(forged.status).toBe(400)
    expect(test.raw.prepare('SELECT status FROM payment_orders WHERE id = ?').get(orderId))
      .toEqual({ status: 'PENDING' })
    expect(test.queue.events).toHaveLength(0)

    const valid = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': await stripeSignature(rawBody),
      },
      body: rawBody,
    }, test.env)
    expect(valid.status).toBe(200)
    expect(test.raw.prepare('SELECT status, paid_amount_micros FROM payment_orders WHERE id = ?').get(orderId))
      .toEqual({ status: 'PAID', paid_amount_micros: 12_500_000 })
    expect(test.queue.events).toHaveLength(1)
    expect(test.objects.objects.get(`payment-webhooks/stripe/evt_checkout_${orderId}.json`)).toBe(rawBody)

    await consumeCapturedEvent(test, 0)
    expect(test.raw.prepare(
      `SELECT status, subscription_id, completed_at_ms FROM payment_orders WHERE id = ?`,
    ).get(orderId)).toMatchObject({
      status: 'COMPLETED',
      subscription_id: expect.any(String),
      completed_at_ms: expect.any(Number),
    })
    expect(test.raw.prepare(
      `SELECT source_type, source_id, plan_id, expires_at_ms
         FROM user_subscriptions WHERE user_id = 'alice' AND group_id = 'group-pro'`,
    ).get()).toMatchObject({
      source_type: 'payment',
      source_id: orderId,
      plan_id: 'plan-pro',
      expires_at_ms: NOW + 30 * DAY_MS,
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM subscription_events
        WHERE source_type = 'payment' AND source_id = ?`,
    ).get(orderId)).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT status, attempts FROM payment_fulfillments WHERE order_id = ?`,
    ).get(orderId)).toEqual({ status: 'applied', attempts: 1 })
    expect(test.subscriptionState.calls).toHaveLength(1)

    test.raw.prepare(
      `UPDATE payment_provider_instances SET enabled = 0 WHERE id = 'stripe-primary-id'`,
    ).run()
    const replay = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': await stripeSignature(rawBody),
      },
      body: rawBody,
    }, test.env)
    expect(replay.status).toBe(200)
    expect(test.queue.events).toHaveLength(1)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM subscription_events
        WHERE source_type = 'payment' AND source_id = ?`,
    ).get(orderId)).toEqual({ count: 1 })

    const resolved = await createApp().request('/api/v1/payment/public/orders/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume_token: created.data.resume_token }),
    }, test.env)
    expect(resolved.status).toBe(200)
    const resolvedBody = await json(resolved)
    expect(resolvedBody.data).toMatchObject({ id: orderId, status: 'COMPLETED', paid: true })
    expect(resolvedBody.data).not.toHaveProperty('user_id')
  })

  it('keeps a signed late payment recoverable without granting the subscription', async () => {
    const test = await fixture()
    const created = await createOrder(test, 'payment-create-late-webhook')
    const orderId = created.data.order_id as string
    vi.setSystemTime(NOW + 30 * 60_000 + 1)

    const rawBody = JSON.stringify(stripeCheckoutEvent(orderId))
    const response = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': await stripeSignature(rawBody),
      },
      body: rawBody,
    }, test.env)

    expect(response.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT status, paid_amount_micros, payment_intent_id, last_error
         FROM payment_orders WHERE id = ?`,
    ).get(orderId)).toMatchObject({
      status: 'REFUND_REQUESTED',
      paid_amount_micros: 12_500_000,
      payment_intent_id: 'pi_order_test',
      last_error: 'late_payment_requires_refund',
    })
    expect(test.raw.prepare(
      `SELECT status, amount_micros, reason FROM payment_refunds WHERE order_id = ?`,
    ).get(orderId)).toMatchObject({
      status: 'requested',
      amount_micros: 12_500_000,
      reason: expect.stringContaining('expiry'),
    })
    expect(test.raw.prepare(
      `SELECT status FROM payment_webhook_inbox WHERE provider_event_id = ?`,
    ).get(`evt_checkout_${orderId}`)).toEqual({ status: 'processed' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_events
        WHERE order_id = ? AND event_type = 'order.late_payment_reconciliation_required'`,
    ).get(orderId)).toEqual({ count: 1 })
    expect(test.objects.objects.get(`payment-webhooks/stripe/evt_checkout_${orderId}.json`)).toBe(rawBody)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_fulfillments WHERE order_id = ?`,
    ).get(orderId)).toEqual({ count: 0 })
    expect(test.queue.events).toHaveLength(0)
  })

  it('does not mark the webhook processed when no paid or reconciliation transition commits', async () => {
    const test = await fixture()
    const created = await createOrder(test, 'payment-create-webhook-transition-race')
    const orderId = created.data.order_id as string
    test.raw.prepare(
      `UPDATE payment_orders SET status = 'FAILED', failed_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
    ).run(NOW, NOW, orderId)

    const rawBody = JSON.stringify(stripeCheckoutEvent(orderId))
    const response = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': await stripeSignature(rawBody),
      },
      body: rawBody,
    }, test.env)

    expect(response.status).toBe(409)
    expect((await json(response)).code).toBe('payment_order_changed')
    expect(test.raw.prepare(
      `SELECT status FROM payment_webhook_inbox WHERE provider_event_id = ?`,
    ).get(`evt_checkout_${orderId}`)).toEqual({ status: 'received' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_fulfillments WHERE order_id = ?`,
    ).get(orderId)).toEqual({ count: 0 })
  })

  it('expires overdue checkouts in a bounded scheduled recovery', async () => {
    const test = await fixture()
    await createOrder(test, 'payment-create-expiry-recovery')
    await createOrder(test, 'payment-create-expiry-recovery-second')
    vi.setSystemTime(NOW + 30 * 60_000 + 1)

    await expect(recoverExpiredPaymentOrders(test.env, 1)).resolves.toBe(1)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_orders WHERE status = 'EXPIRED'`,
    ).get()).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_orders WHERE status = 'PENDING'`,
    ).get()).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_events
        WHERE event_type = 'order.expired' AND source_type = 'cron'`,
    ).get()).toEqual({ count: 1 })
    expect(test.stripeFetch.mock.calls.filter(([url]) => String(url).endsWith('/expire'))).toHaveLength(1)
  })

  it('aligns short configured timeouts to 30 minutes and leaves remote expiry to recovery', async () => {
    const test = await fixture()
    test.raw.prepare(
      `UPDATE payment_config SET order_timeout_minutes = 1 WHERE id = 'global'`,
    ).run()
    const first = await createOrder(test, 'payment-create-short-expiry')
    const firstId = first.data.order_id as string
    expect(test.raw.prepare(
      `SELECT expires_at_ms FROM payment_orders WHERE id = ?`,
    ).get(firstId)).toEqual({ expires_at_ms: NOW + 30 * 60_000 })
    const firstForm = new URLSearchParams(String(test.stripeFetch.mock.calls[0]?.[1]?.body))
    expect(firstForm.get('expires_at')).toBe(String(NOW / 1_000 + 30 * 60))

    vi.setSystemTime(NOW + 30 * 60_000 + 1)
    await createOrder(test, 'payment-create-after-overdue-order')
    expect(test.raw.prepare(
      `SELECT status FROM payment_orders WHERE id = ?`,
    ).get(firstId)).toEqual({ status: 'PENDING' })
    expect(test.stripeFetch.mock.calls.filter(([url]) => String(url).endsWith('/expire'))).toHaveLength(0)
  })

  it.each([
    ['max pending orders', 'max_pending_orders', 1, 'too_many_pending_orders'],
    ['daily payment limit', 'daily_limit_micros', 12_500_000, 'daily_payment_limit_exceeded'],
  ])('atomically enforces %s for concurrent distinct idempotency keys', async (
    _name,
    column,
    value,
    rejectionCode,
  ) => {
    const test = await fixture()
    test.raw.prepare(
      `UPDATE payment_config SET ${column} = ?, max_pending_orders = ?
        WHERE id = 'global'`,
    ).run(value, column === 'daily_limit_micros' ? 10 : 1)

    const request = (key: string) => userRequest(test, 'alice', '/api/v1/payment/orders', {
      method: 'POST',
      headers: mutationHeaders(key),
      body: JSON.stringify({
        amount: 1,
        payment_type: 'stripe',
        order_type: 'subscription',
        plan_id: 'plan-pro',
      }),
    })
    const responses = await Promise.all([
      request(`payment-create-concurrent-${column}-a`),
      request(`payment-create-concurrent-${column}-b`),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    const rejected = responses.find((response) => response.status === 409)!
    expect((await json(rejected)).code).toBe(rejectionCode)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_orders WHERE user_id = 'alice' AND status = 'PENDING'`,
    ).get()).toEqual({ count: 1 })
    expect(test.stripeFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects non-USD plans before creating provider or financial state', async () => {
    const test = await fixture()
    test.raw.prepare(
      `INSERT INTO subscription_plans (
         id, group_id, name, description, validity_days, price_micros, currency,
         enabled, sort_order, created_at_ms, updated_at_ms
       ) VALUES ('plan-eur', 'group-pro', 'Euro plan', '', 30, 12500000, 'EUR', 1, 1, ?, ?)`,
    ).run(NOW, NOW)

    const response = await userRequest(test, 'alice', '/api/v1/payment/orders', {
      method: 'POST',
      headers: mutationHeaders('payment-create-eur'),
      body: JSON.stringify({
        amount: 12.5,
        payment_type: 'stripe',
        order_type: 'subscription',
        plan_id: 'plan-eur',
      }),
    })
    expect(response.status).toBe(409)
    expect((await json(response)).code).toBe('subscription_plan_currency_unsupported')
    expect(test.raw.prepare(`SELECT COUNT(*) AS count FROM payment_orders`).get()).toEqual({ count: 0 })
    expect(test.stripeFetch).not.toHaveBeenCalled()
  })

  it('acknowledges an unknown signed-provider event without creating financial state', async () => {
    const test = await fixture()
    const event = stripeCheckoutEvent('missing-order')
    const rawBody = JSON.stringify(event)
    const response = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': await stripeSignature(rawBody) },
      body: rawBody,
    }, test.env)
    expect(response.status).toBe(200)
    expect(test.queue.events).toHaveLength(0)
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM payment_webhook_inbox').get())
      .toEqual({ count: 0 })
  })

  it('rejects a forged unknown-order event before acknowledging it', async () => {
    const test = await fixture()
    const rawBody = JSON.stringify(stripeCheckoutEvent('missing-order'))
    const response = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${NOW / 1_000},v1=${'0'.repeat(64)}`,
      },
      body: rawBody,
    }, test.env)
    expect(response.status).toBe(400)
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM payment_webhook_inbox').get())
      .toEqual({ count: 0 })
  })

  it.each([
    ['amount_total', 1251, 'payment_amount_mismatch'],
    ['id', 'cs_another_order', 'payment_provider_order_mismatch'],
  ])('rejects a paid callback with mismatched %s', async (field, value, code) => {
    const test = await fixture()
    const created = await createOrder(test, `payment-create-mismatch-${field}`)
    const orderId = created.data.order_id as string
    const event = stripeCheckoutEvent(orderId) as any
    event.data.object[field] = value
    const rawBody = JSON.stringify(event)
    const response = await createApp().request('/api/v1/payment/webhook/stripe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': await stripeSignature(rawBody),
      },
      body: rawBody,
    }, test.env)
    expect(response.status).toBe(400)
    expect((await json(response)).code).toBe(code)
    expect(test.raw.prepare('SELECT status FROM payment_orders WHERE id = ?').get(orderId))
      .toEqual({ status: 'PENDING' })
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM payment_webhook_inbox').get())
      .toEqual({ count: 0 })
  })

  it('isolates order reads by owner and cancels only pending checkout sessions', async () => {
    const test = await fixture()
    const created = await createOrder(test, 'payment-create-cancel')
    const orderId = created.data.order_id as string

    const forbidden = await userRequest(test, 'bob', `/api/v1/payment/orders/${orderId}`)
    expect(forbidden.status).toBe(404)

    const list = await userRequest(test, 'alice', '/api/v1/payment/orders/my?page=1&page_size=20')
    expect(await json(list)).toMatchObject({
      code: 0,
      data: { items: [expect.objectContaining({ id: orderId })], total: 1, page: 1, page_size: 20, pages: 1 },
    })

    const cancelled = await userRequest(test, 'alice', `/api/v1/payment/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: mutationHeaders('payment-cancel-order'),
    })
    expect(cancelled.status).toBe(200)
    expect((await json(cancelled)).data.status).toBe('CANCELLED')
    expect(test.stripeFetch).toHaveBeenCalledTimes(2)

    const again = await userRequest(test, 'alice', `/api/v1/payment/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: mutationHeaders('payment-cancel-order'),
    })
    expect(again.status).toBe(200)
    expect(test.stripeFetch).toHaveBeenCalledTimes(2)
  })
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.prepare(
    `UPDATE payment_config
        SET enabled = 1, balance_disabled = 1, min_amount_micros = 10000,
            order_timeout_minutes = 30
      WHERE id = 'global'`,
  ).run()
  for (const [id, email, role] of [
    ['alice', 'alice@example.test', 'user'],
    ['bob', 'bob@example.test', 'user'],
    ['admin', 'admin@example.test', 'admin'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email, id, role, NOW, NOW)
  }
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, group_type, created_at_ms, updated_at_ms
     ) VALUES ('group-pro', 'Pro', 'openai', 1, 'subscription', ?, ?)`,
  ).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO subscription_plans (
       id, group_id, name, description, validity_days, price_micros, currency,
       daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
       enabled, sort_order, created_at_ms, updated_at_ms
     ) VALUES ('plan-pro', 'group-pro', 'Pro 30 days', 'Production plan', 30,
               12500000, 'USD', 5000000, 20000000, 60000000, 1, 0, ?, ?)`,
  ).run(NOW, NOW)

  const keyId = 'payment-key-v1'
  const providerId = 'stripe-primary-id'
  const encrypted = await encryptCredential({
    api_key: 'sk_test_payment',
    webhook_secret: WEBHOOK_SECRET,
    publishable_key: 'pk_test_payment',
  } as any, MASTER_KEY, paymentProviderAad('test', providerId, keyId, 0))
  raw.prepare(
    `INSERT INTO payment_provider_instances (
       id, provider_key, provider_type, display_name,
       config_ciphertext, config_nonce, config_key_id,
       enabled, version, created_at_ms, updated_at_ms
     ) VALUES (?, 'stripe-primary', 'stripe', 'Stripe', ?, ?, ?, 1, 0, ?, ?)`,
  ).run(providerId, encrypted.ciphertext_b64, encrypted.nonce_b64, keyId, NOW, NOW)

  const authorization = {} as Fixture['authorization']
  for (const userId of ['alice', 'bob', 'admin'] as const) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `session-${userId}`,
      `family-${userId}`,
      userId,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      NOW,
      NOW + DAY_MS,
      NOW + 30 * DAY_MS,
    )
    authorization[userId] = `Bearer ${access}`
  }

  const queue = new CapturedQueue()
  const objects = new CapturedBucket()
  const subscriptionState = new SubscriptionStateFake()
  let checkoutSessions = 0
  const stripeFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/expire')) {
      const sessionId = url.split('/').at(-2) ?? 'cs_order_test'
      return stripeJson({
        id: sessionId, object: 'checkout.session', status: 'expired',
        payment_status: 'unpaid', amount_total: 1250, currency: 'usd', url: null,
        payment_intent: null,
      })
    }
    expect(init?.method).toBe('POST')
    const sessionId = checkoutSessions === 0 ? 'cs_order_test' : `cs_order_test_${checkoutSessions}`
    checkoutSessions += 1
    return stripeJson({
      id: sessionId, object: 'checkout.session', status: 'open',
      payment_status: 'unpaid', amount_total: 1250, currency: 'usd',
      url: `https://checkout.stripe.com/c/pay/${sessionId}`, payment_intent: null,
    })
  })
  vi.stubGlobal('fetch', stripeFetch)

  return {
    raw,
    authorization,
    queue,
    objects,
    subscriptionState,
    stripeFetch,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      CREDENTIALS_MASTER_KEY: MASTER_KEY,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: objects.bucket(),
      EVENTS_QUEUE: queue.queue(),
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: subscriptionState.namespace(),
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

async function createOrder(test: Fixture, key: string): Promise<any> {
  const response = await userRequest(test, 'alice', '/api/v1/payment/orders', {
    method: 'POST',
    headers: mutationHeaders(key),
    body: JSON.stringify({
      amount: 1,
      payment_type: 'stripe',
      order_type: 'subscription',
      plan_id: 'plan-pro',
      return_url: 'https://ignored.example/payment/result',
      payment_source: 'hosted_redirect',
      is_mobile: false,
    }),
  })
  expect(response.status).toBe(201)
  return json(response)
}

async function userRequest(
  test: Fixture,
  user: keyof Fixture['authorization'],
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return createApp().request(path, {
    ...init,
    headers: { authorization: test.authorization[user], ...init.headers },
  }, test.env)
}

function mutationHeaders(key: string): Record<string, string> {
  return { 'content-type': 'application/json', 'idempotency-key': key }
}

function stripeJson(value: unknown): Response {
  return Response.json(value, { status: 200 })
}

function stripeCheckoutEvent(orderId: string): Record<string, unknown> {
  return {
    id: `evt_checkout_${orderId}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        id: 'cs_order_test',
        object: 'checkout.session',
        client_reference_id: orderId,
        metadata: { order_id: orderId },
        payment_status: 'paid',
        status: 'complete',
        amount_total: 1250,
        currency: 'usd',
        payment_intent: 'pi_order_test',
      },
    },
  }
}

async function stripeSignature(rawBody: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1_000)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  )
  const hex = Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, '0')).join('')
  return `t=${timestamp},v1=${hex}`
}

async function consumeCapturedEvent(test: Fixture, index: number): Promise<void> {
  const event = test.queue.events[index]
  if (!event) throw new Error(`missing queued event ${index}`)
  let retry = false
  let ack = false
  const message = {
    id: `message-${index}`,
    timestamp: new Date(NOW),
    body: event,
    attempts: 1,
    ack: () => { ack = true },
    retry: () => { retry = true },
  }
  await consumeEvents({ queue: 'test', messages: [message] } as unknown as MessageBatch<unknown>, test.env)
  expect({ ack, retry }).toEqual({ ack: true, retry: false })
}

async function json(response: Response): Promise<any> {
  return response.json()
}

function paymentProviderAad(environment: string, id: string, keyId: string, version: number): string {
  return `sub2api/payment-provider/v1/${environment}/${id}/${keyId}/${version}`
}
