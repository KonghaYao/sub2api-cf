import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn()
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, put }
}))

describe('admin settings Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
    post.mockReset()
    put.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222'
    )
  })

  it('reads, updates, tests and resets real Worker search configuration with its own version', async () => {
    const { getWebSearchEmulationConfig, resetWebSearchUsage, testWebSearchEmulation, updateWebSearchEmulationConfig } = await import('@/api/admin/settings')
    get.mockResolvedValue({ data: { enabled: false, providers: [], control_version: 3 } })
    put.mockResolvedValue({ data: { enabled: true, providers: [], control_version: 4 } })
    post.mockResolvedValue({ data: { results: [] } })
    await expect(getWebSearchEmulationConfig()).resolves.toMatchObject({ control_version: 3 })
    await updateWebSearchEmulationConfig({ enabled: true, providers: [] })
    expect(put).toHaveBeenCalledWith('/admin/settings/web-search-emulation', { enabled: true, providers: [] }, { headers: { 'If-Match': '"3"' } })
    await testWebSearchEmulation('query')
    expect(post).toHaveBeenCalledWith('/admin/settings/web-search-emulation/test', { query: 'query' })
    await resetWebSearchUsage({ provider_type: 'tavily' })
    expect(post).toHaveBeenCalledWith('/admin/settings/web-search-emulation/reset-usage', { provider_type: 'tavily' })
  })

  it('adapts the versioned Worker response to the existing settings form', async () => {
    get.mockResolvedValueOnce({
      data: {
        schema_version: 1,
        control_version: 7,
        audit_log_retention_days: 45,
        public: {
          site_name: 'Sub2API CF',
          registration_enabled: true,
          email_verification_enabled: false,
          turnstile_enabled: true,
          turnstile_site_key: 'site-key',
          passkey_enabled: true,
          available_channels_enabled: true,
          model_plaza_enabled: true,
          model_plaza_require_auth: true,
          model_plaza_description: 'Public prices',
          promo_code_enabled: true,
          invitation_code_enabled: true,
          affiliate_enabled: true
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
      available_channels_enabled: true,
      passkey_configured: true,
      passkey_rp_id: 'example.com',
      passkey_rp_origins: ['https://example.com'],
      model_plaza_enabled: true,
      model_plaza_require_auth: true,
      model_plaza_description: 'Public prices',
      promo_code_enabled: true,
      invitation_code_enabled: true,
      affiliate_enabled: true,
      step_up_enabled: true,
      turnstile_secret_key_configured: true,
      cloudflare_worker_contract: true,
      control_version: 7,
      audit_log_retention_days: 45,
    }))
  })

  it('round-trips an explicit zero audit retention without dropping it', async () => {
    const response = (controlVersion: number) => ({
      schema_version: 1,
      control_version: controlVersion,
      audit_log_retention_days: 0,
      public: {
        site_name: 'Sub2API',
        registration_enabled: false,
        email_verification_enabled: false,
        turnstile_enabled: false,
        turnstile_site_key: '',
      },
      security: { step_up_enabled: false },
      secrets: { turnstile_secret_key_configured: false },
      auth_source_defaults: {},
      updated_at_ms: controlVersion,
    })
    get.mockResolvedValueOnce({ data: response(3), headers: { etag: '"3"' } })
    put.mockResolvedValueOnce({ data: response(4), headers: { etag: '"4"' } })
    const { getSettings, updateSettings } = await import('@/api/admin/settings')

    await expect(getSettings()).resolves.toEqual(expect.objectContaining({
      audit_log_retention_days: 0,
    }))
    await expect(updateSettings({ audit_log_retention_days: 0 })).resolves.toEqual(
      expect.objectContaining({ audit_log_retention_days: 0, control_version: 4 }),
    )
    expect(put).toHaveBeenCalledWith('/admin/settings', {
      audit_log_retention_days: 0,
    }, {
      headers: {
        'Idempotency-Key': 'admin-settings-update-22222222-2222-4222-8222-222222222222',
        'If-Match': '"3"',
      },
    })
  })

  it('round-trips the Worker auth source defaults as the supported nested patch', async () => {
    const authSourceDefaults = Object.fromEntries(
      ['email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google'].map((source) => [
        source,
        {
          balance: source === 'email' ? 12.5 : 0,
          concurrency: source === 'email' ? 8 : 5,
          subscriptions: source === 'email'
            ? [{ group_id: 'subscription-pro', validity_days: 30 }]
            : [],
          grant_on_signup: source === 'email',
          grant_on_first_bind: source === 'github',
          platform_quotas: source === 'email'
            ? { openai: { daily: 3, weekly: null, monthly: 50 } }
            : {},
        },
      ]),
    )
    const response = (controlVersion: number) => ({
      schema_version: 1,
      control_version: controlVersion,
      audit_log_retention_days: 180,
      public: {
        site_name: 'Sub2API',
        registration_enabled: true,
        email_verification_enabled: true,
        turnstile_enabled: false,
        turnstile_site_key: '',
        passkey_enabled: false,
        available_channels_enabled: false,
        model_plaza_enabled: false,
        model_plaza_require_auth: false,
        model_plaza_description: '',
        promo_code_enabled: false,
        invitation_code_enabled: false,
        affiliate_enabled: false,
      },
      security: { step_up_enabled: false },
      secrets: { turnstile_secret_key_configured: false },
      auth_source_defaults: authSourceDefaults,
      updated_at_ms: controlVersion,
    })
    get.mockResolvedValueOnce({ data: response(4), headers: { etag: '"4"' } })
    put.mockResolvedValueOnce({ data: response(5), headers: { etag: '"5"' } })
    const { getSettings, updateSettings } = await import('@/api/admin/settings')

    const loaded = await getSettings()
    expect(loaded.auth_source_defaults?.email).toEqual({
      balance: 12.5,
      concurrency: 8,
      subscriptions: [{ group_id: 'subscription-pro', validity_days: 30 }],
      grant_on_signup: true,
      grant_on_first_bind: false,
      platform_quotas: { openai: { daily: 3, weekly: null, monthly: 50 } },
    })

    await updateSettings({
      auth_source_defaults: {
        email: {
          balance: 15,
          concurrency: 10,
          subscriptions: [{ group_id: 'subscription-pro', validity_days: 60 }],
          grant_on_signup: true,
          grant_on_first_bind: true,
          platform_quotas: { openai: { daily: 4, weekly: 20, monthly: null } },
        },
      },
    })

    expect(put).toHaveBeenCalledWith('/admin/settings', {
      auth_source_defaults: {
        email: {
          balance: 15,
          concurrency: 10,
          subscriptions: [{ group_id: 'subscription-pro', validity_days: 60 }],
          grant_on_signup: true,
          grant_on_first_bind: true,
          platform_quotas: { openai: { daily: 4, weekly: 20, monthly: null } },
        },
      },
    }, {
      headers: {
        'Idempotency-Key': 'admin-settings-update-22222222-2222-4222-8222-222222222222',
        'If-Match': '"4"',
      },
    })
  })

  it('sends only the supported nested patch with concurrency and idempotency headers', async () => {
    get.mockResolvedValueOnce({
      data: {
        schema_version: 1,
        control_version: 7,
        audit_log_retention_days: 180,
        public: {
          site_name: 'Old',
          registration_enabled: true,
          email_verification_enabled: false,
          turnstile_enabled: false,
          turnstile_site_key: '',
          passkey_enabled: false,
          available_channels_enabled: false,
          model_plaza_enabled: false,
          model_plaza_require_auth: false,
          model_plaza_description: '',
          promo_code_enabled: false,
          invitation_code_enabled: false,
          affiliate_enabled: false
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
        audit_log_retention_days: 180,
        public: {
          site_name: 'New',
          registration_enabled: false,
          email_verification_enabled: true,
          turnstile_enabled: true,
          turnstile_site_key: 'new-site-key',
          passkey_enabled: true,
          available_channels_enabled: true,
          model_plaza_enabled: true,
          model_plaza_require_auth: true,
          model_plaza_description: 'Public prices',
          promo_code_enabled: true,
          invitation_code_enabled: true,
          affiliate_enabled: true
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
      available_channels_enabled: true,
      model_plaza_enabled: true,
      model_plaza_require_auth: true,
      model_plaza_description: 'Public prices',
      promo_code_enabled: true,
      invitation_code_enabled: true,
      affiliate_enabled: true,
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
        passkey_enabled: true,
        available_channels_enabled: true,
        model_plaza_enabled: true,
        model_plaza_require_auth: true,
        model_plaza_description: 'Public prices',
        promo_code_enabled: true,
        invitation_code_enabled: true,
        affiliate_enabled: true
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
        audit_log_retention_days: 180,
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
        audit_log_retention_days: 180,
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

  it('loads and updates the private Worker commercial config with CAS and idempotency', async () => {
    get.mockResolvedValueOnce({
      data: {
        control_version: 3,
        affiliate_rebate_rate: 12.5,
        affiliate_rebate_rate_ppm: 125_000,
        affiliate_rebate_freeze_hours: 24,
        affiliate_rebate_duration_days: 365,
        affiliate_rebate_per_invitee_cap: 50,
        affiliate_rebate_per_invitee_cap_micros: 50_000_000,
        affiliate_admin_recharge_enabled: false,
        updated_at_ms: 1
      },
      headers: { etag: '"3"' }
    })
    put.mockResolvedValueOnce({
      data: {
        control_version: 4,
        affiliate_rebate_rate: 15,
        affiliate_rebate_rate_ppm: 150_000,
        affiliate_rebate_freeze_hours: 48,
        affiliate_rebate_duration_days: 180,
        affiliate_rebate_per_invitee_cap: 25,
        affiliate_rebate_per_invitee_cap_micros: 25_000_000,
        affiliate_admin_recharge_enabled: true,
        updated_at_ms: 2
      },
      headers: { etag: '"4"' }
    })
    const { getCommercialConfig, updateCommercialConfig } = await import('@/api/admin/settings')

    await expect(getCommercialConfig()).resolves.toEqual(expect.objectContaining({
      control_version: 3,
      affiliate_rebate_rate: 12.5,
      affiliate_rebate_per_invitee_cap: 50
    }))
    await expect(updateCommercialConfig({
      affiliate_rebate_rate: 15,
      affiliate_rebate_freeze_hours: 48,
      affiliate_rebate_duration_days: 180,
      affiliate_rebate_per_invitee_cap: 25,
      affiliate_admin_recharge_enabled: true
    })).resolves.toEqual(expect.objectContaining({ control_version: 4 }))

    expect(get).toHaveBeenCalledWith('/admin/commercial/config')
    expect(put).toHaveBeenCalledWith('/admin/commercial/config', {
      affiliate_rebate_rate: 15,
      affiliate_rebate_freeze_hours: 48,
      affiliate_rebate_duration_days: 180,
      affiliate_rebate_per_invitee_cap: 25,
      affiliate_admin_recharge_enabled: true
    }, {
      headers: {
        'Idempotency-Key': 'admin-commercial-config-update-22222222-2222-4222-8222-222222222222',
        'If-Match': '"3"'
      }
    })
  })
  it('bridges all four original Antigravity settings through the canonical Worker gateway payload', async () => {
    const gateway = { fallback_model_antigravity: 'gemini-selected', enable_identity_patch: true, identity_patch_prompt: 'Configured identity', antigravity_user_agent_version: '1.2.3' }
    get.mockResolvedValue({ data: { schema_version: 1, control_version: 8, audit_log_retention_days: 30, gateway, public: {}, security: {}, secrets: {} }, headers: { etag: '"8"' } })
    const { getSettings, buildWorkerGatewaySettings } = await import('@/api/admin/settings')
    const form = await getSettings()
    expect(form).toMatchObject(gateway)
    expect(buildWorkerGatewaySettings({ ...form, enable_identity_patch: false, identity_patch_prompt: 'Changed identity' })).toEqual({ ...gateway, enable_identity_patch: false, identity_patch_prompt: 'Changed identity' })
  })

})
