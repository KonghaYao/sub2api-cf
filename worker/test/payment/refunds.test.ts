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
  recoverPendingRefundClawbacks,
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
  subscriptionFetch: ReturnType<typeof vi.fn>
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

  it('requires force when a subscription entitlement can no longer be found', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-subscription-missing',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'subscription',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
    })

    const response = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-missing/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'subscription-missing-v1' },
        body: JSON.stringify({ amount: 12.5, reason: 'subscription missing' }),
      })

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      code: 0,
      data: {
        success: false,
        warning: 'Cannot find an active subscription for deduction; retry with force',
        require_force: true,
      },
    })
    expect(test.stripeFetch).not.toHaveBeenCalled()
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_refunds WHERE order_id = 'order-subscription-missing'`,
    ).get()).toEqual({ count: 0 })
  })

  it('deducts snapshotted subscription days once and replays the completed result', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'subscription-refund-once',
      userId: 'alice',
      status: 'active',
      startsAt: NOW - 10 * DAY_MS,
      expiresAt: NOW + 60 * DAY_MS,
      controlVersion: 3,
    })
    insertOrder(test.raw, {
      id: 'order-subscription-refund-once',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'subscription',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
      subscriptionId: 'subscription-refund-once',
      paymentIntentId: 'pi-subscription-refund-once',
    })
    test.stripeFetch.mockResolvedValue(stripeRefund({
      id: 're-subscription-refund-once', amount: 1_250, currency: 'usd', status: 'succeeded',
      paymentIntent: 'pi-subscription-refund-once',
    }))
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'subscription-refund-once-v1' },
      body: JSON.stringify({ amount: 12.5, reason: 'subscription refund' }),
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await userRequest(test, 'admin',
        '/api/v1/admin/payment/orders/order-subscription-refund-once/refund', request)
      expect(response.status).toBe(200)
      expect((await json(response)).data).toEqual({
        success: true, balance_deducted: 0, subscription_days_deducted: 30,
      })
    }

    expect(test.stripeFetch).toHaveBeenCalledTimes(1)
    expect(test.subscriptionFetch).toHaveBeenCalledTimes(1)
    expect(test.raw.prepare(
      `SELECT status, expires_at_ms, control_version
         FROM user_subscriptions WHERE id = 'subscription-refund-once'`,
    ).get()).toEqual({ status: 'active', expires_at_ms: NOW + 30 * DAY_MS, control_version: 4 })
    expect(test.raw.prepare(
      `SELECT clawback_kind, clawback_status, clawback_resource_id, clawback_days,
              clawback_forced, clawback_applied_control_version
         FROM payment_refunds WHERE order_id = 'order-subscription-refund-once'`,
    ).get()).toEqual({
      clawback_kind: 'subscription',
      clawback_status: 'applied',
      clawback_resource_id: 'subscription-refund-once',
      clawback_days: 30,
      clawback_forced: 0,
      clawback_applied_control_version: 4,
    })
    expect(test.raw.prepare(
      `SELECT status FROM subscription_state_sync
        WHERE request_id LIKE 'payment-refund-clawback:%'`,
    ).all()).toEqual([{ status: 'applied' }])
  })

  it('allows only one refund saga when different idempotency keys race', async () => {
    const test = await fixture()
    insertOrder(test.raw, {
      id: 'order-refund-claim-race',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'balance',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
      paymentIntentId: 'pi-refund-claim-race',
    })
    test.stripeFetch.mockResolvedValue(stripeRefund({
      id: 're-refund-claim-race', amount: 1_250, currency: 'usd', status: 'succeeded',
      paymentIntent: 'pi-refund-claim-race',
    }))
    const database = test.env.DB
    const originalBatch = database.batch.bind(database)
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    database.batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (statements.some((statement) => (
        statement as D1PreparedStatement & { sql?: string }
      ).sql?.includes('payment_refund_claims'))) {
        arrivals += 1
        if (arrivals === 2) release()
        else await gate
      }
      return originalBatch<T>(statements)
    }
    const request = (idempotencyKey: string) => userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-refund-claim-race/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ amount: 12.5, reason: 'concurrent refund', deduct_balance: false }),
      })

    const responses = await Promise.all([request('claim-race-a'), request('claim-race-b')])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(test.stripeFetch).toHaveBeenCalledTimes(1)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_refunds WHERE order_id = 'order-refund-claim-race'`,
    ).get()).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_refund_claims
        WHERE order_id = 'order-refund-claim-race'`,
    ).get()).toEqual({ count: 1 })
  })

  it('revokes an entitlement when subtracting its paid days would expire it', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'subscription-refund-revoke',
      userId: 'alice',
      status: 'active',
      startsAt: NOW - 20 * DAY_MS,
      expiresAt: NOW + 10 * DAY_MS,
      controlVersion: 8,
    })
    insertOrder(test.raw, {
      id: 'order-subscription-refund-revoke',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'subscription',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
      subscriptionId: 'subscription-refund-revoke',
    })
    test.stripeFetch.mockResolvedValue(stripeRefund({
      id: 're-subscription-refund-revoke', amount: 1_250, currency: 'usd', status: 'succeeded',
      paymentIntent: 'pi-order-subscription-refund-revoke',
    }))

    const response = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-refund-revoke/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'subscription-revoke-v1' },
        body: JSON.stringify({ amount: 12.5, reason: 'revoke entitlement' }),
      })

    expect(response.status).toBe(200)
    expect((await json(response)).data.subscription_days_deducted).toBe(30)
    expect(test.raw.prepare(
      `SELECT status, expires_at_ms, control_version
         FROM user_subscriptions WHERE id = 'subscription-refund-revoke'`,
    ).get()).toEqual({ status: 'revoked', expires_at_ms: NOW + 10 * DAY_MS, control_version: 9 })
    const configure = await (test.subscriptionFetch.mock.calls[0]?.[0] as Request).clone().json() as {
      enabled: boolean
    }
    expect(configure.enabled).toBe(false)
  })

  it('rolls back a clawback while Stripe is pending and reapplies it exactly once on success', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'subscription-refund-pending',
      userId: 'alice',
      status: 'active',
      startsAt: NOW - 10 * DAY_MS,
      expiresAt: NOW + 60 * DAY_MS,
      controlVersion: 1,
    })
    insertOrder(test.raw, {
      id: 'order-subscription-refund-pending',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'subscription',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
      subscriptionId: 'subscription-refund-pending',
      paymentIntentId: 'pi-subscription-refund-pending',
    })
    test.stripeFetch
      .mockResolvedValueOnce(stripeRefund({
        id: 're-subscription-refund-pending', amount: 1_250, currency: 'usd', status: 'pending',
        paymentIntent: 'pi-subscription-refund-pending',
      }))
      .mockResolvedValueOnce(stripeRefund({
        id: 're-subscription-refund-pending', amount: 1_250, currency: 'usd', status: 'succeeded',
        paymentIntent: 'pi-subscription-refund-pending',
      }))

    const started = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-refund-pending/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'subscription-pending-v1' },
        body: JSON.stringify({ amount: 12.5, reason: 'pending entitlement refund' }),
      })
    expect(started.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT status, expires_at_ms, control_version
         FROM user_subscriptions WHERE id = 'subscription-refund-pending'`,
    ).get()).toEqual({ status: 'active', expires_at_ms: NOW + 60 * DAY_MS, control_version: 3 })
    expect(test.raw.prepare(
      `SELECT clawback_status FROM payment_refunds
        WHERE order_id = 'order-subscription-refund-pending'`,
    ).get()).toEqual({ clawback_status: 'rolled_back' })

    const completed = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-refund-pending/refund/query',
      { method: 'POST' })
    expect(completed.status).toBe(200)
    expect((await json(completed)).data).toEqual({
      success: true, balance_deducted: 0, subscription_days_deducted: 30,
    })
    expect(test.raw.prepare(
      `SELECT status, expires_at_ms, control_version
         FROM user_subscriptions WHERE id = 'subscription-refund-pending'`,
    ).get()).toEqual({ status: 'active', expires_at_ms: NOW + 30 * DAY_MS, control_version: 4 })
    expect(test.subscriptionFetch).toHaveBeenCalledTimes(3)
  })

  it('does not roll back entitlement when a stale pending query finishes after success', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'subscription-refund-query-race',
      userId: 'alice',
      status: 'active',
      startsAt: NOW - 10 * DAY_MS,
      expiresAt: NOW + 60 * DAY_MS,
      controlVersion: 1,
    })
    insertOrder(test.raw, {
      id: 'order-subscription-refund-query-race',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'subscription',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
      subscriptionId: 'subscription-refund-query-race',
      paymentIntentId: 'pi-subscription-refund-query-race',
    })
    let resolveStalePending!: (response: Response) => void
    const stalePending = new Promise<Response>((resolve) => { resolveStalePending = resolve })
    test.stripeFetch
      .mockResolvedValueOnce(stripeRefund({
        id: 're-subscription-refund-query-race', amount: 1_250, currency: 'usd', status: 'pending',
        paymentIntent: 'pi-subscription-refund-query-race',
      }))
      .mockImplementationOnce(() => stalePending)
      .mockResolvedValueOnce(stripeRefund({
        id: 're-subscription-refund-query-race', amount: 1_250, currency: 'usd', status: 'succeeded',
        paymentIntent: 'pi-subscription-refund-query-race',
      }))

    const started = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-refund-query-race/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'query-race-v1' },
        body: JSON.stringify({ amount: 12.5, reason: 'query race' }),
      })
    expect(started.status).toBe(200)

    const staleQuery = userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-refund-query-race/refund/query',
      { method: 'POST' })
    await vi.waitFor(() => expect(test.stripeFetch).toHaveBeenCalledTimes(2))
    const succeeded = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-refund-query-race/refund/query',
      { method: 'POST' })
    expect(succeeded.status).toBe(200)
    resolveStalePending(stripeRefund({
      id: 're-subscription-refund-query-race', amount: 1_250, currency: 'usd', status: 'pending',
      paymentIntent: 'pi-subscription-refund-query-race',
    }))
    await staleQuery

    expect(test.raw.prepare(
      `SELECT status, expires_at_ms FROM user_subscriptions
        WHERE id = 'subscription-refund-query-race'`,
    ).get()).toEqual({ status: 'active', expires_at_ms: NOW + 30 * DAY_MS })
    expect(test.raw.prepare(
      `SELECT status, clawback_status FROM payment_refunds
        WHERE order_id = 'order-subscription-refund-query-race'`,
    ).get()).toEqual({ status: 'refunded', clawback_status: 'applied' })
  })

  it('persists a rollback conflict and Cron restores the entitlement once it is safe', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'subscription-refund-recovery',
      userId: 'alice',
      status: 'active',
      startsAt: NOW - 10 * DAY_MS,
      expiresAt: NOW + 60 * DAY_MS,
      controlVersion: 1,
    })
    insertOrder(test.raw, {
      id: 'order-subscription-refund-recovery',
      userId: 'alice',
      providerId: 'stripe-admin-refunds',
      providerKey: 'stripe-admin-refunds-key',
      orderType: 'subscription',
      status: 'COMPLETED',
      amountMicros: 12_500_000,
      payAmountMicros: 12_500_000,
      paidAmountMicros: 12_500_000,
      subscriptionId: 'subscription-refund-recovery',
      paymentIntentId: 'pi-subscription-refund-recovery',
    })
    test.stripeFetch.mockImplementationOnce(async () => {
      test.raw.prepare(
        `UPDATE user_subscriptions
            SET expires_at_ms = ?, control_version = control_version + 1
          WHERE id = 'subscription-refund-recovery'`,
      ).run(NOW + 31 * DAY_MS)
      return stripeRefund({
        id: 're-subscription-refund-recovery', amount: 1_250, currency: 'usd', status: 'pending',
        paymentIntent: 'pi-subscription-refund-recovery',
      })
    })

    const started = await userRequest(test, 'admin',
      '/api/v1/admin/payment/orders/order-subscription-refund-recovery/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'subscription-recovery-v1' },
        body: JSON.stringify({ amount: 12.5, reason: 'recover entitlement rollback' }),
      })

    expect(started.status).toBe(503)
    expect((await json(started)).code).toBe('refund_clawback_rollback_pending')
    expect(test.raw.prepare(
      `SELECT status, clawback_status, clawback_recovery_attempts,
              clawback_recovery_after_ms, clawback_last_error
         FROM payment_refunds WHERE order_id = 'order-subscription-refund-recovery'`,
    ).get()).toMatchObject({
      status: 'pending',
      clawback_status: 'rollback_pending',
      clawback_recovery_attempts: 1,
      clawback_recovery_after_ms: NOW + 1_000,
      clawback_last_error: expect.stringContaining('manual reconciliation'),
    })

    test.raw.prepare(
      `UPDATE payment_refunds
          SET clawback_recovery_attempts = 19, clawback_recovery_after_ms = ?
        WHERE order_id = 'order-subscription-refund-recovery'`,
    ).run(NOW)
    await expect(recoverPendingRefundClawbacks(test.env, 10)).resolves.toBe(0)
    expect(test.raw.prepare(
      `SELECT clawback_recovery_attempts, clawback_recovery_after_ms, clawback_last_error
         FROM payment_refunds WHERE order_id = 'order-subscription-refund-recovery'`,
    ).get()).toEqual({
      clawback_recovery_attempts: 20,
      clawback_recovery_after_ms: 8_640_000_000_000_000,
      clawback_last_error: expect.stringContaining('manual_review:'),
    })

    test.raw.prepare(
      `UPDATE user_subscriptions SET expires_at_ms = ?
        WHERE id = 'subscription-refund-recovery'`,
    ).run(NOW + 30 * DAY_MS)
    test.raw.prepare(
      `UPDATE payment_refunds SET clawback_recovery_after_ms = ?
        WHERE order_id = 'order-subscription-refund-recovery'`,
    ).run(NOW + 1_000)
    vi.setSystemTime(NOW + 1_001)
    await expect(recoverPendingRefundClawbacks(test.env, 10)).resolves.toBe(1)

    expect(test.raw.prepare(
      `SELECT status, expires_at_ms, control_version
         FROM user_subscriptions WHERE id = 'subscription-refund-recovery'`,
    ).get()).toEqual({ status: 'active', expires_at_ms: NOW + 60 * DAY_MS, control_version: 4 })
    expect(test.raw.prepare(
      `SELECT clawback_status, clawback_recovery_attempts,
              clawback_recovery_after_ms, clawback_last_error
         FROM payment_refunds WHERE order_id = 'order-subscription-refund-recovery'`,
    ).get()).toEqual({
      clawback_status: 'rolled_back',
      clawback_recovery_attempts: 0,
      clawback_recovery_after_ms: null,
      clawback_last_error: null,
    })
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
    seedAvailableAffiliateRebate(test.raw, 'order-admin-partial', 'bob', 'alice', 2_500_000)

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
      { event_type: 'AFFILIATE_REBATE_CLAWBACK_SUCCEEDED' },
      { event_type: 'REFUND_PROCESSING' },
      { event_type: 'REFUND_SUCCEEDED' },
    ])
    expect(test.raw.prepare(
      `SELECT available_micros, frozen_micros, history_micros
         FROM affiliate_profiles WHERE user_id = 'bob'`,
    ).get()).toEqual({ available_micros: 1_500_000, frozen_micros: 0, history_micros: 1_500_000 })
    expect(test.raw.prepare(
      `SELECT adjustment_kind, adjustment_micros, status
         FROM affiliate_rebate_adjustments`,
    ).all()).toEqual([{
      adjustment_kind: 'partial_clawback', adjustment_micros: 1_000_000, status: 'completed',
    }])
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
  raw.prepare(
    `INSERT INTO "groups" (id, name, platform, enabled, group_type, created_at_ms, updated_at_ms)
     VALUES ('group-refund', 'Refund group', 'openai', 1, 'subscription', ?, ?)`,
  ).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO subscription_plans (
       id, group_id, name, validity_days, price_micros, currency, created_at_ms, updated_at_ms
     ) VALUES ('plan-refund', 'group-refund', 'Refund plan', 30, 12500000, 'USD', ?, ?)`,
  ).run(NOW, NOW)

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
  const subscriptionFetch = vi.fn(async () => Response.json({ ok: true }))
  const subscriptionNamespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: subscriptionFetch }),
  } as unknown as DurableObjectNamespace
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
    SUBSCRIPTION_STATE: subscriptionNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  } as Env

  const app = new Hono<{ Bindings: Env }>()
  app.get('/api/v1/payment/orders/refund-eligible-providers', getRefundEligibleProviders)
  app.post('/api/v1/payment/orders/:id/refund-request', requestPaymentRefund)
  app.use('/api/v1/admin/*', requireAdminSession)
  app.post('/api/v1/admin/payment/orders/:id/refund', processAdminRefund)
  app.post('/api/v1/admin/payment/orders/:id/refund/query', queryAdminRefund)

  return { raw, env, app, authorization, stripeFetch, subscriptionFetch }
}

function seedAvailableAffiliateRebate(
  raw: any,
  orderId: string,
  inviterUserId: string,
  inviteeUserId: string,
  rebateMicros: number,
): void {
  raw.prepare(
    `INSERT INTO affiliate_profiles (
       user_id, code_hash, code_prefix, code_key_version,
       code_nonce_b64, code_ciphertext_b64, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 'AFFTEST', 1, 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', ?, ?)`,
  ).run(inviterUserId, 'd'.repeat(64), NOW, NOW)
  const order = raw.prepare(
    `SELECT amount_micros, paid_amount_micros FROM payment_orders WHERE id = ?`,
  ).get(orderId) as { amount_micros: number; paid_amount_micros: number }
  raw.prepare(
    `INSERT INTO affiliate_rebates (
       id, source_order_id, inviter_user_id, invitee_user_id,
       order_amount_micros, pay_amount_micros, rebate_micros,
       status, eligible_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
  ).run(`rebate-${orderId}`, orderId, inviterUserId, inviteeUserId,
    order.amount_micros, order.paid_amount_micros, rebateMicros, NOW, NOW, NOW)
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
  subscriptionId?: string
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
  if (input.subscriptionId !== undefined) {
    raw.prepare(
      `UPDATE payment_orders
          SET subscription_id = ?, subscription_fulfilled_at_ms = ?
        WHERE id = ?`,
    ).run(input.subscriptionId, NOW, input.id)
  }
}

function seedSubscription(raw: any, input: {
  id: string
  userId: string
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  startsAt: number
  expiresAt: number
  controlVersion: number
}): void {
  raw.prepare(
    `INSERT INTO user_subscriptions (
       id, user_id, group_id, plan_id, status, starts_at_ms, expires_at_ms,
       source_type, source_id, control_version, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 'group-refund', 'plan-refund', ?, ?, ?, 'payment', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.status,
    input.startsAt,
    input.expiresAt,
    `seed-${input.id}`,
    input.controlVersion,
    input.startsAt,
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
