import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { apiKeyDigest } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'lifecycle-audit-pepper-at-least-32-bytes'
const PASSWORD = 'initial-user-password-value'

async function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(`INSERT INTO users (id,email,role,created_at_ms,updated_at_ms)
    VALUES ('admin','admin@example.test','admin',?,?)`).run(now, now)
  const admin = `adm-sub2api-${'l'.repeat(48)}`
  raw.prepare(`INSERT INTO admin_sessions (id,user_id,token_hash,created_at_ms,expires_at_ms)
    VALUES ('admin-session','admin',?,?,?)`).run(await apiKeyDigest(`admin-session:v1:${admin}`, PEPPER), now, now + 600000)
  const states = new Map<string, { version: number; balance: number; enabled: boolean }>()
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') },
    DB: d1,
    CONFIG_KV: { get: async () => ({ registration_enabled: true }), put: async () => {} },
    OBJECTS: {},
    EVENTS_QUEUE: {},
    POOL_STATE: {},
    SUBSCRIPTION_STATE: {},
    API_KEY_LIMIT_STATE: {},
    AUTH_RATE_LIMIT: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({
          schema_version: 1, allowed: true, recorded: true, cleared: ['account'],
        }),
      }),
    },
    USER_STATE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (request: Request) => {
          const body = await request.json() as any
          const path = new URL(request.url).pathname
          let state = states.get(name)
          if (!state) {
            state = {
              version: body.initial_state_version ?? 0,
              balance: body.balance_micros ?? 0,
              enabled: body.enabled ?? true,
            }
            states.set(name, state)
          }
          if (path === '/enabled') {
            state.enabled = body.enabled
            state.version++
          }
          return Response.json({
            schema_version: 1,
            idempotent: false,
            applied: true,
            state_version: state.version,
            profile: {
              user_id: body.user_id ?? name,
              enabled: state.enabled,
              balance_micros: state.balance,
              reserved_micros: 0,
              settled_micros: 0,
            },
          })
        },
      }),
    },
  } as unknown as Env
  const app = createApp()
  const request = (path: string, method = 'GET', body?: unknown, token?: string) => app.request(`/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env)
  const register = async (email = 'alice@example.test') => {
    const response = await request('/auth/register', 'POST', { email, password: PASSWORD })
    expect(response.status, await response.clone().text()).toBe(201)
    return (await response.json() as any).data
  }
  return { raw, env, request, register, admin }
}

describe('full user authentication lifecycle against migrated SQLite', () => {
  it.each(['tencent', 'aliyun'] as const)('saved %s CAPTCHA controls real registration and keeps credentials encrypted', async provider => {
    const t = await fixture()
    const app = createApp()
    const publicSettings = provider === 'tencent'
      ? { registration_enabled: true, tencent_captcha_enabled: true, tencent_captcha_app_id: '123456', tencent_captcha_region: 'intl' }
      : { registration_enabled: true, aliyun_captcha_enabled: true, aliyun_captcha_access_key_id: 'public-id', aliyun_captcha_scene_id: 'scene-id', aliyun_captcha_prefix: 'prefix', aliyun_captcha_region: 'sgp' }
    const secrets = provider === 'tencent'
      ? { tencent_captcha_app_secret_key: 'private-app-secret', tencent_captcha_cloud_secret_id: 'cloud-id', tencent_captcha_cloud_secret_key: 'private-cloud-secret' }
      : { aliyun_captcha_access_key_secret: 'private-aliyun-secret' }
    const save = await app.request('/api/v1/admin/settings', { method: 'PUT', headers: { authorization: `Bearer ${t.admin}`, 'content-type': 'application/json', 'if-match': '"0"', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ public: publicSettings, secrets }) }, t.env)
    expect(save.status, await save.clone().text()).toBe(200)
    const persisted = (await save.json() as any).data
    expect(JSON.stringify(persisted)).not.toContain('private-')
    expect(t.raw.prepare('SELECT ciphertext_b64 FROM system_setting_secrets LIMIT 1').get().ciphertext_b64).not.toContain('private-')
    t.env.CONFIG_KV.get = (async () => persisted.public) as unknown as KVNamespace['get']
    const missing = await t.request('/auth/register', 'POST', { email: 'captcha@example.test', password: PASSWORD })
    expect(missing.status).toBe(400)
    let accepted = false
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init: init! })
      return Response.json(provider === 'tencent' ? { Response: { CaptchaCode: accepted ? 1 : 7 } } : { Result: { VerifyResult: accepted } })
    })
    try {
      const body = { email: 'captcha@example.test', password: PASSWORD, turnstile_token: 'proof', tencent_captcha_ticket: 'ticket', tencent_captcha_randstr: 'rand' }
      expect((await t.request('/auth/register', 'POST', body)).status).toBe(400)
      accepted = true
      const created = await t.request('/auth/register', 'POST', body)
      expect(created.status, await created.clone().text()).toBe(201)
      expect(requests[0].url).toBe(provider === 'tencent' ? 'https://captcha.intl.tencentcloudapi.com/' : 'https://captcha.ap-southeast-1.aliyuncs.com/')
      expect(new Headers(requests[0].init.headers).get('authorization')).toMatch(provider === 'tencent' ? /^TC3-HMAC-SHA256 Credential=cloud-id\// : /^ACS3-HMAC-SHA256 Credential=public-id,/)
      expect(requests[0].init.redirect).toBe('error')
    } finally { fetchMock.mockRestore() }
  })

  it('permits one non-whitelisted domain registration and rejects the second atomically', async () => {
    const t = await fixture()
    const settings = { registration_enabled: true, registration_email_suffix_whitelist: ['@trusted.test'], registration_email_domain_quota_enabled: true }
    t.env.CONFIG_KV.get = (async () => settings) as unknown as KVNamespace['get']
    t.raw.prepare("UPDATE system_settings SET public_json = ? WHERE id='global'").run(JSON.stringify(settings))
    const responses = await Promise.all(['first@external.test', 'second@external.test'].map(email =>
      t.request('/auth/register', 'POST', { email, password: PASSWORD })))
    expect(responses.map(response => response.status).sort()).toEqual([201, 400])
    const denied = responses.find(response => response.status === 400)!
    expect(await denied.json()).toMatchObject({ code: 'EMAIL_DOMAIN_QUOTA_EXCEEDED' })
    expect(t.raw.prepare("SELECT count(*) AS total FROM users WHERE email LIKE '%@external.test'").get().total).toBe(1)
    await t.register('first@trusted.test')
    await t.register('second@trusted.test')
  })

  it.each([false, true])('applies saved global registration defaults with source override=%s', async sourceOverride => {
    const t = await fixture()
    const save = await createApp().request('/api/v1/admin/settings', { method: 'PUT', headers: { authorization: `Bearer ${t.admin}`, 'content-type': 'application/json', 'if-match': '"0"', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ public: { default_balance: 2.5, default_concurrency: 7, plugin_management_enabled: true, allow_user_view_error_requests: true } }) }, t.env)
    expect(save.status, await save.clone().text()).toBe(200)
    expect((await save.json() as any).data.public).toMatchObject({ default_balance: 2.5, default_concurrency: 7, plugin_management_enabled: true })
    if (sourceOverride) t.raw.exec("UPDATE auth_source_defaults SET grant_on_signup=1,balance_micros=1000000,concurrency=3 WHERE source='email'")
    const result = await t.register()
    expect(t.raw.prepare('SELECT balance_micros,concurrency FROM users WHERE id=?').get(result.user.id)).toEqual({ balance_micros: sourceOverride ? 1000000 : 2500000, concurrency: sourceOverride ? 3 : 7 })
    expect(result.user.balance).toBe(sourceOverride ? 1 : 2.5)
  })

  it('applies the configured default RPM to newly registered users', async () => {
    const t = await fixture()
    t.raw.prepare("UPDATE system_settings SET public_json = json_set(public_json, '$.default_user_rpm_limit', 37) WHERE id='global'").run()
    const user = await t.register()
    expect(user.user.rpm_limit).toBe(37)
    expect(t.raw.prepare('SELECT rpm_limit FROM users WHERE id = ?').get(user.user.id).rpm_limit).toBe(37)
    const profile = await t.request('/auth/me', 'GET', undefined, user.access_token)
    expect((await profile.json() as any).data.rpm_limit).toBe(37)
  })

  it('enforces saved session IP and user-agent binding for access and refresh', async () => {
    const t = await fixture()
    const user = await t.register()
    t.env.CONFIG_KV.get = (async () => ({ registration_enabled: true, session_binding_enabled: true })) as unknown as KVNamespace['get']
    const app = createApp()
    const read = (ip: string, agent = 'Browser A') => app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${user.access_token}`, 'cf-connecting-ip': ip, 'user-agent': agent },
    }, t.env)
    expect((await read('203.0.113.1')).status).toBe(200)
    expect((await read('203.0.113.2')).status).toBe(401)
    expect((await read('203.0.113.1', 'Browser B')).status).toBe(401)
    const refresh = await app.request('/api/v1/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.2', 'user-agent': 'Browser A' },
      body: JSON.stringify({ refresh_token: user.refresh_token }),
    }, t.env)
    expect(refresh.status).toBe(401)
    expect((await read('203.0.113.1')).status).toBe(200)
  })

  it('registers, logs in, rotates tokens, rejects reuse, and logs out', async () => {
    const t = await fixture()
    const registered = await t.register()
    expect((await t.request('/auth/me', 'GET', undefined, registered.access_token)).status).toBe(200)
    const duplicate = await t.request('/auth/register', 'POST', { email: 'alice@example.test', password: PASSWORD })
    expect(duplicate.status).toBe(409)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: 'incorrect-password' })).status).toBe(401)
    const login = await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })
    expect(login.status).toBe(200)
    const tokens = (await login.json() as any).data
    const rotated = await t.request('/auth/refresh', 'POST', { refresh_token: tokens.refresh_token })
    expect(rotated.status).toBe(200)
    const current = (await rotated.json() as any).data
    expect((await t.request('/auth/me', 'GET', undefined, tokens.access_token)).status).toBe(401)
    expect((await t.request('/auth/me', 'GET', undefined, current.access_token)).status).toBe(200)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: tokens.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/me', 'GET', undefined, current.access_token)).status).toBe(401)
    expect((await t.request('/auth/logout', 'POST', { refresh_token: registered.refresh_token })).status).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, registered.access_token)).status).toBe(401)
  })

  it('does not resurrect old access or refresh tokens after an administrator disables and re-enables a user', async () => {
    const t = await fixture()
    const user = await t.register()
    const disable = await t.request(`/admin/users/${user.user.id}`, 'PUT', { status: 'disabled' }, t.admin)
    expect(disable.status, await disable.clone().text()).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(401)
    const enable = await t.request(`/admin/users/${user.user.id}`, 'PUT', { status: 'active' }, t.admin)
    expect(enable.status, await enable.clone().text()).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(401)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: user.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })).status).toBe(200)
  })

  it('revokes recovery administrator sessions when their password is reset', async () => {
    const t = await fixture()
    expect((await t.request('/admin/users', 'GET', undefined, t.admin)).status).toBe(200)
    const reset = await t.request('/admin/users/admin', 'PUT', { password: 'replacement-password-value' }, t.admin)
    expect(reset.status, await reset.clone().text()).toBe(200)
    expect((await t.request('/admin/users', 'GET', undefined, t.admin)).status).toBe(401)
  })

  it('keeps the changing browser logged in while revoking other logins and accepting only the new password', async () => {
    const t = await fixture()
    const user = await t.register()
    const secondResponse = await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })
    const second = (await secondResponse.json() as any).data
    const changed = await t.request('/user/password', 'PUT', {
      old_password: PASSWORD, new_password: 'replacement-password-value',
    }, user.access_token)
    expect(changed.status, await changed.clone().text()).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, second.access_token)).status).toBe(401)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: second.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: 'replacement-password-value' })).status).toBe(200)
  })

  it('denies ordinary users admin access and makes a deleted user unable to log in or refresh', async () => {
    const t = await fixture()
    const user = await t.register()
    expect((await t.request('/admin/users', 'GET', undefined, user.access_token)).status).toBe(403)
    const deleted = await t.request(`/admin/users/${user.user.id}`, 'DELETE', undefined, t.admin)
    expect(deleted.status, await deleted.clone().text()).toBe(200)
    expect((await t.request(`/admin/users/${user.user.id}`, 'GET', undefined, t.admin)).status).toBe(404)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(401)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: user.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })).status).toBe(401)
  })
})
