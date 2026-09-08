import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { smtpExchange } from '../../src/email/smtp'
vi.mock('../../src/email/smtp', async (original) => ({ ...await original<typeof import('../../src/email/smtp')>(), smtpExchange: vi.fn(async () => undefined) }))
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


describe('email settings original contract and actual delivery consumption', () => {
  it('CAS persists encrypted SMTP config, retains blank passwords, tests transport, renders and restores templates', async () => {
    const fixture = await clearHarness(false)
    const app = createApp()
    const call = async (path: string, method = 'GET', body?: unknown, version?: number) => app.request('/api/v1/admin/settings' + path.replace(/^\/delivery$/, '/email-delivery').replace(/^\/templates/, '/email-templates').replace(/\/restore$/, '/restore-official').replace(/^\/preview$/, '/email-template-preview'),
      { method, headers: { authorization: `Bearer ${fixture.accessToken}`, 'content-type': 'application/json', ...(version === undefined ? {} : { 'if-match': `"${version}"` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, fixture.env)
    const data = async (response: Response) => { expect(response.status, await response.clone().text()).toBe(200); return (await response.json() as any).data }
    try {
      expect(await data(await call('/delivery'))).toMatchObject({ control_version: 0, smtp_password_configured: false })
      const settings = { smtp_host: 'smtp.example.test', smtp_port: 465, smtp_username: 'operator', smtp_password: 'only-in-memory-secret', smtp_from_email: 'no-reply@example.test', smtp_from_name: 'Site', smtp_use_tls: true }
      expect((await call('/delivery', 'PUT', settings)).status).toBe(428)
      expect(await data(await call('/delivery', 'PUT', settings, 0))).toMatchObject({ control_version: 1, smtp_password_configured: true })
      expect(JSON.stringify(fixture.raw.prepare('SELECT * FROM email_delivery_settings').get())).not.toContain(settings.smtp_password)
      expect(JSON.stringify(await data(await call('/delivery')))).not.toContain(settings.smtp_password)
      expect((await call('/delivery', 'PUT', { smtp_host: 'stale.example.test' }, 0)).status).toBe(412)
      await data(await call('/delivery', 'PUT', { smtp_password: '', smtp_from_name: 'Changed' }, 1))
      await data(await call('/test-smtp', 'POST', {}))
      expect(smtpExchange).toHaveBeenLastCalledWith(expect.objectContaining({ smtp_password: settings.smtp_password, smtp_from_name: 'Changed' }), undefined)
      await data(await call('/send-test-email', 'POST', { email: 'test@example.test' }))
      expect(smtpExchange).toHaveBeenLastCalledWith(expect.objectContaining({ smtp_host: settings.smtp_host }), expect.objectContaining({ to: 'test@example.test' }))
      const templates = await data(await call('/templates'))
      expect(templates.templates).toHaveLength(26)
      expect(templates.events).toContain('auth.password_reset')
      const original = await data(await call('/templates/auth.password_reset/en'))
      const custom = { subject: '{{site_name}} reset', html: '<a href="{{reset_url}}">{{recipient_name}}</a>' }
      expect(await data(await call('/templates/auth.password_reset/en', 'PUT', custom))).toMatchObject({ ...custom, is_custom: true })
      const preview = await data(await call('/preview', 'POST', { ...custom, event: 'auth.password_reset', locale: 'en' }))
      expect(preview).toMatchObject({ subject: 'Sub2API reset' })
      expect(preview.html).toContain('https://example.com/reset-password?token=preview')
      expect(await hasEmailDeliveryConfigured(fixture.env)).toBe(true)
      await deliverPlatformEmail({ eventId: 'test-delivery', recipient: 'recipient@example.test', subject: 'default', html: 'default', text: 'default', compatibilityPayload: { purpose: 'password_reset', site_name: 'Actual site', locale: 'en', action_url: 'https://site.test/reset?token=private&step=1', expires_at_ms: Date.now() + 100000 } }, fixture.env)
      expect(smtpExchange).toHaveBeenLastCalledWith(expect.objectContaining({ smtp_password: settings.smtp_password }), expect.objectContaining({ subject: 'Actual site reset', text: 'recipient@example.test (https://site.test/reset?token=private&step=1)', html: '<a href="https://site.test/reset?token=private&amp;step=1">recipient@example.test</a>' }))
      expect(await data(await call('/templates/auth.password_reset/en/restore', 'POST'))).toMatchObject({ subject: original.subject, html: original.html, is_custom: false })
      expect((await call('/templates/unknown/en')).status).toBe(400)
      expect((await call('/templates/auth.password_reset/en', 'PUT', { ...custom, html: '{{unknown_field}}' })).status).toBe(400)
    } finally { fixture.raw.close() }
  })
})
