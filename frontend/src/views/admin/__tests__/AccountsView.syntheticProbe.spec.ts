import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsView from '../AccountsView.vue'

const {
  workerContract,
  listAccounts,
  listModels,
  getAllGroups,
  settingsFetch,
} = vi.hoisted(() => ({
  workerContract: { enabled: true },
  listAccounts: vi.fn(),
  listModels: vi.fn(),
  getAllGroups: vi.fn(),
  settingsFetch: vi.fn(),
}))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    accounts: {
      list: listAccounts,
      listWithEtag: vi.fn().mockResolvedValue({ notModified: true, etag: null, data: null }),
      getBatchTodayStats: vi.fn().mockResolvedValue({ stats: {} }),
      getUpstreamBillingProbeSettings: vi.fn().mockResolvedValue({ enabled: false, interval_minutes: 30 }),
    },
    models: { list: listModels },
    groups: { getAll: getAllGroups },
    proxies: { getAll: vi.fn().mockResolvedValue([]) },
  },
}))

vi.mock('@/stores/adminSettings', () => ({
  useAdminSettingsStore: () => ({
    get cloudflareWorkerContract() { return workerContract.enabled },
    fetch: settingsFetch,
  }),
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn(), showInfo: vi.fn() }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ token: 'test-token', isSimpleMode: false }),
}))

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

const account = {
  id: 'account-1',
  name: 'Worker account',
  platform: 'openai',
  type: 'apikey',
  status: 'active',
  schedulable: true,
  control_version: 7,
  model_capabilities: [{ model_id: 'model-alpha', responses: true }],
  created_at: '2026-09-06T00:00:00Z',
  updated_at: '2026-09-06T00:00:00Z',
}

const model = {
  id: 'model-alpha', platform: 'openai', public_name: 'Model Alpha', upstream_name: 'model-alpha',
  endpoint: 'responses', embeddings: false, image_generation: false, enabled: true, control_version: 3,
}

function mountView() {
  return mount(AccountsView, {
    global: {
      stubs: {
        AppLayout: { template: '<div><slot /></div>' },
        TablePageLayout: { template: '<div><slot name="filters" /><slot name="table" /><slot name="pagination" /></div>' },
        AccountTableActions: { template: '<div><slot name="after" /></div>' },
        DataTable: {
          props: ['data'],
          template: '<div><slot v-if="data[0]" name="cell-select" :row="data[0]" /></div>',
        },
        SyntheticProbeModal: {
          props: ['show', 'accounts', 'models'],
          emits: ['close'],
          template: '<div v-if="show" data-testid="synthetic-modal-stub">{{ accounts[0]?.id }}:{{ models[0]?.id }}</div>',
        },
        AccountBulkActionsBar: true,
        Pagination: true,
        ConfirmDialog: true,
        AccountTableFilters: true,
        AccountActionMenu: true,
        ImportDataModal: true,
        ReAuthAccountModal: true,
        AccountTestModal: true,
        AccountStatsModal: true,
        ScheduledTestsPanel: true,
        SyncFromCrsModal: true,
        TempUnschedStatusModal: true,
        ErrorPassthroughRulesModal: true,
        TLSFingerprintProfilesModal: true,
        TotpStepUpDialog: true,
        CreateAccountModal: true,
        EditAccountModal: true,
        BulkEditAccountModal: true,
        Icon: true,
      },
    },
  })
}

describe('AccountsView Worker synthetic probes', () => {
  beforeEach(() => {
    workerContract.enabled = true
    listModels.mockReset()
    settingsFetch.mockResolvedValue(undefined)
    getAllGroups.mockResolvedValue([])
    listModels.mockResolvedValue({ items: [model], total: 1, page: 1, page_size: 100, pages: 1 })
    listAccounts.mockResolvedValue({ items: [account], total: 1, page: 1, page_size: 20, pages: 1 })
  })

  it('opens the Worker-only modal with selected account data and loaded models', async () => {
    const wrapper = mountView()
    await flushPromises()

    const trigger = wrapper.get('[data-testid="open-synthetic-probes"]')
    expect(trigger.attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    expect(trigger.attributes('disabled')).toBeUndefined()
    await trigger.trigger('click')

    expect(wrapper.get('[data-testid="synthetic-modal-stub"]').text()).toBe('account-1:model-alpha')
  })

  it('does not change the legacy account controls', async () => {
    workerContract.enabled = false
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-testid="open-synthetic-probes"]').exists()).toBe(false)
    expect(listModels).not.toHaveBeenCalled()
  })
})
