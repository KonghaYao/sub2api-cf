import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import UserAllowedGroupsModal from '../UserAllowedGroupsModal.vue'

const { getAll, updateAllowedGroups } = vi.hoisted(() => ({
  getAll: vi.fn(),
  updateAllowedGroups: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn() }),
}))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    groups: { getAll },
    users: { updateAllowedGroups },
  },
}))

describe('UserAllowedGroupsModal Worker group selector', () => {
  beforeEach(() => {
    getAll.mockReset()
    updateAllowedGroups.mockReset()
    getAll.mockResolvedValue([
      {
        id: 'group-active',
        name: 'Worker Active Group',
        platform: 'openai',
        subscription_type: 'standard',
        status: 'active',
        is_exclusive: false,
        rate_multiplier: 1,
      },
    ])
  })

  it('loads the semantic active-group collection without an oversized paginated request', async () => {
    const wrapper = mount(UserAllowedGroupsModal, {
      props: {
        show: false,
        user: {
          id: 'user-1',
          email: 'user@example.test',
          allowed_groups: [],
          group_rates: {},
          restrict_public_groups: false,
        } as never,
      },
      global: {
        stubs: {
          BaseDialog: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
          PlatformIcon: true,
        },
      },
    })

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(getAll).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('Worker Active Group')
  })
})
