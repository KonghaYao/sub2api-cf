import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, put } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn()
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, put }
}))

describe('admin settings Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
    put.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222'
    )
  })

  it('adapts the versioned Worker response to the existing settings form', async () => {
    get.mockResolvedValueOnce({
      data: {
        schema_version: 1,
        control_version: 7,
        public: {
          site_name: 'Sub2API CF',
          registration_enabled: true,
          email_verification_enabled: false,
          turnstile_enabled: true,
          turnstile_site_key: 'site-key',
          passkey_enabled: true
        },
        security: {
          step_up_enabled: true,
          passkey_configured: true,
          passkey_rp_id: 'example.com',
          passkey_rp_origins: ['https://example.com']
        },
        secrets: { turnstile_secret_key_configured: true },
        updated_at_ms: 1_788_451_200_000
      },
      headers: { etag: '"7"' }
    })
    const { getSettings } = await import('@/api/admin/settings')

    await expect(getSettings()).resolves.toEqual(expect.objectContaining({
      site_name: 'Sub2API CF',
      registration_enabled: true,
      email_verify_enabled: false,
      turnstile_enabled: true,
      turnstile_site_key: 'site-key',
      passkey_enabled: true,
      passkey_configured: true,
      passkey_rp_id: 'example.com',
      passkey_rp_origins: ['https://example.com'],
      step_up_enabled: true,
      turnstile_secret_key_configured: true,
      cloudflare_worker_contract: true,
      control_version: 7
    }))
  })

  it('sends only the supported nested patch with concurrency and idempotency headers', async () => {
    get.mockResolvedValueOnce({
      data: {
        schema_version: 1,
        control_version: 7,
        public: {
          site_name: 'Old',
          registration_enabled: true,
          email_verification_enabled: false,
          turnstile_enabled: false,
          turnstile_site_key: '',
          passkey_enabled: false
        },
        security: { step_up_enabled: false },
        secrets: { turnstile_secret_key_configured: false },
        updated_at_ms: 1
      },
      headers: { etag: '"7"' }
    })
    put.mockResolvedValueOnce({
      data: {
        schema_version: 1,
        control_version: 8,
        public: {
          site_name: 'New',
          registration_enabled: false,
          email_verification_enabled: true,
          turnstile_enabled: true,
          turnstile_site_key: 'new-site-key',
          passkey_enabled: true
        },
        security: { step_up_enabled: true },
        secrets: { turnstile_secret_key_configured: true },
        updated_at_ms: 2
      },
      headers: { etag: '"8"' }
    })
    const { getSettings, updateSettings } = await import('@/api/admin/settings')
    await getSettings()

    const updated = await updateSettings({
      site_name: 'New',
      registration_enabled: false,
      email_verify_enabled: true,
      turnstile_enabled: true,
      turnstile_site_key: 'new-site-key',
      passkey_enabled: true,
      turnstile_secret_key: 'new-secret',
      step_up_enabled: true,
      payment_enabled: true
    })

    expect(put).toHaveBeenCalledWith('/admin/settings', {
      public: {
        site_name: 'New',
        registration_enabled: false,
        email_verification_enabled: true,
        turnstile_enabled: true,
        turnstile_site_key: 'new-site-key',
        passkey_enabled: true
      },
      security: { step_up_enabled: true },
      secrets: { turnstile_secret_key: 'new-secret' }
    }, {
      headers: {
        'Idempotency-Key': 'admin-settings-update-22222222-2222-4222-8222-222222222222',
        'If-Match': '"7"'
      }
    })
    expect(updated.control_version).toBe(8)
  })

  it('refuses an update when no version has been loaded', async () => {
    const { updateSettings } = await import('@/api/admin/settings')

    await expect(updateSettings({ site_name: 'unsafe write' })).rejects.toMatchObject({
      code: 'settings_version_not_loaded'
    })
    expect(put).not.toHaveBeenCalled()
  })

  it('supports a security-only update after loading the Worker version', async () => {
    get.mockResolvedValueOnce({
      data: {
        schema_version: 1,
        control_version: 4,
        public: {
          site_name: 'Sub2API',
          registration_enabled: false,
          email_verification_enabled: false,
          turnstile_enabled: false,
          turnstile_site_key: ''
        },
        security: { step_up_enabled: false },
        secrets: { turnstile_secret_key_configured: false },
        updated_at_ms: 1
      },
      headers: { etag: '"4"' }
    })
    put.mockResolvedValueOnce({
      data: {
        schema_version: 1,
        control_version: 5,
        public: {
          site_name: 'Sub2API',
          registration_enabled: false,
          email_verification_enabled: false,
          turnstile_enabled: false,
          turnstile_site_key: ''
        },
        security: { step_up_enabled: true },
        secrets: { turnstile_secret_key_configured: false },
        updated_at_ms: 2
      },
      headers: { etag: '"5"' }
    })
    const { getSettings, updateSettings } = await import('@/api/admin/settings')
    await getSettings()

    await expect(updateSettings({ step_up_enabled: true })).resolves.toEqual(
      expect.objectContaining({ step_up_enabled: true, control_version: 5 })
    )
    expect(put).toHaveBeenCalledWith('/admin/settings', {
      security: { step_up_enabled: true }
    }, expect.any(Object))
  })
})
