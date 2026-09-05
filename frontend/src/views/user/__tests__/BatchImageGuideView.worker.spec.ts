import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const batchMocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  listItems: vi.fn(),
  listJobs: vi.fn(),
  listModels: vi.fn(),
}))

const keysList = vi.hoisted(() => vi.fn())
const groupsList = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  keysAPI: { list: keysList },
}))

vi.mock('@/api/groups', () => ({
  userGroupsAPI: { getAvailable: groupsList },
}))

vi.mock('@/api/batchImage', () => ({
  cancelBatchImageJob: vi.fn(),
  deleteBatchImageJobRecord: vi.fn(),
  downloadBatchImageZip: vi.fn(),
  getBatchImageItemContent: vi.fn(),
  getBatchImageJob: batchMocks.getJob,
  listBatchImageItems: batchMocks.listItems,
  listBatchImageJobs: batchMocks.listJobs,
  listBatchImageModels: batchMocks.listModels,
  saveBlob: vi.fn(),
  submitBatchImageJob: vi.fn(),
}))

vi.mock('@/composables/useBatchImageAccess', () => ({
  keyAllowsBatchImage: () => true,
}))

vi.mock('@/composables/useClipboard', () => ({
  useClipboard: () => ({ copyToClipboard: vi.fn() }),
}))

vi.mock('@/composables/usePersistedPageSize', () => ({
  getPersistedPageSize: () => 20,
  setPersistedPageSize: vi.fn(),
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    apiBaseUrl: '',
    fetchPublicSettings: vi.fn(),
    showError: vi.fn(),
    showSuccess: vi.fn(),
  }),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    locale: { value: 'en' },
    t: (key: string) => key,
  }),
}))

import BatchImageGuideView from '../BatchImageGuideView.vue'

const job = {
  id: 'batch-175',
  object: 'image.batch',
  task_name: 'job-175',
  parent_batch_id: null,
  status: 'completed',
  model: 'gemini-2.5-flash-image',
  provider: 'gemini_api',
  item_count: 175,
  success_count: 175,
  fail_count: 0,
  estimated_cost: 17.5,
  hold_amount: 10.5,
  actual_cost: 17.5,
  created_at: 1_788_000_000,
  submitted_at: 1_788_000_001,
  settled_at: 1_788_000_100,
  downloaded_at: null,
}

describe('BatchImageGuideView Worker item list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    keysList.mockResolvedValue({
      items: [{ id: 7, name: 'Gemini key', status: 'active', group_id: 1 }],
      pages: 1,
    })
    groupsList.mockResolvedValue([])
    batchMocks.listModels.mockResolvedValue({ object: 'list', data: [] })
    batchMocks.listJobs.mockResolvedValue({ object: 'list', data: [job], has_more: false })
    batchMocks.getJob.mockResolvedValue(job)
    batchMocks.listItems.mockResolvedValue({
      object: 'list',
      data: Array.from({ length: 175 }, (_, index) => ({
        custom_id: `item-${index + 1}`,
        status: 'succeeded',
        prompt_preview: `Prompt ${index + 1}`,
        mime_type: 'image/png',
        file_extension: 'png',
        image_count: 1,
      })),
      has_more: false,
    })
  })

  it('renders every item returned by a <=200 Worker task instead of clipping at 100', async () => {
    const wrapper = mount(BatchImageGuideView, {
      global: {
        stubs: {
          AppLayout: { template: '<main><slot /></main>' },
          TablePageLayout: {
            template: '<div><slot name="filters" /><slot name="table" /><slot name="pagination" /></div>',
          },
          DataTable: {
            props: ['data'],
            template: '<div><div v-for="row in data" :key="row.id"><slot name="cell-id" :row="row" /></div></div>',
          },
          BaseDialog: {
            props: ['show'],
            template: '<section v-if="show" data-test="dialog"><slot /></section>',
          },
          SearchInput: true,
          Select: true,
          Icon: true,
          Teleport: true,
          'i18n-t': { template: '<span><slot name="count" /></span>' },
        },
      },
    })
    await flushPromises()

    const jobButton = wrapper.findAll('button').find(button => button.text().includes('job-175'))
    expect(jobButton).toBeDefined()
    await jobButton!.trigger('click')
    await flushPromises()

    expect(batchMocks.listItems).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 'batch-175')
    expect(wrapper.findAll('[data-test="dialog"] tbody tr')).toHaveLength(175)
    expect(wrapper.text()).toContain('item-175')

    wrapper.unmount()
  })
})
