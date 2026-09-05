import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import CursorPagination from '../CursorPagination.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: { page: number }) => params ? `${key}:${params.page}` : key }),
}))

describe('CursorPagination', () => {
  it('only exposes bounded previous and next navigation', async () => {
    const wrapper = mount(CursorPagination, { props: { page: 2, hasMore: true } })

    await wrapper.get('[data-testid="cursor-previous"]').trigger('click')
    await wrapper.get('[data-testid="cursor-next"]').trigger('click')

    expect(wrapper.emitted('previous')).toHaveLength(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
    expect(wrapper.text()).toContain('usage.explorer.page:2')
  })

  it('disables navigation that has no known cursor', () => {
    const wrapper = mount(CursorPagination, { props: { page: 1, hasMore: false } })

    expect(wrapper.get('[data-testid="cursor-previous"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="cursor-next"]').attributes('disabled')).toBeDefined()
  })
})
