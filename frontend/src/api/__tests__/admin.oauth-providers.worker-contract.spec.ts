import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getRequest, putRequest, postRequest } = vi.hoisted(() => ({
  getRequest: vi.fn(),
  putRequest: vi.fn(),
  postRequest: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { get: getRequest, put: putRequest, post: postRequest },
}))

function provider(controlVersion: number, overrides: Record<string, unknown> = {}) {
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
    client_id: 'client-id',
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

describe('admin OAuth providers Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    getRequest.mockReset()
    putRequest.mockReset()
    postRequest.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '66666666-6666-4666-8666-666666666666',
    )
  })

  it('lists and gets secret-redacted provider projections while retaining their versions', async () => {
    getRequest
      .mockResolvedValueOnce({ data: { items: [provider(6)], total: 1 } })
      .mockResolvedValueOnce({ data: provider(7), headers: { etag: '"7"' } })
    const oauthProviders = await import('@/api/admin/oauthProviders')

    await expect(oauthProviders.list()).resolves.toMatchObject({
      total: 1,
      items: [{ provider: 'github', client_secret_configured: true }],
    })
    const fetched = await oauthProviders.get('github')

    expect(fetched).not.toHaveProperty('client_secret')
    expect(getRequest).toHaveBeenNthCalledWith(1, '/admin/oauth-providers')
    expect(getRequest).toHaveBeenNthCalledWith(2, '/admin/oauth-providers/github')
  })

  it('uses ETag-backed optimistic concurrency and idempotency for update and disable', async () => {
    getRequest.mockResolvedValueOnce({ data: provider(7), headers: { etag: '"7"' } })
    putRequest.mockResolvedValueOnce({ data: provider(8), headers: { etag: '"8"' } })
    postRequest.mockResolvedValueOnce({
      data: provider(9, { enabled: false }),
      headers: { etag: '"9"' },
    })
    const oauthProviders = await import('@/api/admin/oauthProviders')
    await oauthProviders.get('github')

    const input = {
      adapter: 'github' as const,
      enabled: true,
      issuer: 'github',
      authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token',
      userinfo_endpoint: 'https://api.github.com/user',
      emails_endpoint: 'https://api.github.com/user/emails',
      jwks_endpoint: null,
      client_id: 'client-id',
      client_secret: 'new-client-secret',
      scopes: ['read:user', 'user:email'],
      allowed_hosts: ['github.com', 'api.github.com'],
      frontend_callback_path: '/auth/oauth/callback',
      pkce_enabled: true,
    }
    await oauthProviders.upsert('github', input, { idempotencyKey: 'same-logical-update' })
    await oauthProviders.disable('github')

    expect(putRequest).toHaveBeenCalledWith('/admin/oauth-providers/github', {
      ...input,
      expected_control_version: 7,
    }, {
      headers: {
        'Idempotency-Key': 'same-logical-update',
        'If-Match': '"7"',
      },
    })
    expect(postRequest).toHaveBeenCalledWith('/admin/oauth-providers/github/disable', {
      expected_control_version: 8,
    }, {
      headers: {
        'Idempotency-Key': 'admin-oauth-provider-disable-github-66666666-6666-4666-8666-666666666666',
        'If-Match': '"8"',
      },
    })
  })

  it('requires an explicit create version and rejects mismatched response ETags', async () => {
    const oauthProviders = await import('@/api/admin/oauthProviders')
    const input = {
      adapter: 'standard' as const,
      enabled: true,
      issuer: 'google',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      emails_endpoint: null,
      jwks_endpoint: null,
      client_id: 'google-client-id',
      scopes: ['openid', 'email', 'profile'],
      allowed_hosts: ['accounts.google.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com'],
      frontend_callback_path: '/auth/oauth/callback',
      pkce_enabled: true,
    }

    await expect(oauthProviders.upsert('google', input)).rejects.toMatchObject({
      code: 'oauth_provider_version_not_loaded',
    })
    putRequest.mockResolvedValueOnce({
      data: provider(1, { provider: 'google', adapter: 'standard' }),
      headers: { etag: '"2"' },
    })
    await expect(oauthProviders.upsert('google', input, {
      expectedControlVersion: 0,
    })).rejects.toMatchObject({ code: 'oauth_provider_etag_mismatch' })
  })
})
