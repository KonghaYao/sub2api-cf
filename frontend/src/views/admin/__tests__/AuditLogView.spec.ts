import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AuditLogView from '../AuditLogView.vue'

const { list, get, clear, getStatus, showError, showSuccess } = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), clear: vi.fn(), getStatus: vi.fn(),
  showError: vi.fn(), showSuccess: vi.fn(),
}))

vi.mock('@/api/admin', () => ({ adminAPI: { audit: { list, get, clear } } }))
vi.mock('@/api', () => ({ totpAPI: { getStatus } }))
vi.mock('@/stores', () => ({ useAppStore: () => ({ showError, showSuccess }) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

const auditLog = {
  id: 42,
  created_at: '2026-09-01T00:00:00.000Z',
  actor_user_id: 'user-one',
  actor_email: 'admin@example.com',
  actor_role: 'admin',
  auth_method: 'jwt',
  credential_masked: 'sub2…alue',
  action: 'POST /api/v1/admin/users',
  method: 'POST',
  path: '/api/v1/admin/users',
  request_id: 'request-one',
  client_ip: '203.0.113.1',
  user_agent: 'test-agent',
  status_code: 201,
  latency_ms: 7,
}

const TablePageLayoutStub = defineComponent({
  template: '<div><slot name="filters" /><slot name="table" /><slot name="pagination" /></div>',
})
const DataTableStub = defineComponent({
  props: { data: { type: Array, default: () => [] } },
  template: '<div><div v-for="row in data" :key="row.id"><slot name="cell-actions" :row="row" /></div></div>',
})
const PaginationStub = defineComponent({
  emits: ['update:page', 'update:pageSize'],
  template: '<button data-test="next-page" @click="$emit(\'update:page\', 2)">next</button>',
})
const BaseDialogStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  template: '<div v-if="show" data-test="dialog"><slot /><slot name="footer" /></div>',
})
const ConfirmDialogStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  emits: ['confirm', 'cancel'],
  template: '<button v-if="show" data-test="confirm-clear" @click="$emit(\'confirm\')">confirm</button>',
})

function mountView() {
  return mount(AuditLogView, {
    global: {
      stubs: {
        AppLayout: { template: '<div><slot /></div>' },
        TablePageLayout: TablePageLayoutStub,
        DataTable: DataTableStub,
        Pagination: PaginationStub,
        BaseDialog: BaseDialogStub,
        ConfirmDialog: ConfirmDialogStub,
        Select: true,
        Icon: true,
      },
    },
  })
}

describe('admin request audit view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    list.mockResolvedValue({ items: [auditLog], total: 21, page: 1, page_size: 20, pages: 2 })
    get.mockResolvedValue({ ...auditLog, request_body: '[not_captured]' })
    clear.mockResolvedValue({ deleted: 3 })
    getStatus.mockResolvedValue({ enabled: true })
  })

  it('uses original page pagination and filter contract', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1, page_size: 20 }))
    await wrapper.get('[data-test="next-page"]').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, page_size: 20 }))
  })

  it('opens numeric detail and preserves the original clear affordance', async () => {
    const wrapper = mountView()
    await flushPromises()
    const detailButton = wrapper.findAll('button').find((button) =>
      button.text().includes('admin.audit.columns.detail'))
    await detailButton!.trigger('click')
    await flushPromises()
    expect(get).toHaveBeenCalledWith(42)
    expect(wrapper.find('[data-test="dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('admin.audit.clearAll')
    expect(wrapper.find('.btn-danger').exists()).toBe(true)
  })

  it('runs the original confirm and fresh-TOTP clear flow', async () => {
    const wrapper = mountView()
    await flushPromises()
    const clearButton = wrapper.findAll('button').find((button) =>
      button.text().includes('admin.audit.clearAll'))
    await clearButton!.trigger('click')
    await flushPromises()
    expect(getStatus).toHaveBeenCalledOnce()

    await wrapper.get('[data-test="confirm-clear"]').trigger('click')
    const input = wrapper.get('input[autocomplete="one-time-code"]')
    await input.setValue('123456')
    const dangerButtons = wrapper.findAll('.btn-danger')
    const submit = dangerButtons[dangerButtons.length - 1]
    await submit!.trigger('click')
    await flushPromises()

    expect(clear).toHaveBeenCalledWith('123456')
    expect(showSuccess).toHaveBeenCalledWith('admin.audit.clearConfirm.success')
    expect(list).toHaveBeenCalledTimes(2)
  })
})
