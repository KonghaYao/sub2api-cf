import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AuditLogView from '../AuditLogView.vue'

const { list, get, showError } = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  showError: vi.fn()
}))

vi.mock('@/api/admin', () => ({
  adminAPI: { audit: { list, get } }
}))

vi.mock('@/stores', () => ({
  useAppStore: () => ({ showError })
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key })
}))

const auditEvent = {
  category: 'auth',
  event_id: 'event-one',
  action: 'auth.login',
  outcome: 'succeeded',
  actor_user_id: 'user-one',
  actor_session_id_masked: 'sess…alue',
  origin: 'auth',
  resource_type: 'user',
  resource_id: 'user-one',
  resource_version: null,
  occurred_at_ms: 1_788_451_200_000,
  occurred_at: '2026-09-01T00:00:00.000Z'
}

const TablePageLayoutStub = defineComponent({
  template: '<div><slot name="filters" /><slot name="table" /><slot name="pagination" /></div>'
})
const DataTableStub = defineComponent({
  props: { data: { type: Array, default: () => [] } },
  template: '<div><div v-for="row in data" :key="row.event_id"><slot name="cell-actions" :row="row" /></div><slot v-if="data.length === 0" name="empty" /></div>'
})
const BaseDialogStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  template: '<div v-if="show" data-test="dialog"><slot /><slot name="footer" /></div>'
})

function mountView() {
  return mount(AuditLogView, {
    global: {
      stubs: {
        AppLayout: { template: '<div><slot /></div>' },
        TablePageLayout: TablePageLayoutStub,
        DataTable: DataTableStub,
        BaseDialog: BaseDialogStub,
        Select: true,
        Icon: true
      }
    }
  })
}

describe('admin audit event view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    list
      .mockResolvedValueOnce({ items: [auditEvent], has_more: true, next_cursor: 'cursor-two' })
      .mockResolvedValueOnce({ items: [{ ...auditEvent, event_id: 'event-two' }], has_more: false, next_cursor: null })
      .mockResolvedValueOnce({ items: [auditEvent], has_more: true, next_cursor: 'cursor-two' })
    get.mockResolvedValue({ ...auditEvent, metadata: { reason: 'test' } })
  })

  it('uses cursor history for next and previous navigation', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 20, cursor: undefined }))
    await wrapper.get('[aria-label="admin.audit.pagination.next"]').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cursor-two' }))

    await wrapper.get('[aria-label="admin.audit.pagination.previous"]').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenNthCalledWith(3, expect.objectContaining({ cursor: undefined }))
  })

  it('opens category-scoped detail and contains no clear affordance', async () => {
    const wrapper = mountView()
    await flushPromises()
    const detailButton = wrapper.findAll('button').find((button) =>
      button.text().includes('admin.audit.columns.detail'))
    expect(detailButton).toBeDefined()
    await detailButton!.trigger('click')
    await flushPromises()

    expect(get).toHaveBeenCalledWith('auth', 'event-one')
    expect(wrapper.find('[data-test="dialog"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('admin.audit.clearAll')
    expect(wrapper.find('.btn-danger').exists()).toBe(false)
  })
})
