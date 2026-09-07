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

describe('OpsErrorDetailsModal Worker offset contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    mocks.listRequestErrors.mockReset().mockResolvedValue({ items: [{}], total: 1, page: 1, page_size: 10, pages: 1 })
    mocks.listUpstreamErrors.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  it('sends the original offset filters and preserves opaque group ids', async () => {
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
    expect(mocks.listRequestErrors.mock.calls[0][0]).toEqual(expect.objectContaining({
      page: 1,
      page_size: 10,
      view: 'errors',
      sort_by: 'created_at',
      sort_order: 'desc',
      group_id: 'group_opaque',
    }))
    expect(mocks.listRequestErrors).toHaveBeenCalledTimes(1)
  })

  it('does not let an older response overwrite a newer filter result', async () => {
    let resolveOld!: (value: unknown) => void
    mocks.listRequestErrors.mockImplementation((params: { group_id?: string }) => {
      if (params.group_id === 'group-old') {
        return new Promise(resolve => { resolveOld = resolve })
      }
      return Promise.resolve({
        items: [{ id: params.group_id || 'initial' }], total: 1, page: 1, page_size: 10, pages: 1,
      })
    })
    const wrapper = mount(OpsErrorDetailsModal, {
      props: { show: true, timeRange: '1h', errorType: 'request' },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
          Select: true,
          OpsErrorLogTable: { props: ['rows'], template: '<div data-testid="rows">{{ rows?.[0]?.id }}</div>' },
        },
      },
    })
    await flushPromises()
    await wrapper.setProps({ groupId: 'group-old' })
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ groupId: 'group-new' })
    await flushPromises()
    expect(wrapper.get('[data-testid="rows"]').text()).toBe('group-new')

    resolveOld({ items: [{ id: 'stale' }], total: 1, page: 1, page_size: 10, pages: 1 })
    await flushPromises()
    expect(wrapper.get('[data-testid="rows"]').text()).toBe('group-new')
  })
})
