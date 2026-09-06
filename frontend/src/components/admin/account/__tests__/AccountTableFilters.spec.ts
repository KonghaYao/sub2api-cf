import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AccountTableFilters from '../AccountTableFilters.vue'

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

const SelectStub = {
  props: ['modelValue', 'options'],
  template: '<div data-test="select">{{ options.map((option) => option.value).join(",") }}</div>'
}

const SearchInputStub = { template: '<input data-test="search" />' }
const filters = { platform: '', type: '', status: '', privacy_mode: '', group: '' }

describe('AccountTableFilters Worker contract', () => {
  it('shows only search, platform, status, and group controls for Worker accounts', () => {
    const wrapper = mount(AccountTableFilters, {
      props: { searchQuery: '', filters, groups: [{ id: 'group-1', name: 'Primary' }], cloudflareWorker: true },
      global: { stubs: { Select: SelectStub, SearchInput: SearchInputStub } }
    })
    expect(wrapper.get('[data-test="search"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="select"]')).toHaveLength(3)
    expect(wrapper.text()).not.toContain('oauth')
    expect(wrapper.text()).not.toContain('__unset__')
    expect(wrapper.text()).toContain('group-1')
  })

  it('keeps type and privacy controls for the legacy API', () => {
    const wrapper = mount(AccountTableFilters, {
      props: { searchQuery: '', filters },
      global: { stubs: { Select: SelectStub, SearchInput: SearchInputStub } }
    })
    expect(wrapper.findAll('[data-test="select"]')).toHaveLength(5)
    expect(wrapper.text()).toContain('oauth')
    expect(wrapper.text()).toContain('__unset__')
  })
})
