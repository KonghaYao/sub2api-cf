import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TotpLoginModal from '@/components/auth/TotpLoginModal.vue'

const { showErrorMock } = vi.hoisted(() => ({
  showErrorMock: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/stores', () => ({
  useAppStore: () => ({
    showError: (...args: any[]) => showErrorMock(...args),
  }),
}))

describe('TotpLoginModal', () => {
  beforeEach(() => {
    showErrorMock.mockReset()
  })

  it('sends verification errors to toast and does not render inline red text', async () => {
    const wrapper = mount(TotpLoginModal, {
      props: {
        tempToken: 'temp-token',
        userEmailMasked: 'u***@example.com',
      },
    })

    ;(wrapper.vm as unknown as { setError: (message: string) => void }).setError('Invalid code')
    await wrapper.vm.$nextTick()

    expect(showErrorMock).toHaveBeenCalledWith('Invalid code')
    expect(wrapper.text()).not.toContain('Invalid code')
    expect(wrapper.find('.bg-red-50').exists()).toBe(false)
  })

  it('normalizes and submits a one-time recovery code', async () => {
    const wrapper = mount(TotpLoginModal, {
      props: { tempToken: 'temp-token' },
    })

    const toggle = wrapper.findAll('button').find((button) =>
      button.text().includes('profile.totp.useRecoveryCode'),
    )
    expect(toggle).toBeTruthy()
    await toggle!.trigger('click')
    const input = wrapper.get('[data-testid="totp-recovery-code"]')
    await input.setValue('abcd efgh jkmn pqrs')
    expect((input.element as HTMLInputElement).value).toBe('ABCD-EFGH-JKMN-PQRS')
    await wrapper.get('form').trigger('submit.prevent')

    expect(wrapper.emitted('verify')).toEqual([['ABCD-EFGH-JKMN-PQRS']])
  })
})
