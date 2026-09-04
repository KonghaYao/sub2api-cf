import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'

const getMyOrders = vi.hoisted(() => vi.fn())
const cancelOrder = vi.hoisted(() => vi.fn())
const getRefundEligibleProviders = vi.hoisted(() => vi.fn())
const showSuccess = vi.hoisted(() => vi.fn())
const showError = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: vi.fn() }) }
})

vi.mock('@/stores', () => ({
  useAppStore: () => ({ showSuccess, showError }),
}))

vi.mock('@/api/payment', () => ({
  paymentAPI: {
    getMyOrders,
    cancelOrder,
    requestRefund: vi.fn(),
    getRefundEligibleProviders,
  },
}))

import UserOrdersView from '../UserOrdersView.vue'

describe('UserOrdersView opaque order IDs', () => {
  beforeEach(() => {
    getMyOrders.mockReset().mockResolvedValue({
      data: {
        items: [{
          id: '01JORDER-user-list',
          user_id: '01JUSER-user-list',
          amount: 20,
          pay_amount: 20,
          fee_rate: 0,
          payment_type: 'stripe',
          out_trade_no: 'sub2_user_list',
          status: 'PENDING',
          order_type: 'balance',
          created_at: '2026-09-04T00:00:00Z',
          expires_at: '2026-09-04T00:30:00Z',
          refund_amount: 0,
        }],
        page: 1,
        page_size: 20,
        total: 1,
      },
    })
    cancelOrder.mockReset().mockResolvedValue({ data: {} })
    getRefundEligibleProviders.mockReset().mockResolvedValue({ data: { provider_instance_ids: [] } })
    showSuccess.mockReset()
    showError.mockReset()
  })

  it('cancels the UUID selected from the order table without coercion', async () => {
    const wrapper = shallowMount(UserOrdersView, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          OrderTable: {
            props: ['orders'],
            template: '<div><slot v-if="orders[0]" name="actions" :row="orders[0]" /></div>',
          },
          BaseDialog: {
            props: ['show'],
            template: '<div v-if="show"><slot /><slot name="footer" /></div>',
          },
          Pagination: true,
          Select: true,
          Icon: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('button.text-yellow-600').trigger('click')
    await wrapper.get('button.btn-danger').trigger('click')
    await flushPromises()

    expect(cancelOrder).toHaveBeenCalledWith('01JORDER-user-list')
  })

  it('does not offer self-service refund for a paid subscription', async () => {
    getMyOrders.mockResolvedValueOnce({
      data: {
        items: [{
          id: '01JORDER-subscription',
          user_id: '01JUSER-user-list',
          amount: 20,
          pay_amount: 20,
          fee_rate: 0,
          payment_type: 'stripe',
          provider_instance_id: 'stripe-primary',
          out_trade_no: 'sub2_subscription',
          status: 'COMPLETED',
          order_type: 'subscription',
          created_at: '2026-09-04T00:00:00Z',
          expires_at: '2026-09-04T00:30:00Z',
          refund_amount: 0,
        }],
        page: 1,
        page_size: 20,
        total: 1,
      },
    })
    getRefundEligibleProviders.mockResolvedValueOnce({
      data: { provider_instance_ids: ['stripe-primary'] },
    })

    const wrapper = shallowMount(UserOrdersView, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          OrderTable: {
            props: ['orders'],
            template: '<div><slot v-if="orders[0]" name="actions" :row="orders[0]" /></div>',
          },
          BaseDialog: true,
          Pagination: true,
          Select: true,
          Icon: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('button.text-red-600').exists()).toBe(false)
  })
})
