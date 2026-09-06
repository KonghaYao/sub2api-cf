import { flushPromises, shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import ChannelsView from '../ChannelsView.vue'
import PricingEntryCard from '@/components/admin/channel/PricingEntryCard.vue'

const { create, getAll, getAccountById, list, syncPricingModels, update } = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getAll: vi.fn().mockResolvedValue([]),
  getAccountById: vi.fn(),
  syncPricingModels: vi.fn().mockResolvedValue({ models: ['claude-sonnet-4'] }),
  update: vi.fn(),
}))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    channels: { create, list, syncPricingModels, update },
    groups: { getAll },
    accounts: { getById: getAccountById },
  },
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn() }),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({
    t: (key: string, value?: unknown, fallback?: string) =>
      fallback ?? (typeof value === 'string' ? value : key),
  }),
}))

vi.mock('@/utils/adminCapabilities', () => ({
  isCloudflareWorkerContractActive: () => true,
}))

describe('ChannelsView Worker pricing helpers', () => {
  it('shows model sync and enables default-price autofill in Worker mode', async () => {
    const wrapper = shallowMount(ChannelsView, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          TablePageLayout: {
            template: '<div><slot name="filters"/><slot name="table"/><slot name="pagination"/></div>',
          },
          BaseDialog: {
            props: ['show', 'title', 'width'],
            emits: ['close'],
            template: '<div><slot /><slot name="footer" /></div>',
          },
          ConfirmDialog: true,
        },
      },
    })

    const anthropicLabel = wrapper.findAll('label').find((label) => label.text() === 'anthropic')
    const anthropic = anthropicLabel?.find('input[type="checkbox"]')
    expect(anthropic?.exists()).toBe(true)
    if (anthropic === undefined) throw new Error('anthropic channel checkbox is missing')
    await anthropic.trigger('change')
    await nextTick()

    expect(wrapper.text()).toContain('admin.channels.form.syncLatestModels')
    const syncButton = wrapper.findAll('button').find(
      (button) => button.text().includes('admin.channels.form.syncLatestModels'),
    )
    expect(syncButton).toBeDefined()
    if (syncButton === undefined) throw new Error('model sync button is missing')
    await syncButton.trigger('click')
    await flushPromises()

    const pricing = wrapper.findComponent(PricingEntryCard)
    expect(pricing.props('enableDefaultPricing')).toBe(true)
    expect(pricing.props('entry')).toMatchObject({ models: ['claude-sonnet-4'] })
    expect(syncPricingModels).toHaveBeenCalledWith('anthropic')
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('offers every route-time Worker billing source and exposes account-stat pricing controls', async () => {
    const wrapper = shallowMount(ChannelsView, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          TablePageLayout: {
            template: '<div><slot name="filters"/><slot name="table"/><slot name="pagination"/></div>',
          },
          BaseDialog: {
            props: ['show', 'title', 'width'],
            emits: ['close'],
            template: '<div><slot /><slot name="footer" /></div>',
          },
          ConfirmDialog: true,
        },
      },
    })

    const billingSource = wrapper.findComponent('[data-testid="channel-billing-model-source"]')
    expect(billingSource.exists()).toBe(true)
    expect(billingSource.props('options')).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'channel_mapped' }),
      expect.objectContaining({ value: 'requested' }),
      expect.objectContaining({ value: 'upstream' }),
    ]))

    const anthropicLabel = wrapper.findAll('label').find((label) => label.text() === 'anthropic')
    const anthropic = anthropicLabel?.find('input[type="checkbox"]')
    if (anthropic === undefined) throw new Error('anthropic channel checkbox is missing')
    await anthropic.trigger('change')
    await nextTick()

    expect(wrapper.text()).toContain('admin.channels.form.accountStatsPricingRules')
    expect(wrapper.text()).toContain('admin.channels.form.applyPricingToAccountStats')
  })

  it('round-trips multi-platform and platform-neutral account-stat prices without rewriting them', async () => {
    getAll.mockResolvedValue([
      { id: 'anthropic-group', name: 'Anthropic', platform: 'anthropic' },
      { id: 'openai-group', name: 'OpenAI', platform: 'openai' },
    ])
    getAccountById.mockResolvedValue({ id: 'account-uuid', name: 'Shared account', platform: 'openai' })
    update.mockResolvedValue({})
    const wrapper = shallowMount(ChannelsView, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          TablePageLayout: {
            template: '<div><slot name="filters"/><slot name="table"/><slot name="pagination"/></div>',
          },
          BaseDialog: {
            props: ['show', 'title', 'width'],
            emits: ['close'],
            template: '<div><slot /><slot name="footer" /></div>',
          },
          ConfirmDialog: true,
        },
      },
    })
    const tokenPrice = (platform: string, model: string, inputPrice: number) => ({
      platform,
      models: [model],
      billing_mode: 'token' as const,
      input_price: inputPrice,
      output_price: inputPrice * 2,
      cache_write_price: null,
      cache_read_price: null,
      image_input_price: null,
      image_output_price: null,
      per_request_price: null,
      intervals: [],
      time_pricing: null,
    })
    const channel = {
      id: 'channel-uuid',
      name: 'Mixed stats pricing',
      description: '',
      status: 'active' as const,
      billing_model_source: 'channel_mapped' as const,
      restrict_models: false,
      features_config: {},
      group_ids: ['openai-group', 'anthropic-group'],
      model_pricing: [],
      model_mapping: {},
      apply_pricing_to_account_stats: true,
      account_stats_pricing_rules: [
        {
          name: 'Mixed providers',
          group_ids: ['openai-group', 'anthropic-group'],
          account_ids: [],
          pricing: [
            tokenPrice('openai', 'gpt-5', 0.000001),
            tokenPrice('anthropic', 'claude-sonnet-4', 0.000003),
          ],
        },
        {
          name: 'Provider neutral account',
          group_ids: [],
          account_ids: ['account-uuid'],
          pricing: [tokenPrice('', 'shared-*', 0.0000005)],
        },
      ],
      created_at: '2026-09-06T00:00:00.000Z',
      updated_at: '2026-09-06T00:00:00.000Z',
      control_version: 2,
    }

    const vm = wrapper.vm as unknown as {
      openEditDialog: (value: typeof channel) => Promise<void>
      handleSubmit: () => Promise<void>
    }
    await vm.openEditDialog(channel)
    const accountStatsPricing = wrapper.findAllComponents(PricingEntryCard).at(-1)
    expect(accountStatsPricing?.props('accountStatsWorkerMode')).toBe(true)
    expect(accountStatsPricing?.props('enableDefaultPricing')).toBe(false)
    await vm.handleSubmit()

    const request = update.mock.calls.at(-1)?.[1]
    const mixed = request.account_stats_pricing_rules.find((rule: { name: string }) => rule.name === 'Mixed providers')
    const neutral = request.account_stats_pricing_rules.find((rule: { name: string }) => rule.name === 'Provider neutral account')
    expect(mixed.pricing.map((price: { platform: string }) => price.platform)).toEqual(['openai', 'anthropic'])
    expect(neutral.pricing[0].platform).toBe('')
    expect(request.apply_pricing_to_account_stats).toBe(true)
  })
})
