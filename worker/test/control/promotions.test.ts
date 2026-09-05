import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import {
  createAdminInvitationCode,
  createAdminPromotionCode,
  deleteAdminInvitationCode,
  deleteAdminPromotionCode,
  getAdminCommercialConfig,
  getAdminInvitationCode,
  getAdminPromotionCode,
  listAdminPromotionCodes,
  listAdminPromotionUsages,
  updateAdminPromotionCode,
  updateAdminInvitationCode,
  updateAdminCommercialConfig,
} from '../../src/control/promotions'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'admin-promotion-pepper-at-least-32-bytes'
const MASTER_KEY = 'admin-promotion-master-key-at-least-32-bytes'

describe('admin promotion HTTP contract', () => {
  it('keeps code lookup hashed while preserving the existing admin CRUD shape', async () => {
    const test = await fixture()
    const app = routes()
    expect((await app.request('/promo', {}, test.env)).status).toBe(401)

    const created = await app.request('/promo', {
      method: 'POST', headers: { ...test.jsonHeaders, 'idempotency-key': 'promo-create-shape-1' },
      body: JSON.stringify({ code: ' Welcome_One ', bonus_amount: 2.5, max_uses: 2, notes: 'launch' }),
    }, test.env)
    expect(created.status).toBe(201)
    const createdBody = await created.json() as any
    expect(createdBody.data).toMatchObject({
      code: 'WELCOME_ONE', bonus_amount: 2.5, max_uses: 2, used_count: 0, status: 'active',
    })
    expect(JSON.stringify(test.raw.prepare(
      `SELECT code_hash, code_prefix FROM promotion_codes`,
    ).get())).not.toContain('WELCOME_ONE')

    const listed = await app.request('/promo?page=1&page_size=20&search=welcome_one', {
      headers: test.authHeaders,
    }, test.env)
    await expect(listed.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ code: 'WELCOME_ONE', bonus_amount: 2.5 }] },
    })

    const id = createdBody.data.id
    const updated = await app.request(`/promo/${id}`, {
      method: 'PUT', headers: {
        ...test.jsonHeaders, 'idempotency-key': 'promo-update-shape-1', 'if-match': '"0"',
      },
      body: JSON.stringify({ bonus_amount: 3, status: 'disabled', notes: 'paused' }),
    }, test.env)
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      data: { id, code: 'WELCOME_ONE', bonus_amount: 3, status: 'disabled', notes: 'paused' },
    })
    const detail = await app.request(`/promo/${id}`, { headers: test.authHeaders }, test.env)
    await expect(detail.json()).resolves.toMatchObject({ data: { control_version: 1 } })
    expect(detail.headers.get('etag')).toBe('"1"')

    const deleted = await app.request(`/promo/${id}`, {
      method: 'DELETE', headers: {
        ...test.authHeaders, 'idempotency-key': 'promo-delete-shape-1', 'if-match': '"1"',
      },
    }, test.env)
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toMatchObject({ data: { message: 'Promo code deleted successfully' } })
  })

  it('lists usage owners without exposing hashes and refuses deletion after use', async () => {
    const test = await fixture()
    const app = routes()
    const created = await app.request('/promo', {
      method: 'POST', headers: { ...test.jsonHeaders, 'idempotency-key': 'promo-create-used-1' },
      body: JSON.stringify({ code: 'USED-CODE', bonus_amount: 1, max_uses: 10 }),
    }, test.env)
    const id = (await created.json() as any).data.id
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('customer', 'customer@example.test', 'Customer', ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO promotion_code_usages (id, promotion_code_id, user_id, bonus_micros, used_at_ms)
       VALUES ('usage', ?, 'customer', 1000000, ?)`,
    ).run(id, now)

    const usages = await app.request(`/promo/${id}/usages`, { headers: test.authHeaders }, test.env)
    await expect(usages.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ user_id: 'customer', bonus_amount: 1, user: { email: 'customer@example.test' } }] },
    })
    const rejected = await app.request(`/promo/${id}`, {
      method: 'DELETE', headers: {
        ...test.authHeaders, 'idempotency-key': 'promo-delete-used-1', 'if-match': '"0"',
      },
    }, test.env)
    expect(rejected.status).toBe(409)
  })

  it('creates single-use invitation codes through a dedicated control-plane boundary', async () => {
    const test = await fixture()
    const app = routes()
    const response = await app.request('/invitation', {
      method: 'POST', headers: { ...test.jsonHeaders, 'idempotency-key': 'invitation-create-1' },
      body: JSON.stringify({ code: ' Invite-X ', max_uses: 1 }),
    }, test.env)
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      data: { code: 'INVITE-X', max_uses: 1, used_count: 0, status: 'active' },
    })
  })

  it('requires create idempotency and replays the same encrypted resource without another audit', async () => {
    const test = await fixture()
    const app = routes()
    const body = JSON.stringify({ code: 'REPLAY-CODE', bonus_amount: 4, max_uses: 3 })
    const missing = await app.request('/promo', {
      method: 'POST', headers: test.jsonHeaders, body,
    }, test.env)
    expect(missing.status).toBe(400)

    const headers = { ...test.jsonHeaders, 'idempotency-key': 'promotion-create-replay-0001' }
    const first = await app.request('/promo', { method: 'POST', headers, body }, test.env)
    const replay = await app.request('/promo', { method: 'POST', headers, body }, test.env)
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(first.headers.get('etag')).toBe('"0"')
    expect(replay.headers.get('etag')).toBe('"0"')
    expect(await replay.json()).toEqual(await first.json())
    expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM promotion_codes`).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action = 'promotion_code.create'`,
    ).get()).toEqual({ total: 1 })
    expect(JSON.stringify(test.raw.prepare(
      `SELECT response_json FROM control_idempotency
        WHERE scope = 'commercial.promotion-code.create.v1'`,
    ).get())).not.toContain('REPLAY-CODE')

    const conflict = await app.request('/promo', {
      method: 'POST', headers,
      body: JSON.stringify({ code: 'DIFFERENT-CODE', bonus_amount: 4, max_uses: 3 }),
    }, test.env)
    expect(conflict.status).toBe(409)
  })

  it('requires If-Match and lets only one concurrent update commit and audit', async () => {
    const test = await fixture()
    const app = routes()
    const created = await app.request('/promo', {
      method: 'POST',
      headers: { ...test.jsonHeaders, 'idempotency-key': 'promotion-create-for-update-1' },
      body: JSON.stringify({ code: 'CAS-UPDATE', bonus_amount: 1, max_uses: 5 }),
    }, test.env)
    const id = (await created.json() as any).data.id

    const missingVersion = await app.request(`/promo/${id}`, {
      method: 'PUT',
      headers: { ...test.jsonHeaders, 'idempotency-key': 'promotion-update-missing-version' },
      body: JSON.stringify({ notes: 'missing' }),
    }, test.env)
    expect(missingVersion.status).toBe(428)
    const missingKey = await app.request(`/promo/${id}`, {
      method: 'PUT',
      headers: { ...test.jsonHeaders, 'if-match': '"0"' },
      body: JSON.stringify({ notes: 'missing key' }),
    }, test.env)
    expect(missingKey.status).toBe(400)

    const body = JSON.stringify({ notes: 'winner' })
    const requests = ['promotion-update-cas-a', 'promotion-update-cas-b'].map((key) =>
      app.request(`/promo/${id}`, {
        method: 'PUT',
        headers: { ...test.jsonHeaders, 'idempotency-key': key, 'if-match': '"0"' },
        body,
      }, test.env))
    const responses = await Promise.all(requests)
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412])
    expect(test.raw.prepare(
      `SELECT control_version, notes FROM promotion_codes WHERE id = ?`,
    ).get(id)).toEqual({ control_version: 1, notes: 'winner' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action = 'promotion_code.update'`,
    ).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'commercial.promotion-code.update.v1'`,
    ).get()).toEqual({ total: 1 })

    const detail = await app.request(`/promo/${id}`, { headers: test.authHeaders }, test.env)
    expect(detail.headers.get('etag')).toBe('"1"')
    const winner = responses.findIndex((response) => response.status === 200)
    const reused = await app.request(`/promo/${id}`, {
      method: 'PUT',
      headers: {
        ...test.jsonHeaders,
        'idempotency-key': ['promotion-update-cas-a', 'promotion-update-cas-b'][winner]!,
        'if-match': '"0"',
      },
      body: JSON.stringify({ notes: 'different request' }),
    }, test.env)
    expect(reused.status).toBe(409)
  })

  it('uses delete CAS and leaves no ghost audit for the losing request', async () => {
    const test = await fixture()
    const app = routes()
    const created = await app.request('/promo', {
      method: 'POST',
      headers: { ...test.jsonHeaders, 'idempotency-key': 'promotion-create-for-delete-1' },
      body: JSON.stringify({ code: 'CAS-DELETE', bonus_amount: 1, max_uses: 1 }),
    }, test.env)
    const id = (await created.json() as any).data.id

    const missingVersion = await app.request(`/promo/${id}`, {
      method: 'DELETE',
      headers: { ...test.authHeaders, 'idempotency-key': 'promotion-delete-missing-version' },
    }, test.env)
    expect(missingVersion.status).toBe(428)
    const missingKey = await app.request(`/promo/${id}`, {
      method: 'DELETE', headers: { ...test.authHeaders, 'if-match': '"0"' },
    }, test.env)
    expect(missingKey.status).toBe(400)

    const responses = await Promise.all(['promotion-delete-cas-a', 'promotion-delete-cas-b'].map((key) =>
      app.request(`/promo/${id}`, {
        method: 'DELETE',
        headers: { ...test.authHeaders, 'idempotency-key': key, 'if-match': '"0"' },
      }, test.env)))
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1)
    expect(responses.filter((response) => response.status !== 200)).toHaveLength(1)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action = 'promotion_code.delete'`,
    ).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'commercial.promotion-code.delete.v1'`,
    ).get()).toEqual({ total: 1 })
    const winner = responses.findIndex((response) => response.status === 200)
    const replay = await app.request(`/promo/${id}`, {
      method: 'DELETE',
      headers: {
        ...test.authHeaders,
        'idempotency-key': ['promotion-delete-cas-a', 'promotion-delete-cas-b'][winner]!,
        'if-match': '"0"',
      },
    }, test.env)
    expect(replay.status).toBe(200)
    const reused = await app.request(`/promo/${id}`, {
      method: 'DELETE',
      headers: {
        ...test.authHeaders,
        'content-type': 'application/json',
        'idempotency-key': ['promotion-delete-cas-a', 'promotion-delete-cas-b'][winner]!,
        'if-match': '"1"',
      },
      body: JSON.stringify({ expected_control_version: 1 }),
    }, test.env)
    expect(reused.status).toBe(409)
  })

  it('applies the same ETag, idempotency, update and delete contract to invitation codes', async () => {
    const test = await fixture()
    const app = routes()
    const created = await app.request('/invitation', {
      method: 'POST',
      headers: { ...test.jsonHeaders, 'idempotency-key': 'invitation-crud-create-1' },
      body: JSON.stringify({ code: 'INVITATION-CAS', max_uses: 2 }),
    }, test.env)
    const createdBody = await created.json() as any
    const id = createdBody.data.id
    expect(created.headers.get('etag')).toBe('"0"')
    const detail = await app.request(`/invitation/${id}`, { headers: test.authHeaders }, test.env)
    expect(detail.headers.get('etag')).toBe('"0"')

    const updated = await app.request(`/invitation/${id}`, {
      method: 'PUT',
      headers: {
        ...test.jsonHeaders, 'idempotency-key': 'invitation-crud-update-1', 'if-match': '"0"',
      },
      body: JSON.stringify({ max_uses: 3, notes: 'expanded' }),
    }, test.env)
    expect(updated.status).toBe(200)
    expect(updated.headers.get('etag')).toBe('"1"')

    const deleted = await app.request(`/invitation/${id}`, {
      method: 'DELETE',
      headers: {
        ...test.authHeaders, 'idempotency-key': 'invitation-crud-delete-1', 'if-match': '"1"',
      },
    }, test.env)
    expect(deleted.status).toBe(200)
    const replay = await app.request(`/invitation/${id}`, {
      method: 'DELETE',
      headers: {
        ...test.authHeaders, 'idempotency-key': 'invitation-crud-delete-1', 'if-match': '"1"',
      },
    }, test.env)
    expect(await replay.json()).toEqual(await deleted.json())
    expect(test.raw.prepare(
      `SELECT action, COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action LIKE 'invitation_code.%' GROUP BY action ORDER BY action`,
    ).all()).toEqual([
      { action: 'invitation_code.create', total: 1 },
      { action: 'invitation_code.delete', total: 1 },
      { action: 'invitation_code.update', total: 1 },
    ])
  })

  it('updates private commercial policy with ETag, CAS and idempotent replay', async () => {
    const test = await fixture()
    const app = routes()

    const current = await app.request('/commercial', { headers: test.authHeaders }, test.env)
    expect(current.headers.get('etag')).toBe('"0"')

    const body = JSON.stringify({
      affiliate_rebate_rate: 12.5,
      affiliate_rebate_freeze_hours: 24,
      affiliate_rebate_duration_days: 365,
      affiliate_rebate_per_invitee_cap: 50,
      affiliate_admin_recharge_enabled: true,
    })
    const missingKey = await app.request('/commercial', {
      method: 'PUT', headers: { ...test.jsonHeaders, 'if-match': '"0"' }, body,
    }, test.env)
    expect(missingKey.status).toBe(400)
    const missingVersion = await app.request('/commercial', {
      method: 'PUT',
      headers: { ...test.jsonHeaders, 'idempotency-key': 'commercial-config-no-version' },
      body,
    }, test.env)
    expect(missingVersion.status).toBe(428)

    const headers = {
      ...test.jsonHeaders,
      'if-match': '"0"',
      'idempotency-key': 'commercial-config-save-1',
    }
    const updated = await app.request('/commercial', { method: 'PUT', headers, body }, test.env)
    expect(updated.status).toBe(200)
    expect(updated.headers.get('etag')).toBe('"1"')
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        control_version: 1,
        affiliate_rebate_rate: 12.5,
        affiliate_rebate_freeze_hours: 24,
        affiliate_rebate_per_invitee_cap: 50,
        affiliate_admin_recharge_enabled: true,
      },
    })

    const replay = await app.request('/commercial', { method: 'PUT', headers, body }, test.env)
    expect(replay.status).toBe(200)
    expect(replay.headers.get('etag')).toBe('"1"')
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action = 'commercial_config.update'`,
    ).get()).toEqual({ total: 1 })

    const reused = await app.request('/commercial', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ affiliate_rebate_rate: 20 }),
    }, test.env)
    expect(reused.status).toBe(409)

    const stale = await app.request('/commercial', {
      method: 'PUT',
      headers: {
        ...test.jsonHeaders,
        'if-match': '"0"',
        'idempotency-key': 'commercial-config-save-2',
      },
      body: JSON.stringify({ affiliate_rebate_rate: 20 }),
    }, test.env)
    expect(stale.status).toBe(412)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action = 'commercial_config.update'`,
    ).get()).toEqual({ total: 1 })
  })
})

function routes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/promo', listAdminPromotionCodes)
  app.post('/promo', createAdminPromotionCode)
  app.get('/promo/:id', getAdminPromotionCode)
  app.put('/promo/:id', updateAdminPromotionCode)
  app.delete('/promo/:id', deleteAdminPromotionCode)
  app.get('/promo/:id/usages', listAdminPromotionUsages)
  app.post('/invitation', createAdminInvitationCode)
  app.get('/invitation/:id', getAdminInvitationCode)
  app.put('/invitation/:id', updateAdminInvitationCode)
  app.delete('/invitation/:id', deleteAdminInvitationCode)
  app.get('/commercial', getAdminCommercialConfig)
  app.put('/commercial', updateAdminCommercialConfig)
  return app
}

async function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', ?, ?)`,
  ).run(now, now)
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('admin-session', 'admin-family', 'admin', 1, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    now, now + 60_000, now + 120_000,
  )
  const authHeaders = { authorization: `Bearer ${access}` }
  return {
    raw,
    authHeaders,
    jsonHeaders: { ...authHeaders, 'content-type': 'application/json' },
    env: {
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
      CREDENTIALS_MASTER_KEY: MASTER_KEY,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    } satisfies Env,
  }
}
