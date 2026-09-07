import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ post: vi.fn(), persist: vi.fn(), setToken: vi.fn(), replace: vi.fn(), push: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { post: mocks.post } }))
vi.mock('@/api/auth', () => ({ persistOAuthTokenContext: mocks.persist }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ setToken: mocks.setToken }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: mocks.replace, push: mocks.push }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/auth/PendingOAuthCreateAccountForm.vue', () => ({ default: { template: '<div />' } }))
import View from '../WorkerOAuthCompleteView.vue'
const Form = defineComponent({ props: ['initialEmail', 'forceEmailVerification', 'proofAlreadyVerified'], emits: ['submit'], template: '<div />' })
const mountView = () => mount(View, { global: { stubs: { PendingOAuthCreateAccountForm: Form, RouterLink: true } } })
describe('Worker pending OAuth completion', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.post.mockResolvedValue({ data: { email: 'verified@example.test' } }); mocks.setToken.mockResolvedValue(undefined) })
  it('exchanges the browser-bound pending session and completes email verification before storing tokens', async () => {
    const wrapper = mountView()
    await flushPromises()
    const form = wrapper.getComponent(Form)
    expect(form.props()).toMatchObject({ initialEmail: 'verified@example.test', forceEmailVerification: true, proofAlreadyVerified: true })
    mocks.post.mockResolvedValueOnce({ data: { access_token: 'access', refresh_token: 'refresh', redirect: '/dashboard' } })
    form.vm.$emit('submit', { email: 'local@example.test', password: 'password123', verifyCode: '123456', invitationCode: 'invite' })
    await flushPromises()
    expect(mocks.post).toHaveBeenLastCalledWith('/auth/oauth/pending/create-account', { email: 'local@example.test', password: 'password123', verify_code: '123456', invitation_code: 'invite' })
    expect(mocks.setToken).toHaveBeenCalledWith('access')
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard')
  })
  it('does not render account creation or store credentials after pending exchange expires', async () => {
    mocks.post.mockRejectedValueOnce({ message: 'Pending session expired' })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.findComponent(Form).exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toBe('Pending session expired')
    expect(mocks.persist).not.toHaveBeenCalled()
  })
})
