import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AccountBulkActionsBar from '../AccountBulkActionsBar.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

describe('AccountBulkActionsBar', () => {
  it('allows selecting all results before any row is selected', async () => {
    const wrapper = mount(AccountBulkActionsBar, {
      props: {
        selectedIds: [],
        totalResults: 45,
        selectingAll: false,
        allResultsSelected: false
      }
    })

    const button = wrapper.findAll('button').find(item =>
      item.text().includes('admin.accounts.bulkActions.selectAllResults')
    )

    expect(button).toBeDefined()
    await button!.trigger('click')
    expect(wrapper.emitted('select-all-results')).toHaveLength(1)
  })

  it('preserves the upstream billing probe action from v0.1.166', async () => {
    const wrapper = mount(AccountBulkActionsBar, {
      props: {
        selectedIds: [1],
        totalResults: 45,
        selectingAll: false,
        allResultsSelected: false
      }
    })

    const button = wrapper.findAll('button').find(item =>
      item.text().includes('admin.accounts.bulkActions.probeUpstreamBilling')
    )

    expect(button).toBeDefined()
    await button!.trigger('click')
    expect(wrapper.emitted('probe-upstream-billing')).toHaveLength(1)
  })

  it('keeps the original batch controls in Worker mode', async () => {
    const wrapper = mount(AccountBulkActionsBar, {
      props: {
        selectedIds: [1],
        totalResults: 2,
        selectingAll: false,
        allResultsSelected: false,
        cloudflareWorker: true,
      }
    })

    const labels = wrapper.findAll('button').map((button) => button.text())
    expect(labels).toContain('admin.accounts.bulkActions.enableScheduling')
    expect(labels).toContain('admin.accounts.bulkActions.disableScheduling')
    expect(labels).toContain('admin.accounts.bulkActions.delete')
    expect(labels).toContain('admin.accounts.bulkActions.refreshToken')
    expect(labels).toContain('admin.accounts.bulkActions.probeUpstreamBilling')
    expect(labels).toContain('admin.accounts.bulkActions.edit')
    expect(labels).toContain('admin.accounts.bulkEdit.submit')
    expect(labels).toContain('admin.accounts.bulkActions.selectAllResults')
    expect(labels).not.toContain('admin.accounts.testConnection')
  })
})
