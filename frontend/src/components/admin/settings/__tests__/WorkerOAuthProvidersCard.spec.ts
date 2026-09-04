import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WorkerOAuthProvidersCard from '../WorkerOAuthProvidersCard.vue'

const { list, get, upsert, disable } = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  disable: vi.fn(),
}))

vi.mock('@/api', () => ({
  adminAPI: { oauthProviders: { list, get, upsert, disable } },
}))

function github(controlVersion: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    control_version: controlVersion,
    provider: 'github',
    adapter: 'github',
    enabled: true,
    issuer: 'github',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
    userinfo_endpoint: 'https://api.github.com/user',
    emails_endpoint: 'https://api.github.com/user/emails',
    jwks_endpoint: null,
    client_id: 'github-client',
    client_secret_configured: true,
    scopes: ['read:user', 'user:email'],
    allowed_hosts: ['github.com', 'api.github.com'],
    frontend_callback_path: '/auth/oauth/callback',
    pkce_enabled: true,
    created_at_ms: 1,
    updated_at_ms: controlVersion,
    ...overrides,
  }
}

describe('WorkerOAuthProvidersCard', () => {
  beforeEach(() => {
    list.mockReset()
    get.mockReset()
    upsert.mockReset()
    disable.mockReset()
  })

  it('lists all provider choices, loads one without echoing its secret, then updates and disables it', async () => {
    list.mockResolvedValue({ items: [github(7)], total: 1 })
    get.mockResolvedValue(github(7))
    upsert.mockResolvedValue(github(8, { client_id: 'updated-client' }))
    disable.mockResolvedValue(github(9, { client_id: 'updated-client', enabled: false }))
    const wrapper = mount(WorkerOAuthProvidersCard)
    await flushPromises()

    const providerSelect = wrapper.get('[data-testid="oauth-provider-select"]')
    expect(providerSelect.findAll('option')).toHaveLength(6)
    expect(get).toHaveBeenCalledWith('github')
    const secret = wrapper.get<HTMLInputElement>('[data-testid="oauth-provider-client-secret"]')
    expect(secret.element.value).toBe('')
    expect(secret.attributes('placeholder')).toContain('Configured')

    await wrapper.get('[data-testid="oauth-provider-client-id"]').setValue('updated-client')
    await secret.setValue('replacement-secret')
    await wrapper.get('[data-testid="oauth-provider-save"]').trigger('click')
    await flushPromises()

    expect(upsert).toHaveBeenCalledWith('github', expect.objectContaining({
      adapter: 'github',
      client_id: 'updated-client',
      client_secret: 'replacement-secret',
      scopes: ['read:user', 'user:email'],
      allowed_hosts: ['github.com', 'api.github.com'],
    }), { expectedControlVersion: 7 })
    expect(secret.element.value).toBe('')

    await wrapper.get('[data-testid="oauth-provider-disable"]').trigger('click')
    await flushPromises()
    expect(disable).toHaveBeenCalledWith('github', { expectedControlVersion: 8 })
    expect(wrapper.text()).toContain('provider disabled')
  })

  it('creates an unconfigured provider at version zero and surfaces CAS conflicts', async () => {
    list.mockResolvedValue({ items: [], total: 0 })
    upsert.mockRejectedValue({
      code: 'oauth_provider_version_conflict',
      message: 'OAuth provider changed; reload it',
    })
    const wrapper = mount(WorkerOAuthProvidersCard)
    await flushPromises()

    await wrapper.get('[data-testid="oauth-provider-select"]').setValue('oidc')
    await wrapper.get('[data-testid="oauth-provider-select"]').trigger('change')
    await wrapper.get('[data-testid="oauth-provider-client-id"]').setValue('oidc-client')
    await wrapper.get('[data-testid="oauth-provider-client-secret"]').setValue('oidc-secret')
    await wrapper.get('#worker-oauth-issuer').setValue('https://id.example.com')
    await wrapper.get('#worker-oauth-authorization-endpoint').setValue('https://id.example.com/authorize')
    await wrapper.get('#worker-oauth-token-endpoint').setValue('https://id.example.com/token')
    await wrapper.get('#worker-oauth-userinfo-endpoint').setValue('https://id.example.com/userinfo')
    await wrapper.get('#worker-oauth-jwks-endpoint').setValue('https://id.example.com/jwks')
    await wrapper.get('[data-testid="oauth-provider-allowed-hosts"]').setValue('id.example.com')
    await wrapper.get('[data-testid="oauth-provider-save"]').trigger('click')
    await flushPromises()

    expect(get).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledWith('oidc', expect.objectContaining({
      adapter: 'oidc',
      jwks_endpoint: 'https://id.example.com/jwks',
      client_secret: 'oidc-secret',
    }), { expectedControlVersion: 0 })
    expect(wrapper.get('[data-testid="oauth-provider-error"]').text()).toContain(
      'oauth_provider_version_conflict',
    )
  })
})
