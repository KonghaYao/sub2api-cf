import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WorkerAuthSourceDefaultsCard from '../WorkerAuthSourceDefaultsCard.vue'

const { getSettings, updateSettings, getGroups } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getGroups: vi.fn(),
}))

vi.mock('@/api', () => ({
  adminAPI: {
    settings: { getSettings, updateSettings },
    groups: { getAll: getGroups },
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      params?.source ? `${key}:${String(params.source)}` : key
    ),
  }),
}))

const sources = ['email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google'] as const

function authDefaults() {
  return Object.fromEntries(sources.map((source) => [source, {
    balance: source === 'email' ? 1.25 : 0,
    concurrency: source === 'email' ? 3 : 5,
    subscriptions: source === 'email'
      ? [{ group_id: 'group-basic', validity_days: 30 }]
      : [],
    grant_on_signup: source === 'email',
    grant_on_first_bind: source === 'github',
    platform_quotas: source === 'email'
      ? { openai: { daily: 2, weekly: null, monthly: 20 } }
      : {},
  }]))
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    cloudflare_worker_contract: true,
    control_version: 4,
    auth_source_defaults: authDefaults(),
    ...overrides,
  }
}

function group(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    platform: 'openai',
    rate_multiplier: 1,
    subscription_type: 'subscription',
    status: 'active',
  }
}

describe('WorkerAuthSourceDefaultsCard', () => {
  beforeEach(() => {
    getSettings.mockReset()
    updateSettings.mockReset()
    getGroups.mockReset()
    getSettings.mockResolvedValue(settings())
    getGroups.mockResolvedValue([
      group('group-basic', 'Basic'),
      group('group-pro', 'Pro'),
      { ...group('group-disabled', 'Disabled'), status: 'inactive' },
    ])
    updateSettings.mockImplementation(async ({ auth_source_defaults: patch }) => settings({
      control_version: 5,
      auth_source_defaults: { ...authDefaults(), ...patch },
    }))
  })

  it('loads all seven sources and saves the selected source with the nested Worker contract', async () => {
    const wrapper = mount(WorkerAuthSourceDefaultsCard)
    await flushPromises()

    expect(wrapper.get('[data-testid="auth-source-select"]').findAll('option')).toHaveLength(7)
    expect((wrapper.get('[data-testid="auth-source-balance"]').element as HTMLInputElement).value)
      .toBe('1.25')
    expect((wrapper.get('[data-testid="auth-source-concurrency"]').element as HTMLInputElement).value)
      .toBe('3')
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)

    await wrapper.get('[data-testid="auth-source-balance"]').setValue('3.500001')
    await wrapper.get('[data-testid="auth-source-concurrency"]').setValue('7')
    await wrapper.get('[data-testid="auth-source-grant-first-bind"]').setValue(true)
    await wrapper.get('[data-testid="auth-source-subscription-group-0"]').setValue('group-pro')
    await wrapper.get('[data-testid="auth-source-subscription-validity-0"]').setValue('60')
    await wrapper.get('[data-testid="auth-source-quota-openai-daily"]').setValue('4.25')
    await wrapper.get('[data-testid="auth-source-quota-openai-weekly"]').setValue('15')
    await wrapper.get('[data-testid="auth-source-save"]').trigger('click')
    await flushPromises()

    expect(updateSettings).toHaveBeenCalledWith({
      auth_source_defaults: {
        email: expect.objectContaining({
          balance: 3.500001,
          concurrency: 7,
          subscriptions: [{ group_id: 'group-pro', validity_days: 60 }],
          grant_on_signup: true,
          grant_on_first_bind: true,
          platform_quotas: expect.objectContaining({
            openai: { daily: 4.25, weekly: 15, monthly: 20 },
          }),
        }),
      },
    })
    const savedEmail = updateSettings.mock.calls[0]?.[0].auth_source_defaults.email
    expect(savedEmail.platform_quotas).not.toHaveProperty('anthropic')
    expect(wrapper.get('[data-testid="auth-source-success"]').exists()).toBe(true)
  })

  it('blocks invalid values locally and displays an actionable validation error', async () => {
    const wrapper = mount(WorkerAuthSourceDefaultsCard)
    await flushPromises()

    await wrapper.get('[data-testid="auth-source-concurrency"]').setValue('0')
    await wrapper.get('[data-testid="auth-source-save"]').trigger('click')

    expect(updateSettings).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="auth-source-error"]').text()).toContain(
      'admin.settings.authSourceDefaults.validation.concurrency',
    )
  })

  it('surfaces Worker validation and version conflicts without losing the edited form', async () => {
    updateSettings.mockRejectedValue({
      code: 'settings_version_conflict',
      message: 'System settings changed; reload them',
    })
    const wrapper = mount(WorkerAuthSourceDefaultsCard)
    await flushPromises()

    await wrapper.get('[data-testid="auth-source-balance"]').setValue('8')
    await wrapper.get('[data-testid="auth-source-save"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="auth-source-error"]').text()).toContain(
      'settings_version_conflict',
    )
    expect((wrapper.get('[data-testid="auth-source-balance"]').element as HTMLInputElement).value)
      .toBe('8')
  })
})
