import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { requireAdminSession } from '../../src/control/admin-auth'
import {
  getAdminSettings,
  PUBLIC_SETTINGS_SCHEMA_VERSION,
  publicSettingsKey,
  readSystemSettingSecret,
  updateAdminSettings,
} from '../../src/control/settings'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const ADMIN_ID = 'admin-1'
const SESSION_ID = 'session-1'
const SESSION_TOKEN = 's'.repeat(32)
const PEPPER = 'p'.repeat(32)

interface SettingsResponse {
  code: 0
  data: {
    schema_version: number
    control_version: number
    public: {
      site_name: string
      registration_enabled: boolean
      registration_email_suffix_whitelist: string[]
      email_verification_enabled: boolean
      turnstile_enabled: boolean
      turnstile_site_key: string
      passkey_enabled?: boolean
      available_channels_enabled: boolean
      model_plaza_enabled: boolean
      model_plaza_require_auth: boolean
      model_plaza_description: string
      promo_code_enabled: boolean
      invitation_code_enabled: boolean
      affiliate_enabled: boolean
    }
    security: {
      step_up_enabled: boolean
      passkey_configured: boolean
      passkey_rp_id: string
      passkey_rp_origins: string[]
    }
    secrets: { turnstile_secret_key_configured: boolean }
    updated_at_ms: number
  }
}

class TestKv {
  readonly values = new Map<string, string>()
  readonly puts: Array<{ key: string; value: string }> = []
  failuresRemaining = 0

  async put(key: string, value: string): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('simulated KV outage')
    }
    this.values.set(key, value)
    this.puts.push({ key, value })
  }
}

interface Harness {
  app: Hono<{ Bindings: Env }>
  env: Env
  kv: TestKv
  raw: any
}

async function harness(): Promise<Harness> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, balance_micros,
       state_version, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 'admin', 'active', 0, 0, ?, ?)`,
  ).run(ADMIN_ID, 'admin@example.com', 'Admin', now, now)
  raw.prepare(
    `INSERT INTO admin_sessions (
       id, user_id, token_hash, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    SESSION_ID,
    ADMIN_ID,
    await apiKeyDigest(`admin-session:v1:${SESSION_TOKEN}`, PEPPER),
    now,
    now + 60_000,
  )

  const kv = new TestKv()
  const env: Env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN: 'a'.repeat(32),
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: kv as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
  const app = new Hono<{ Bindings: Env }>()
  app.use('/settings', requireAdminSession)
  app.get('/settings', getAdminSettings)
  app.put('/settings', updateAdminSettings)
  return { app, env, kv, raw }
}

function headers(key = 'settings-update-0001', version = 0): Record<string, string> {
  return {
    authorization: `Bearer ${SESSION_TOKEN}`,
    'content-type': 'application/json',
    'idempotency-key': key,
    'if-match': `"${version}"`,
  }
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>
}

describe('admin system settings', () => {
  let subject: Harness

  beforeEach(async () => {
    subject = await harness()
  })

  it('returns typed versioned defaults after admin session auth without exposing secrets', async () => {
    const response = await subject.app.request('/settings', {
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    }, subject.env)

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"0"')
    const body = await responseJson(response) as SettingsResponse
    expect(body).toEqual({
      code: 0,
      data: {
        schema_version: PUBLIC_SETTINGS_SCHEMA_VERSION,
        control_version: 0,
        public: {
          site_name: 'Sub2API',
          registration_enabled: false,
          registration_email_suffix_whitelist: [],
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
          affiliate_enabled: false,
        },
        security: {
          step_up_enabled: false,
          passkey_configured: false,
          passkey_rp_id: '',
          passkey_rp_origins: [],
        },
        secrets: { turnstile_secret_key_configured: false },
        auth_source_defaults: Object.fromEntries(
          ['email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google'].map((source) => [
            source,
            {
              balance: 0,
              concurrency: 5,
              subscriptions: [],
              grant_on_signup: false,
              grant_on_first_bind: false,
              platform_quotas: {},
            },
          ]),
        ),
        updated_at_ms: expect.any(Number),
      },
    })
    expect(JSON.stringify(body)).not.toContain('turnstile_secret_key"')
  })

  it('normalizes an unknown persisted available-channels flag to false', async () => {
    subject.raw.prepare(
      `UPDATE system_settings
          SET public_json = json_set(public_json, '$.available_channels_enabled', 'yes')
        WHERE id = 'global'`,
    ).run()

    const response = await subject.app.request('/settings', {
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    }, subject.env)

    expect(response.status).toBe(200)
    await expect(responseJson(response)).resolves.toMatchObject({
      data: { public: { available_channels_enabled: false } },
    })
  })

  it('projects deployment-owned passkey RP readiness without trusting request headers', async () => {
    subject.env.WEBAUTHN_RP_ID = 'example.com'
    subject.env.WEBAUTHN_RP_NAME = 'Sub2API'
    subject.env.WEBAUTHN_RP_ORIGINS = 'https://example.com,https://admin.example.com'

    const response = await subject.app.request('/settings', {
      headers: {
        authorization: `Bearer ${SESSION_TOKEN}`,
        host: 'attacker.invalid',
        origin: 'https://attacker.invalid',
      },
    }, subject.env)

    expect(response.status).toBe(200)
    await expect(responseJson(response)).resolves.toMatchObject({
      data: {
        security: {
          passkey_configured: true,
          passkey_rp_id: 'example.com',
          passkey_rp_origins: ['https://example.com', 'https://admin.example.com'],
        },
      },
    })
  })

  it('round-trips private typed auth-source defaults without projecting them to public KV', async () => {
    const now = Date.now()
    subject.raw.prepare(
      `INSERT INTO "groups" (
         id, name, platform, group_type, daily_quota_micros, weekly_quota_micros,
         monthly_quota_micros, created_at_ms, updated_at_ms
       ) VALUES ('welcome-sub', 'Welcome subscription', 'openai', 'subscription',
                 1000000, 5000000, 10000000, ?, ?)`,
    ).run(now, now)

    const update = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('settings-auth-source-defaults'),
      body: JSON.stringify({
        auth_source_defaults: {
          email: {
            balance: 12.5,
            concurrency: 7,
            subscriptions: [{ group_id: 'welcome-sub', validity_days: 30 }],
            grant_on_signup: true,
            grant_on_first_bind: true,
            platform_quotas: {
              openai: { daily: 1.25, weekly: null, monthly: 8 },
            },
          },
        },
      }),
    }, subject.env)

    expect(update.status).toBe(200)
    await expect(responseJson(update)).resolves.toMatchObject({
      data: {
        control_version: 1,
        auth_source_defaults: {
          email: {
            balance: 12.5,
            concurrency: 7,
            subscriptions: [{ group_id: 'welcome-sub', validity_days: 30 }],
            grant_on_signup: true,
            grant_on_first_bind: true,
            platform_quotas: {
              openai: { daily: 1.25, weekly: null, monthly: 8 },
            },
          },
          github: expect.any(Object),
          google: expect.any(Object),
          linuxdo: expect.any(Object),
          dingtalk: expect.any(Object),
          wechat: expect.any(Object),
          oidc: expect.any(Object),
        },
      },
    })
    expect(subject.raw.prepare(
      "SELECT balance_micros, concurrency FROM auth_source_defaults WHERE source = 'email'",
    ).get()).toEqual({ balance_micros: 12_500_000, concurrency: 7 })

    const projected = subject.kv.values.get(publicSettingsKey('test')) ?? ''
    expect(projected).not.toContain('auth_source_defaults')
    expect(projected).not.toContain('welcome-sub')
  })

  it('rejects invalid auth-source groups and monetary precision without advancing settings', async () => {
    const missingGroup = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('settings-invalid-auth-source-group'),
      body: JSON.stringify({
        auth_source_defaults: {
          github: {
            balance: 1,
            concurrency: 5,
            subscriptions: [{ group_id: 'missing', validity_days: 30 }],
            grant_on_signup: true,
            grant_on_first_bind: false,
            platform_quotas: {},
          },
        },
      }),
    }, subject.env)
    expect(missingGroup.status).toBe(400)

    const imprecise = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('settings-invalid-auth-source-money'),
      body: JSON.stringify({
        auth_source_defaults: {
          email: {
            balance: 0.0000001,
            concurrency: 5,
            subscriptions: [],
            grant_on_signup: true,
            grant_on_first_bind: false,
            platform_quotas: {},
          },
        },
      }),
    }, subject.env)
    expect(imprecise.status).toBe(400)
    const malformedQuota = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('settings-invalid-auth-source-quota'),
      body: JSON.stringify({
        auth_source_defaults: {
          email: {
            balance: 0,
            concurrency: 5,
            subscriptions: [],
            grant_on_signup: true,
            grant_on_first_bind: false,
            platform_quotas: { openai: { daily: 1 } },
          },
        },
      }),
    }, subject.env)
    expect(malformedQuota.status).toBe(400)
    expect(subject.raw.prepare(
      "SELECT control_version FROM system_settings WHERE id = 'global'",
    ).get()).toEqual({ control_version: 0 })
  })

  it('maps all seven authentication sources to distinct private D1 defaults', async () => {
    const sources = ['email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google'] as const
    const authSourceDefaults = Object.fromEntries(sources.map((source, index) => [source, {
      balance: index + 1,
      concurrency: index + 2,
      subscriptions: [],
      grant_on_signup: index % 2 === 0,
      grant_on_first_bind: index % 2 === 1,
      platform_quotas: {},
    }]))

    const response = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('settings-all-auth-source-mapping'),
      body: JSON.stringify({ auth_source_defaults: authSourceDefaults }),
    }, subject.env)

    expect(response.status).toBe(200)
    expect(subject.raw.prepare(
      `SELECT source, balance_micros, concurrency, grant_on_signup, grant_on_first_bind
         FROM auth_source_defaults ORDER BY balance_micros`,
    ).all()).toEqual(sources.map((source, index) => ({
      source,
      balance_micros: (index + 1) * 1_000_000,
      concurrency: index + 2,
      grant_on_signup: index % 2 === 0 ? 1 : 0,
      grant_on_first_bind: index % 2 === 1 ? 1 : 0,
    })))
  })

  it('atomically updates public and encrypted secret settings, projects KV, and audits the administrator', async () => {
    const response = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        public: {
          site_name: 'Edge Sub2API',
          registration_enabled: true,
          registration_email_suffix_whitelist: ['example.com', '@EXAMPLE.com', '*.EDU.cn'],
          email_verification_enabled: true,
          turnstile_enabled: true,
          turnstile_site_key: 'site-key-public',
          passkey_enabled: true,
          available_channels_enabled: true,
          model_plaza_enabled: true,
          model_plaza_require_auth: true,
          model_plaza_description: 'Prices are shown in USD.',
          promo_code_enabled: true,
          invitation_code_enabled: true,
          affiliate_enabled: true,
        },
        secrets: { turnstile_secret_key: 'turnstile-secret-private' },
      }),
    }, subject.env)

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"1"')
    const body = await responseJson(response) as SettingsResponse
    expect(body.data).toMatchObject({
      schema_version: 1,
      control_version: 1,
      public: {
        site_name: 'Edge Sub2API',
        registration_enabled: true,
        registration_email_suffix_whitelist: ['@example.com', '*.edu.cn'],
        email_verification_enabled: true,
        turnstile_enabled: true,
        turnstile_site_key: 'site-key-public',
        passkey_enabled: true,
        model_plaza_enabled: true,
        model_plaza_require_auth: true,
        model_plaza_description: 'Prices are shown in USD.',
        promo_code_enabled: true,
        invitation_code_enabled: true,
        affiliate_enabled: true,
      },
      secrets: { turnstile_secret_key_configured: true },
    })
    expect(JSON.stringify(body)).not.toContain('turnstile-secret-private')

    const expectedProjection = {
      schema_version: 1,
      control_version: 1,
      site_name: 'Edge Sub2API',
      registration_enabled: true,
      registration_email_suffix_whitelist: ['@example.com', '*.edu.cn'],
      email_verification_enabled: true,
      turnstile_enabled: true,
      turnstile_site_key: 'site-key-public',
      passkey_enabled: true,
      available_channels_enabled: true,
      model_plaza_enabled: true,
      model_plaza_require_auth: true,
      model_plaza_description: 'Prices are shown in USD.',
      promo_code_enabled: true,
      invitation_code_enabled: true,
      affiliate_enabled: true,
    }
    expect(subject.kv.puts).toEqual([{
      key: publicSettingsKey('test'),
      value: JSON.stringify(expectedProjection),
    }])

    const storedSecret = subject.raw.prepare(
      `SELECT nonce_b64, ciphertext_b64 FROM system_setting_secrets
        WHERE settings_id = 'global' AND key = 'turnstile_secret_key'`,
    ).get() as { nonce_b64: string; ciphertext_b64: string }
    expect(storedSecret.nonce_b64).not.toContain('turnstile-secret-private')
    expect(storedSecret.ciphertext_b64).not.toContain('turnstile-secret-private')
    await expect(readSystemSettingSecret(subject.env, 'turnstile_secret_key'))
      .resolves.toBe('turnstile-secret-private')

    const audit = subject.raw.prepare(
      'SELECT actor_user_id, actor_session_id, action, resource_version, changed_fields_json FROM admin_settings_audit_events',
    ).get() as Record<string, unknown>
    expect(audit).toMatchObject({
      actor_user_id: ADMIN_ID,
      actor_session_id: SESSION_ID,
      action: 'system_settings.update',
      resource_version: 1,
    })
    expect(JSON.parse(String(audit.changed_fields_json))).toEqual([
      'public.affiliate_enabled',
      'public.available_channels_enabled',
      'public.email_verification_enabled',
      'public.invitation_code_enabled',
      'public.model_plaza_description',
      'public.model_plaza_enabled',
      'public.model_plaza_require_auth',
      'public.passkey_enabled',
      'public.promo_code_enabled',
      'public.registration_email_suffix_whitelist',
      'public.registration_enabled',
      'public.site_name',
      'public.turnstile_enabled',
      'public.turnstile_site_key',
      'secrets.turnstile_secret_key:set',
    ])
  })

  it('enables privileged-operation step-up only for an administrator with TOTP', async () => {
    const denied = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('enable-step-up-without-totp'),
      body: JSON.stringify({ security: { step_up_enabled: true } }),
    }, subject.env)
    expect(denied.status).toBe(403)
    await expect(responseJson(denied)).resolves.toMatchObject({
      code: 'STEP_UP_TOTP_NOT_ENABLED',
    })

    const now = Date.now()
    subject.raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, nonce_b64, ciphertext_b64, enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ADMIN_ID, 'A'.repeat(16), 'B'.repeat(24), now, now, now)
    const enabled = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('enable-step-up-with-totp'),
      body: JSON.stringify({ security: { step_up_enabled: true } }),
    }, subject.env)
    expect(enabled.status).toBe(200)
    await expect(responseJson(enabled)).resolves.toMatchObject({
      data: { security: { step_up_enabled: true }, control_version: 1 },
    })
    expect(subject.raw.prepare(
      "SELECT step_up_enabled FROM system_settings WHERE id = 'global'",
    ).get()).toEqual({ step_up_enabled: 1 })
    expect(subject.kv.puts.at(-1)?.value).not.toContain('step_up_enabled')
  })

  it('requires If-Match and Idempotency-Key, rejects stale versions, and replays without another mutation', async () => {
    const body = JSON.stringify({ public: { registration_enabled: true } })
    const missingMatchHeaders = headers()
    delete missingMatchHeaders['if-match']
    const missingMatch = await subject.app.request('/settings', {
      method: 'PUT', headers: missingMatchHeaders, body,
    }, subject.env)
    expect(missingMatch.status).toBe(428)
    expect((await responseJson(missingMatch)).code).toBe('settings_version_required')

    const missingKeyHeaders = headers()
    delete missingKeyHeaders['idempotency-key']
    const missingKey = await subject.app.request('/settings', {
      method: 'PUT', headers: missingKeyHeaders, body,
    }, subject.env)
    expect(missingKey.status).toBe(400)
    expect((await responseJson(missingKey)).code).toBe('invalid_idempotency_key')

    const first = await subject.app.request('/settings', {
      method: 'PUT', headers: headers(), body,
    }, subject.env)
    const replay = await subject.app.request('/settings', {
      method: 'PUT', headers: headers(), body,
    }, subject.env)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(await responseJson(replay)).toEqual(await responseJson(first.clone()))
    expect(subject.raw.prepare("SELECT control_version FROM system_settings WHERE id = 'global'").get())
      .toEqual({ control_version: 1 })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_settings_audit_events').get())
      .toEqual({ count: 1 })

    const reusedKey = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ public: { registration_enabled: false } }),
    }, subject.env)
    expect(reusedKey.status).toBe(409)
    expect((await responseJson(reusedKey)).code).toBe('idempotency_conflict')

    const stale = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('settings-update-0002', 0),
      body: JSON.stringify({ public: { site_name: 'Stale write' } }),
    }, subject.env)
    expect(stale.status).toBe(409)
    expect((await responseJson(stale)).code).toBe('settings_version_conflict')
  })

  it('returns an explicit failure on KV outage and repairs the projection on idempotent retry', async () => {
    subject.kv.failuresRemaining = 1
    const request = {
      method: 'PUT',
      headers: headers('settings-update-kv-failure'),
      body: JSON.stringify({ public: { site_name: 'Persisted truth' } }),
    }

    const failed = await subject.app.request('/settings', request, subject.env)
    expect(failed.status).toBe(503)
    expect((await responseJson(failed)).code).toBe('public_settings_projection_failed')
    expect(subject.kv.values.has(publicSettingsKey('test'))).toBe(false)
    expect(subject.raw.prepare("SELECT control_version FROM system_settings WHERE id = 'global'").get())
      .toEqual({ control_version: 1 })

    const repaired = await subject.app.request('/settings', request, subject.env)
    expect(repaired.status).toBe(200)
    expect((await responseJson(repaired)).data).toMatchObject({
      control_version: 1,
      public: { site_name: 'Persisted truth' },
    })
    expect(JSON.parse(subject.kv.values.get(publicSettingsKey('test')) ?? '{}')).toMatchObject({
      control_version: 1,
      site_name: 'Persisted truth',
    })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_settings_audit_events').get())
      .toEqual({ count: 1 })
  })

  it('rejects unknown fields and invalid public setting types', async () => {
    const unknown = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ public: { future_untyped_secret: 'do-not-store' } }),
    }, subject.env)
    expect(unknown.status).toBe(400)
    expect((await responseJson(unknown)).code).toBe('unknown_setting')

    const invalid = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers('settings-update-invalid'),
      body: JSON.stringify({ public: { turnstile_enabled: 'yes' } }),
    }, subject.env)
    expect(invalid.status).toBe(400)
    expect((await responseJson(invalid)).code).toBe('invalid_turnstile_enabled')
  })
})
