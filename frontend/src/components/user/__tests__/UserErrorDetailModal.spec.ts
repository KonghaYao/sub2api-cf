import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import UserErrorDetailModal from '../UserErrorDetailModal.vue'

const { getMyErrorDetail } = vi.hoisted(() => ({ getMyErrorDetail: vi.fn() }))

vi.mock('@/api/usage', () => ({ getMyErrorDetail }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))

const baseDetail = {
  id: 'err_opaque',
  created_at: '2026-09-05T00:00:00.000Z',
  model: 'gpt-5',
  inbound_endpoint: '/v1/responses',
  status_code: 500,
  category: 'upstream',
  platform: 'openai',
  message: 'failed',
  key_name: 'redacted-key',
  key_deleted: false,
}

function mountModal() {
  return mount(UserErrorDetailModal, {
    props: { show: false, errorId: 'err_opaque' },
    global: {
      stubs: {
        BaseDialog: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
      },
    },
  })
}

describe('UserErrorDetailModal payload safety', () => {
  beforeEach(() => getMyErrorDetail.mockReset())

  it('renders HTML-looking JSON only as text and preserves opaque IDs', async () => {
    getMyErrorDetail.mockResolvedValue({
      ...baseDetail,
      payload: {
        state: 'available',
        body: '{"message":"<img src=x onerror=alert(1)>"}',
        content_type: 'application/json',
        redacted: true,
      },
    })

    const wrapper = mountModal()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(getMyErrorDetail).toHaveBeenCalledWith('err_opaque')
    expect(wrapper.find('[data-testid="error-payload"]').text()).toContain('<img src=x onerror=alert(1)>')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('usage.explorer.payload.redacted')
  })

  it.each(['missing', 'expired', 'pending_recovery'] as const)('shows the %s payload state', async (state) => {
    getMyErrorDetail.mockResolvedValue({
      ...baseDetail,
      payload: { state, body: null, content_type: null, redacted: false },
    })

    const wrapper = mountModal()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.text()).toContain(`usage.explorer.payload.${state}`)
    expect(wrapper.find('[data-testid="error-payload"]').exists()).toBe(false)
  })
})
