import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OpsErrorDetailsModal from '../OpsErrorDetailsModal.vue'

const mocks = vi.hoisted(() => ({
  listRequestErrors: vi.fn(),
  listUpstreamErrors: vi.fn(),
}))

vi.mock('@/api/admin/ops', () => ({
  opsAPI: mocks,
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

describe('OpsErrorDetailsModal Worker pagination', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    mocks.listRequestErrors.mockReset()
      .mockResolvedValueOnce({ items: [{}], has_more: true, next_cursor: 'next' })
      .mockResolvedValueOnce({ items: [], has_more: false, next_cursor: null })
    mocks.listUpstreamErrors.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  it('reuses one bounded time window across cursor pages', async () => {
    const wrapper = mount(OpsErrorDetailsModal, {
      props: { show: false, timeRange: '1h', errorType: 'request', groupId: 'group_opaque' },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
          Select: true,
          OpsErrorLogTable: true,
        },
      },
    })

    await wrapper.setProps({ show: true })
    await flushPromises()
    const first = mocks.listRequestErrors.mock.calls[0][0]

    vi.setSystemTime(new Date('2026-09-05T00:10:00.000Z'))
    ;(wrapper.vm as any).goToNextPage()
    await flushPromises()

    expect(mocks.listRequestErrors.mock.calls[1][0]).toEqual(expect.objectContaining({
      cursor: 'next',
      group_id: 'group_opaque',
      start_time: first.start_time,
      end_time: first.end_time,
    }))
  })
})
