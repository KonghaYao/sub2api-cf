import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import {
  actOnAdminPaymentReconciliationIssue,
  downloadAdminPaymentReconciliationEvidence,
  getAdminPaymentReconciliationIssue,
  listAdminPaymentReconciliationIssues,
  scanPaymentReconciliationIssues,
} from '../../src/payment/reconciliation'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.UTC(2026, 8, 5, 9, 0)
const DAY_MS = 86_400_000
const PEPPER = 'payment-reconciliation-test-pepper-32-bytes'
const ADMIN = 'reconciliation-admin'
const BUYER = 'reconciliation-buyer'
const PROVIDER = 'reconciliation-provider'

interface Fixture {
  raw: any
  env: Env
  bucket: EvidenceBucket
  authorization: Record<'admin' | 'buyer', string>
}

class EvidenceBucket {
  readonly objects = new Map<string, Uint8Array>()

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob): Promise<any> {
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Blob
        ? new Uint8Array(await value.arrayBuffer())
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array(value)
    this.objects.set(key, bytes.slice())
    return { key, size: bytes.byteLength }
  }

  async get(key: string): Promise<any> {
    const bytes = this.objects.get(key)
    if (bytes === undefined) return null
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    return { key, size: bytes.byteLength, body: new Blob([buffer]).stream() }
  }

  bucket(): R2Bucket {
    return this as unknown as R2Bucket
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('payment reconciliation scanner and admin HTTP contract', () => {
  it('scans all anomaly classes with a bounded durable cursor and replay-safe issue identities', async () => {
    const test = await fixture()
    seedAnomalies(test.raw)

    const scans = []
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await scanPaymentReconciliationIssues(test.env, 3)
      scans.push(result)
      expect(result.scanned).toBeLessThanOrEqual(3)
      if (result.next_cursor === '') break
    }
    expect(scans.at(-1)?.next_cursor).toBe('')

    const response = await adminRequest(test, '/reconciliation?page=1&page_size=20')
    expect(response.status).toBe(200)
    const first = await json(response)
    expect(first.data.total).toBe(9)
    expect(new Set(first.data.items.map((item: any) => item.type))).toEqual(new Set([
      'late_paid_refund_required',
      'webhook_pending',
      'webhook_failed',
      'fulfillment_pending',
      'fulfillment_failed',
      'refund_pending',
      'refund_failed',
      'provider_amount_mismatch',
      'provider_status_mismatch',
    ]))
    expect(JSON.stringify(first)).not.toContain('payment-reconciliation-evidence/')
    expect(JSON.stringify(first)).not.toContain('sk_live_reconciliation_secret')

    const ids = first.data.items.map((item: any) => item.id).sort()
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await scanPaymentReconciliationIssues(test.env, 3)
      if (result.next_cursor === '') break
    }
    const replayed = await json(await adminRequest(test, '/reconciliation?page=1&page_size=20'))
    expect(replayed.data.total).toBe(9)
    expect(replayed.data.items.map((item: any) => item.id).sort()).toEqual(ids)

    const filtered = await json(await adminRequest(
      test,
      '/reconciliation?status=open&type=refund_failed&severity=error&source_kind=refund',
    ))
    expect(filtered.data).toMatchObject({ total: 1, page: 1, page_size: 20, pages: 1 })
    expect(filtered.data.items[0]).toMatchObject({
      type: 'refund_failed',
      severity: 'error',
      status: 'open',
      source: { kind: 'refund', id: 'refund-failed' },
      order_id: 'recon-order-refund-failed',
      evidence: { available: true, content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
  })

  it('requires admin access and serves only safe immutable evidence through the guarded route', async () => {
    const test = await fixture()
    insertOrder(test.raw, 'recon-order-late', 'REFUND_REQUESTED', {
      paidAmountMicros: 12_500_000,
      lastError: 'late_payment_requires_refund sk_live_reconciliation_secret',
    })
    await scanToEnd(test.env)

    expect((await bareRequest(test, '/reconciliation')).status).toBe(401)
    expect((await adminRequest(test, '/reconciliation', {}, 'buyer')).status).toBe(403)

    const listed = await json(await adminRequest(test, '/reconciliation'))
    const issueId = listed.data.items[0].id as string
    const detail = await adminRequest(test, `/reconciliation/${issueId}`)
    expect(detail.status).toBe(200)
    expect(detail.headers.get('etag')).toBe('"0"')
    expect((await json(detail)).data).toMatchObject({
      issue: {
        id: issueId,
        type: 'late_paid_refund_required',
        source: { kind: 'order', id: 'recon-order-late' },
      },
      actions: [],
      events: [],
    })

    const evidence = await adminRequest(test, `/reconciliation/${issueId}/evidence`)
    expect(evidence.status).toBe(200)
    const evidenceText = await evidence.text()
    expect(JSON.parse(evidenceText)).toMatchObject({
      schema_version: 1,
      issue_type: 'late_paid_refund_required',
      source: { kind: 'order', id: 'recon-order-late' },
      observation: {
        order_id: 'recon-order-late',
        status: 'REFUND_REQUESTED',
        paid_amount_micros: 12_500_000,
      },
    })
    expect(evidenceText).not.toContain('sk_live_reconciliation_secret')
    expect(evidenceText).not.toContain('payment-reconciliation-evidence/')
  })

  it('applies acknowledge, resolve, and reopen with CAS, idempotency, and immutable audit history', async () => {
    const test = await fixture()
    insertOrder(test.raw, 'recon-order-actions', 'REFUND_REQUESTED', {
      paidAmountMicros: 12_500_000,
      lastError: 'late_payment_requires_refund',
    })
    await scanToEnd(test.env)
    const issueId = (await json(await adminRequest(test, '/reconciliation'))).data.items[0].id

    const acknowledge = () => adminRequest(test, `/reconciliation/${issueId}/acknowledge`, {
      method: 'POST',
      headers: mutationHeaders('reconciliation-acknowledge-0001', 0),
      body: JSON.stringify({ note: 'Investigating with the provider' }),
    })
    const acknowledged = await acknowledge()
    expect(acknowledged.status).toBe(200)
    expect(acknowledged.headers.get('etag')).toBe('"1"')
    expect((await json(acknowledged)).data).toMatchObject({
      id: issueId,
      status: 'acknowledged',
      version: 1,
    })
    const replay = await acknowledge()
    expect(replay.status).toBe(200)
    expect((await json(replay)).data).toMatchObject({ status: 'acknowledged', version: 1 })

    const idempotencyConflict = await adminRequest(
      test,
      `/reconciliation/${issueId}/acknowledge`,
      {
        method: 'POST',
        headers: mutationHeaders('reconciliation-acknowledge-0001', 0),
        body: JSON.stringify({ note: 'different request' }),
      },
    )
    expect(idempotencyConflict.status).toBe(409)
    expect((await json(idempotencyConflict)).code).toBe('idempotency_conflict')

    const stale = await adminRequest(test, `/reconciliation/${issueId}/resolve`, {
      method: 'POST',
      headers: mutationHeaders('reconciliation-stale-version', 0),
      body: JSON.stringify({ resolution_code: 'refunded', note: 'Provider refund settled' }),
    })
    expect(stale.status).toBe(409)
    expect((await json(stale)).code).toBe('payment_reconciliation_issue_changed')

    const resolved = await adminRequest(test, `/reconciliation/${issueId}/resolve`, {
      method: 'POST',
      headers: mutationHeaders('reconciliation-resolve-0001', 1),
      body: JSON.stringify({ resolution_code: 'refunded', note: 'Provider refund settled' }),
    })
    expect(resolved.status).toBe(200)
    expect((await json(resolved)).data).toMatchObject({
      status: 'resolved',
      version: 2,
      resolution: { code: 'refunded', note: 'Provider refund settled' },
    })

    const reopened = await adminRequest(test, `/reconciliation/${issueId}/reopen`, {
      method: 'POST',
      headers: mutationHeaders('reconciliation-reopen-0001', 2),
      body: JSON.stringify({ note: 'Provider settlement reversed' }),
    })
    expect(reopened.status).toBe(200)
    expect((await json(reopened)).data).toMatchObject({ status: 'open', version: 3 })

    const detail = await json(await adminRequest(test, `/reconciliation/${issueId}`))
    expect(detail.data.actions.map((action: any) => action.action)).toEqual([
      'reopen', 'resolve', 'acknowledge',
    ])
    expect(detail.data.events.map((event: any) => event.to_status)).toEqual([
      'open', 'resolved', 'acknowledged',
    ])
    expect(test.raw.prepare(
      `SELECT status, version FROM payment_orders WHERE id = 'recon-order-actions'`,
    ).get()).toEqual({ status: 'REFUND_REQUESTED', version: 0 })
  })

  it('lets only one of two concurrent actions win the expected issue version', async () => {
    const test = await fixture()
    insertOrder(test.raw, 'recon-order-race', 'REFUND_REQUESTED', {
      paidAmountMicros: 12_500_000,
      lastError: 'late_payment_requires_refund',
    })
    await scanToEnd(test.env)
    const issueId = (await json(await adminRequest(test, '/reconciliation'))).data.items[0].id

    const responses = await Promise.all([
      adminRequest(test, `/reconciliation/${issueId}/acknowledge`, {
        method: 'POST',
        headers: mutationHeaders('reconciliation-race-action-a', 0),
        body: JSON.stringify({ note: 'operator A' }),
      }),
      adminRequest(test, `/reconciliation/${issueId}/acknowledge`, {
        method: 'POST',
        headers: mutationHeaders('reconciliation-race-action-b', 0),
        body: JSON.stringify({ note: 'operator B' }),
      }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
  })
})

function reconciliationApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/reconciliation', listAdminPaymentReconciliationIssues)
  app.get('/reconciliation/:id', getAdminPaymentReconciliationIssue)
  app.get('/reconciliation/:id/evidence', downloadAdminPaymentReconciliationEvidence)
  app.post('/reconciliation/:id/:action', actOnAdminPaymentReconciliationIssue)
  return app
}

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  for (const [id, email, role] of [
    [ADMIN, 'admin@example.test', 'admin'],
    [BUYER, 'buyer@example.test', 'user'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email, id, role, NOW - DAY_MS, NOW - DAY_MS)
  }
  raw.prepare(
    `INSERT INTO payment_provider_instances (
       id, provider_key, provider_type, display_name, config_ciphertext,
       config_nonce, config_key_id, enabled, version, created_at_ms, updated_at_ms
     ) VALUES (?, 'stripe-primary', 'stripe', 'Stripe safe', ?, 'nonce', 'key', 1, 0, ?, ?)`,
  ).run(PROVIDER, 'sk_live_reconciliation_secret', NOW - DAY_MS, NOW - DAY_MS)

  const authorization = {} as Fixture['authorization']
  for (const [actor, userId] of [['admin', ADMIN], ['buyer', BUYER]] as const) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `reconciliation-session-${actor}`,
      `reconciliation-family-${actor}`,
      userId,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      NOW - 1_000,
      NOW + DAY_MS,
      NOW + 30 * DAY_MS,
    )
    authorization[actor] = `Bearer ${access}`
  }

  const bucket = new EvidenceBucket()
  return {
    raw,
    bucket,
    authorization,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: {} as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: bucket.bucket(),
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function seedAnomalies(raw: any): void {
  insertOrder(raw, 'recon-order-late', 'REFUND_REQUESTED', {
    paidAmountMicros: 12_500_000,
    lastError: 'late_payment_requires_refund',
  })
  insertOrder(raw, 'recon-order-amount', 'PAID', { paidAmountMicros: 11_000_000 })
  insertOrder(raw, 'recon-order-status', 'COMPLETED', { paidAmountMicros: 0, paidAt: null })
  insertOrder(raw, 'recon-order-fulfillment-pending', 'PAID')
  insertOrder(raw, 'recon-order-fulfillment-failed', 'FAILED')
  insertOrder(raw, 'recon-order-refund-pending', 'REFUND_PENDING')
  insertOrder(raw, 'recon-order-refund-failed', 'REFUND_FAILED')

  raw.prepare(
    `INSERT INTO payment_webhook_inbox (
       id, provider_key, provider_event_id, event_type, payload_sha256,
       payload_r2_key, status, attempts, available_at_ms,
       received_at_ms, updated_at_ms
     ) VALUES
       ('webhook-pending', 'stripe-primary', 'evt-pending', 'checkout.session.completed',
        ?, 'private/webhook-pending', 'received', 0, ?, ?, ?),
       ('webhook-failed', 'stripe-primary', 'evt-failed', 'checkout.session.completed',
        ?, 'private/webhook-failed', 'failed', 3, ?, ?, ?)`,
  ).run(
    '1'.repeat(64), NOW - DAY_MS, NOW - DAY_MS, NOW - DAY_MS,
    '2'.repeat(64), NOW - DAY_MS, NOW - DAY_MS, NOW - DAY_MS,
  )
  raw.prepare(
    `INSERT INTO payment_fulfillments (
       id, order_id, action, status, attempts, available_at_ms,
       last_error, created_at_ms, updated_at_ms
     ) VALUES
       ('fulfillment-pending', 'recon-order-fulfillment-pending',
        'subscription_entitlement', 'pending', 0, ?, NULL, ?, ?),
       ('fulfillment-failed', 'recon-order-fulfillment-failed',
        'subscription_entitlement', 'failed', 3, ?,
        'failed with sk_live_reconciliation_secret', ?, ?)`,
  ).run(
    NOW - DAY_MS, NOW - DAY_MS, NOW - DAY_MS,
    NOW - DAY_MS, NOW - DAY_MS, NOW - DAY_MS,
  )
  for (const [id, orderId, status] of [
    ['refund-pending', 'recon-order-refund-pending', 'pending'],
    ['refund-failed', 'recon-order-refund-failed', 'failed'],
  ] as const) {
    raw.prepare(
      `INSERT INTO payment_refunds (
         id, order_id, request_key_hash, provider_key, provider_refund_id,
         amount_micros, settled_amount_micros, currency, status, reason,
         last_error, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'stripe-primary', ?, 12500000, 0, 'USD', ?,
                 'requested', 'sk_live_reconciliation_secret', ?, ?)`,
    ).run(
      id,
      orderId,
      id.padEnd(64, 'f').slice(0, 64),
      `provider-${id}`,
      status,
      NOW - DAY_MS,
      NOW - DAY_MS,
    )
  }
}

function insertOrder(
  raw: any,
  id: string,
  status: string,
  options: {
    paidAmountMicros?: number
    paidAt?: number | null
    lastError?: string | null
  } = {},
): void {
  const paidAmount = options.paidAmountMicros ?? 12_500_000
  const paidAt = options.paidAt === undefined
    ? paidAmount > 0 ? NOW - DAY_MS : null
    : options.paidAt
  raw.prepare(
    `INSERT INTO payment_orders (
       id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
       idempotency_key_hash, request_hash, provider_order_id, payment_intent_id,
       payment_trade_no, order_type, status, amount_micros, pay_amount_micros,
       paid_amount_micros, refunded_amount_micros, currency, last_error, version,
       expires_at_ms, paid_at_ms, created_at_ms, updated_at_ms
     ) VALUES (
       ?, ?, ?, 'stripe-primary', ?, ?, ?, ?, ?, ?, 'balance', ?,
       12500000, 12500000, ?, 0, 'USD', ?, 0, ?, ?, ?, ?
     )`,
  ).run(
    id,
    BUYER,
    PROVIDER,
    `trade-${id}`,
    id.padEnd(64, 'a').slice(0, 64),
    id.padEnd(64, 'b').slice(0, 64),
    `checkout-${id}`,
    `intent-${id}`,
    `provider-trade-${id}`,
    status,
    paidAmount,
    options.lastError ?? null,
    NOW + DAY_MS,
    paidAt,
    NOW - DAY_MS,
    NOW - DAY_MS,
  )
}

async function scanToEnd(env: Env): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await scanPaymentReconciliationIssues(env, 25)).next_cursor === '') return
  }
  throw new Error('scanner did not reach the end')
}

async function bareRequest(test: Fixture, path: string): Promise<Response> {
  return reconciliationApp().request(path, {}, test.env)
}

async function adminRequest(
  test: Fixture,
  path: string,
  init: RequestInit = {},
  actor: keyof Fixture['authorization'] = 'admin',
): Promise<Response> {
  return reconciliationApp().request(path, {
    ...init,
    headers: {
      authorization: test.authorization[actor],
      ...init.headers,
    },
  }, test.env)
}

function mutationHeaders(key: string, version: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': key,
    'if-match': `"${version}"`,
  }
}

async function json(response: Response): Promise<any> {
  return response.json()
}
