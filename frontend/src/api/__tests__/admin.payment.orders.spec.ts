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

  it('uses the Worker reconciliation contract with opaque IDs and CAS actions', async () => {
    const issueId = '01JRECONCILIATION-uuid'
    get
      .mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 } })
      .mockResolvedValueOnce({ data: { issue: { id: issueId }, actions: [], events: [] } })
    post.mockResolvedValueOnce({ data: { id: issueId, version: 8, status: 'acknowledged' } })

    await adminPaymentAPI.getReconciliationIssues({
      page: 2,
      page_size: 10,
      status: 'open',
      severity: 'critical',
      order_id: '01JORDER-filter',
    })
    await adminPaymentAPI.getReconciliationIssue(issueId)
    await adminPaymentAPI.actOnReconciliationIssue(issueId, 'acknowledge', 7, { note: 'reviewing' })
    await adminPaymentAPI.downloadReconciliationEvidence(issueId)

    expect(get).toHaveBeenNthCalledWith(1, '/admin/payment/reconciliation', {
      params: {
        page: 2,
        page_size: 10,
        status: 'open',
        severity: 'critical',
        order_id: '01JORDER-filter',
      },
    })
    expect(get).toHaveBeenNthCalledWith(2, `/admin/payment/reconciliation/${issueId}`)
    expect(get).toHaveBeenNthCalledWith(3, `/admin/payment/reconciliation/${issueId}/evidence`, {
      responseType: 'blob',
    })
    expect(post).toHaveBeenCalledWith(
      `/admin/payment/reconciliation/${issueId}/acknowledge`,
      { note: 'reviewing', expected_control_version: 7 },
      {
        headers: expect.objectContaining({
          'If-Match': '"7"',
          'Idempotency-Key': expect.any(String),
        }),
      },
    )
  })
})
