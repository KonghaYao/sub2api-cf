import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const { fetchVersion, fetchAdminSettings, performUpdate, restartService, rollback } = vi.hoisted(() => ({
  fetchVersion: vi.fn(),
  fetchAdminSettings: vi.fn().mockResolvedValue(undefined),
  performUpdate: vi.fn(),
  restartService: vi.fn(),
  rollback: vi.fn(),
}))

vi.mock('@/stores', () => ({
  useAuthStore: () => ({ isAdmin: true }),
  useAppStore: () => ({
    currentVersion: '',
    latestVersion: '',
    versionLoading: false,
    hasUpdate: false,
    releaseInfo: null,
    buildType: '',
    fetchVersion,
  }),
  useAdminSettingsStore: () => ({
    cloudflareWorkerContract: true,
    fetch: fetchAdminSettings,
  }),
}))

vi.mock('@/api/admin/system', () => ({
  performUpdate,
  restartService,
  getRollbackVersions: vi.fn(),
  rollback,
}))

vi.mock('@/composables/useClipboard', () => ({
  useClipboard: () => ({
    copied: { value: false },
    copyToClipboard: vi.fn(),
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import VersionBadge from '../VersionBadge.vue'

describe('VersionBadge Worker contract', () => {
  it('renders static APP_VERSION text without lifecycle API calls', async () => {
    const wrapper = mount(VersionBadge, {
      props: { version: '1.2.3' },
      global: { stubs: { Icon: true } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('v1.2.3')
    expect(wrapper.find('button').exists()).toBe(false)
    expect(fetchAdminSettings).toHaveBeenCalledOnce()
    expect(fetchVersion).not.toHaveBeenCalled()
    expect(performUpdate).not.toHaveBeenCalled()
    expect(restartService).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
  })
})
