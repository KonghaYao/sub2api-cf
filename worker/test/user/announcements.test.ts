import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import {
  createAdminAnnouncement,
  deleteAdminAnnouncement,
  getAdminAnnouncement,
  listAdminAnnouncementReadStatus,
  listAdminAnnouncements,
  listMyAnnouncements,
  markMyAnnouncementRead,
  updateAdminAnnouncement,
} from '../../src/user/announcements'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'announcement-test-pepper-value-32-bytes'

async function fixture(): Promise<{
  raw: any
  env: Env
  auth: Record<'admin' | 'alice' | 'bob', string>
}> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, balance_micros, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', 0, ?, ?),
            ('alice', 'alice@example.test', 'Alice', 'user', 5000000, ?, ?),
            ('bob', 'bob@example.test', 'Bob', 'user', 1000000, ?, ?)`,
  ).run(now, now, now, now, now, now)
  raw.prepare(
    `INSERT INTO "groups" (id, name, platform, enabled, group_type, created_at_ms, updated_at_ms)
     VALUES ('group-pro', 'Pro', 'openai', 1, 'subscription', ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO user_subscriptions (
       id, user_id, group_id, status, starts_at_ms, expires_at_ms,
       source_type, source_id, created_at_ms, updated_at_ms
     ) VALUES ('sub-alice', 'alice', 'group-pro', 'active', ?, ?, 'admin', 'setup', ?, ?)`,
  ).run(now - 1_000, now + 86_400_000, now, now)

  const auth = {} as Record<'admin' | 'alice' | 'bob', string>
  for (const user of ['admin', 'alice', 'bob'] as const) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `session-${user}`, `family-${user}`, user,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      now, now + 60_000, now + 600_000,
    )
    auth[user] = `Bearer ${access}`
  }
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch: async () => Response.json({}) }),
  } as unknown as DurableObjectNamespace
  return {
    raw,
    auth,
    env: {
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
      DB: d1, ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
      USER_STATE: namespace, SUBSCRIPTION_STATE: namespace,
      POOL_STATE: namespace, API_KEY_LIMIT_STATE: namespace,
    },
  }
}

function api() {
  const app = new Hono<{ Bindings: Env }>()
  app.post('/admin/announcements', createAdminAnnouncement)
  app.get('/admin/announcements', listAdminAnnouncements)
  app.get('/admin/announcements/:id', getAdminAnnouncement)
  app.put('/admin/announcements/:id', updateAdminAnnouncement)
  app.delete('/admin/announcements/:id', deleteAdminAnnouncement)
  app.get('/admin/announcements/:id/read-status', listAdminAnnouncementReadStatus)
  app.get('/announcements', listMyAnnouncements)
  app.post('/announcements/:id/read', markMyAnnouncementRead)
  return app
}

describe('announcement HTTP boundaries', () => {
  it('publishes a targeted announcement and keeps read state owner-scoped', async () => {
    const test = await fixture()
    const app = api()
    const created = await app.request('/admin/announcements', {
      method: 'POST',
      headers: {
        authorization: test.auth.admin,
        'content-type': 'application/json',
        'idempotency-key': 'announcement-create-0001',
      },
      body: JSON.stringify({
        title: 'Pro maintenance',
        content: '**Maintenance** tonight.',
        status: 'active',
        notify_mode: 'popup',
        targeting: {
          any_of: [{ all_of: [{
            type: 'subscription', operator: 'in', group_ids: ['group-pro'],
          }] }],
        },
      }),
    }, test.env)
    expect(created.status).toBe(201)
    expect(created.headers.get('etag')).toBe('"1"')
    const createdBody = await created.json() as any
    const id = createdBody.data.id as string

    const alice = await app.request('/announcements', {
      headers: { authorization: test.auth.alice },
    }, test.env)
    expect(alice.status).toBe(200)
    await expect(alice.json()).resolves.toMatchObject({
      data: [{ id, title: 'Pro maintenance', notify_mode: 'popup', read_at: null }],
    })
    const productionRoute = await createApp().request('/api/v1/announcements', {
      headers: { authorization: test.auth.alice },
    }, test.env)
    expect(productionRoute.status).toBe(200)
    expect(((await productionRoute.json()) as any).data[0].id).toBe(id)
    const productionAdminRoute = await createApp().request('/api/v1/admin/announcements', {
      headers: { authorization: test.auth.admin },
    }, test.env)
    expect(productionAdminRoute.status).toBe(200)
    expect(((await productionAdminRoute.json()) as any).data.items[0].id).toBe(id)

    const bob = await app.request('/announcements', {
      headers: { authorization: test.auth.bob },
    }, test.env)
    await expect(bob.json()).resolves.toEqual({ code: 0, data: [] })
    expect((await app.request(`/announcements/${id}/read`, {
      method: 'POST', headers: { authorization: test.auth.bob },
    }, test.env)).status).toBe(404)

    expect((await app.request(`/announcements/${id}/read`, {
      method: 'POST', headers: { authorization: test.auth.alice },
    }, test.env)).status).toBe(200)
    const unread = await app.request('/announcements?unread_only=1', {
      headers: { authorization: test.auth.alice },
    }, test.env)
    await expect(unread.json()).resolves.toEqual({ code: 0, data: [] })
    test.raw.close()
  })

  it('provides a guarded admin lifecycle and paged eligibility/read status', async () => {
    const test = await fixture()
    const app = api()
    const create = (key: string, title: string, status = 'draft') => app.request(
      '/admin/announcements',
      {
        method: 'POST',
        headers: {
          authorization: test.auth.admin,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          title, content: `${title} content`, status, targeting: { any_of: [] },
        }),
      },
      test.env,
    )
    const first = await create('announcement-admin-0001', 'Alpha notice')
    const replay = await create('announcement-admin-0001', 'Alpha notice')
    expect(first.status).toBe(201)
    expect(await replay.json()).toEqual(await first.clone().json())
    const id = ((await first.json()) as any).data.id as string
    await create('announcement-admin-0002', 'Beta notice', 'active')

    const listed = await app.request(
      '/admin/announcements?page=1&page_size=1&status=draft&search=Alpha&sort_by=title&sort_order=asc',
      { headers: { authorization: test.auth.admin } },
      test.env,
    )
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      data: { items: [{ id, title: 'Alpha notice' }], total: 1, page: 1, page_size: 1 },
    })

    const detail = await app.request(`/admin/announcements/${id}`, {
      headers: { authorization: test.auth.admin },
    }, test.env)
    expect(detail.headers.get('etag')).toBe('"1"')
    const updated = await app.request(`/admin/announcements/${id}`, {
      method: 'PUT',
      headers: {
        authorization: test.auth.admin,
        'content-type': 'application/json',
        'idempotency-key': 'announcement-update-0001',
        'if-match': '"1"',
      },
      body: JSON.stringify({ title: 'Alpha published', status: 'active' }),
    }, test.env)
    expect(updated.status).toBe(200)
    expect(updated.headers.get('etag')).toBe('"2"')
    const updateReplay = await app.request(`/admin/announcements/${id}`, {
      method: 'PUT',
      headers: {
        authorization: test.auth.admin,
        'content-type': 'application/json',
        'idempotency-key': 'announcement-update-0001',
        'if-match': '"1"',
      },
      body: JSON.stringify({ title: 'Alpha published', status: 'active' }),
    }, test.env)
    expect(updateReplay.status).toBe(200)
    expect(updateReplay.headers.get('etag')).toBe('"2"')
    expect((await app.request(`/admin/announcements/${id}`, {
      method: 'PUT',
      headers: {
        authorization: test.auth.admin,
        'content-type': 'application/json',
        'idempotency-key': 'announcement-update-stale-0001',
        'if-match': '"1"',
      },
      body: JSON.stringify({ title: 'stale' }),
    }, test.env)).status).toBe(412)

    await app.request(`/announcements/${id}/read`, {
      method: 'POST', headers: { authorization: test.auth.alice },
    }, test.env)
    const statuses = await app.request(
      `/admin/announcements/${id}/read-status?page=1&page_size=10&sort_by=email&sort_order=asc`,
      { headers: { authorization: test.auth.admin } },
      test.env,
    )
    expect(statuses.status).toBe(200)
    const statusBody = await statuses.json() as any
    expect(statusBody.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: 'alice', eligible: true }),
      expect.objectContaining({ user_id: 'bob', eligible: true, read_at: null }),
    ]))
    expect(statusBody.data.items.find((item: any) => item.user_id === 'alice').read_at).toMatch(/T/)
    expect((await app.request(
      `/admin/announcements/${id}/read-status?sort_by=read_at`,
      { headers: { authorization: test.auth.admin } },
      test.env,
    )).status).toBe(400)

    const deleted = await app.request(`/admin/announcements/${id}`, {
      method: 'DELETE',
      headers: {
        authorization: test.auth.admin,
        'idempotency-key': 'announcement-delete-0001',
        'if-match': '"2"',
      },
    }, test.env)
    expect(deleted.status).toBe(200)
    const deleteReplay = await app.request(`/admin/announcements/${id}`, {
      method: 'DELETE',
      headers: {
        authorization: test.auth.admin,
        'idempotency-key': 'announcement-delete-0001',
        'if-match': '"2"',
      },
    }, test.env)
    expect(deleteReplay.status).toBe(200)
    expect((await app.request(`/admin/announcements/${id}`, {
      headers: { authorization: test.auth.admin },
    }, test.env)).status).toBe(404)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM announcement_admin_audit_events WHERE announcement_id = ?`,
    ).get(id)).toEqual({ total: 3 })
    test.raw.close()
  })

  it('serializes create replay and rejects invalid or inactive targeting facts', async () => {
    const test = await fixture()
    const app = api()
    const request = (body: Record<string, unknown>, key = 'announcement-race-0001') =>
      app.request('/admin/announcements', {
        method: 'POST',
        headers: {
          authorization: test.auth.admin,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      }, test.env)
    const balanceNotice = {
      title: 'Balance notice', content: 'For funded users', status: 'active',
      targeting: { any_of: [
        { all_of: [
          { type: 'subscription', operator: 'in', group_ids: ['group-pro'] },
          { type: 'balance', operator: 'gt', value: 10 },
        ] },
        { all_of: [{ type: 'balance', operator: 'eq', value: 5 }] },
      ] },
    }
    const concurrent = await Promise.all([request(balanceNotice), request(balanceNotice)])
    expect(concurrent.map((response) => response.status)).toEqual([201, 201])
    const payloads = await Promise.all(concurrent.map((response) => response.json()))
    expect(payloads[0]).toEqual(payloads[1])
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM announcements').get()).toEqual({ total: 1 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM announcement_admin_audit_events').get()).toEqual({ total: 1 })

    const conflict = await request({ ...balanceNotice, title: 'Different title' })
    expect(conflict.status).toBe(409)
    const invalidGroup = await request({
      title: 'Invalid target', content: 'No such group', status: 'active',
      targeting: { any_of: [{ all_of: [{
        type: 'subscription', operator: 'in', group_ids: ['missing-group'],
      }] }] },
    }, 'announcement-invalid-0001')
    expect(invalidGroup.status).toBe(400)
    expect((await request({
      title: 'Empty target', content: 'Invalid empty group', status: 'active',
      targeting: { any_of: [{ all_of: [] }] },
    }, 'announcement-invalid-0003')).status).toBe(400)
    expect((await request({
      title: 'Too many conditions', content: 'Bound Worker evaluation', status: 'active',
      targeting: {
        any_of: Array.from({ length: 3 }, () => ({
          all_of: Array.from({ length: 34 }, () => ({
            type: 'balance', operator: 'gte', value: 0,
          })),
        })),
      },
    }, 'announcement-invalid-0004')).status).toBe(400)
    expect((await app.request('/admin/announcements?page=101', {
      headers: { authorization: test.auth.admin },
    }, test.env)).status).toBe(400)
    const invalidSchedule = await request({
      title: 'Bad schedule', content: 'Bad schedule', status: 'active',
      starts_at: 2_000_000_000, ends_at: 1_900_000_000,
      targeting: { any_of: [] },
    }, 'announcement-invalid-0002')
    expect(invalidSchedule.status).toBe(400)
    await request({
      title: 'Future', content: 'Not yet', status: 'active',
      starts_at: Math.floor(Date.now() / 1_000) + 3_600,
      targeting: { any_of: [] },
    }, 'announcement-future-0001')

    const alice = await app.request('/announcements', {
      headers: { authorization: test.auth.alice },
    }, test.env)
    expect(((await alice.json()) as any).data.map((item: any) => item.title)).toEqual(['Balance notice'])
    const bob = await app.request('/announcements', {
      headers: { authorization: test.auth.bob },
    }, test.env)
    expect(((await bob.json()) as any).data).toEqual([])
    test.raw.close()
  })
})
