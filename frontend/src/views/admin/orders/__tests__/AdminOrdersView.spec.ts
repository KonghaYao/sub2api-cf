import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'

const getOrders = vi.hoisted(() => vi.fn())
const queryRefund = vi.hoisted(() => vi.fn())
const showSuccess = vi.hoisted(() => vi.fn())
const showError = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showSuccess, showError }),
}))

vi.mock('@/api/admin/payment', () => ({
  adminPaymentAPI: {
    getOrders,
    queryRefund,
    getOrder: vi.fn(),
    cancelOrder: vi.fn(),
    retryRecharge: vi.fn(),
    refundOrder: vi.fn(),
  },
  default: {
    getOrders,
    queryRefund,
    getOrder: vi.fn(),
    cancelOrder: vi.fn(),
    retryRecharge: vi.fn(),
    refundOrder: vi.fn(),
  },
}))

import AdminOrdersView from '../AdminOrdersView.vue'

describe('AdminOrdersView opaque order IDs', () => {
  beforeEach(() => {
    getOrders.mockReset().mockResolvedValue({
      data: {
        items: [{
          id: '01JORDER-admin-list',
          user_id: '01JUSER-admin-list',
          amount: 20,
          pay_amount: 20,
          fee_rate: 0,
          payment_type: 'stripe',
          out_trade_no: 'sub2_admin_list',
          status: 'REFUND_PENDING',
          order_type: 'balance',
          created_at: '2026-09-04T00:00:00Z',
          expires_at: '2026-09-04T00:30:00Z',
          refund_amount: 20,
        }],
        page: 1,
        page_size: 20,
        total: 1,
      },
    })
    queryRefund.mockReset().mockResolvedValue({ data: { success: true } })
    showSuccess.mockReset()
    showError.mockReset()
  })

  it('queries a pending refund with the UUID from the order table', async () => {
    const wrapper = shallowMount(AdminOrdersView, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          OrderTable: {
            props: ['orders'],
            template: '<div><slot v-if="orders[0]" name="actions" :row="orders[0]" /></div>',
          },
          Pagination: true,
          BaseDialog: true,
          Select: true,
          Icon: true,
          AdminRefundDialog: true,
          OrderStatusBadge: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('button.text-orange-600').trigger('click')
    await flushPromises()

    expect(queryRefund).toHaveBeenCalledWith('01JORDER-admin-list')
  })
})
