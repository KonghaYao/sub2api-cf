import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DingTalkCallbackView from '../DingTalkCallbackView.vue'
import { setCloudflareWorkerContractActive } from '@/utils/adminCapabilities'

const replace = vi.fn()
const showSuccess = vi.fn()
const showError = vi.fn()
const setToken = vi.fn()
const setPendingAuthSession = vi.fn()
const clearPendingAuthSession = vi.fn()
const exchangePendingOAuthCompletion = vi.fn()
const apiClientPost = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace })
}))

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
      te: () => false
    })
  }
})

vi.mock('@/stores', () => ({
  useAuthStore: () => ({ setToken, setPendingAuthSession, clearPendingAuthSession }),
  useAppStore: () => ({ showSuccess, showError })
}))

vi.mock('@/api/client', () => ({
  apiClient: {
    post: (...args: any[]) => apiClientPost(...args)
  }
}))

vi.mock('@/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@/api/auth')>('@/api/auth')
  return {
    ...actual,
    exchangePendingOAuthCompletion: (...args: any[]) => exchangePendingOAuthCompletion(...args)
  }
})

describe('DingTalkCallbackView', () => {
  beforeEach(() => {
    setCloudflareWorkerContractActive(false)
    replace.mockReset()
    showSuccess.mockReset()
    showError.mockReset()
    setToken.mockReset()
    setPendingAuthSession.mockReset()
    clearPendingAuthSession.mockReset()
    exchangePendingOAuthCompletion.mockReset()
    apiClientPost.mockReset()
    window.location.hash = ''
    localStorage.clear()
    sessionStorage.clear()
  })

  it('rejects a legacy pending invitation fragment in Worker mode', async () => {
    setCloudflareWorkerContractActive(true)
    window.location.hash =
      '#error=invitation_required&pending_oauth_token=legacy-pending-token&redirect=%2Flegacy-invite'

    const wrapper = mount(DingTalkCallbackView, {
      global: {
        stubs: {
          AuthLayout: { template: '<div><slot /></div>' },
          PendingOAuthCreateAccountForm: true,
          transition: false
        }
      }
    })
    await flushPromises()

    expect(exchangePendingOAuthCompletion).not.toHaveBeenCalled()
    expect(apiClientPost).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith('auth.oauth.invalidCallbackHint')
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
  })
})
