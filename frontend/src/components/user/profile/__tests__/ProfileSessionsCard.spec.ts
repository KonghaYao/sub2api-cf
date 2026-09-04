import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileSessionsCard from '@/components/user/profile/ProfileSessionsCard.vue'

const { getSessions, revokeSession, revokeOtherSessions, showSuccess, showError } = vi.hoisted(() => ({
  getSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn()
}))

vi.mock('@/api', () => ({
  authAPI: { getSessions, revokeSession, revokeOtherSessions }
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showSuccess, showError })
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key })
  }
})

const sessions = [
  {
    id: 'current',
    current: true,
    created_at: '2026-09-04T00:00:00.000Z',
    access_expires_at: '2026-09-04T00:15:00.000Z',
    refresh_expires_at: '2026-10-04T00:00:00.000Z',
    user_agent: 'Current browser'
  },
  {
    id: 'other',
    current: false,
    created_at: '2026-09-03T00:00:00.000Z',
    access_expires_at: '2026-09-03T00:15:00.000Z',
    refresh_expires_at: '2026-10-03T00:00:00.000Z',
    user_agent: 'Other browser'
  }
]

describe('ProfileSessionsCard', () => {
  beforeEach(() => {
    getSessions.mockReset().mockResolvedValue({ items: sessions, total: sessions.length })
    revokeSession.mockReset().mockResolvedValue(undefined)
    revokeOtherSessions.mockReset().mockResolvedValue(undefined)
    showSuccess.mockReset()
    showError.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('shows the current session but only offers per-device revocation for another session', async () => {
    const wrapper = mount(ProfileSessionsCard, { global: { stubs: { Icon: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('Current browser')
    expect(wrapper.text()).toContain('Other browser')
    expect(wrapper.findAll('button')).toHaveLength(2)

    await wrapper.findAll('button')[1]!.trigger('click')
    await flushPromises()

    expect(revokeSession).toHaveBeenCalledWith('other')
    expect(wrapper.text()).not.toContain('Other browser')
    expect(wrapper.text()).toContain('Current browser')
  })

  it('revokes all other sessions while preserving the current one in the view', async () => {
    const wrapper = mount(ProfileSessionsCard, { global: { stubs: { Icon: true } } })
    await flushPromises()

    await wrapper.findAll('button')[0]!.trigger('click')
    await flushPromises()

    expect(revokeOtherSessions).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('Other browser')
    expect(wrapper.text()).toContain('Current browser')
  })
})
