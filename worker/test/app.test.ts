import { describe, expect, it } from 'vitest'
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
        registration_enabled: false,
        email_verification_enabled: false,
        email_verify_enabled: false,
        turnstile_enabled: false,
        turnstile_site_key: '',
        passkey_enabled: false,
        model_plaza_enabled: false,
        model_plaza_require_auth: false,
        model_plaza_description: '',
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
        registration_enabled: false,
        email_verification_enabled: false,
        email_verify_enabled: false,
        turnstile_enabled: false,
        turnstile_site_key: '',
        passkey_enabled: false,
        model_plaza_enabled: false,
        model_plaza_require_auth: false,
        model_plaza_description: '',
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
      },
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

  it('still delegates non-API routes to Static Assets', async () => {
    const response = await createApp().request('/dashboard', {}, testEnv())

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('asset')
  })
})
