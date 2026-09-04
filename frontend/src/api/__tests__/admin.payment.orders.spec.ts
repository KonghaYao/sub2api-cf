import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: {
    get,
    post,
    put,
    delete: del,
  },
}))

import { adminPaymentAPI } from '@/api/admin/payment'

describe('admin payment opaque IDs', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data: {} })
    post.mockReset().mockResolvedValue({ data: {} })
    put.mockReset().mockResolvedValue({ data: {} })
    del.mockReset().mockResolvedValue({ data: {} })
  })

  it('keeps UUID order IDs intact across admin order actions', async () => {
    const orderId = '01JORDER-admin-uuid'
    const refund = { amount: 9, reason: 'requested', force: true }

    await adminPaymentAPI.getOrder(orderId)
    await adminPaymentAPI.cancelOrder(orderId)
    await adminPaymentAPI.retryRecharge(orderId)
    await adminPaymentAPI.refundOrder(orderId, refund)
    await adminPaymentAPI.queryRefund(orderId)

    expect(get).toHaveBeenCalledWith(`/admin/payment/orders/${orderId}`)
    expect(post).toHaveBeenCalledWith(`/admin/payment/orders/${orderId}/cancel`)
    expect(post).toHaveBeenCalledWith(`/admin/payment/orders/${orderId}/retry`)
    expect(post).toHaveBeenCalledWith(
      `/admin/payment/orders/${orderId}/refund`,
      refund,
      { headers: { 'Idempotency-Key': expect.any(String) } },
    )
    expect(post).toHaveBeenCalledWith(`/admin/payment/orders/${orderId}/refund/query`)
  })

  it('accepts opaque user and provider IDs without numeric coercion', async () => {
    const userId = '01JUSER-admin-filter'
    const providerId = '01JPROVIDER-admin-uuid'

    get.mockImplementation(async (url: string) => ({
      data: url === '/admin/payment/providers'
        ? [{ id: providerId, version: 3 }]
        : {},
    }))
    put.mockResolvedValue({ data: { id: providerId, version: 4 } })
    del.mockResolvedValue({ data: { id: providerId, version: 5 } })

    await adminPaymentAPI.getOrders({ user_id: userId })
    await adminPaymentAPI.updateProvider(providerId, { name: 'Stripe primary' })
    await adminPaymentAPI.deleteProvider(providerId)

    expect(get).toHaveBeenCalledWith('/admin/payment/orders', { params: { user_id: userId } })
    expect(put).toHaveBeenCalledWith(
      `/admin/payment/providers/${providerId}`,
      { name: 'Stripe primary', expected_control_version: 3 },
      { headers: expect.objectContaining({ 'If-Match': '"3"', 'Idempotency-Key': expect.any(String) }) },
    )
    expect(del).toHaveBeenCalledWith(
      `/admin/payment/providers/${providerId}`,
      {
        headers: expect.objectContaining({ 'If-Match': '"4"', 'Idempotency-Key': expect.any(String) }),
        data: { expected_control_version: 4 },
      },
    )
  })

  it('carries config CAS and idempotency headers from read to update', async () => {
    get.mockResolvedValueOnce({ data: { enabled: false, version: 7 } })
    put.mockResolvedValueOnce({ data: { enabled: true, version: 8 } })

    await adminPaymentAPI.getConfig()
    await adminPaymentAPI.updateConfig({ enabled: true })

    expect(put).toHaveBeenCalledWith(
      '/admin/payment/config',
      { enabled: true, expected_control_version: 7 },
      { headers: expect.objectContaining({ 'If-Match': '"7"', 'Idempotency-Key': expect.any(String) }) },
    )
  })
})
