import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { requireAdminSession } from '../../src/control/admin-auth'
import { deterministicUuid } from '../../src/control/http'
import type { Env } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { paymentProviderCredentialAad } from '../../src/payment/config'
import {
  getRefundEligibleProviders,
  processAdminRefund,
  queryAdminRefund,
  requestPaymentRefund,
} from '../../src/payment/refunds'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'payment-refund-test-pepper-value-at-least-32-bytes'
const MASTER_KEY = 'payment-refund-master-key-value-at-least-32-bytes'
const NOW = 1_788_451_200_000
const DAY_MS = 86_400_000

interface Fixture {
  raw: any
  env: Env
  app: Hono<{ Bindings: Env }>
  authorization: Record<'alice' | 'bob' | 'admin', string>
  stripeFetch: ReturnType<typeof vi.fn<typeof fetch>>
}

interface InsertProviderInput {
  id: string
  providerKey: string
  refundEnabled: boolean
  allowUserRefund: boolean
  enabled?: boolean
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Stripe refund HTTP contract', () => {
  it('lists only provider instances that explicitly allow user refunds', async () => {
    const test = await fixture()

    const response = await userRequest(
      test,
      'alice',
      '/api/v1/payment/orders/refund-eligible-providers',
    )

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      code: 0,
      data: { provider_instance_ids: ['stripe-user-refunds'] },
    })
  })

  it('fails closed instead of accepting a self-service balance refund before clawback exists', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-user-refund',
      userId: 'alice',
      providerId: 'stripe-user-refunds',
      providerKey: 'stripe-user-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
    })

    const response = await userRequest(
      test,
      'alice',
      '/api/v1/payment/orders/order-user-refund/refund-request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'charged by mistake' }),
      },
    )
    expect(response.status).toBe(409)
    expect((await json(response)).code).toBe('refund_clawback_unavailable')

    expect(test.raw.prepare(
      `SELECT status, refund_requested_at_ms, version
         FROM payment_orders WHERE id = 'order-user-refund'`,
    ).get()).toEqual({
      status: 'COMPLETED',
      refund_requested_at_ms: null,
      version: 0,
    })
    expect(test.raw.prepare(
      `SELECT order_id, amount_micros, currency, status, reason, requested_by_user_id
         FROM payment_refunds WHERE order_id = 'order-user-refund'`,
    ).all()).toEqual([])
    expect(test.raw.prepare(
      `SELECT event_type, source_type FROM payment_events
        WHERE order_id = 'order-user-refund'`,
    ).all()).toEqual([])
    expect(test.stripeFetch).not.toHaveBeenCalled()
  })

  it('rejects a historical user refund replay when the reason changes', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-user-reason-conflict',
      userId: 'alice',
      providerId: 'stripe-user-refunds',
      providerKey: 'stripe-user-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 2_000_000,
      payAmountMicros: 2_000_000,
      paidAmountMicros: 2_000_000,
    })
    const requestHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        'payment-refund-user-request:v2\0order-user-reason-conflict\0alice\0duplicate purchase',
      ),
    )
    const requestHashHex = Array.from(new Uint8Array(requestHash))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')
    test.raw.prepare(
      `INSERT INTO payment_refunds (
         id, order_id, request_key_hash, provider_key, amount_micros, currency,
         status, reason, requested_by_user_id, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'USD', 'requested', ?, ?, ?, ?)`,
    ).run(
      await deterministicUuid(
        'payment-refund-user-request:v1',
        'order-user-reason-conflict\0alice',
      ),
      'order-user-reason-conflict',
      requestHashHex,
      'stripe-user-refunds-key',
      2_000_000,
      'duplicate purchase',
      'alice',
      NOW,
      NOW,
    )

    const conflict = await userRequest(
      test,
      'alice',
      '/api/v1/payment/orders/order-user-reason-conflict/refund-request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'different reason' }),
      },
    )
    expect(conflict.status).toBe(409)
    expect((await json(conflict)).code).toBe('refund_request_conflict')
  })

  it('does not disclose or mutate another user\'s order during a refund request', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-owned-by-bob',
      userId: 'bob',
      providerId: 'stripe-user-refunds',
      providerKey: 'stripe-user-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 4_000_000,
      payAmountMicros: 4_000_000,
      paidAmountMicros: 4_000_000,
    })

    const response = await userRequest(
      test,
      'alice',
      '/api/v1/payment/orders/order-owned-by-bob/refund-request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'not my order' }),
      },
    )

    expect(response.status).toBe(404)
    expect((await json(response)).code).toBe('payment_order_not_found')
    expect(test.raw.prepare(
      `SELECT status, version FROM payment_orders WHERE id = 'order-owned-by-bob'`,
    ).get()).toEqual({ status: 'COMPLETED', version: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_refunds WHERE order_id = 'order-owned-by-bob'`,
    ).get()).toEqual({ count: 0 })
  })

  it('defaults admin clawback to required and rejects both omission and explicit true', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-clawback-required',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 6_000_000,
      payAmountMicros: 6_000_000,
      paidAmountMicros: 6_000_000,
    })

    for (const [suffix, deductBalance] of [
      ['omitted', undefined],
      ['explicit', true],
    ] as const) {
      const body: Record<string, unknown> = { amount: 6, reason: 'clawback required' }
      if (deductBalance !== undefined) body.deduct_balance = deductBalance
      const response = await userRequest(test, 'admin',
        '/api/v1/admin/payment/orders/order-clawback-required/refund', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `clawback-${suffix}` },
          body: JSON.stringify(body),
        })
      expect(response.status).toBe(409)
      expect((await json(response)).code).toBe('refund_clawback_unavailable')
    }
    expect(test.raw.prepare(
      `SELECT status, version FROM payment_orders WHERE id = 'order-clawback-required'`,
    ).get()).toEqual({ status: 'COMPLETED', version: 0 })
    expect(test.stripeFetch).not.toHaveBeenCalled()
  })

  it('processes one partial Stripe refund and replays the completed result', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-admin-partial',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
      paymentIntentId: 'pi-admin-partial',
    })

    test.stripeFetch.mockResolvedValue(stripeRefund({
      id: 're-admin-partial',
      amount: 500,
      currency: 'usd',
      status: 'succeeded',
      paymentIntent: 'pi-admin-partial',
    }))
    const request = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-partial-refund-v1',
      },
      body: JSON.stringify({
        amount: 5,
        reason: 'partial service credit',
        deduct_balance: false,
        force: false,
      }),
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await userRequest(
        test,
        'admin',
        '/api/v1/admin/payment/orders/order-admin-partial/refund',
        request,
      )
      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({
        code: 0,
        data: {
          success: true,
          balance_deducted: 0,
          subscription_days_deducted: 0,
        },
      })
    }

    expect(test.stripeFetch).toHaveBeenCalledTimes(1)
    const stripeCall = test.stripeFetch.mock.calls[0]
    expect(String(stripeCall?.[0])).toBe('https://api.stripe.com/v1/refunds')
    const stripeForm = new URLSearchParams(String(stripeCall?.[1]?.body))
    expect(stripeForm.get('payment_intent')).toBe('pi-admin-partial')
    expect(stripeForm.get('amount')).toBe('500')

    expect(test.raw.prepare(
      `SELECT status, refunded_amount_micros, refund_completed_at_ms, version
         FROM payment_orders WHERE id = 'order-admin-partial'`,
    ).get()).toEqual({
      status: 'PARTIALLY_REFUNDED',
      refunded_amount_micros: 5_000_000,
      refund_completed_at_ms: NOW,
      version: 2,
    })
    expect(test.raw.prepare(
      `SELECT status, provider_refund_id, amount_micros, settled_amount_micros, currency
         FROM payment_refunds WHERE order_id = 'order-admin-partial'`,
    ).all()).toEqual([{
      status: 'refunded',
      provider_refund_id: 're-admin-partial',
      amount_micros: 5_000_000,
      settled_amount_micros: 5_000_000,
      currency: 'USD',
    }])
    expect(test.raw.prepare(
      `SELECT event_type FROM payment_events
        WHERE order_id = 'order-admin-partial' ORDER BY event_type`,
    ).all()).toEqual([
      { event_type: 'REFUND_PROCESSING' },
      { event_type: 'REFUND_SUCCEEDED' },
    ])
    const processingEvent = test.raw.prepare(
      `SELECT payload_json FROM payment_events
        WHERE order_id = 'order-admin-partial' AND event_type = 'REFUND_PROCESSING'`,
    ).get() as { payload_json: string }
    expect(JSON.parse(processingEvent.payload_json)).toMatchObject({
      deduct_balance: false,
      courtesy_refund_without_clawback: true,
    })
  })

  it('records principal refund while sending the proportional fee-inclusive amount to Stripe', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-admin-fee',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 10_000_000,
      payAmountMicros: 11_000_000,
      paidAmountMicros: 11_000_000,
      paymentIntentId: 'pi-admin-fee',
    })
    test.stripeFetch.mockResolvedValue(stripeRefund({
      id: 're-admin-fee', amount: 550, currency: 'usd', status: 'succeeded',
      paymentIntent: 'pi-admin-fee',
    }))

    const response = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-admin-fee/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-fee-v1' },
        body: JSON.stringify({ amount: 5, reason: 'half including fee', deduct_balance: false }),
      })

    expect(response.status).toBe(200)
    const stripeForm = new URLSearchParams(String(test.stripeFetch.mock.calls[0]?.[1]?.body))
    expect(stripeForm.get('amount')).toBe('550')
    expect(test.raw.prepare(
      `SELECT status, refunded_amount_micros FROM payment_orders WHERE id = 'order-admin-fee'`,
    ).get()).toEqual({ status: 'PARTIALLY_REFUNDED', refunded_amount_micros: 5_000_000 })
    expect(test.raw.prepare(
      `SELECT amount_micros, settled_amount_micros
         FROM payment_refunds WHERE order_id = 'order-admin-fee'`,
    ).get()).toEqual({ amount_micros: 5_000_000, settled_amount_micros: 5_000_000 })
  })

  it('persists a pending Stripe refund and query finalizes the same provider refund', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-admin-pending',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 10_000_000,
      payAmountMicros: 10_000_000,
      paidAmountMicros: 10_000_000,
      paymentIntentId: 'pi-admin-pending',
    })
    test.stripeFetch
      .mockResolvedValueOnce(stripeRefund({
        id: 're-admin-pending', amount: 1_000, currency: 'usd', status: 'pending',
        paymentIntent: 'pi-admin-pending',
      }))
      .mockResolvedValueOnce(stripeRefund({
        id: 're-admin-pending', amount: 1_000, currency: 'usd', status: 'succeeded',
        paymentIntent: 'pi-admin-pending',
      }))

    const start = await userRequest(
      test,
      'admin',
      '/api/v1/admin/payment/orders/order-admin-pending/refund',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'admin-pending-v1' },
        body: JSON.stringify({ amount: 10, reason: 'full refund', deduct_balance: false }),
      },
    )
    expect(start.status).toBe(200)
    expect(await json(start)).toEqual({
      code: 0,
      data: { success: false, warning: 'Stripe refund is pending' },
    })
    expect(test.raw.prepare(
      `SELECT status, version FROM payment_orders WHERE id = 'order-admin-pending'`,
    ).get()).toEqual({ status: 'REFUND_PENDING', version: 2 })

    const query = await userRequest(
      test,
      'admin',
      '/api/v1/admin/payment/orders/order-admin-pending/refund/query',
      { method: 'POST' },
    )
    expect(query.status).toBe(200)
    expect(await json(query)).toEqual({
      code: 0,
      data: { success: true, balance_deducted: 0, subscription_days_deducted: 0 },
    })
    expect(String(test.stripeFetch.mock.calls[1]?.[0])).toBe(
      'https://api.stripe.com/v1/refunds/re-admin-pending',
    )
    expect(test.raw.prepare(
      `SELECT status, refunded_amount_micros, version
         FROM payment_orders WHERE id = 'order-admin-pending'`,
    ).get()).toEqual({ status: 'REFUNDED', refunded_amount_micros: 10_000_000, version: 3 })
    expect(test.raw.prepare(
      `SELECT status, provider_refund_id, settled_amount_micros
         FROM payment_refunds WHERE order_id = 'order-admin-pending'`,
    ).get()).toEqual({
      status: 'refunded', provider_refund_id: 're-admin-pending', settled_amount_micros: 10_000_000,
    })
  })

  it('fails closed on a mismatched Stripe currency and query can recover the persisted failure', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-currency-mismatch',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 7_000_000,
      payAmountMicros: 7_000_000,
      paidAmountMicros: 7_000_000,
      paymentIntentId: 'pi-currency-mismatch',
    })
    test.stripeFetch
      .mockResolvedValueOnce(stripeRefund({
        id: 're-currency-mismatch', amount: 700, currency: 'eur', status: 'succeeded',
        paymentIntent: 'pi-currency-mismatch',
      }))
      .mockResolvedValueOnce(stripeRefund({
        id: 're-currency-mismatch', amount: 700, currency: 'usd', status: 'succeeded',
        paymentIntent: 'pi-currency-mismatch',
      }))

    const failed = await userRequest(
      test,
      'admin',
      '/api/v1/admin/payment/orders/order-currency-mismatch/refund',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'currency-mismatch-v1' },
        body: JSON.stringify({ amount: 7, reason: 'currency check', deduct_balance: false }),
      },
    )
    expect(failed.status).toBe(502)
    expect((await json(failed)).code).toBe('stripe_refund_mismatch')
    expect(test.raw.prepare(
      `SELECT status, refunded_amount_micros, version
         FROM payment_orders WHERE id = 'order-currency-mismatch'`,
    ).get()).toEqual({ status: 'REFUND_FAILED', refunded_amount_micros: 0, version: 2 })
    expect(test.raw.prepare(
      `SELECT status, provider_refund_id, settled_amount_micros
         FROM payment_refunds WHERE order_id = 'order-currency-mismatch'`,
    ).get()).toEqual({
      status: 'failed', provider_refund_id: 're-currency-mismatch', settled_amount_micros: 0,
    })

    const recovered = await userRequest(
      test,
      'admin',
      '/api/v1/admin/payment/orders/order-currency-mismatch/refund/query',
      { method: 'POST' },
    )
    expect(recovered.status).toBe(200)
    expect((await json(recovered)).data).toEqual({
      success: true, balance_deducted: 0, subscription_days_deducted: 0,
    })
    expect(test.raw.prepare(
      `SELECT status, refunded_amount_micros, version
         FROM payment_orders WHERE id = 'order-currency-mismatch'`,
    ).get()).toEqual({ status: 'REFUNDED', refunded_amount_micros: 7_000_000, version: 3 })
  })

  it('retries the stable Stripe refund from query after a network failure persisted no provider id', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-network-recovery',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 9_000_000,
      payAmountMicros: 9_900_000,
      paidAmountMicros: 9_900_000,
      paymentIntentId: 'pi-network-recovery',
    })
    test.stripeFetch
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(stripeRefund({
        id: 're-network-recovery', amount: 990, currency: 'usd', status: 'succeeded',
        paymentIntent: 'pi-network-recovery',
      }))

    const failed = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-network-recovery/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'network-recovery-v1' },
        body: JSON.stringify({ amount: 9, reason: 'network recovery', deduct_balance: false }),
      })
    expect(failed.status).toBe(503)
    expect(test.raw.prepare(
      `SELECT status, version FROM payment_orders WHERE id = 'order-network-recovery'`,
    ).get()).toEqual({ status: 'REFUND_FAILED', version: 2 })
    expect(test.raw.prepare(
      `SELECT status, provider_refund_id, amount_micros, reason
         FROM payment_refunds WHERE order_id = 'order-network-recovery'`,
    ).get()).toEqual({
      status: 'failed', provider_refund_id: null,
      amount_micros: 9_000_000, reason: 'network recovery',
    })

    const recovered = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-network-recovery/refund/query',
      { method: 'POST' },
    )
    expect(recovered.status).toBe(200)
    expect((await json(recovered)).data).toEqual({
      success: true, balance_deducted: 0, subscription_days_deducted: 0,
    })
    expect(test.stripeFetch).toHaveBeenCalledTimes(2)
    for (const call of test.stripeFetch.mock.calls) {
      expect(String(call[0])).toBe('https://api.stripe.com/v1/refunds')
      expect(new Headers(call[1]?.headers).get('idempotency-key')).toBe(
        're-order-network-recovery-990',
      )
    }
    expect(test.raw.prepare(
      `SELECT status, refunded_amount_micros, version
         FROM payment_orders WHERE id = 'order-network-recovery'`,
    ).get()).toEqual({ status: 'REFUNDED', refunded_amount_micros: 9_000_000, version: 4 })
  })

  it('rejects an over-refund or non-refundable status before calling Stripe', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-invalid-refund',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 3_000_000,
      payAmountMicros: 3_000_000,
      paidAmountMicros: 3_000_000,
    })
    const over = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-invalid-refund/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'over-refund-v1' },
        body: JSON.stringify({ amount: 3.01, reason: 'too much', deduct_balance: false }),
      })
    expect(over.status).toBe(400)
    expect((await json(over)).code).toBe('refund_amount_too_large')

    test.raw.prepare(
      `UPDATE payment_orders SET status = 'CANCELLED' WHERE id = 'order-invalid-refund'`,
    ).run()
    const invalidStatus = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-invalid-refund/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-status-v1' },
        body: JSON.stringify({ amount: 3, reason: 'cancelled', deduct_balance: false }),
      })
    expect(invalidStatus.status).toBe(409)
    expect((await json(invalidStatus)).code).toBe('invalid_refund_status')
    expect(test.stripeFetch).not.toHaveBeenCalled()
  })
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  for (const [id, role] of [
    ['alice', 'user'],
    ['bob', 'user'],
    ['admin', 'admin'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, balance_micros, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 100000000, ?, ?)`,
    ).run(id, `${id}@example.test`, id, role, NOW, NOW)
  }

  await insertProvider(raw, {
    id: 'stripe-user-refunds',
    providerKey: 'stripe-user-refunds-key',
    refundEnabled: true,
    allowUserRefund: true,
  })
  await insertProvider(raw, {
    id: 'stripe-admin-refunds',
    providerKey: 'stripe-admin-refunds-key',
    refundEnabled: true,
    allowUserRefund: false,
  })
  await insertProvider(raw, {
    id: 'stripe-refunds-disabled',
    providerKey: 'stripe-refunds-disabled-key',
    refundEnabled: false,
    allowUserRefund: false,
  })
  await insertProvider(raw, {
    id: 'stripe-user-refunds-disabled',
    providerKey: 'stripe-user-refunds-disabled-key',
    refundEnabled: true,
    allowUserRefund: true,
    enabled: false,
  })

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

  const stripeFetch = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', stripeFetch)
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  } as Env

  const app = new Hono<{ Bindings: Env }>()
  app.get('/api/v1/payment/orders/refund-eligible-providers', getRefundEligibleProviders)
  app.post('/api/v1/payment/orders/:id/refund-request', requestPaymentRefund)
  app.use('/api/v1/admin/*', requireAdminSession)
  app.post('/api/v1/admin/payment/orders/:id/refund', processAdminRefund)
  app.post('/api/v1/admin/payment/orders/:id/refund/query', queryAdminRefund)

  return { raw, env, app, authorization, stripeFetch }
}

async function insertProvider(raw: any, input: InsertProviderInput): Promise<void> {
  const keyId = `key-${input.id}`
  const encrypted = await encryptCredential({
    api_key: `sk_test_${input.id}`,
    webhook_secret: `whsec_${input.id}`,
    publishable_key: `pk_test_${input.id}`,
    supported_types: ['stripe'],
    payment_mode: 'redirect',
    limits: '',
    refund_enabled: input.refundEnabled,
    allow_user_refund: input.allowUserRefund,
  } as any, MASTER_KEY, paymentProviderCredentialAad('test', input.id, keyId, 0))
  raw.prepare(
    `INSERT INTO payment_provider_instances (
       id, provider_key, provider_type, display_name,
       config_ciphertext, config_nonce, config_key_id,
       enabled, version, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 'stripe', 'Stripe', ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    input.id,
    input.providerKey,
    encrypted.ciphertext_b64,
    encrypted.nonce_b64,
    keyId,
    input.enabled === false ? 0 : 1,
    NOW,
    NOW,
  )
}

function insertOrder(raw: any, input: {
  id: string
  userId: string
  providerId: string
  providerKey: string
  orderType: 'balance' | 'subscription'
  status: string
  amountMicros: number
  payAmountMicros: number
  paidAmountMicros: number
  refundedAmountMicros?: number
  currency?: string
  paymentIntentId?: string | null
}): void {
  const subscription = input.orderType === 'subscription'
  raw.prepare(
    `INSERT INTO payment_orders (
       id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
       idempotency_key_hash, request_hash, payment_intent_id,
       order_type, status, amount_micros, pay_amount_micros, fee_ppm_snapshot,
       paid_amount_micros, refunded_amount_micros, currency,
       plan_id, plan_name_snapshot, plan_group_id_snapshot,
       plan_validity_days_snapshot, plan_price_micros_snapshot, plan_currency_snapshot,
       version, expires_at_ms, paid_at_ms, completed_at_ms, created_at_ms, updated_at_ms
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?
     )`,
  ).run(
    input.id,
    input.userId,
    input.providerId,
    input.providerKey,
    `sub2-${input.id}`,
    refundHash(`${input.id}-idempotency`),
    refundHash(`${input.id}-request`),
    input.paymentIntentId === undefined ? `pi-${input.id}` : input.paymentIntentId,
    input.orderType,
    input.status,
    input.amountMicros,
    input.payAmountMicros,
    input.paidAmountMicros,
    input.refundedAmountMicros ?? 0,
    input.currency ?? 'USD',
    subscription ? 'plan-refund' : null,
    subscription ? 'Refund plan' : null,
    subscription ? 'group-refund' : null,
    subscription ? 30 : null,
    subscription ? input.amountMicros : null,
    subscription ? input.currency ?? 'USD' : null,
    NOW + DAY_MS,
    NOW,
    NOW,
    NOW - 1_000,
    NOW,
  )
}

function refundHash(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .reduce((result, byte) => result + byte.toString(16).padStart(2, '0'), '')
    .padEnd(64, '0')
    .slice(0, 64)
}

async function userRequest(
  test: Fixture,
  user: keyof Fixture['authorization'],
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return test.app.request(path, {
    ...init,
    headers: { authorization: test.authorization[user], ...init.headers },
  }, test.env)
}

async function json(response: Response): Promise<any> {
  return response.json()
}

function stripeRefund(input: {
  id: string
  amount: number
  currency: string
  status: string
  paymentIntent: string
}): Response {
  return Response.json({
    id: input.id,
    object: 'refund',
    amount: input.amount,
    currency: input.currency,
    status: input.status,
    payment_intent: input.paymentIntent,
  })
}
