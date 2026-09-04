import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const getOrder = vi.hoisted(() => vi.fn())

vi.mock('@/api/payment', () => ({
  paymentAPI: {
    getOrder,
  },
}))

import { usePaymentStore } from '@/stores/payment'
import type { PaymentOrder } from '@/types/payment'

function order(id: string | number, status: PaymentOrder['status']): PaymentOrder {
  return {
    id,
    user_id: '01JUSER-store',
    amount: 20,
    pay_amount: 20,
    fee_rate: 0,
    payment_type: 'stripe',
    out_trade_no: 'sub2_store',
    status,
    order_type: 'balance',
    created_at: '2026-09-04T00:00:00Z',
    expires_at: '2026-09-04T00:30:00Z',
    refund_amount: 0,
  }
}

describe('payment store opaque order IDs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getOrder.mockReset()
  })

  it('polls a UUID unchanged and updates the matching current order', async () => {
    const orderId = '01JORDER-store-uuid'
    const store = usePaymentStore()
    store.currentOrder = order(orderId, 'PAID')
    getOrder.mockResolvedValue({ data: order(orderId, 'COMPLETED') })

    const result = await store.pollOrderStatus(orderId)

    expect(getOrder).toHaveBeenCalledWith(orderId)
    expect(result?.status).toBe('COMPLETED')
    expect(store.currentOrder?.status).toBe('COMPLETED')
  })

  it('matches a legacy numeric current ID to its string route representation', async () => {
    const store = usePaymentStore()
    store.currentOrder = order(42, 'PAID')
    getOrder.mockResolvedValue({ data: order(42, 'COMPLETED') })

    await store.pollOrderStatus('42')

    expect(store.currentOrder?.status).toBe('COMPLETED')
  })
})
