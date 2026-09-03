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
      email_verification_enabled: boolean
      turnstile_enabled: boolean
      turnstile_site_key: string
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
          email_verification_enabled: false,
          turnstile_enabled: false,
          turnstile_site_key: '',
        },
        secrets: { turnstile_secret_key_configured: false },
        updated_at_ms: expect.any(Number),
      },
    })
    expect(JSON.stringify(body)).not.toContain('turnstile_secret_key"')
  })

  it('atomically updates public and encrypted secret settings, projects KV, and audits the administrator', async () => {
    const response = await subject.app.request('/settings', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        public: {
          site_name: 'Edge Sub2API',
          registration_enabled: true,
          email_verification_enabled: true,
          turnstile_enabled: true,
          turnstile_site_key: 'site-key-public',
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
        email_verification_enabled: true,
        turnstile_enabled: true,
        turnstile_site_key: 'site-key-public',
      },
      secrets: { turnstile_secret_key_configured: true },
    })
    expect(JSON.stringify(body)).not.toContain('turnstile-secret-private')

    const expectedProjection = {
      schema_version: 1,
      control_version: 1,
      site_name: 'Edge Sub2API',
      registration_enabled: true,
      email_verification_enabled: true,
      turnstile_enabled: true,
      turnstile_site_key: 'site-key-public',
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
      'public.email_verification_enabled',
      'public.registration_enabled',
      'public.site_name',
      'public.turnstile_enabled',
      'public.turnstile_site_key',
      'secrets.turnstile_secret_key:set',
    ])
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
