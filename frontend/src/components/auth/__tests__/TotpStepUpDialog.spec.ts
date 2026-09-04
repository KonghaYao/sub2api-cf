import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'

const mocks = vi.hoisted(() => ({
  showError: vi.fn(),
  stepUp: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores', () => ({
  useAppStore: () => ({ showError: mocks.showError }),
}))

vi.mock('@/api', () => ({
  totpAPI: { stepUp: mocks.stepUp },
}))

function controller() {
  return {
    visible: ref(true),
    blockedReason: ref(''),
    prompt: vi.fn(),
    onVerified: vi.fn(),
    onCancel: vi.fn(),
    run: vi.fn(),
  }
}

describe('TotpStepUpDialog', () => {
  beforeEach(() => {
    mocks.showError.mockReset()
    mocks.stepUp.mockReset()
  })

  it('focuses the visible recovery input and keeps it focused after a failed verification', async () => {
    mocks.stepUp.mockRejectedValue(new Error('invalid recovery code'))
    const wrapper = mount(TotpStepUpDialog, {
      props: { controller: controller() },
      attachTo: document.body,
    })

    const toggle = wrapper.findAll('button').find((button) =>
      button.text().includes('profile.totp.useRecoveryCode'),
    )
    expect(toggle).toBeTruthy()
    await toggle!.trigger('click')
    await wrapper.vm.$nextTick()

    const input = wrapper.get('[data-testid="step-up-recovery-code"]')
    expect(document.activeElement).toBe(input.element)
    await input.setValue('abcd efgh jkmn pqrs')
    await wrapper.get('form').trigger('submit.prevent')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(mocks.stepUp).toHaveBeenCalledWith('ABCD-EFGH-JKMN-PQRS')
    expect(mocks.showError).toHaveBeenCalledWith('invalid recovery code')
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('returns to the authenticator input when the dialog is reopened', async () => {
    const stepUpController = controller()
    const wrapper = mount(TotpStepUpDialog, {
      props: { controller: stepUpController },
      attachTo: document.body,
    })
    const toggle = wrapper.findAll('button').find((button) =>
      button.text().includes('profile.totp.useRecoveryCode'),
    )
    await toggle!.trigger('click')
    expect(wrapper.find('[data-testid="step-up-recovery-code"]').exists()).toBe(true)

    stepUpController.visible.value = false
    await wrapper.vm.$nextTick()
    stepUpController.visible.value = true
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="step-up-recovery-code"]').exists()).toBe(false)
    expect(document.activeElement).toBe(
      wrapper.get('input[inputmode="numeric"]:not([aria-hidden="true"])').element,
    )
    wrapper.unmount()
  })
})
