import { createApp } from '../../src/app'
import { describe, it, expect } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
const PEPPER = 'p'.repeat(32)
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'
async function clearHarness(enableTotp = true): Promise<any> {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  const now = Date.now()
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  database.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
     ) VALUES ('clear-admin', 'clear@example.com', 'Clear Admin', 'admin', 'active', 1, ?, ?)`,
  ).run(now, now)
  database.raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, step_up_expires_at_ms
     ) VALUES ('clear-session', 'clear-family', 'clear-admin', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now,
    now + 60_000,
    now + 120_000,
    now + 60_000,
  )
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    DB: database.d1, ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  if (enableTotp) {
    const encrypted = await encryptTotpSecret(env, 'clear-admin', TOTP_SECRET)
    database.raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, secret_version, nonce_b64, ciphertext_b64,
         enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('clear-admin', ?, ?, ?, ?, ?, ?)`,
    ).run(
      encrypted.secret_version,
      encrypted.nonce_b64,
      encrypted.ciphertext_b64,
      now,
      now,
      now,
    )
  }
  return { env, raw: database.raw, accessToken }
}

describe('administrator automation key lifecycle', () => {
  it('generates a usable key once, masks list, revokes on rotate/delete, and never bypasses step-up', async () => {
    const fixture = await clearHarness(false)
    const app = createApp()
    const call = (path: string, method = 'GET', token = fixture.accessToken) => app.request(
      '/api/v1/admin/settings' + (path === '/operation' ? '/email-template-preview' : '/admin-api-key' + (method === 'POST' ? '/regenerate' : '')),
      { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(path === '/operation' ? { body: JSON.stringify({ event: 'auth.password_reset', locale: 'en', subject: 'preview', html: '<p>preview</p>' }) } : {}) }, fixture.env)
    try {
      expect((await (await call('/key')).json() as any).data.exists).toBe(false)
      const first = (await (await call('/key', 'POST')).json() as any).data.key
      expect(first).toMatch(/^admin-api-/)
      expect((await call('/key', 'GET', first)).status).toBe(200)
      const headerAuth = await app.request('/api/v1/admin/settings/admin-api-key', { headers: { 'x-api-key': first } }, fixture.env)
      expect(headerAuth.status).toBe(200)
      const stored = fixture.raw.prepare('SELECT * FROM admin_automation_keys').get()
      expect(JSON.stringify(stored)).not.toContain(first)
      expect((await (await call('/key')).json() as any).data).toMatchObject({ exists: true, masked_key: stored.masked_key })
      expect((await call('/key', 'POST', first)).status).toBe(403)
      expect((await call('/operation', 'POST', first)).status).toBe(200)
      fixture.raw.prepare("UPDATE system_settings SET step_up_enabled=1 WHERE id='global'").run()
      expect((await call('/operation', 'POST', first)).status).toBe(403)
      fixture.raw.prepare("UPDATE system_settings SET step_up_enabled=0 WHERE id='global'").run()
      const second = (await (await call('/key', 'POST')).json() as any).data.key
      expect(second).not.toBe(first)
      expect((await call('/key', 'GET', first)).status).toBe(401)
      expect((await call('/key', 'GET', second)).status).toBe(200)
      expect((await call('/key', 'DELETE')).status).toBe(200)
      expect((await call('/key', 'GET', second)).status).toBe(401)
    } finally { fixture.raw.close() }
  })
})
