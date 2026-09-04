import { describe, expect, it, vi } from 'vitest'

import {
  StripeAdapterError,
  StripeClient,
  verifyStripeWebhookSignature,
} from '../../src/payment/stripe'

const validSession = {
  id: 'cs_test_123',
  object: 'checkout.session',
  status: 'open',
  payment_status: 'unpaid',
  amount_total: 1299,
  currency: 'usd',
  url: 'https://checkout.stripe.com/c/pay/cs_test_123',
  payment_intent: null,
}

const validRefund = {
  id: 're_test_123',
  object: 'refund',
  amount: 499,
  currency: 'usd',
  status: 'succeeded',
  payment_intent: 'pi_test_123',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('verifyStripeWebhookSignature', () => {
  const rawBody = '{"id":"evt_1","object":"event"}'
  const timestamp = 1_778_241_600
  const signature = 'da8c23d6e0ee8f84d306ef350fbad8a90ca975f426e5a8e54280dce2e42da0be'

  it('accepts any matching v1 signature over the exact raw body', async () => {
    await expect(
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader: `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`,
        webhookSecret: 'whsec_test_secret',
        nowMs: timestamp * 1000,
      }),
    ).resolves.toBe(true)
  })

  it('rejects a changed raw body and timestamps beyond the default 300 second tolerance', async () => {
    await expect(
      verifyStripeWebhookSignature({
        rawBody: `${rawBody}\n`,
        signatureHeader: `t=${timestamp},v1=${signature}`,
        webhookSecret: 'whsec_test_secret',
        nowMs: timestamp * 1000,
      }),
    ).resolves.toBe(false)

    await expect(
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader: `t=${timestamp},v1=${signature}`,
        webhookSecret: 'whsec_test_secret',
        nowMs: (timestamp + 301) * 1000,
      }),
    ).resolves.toBe(false)
  })

  it('rejects malformed signature headers without throwing', async () => {
    await expect(
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader: 'v1=not-hex,t=not-a-number',
        webhookSecret: 'whsec_test_secret',
        nowMs: timestamp * 1000,
      }),
    ).resolves.toBe(false)
  })
})

describe('StripeClient checkout sessions', () => {
  it('creates a session with form encoding, bearer auth, and a stable order idempotency key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(validSession))
    const stripe = new StripeClient({ secretKey: 'sk_test_secret', fetch: fetchMock })
    const input = {
      orderId: 'order-42',
      amountMinor: 1299,
      currency: 'USD',
      productName: 'Pro monthly',
      successUrl: 'https://example.com/pay/success',
      cancelUrl: 'https://example.com/pay/cancel',
      expiresAtSeconds: 1_778_243_400,
    }

    await stripe.createCheckoutSession(input)
    await stripe.createCheckoutSession(input)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, firstInit] = fetchMock.mock.calls[0]!
    const [, secondInit] = fetchMock.mock.calls[1]!
    expect(firstInit?.method).toBe('POST')
    expect(firstInit?.headers).toMatchObject({
      authorization: 'Bearer sk_test_secret',
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': 'checkout-order-42',
    })
    expect(secondInit?.headers).toMatchObject({ 'idempotency-key': 'checkout-order-42' })

    const form = new URLSearchParams(String(firstInit?.body))
    expect(Object.fromEntries(form)).toMatchObject({
      mode: 'payment',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: String(input.expiresAtSeconds),
      client_reference_id: input.orderId,
      'metadata[order_id]': input.orderId,
      'payment_intent_data[metadata][order_id]': input.orderId,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '1299',
      'line_items[0][price_data][product_data][name]': input.productName,
      'line_items[0][quantity]': '1',
    })
  })

  it('retrieves and expires a session using the minimal Stripe endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(validSession))
    const stripe = new StripeClient({
      secretKey: 'sk_test_secret',
      apiBase: 'https://stripe.invalid/v1',
      fetch: fetchMock,
    })

    await stripe.retrieveCheckoutSession('cs_test_123')
    await stripe.expireCheckoutSession('cs_test_123')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://stripe.invalid/v1/checkout/sessions/cs_test_123')
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://stripe.invalid/v1/checkout/sessions/cs_test_123/expire')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': 'expire-cs_test_123' }),
    })
  })
})

describe('StripeClient refunds', () => {
  it('creates amount-specific idempotent refunds and retrieves them', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(validRefund))
    const stripe = new StripeClient({ secretKey: 'sk_test_secret', fetch: fetchMock })

    const refund = {
      orderId: 'order-42',
      paymentIntentId: 'pi_test_123',
      amountMinor: 499,
    }
    await stripe.createRefund(refund)
    await stripe.createRefund(refund)
    await stripe.createRefund({ ...refund, amountMinor: 500 })
    await stripe.retrieveRefund('re_test_123')

    const [, createInit] = fetchMock.mock.calls[0]!
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.stripe.com/v1/refunds')
    expect(createInit?.headers).toMatchObject({ 'idempotency-key': 're-order-42-499' })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'idempotency-key': 're-order-42-499',
    })
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      'idempotency-key': 're-order-42-500',
    })
    expect(Object.fromEntries(new URLSearchParams(String(createInit?.body)))).toEqual({
      payment_intent: 'pi_test_123',
      amount: '499',
      'metadata[order_id]': 'order-42',
    })
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://api.stripe.com/v1/refunds/re_test_123')
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe('GET')
  })

  it('maps provider failures to a safe error without leaking Stripe response details', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { message: 'declined: internal account secret' } }, 402),
    )
    const stripe = new StripeClient({ secretKey: 'sk_test_secret', fetch: fetchMock })

    const caught = await stripe.retrieveRefund('re_test_123').catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(StripeAdapterError)
    expect(caught).toMatchObject({ code: 'stripe_request_failed', status: 502, retryable: false })
    expect(String(caught)).not.toContain('internal account secret')
  })

  it('rejects malformed success responses instead of accepting partial objects', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: 're_test_123', object: 'refund' }),
    )
    const stripe = new StripeClient({ secretKey: 'sk_test_secret', fetch: fetchMock })

    await expect(stripe.retrieveRefund('re_test_123')).rejects.toMatchObject({
      code: 'stripe_response_invalid',
      status: 502,
    })
  })
})
