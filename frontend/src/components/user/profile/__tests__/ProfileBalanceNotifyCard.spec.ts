import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileBalanceNotifyCard from '@/components/user/profile/ProfileBalanceNotifyCard.vue'

const { updateProfileMock, authState } = vi.hoisted(() => ({
  updateProfileMock: vi.fn(),
  authState: { user: null as Record<string, unknown> | null }
}))

vi.mock('@/api', () => ({
  userAPI: {
    updateProfile: updateProfileMock,
    sendNotifyEmailCode: vi.fn(),
    verifyNotifyEmail: vi.fn(),
    removeNotifyEmail: vi.fn(),
    toggleNotifyEmail: vi.fn()
  }
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => authState
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn() })
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

describe('ProfileBalanceNotifyCard', () => {
  beforeEach(() => {
    updateProfileMock.mockReset()
    authState.user = {
      id: 'user-1',
      balance_notify_extra_emails: [],
      notification_preferences_version: 8
    }
    updateProfileMock.mockResolvedValue(authState.user)
  })

  it('sends null when the threshold input is cleared so the system default is restored', async () => {
    const wrapper = mount(ProfileBalanceNotifyCard, {
      props: {
        enabled: true,
        threshold: 5,
        extraEmails: [],
        notificationPreferencesVersion: 7,
        systemDefaultThreshold: 10,
        userEmail: 'owner@example.test'
      }
    })

    await wrapper.get('input[type="number"]').setValue('')
    await wrapper.get('button.btn-primary').trigger('click')
    await flushPromises()

    expect(updateProfileMock).toHaveBeenCalledWith({
      balance_notify_threshold: null,
      notification_preferences_version: 7
    })
  })
})
