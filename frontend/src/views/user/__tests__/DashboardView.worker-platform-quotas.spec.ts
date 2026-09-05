import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const getMyPlatformQuotas = vi.hoisted(() => vi.fn())
const refreshUser = vi.hoisted(() => vi.fn())

vi.mock('@/api/user', () => ({ getMyPlatformQuotas }))
vi.mock('@/api/usage', () => ({
  usageAPI: {
    getDashboardStats: vi.fn().mockResolvedValue({
      total_actual_cost: 0, today_actual_cost: 0, total_requests: 0,
      total_tokens: 0, by_platform: [],
    }),
    getDashboardTrend: vi.fn().mockResolvedValue({ trend: [] }),
    getDashboardModels: vi.fn().mockResolvedValue({ models: [] }),
    getByDateRange: vi.fn().mockResolvedValue({ items: [] }),
  },
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { balance: 10 }, isSimpleMode: false, refreshUser,
  }),
}))

import DashboardView from '../DashboardView.vue'

describe('DashboardView Worker platform quota payload', () => {
  it('passes the owner-scoped quota list to the visible dashboard stats', async () => {
    getMyPlatformQuotas.mockResolvedValue({
      schema_version: 1,
      control_version: 4,
      updated_at_ms: 100,
      platform_quotas: [{
        platform: 'openai', daily_limit_usd: 5, weekly_limit_usd: null,
        monthly_limit_usd: 30, daily_usage_usd: 1.25,
        weekly_usage_usd: 1.25, monthly_usage_usd: 1.25,
        daily_window_resets_at: '2026-09-06T00:00:00.000Z',
      }],
    })
    const wrapper = mount(DashboardView, { global: { stubs: {
      AppLayout: { template: '<div><slot /></div>' },
      LoadingSpinner: true,
      UserDashboardStats: {
        props: ['platformQuotas'],
        template: '<div data-test="quota-platforms">{{ platformQuotas.map(q => q.platform + ":" + q.daily_usage_usd).join(",") }}</div>',
      },
      UserDashboardCharts: true,
      UserDashboardRecentUsage: true,
      UserDashboardQuickActions: true,
    } } })
    await flushPromises()

    expect(getMyPlatformQuotas).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-test="quota-platforms"]').text()).toBe('openai:1.25')
  })
})
