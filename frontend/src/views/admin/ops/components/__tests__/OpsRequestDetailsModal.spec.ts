import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OpsRequestDetailsModal from '../OpsRequestDetailsModal.vue'

const mocks = vi.hoisted(() => ({ listRequestDetails: vi.fn() }))

vi.mock('@/api/admin/ops', () => ({ opsAPI: mocks }))
vi.mock('@/stores', () => ({ useAppStore: () => ({ showError: vi.fn(), showWarning: vi.fn() }) }))
vi.mock('@/composables/useClipboard', () => ({ useClipboard: () => ({ copyToClipboard: vi.fn() }) }))
vi.mock('@vueuse/core', () => ({ useMediaQuery: () => true }))
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

describe('OpsRequestDetailsModal Worker contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T00:00:00.000Z'))
    mocks.listRequestDetails.mockReset().mockResolvedValue({
      items: [], total: 0, page: 1, page_size: 10, pages: 0,
    })
  })

  afterEach(() => vi.useRealTimers())

  it('binds the original preset and Pagination fields while preserving an opaque group id', async () => {
    const wrapper = mount(OpsRequestDetailsModal, {
      props: {
        modelValue: false,
        timeRange: '1h',
        platform: 'openai',
        groupId: 'group_01HZZ',
        preset: {
          title: 'Slow requests',
          kind: 'error',
          sort: 'duration_desc',
          min_duration_ms: 800,
          max_duration_ms: 1_000,
        },
      },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
          Pagination: true,
        },
      },
    })
    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    expect(mocks.listRequestDetails).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      page_size: 10,
      kind: 'error',
      sort: 'duration_desc',
      min_duration_ms: 800,
      max_duration_ms: 1_000,
      platform: 'openai',
      group_id: 'group_01HZZ',
      start_time: '2026-09-06T23:00:00.000Z',
      end_time: '2026-09-07T00:00:00.000Z',
    }))
  })

  it('uses the dashboard custom range carried by the preset instead of falling back to one hour', async () => {
    const wrapper = mount(OpsRequestDetailsModal, {
      props: {
        modelValue: false,
        timeRange: 'custom',
        preset: {
          title: 'Custom range',
          custom_start_time: '2026-09-01T01:02:03.000Z',
          custom_end_time: '2026-09-03T04:05:06.000Z',
        },
      },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
          Pagination: true,
        },
      },
    })
    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    expect(mocks.listRequestDetails).toHaveBeenCalledWith(expect.objectContaining({
      start_time: '2026-09-01T01:02:03.000Z',
      end_time: '2026-09-03T04:05:06.000Z',
    }))
  })
})
