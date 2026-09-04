import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: {
    get,
    post,
  },
}))

import { paymentAPI } from '@/api/payment'

describe('payment api', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    get.mockResolvedValue({ data: {} })
    post.mockResolvedValue({ data: {} })
  })

  it('keeps legacy public out_trade_no verification for upgrade compatibility', async () => {
    await paymentAPI.verifyOrderPublic('legacy-order-no')

    expect(post).toHaveBeenCalledWith('/payment/public/orders/verify', {
      out_trade_no: 'legacy-order-no',
    })
  })

  it('keeps signed public resume-token resolve endpoint', async () => {
    await paymentAPI.resolveOrderPublicByResumeToken('resume-token-123')

    expect(post).toHaveBeenCalledWith('/payment/public/orders/resolve', {
      resume_token: 'resume-token-123',
    })
  })

  it('adds a unique idempotency key to every create-order request', async () => {
    const payload = {
      amount: 20,
      payment_type: 'stripe',
      order_type: 'balance',
    }

    await paymentAPI.createOrder(payload)
    await paymentAPI.createOrder(payload)

    const firstConfig = post.mock.calls[0]?.[2]
    const secondConfig = post.mock.calls[1]?.[2]
    const firstKey = firstConfig?.headers?.['Idempotency-Key']
    const secondKey = secondConfig?.headers?.['Idempotency-Key']

    expect(post).toHaveBeenNthCalledWith(1, '/payment/orders', payload, expect.any(Object))
    expect(firstKey).toEqual(expect.any(String))
    expect(firstKey).not.toBe('')
    expect(secondKey).toEqual(expect.any(String))
    expect(secondKey).not.toBe(firstKey)
  })

  it('keeps opaque UUID order IDs intact in user order routes', async () => {
    const orderId = '01JORDER-8c0f-4d4f-a062-opaque'

    await paymentAPI.getOrder(orderId)
    await paymentAPI.cancelOrder(orderId)
    await paymentAPI.requestRefund(orderId, { reason: 'duplicate' })

    expect(get).toHaveBeenCalledWith(`/payment/orders/${orderId}`)
    expect(post).toHaveBeenCalledWith(`/payment/orders/${orderId}/cancel`)
    expect(post).toHaveBeenCalledWith(`/payment/orders/${orderId}/refund-request`, {
      reason: 'duplicate',
    })
  })
})
