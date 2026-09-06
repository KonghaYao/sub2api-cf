const DEFAULT_API_BASE = 'https://api.stripe.com/v1'
const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300
const MAX_SIGNATURE_HEADER_LENGTH = 8_192

type StripeErrorCode =
  | 'stripe_request_failed'
  | 'stripe_response_invalid'
  | 'stripe_unavailable'

export class StripeAdapterError extends Error {
  readonly code: StripeErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly providerStatus?: number

  constructor(
    message: string,
    options: {
      code: StripeErrorCode
      status: number
      retryable: boolean
      providerStatus?: number
    },
  ) {
    super(message)
    this.name = 'StripeAdapterError'
    this.code = options.code
    this.status = options.status
    this.retryable = options.retryable
    this.providerStatus = options.providerStatus
  }
}

export interface StripeWebhookVerificationInput {
  rawBody: string | Uint8Array
  signatureHeader: string
  webhookSecret: string
  nowMs?: number
  toleranceSeconds?: number
}

/**
 * Verify Stripe's `t=...,v1=...` webhook signature against the exact request
 * body. Callers must pass the body before JSON parsing or normalization.
 */
export async function verifyStripeWebhookSignature(
  input: StripeWebhookVerificationInput,
): Promise<boolean> {
  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS
  const nowMs = input.nowMs ?? Date.now()
  if (
    input.webhookSecret.length === 0 ||
    input.signatureHeader.length === 0 ||
    input.signatureHeader.length > MAX_SIGNATURE_HEADER_LENGTH ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  ) {
    return false
  }

  const parsed = parseSignatureHeader(input.signatureHeader)
  if (!parsed) return false

  const nowSeconds = Math.floor(nowMs / 1000)
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) return false

  const encoder = new TextEncoder()
  const bodyBytes =
    typeof input.rawBody === 'string' ? encoder.encode(input.rawBody) : input.rawBody
  const prefixBytes = encoder.encode(`${parsed.timestamp}.`)
  const signedPayload = new Uint8Array(prefixBytes.length + bodyBytes.length)
  signedPayload.set(prefixBytes)
  signedPayload.set(bodyBytes, prefixBytes.length)

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, signedPayload)
  const expected = bytesToHex(new Uint8Array(digest))

  // Compare every supplied v1 value so the position of a matching signature
  // does not change the work performed during key rotation.
  let matched = false
  for (const candidate of parsed.v1Signatures) {
    matched = constantTimeEqual(expected, candidate.toLowerCase()) || matched
  }
  return matched
}

interface ParsedSignatureHeader {
  timestamp: number
  v1Signatures: string[]
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | undefined
  const v1Signatures: string[] = []

  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()

    if (key === 't') {
      if (timestamp !== undefined || !/^\d+$/.test(value)) return null
      const parsedTimestamp = Number(value)
      if (!Number.isSafeInteger(parsedTimestamp) || parsedTimestamp < 0) return null
      timestamp = parsedTimestamp
    } else if (key === 'v1' && /^[a-fA-F0-9]{64}$/.test(value)) {
      v1Signatures.push(value)
    }
  }

  if (timestamp === undefined || v1Signatures.length === 0) return null
  return { timestamp, v1Signatures }
}

function bytesToHex(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

export interface StripeClientOptions {
  secretKey: string
  apiBase?: string
  fetch?: typeof fetch
}

export interface StripeCreateCheckoutSessionInput {
  orderId: string
  amountMinor: number
  currency: string
  productName: string
  successUrl: string
  cancelUrl: string
  /** Unix timestamp in seconds. Stripe currently accepts 30 minutes to 24 hours. */
  expiresAtSeconds: number
  paymentMethodTypes?: string[]
}

export interface StripeCheckoutSession {
  id: string
  object: 'checkout.session'
  status: 'open' | 'complete' | 'expired'
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required'
  amountTotal: number
  currency: string
  url: string | null
  paymentIntentId: string | null
}

export interface StripeCreateRefundInput {
  orderId: string
  refundId: string
  idempotencyKey: string
  paymentIntentId: string
  amountMinor: number
}

export interface StripeRefund {
  id: string
  object: 'refund'
  amount: number
  currency: string
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled'
  paymentIntentId: string
}

export class StripeClient {
  private readonly secretKey: string
  private readonly apiBase: string
  private readonly fetchImplementation: typeof fetch

  constructor(options: StripeClientOptions) {
    assertHeaderValue(options.secretKey, 'secretKey')
    this.secretKey = options.secretKey
    this.apiBase = normalizeApiBase(options.apiBase ?? DEFAULT_API_BASE)
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async createCheckoutSession(
    input: StripeCreateCheckoutSessionInput,
  ): Promise<StripeCheckoutSession> {
    assertIdentifier(input.orderId, 'orderId')
    assertPositiveMinorAmount(input.amountMinor)
    const currency = normalizeCurrency(input.currency)
    assertNonEmpty(input.productName, 'productName', 500)
    assertHttpUrl(input.successUrl, 'successUrl')
    assertHttpUrl(input.cancelUrl, 'cancelUrl')
    assertPositiveSafeInteger(input.expiresAtSeconds, 'expiresAtSeconds')

    const form = new URLSearchParams({
      mode: 'payment',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: String(input.expiresAtSeconds),
      client_reference_id: input.orderId,
      'metadata[order_id]': input.orderId,
      'payment_intent_data[metadata][order_id]': input.orderId,
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': String(input.amountMinor),
      'line_items[0][price_data][product_data][name]': input.productName,
      'line_items[0][quantity]': '1',
    })
    for (const [index, method] of (input.paymentMethodTypes ?? []).entries()) {
      assertIdentifier(method, `paymentMethodTypes[${index}]`)
      form.set(`payment_method_types[${index}]`, method)
    }

    return this.request(
      '/checkout/sessions',
      {
        method: 'POST',
        headers: this.headers(`checkout-${input.orderId}`, true),
        body: form.toString(),
      },
      parseCheckoutSession,
    )
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
    assertIdentifier(sessionId, 'sessionId')
    return this.request(
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET', headers: this.headers() },
      parseCheckoutSession,
    )
  }

  async expireCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
    assertIdentifier(sessionId, 'sessionId')
    return this.request(
      `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      {
        method: 'POST',
        headers: this.headers(`expire-${sessionId}`, true),
        body: '',
      },
      parseCheckoutSession,
    )
  }

  async createRefund(input: StripeCreateRefundInput): Promise<StripeRefund> {
    assertIdentifier(input.orderId, 'orderId')
    assertIdentifier(input.refundId, 'refundId')
    assertIdentifier(input.idempotencyKey, 'idempotencyKey')
    assertIdentifier(input.paymentIntentId, 'paymentIntentId')
    assertPositiveMinorAmount(input.amountMinor)
    const form = new URLSearchParams({
      payment_intent: input.paymentIntentId,
      amount: String(input.amountMinor),
      'metadata[order_id]': input.orderId,
      'metadata[refund_id]': input.refundId,
    })

    return this.request(
      '/refunds',
      {
        method: 'POST',
        headers: this.headers(input.idempotencyKey, true),
        body: form.toString(),
      },
      parseRefund,
    )
  }

  async retrieveRefund(refundId: string): Promise<StripeRefund> {
    assertIdentifier(refundId, 'refundId')
    return this.request(
      `/refunds/${encodeURIComponent(refundId)}`,
      { method: 'GET', headers: this.headers() },
      parseRefund,
    )
  }

  private headers(idempotencyKey?: string, formEncoded = false): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
    }
    if (formEncoded) headers['content-type'] = 'application/x-www-form-urlencoded'
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    return headers
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImplementation(`${this.apiBase}${path}`, init)
    } catch {
      throw new StripeAdapterError('Stripe is temporarily unavailable', {
        code: 'stripe_unavailable',
        status: 503,
        retryable: true,
      })
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      throw new StripeAdapterError('Stripe request failed', {
        code: 'stripe_request_failed',
        status: retryable ? 503 : 502,
        retryable,
        providerStatus: response.status,
      })
    }

    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw invalidResponseError()
    }

    try {
      return parse(value)
    } catch (error) {
      if (error instanceof StripeAdapterError) throw error
      throw invalidResponseError()
    }
  }
}

function parseCheckoutSession(value: unknown): StripeCheckoutSession {
  const record = requireRecord(value)
  requireLiteral(record.object, 'checkout.session')
  const status = requireOneOf(record.status, ['open', 'complete', 'expired'] as const)
  const paymentStatus = requireOneOf(record.payment_status, [
    'paid',
    'unpaid',
    'no_payment_required',
  ] as const)

  return {
    id: requireString(record.id),
    object: 'checkout.session',
    status,
    paymentStatus,
    amountTotal: requireNonNegativeInteger(record.amount_total),
    currency: requireCurrency(record.currency),
    url: requireNullableString(record.url),
    paymentIntentId: requireNullableString(record.payment_intent),
  }
}

function parseRefund(value: unknown): StripeRefund {
  const record = requireRecord(value)
  requireLiteral(record.object, 'refund')
  const status = requireOneOf(record.status, [
    'pending',
    'requires_action',
    'succeeded',
    'failed',
    'canceled',
  ] as const)

  return {
    id: requireString(record.id),
    object: 'refund',
    amount: requireNonNegativeInteger(record.amount),
    currency: requireCurrency(record.currency),
    status,
    paymentIntentId: requireString(record.payment_intent),
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
  return value as Record<string, unknown>
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error()
  return value
}

function requireNullableString(value: unknown): string | null {
  if (value === null) return null
  return requireString(value)
}

function requireNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error()
  return value as number
}

function requireCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z]{3}$/.test(value)) throw new Error()
  return value
}

function requireLiteral<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) throw new Error()
  return expected
}

function requireOneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error()
  return value as T[number]
}

function invalidResponseError(): StripeAdapterError {
  return new StripeAdapterError('Stripe returned an invalid response', {
    code: 'stripe_response_invalid',
    status: 502,
    retryable: false,
  })
}

function assertPositiveMinorAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('amountMinor must be a positive safe integer')
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
}

function assertNonEmpty(value: string, field: string, maxLength = 200): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} is invalid`)
  }
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new TypeError(`${field} is invalid`)
  }
}

function assertHeaderValue(value: string, field: string): void {
  assertNonEmpty(value, field, 500)
  if (/[\r\n]/.test(value)) throw new TypeError(`${field} is invalid`)
}

function normalizeCurrency(currency: string): string {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new TypeError('currency must be a three-letter code')
  }
  return currency.toLowerCase()
}

function assertHttpUrl(value: string, field: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`${field} must be an absolute HTTP URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError(`${field} must be an absolute HTTP URL`)
  }
}

function normalizeApiBase(value: string): string {
  assertHttpUrl(value, 'apiBase')
  return value.replace(/\/+$/, '')
}
