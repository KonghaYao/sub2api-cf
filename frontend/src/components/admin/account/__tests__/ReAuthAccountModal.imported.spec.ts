import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
const { update } = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('@/api/admin', () => ({ adminAPI: { accounts: { update } } }))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn() }) }))
vi.mock('vue-i18n', async () => ({ ...await vi.importActual<typeof import('vue-i18n')>('vue-i18n'), useI18n: () => ({ t: (key:string) => key }) }))
import ReAuthAccountModal from '../ReAuthAccountModal.vue'
const BaseDialog = defineComponent({ template: '<div><slot /><slot name="footer" /></div>' })
describe('Worker imported OAuth token replacement', () => {
 it.each(['antigravity', 'grok'])('replaces the existing %s account token using CAS without invoking OAuth authorization', async(platform) => {
  update.mockReset().mockResolvedValue({ id: 'existing', control_version: 5 })
  const account = { id: 'existing', platform, type: 'oauth', name: 'Imported', control_version: 4 } as any
  const wrapper = mount(ReAuthAccountModal, { props: { show: true, account }, global: { stubs: { BaseDialog, Icon: true, OAuthAuthorizationFlow: true } } })
  expect(wrapper.find('o-auth-authorization-flow-stub').exists()).toBe(false)
  await wrapper.get('[data-testid="reauth-imported-token"]').setValue('replacement-token')
  await wrapper.get('[data-testid="reauth-imported-submit"]').trigger('click')
  await flushPromises()
  expect(update).toHaveBeenCalledWith('existing', { credentials: { access_token: 'replacement-token' } }, 4)
  expect(wrapper.emitted('reauthorized')?.[0]).toEqual([{ id: 'existing', control_version: 5 }])
  await wrapper.setProps({ account: { ...account, id: 'other-account' } })
  expect((wrapper.get('[data-testid="reauth-imported-token"]').element as HTMLInputElement).value).toBe('')
  wrapper.unmount()
 })
})
