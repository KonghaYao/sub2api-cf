import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

import type { ApiKey } from '@/types'
import KeysView from '../KeysView.vue'

const {
  listKeys,
  createKey,
  updateKey,
  deleteKey,
  toggleKeyStatus,
  getPublicSettings,
  getDashboardApiKeysUsage,
  getAvailableGroups,
  getUserGroupRates,
  showError,
  showSuccess,
  copyToClipboard,
  isCurrentStep,
  nextStep,
} = vi.hoisted(() => ({
  listKeys: vi.fn(),
  createKey: vi.fn(),
  updateKey: vi.fn(),
  deleteKey: vi.fn(),
  toggleKeyStatus: vi.fn(),
  getPublicSettings: vi.fn(),
  getDashboardApiKeysUsage: vi.fn(),
  getAvailableGroups: vi.fn(),
  getUserGroupRates: vi.fn(),
  showError: vi.fn(),
  showSuccess: vi.fn(),
  copyToClipboard: vi.fn(),
  isCurrentStep: vi.fn(),
  nextStep: vi.fn(),
}))

const messages: Record<string, string> = {
  'common.actions': 'Actions',
  'common.create': 'Create',
  'common.edit': 'Edit',
  'common.name': 'Name',
  'common.refresh': 'Refresh',
  'common.status': 'Status',
  'keys.apiKey': 'API Key',
  'keys.allGroups': 'All Groups',
  'keys.allStatus': 'All Status',
  'keys.columnSettings': 'Column Settings',
  'keys.createKey': 'Create API Key',
  'keys.created': 'Created',
  'keys.expiresAt': 'Expires',
  'keys.group': 'Group',
  'keys.id': 'ID',
  'keys.currentConcurrency': 'Current Concurrency',
  'keys.lastUsedAt': 'Last Used',
  'keys.lastUsedIP': 'Last Used IP',
  'keys.rateLimitColumn': 'Rate Limit',
  'keys.reset': 'Reset',
  'keys.resetRateLimitUsage': 'Reset Rate Limit Usage',
  'keys.resetUsage': 'Reset usage',
  'keys.searchPlaceholder': 'Search name or key...',
  'keys.status.active': 'Active',
  'keys.status.expired': 'Expired',
  'keys.status.inactive': 'Inactive',
  'keys.status.quota_exhausted': 'Quota exhausted',
  'keys.usage': 'Usage',
}

vi.mock('@/api', () => ({
  keysAPI: {
    list: listKeys,
    create: createKey,
    update: updateKey,
    delete: deleteKey,
    toggleStatus: toggleKeyStatus,
  },
  authAPI: {
    getPublicSettings,
  },
  usageAPI: {
    getDashboardApiKeysUsage,
  },
  userGroupsAPI: {
    getAvailable: getAvailableGroups,
    getUserGroupRates,
  },
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    showError,
    showSuccess,
  }),
}))

vi.mock('@/stores/onboarding', () => ({
  useOnboardingStore: () => ({
    isCurrentStep,
    nextStep,
  }),
}))

vi.mock('@/composables/useClipboard', () => ({
  useClipboard: () => ({
    copyToClipboard,
  }),
}))

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => messages[key] ?? key,
    }),
  }
})

const createApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 1,
  user_id: 1,
  key: 'sk-test-key',
  name: 'test-key',
  group_id: null,
  status: 'active',
  ip_whitelist: [],
  ip_blacklist: [],
  last_used_at: null,
  last_used_ip: null,
  quota: 0,
  quota_used: 0,
  expires_at: null,
  created_at: '2026-06-27T00:00:00Z',
  updated_at: '2026-06-27T00:00:00Z',
  current_concurrency: 3,
  rate_limit_5h: 0,
  rate_limit_1d: 0,
  rate_limit_7d: 0,
  usage_5h: 0,
  usage_1d: 0,
  usage_7d: 0,
  window_5h_start: null,
  window_1d_start: null,
  window_7d_start: null,
  reset_5h_at: null,
  reset_1d_at: null,
  reset_7d_at: null,
  ...overrides,
})

const AppLayoutStub = {
  template: '<div><slot /></div>',
}

const TablePageLayoutStub = {
  template: `
    <div>
      <slot name="filters" />
      <slot name="actions" />
      <slot name="table" />
      <slot name="pagination" />
    </div>
  `,
}

const DataTableStub = {
  name: 'DataTable',
  props: ['columns', 'data'],
  emits: ['sort'],
  template: `
    <div>
      <div data-test="columns">{{ columns.map((col) => col.key).join(',') }}</div>
      <div data-test="columns-meta">{{ JSON.stringify(columns.map((col) => ({ key: col.key, sortable: !!col.sortable }))) }}</div>
      <button data-test="sort-current-concurrency" @click="$emit('sort', 'current_concurrency', 'asc')">
        Sort Current Concurrency
      </button>
      <div v-for="row in data" :key="row.id">
        <div
          v-if="columns.some((col) => col.key === 'id')"
          data-test="key-id"
        >
          <slot name="cell-id" :value="row.id" :row="row" />
        </div>
        <slot name="cell-name" :value="row.name" :row="row" />
        <div data-test="current-concurrency">
          <slot name="cell-current_concurrency" :value="row.current_concurrency" :row="row" />
        </div>
        <div v-if="columns.some((col) => col.key === 'usage')" data-test="usage-cell">
          <slot name="cell-usage" :value="row.usage" :row="row" />
        </div>
        <div v-if="columns.some((col) => col.key === 'rate_limit')" data-test="rate-limit-cell">
          <slot name="cell-rate_limit" :value="row.rate_limit_5h" :row="row" />
        </div>
        <div
          v-if="columns.some((col) => col.key === 'last_used_ip')"
          data-test="last-used-ip"
        >
          <slot name="cell-last_used_ip" :value="row.last_used_ip" :row="row" />
        </div>
        <div data-test="actions-cell">
          <slot name="cell-actions" :row="row" />
        </div>
      </div>
      <slot name="empty" />
    </div>
  `,
}

const SelectStub = {
  name: 'Select',
  props: ['modelValue', 'options'],
  emits: ['update:modelValue'],
  template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"></select>',
}

const SearchInputStub = {
  name: 'SearchInput',
  props: ['modelValue'],
  emits: ['update:modelValue', 'search'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
}

const PaginationStub = {
  name: 'Pagination',
  props: ['page', 'total', 'pageSize'],
  emits: ['update:page', 'update:pageSize'],
  template: `
    <div>
      <button data-test="page-size-50" @click="$emit('update:pageSize', 50)">50</button>
      <button data-test="page-two" @click="$emit('update:page', 2)">2</button>
    </div>
  `,
}

const IconStub = {
  props: ['name'],
  template: '<span data-test="icon">{{ name }}</span>',
}

const BaseDialogStub = {
  props: ['show', 'title'],
  template: '<div v-if="show" data-test="base-dialog"><slot /><slot name="footer" /></div>',
}

const ConfirmDialogStub = {
  props: ['show', 'title', 'message'],
  emits: ['confirm', 'cancel'],
  template: '<button v-if="show" data-test="confirm-dialog" @click="$emit(\'confirm\')">Confirm</button>',
}

const mountView = async () => {
  const wrapper = mount(KeysView, {
    global: {
      stubs: {
        AppLayout: AppLayoutStub,
        TablePageLayout: TablePageLayoutStub,
        DataTable: DataTableStub,
        Pagination: PaginationStub,
        BaseDialog: BaseDialogStub,
        ConfirmDialog: ConfirmDialogStub,
        EmptyState: true,
        Select: SelectStub,
        SearchInput: SearchInputStub,
        Icon: IconStub,
        UseKeyModal: true,
        EndpointPopover: true,
        GroupBadge: true,
        GroupOptionItem: true,
        Teleport: true,
      },
    },
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

const visibleColumnKeys = (wrapper: VueWrapper) =>
  wrapper.get('[data-test="columns"]').text().split(',').filter(Boolean)

const visibleColumnMeta = (wrapper: VueWrapper): Array<{ key: string; sortable: boolean }> =>
  JSON.parse(wrapper.get('[data-test="columns-meta"]').text())

const getButtonByText = (wrapper: VueWrapper, text: string) => {
  const button = wrapper.findAll('button').find((item) => item.text().includes(text))
  if (!button) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

const getFormToggle = (wrapper: VueWrapper, label: string) => {
  const section = wrapper.get('#key-form').findAll('.flex.items-center.justify-between')
    .find((item) => item.text().includes(label))
  if (!section) throw new Error(`Toggle not found: ${label}`)
  return section.get('button')
}

describe('user KeysView column settings', () => {
  beforeEach(async () => {
    localStorage.clear()

    listKeys.mockReset()
    createKey.mockReset()
    updateKey.mockReset()
    deleteKey.mockReset()
    toggleKeyStatus.mockReset()
    getPublicSettings.mockReset()
    getDashboardApiKeysUsage.mockReset()
    getAvailableGroups.mockReset()
    getUserGroupRates.mockReset()
    showError.mockReset()
    showSuccess.mockReset()
    copyToClipboard.mockReset()
    isCurrentStep.mockReset()
    nextStep.mockReset()

    listKeys.mockResolvedValue({
      items: [createApiKey()],
      total: 1,
      page: 1,
      page_size: 20,
      pages: 1,
    })
    getPublicSettings.mockResolvedValue({})
    getDashboardApiKeysUsage.mockResolvedValue({ stats: {} })
    getAvailableGroups.mockResolvedValue([])
    getUserGroupRates.mockResolvedValue({})
    isCurrentStep.mockReturnValue(false)
    createKey.mockResolvedValue(createApiKey({ id: 'created-key', key: 'sk-created' }))
    updateKey.mockImplementation(async (_id, _updates, version) =>
      createApiKey({ id: 'worker-key', control_version: (version ?? 0) + 1 })
    )
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
  })

  it('uses the default API key columns with low-frequency columns hidden', async () => {
    const wrapper = await mountView()

    expect(visibleColumnKeys(wrapper)).toEqual([
      'name',
      'key',
      'group',
      'current_concurrency',
      'usage',
      'expires_at',
      'status',
      'created_at',
      'actions',
    ])
    expect(visibleColumnKeys(wrapper)).not.toContain('rate_limit')
    expect(visibleColumnKeys(wrapper)).not.toContain('last_used_at')
    expect(visibleColumnKeys(wrapper)).not.toContain('last_used_ip')
    expect(visibleColumnKeys(wrapper)).not.toContain('id')
  })

  it('shows a hidden column when toggled and persists the preference', async () => {
    const wrapper = await mountView()

    await wrapper.get('button[title="Column Settings"]').trigger('click')
    await getButtonByText(wrapper, 'Rate Limit').trigger('click')
    await nextTick()

    expect(visibleColumnKeys(wrapper)).toContain('rate_limit')
    expect(localStorage.getItem('api-key-hidden-columns')).toBe(
      JSON.stringify(['id', 'last_used_at', 'last_used_ip'])
    )
    expect(localStorage.getItem('api-key-column-settings-version')).toBe('3')
  })

  it('shows the API key ID column when toggled', async () => {
    const wrapper = await mountView()

    await wrapper.get('button[title="Column Settings"]').trigger('click')
    await getButtonByText(wrapper, 'ID').trigger('click')
    await nextTick()

    expect(visibleColumnKeys(wrapper)).toContain('id')
    expect(wrapper.get('[data-test="key-id"]').text()).toBe('#1')
    expect(visibleColumnMeta(wrapper).find((column) => column.key === 'id')?.sortable).toBe(true)
  })

  it('shows the last used IP column when toggled', async () => {
    listKeys.mockResolvedValueOnce({
      items: [{ ...createApiKey(), last_used_ip: '203.0.113.10' }],
      total: 1,
      page: 1,
      page_size: 20,
      pages: 1,
    })
    const wrapper = await mountView()

    await wrapper.get('button[title="Column Settings"]').trigger('click')
    await getButtonByText(wrapper, 'Last Used IP').trigger('click')
    await nextTick()

    expect(visibleColumnKeys(wrapper)).toContain('last_used_ip')
    expect(wrapper.get('[data-test="last-used-ip"]').text()).toBe('203.0.113.10')
  })

  it('restores column preferences from localStorage on mount', async () => {
    localStorage.setItem('api-key-hidden-columns', JSON.stringify(['group', 'created_at']))
    localStorage.setItem('api-key-column-settings-version', '1')

    const wrapper = await mountView()

    expect(visibleColumnKeys(wrapper)).toEqual([
      'name',
      'key',
      'current_concurrency',
      'usage',
      'rate_limit',
      'expires_at',
      'status',
      'last_used_at',
      'actions',
    ])
    expect(localStorage.getItem('api-key-hidden-columns')).toBe(
      JSON.stringify(['group', 'created_at', 'last_used_ip', 'id'])
    )
    expect(localStorage.getItem('api-key-column-settings-version')).toBe('3')
  })

  it('does not include always-visible columns in the toggleable menu', async () => {
    const wrapper = await mountView()

    await wrapper.get('button[title="Column Settings"]').trigger('click')
    await nextTick()

    const columnMenuText = wrapper.text()
    expect(columnMenuText).toContain('API Key')
    expect(columnMenuText).toContain('ID')
    expect(columnMenuText).toContain('Current Concurrency')
    expect(columnMenuText).toContain('Rate Limit')
    expect(columnMenuText).toContain('Last Used IP')
    expect(columnMenuText).not.toContain('Name')
    expect(columnMenuText).not.toContain('Actions')
  })

  it('renders the current concurrency value', async () => {
    const wrapper = await mountView()

    expect(wrapper.get('[data-test="current-concurrency"]').text()).toBe('3')
  })

  it('disables current concurrency sorting for the Worker because the value lives in a Durable Object', async () => {
    const wrapper = await mountView()

    const currentConcurrencyColumn = visibleColumnMeta(wrapper).find(
      (column) => column.key === 'current_concurrency'
    )
    expect(currentConcurrencyColumn?.sortable).toBe(false)
  })

  it('keeps current concurrency sortable against the legacy API', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(false)
    const wrapper = await mountView()
    const currentConcurrencyColumn = visibleColumnMeta(wrapper).find(
      (column) => column.key === 'current_concurrency'
    )
    expect(currentConcurrencyColumn?.sortable).toBe(true)
  })

  it('keeps filters and selected page size when sorting by current concurrency', async () => {
    getAvailableGroups.mockResolvedValue([{ id: 42, name: 'OpenAI' }])
    const wrapper = await mountView()

    await wrapper.get('[data-test="page-size-50"]').trigger('click')
    await flushPromises()

    await wrapper.findComponent({ name: 'SearchInput' }).vm.$emit('update:modelValue', 'target')
    await wrapper.findComponent({ name: 'SearchInput' }).vm.$emit('search')
    await flushPromises()

    const selects = wrapper.findAllComponents({ name: 'Select' })
    await selects[0].vm.$emit('update:modelValue', 42)
    await flushPromises()
    await selects[1].vm.$emit('update:modelValue', 'active')
    await flushPromises()

    listKeys.mockClear()

    await wrapper.get('[data-test="sort-current-concurrency"]').trigger('click')
    await flushPromises()

    expect(listKeys).toHaveBeenLastCalledWith(
      1,
      50,
      {
        search: 'target',
        status: 'active',
        group_id: 42,
        sort_by: 'current_concurrency',
        sort_order: 'asc',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('renders Worker quota progress, rolling-window usage, and reset countdown for a UUID key', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'))
    localStorage.setItem(
      'api-key-hidden-columns',
      JSON.stringify(['id', 'last_used_at', 'last_used_ip'])
    )
    localStorage.setItem('api-key-column-settings-version', '3')
    listKeys.mockResolvedValueOnce({
      items: [createApiKey({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        control_version: 7,
        quota: 10,
        quota_used: 2.5,
        rate_limit_5h: 5,
        usage_5h: 1,
        reset_5h_at: '2027-01-01T02:30:00.000Z',
      })],
      total: 1,
      page: 1,
      page_size: 20,
      pages: 1,
    })

    const wrapper = await mountView()

    expect(wrapper.get('[data-test="usage-cell"]').text()).toContain('$2.50 / $10.00')
    expect(wrapper.get('[data-test="rate-limit-cell"]').text()).toContain('$1.00/$5.00')
    expect(wrapper.get('[data-test="rate-limit-cell"]').text()).toContain('2h 30m')
    expect(wrapper.get('[data-test="rate-limit-cell"]').text()).toContain('Reset usage')

    wrapper.unmount()
    vi.useRealTimers()
  })

  it('submits an enabled quota from the existing create form', async () => {
    const groupID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    getAvailableGroups.mockResolvedValueOnce([{
      id: groupID,
      name: 'OpenAI',
      description: null,
      platform: 'openai',
      rate_multiplier: 1,
      subscription_type: 'standard',
    }])
    const wrapper = await mountView()

    await getButtonByText(wrapper, 'Create API Key').trigger('click')
    await wrapper.get('input[data-tour="key-form-name"]').setValue('budgeted')
    const groupSelect = wrapper.findAllComponents({ name: 'Select' })
      .find((select) => select.attributes('data-tour') === 'key-form-group')
    expect(groupSelect).toBeDefined()
    groupSelect!.vm.$emit('update:modelValue', groupID)
    await nextTick()
    await wrapper.get('input[step="0.01"]').setValue('0.000001')
    await wrapper.get('form#key-form').trigger('submit')
    await flushPromises()

    expect(createKey).toHaveBeenCalledWith(
      'budgeted',
      groupID,
      undefined,
      undefined,
      undefined,
      0.000001,
      undefined,
      { rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 }
    )
  })

  it('exposes Worker custom-token and IP policy controls and submits them through the key API', async () => {
    const groupID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    getAvailableGroups.mockResolvedValueOnce([{ id: groupID, name: 'OpenAI' }])
    const wrapper = await mountView()

    await getButtonByText(wrapper, 'Create API Key').trigger('click')
    await wrapper.get('input[data-tour="key-form-name"]').setValue('restricted')
    const groupSelect = wrapper.findAllComponents({ name: 'Select' })
      .find((select) => select.attributes('data-tour') === 'key-form-group')
    groupSelect!.vm.$emit('update:modelValue', groupID)
    await nextTick()
    await getFormToggle(wrapper, 'keys.customKeyLabel').trigger('click')
    await wrapper.get('input[placeholder="keys.customKeyPlaceholder"]').setValue('Customer_Key-2026_abcdefgh')
    await getFormToggle(wrapper, 'keys.ipRestriction').trigger('click')
    const createPolicies = wrapper.get('#key-form').findAll('textarea')
    await createPolicies[0].setValue('10.2.3.4/8\n2001:db8::/32')
    await createPolicies[1].setValue('10.9.0.0/16')
    await wrapper.get('form#key-form').trigger('submit')
    await flushPromises()

    expect(createKey).toHaveBeenCalledWith(
      'restricted',
      groupID,
      'Customer_Key-2026_abcdefgh',
      ['10.2.3.4/8', '2001:db8::/32'],
      ['10.9.0.0/16'],
      0,
      undefined,
      { rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 }
    )
  })

  it('submits an edited Worker IP policy with the loaded control version', async () => {
    const key = createApiKey({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      control_version: 7,
      ip_whitelist: ['10.0.0.0/8'],
      ip_blacklist: ['10.9.0.0/16'],
    })
    listKeys.mockResolvedValueOnce({ items: [key], total: 1, page: 1, page_size: 20, pages: 1 })
    const wrapper = await mountView()

    await getButtonByText(wrapper, 'Edit').trigger('click')
    const editPolicies = wrapper.get('#key-form').findAll('textarea')
    await editPolicies[0].setValue('192.0.2.0/24')
    await editPolicies[1].setValue('')
    await wrapper.get('form#key-form').trigger('submit')
    await flushPromises()

    expect(updateKey).toHaveBeenCalledWith(
      key.id,
      expect.objectContaining({
        ip_whitelist: ['192.0.2.0/24'],
        ip_blacklist: [],
      }),
      { expectedControlVersion: 7, monetaryBaseline: key }
    )
  })

  it('submits zero for disabled quota and rate-limit controls when creating', async () => {
    const groupID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    getAvailableGroups.mockResolvedValueOnce([{ id: groupID, name: 'OpenAI' }])
    const wrapper = await mountView()

    await getButtonByText(wrapper, 'Create API Key').trigger('click')
    await wrapper.get('input[data-tour="key-form-name"]').setValue('unlimited')
    const groupSelect = wrapper.findAllComponents({ name: 'Select' })
      .find((select) => select.attributes('data-tour') === 'key-form-group')
    groupSelect!.vm.$emit('update:modelValue', groupID)
    await nextTick()
    await wrapper.get('form#key-form').trigger('submit')
    await flushPromises()

    expect(createKey).toHaveBeenCalledWith(
      'unlimited',
      groupID,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      { rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 }
    )
  })

  it('falls back to the final valid page after deleting its last API key', async () => {
    const key = createApiKey({ id: 'page-two-key' })
    listKeys
      .mockResolvedValueOnce({ items: [createApiKey({ id: 'page-one-key' })], total: 21, page: 1, page_size: 20, pages: 2 })
      .mockResolvedValueOnce({ items: [key], total: 21, page: 2, page_size: 20, pages: 2 })
      .mockResolvedValueOnce({ items: [], total: 20, page: 2, page_size: 20, pages: 1 })
      .mockResolvedValueOnce({ items: [createApiKey({ id: 'page-one-key' })], total: 20, page: 1, page_size: 20, pages: 1 })
    deleteKey.mockResolvedValueOnce({ ...key, status: 'inactive' })
    const wrapper = await mountView()

    await wrapper.get('[data-test="page-two"]').trigger('click')
    await flushPromises()
    await getButtonByText(wrapper, 'common.delete').trigger('click')
    await wrapper.get('[data-test="confirm-dialog"]').trigger('click')
    await flushPromises()

    expect(deleteKey).toHaveBeenCalledWith('page-two-key')
    expect(listKeys).toHaveBeenLastCalledWith(
      1,
      20,
      expect.objectContaining({ sort_by: 'created_at', sort_order: 'desc' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('clears an existing quota and all rate windows with the original form controls', async () => {
    const key = createApiKey({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      control_version: 7,
      quota: 10,
      rate_limit_5h: 5,
      rate_limit_1d: 20,
      rate_limit_7d: 80,
    })
    listKeys.mockResolvedValueOnce({ items: [key], total: 1, page: 1, page_size: 20, pages: 1 })
    updateKey.mockResolvedValueOnce({ ...key, quota: 0, rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 })
    const wrapper = await mountView()

    await getButtonByText(wrapper, 'Edit').trigger('click')
    const amountInputs = wrapper.get('#key-form').findAll('input[step="0.01"]')
    for (const input of amountInputs) await input.setValue('0')
    await getFormToggle(wrapper, 'keys.rateLimitSection').trigger('click')
    await wrapper.get('form#key-form').trigger('submit')
    await flushPromises()

    expect(updateKey).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expect.objectContaining({
        quota: 0,
        rate_limit_5h: 0,
        rate_limit_1d: 0,
        rate_limit_7d: 0,
      }),
      {
        expectedControlVersion: 7,
        monetaryBaseline: key
      }
    )
  })

  it('passes the loaded raw micros as the unchanged edit baseline for lossless saving', async () => {
    const key = createApiKey({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      control_version: 11,
      quota: 9_007_199_254.740992,
      quota_micros: Number.MAX_SAFE_INTEGER,
      rate_limit_5h: 9_007_199_254.74099,
      rate_limit_5h_micros: Number.MAX_SAFE_INTEGER - 1,
      rate_limit_1d: 20,
      rate_limit_1d_micros: 20_000_000,
      rate_limit_7d: 80,
      rate_limit_7d_micros: 80_000_000,
    })
    listKeys.mockResolvedValueOnce({ items: [key], total: 1, page: 1, page_size: 20, pages: 1 })
    updateKey.mockResolvedValueOnce(key)
    const wrapper = await mountView()

    await getButtonByText(wrapper, 'Edit').trigger('click')
    await wrapper.get('form#key-form').trigger('submit')
    await flushPromises()

    expect(updateKey).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expect.objectContaining({
        quota: key.quota,
        rate_limit_5h: key.rate_limit_5h,
        rate_limit_1d: key.rate_limit_1d,
        rate_limit_7d: key.rate_limit_7d,
      }),
      {
        expectedControlVersion: 11,
        monetaryBaseline: key
      }
    )
  })

  it('resets cumulative usage with the selected UUID key control version', async () => {
    const key = createApiKey({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      control_version: 7,
      quota: 10,
      quota_used: 2.5,
    })
    listKeys.mockResolvedValueOnce({ items: [key], total: 1, page: 1, page_size: 20, pages: 1 })
    updateKey.mockResolvedValueOnce({ ...key, quota_used: 0, control_version: 8 })
    const wrapper = await mountView()

    await getButtonByText(wrapper, 'Edit').trigger('click')
    const reset = wrapper.get('[data-test="base-dialog"]').findAll('button')
      .find((button) => button.text() === 'Reset')
    expect(reset).toBeDefined()
    await reset!.trigger('click')
    await wrapper.get('[data-test="confirm-dialog"]').trigger('click')
    await flushPromises()

    expect(updateKey).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { reset_quota: true },
      7
    )
  })

  it('resets rolling-window usage from the table with UUID CAS', async () => {
    localStorage.setItem(
      'api-key-hidden-columns',
      JSON.stringify(['id', 'last_used_at', 'last_used_ip'])
    )
    localStorage.setItem('api-key-column-settings-version', '3')
    const key = createApiKey({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      control_version: 9,
      rate_limit_5h: 5,
      usage_5h: 1,
    })
    listKeys.mockResolvedValue({ items: [key], total: 1, page: 1, page_size: 20, pages: 1 })
    updateKey.mockResolvedValueOnce({ ...key, usage_5h: 0, control_version: 10 })
    const wrapper = await mountView()

    await wrapper.get('button[title="Reset Rate Limit Usage"]').trigger('click')
    await wrapper.get('[data-test="confirm-dialog"]').trigger('click')
    await flushPromises()

    expect(updateKey).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { reset_rate_limit_usage: true },
      9
    )
  })
})
