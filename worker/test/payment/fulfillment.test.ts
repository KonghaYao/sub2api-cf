import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import {
  createPaymentFulfillmentEvent,
  fulfillPaymentOrder,
  isPaymentFulfillmentEvent,
  recoverPendingPaymentFulfillments,
} from '../../src/payment/fulfillment'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const DAY_MS = 86_400_000
const NOW = Date.UTC(2026, 8, 4, 8, 30)
const USER_ID = '00000000-0000-4000-8000-000000000001'
const GROUP_ID = '00000000-0000-4000-8000-000000000010'
const PLAN_ID = '00000000-0000-4000-8000-000000000020'
const PROVIDER_ID = '00000000-0000-4000-8000-000000000030'

class SubscriptionStateFake {
  calls: Array<{ subscriptionId: string; path: string; body: Record<string, unknown> }> = []
  failuresRemaining = 0

  namespace(): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: (subscriptionId: string) => ({
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname
          const body = await request.json() as Record<string, unknown>
          this.calls.push({ subscriptionId, path, body })
          if (this.failuresRemaining > 0) {
            this.failuresRemaining -= 1
            throw new Error('simulated subscription state outage')
          }
          return Response.json({ schema_version: 1, idempotent: false })
        },
      }),
    } as unknown as DurableObjectNamespace
  }
}

interface Fixture {
  raw: any
  env: Env
  state: SubscriptionStateFake
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('payment subscription fulfillment', () => {
  it('creates and recognizes the stable queue event contract', () => {
    const event = createPaymentFulfillmentEvent('order-1', NOW)
    expect(event).toEqual({
      schema_version: 1,
      event_id: 'payment-fulfillment:order-1',
      event_type: 'payment.fulfillment.requested.v1',
      occurred_at_ms: NOW,
      aggregate_type: 'payment_order',
      aggregate_id: 'order-1',
      payload: { order_id: 'order-1' },
    })
    expect(isPaymentFulfillmentEvent(event)).toBe(true)
    expect(isPaymentFulfillmentEvent({ ...event, event_type: 'payment.fulfillment.v0' })).toBe(false)
    expect(isPaymentFulfillmentEvent({ ...event, payload: { order_id: 'another-order' } })).toBe(false)
  })

  it('creates one initial term and sends its exact configuration to SubscriptionStateDO', async () => {
    const test = fixture()
    insertOrder(test.raw, 'order-initial')

    const result = await fulfillPaymentOrder(test.env, 'order-initial')

    expect(result.status).toBe('applied')
    const row = subscription(test.raw, result.subscription_id)
    expect(row).toMatchObject({
      status: 'active',
      starts_at_ms: NOW,
      expires_at_ms: NOW + 30 * DAY_MS,
      daily_used_micros: 0,
      weekly_used_micros: 0,
      monthly_used_micros: 0,
      control_version: 0,
    })
    expect(test.raw.prepare(
      `SELECT term_kind, previous_status, previous_starts_at_ms,
              previous_expires_at_ms, starts_at_ms, expires_at_ms, granted_duration_ms
         FROM payment_subscription_terms WHERE order_id = 'order-initial'`,
    ).get()).toEqual({
      term_kind: 'initial',
      previous_status: null,
      previous_starts_at_ms: null,
      previous_expires_at_ms: null,
      starts_at_ms: NOW,
      expires_at_ms: NOW + 30 * DAY_MS,
      granted_duration_ms: 30 * DAY_MS,
    })
    expect(test.state.calls).toHaveLength(1)
    expect(test.state.calls[0]).toMatchObject({
      subscriptionId: result.subscription_id,
      path: '/configure',
      body: {
        subscription_id: result.subscription_id,
        starts_at_ms: NOW,
        expires_at_ms: NOW + 30 * DAY_MS,
        control_version: 0,
        enabled: true,
      },
    })
  })

  it('extends an active subscription once from immutable order snapshots', async () => {
    const test = fixture()
    const oldExpiry = NOW + 5 * DAY_MS
    seedSubscription(test.raw, {
      id: 'subscription-active',
      status: 'active',
      startsAt: NOW - 10 * DAY_MS,
      expiresAt: oldExpiry,
      usedMicros: 777,
      controlVersion: 4,
    })
    insertOrder(test.raw, 'order-active')

    const first = await fulfillPaymentOrder(test.env, 'order-active')
    expect(first).toMatchObject({
      order_id: 'order-active',
      subscription_id: 'subscription-active',
      status: 'applied',
      idempotent: false,
    })
    expect(subscription(test.raw, 'subscription-active')).toMatchObject({
      plan_id: PLAN_ID,
      status: 'active',
      starts_at_ms: NOW - 10 * DAY_MS,
      expires_at_ms: oldExpiry + 30 * DAY_MS,
      daily_quota_micros: 5_000_000,
      weekly_quota_micros: 20_000_000,
      monthly_quota_micros: 60_000_000,
      daily_used_micros: 777,
      weekly_used_micros: 777,
      monthly_used_micros: 777,
      source_type: 'payment',
      source_id: 'order-active',
      control_version: 5,
    })
    expect(test.raw.prepare(
      `SELECT event_type, source_type, source_id
         FROM subscription_events WHERE source_type = 'payment'`,
    ).all()).toEqual([{
      event_type: 'extended',
      source_type: 'payment',
      source_id: 'order-active',
    }])
    expect(test.raw.prepare(
      `SELECT subscription_id, term_kind, previous_status,
              previous_starts_at_ms, previous_expires_at_ms,
              starts_at_ms, expires_at_ms, granted_duration_ms, refunded_duration_ms
         FROM payment_subscription_terms WHERE order_id = ?`,
    ).get('order-active')).toEqual({
      subscription_id: 'subscription-active',
      term_kind: 'extended',
      previous_status: 'active',
      previous_starts_at_ms: NOW - 10 * DAY_MS,
      previous_expires_at_ms: oldExpiry,
      starts_at_ms: NOW - 10 * DAY_MS,
      expires_at_ms: oldExpiry + 30 * DAY_MS,
      granted_duration_ms: 30 * DAY_MS,
      refunded_duration_ms: 0,
    })
    expect(test.raw.prepare(
      `SELECT status, result_resource_id FROM payment_fulfillments WHERE order_id = ?`,
    ).get('order-active')).toEqual({ status: 'applied', result_resource_id: 'subscription-active' })
    expect(test.raw.prepare(
      `SELECT status, subscription_id, completed_at_ms,
              subscription_fulfilled_at_ms, last_error
         FROM payment_orders WHERE id = ?`,
    ).get('order-active')).toEqual({
      status: 'COMPLETED',
      subscription_id: 'subscription-active',
      completed_at_ms: NOW,
      subscription_fulfilled_at_ms: NOW,
      last_error: null,
    })
    expect(test.state.calls).toHaveLength(1)
    expect(test.state.calls[0]).toMatchObject({
      subscriptionId: 'subscription-active',
      path: '/configure',
    })

    const repeated = await fulfillPaymentOrder(test.env, 'order-active')
    expect(repeated).toMatchObject({
      subscription_id: 'subscription-active',
      status: 'applied',
      idempotent: true,
    })
    expect(subscription(test.raw, 'subscription-active').expires_at_ms)
      .toBe(oldExpiry + 30 * DAY_MS)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM subscription_events WHERE source_type = 'payment'`,
    ).get()).toEqual({ count: 1 })
    expect(test.state.calls).toHaveLength(1)
  })

  it('recovers a DO failure without extending the subscription twice', async () => {
    const test = fixture()
    const oldExpiry = NOW + 2 * DAY_MS
    seedSubscription(test.raw, {
      id: 'subscription-retry',
      status: 'active',
      startsAt: NOW - DAY_MS,
      expiresAt: oldExpiry,
      usedMicros: 123,
      controlVersion: 2,
    })
    insertOrder(test.raw, 'order-retry')
    test.state.failuresRemaining = 1

    await expect(fulfillPaymentOrder(test.env, 'order-retry')).rejects.toThrow()
    expect(subscription(test.raw, 'subscription-retry').expires_at_ms)
      .toBe(oldExpiry + 30 * DAY_MS)
    expect(test.raw.prepare(
      `SELECT status, result_resource_id, last_error
         FROM payment_fulfillments WHERE order_id = ?`,
    ).get('order-retry')).toMatchObject({
      status: 'failed',
      result_resource_id: 'subscription-retry',
    })
    expect(test.raw.prepare(
      `SELECT status, subscription_id FROM payment_orders WHERE id = ?`,
    ).get('order-retry')).toEqual({ status: 'RECHARGING', subscription_id: null })

    const recovered = await fulfillPaymentOrder(test.env, 'order-retry')
    expect(recovered).toMatchObject({ status: 'applied', subscription_id: 'subscription-retry' })
    expect(subscription(test.raw, 'subscription-retry').expires_at_ms)
      .toBe(oldExpiry + 30 * DAY_MS)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM subscription_events
        WHERE source_type = 'payment' AND source_id = ?`,
    ).get('order-retry')).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_subscription_terms WHERE order_id = ?`,
    ).get('order-retry')).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT status, attempts FROM subscription_state_sync WHERE request_id = ?`,
    ).get('payment:order-retry')).toEqual({ status: 'applied', attempts: 1 })
  })

  it('serializes different paid renewal orders and applies both contributions', async () => {
    const test = fixture()
    const oldExpiry = NOW + 5 * DAY_MS
    seedSubscription(test.raw, {
      id: 'subscription-concurrent-renewal',
      status: 'active',
      startsAt: NOW - 10 * DAY_MS,
      expiresAt: oldExpiry,
      usedMicros: 321,
      controlVersion: 2,
    })
    insertOrder(test.raw, 'order-concurrent-a', '1'.repeat(64))
    insertOrder(test.raw, 'order-concurrent-b', '2'.repeat(64))
    const database = test.env.DB
    const originalBatch = database.batch.bind(database)
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    database.batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (statements.some((statement) => (
        statement as D1PreparedStatement & { sql?: string }
      ).sql?.includes('INSERT INTO user_subscriptions'))) {
        arrivals += 1
        if (arrivals === 2) release()
        else await gate
      }
      return originalBatch<T>(statements)
    }

    const results = await Promise.all([
      fulfillPaymentOrder(test.env, 'order-concurrent-a'),
      fulfillPaymentOrder(test.env, 'order-concurrent-b'),
    ])

    expect(results.map((result) => result.status)).toEqual(['applied', 'applied'])
    expect(subscription(test.raw, 'subscription-concurrent-renewal')).toMatchObject({
      status: 'active',
      starts_at_ms: NOW - 10 * DAY_MS,
      expires_at_ms: oldExpiry + 60 * DAY_MS,
      daily_used_micros: 321,
      control_version: 4,
    })
    expect(test.raw.prepare(
      `SELECT order_id, granted_duration_ms FROM payment_subscription_terms
        WHERE subscription_id = ? ORDER BY order_id`,
    ).all('subscription-concurrent-renewal')).toEqual([
      { order_id: 'order-concurrent-a', granted_duration_ms: 30 * DAY_MS },
      { order_id: 'order-concurrent-b', granted_duration_ms: 30 * DAY_MS },
    ])
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM subscription_events
        WHERE source_type = 'payment' AND source_id IN (?, ?)`,
    ).get('order-concurrent-a', 'order-concurrent-b')).toEqual({ count: 2 })
  })

  it('restarts an expired term with fresh windows and snapshot quotas', async () => {
    const test = fixture()
    seedSubscription(test.raw, {
      id: 'subscription-expired',
      status: 'expired',
      startsAt: NOW - 60 * DAY_MS,
      expiresAt: NOW - DAY_MS,
      usedMicros: 999,
      controlVersion: 8,
      quotaResetEpoch: 3,
    })
    insertOrder(test.raw, 'order-restart')

    await fulfillPaymentOrder(test.env, 'order-restart')

    expect(subscription(test.raw, 'subscription-expired')).toMatchObject({
      starts_at_ms: NOW,
      expires_at_ms: NOW + 30 * DAY_MS,
      daily_anchor_ms: 0,
      daily_window_start_ms: Math.floor(NOW / DAY_MS) * DAY_MS,
      weekly_window_start_ms: NOW,
      monthly_window_start_ms: NOW,
      daily_used_micros: 0,
      weekly_used_micros: 0,
      monthly_used_micros: 0,
      quota_reset_epoch: 4,
      source_type: 'payment',
      source_id: 'order-restart',
      control_version: 9,
    })
    expect(test.raw.prepare(
      `SELECT term_kind, previous_status, previous_starts_at_ms,
              previous_expires_at_ms, starts_at_ms, expires_at_ms,
              granted_duration_ms, refunded_duration_ms
         FROM payment_subscription_terms WHERE order_id = 'order-restart'`,
    ).get()).toEqual({
      term_kind: 'restarted',
      previous_status: 'expired',
      previous_starts_at_ms: NOW - 60 * DAY_MS,
      previous_expires_at_ms: NOW - DAY_MS,
      starts_at_ms: NOW,
      expires_at_ms: NOW + 30 * DAY_MS,
      granted_duration_ms: 30 * DAY_MS,
      refunded_duration_ms: 0,
    })
  })

  it.each(['suspended', 'revoked'] as const)(
    'does not overwrite a %s entitlement',
    async (status) => {
      const test = fixture()
      const oldExpiry = NOW + DAY_MS
      seedSubscription(test.raw, {
        id: `subscription-${status}`,
        status,
        startsAt: NOW - DAY_MS,
        expiresAt: oldExpiry,
        usedMicros: 55,
        controlVersion: 1,
      })
      insertOrder(test.raw, `order-${status}`)

      await expect(fulfillPaymentOrder(test.env, `order-${status}`)).rejects.toThrow()

      expect(subscription(test.raw, `subscription-${status}`)).toMatchObject({
        status,
        expires_at_ms: oldExpiry,
        daily_used_micros: 55,
        control_version: 1,
      })
      expect(test.raw.prepare(
        `SELECT COUNT(*) AS count FROM subscription_events
          WHERE source_type = 'payment' AND source_id = ?`,
      ).get(`order-${status}`)).toEqual({ count: 0 })
      expect(test.raw.prepare(
        `SELECT status, last_error FROM payment_fulfillments WHERE order_id = ?`,
      ).get(`order-${status}`)).toMatchObject({ status: 'failed' })
      expect(test.state.calls).toHaveLength(0)
    },
  )

  it('takes over an expired lease during bounded recovery and leaves a fresh lease alone', async () => {
    const test = fixture()
    insertOrder(test.raw, 'order-stale', '1'.repeat(64))
    insertOrder(test.raw, 'order-fresh', '2'.repeat(64))
    insertFulfillment(test.raw, 'order-stale', NOW - 1)
    insertFulfillment(test.raw, 'order-fresh', NOW + 60_000)

    const recovered = await recoverPendingPaymentFulfillments(test.env, 10)

    expect(recovered).toBe(1)
    expect(test.raw.prepare(
      `SELECT status, attempts, lease_owner FROM payment_fulfillments WHERE order_id = ?`,
    ).get('order-stale')).toEqual({ status: 'applied', attempts: 2, lease_owner: null })
    expect(test.raw.prepare(
      `SELECT status, attempts, lease_owner FROM payment_fulfillments WHERE order_id = ?`,
    ).get('order-fresh')).toEqual({ status: 'processing', attempts: 1, lease_owner: 'old-worker' })
    expect(test.raw.prepare(
      `SELECT status FROM payment_orders WHERE id = ?`,
    ).get('order-stale')).toEqual({ status: 'COMPLETED' })
    expect(test.raw.prepare(
      `SELECT status FROM payment_orders WHERE id = ?`,
    ).get('order-fresh')).toEqual({ status: 'PAID' })
  })
})

function fixture(): Fixture {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.prepare(`
    INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
    VALUES (?, 'buyer@example.test', 'Buyer', ?, ?)
  `).run(USER_ID, NOW, NOW)
  raw.prepare(`
    INSERT INTO "groups" (
      id, name, platform, enabled, group_type,
      daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'Pro', 'openai', 1, 'subscription', 1, 2, 3, ?, ?)
  `).run(GROUP_ID, NOW, NOW)
  raw.prepare(`
    INSERT INTO subscription_plans (
      id, group_id, name, validity_days, price_micros, currency,
      daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'Pro 30', 30, 12500000, 'USD', 5000000, 20000000, 60000000, ?, ?)
  `).run(PLAN_ID, GROUP_ID, NOW, NOW)
  raw.prepare(`
    INSERT INTO payment_provider_instances (
      id, provider_key, provider_type, display_name,
      config_ciphertext, config_nonce, config_key_id,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'stripe-primary', 'stripe', 'Stripe', 'ciphertext', 'nonce', 'key-v1', ?, ?)
  `).run(PROVIDER_ID, NOW, NOW)
  const state = new SubscriptionStateFake()
  return {
    raw,
    state,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      ASSETS: {} as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: state.namespace(),
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function insertOrder(raw: any, id: string, keyHash = 'a'.repeat(64)): void {
  raw.prepare(`
    INSERT INTO payment_orders (
      id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
      idempotency_key_hash, request_hash, order_type, status,
      amount_micros, pay_amount_micros, fee_ppm_snapshot, currency,
      plan_id, plan_name_snapshot, plan_group_id_snapshot,
      plan_validity_days_snapshot, plan_price_micros_snapshot, plan_currency_snapshot,
      plan_daily_quota_micros_snapshot, plan_weekly_quota_micros_snapshot,
      plan_monthly_quota_micros_snapshot, expires_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, 'stripe-primary', ?, ?, ?, 'subscription', 'PAID',
      12500000, 12500000, 0, 'USD', ?, 'Pro 30', ?, 30, 12500000, 'USD',
      5000000, 20000000, 60000000, ?, ?, ?
    )
  `).run(
    id,
    USER_ID,
    PROVIDER_ID,
    `trade-${id}`,
    keyHash,
    'f'.repeat(64),
    PLAN_ID,
    GROUP_ID,
    NOW + DAY_MS,
    NOW - 1_000,
    NOW - 1_000,
  )
}

function seedSubscription(
  raw: any,
  input: {
    id: string
    status: 'active' | 'expired' | 'suspended' | 'revoked'
    startsAt: number
    expiresAt: number
    usedMicros: number
    controlVersion: number
    quotaResetEpoch?: number
  },
): void {
  raw.prepare(`
    INSERT INTO user_subscriptions (
      id, user_id, group_id, plan_id, status, starts_at_ms, expires_at_ms,
      daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
      daily_used_micros, weekly_used_micros, monthly_used_micros,
      daily_anchor_ms, daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
      quota_reset_epoch, quota_reset_generation,
      source_type, source_id, control_version, created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, 100, 200, 300, ?, ?, ?, 0, ?, ?, ?, ?, 0,
      'admin', ?, ?, ?, ?
    )
  `).run(
    input.id,
    USER_ID,
    GROUP_ID,
    PLAN_ID,
    input.status,
    input.startsAt,
    input.expiresAt,
    input.usedMicros,
    input.usedMicros,
    input.usedMicros,
    Math.floor(input.startsAt / DAY_MS) * DAY_MS,
    input.startsAt,
    input.startsAt,
    input.quotaResetEpoch ?? 0,
    `seed-${input.id}`,
    input.controlVersion,
    input.startsAt,
    input.startsAt,
  )
}

function insertFulfillment(raw: any, orderId: string, leaseExpiresAtMs: number): void {
  raw.prepare(`
    INSERT INTO payment_fulfillments (
      id, order_id, action, status, attempts, available_at_ms,
      lease_owner, lease_expires_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'subscription_entitlement', 'processing', 1, ?, 'old-worker', ?, ?, ?)
  `).run(`fulfillment-${orderId}`, orderId, NOW - 10_000, leaseExpiresAtMs, NOW - 10_000, NOW - 10_000)
}

function subscription(raw: any, id: string): Record<string, unknown> {
  return raw.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(id) as Record<string, unknown>
}
