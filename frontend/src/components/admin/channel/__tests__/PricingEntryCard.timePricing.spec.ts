import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PricingEntryCard from '../PricingEntryCard.vue'
import type { PricingFormEntry } from '../types'

const { getModelDefaultPricing } = vi.hoisted(() => ({
  getModelDefaultPricing: vi.fn(),
}))

vi.mock('@/api/admin/channels', () => ({
  default: { getModelDefaultPricing },
  getModelDefaultPricing,
}))

vi.mock('vue-i18n', async importOriginal => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))

function createEntry(billingMode: PricingFormEntry['billing_mode'] = 'token'): PricingFormEntry {
  return {
    models: [],
    billing_mode: billingMode,
    input_price: null,
    output_price: null,
    cache_write_price: null,
    cache_read_price: null,
    fast_multiplier: null,
    flex_multiplier: null,
    image_input_price: null,
    image_output_price: null,
    per_request_price: null,
    intervals: [],
    time_pricing: {
      timezone: 'Asia/Shanghai',
      periods: [{ start_time: '09:00', end_time: '12:00', multiplier: '2.00' }],
    },
  }
}

beforeEach(() => {
  getModelDefaultPricing.mockReset()
})

describe('PricingEntryCard time pricing visibility', () => {
  it('is hidden by default', () => {
    const wrapper = shallowMount(PricingEntryCard, {
      props: { entry: createEntry() },
    })

    expect(wrapper.findComponent({ name: 'TimePricingSection' }).exists()).toBe(false)
  })

  it('is shown for token pricing when explicitly enabled', () => {
    const wrapper = shallowMount(PricingEntryCard, {
      props: { entry: createEntry(), enableTimePricing: true },
    })

    expect(wrapper.findComponent({ name: 'TimePricingSection' }).exists()).toBe(true)
  })

  it('is hidden for non-token pricing even when explicitly enabled', () => {
    const wrapper = shallowMount(PricingEntryCard, {
      props: { entry: createEntry('per_request'), enableTimePricing: true },
    })

    expect(wrapper.findComponent({ name: 'TimePricingSection' }).exists()).toBe(false)
  })

  it('clears time periods when changing billing mode', () => {
    const entry = createEntry()
    const wrapper = shallowMount(PricingEntryCard, {
      props: { entry, enableTimePricing: true },
    })

    wrapper.findComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'image')

    expect(wrapper.emitted('update')?.[0]?.[0]).toEqual({
      ...entry,
      billing_mode: 'image',
      intervals: [],
      time_pricing: { timezone: 'Asia/Shanghai', periods: [] },
    })
    expect(entry.time_pricing.periods).toHaveLength(1)
  })
})

describe('PricingEntryCard service tier multipliers', () => {
  it('shows Fast and Flex controls only when explicitly enabled', () => {
    const hidden = shallowMount(PricingEntryCard, { props: { entry: createEntry() } })
    expect(hidden.text()).not.toContain('admin.channels.form.fastMultiplier')

    const shown = shallowMount(PricingEntryCard, {
      props: { entry: createEntry(), enableTierMultipliers: true },
    })
    expect(shown.text()).toContain('admin.channels.form.fastMultiplier')
    expect(shown.text()).toContain('admin.channels.form.flexMultiplier')
  })
})

describe('PricingEntryCard account-stat form parity', () => {
  it('keeps cache-write, image-token and interval controls visible', () => {
    const entry = {
      ...createEntry(),
      intervals: [{
        min_tokens: 0,
        max_tokens: null,
        tier_label: '',
        input_price: 1,
        output_price: null,
        cache_write_price: null,
        cache_write_1h_price: null,
        cache_read_price: null,
        input_multiplier: null,
        output_multiplier: null,
        cache_write_multiplier: null,
        cache_read_multiplier: null,
        per_request_price: null,
        sort_order: 0,
      }],
    }
    const wrapper = shallowMount(PricingEntryCard, { props: { entry } })

    expect(wrapper.text()).toContain('admin.channels.form.cacheWrite5mPrice')
    expect(wrapper.text()).toContain('admin.channels.form.cacheWrite1hPrice')
    expect(wrapper.text()).toContain('admin.channels.form.imageInputPrice')
    expect(wrapper.text()).toContain('admin.channels.form.imageTokenPrice')
    expect(wrapper.text()).toContain('admin.channels.form.inputPrice')
    expect(wrapper.text()).toContain('admin.channels.form.outputPrice')
    expect(wrapper.text()).toContain('admin.channels.form.cacheReadPrice')
    expect(wrapper.findComponent({ name: 'IntervalRow' }).props('hideCacheWritePrices')).toBeFalsy()
  })

  it.each(['per_request', 'image'] as const)('keeps tiers editable for %s', (billingMode) => {
    const entry = {
      ...createEntry(billingMode),
      intervals: [{
        min_tokens: 0, max_tokens: null, tier_label: 'legacy', input_price: null,
        output_price: null, cache_write_price: null, cache_write_1h_price: null,
        cache_read_price: null, input_multiplier: null, output_multiplier: null,
        cache_write_multiplier: null, cache_read_multiplier: null,
        per_request_price: 1, sort_order: 0,
      }],
    }
    const wrapper = shallowMount(PricingEntryCard, { props: { entry } })

    expect(wrapper.findComponent({ name: 'IntervalRow' }).exists()).toBe(true)
    expect(wrapper.text()).toContain('admin.channels.form.addTier')
  })
})

describe('PricingEntryCard default-price autofill', () => {
  it('fills blank prices from the first newly-added model using dollars per MTok', async () => {
    getModelDefaultPricing.mockResolvedValue({
      found: true,
      input_price: 3e-6,
      output_price: 15e-6,
      cache_write_price: 3.75e-6,
      cache_write_1h_price: null,
      cache_read_price: 0.3e-6,
      image_input_price: 0,
      image_output_price: 0,
    })
    const entry = createEntry()
    const wrapper = shallowMount(PricingEntryCard, { props: { entry } })

    wrapper.findComponent({ name: 'ModelTagInput' }).vm.$emit(
      'update:models',
      ['claude-sonnet-4'],
    )
    await flushPromises()

    expect(getModelDefaultPricing).toHaveBeenCalledWith('claude-sonnet-4')
    expect(wrapper.emitted('update')?.[1]?.[0]).toMatchObject({
      models: ['claude-sonnet-4'],
      input_price: 3,
      output_price: 15,
      cache_write_price: 3.75,
      cache_write_1h_price: null,
      cache_read_price: 0.3,
      image_input_price: 0,
      image_output_price: 0,
    })
  })

  it('never queries or overwrites defaults once any token price is present', async () => {
    const entry = { ...createEntry(), input_price: 9 }
    const wrapper = shallowMount(PricingEntryCard, {
      props: { entry, enableDefaultPricing: true },
    })

    wrapper.findComponent({ name: 'ModelTagInput' }).vm.$emit(
      'update:models',
      ['claude-sonnet-4'],
    )
    await flushPromises()

    expect(getModelDefaultPricing).not.toHaveBeenCalled()
    expect(wrapper.emitted('update')).toEqual([[{
      ...entry,
      models: ['claude-sonnet-4'],
    }]])
  })
})
