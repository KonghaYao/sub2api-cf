import type { Context } from 'hono'

import { authenticateUserRequest, type UserRow } from '../auth/handler'
import { controlError, controlSuccess, requireResourceId } from '../control/http'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { findOrder, type PaymentOrderRow } from './orders'

type PaymentBindings = { Bindings: Env }

const RECEIPT_CONTENT_TYPE = 'application/json'
const MAX_RECEIPT_BYTES = 1024 * 1024
const RECEIPT_ELIGIBLE_STATUSES = new Set([
  'PAID',
  'RECHARGING',
  'COMPLETED',
  'REFUND_REQUESTED',
  'REFUNDING',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REFUND_FAILED',
])

interface ReceiptRow {
  id: string
  order_id: string
  order_version: number
  status: 'pending' | 'available' | 'failed'
  content_type: typeof RECEIPT_CONTENT_TYPE | 'text/html; charset=utf-8' | null
  content_sha256: string | null
  content_length: number | null
  r2_key: string | null
  attempts: number
  last_error_code: string | null
  created_at_ms: number
  updated_at_ms: number
  available_at_ms: number | null
}

interface ProviderReceiptRow {
  provider_key: string
  provider_type: string
  display_name: string
}

/** GET /api/v1/payment/orders/:id/receipt */
export async function getMyPaymentReceipt(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    const receipt = await ensureReceipt(context.env, user, orderId)
    return receiptSuccess(receipt, orderId)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** GET /api/v1/payment/orders/:id/receipt/download */
export async function downloadMyPaymentReceipt(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const orderId = requireResourceId(context.req.param('id'), 'payment_order')
    const receipt = await ensureReceipt(context.env, user, orderId)
    if (
      receipt.status !== 'available' || receipt.r2_key === null ||
      receipt.content_type === null || receipt.content_sha256 === null
    ) throw receiptUnavailable()

    const object = await context.env.OBJECTS.get(receipt.r2_key)
    if (object === null) {
      throw new GatewayError(
        503,
        'payment_receipt_storage_unavailable',
        'Payment receipt storage is temporarily unavailable',
        'server_error',
      )
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': receipt.content_type,
        'content-disposition': `attachment; filename="receipt-${receipt.id}.json"`,
        etag: `"${receipt.content_sha256}"`,
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function ensureReceipt(
  env: Env,
  user: UserRow,
  orderId: string,
): Promise<ReceiptRow> {
  const order = await findOrder(env, orderId, user.id)
  if (order === null) {
    throw new GatewayError(404, 'payment_order_not_found', 'Payment order was not found')
  }
  if (
    !RECEIPT_ELIGIBLE_STATUSES.has(order.status) ||
    order.paid_at_ms === null ||
    order.paid_amount_micros <= 0
  ) {
    throw receiptUnavailable()
  }

  let receipt = await findReceipt(env, order.id, order.version)
  if (receipt === null) {
    const now = Date.now()
    await env.DB.prepare(
      `INSERT OR IGNORE INTO payment_receipts (
         id, order_id, order_version, status, attempts,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    ).bind(crypto.randomUUID(), order.id, order.version, now, now).run()
    receipt = await findReceipt(env, order.id, order.version)
    if (receipt === null) {
      throw new GatewayError(
        409,
        'payment_receipt_creation_conflict',
        'Payment receipt could not be created; retry the request',
      )
    }
  }
  if (receipt.status === 'available') return receipt
  return materializeReceipt(env, user, order, receipt)
}

async function materializeReceipt(
  env: Env,
  user: UserRow,
  order: PaymentOrderRow,
  receipt: ReceiptRow,
): Promise<ReceiptRow> {
  const current = await findOrder(env, order.id, user.id)
  if (current === null) {
    throw new GatewayError(404, 'payment_order_not_found', 'Payment order was not found')
  }
  if (current.version !== receipt.order_version) {
    throw new GatewayError(
      409,
      'payment_receipt_order_changed',
      'Payment order changed while its receipt was generated; retry the request',
    )
  }
  const provider = await env.DB.prepare(
    `SELECT provider_key, provider_type, display_name
       FROM payment_provider_instances WHERE id = ?`,
  ).bind(current.provider_instance_id).first<ProviderReceiptRow>()
  if (provider === null) {
    throw new GatewayError(
      503,
      'payment_receipt_provider_unavailable',
      'Payment receipt provider metadata is unavailable',
      'server_error',
    )
  }

  const content = renderReceipt(receipt, current, user, provider)
  const bytes = new TextEncoder().encode(content)
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new GatewayError(
      500,
      'payment_receipt_too_large',
      'Payment receipt exceeded the storage limit',
      'server_error',
    )
  }
  const digest = await sha256Hex(content)
  const objectKey = `payment-receipts/v1/${receipt.id}/${digest}.json`
  try {
    await env.OBJECTS.put(objectKey, content, {
      httpMetadata: { contentType: RECEIPT_CONTENT_TYPE },
      customMetadata: { schema_version: '1', receipt_id: receipt.id },
    })
  } catch (error) {
    console.error('payment receipt R2 write failed', {
      name: error instanceof Error ? error.name : 'unknown',
    })
    const failedAt = Date.now()
    await env.DB.prepare(
      `UPDATE payment_receipts
          SET status = 'failed', attempts = attempts + 1,
              last_error_code = 'r2_write_failed', updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND order_id = ? AND order_version = ?
          AND status IN ('pending', 'failed')`,
    ).bind(failedAt, receipt.id, current.id, current.version).run()
    throw new GatewayError(
      503,
      'payment_receipt_storage_unavailable',
      'Payment receipt storage is temporarily unavailable',
      'server_error',
    )
  }

  const availableAt = Date.now()
  await env.DB.prepare(
    `UPDATE payment_receipts
        SET status = 'available', content_type = ?, content_sha256 = ?,
            content_length = ?, r2_key = ?, attempts = attempts + 1,
            last_error_code = NULL, available_at_ms = ?,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ? AND order_id = ? AND order_version = ?
        AND status IN ('pending', 'failed')`,
  ).bind(
    RECEIPT_CONTENT_TYPE,
    digest,
    bytes.byteLength,
    objectKey,
    availableAt,
    availableAt,
    receipt.id,
    current.id,
    current.version,
  ).run()
  const persisted = await findReceipt(env, current.id, current.version)
  if (persisted?.status !== 'available') {
    throw new GatewayError(
      409,
      'payment_receipt_creation_conflict',
      'Payment receipt could not be finalized; retry the request',
    )
  }
  return persisted
}

function renderReceipt(
  receipt: ReceiptRow,
  order: PaymentOrderRow,
  user: UserRow,
  provider: ProviderReceiptRow,
): string {
  return `${JSON.stringify({
    schema_version: 1,
    receipt_id: receipt.id,
    issued_at: iso(receipt.created_at_ms),
    order: {
      id: order.id,
      out_trade_no: order.out_trade_no,
      type: order.order_type,
      status: order.status,
      amount_micros: order.amount_micros,
      pay_amount_micros: order.pay_amount_micros,
      paid_amount_micros: order.paid_amount_micros,
      refunded_amount_micros: order.refunded_amount_micros,
      currency: order.currency,
      paid_at: order.paid_at_ms === null ? null : iso(order.paid_at_ms),
      refund_completed_at: order.refund_completed_at_ms === null
        ? null
        : iso(order.refund_completed_at_ms),
    },
    customer: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
    },
    provider: {
      key: provider.provider_key,
      type: provider.provider_type,
      name: provider.display_name,
    },
  }, null, 2)}\n`
}

async function findReceipt(
  env: Env,
  orderId: string,
  orderVersion: number,
): Promise<ReceiptRow | null> {
  return env.DB.prepare(
    `SELECT id, order_id, order_version, status, content_type,
            content_sha256, content_length, r2_key, attempts,
            last_error_code, created_at_ms, updated_at_ms, available_at_ms
       FROM payment_receipts
      WHERE order_id = ? AND order_version = ?`,
  ).bind(orderId, orderVersion).first<ReceiptRow>()
}

function receiptSuccess(receipt: ReceiptRow, orderId: string): Response {
  if (
    receipt.status !== 'available' || receipt.content_type === null ||
    receipt.content_sha256 === null || receipt.content_length === null ||
    receipt.available_at_ms === null
  ) throw receiptUnavailable()
  const response = controlSuccess({
    id: receipt.id,
    order_id: receipt.order_id,
    order_version: receipt.order_version,
    status: receipt.status,
    content_type: receipt.content_type,
    content_sha256: receipt.content_sha256,
    content_length: receipt.content_length,
    issued_at: iso(receipt.created_at_ms),
    available_at: iso(receipt.available_at_ms),
    download_url: `/api/v1/payment/orders/${encodeURIComponent(orderId)}/receipt/download`,
  })
  response.headers.set('etag', `"${receipt.content_sha256}"`)
  return response
}

function receiptUnavailable(): GatewayError {
  return new GatewayError(
    409,
    'payment_receipt_not_available',
    'A receipt is available only after payment has been collected',
  )
}

function iso(value: number): string {
  return new Date(value).toISOString()
}
