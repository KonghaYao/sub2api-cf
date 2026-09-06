import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/app'
import {
  commercialCodeDigest,
  validateInvitationCode,
  validatePromotionCode,
} from '../../src/commercial/registration'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'commercial-registration-pepper-at-least-32-bytes'
const MASTER_KEY = 'commercial-registration-master-key-at-least-32-bytes'

describe('commercial registration HTTP contract', () => {
  it('normalizes public validation and atomically applies promotion, invitation, and attribution', async () => {
    const test = await fixture({ promo: true, invitation: true, affiliate: true })
    await seedCode(test, 'promotion', ' Welcome-25 ', 5_000_000, 10)
    await seedCode(test, 'invitation', ' Invite-One ', 0, 1)
    await seedInviter(test, 'inviter', ' Partner_One ')
    const defaultsNow = Date.now()
    test.raw.prepare(
      `INSERT INTO platform_quota_defaults (
         platform, daily_limit_micros, control_version, updated_at_ms
       ) VALUES ('openai', 3000000, 1, ?)`,
    ).run(defaultsNow)
    test.raw.prepare(
      `UPDATE platform_quota_defaults_control
          SET control_version = 1, updated_at_ms = ? WHERE singleton = 1`,
    ).run(defaultsNow)

    const publicApp = new Hono<{ Bindings: Env }>()
    publicApp.post('/promo', validatePromotionCode)
    publicApp.post('/invite', validateInvitationCode)
    const promo = await publicApp.request('/promo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '  welcome-25 ' }),
    }, test.env)
    await expect(promo.json()).resolves.toMatchObject({
      data: { valid: true, bonus_amount: 5, bonus_micros: 5_000_000 },
    })
    const invitation = await publicApp.request('/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ' invite-one ' }),
    }, test.env)
    await expect(invitation.json()).resolves.toMatchObject({ data: { valid: true } })

    const response = await createApp().request('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'buyer@example.test', password: 'correct horse battery staple',
        promo_code: ' welcome-25 ', invitation_code: ' invite-one ', aff_code: ' partner_one ',
      }),
    }, test.env)
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ data: { user: { balance: 5 } } })
    const user = test.raw.prepare(
      `SELECT id, balance_micros, financial_history_complete
         FROM users WHERE email = 'buyer@example.test'`,
    ).get() as { id: string; balance_micros: number; financial_history_complete: number }
    expect(user.balance_micros).toBe(5_000_000)
    expect(user.financial_history_complete).toBe(1)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM promotion_code_usages WHERE user_id = ?`,
    ).get(user.id)).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM invitation_code_usages WHERE user_id = ?`,
    ).get(user.id)).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT inviter_user_id FROM affiliate_referrals WHERE invitee_user_id = ?`,
    ).get(user.id)).toEqual({ inviter_user_id: 'inviter' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM user_platform_quotas WHERE user_id = ?`,
    ).get(user.id)).toEqual({ total: 1 })
  })

  it('does not consume either code when the registration transaction fails', async () => {
    const test = await fixture({ promo: true, invitation: true, affiliate: false })
    await seedCode(test, 'promotion', 'ROLLBACK', 2_000_000, 1)
    await seedCode(test, 'invitation', 'ROLLBACK-I', 0, 1)
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('existing', 'exists@example.test', 'Existing', ?, ?)`,
    ).run(now, now)

    const failed = await createApp().request('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'exists@example.test', password: 'correct horse battery staple',
        promo_code: 'ROLLBACK', invitation_code: 'ROLLBACK-I',
      }),
    }, test.env)
    expect(failed.status).toBe(409)
    expect(test.raw.prepare(
      `SELECT used_count FROM promotion_codes WHERE code_prefix = 'ROLLBACK'`,
    ).get()).toEqual({ used_count: 0 })
    expect(test.raw.prepare(
      `SELECT used_count FROM invitation_codes WHERE code_prefix = 'ROLLBACK'`,
    ).get()).toEqual({ used_count: 0 })
  })

  it('allows only one concurrent registration to claim the final slots', async () => {
    const test = await fixture({ promo: true, invitation: true, affiliate: false })
    await seedCode(test, 'promotion', 'LAST-PROMO', 1_000_000, 1)
    await seedCode(test, 'invitation', 'LAST-INVITE', 0, 1)

    const responses = await Promise.all(['one', 'two'].map((name) => createApp().request(
      '/api/v1/auth/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `${name}@example.test`, password: 'correct horse battery staple',
          promo_code: 'last-promo', invitation_code: 'last-invite',
        }),
      }, test.env,
    )))
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409])
    expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM promotion_code_usages`).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM invitation_code_usages`).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM users`).get()).toEqual({ total: 1 })
  })

  it('reports disabled, expired, and exhausted code states without leaking hashes', async () => {
    const test = await fixture({ promo: true, invitation: true, affiliate: false })
    await seedCode(test, 'promotion', 'STATUS-P', 1_000_000, 1)
    await seedCode(test, 'invitation', 'STATUS-I', 0, 1)
    const app = new Hono<{ Bindings: Env }>()
    app.post('/promo', validatePromotionCode)
    app.post('/invite', validateInvitationCode)
    const post = (path: string, code: string) => app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    }, test.env)

    test.raw.prepare(`UPDATE promotion_codes SET status = 'disabled'`).run()
    await expect((await post('/promo', 'status-p')).json()).resolves.toMatchObject({
      data: { valid: false, error_code: 'PROMO_CODE_DISABLED' },
    })
    test.raw.prepare(`UPDATE promotion_codes SET status = 'active', expires_at_ms = ?`).run(Date.now() - 1)
    await expect((await post('/promo', 'status-p')).json()).resolves.toMatchObject({
      data: { valid: false, error_code: 'PROMO_CODE_EXPIRED' },
    })
    test.raw.prepare(`UPDATE invitation_codes SET used_count = max_uses`).run()
    const response = await post('/invite', 'status-i')
    const serialized = JSON.stringify(await response.json())
    expect(serialized).toContain('INVITATION_CODE_USED')
    expect(serialized).not.toContain('code_hash')
  })
})

async function fixture(flags: { promo: boolean; invitation: boolean; affiliate: boolean }) {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: { get: async () => ({
      registration_enabled: true, email_verification_enabled: false, turnstile_enabled: false,
      promo_code_enabled: flags.promo, invitation_code_enabled: flags.invitation,
      affiliate_enabled: flags.affiliate,
    }) } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
    AUTH_RATE_LIMIT: allowAuthRateLimit(),
  } satisfies Env
  return { raw, env }
}

function allowAuthRateLimit(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      if (path === '/success') return Response.json({ schema_version: 1, cleared: ['account'] })
      if (path === '/failure') return Response.json({ schema_version: 1, recorded: true })
      return Response.json({ schema_version: 1, allowed: true })
    } }) as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

async function seedCode(
  test: Awaited<ReturnType<typeof fixture>>,
  kind: 'promotion' | 'invitation',
  rawCode: string,
  bonusMicros: number,
  maxUses: number,
): Promise<void> {
  const code = rawCode.trim().toUpperCase()
  const hash = await commercialCodeDigest(kind, code, PEPPER)
  const table = kind === 'promotion' ? 'promotion_codes' : 'invitation_codes'
  const now = Date.now()
  if (kind === 'promotion') {
    test.raw.prepare(
      `INSERT INTO ${table} (
         id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, bonus_micros, max_uses, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', ?, ?, ?, ?)`,
    ).run(`id-${kind}-${code}`, hash, code.slice(0, 8), bonusMicros, maxUses, now, now)
  } else {
    test.raw.prepare(
      `INSERT INTO ${table} (
         id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, max_uses, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', ?, ?, ?)`,
    ).run(`id-${kind}-${code}`, hash, code.slice(0, 8), maxUses, now, now)
  }
}

async function seedInviter(
  test: Awaited<ReturnType<typeof fixture>>,
  userId: string,
  rawCode: string,
): Promise<void> {
  const now = Date.now()
  const code = rawCode.trim().toUpperCase()
  const hash = await commercialCodeDigest('affiliate', code, PEPPER)
  test.raw.prepare(
    `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'Inviter', ?, ?)`,
  ).run(userId, `${userId}@example.test`, now, now)
  test.raw.prepare(
    `INSERT INTO affiliate_profiles (
       user_id, code_hash, code_prefix, code_key_version, code_nonce_b64,
       code_ciphertext_b64, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 1, 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', ?, ?)`,
  ).run(userId, hash, code.slice(0, 8), now, now)
}
