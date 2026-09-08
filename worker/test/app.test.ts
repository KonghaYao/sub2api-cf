import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import type { Env } from '../src/env'

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: 'p'.repeat(32),
    ASSETS: {
      fetch: async () => new Response('asset'),
      connect: () => {
        throw new Error('not implemented')
      },
    } as Fetcher,
    DB: {} as D1Database,
    CONFIG_KV: {
      get: async () => null,
    } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
    AUTH_RATE_LIMIT: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async () => Response.json({ schema_version: 1, allowed: true }),
      }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    ...overrides,
  }
}

describe('worker app', () => {
  it('reports the Worker runtime', async () => {
    const response = await createApp().request('/health', {}, testEnv())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      runtime: 'cloudflare-workers',
      environment: 'test',
      version: 'test',
    })
  })

  it('returns safe public settings before configuration exists', async () => {
    const response = await createApp().request('/api/v1/settings/public', {}, testEnv())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 0,
      data: {
        site_name: 'Sub2API',
        backend_mode_enabled: false,
        site_subtitle: '',
        api_base_url: '',
        contact_info: '',
        doc_url: '',
        site_logo: '',
        home_content: '',
        compact_home_enabled: false,
        hide_ccs_import_button: false,
        custom_menu_items: [],
        custom_endpoints: [],
        registration_enabled: false,
        registration_email_suffix_whitelist: [],
        email_verification_enabled: false,
        email_verify_enabled: false,
        turnstile_enabled: false,
        turnstile_site_key: '',
        passkey_enabled: false,
        available_channels_enabled: false,
        model_plaza_enabled: false,
        model_plaza_require_auth: false,
        model_plaza_description: '',
        openai_advanced_scheduler_subscription_priority_enabled: false,
        promo_code_enabled: false,
        invitation_code_enabled: false,
        affiliate_enabled: false,
        github_oauth_enabled: false,
        google_oauth_enabled: false,
        linuxdo_oauth_enabled: false,
        dingtalk_oauth_enabled: false,
        wechat_oauth_enabled: false,
        wechat_oauth_open_enabled: false,
        wechat_oauth_mp_enabled: false,
        wechat_oauth_mobile_enabled: false,
        oidc_oauth_enabled: false,
        oidc_oauth_provider_name: 'OIDC',
        payment_enabled: false,
        risk_control_enabled: false,
      },
    })
  })

  it('reads public settings from the environment-specific KV key', async () => {
    let requestedKey = ''
    const env = testEnv({
      CONFIG_KV: {
        get: async (key: string) => {
          requestedKey = key
          return { site_name: 'Edge Sub2API' }
        },
      } as unknown as KVNamespace,
    })

    const response = await createApp().request('/api/v1/settings/public', {}, env)

    expect(requestedKey).toBe('test:public-settings:v1')
    await expect(response.json()).resolves.toEqual({
      code: 0,
      data: {
        site_name: 'Edge Sub2API',
        backend_mode_enabled: false,
        site_subtitle: '',
        api_base_url: '',
        contact_info: '',
        doc_url: '',
        site_logo: '',
        home_content: '',
        compact_home_enabled: false,
        hide_ccs_import_button: false,
        custom_menu_items: [],
        custom_endpoints: [],
        registration_enabled: false,
        registration_email_suffix_whitelist: [],
        email_verification_enabled: false,
        email_verify_enabled: false,
        turnstile_enabled: false,
        turnstile_site_key: '',
        passkey_enabled: false,
        available_channels_enabled: false,
        model_plaza_enabled: false,
        model_plaza_require_auth: false,
        model_plaza_description: '',
        openai_advanced_scheduler_subscription_priority_enabled: false,
        promo_code_enabled: false,
        invitation_code_enabled: false,
        affiliate_enabled: false,
        github_oauth_enabled: false,
        google_oauth_enabled: false,
        linuxdo_oauth_enabled: false,
        dingtalk_oauth_enabled: false,
        wechat_oauth_enabled: false,
        wechat_oauth_open_enabled: false,
        wechat_oauth_mp_enabled: false,
        wechat_oauth_mobile_enabled: false,
        oidc_oauth_enabled: false,
        oidc_oauth_provider_name: 'OIDC',
        payment_enabled: false,
        risk_control_enabled: false,
      },
    })
  })

  it('fails closed when cached available-channels settings are malformed', async () => {
    const env = testEnv({
      CONFIG_KV: {
        get: async () => ({ available_channels_enabled: 'yes' }),
      } as unknown as KVNamespace,
    })

    const response = await createApp().request('/api/v1/settings/public', {}, env)

    await expect(response.json()).resolves.toMatchObject({
      data: { available_channels_enabled: false },
    })
  })

  it.each([
    '/api/v1/auth/passkey/login/begin',
    '/api/v1/auth/oauth/github/start',
  ])('enforces the shared Turnstile policy before starting passwordless auth at %s', async (path) => {
    const response = await createApp().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, testEnv({
      CONFIG_KV: {
        get: async () => ({ turnstile_enabled: true, passkey_enabled: true }),
      } as unknown as KVNamespace,
      WEBAUTHN_RP_ID: 'login.example.test',
      WEBAUTHN_RP_ORIGINS: '["https://login.example.test"]',
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'captcha_required' })
  })

  it.each(['/api', '/api/v1/not-migrated', '/v1', '/backend-api']) (
    'does not hide missing API route %s behind the SPA fallback',
    async (path) => {
      const response = await createApp().request(path, {}, testEnv())

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ code: -1 })
    },
  )

  it('routes the admin user delete contract instead of falling through to the SPA', async () => {
    const response = await createApp().request('/api/v1/admin/users/user-1', {
      method: 'DELETE',
    }, testEnv())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'admin_session_required' },
    })
  })

  it.each([
    ['/v1/images/batches', 'GET'],
    ['/api/v1/user/image-batches', 'GET'],
  ])('routes the migrated media contract at %s', async (path, method) => {
    const response = await createApp().request(path, { method }, testEnv())

    expect(response.status).toBe(401)
  })

  it.each([
    ['/v1/videos/generations', 'POST'],
    ['/v1/videos/edits', 'POST'],
    ['/v1/videos/extend', 'POST'],
    ['/v1/videos/tasks/video-task-1', 'GET'],
  ])('fails closed for the retained video surface at %s without touching authorities', async (path, method) => {
    const authorityAccess = vi.fn(() => {
      throw new Error('unsupported video routes must not access an authority')
    })
    const assetFetch = vi.fn(async () => new Response('asset'))
    const upstreamFetch = vi.fn(async () => new Response('upstream'))
    vi.stubGlobal('fetch', upstreamFetch)
    const namespace = {
      idFromName: authorityAccess,
      get: authorityAccess,
    } as unknown as DurableObjectNamespace
    const env = testEnv({
      DB: { prepare: authorityAccess } as unknown as D1Database,
      ASSETS: { fetch: assetFetch } as unknown as Fetcher,
      USER_STATE: namespace,
      API_KEY_LIMIT_STATE: namespace,
      POOL_STATE: namespace,
    })

    const response = await createApp().request(path, {
      method,
      headers: {
        authorization: 'Bearer deliberately-invalid',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? '{}' : undefined,
    }, env)

    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_video_generation',
        message: 'Video generation is not supported by the Cloudflare Worker runtime',
      },
    })
    expect(authorityAccess).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(assetFetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('routes the authenticated available-channels contract', async () => {
    const response = await createApp().request('/api/v1/channels/available', {}, testEnv())

    expect(response.status).toBe(401)
  })

  it.each([
    '/v1/images/generations',
    '/images/generations',
    '/v1/images/edits',
    '/images/edits',
  ])('routes the synchronous Images contract at %s', async (path) => {
    const response = await createApp().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, testEnv())

    expect(response.status).toBe(401)
  })

  it.each([
    ['/v1/images/generations/async', 'POST'],
    ['/images/generations/async', 'POST'],
    ['/v1/images/edits/async', 'POST'],
    ['/images/edits/async', 'POST'],
    ['/v1/images/tasks/imgtask_00000000000000000000000000000000', 'GET'],
    ['/images/tasks/imgtask_00000000000000000000000000000000', 'GET'],
  ])('routes the ordinary asynchronous Images contract at %s', async (path, method) => {
    const response = await createApp().request(path, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify({ prompt: 'cat' }) : undefined,
    }, testEnv())

    expect(response.status).toBe(401)
  })

  it('does not add loose OpenAI-prefixed Images aliases', async () => {
    const response = await createApp().request('/openai/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, testEnv())

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('asset')
  })

  it.each([
    '/videos/generations',
    '/openai/v1/videos/generations',
  ])('does not capture non-API video path %s from the SPA fallback', async (path) => {
    const response = await createApp().request(path, { method: 'POST' }, testEnv())

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('asset')
  })

  it('still delegates non-API routes to Static Assets', async () => {
    const response = await createApp().request('/dashboard', {}, testEnv())

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('asset')
  })
})
