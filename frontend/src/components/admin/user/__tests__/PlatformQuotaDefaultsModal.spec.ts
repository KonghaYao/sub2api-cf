import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({ getDefaults: vi.fn(), updateDefaults: vi.fn() }))
const showError = vi.hoisted(() => vi.fn())
const showSuccess = vi.hoisted(() => vi.fn())

vi.mock('@/api/admin', () => ({
  adminAPI: { platformQuotas: apiMocks },
}))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showError, showSuccess }) }))
vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/components/common/BaseDialog.vue', () => ({
  default: {
    props: ['show', 'title', 'width'],
    template: '<div v-if="show"><slot /><slot name="footer" /></div>',
  },
}))

import PlatformQuotaDefaultsModal from '../PlatformQuotaDefaultsModal.vue'

const empty = () => Object.fromEntries(
  ['anthropic', 'openai', 'gemini', 'antigravity', 'grok'].map((platform) => [platform, {
    daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null,
  }]),
)

beforeEach(() => {
  vi.clearAllMocks()
  apiMocks.getDefaults.mockResolvedValue({
    schema_version: 1, control_version: 3, platform_quotas: empty(), updated_at_ms: 1,
  })
  apiMocks.updateDefaults.mockResolvedValue({
    schema_version: 1, control_version: 4, platform_quotas: empty(), updated_at_ms: 2,
  })
})

describe('PlatformQuotaDefaultsModal', () => {
  it('loads the private signup matrix and saves all five platforms with CAS', async () => {
    const wrapper = mount(PlatformQuotaDefaultsModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(apiMocks.getDefaults).toHaveBeenCalledOnce()
    const inputs = wrapper.findAll('input[type="number"]')
    expect(inputs).toHaveLength(15)
    await wrapper.get('[data-test="default-openai-daily"]').setValue('2.5')
    await wrapper.get('[data-test="save-platform-quota-defaults"]').trigger('click')
    await flushPromises()

    expect(apiMocks.updateDefaults).toHaveBeenCalledWith(expect.objectContaining({
      openai: {
        daily_limit_usd: 2.5,
        weekly_limit_usd: null,
        monthly_limit_usd: null,
      },
    }), 3)
    expect(Object.keys(apiMocks.updateDefaults.mock.calls[0][0])).toHaveLength(5)
    expect(showSuccess).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
