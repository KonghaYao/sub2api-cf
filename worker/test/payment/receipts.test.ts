import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import {
  downloadMyPaymentReceipt,
  getMyPaymentReceipt,
} from '../../src/payment/receipts'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.UTC(2026, 8, 5, 8, 0)
const DAY_MS = 86_400_000
const PEPPER = 'payment-receipt-test-pepper-at-least-32-bytes'
const BUYER = 'receipt-buyer'
const OTHER = 'receipt-other'
const PROVIDER = 'receipt-provider'

interface Fixture {
  raw: any
  env: Env
  bucket: MemoryBucket
  authorization: Record<'buyer' | 'other', string>
}

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>()
  readonly puts: string[] = []
  failPuts = 0

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob): Promise<any> {
    this.puts.push(key)
    if (this.failPuts > 0) {
      this.failPuts -= 1
      throw new Error('simulated R2 outage containing sk_live_should_not_leak')
    }
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
    return {
      key,
      size: bytes.byteLength,
      body: new Blob([
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ]).stream(),
    }
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

describe('payment receipt HTTP contract', () => {
  it('generates and downloads a paid receipt only for its owner without exposing private keys or secrets', async () => {
    const test = await fixture()
    insertOrder(test.raw, 'receipt-order-paid', 'COMPLETED', BUYER)

    const metadata = await request(test, 'buyer', '/orders/receipt-order-paid/receipt')
    expect(metadata.status).toBe(200)
    const metadataJson = await json(metadata)
    expect(metadataJson.data).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      order_id: 'receipt-order-paid',
      order_version: 3,
      status: 'available',
      content_type: 'application/json',
      content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      content_length: expect.any(Number),
      download_url: '/api/v1/payment/orders/receipt-order-paid/receipt/download',
    })
    expect(JSON.stringify(metadataJson)).not.toContain('payment-receipts/')
    expect(JSON.stringify(metadataJson)).not.toContain('sk_live_should_not_leak')

    const forbidden = await request(test, 'other', '/orders/receipt-order-paid/receipt')
    expect(forbidden.status).toBe(404)

    const download = await request(test, 'buyer', '/orders/receipt-order-paid/receipt/download')
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/json')
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="receipt-[0-9a-f-]+\.json"$/)
    const receipt = await download.json() as any
    expect(receipt).toMatchObject({
      schema_version: 1,
      receipt_id: metadataJson.data.id,
      order: {
        id: 'receipt-order-paid',
        out_trade_no: 'trade-receipt-order-paid',
        status: 'COMPLETED',
        amount_micros: 12_500_000,
        paid_amount_micros: 12_500_000,
        refunded_amount_micros: 0,
        currency: 'USD',
      },
      customer: { id: BUYER, email: 'buyer@example.test', display_name: 'Buyer' },
      provider: { key: 'stripe-primary', type: 'stripe', name: 'Stripe safe name' },
    })
    expect(JSON.stringify(receipt)).not.toContain('sk_live_should_not_leak')
    expect(JSON.stringify(receipt)).not.toContain('payment-receipts/')
  })

  it('does not issue a receipt for an unpaid order', async () => {
    const test = await fixture()
    insertOrder(test.raw, 'receipt-order-unpaid', 'PENDING', BUYER)

    const response = await request(test, 'buyer', '/orders/receipt-order-unpaid/receipt')
    expect(response.status).toBe(409)
    expect((await json(response)).code).toBe('payment_receipt_not_available')
    expect(test.bucket.puts).toHaveLength(0)

    insertOrder(test.raw, 'receipt-order-inconsistent', 'PENDING', BUYER)
    test.raw.prepare(
      `UPDATE payment_orders
          SET paid_amount_micros = 12500000, paid_at_ms = ?
        WHERE id = 'receipt-order-inconsistent'`,
    ).run(NOW - 1_000)
    const inconsistent = await request(
      test,
      'buyer',
      '/orders/receipt-order-inconsistent/receipt',
    )
    expect(inconsistent.status).toBe(409)
    expect((await json(inconsistent)).code).toBe('payment_receipt_not_available')
  })

  it('retries an R2 failure and concurrent requests converge on one logical receipt', async () => {
    const test = await fixture()
    insertOrder(test.raw, 'receipt-order-retry', 'REFUNDED', BUYER, {
      refundedAmountMicros: 12_500_000,
      version: 7,
    })
    test.bucket.failPuts = 1

    const failed = await request(test, 'buyer', '/orders/receipt-order-retry/receipt')
    expect(failed.status).toBe(503)
    const failedBody = await json(failed)
    expect(failedBody).toMatchObject({ code: 'payment_receipt_storage_unavailable' })
    expect(JSON.stringify(failedBody)).not.toContain('sk_live_should_not_leak')

    const [first, second] = await Promise.all([
      request(test, 'buyer', '/orders/receipt-order-retry/receipt'),
      request(test, 'buyer', '/orders/receipt-order-retry/receipt'),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const [firstBody, secondBody] = await Promise.all([json(first), json(second)])
    expect(firstBody.data.id).toBe(secondBody.data.id)
    expect(firstBody.data.content_sha256).toBe(secondBody.data.content_sha256)
    expect(new Set(test.bucket.puts).size).toBe(1)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM payment_receipts WHERE order_id = ? AND order_version = 7`,
    ).get('receipt-order-retry')).toEqual({ count: 1 })
  })
})

function receiptApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/orders/:id/receipt', getMyPaymentReceipt)
  app.get('/orders/:id/receipt/download', downloadMyPaymentReceipt)
  return app
}

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  for (const [id, email, name] of [
    [BUYER, 'buyer@example.test', 'Buyer'],
    [OTHER, 'other@example.test', 'Other'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'user', ?, ?)`,
    ).run(id, email, name, NOW - DAY_MS, NOW - DAY_MS)
  }
  raw.prepare(
    `INSERT INTO payment_provider_instances (
       id, provider_key, provider_type, display_name, config_ciphertext,
       config_nonce, config_key_id, enabled, version, created_at_ms, updated_at_ms
     ) VALUES (?, 'stripe-primary', 'stripe', 'Stripe safe name', ?, ?, ?, 1, 0, ?, ?)`,
  ).run(
    PROVIDER,
    'encrypted-sk_live_should_not_leak',
    'secret-nonce-should-not-leak',
    'secret-key-id-should-not-leak',
    NOW - DAY_MS,
    NOW - DAY_MS,
  )

  const authorization = {} as Fixture['authorization']
  for (const [actor, userId] of [['buyer', BUYER], ['other', OTHER]] as const) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `receipt-session-${actor}`,
      `receipt-family-${actor}`,
      userId,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      NOW - 1_000,
      NOW + DAY_MS,
      NOW + 30 * DAY_MS,
    )
    authorization[actor] = `Bearer ${access}`
  }

  const bucket = new MemoryBucket()
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

function insertOrder(
  raw: any,
  id: string,
  status: string,
  userId: string,
  options: { refundedAmountMicros?: number; version?: number } = {},
): void {
  const paid = status === 'PENDING' ? null : NOW - 2_000
  raw.prepare(
    `INSERT INTO payment_orders (
       id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
       idempotency_key_hash, request_hash, provider_order_id, payment_intent_id,
       payment_trade_no, order_type, status, amount_micros, pay_amount_micros,
       paid_amount_micros, refunded_amount_micros, currency, version,
       expires_at_ms, paid_at_ms, completed_at_ms, refund_requested_at_ms,
       refund_completed_at_ms, created_at_ms, updated_at_ms
     ) VALUES (
       ?, ?, ?, 'stripe-primary', ?, ?, ?, ?, ?, ?, 'balance', ?,
       12500000, 12500000, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    id,
    userId,
    PROVIDER,
    `trade-${id}`,
    id.padEnd(64, 'a').slice(0, 64),
    'b'.repeat(64),
    `checkout-${id}`,
    `intent-${id}`,
    `trade-provider-${id}`,
    status,
    paid === null ? 0 : 12_500_000,
    options.refundedAmountMicros ?? 0,
    options.version ?? 3,
    NOW + DAY_MS,
    paid,
    status === 'COMPLETED' ? NOW - 1_000 : null,
    status.includes('REFUND') ? NOW - 1_000 : null,
    status === 'REFUNDED' ? NOW : null,
    NOW - DAY_MS,
    NOW,
  )
}

async function request(
  test: Fixture,
  actor: keyof Fixture['authorization'],
  path: string,
): Promise<Response> {
  return receiptApp().request(path, {
    headers: { authorization: test.authorization[actor] },
  }, test.env)
}

async function json(response: Response): Promise<any> {
  return response.json()
}
