import { defineComponent } from 'vue'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OpsDashboard from '../OpsDashboard.vue'
import { setCloudflareWorkerContractActive } from '@/utils/adminCapabilities'

const mocks = vi.hoisted(() => ({
  getDashboardSnapshotV2: vi.fn(),
  getThroughputTrend: vi.fn(),
  getLatencyHistogram: vi.fn(),
  getErrorDistribution: vi.fn(),
  getAdvancedSettings: vi.fn(),
  getMetricThresholds: vi.fn(),
  settingsFetch: vi.fn(),
  routerReplace: vi.fn(),
}))

vi.mock('@/api/admin/ops', () => {
  const opsAPI = {
    getDashboardSnapshotV2: mocks.getDashboardSnapshotV2,
    getThroughputTrend: mocks.getThroughputTrend,
    getLatencyHistogram: mocks.getLatencyHistogram,
    getErrorDistribution: mocks.getErrorDistribution,
    getAdvancedSettings: mocks.getAdvancedSettings,
    getMetricThresholds: mocks.getMetricThresholds,
  }
  return { opsAPI, default: opsAPI }
})

vi.mock('@/stores', () => ({
  useAppStore: () => ({ showError: vi.fn() }),
  useAdminSettingsStore: () => ({
    opsMonitoringEnabled: true,
    opsQueryModeDefault: 'auto',
    fetch: mocks.settingsFetch,
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: mocks.routerReplace }),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@vueuse/core', () => ({
  useDebounceFn: (callback: (...args: unknown[]) => unknown) => callback,
  useIntervalFn: () => ({ pause: vi.fn(), resume: vi.fn() }),
}))

const DashboardHeaderStub = defineComponent({
  name: 'OpsDashboardHeader',
  emits: ['open-error-details'],
  template: '<button data-testid="open-errors" @click="$emit(\'open-error-details\', \'request\')" />',
})

const ErrorListStub = defineComponent({
  name: 'OpsErrorDetailsModal',
  props: { show: Boolean, resumeState: Boolean },
  emits: ['openErrorDetail'],
  template: '<button data-testid="open-error" @click="$emit(\'openErrorDetail\', \'error-1\')" />',
})

const ErrorDetailStub = defineComponent({
  name: 'OpsErrorDetailModal',
  props: { show: Boolean, backToList: Boolean },
  emits: ['changed', 'back', 'update:show'],
  template: '<div />',
})

describe('OpsDashboard error resolution refresh', () => {
  beforeEach(() => {
    setCloudflareWorkerContractActive(false)
    vi.clearAllMocks()
    mocks.settingsFetch.mockResolvedValue(undefined)
    mocks.getAdvancedSettings.mockResolvedValue({
      display_alert_events: false,
      display_openai_token_stats: false,
      auto_refresh_enabled: false,
      auto_refresh_interval_seconds: 30,
    })
    mocks.getMetricThresholds.mockResolvedValue(null)
    mocks.getDashboardSnapshotV2.mockResolvedValue({
      overview: {},
      throughput_trend: { points: [] },
      error_trend: { points: [] },
    })
    mocks.getThroughputTrend.mockResolvedValue({ points: [] })
    mocks.getLatencyHistogram.mockResolvedValue({ buckets: [] })
    mocks.getErrorDistribution.mockResolvedValue({ total: 0, items: [] })
  })

  it('refreshes dashboard data and reloads the source list after a detail resolution change', async () => {
    const wrapper = shallowMount(OpsDashboard, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          OpsDashboardHeader: DashboardHeaderStub,
          OpsErrorDetailsModal: ErrorListStub,
          OpsErrorDetailModal: ErrorDetailStub,
        },
      },
    })
    await flushPromises()
    const initialRefreshes = mocks.getDashboardSnapshotV2.mock.calls.length

    await wrapper.get('[data-testid="open-errors"]').trigger('click')
    await wrapper.get('[data-testid="open-error"]').trigger('click')
    const detail = wrapper.findComponent(ErrorDetailStub)
    expect(detail.props('show')).toBe(true)
    expect(detail.props('backToList')).toBe(true)

    detail.vm.$emit('changed')
    await flushPromises()
    expect(mocks.getDashboardSnapshotV2).toHaveBeenCalledTimes(initialRefreshes + 1)

    detail.vm.$emit('back')
    await wrapper.vm.$nextTick()
    const list = wrapper.findComponent(ErrorListStub)
    expect(list.props('show')).toBe(true)
    expect(list.props('resumeState')).toBe(false)
  })

  it('renders only Worker request/error explorers without legacy dashboard requests', async () => {
    setCloudflareWorkerContractActive(true)

    const wrapper = shallowMount(OpsDashboard, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          OpsErrorDetailsModal: ErrorListStub,
          OpsErrorDetailModal: ErrorDetailStub,
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="worker-ops-explorer"]').exists()).toBe(true)
    expect(mocks.getAdvancedSettings).not.toHaveBeenCalled()
    expect(mocks.getMetricThresholds).not.toHaveBeenCalled()
    expect(mocks.getDashboardSnapshotV2).not.toHaveBeenCalled()
    expect(mocks.getThroughputTrend).not.toHaveBeenCalled()
    expect(mocks.getLatencyHistogram).not.toHaveBeenCalled()
    expect(mocks.getErrorDistribution).not.toHaveBeenCalled()
  })
})
