import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SyntheticProbeModal from '../SyntheticProbeModal.vue'

const { queueSyntheticProbes, listSyntheticProbeHistory } = vi.hoisted(() => ({
  queueSyntheticProbes: vi.fn(),
  listSyntheticProbeHistory: vi.fn(),
}))

vi.mock('@/api/admin/accounts', () => ({
  queueSyntheticProbes,
  listSyntheticProbeHistory,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => params
      ? `${key}:${Object.values(params).join(':')}`
      : key,
  }),
}))

const models = [{
  id: 'model-alpha',
  platform: 'openai',
  public_name: 'Model Alpha',
  upstream_name: 'model-alpha',
  endpoint: 'both',
  embeddings: true,
  image_generation: false,
  enabled: true,
  control_version: 3,
}]

const accounts = [{
  id: 'account-1',
  name: 'Primary account',
  platform: 'openai',
  control_version: 7,
  model_capabilities: [{
    model_id: 'model-alpha',
    chat_completions: true,
    responses: true,
    embeddings: true,
    image_generation: true,
    control_version: 2,
  }],
}]

function mountModal(overrides: Record<string, unknown> = {}) {
  return mount(SyntheticProbeModal, {
    props: {
      show: true,
      accounts,
      models,
      ...overrides,
    } as never,
    global: {
      stubs: {
        BaseDialog: {
          props: ['show', 'title'],
          emits: ['close'],
          template: '<div v-if="show"><slot /><slot name="footer" /></div>',
        },
        Icon: true,
      },
    },
  })
}

describe('SyntheticProbeModal', () => {
  beforeEach(() => {
    queueSyntheticProbes.mockReset()
    listSyntheticProbeHistory.mockReset()
    listSyntheticProbeHistory.mockResolvedValue({ items: [], has_more: false, next_cursor: null })
  })

  it('queues only legal account/model/capability targets and exposes accepted and stale results', async () => {
    queueSyntheticProbes.mockResolvedValue({
      total: 2,
      queued: 1,
      failed: 1,
      queued_ids: ['account-1'],
      failed_ids: ['account-1'],
      results: [
        {
          account_id: 'account-1', expected_control_version: 7,
          model_id: 'model-alpha', capability: 'responses', success: true,
          generation: 4, job_id: 'queued-job',
        },
        {
          account_id: 'account-1', expected_control_version: 7,
          model_id: 'model-alpha', capability: 'embeddings', success: false,
          error: { code: 'account_version_conflict', message: 'Account changed; reload it and retry' },
        },
      ],
    })
    const wrapper = mountModal()
    await flushPromises()

    expect(wrapper.find('[data-testid="synthetic-target-account-1-model-alpha-image_generation"]').exists()).toBe(false)
    await wrapper.get('[data-testid="synthetic-target-account-1-model-alpha-responses"]').setValue(true)
    await wrapper.get('[data-testid="synthetic-target-account-1-model-alpha-embeddings"]').setValue(true)
    await wrapper.get('[data-testid="synthetic-run"]').trigger('click')
    await flushPromises()

    expect(queueSyntheticProbes).toHaveBeenCalledWith([
      {
        account_id: 'account-1', expected_control_version: 7,
        model_id: 'model-alpha', capability: 'responses',
      },
      {
        account_id: 'account-1', expected_control_version: 7,
        model_id: 'model-alpha', capability: 'embeddings',
      },
    ])
    expect(wrapper.get('[data-testid="synthetic-results"]').text()).toContain('queued-job')
    expect(wrapper.get('[data-testid="synthetic-results"]').text()).toContain('account_version_conflict')
    expect(wrapper.get('[data-testid="synthetic-results"]').text()).not.toContain('credential')
  })

  it('handles no legal models and enforces the 25-target limit without duplicates', async () => {
    const empty = mountModal({ models: [] })
    await flushPromises()
    expect(empty.get('[data-testid="synthetic-probe-empty"]').exists()).toBe(true)
    expect(empty.get('[data-testid="synthetic-run"]').attributes('disabled')).toBeDefined()

    const manyAccounts = Array.from({ length: 26 }, (_, index) => ({
      ...accounts[0],
      id: `account-${index}`,
      name: `Account ${index}`,
    }))
    const wrapper = mountModal({ accounts: manyAccounts })
    await flushPromises()
    const targets = wrapper.findAll('[data-testid^="synthetic-target-"]')
    for (const target of targets.slice(0, 25)) await target.setValue(true)
    await targets[25].setValue(true)

    expect(wrapper.get('[data-testid="synthetic-selection-count"]').text()).toContain('25')
    expect(wrapper.get('[data-testid="synthetic-limit-error"]').exists()).toBe(true)
    expect(new Set(targets.map((target) => target.attributes('data-testid'))).size).toBe(targets.length)
  })

  it('keeps the selected target available for retry after a queueing error', async () => {
    queueSyntheticProbes
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce({
        total: 1, queued: 1, failed: 0, queued_ids: ['account-1'], failed_ids: [],
        results: [{
          account_id: 'account-1', expected_control_version: 7,
          model_id: 'model-alpha', capability: 'responses', success: true, job_id: 'retry-job',
        }],
      })
    const wrapper = mountModal()
    await flushPromises()
    await wrapper.get('[data-testid="synthetic-target-account-1-model-alpha-responses"]').setValue(true)

    await wrapper.get('[data-testid="synthetic-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="synthetic-submit-error"]').text()).toContain('queue unavailable')

    await wrapper.get('[data-testid="synthetic-run"]').trigger('click')
    await flushPromises()
    expect(queueSyntheticProbes).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="synthetic-results"]').text()).toContain('retry-job')
  })

  it('retries failed history and appends the next page with an opaque cursor', async () => {
    const firstPage = {
      items: [{
        id: 'history-1', job_id: 'job-1', account_id: 'account-1', model_id: 'model-alpha',
        capability: 'responses', generation: 2, outcome: 'failed',
        error_code: 'upstream_http_error', upstream_status: 429, latency_ms: 87,
        alert_transition: 'firing', checked_at_ms: 1_788_451_260_000,
      }],
      has_more: true,
      next_cursor: 'opaque+/cursor==',
    }
    const secondPage = {
      items: [{
        ...firstPage.items[0], id: 'history-2', outcome: 'succeeded', error_code: null,
        latency_ms: 41, checked_at_ms: 1_788_451_261_000,
      }],
      has_more: false,
      next_cursor: null,
    }
    listSyntheticProbeHistory
      .mockRejectedValueOnce(new Error('history unavailable'))
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)

    const wrapper = mountModal()
    await flushPromises()
    expect(wrapper.get('[data-testid="synthetic-history-error"]').text()).toContain('history unavailable')

    await wrapper.get('[data-testid="synthetic-history-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="synthetic-history"]').text()).toContain('upstream_http_error')
    expect(wrapper.get('[data-testid="synthetic-history"]').text()).toContain('87')

    await wrapper.get('[data-testid="synthetic-history-more"]').trigger('click')
    await flushPromises()
    expect(listSyntheticProbeHistory).toHaveBeenLastCalledWith({
      account_id: 'account-1', limit: 25, cursor: 'opaque+/cursor==',
    })
    expect(wrapper.findAll('[data-testid="synthetic-history-row"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="synthetic-history"]').text()).not.toContain('response_body')
  })
})
