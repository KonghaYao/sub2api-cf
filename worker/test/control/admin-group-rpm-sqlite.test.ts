import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import {
  createAdminGroup,
  getAdminGroup,
  updateAdminGroup,
} from '../../src/control/catalog'
import {
  clearAdminGroupRpmOverrides,
  listAdminGroupRpmOverrides,
  putAdminGroupRpmOverrides,
} from '../../src/control/group-rpm'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture(): { app: Hono<{ Bindings: Env }>; env: Env; raw: any } {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const app = new Hono<{ Bindings: Env }>()
  app.post('/groups', createAdminGroup)
  app.get('/groups/:id', getAdminGroup)
  app.put('/groups/:id', updateAdminGroup)
  app.get('/groups/:id/rpm-overrides', listAdminGroupRpmOverrides)
  app.put('/groups/:id/rpm-overrides', putAdminGroupRpmOverrides)
  app.delete('/groups/:id/rpm-overrides', clearAdminGroupRpmOverrides)
  return {
    app,
    raw,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      ASSETS: {} as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
      AUTH_RATE_LIMIT: {} as DurableObjectNamespace,
      API_KEY_LIMIT_STATE: {} as DurableObjectNamespace,
    } as Env,
  }
}

describe('group RPM administration on D1', () => {
  it.each(['openai', 'anthropic', 'gemini', 'codex'])(
    'allows an enabled %s group for a Worker-native provider',
    async (platform) => {
      const test = fixture()
      const response = await test.app.request('/groups', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `group-provider-create-${platform}`,
        },
        body: JSON.stringify({ name: `${platform} group`, platform }),
      }, test.env)
      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({ data: { platform, enabled: true } })
    },
  )

  it('round-trips the group-wide RPM limit through create, read, and update', async () => {
    const test = fixture()
    const created = await test.app.request('/groups', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-create-0001',
      },
      body: JSON.stringify({ name: 'RPM group', rpm_limit: 60 }),
    }, test.env)
    expect(created.status).toBe(201)
    const group = (await created.json() as any).data
    expect(group.rpm_limit).toBe(60)

    const updated = await test.app.request(`/groups/${group.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-update-0001',
        'if-match': '"0"',
      },
      body: JSON.stringify({ rpm_limit: 90 }),
    }, test.env)
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      data: { id: group.id, rpm_limit: 90, control_version: 1 },
    })
    expect(test.raw.prepare(
      `SELECT rpm_limit FROM "groups" WHERE id = ?`,
    ).get(group.id)).toEqual({ rpm_limit: 90 })
  })

  it('replaces, lists, replays, and clears per-user overrides without touching other groups', async () => {
    const test = fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'one@example.test', 'One', 'user', 'active', ?, ?),
              ('user-2', 'two@example.test', 'Two', 'user', 'disabled', ?, ?)`,
    ).run(now, now, now, now)
    test.raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
       VALUES ('group-1', 'Primary', 'openai', 1, ?, ?),
              ('group-2', 'Other', 'openai', 1, ?, ?)`,
    ).run(now, now, now, now)
    test.raw.prepare(
      `INSERT INTO user_group_rpm_overrides
         (user_id, group_id, rpm_override, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'group-2', 999, ?, ?)`,
    ).run(now, now)

    const request = {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-overrides-put-0001',
      },
      body: JSON.stringify({
        entries: [
          { user_id: 'user-1', rpm_override: 0 },
          { user_id: 'user-2', rpm_override: 120 },
        ],
      }),
    }
    const first = await test.app.request('/groups/group-1/rpm-overrides', request, test.env)
    const replay = await test.app.request('/groups/group-1/rpm-overrides', request, test.env)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({ data: { updated: 2 } })

    const listed = await test.app.request('/groups/group-1/rpm-overrides', {}, test.env)
    await expect(listed.json()).resolves.toEqual({
      code: 0,
      data: [
        {
          user_id: 'user-1',
          user_name: 'One',
          user_email: 'one@example.test',
          user_notes: '',
          user_status: 'active',
          rpm_override: 0,
          control_version: 0,
        },
        {
          user_id: 'user-2',
          user_name: 'Two',
          user_email: 'two@example.test',
          user_notes: '',
          user_status: 'disabled',
          rpm_override: 120,
          control_version: 0,
        },
      ],
    })

    const replaced = await test.app.request('/groups/group-1/rpm-overrides', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-overrides-put-0002',
      },
      body: JSON.stringify({
        entries: [{ user_id: 'user-1', rpm_override: 60 }],
      }),
    }, test.env)
    expect(replaced.status).toBe(200)
    await expect(replaced.json()).resolves.toMatchObject({ data: { updated: 1 } })
    expect(test.raw.prepare(
      `SELECT user_id, rpm_override, control_version
         FROM user_group_rpm_overrides
        WHERE group_id = 'group-1'
        ORDER BY user_id`,
    ).all()).toEqual([{ user_id: 'user-1', rpm_override: 60, control_version: 1 }])
    expect(test.raw.prepare(
      `SELECT rpm_override FROM user_group_rpm_overrides WHERE group_id = 'group-2'`,
    ).get()).toEqual({ rpm_override: 999 })

    const cleared = await test.app.request('/groups/group-1/rpm-overrides', {
      method: 'DELETE',
      headers: { 'idempotency-key': 'group-rpm-overrides-clear-0001' },
    }, test.env)
    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toMatchObject({ data: { deleted: 1 } })
    expect(test.raw.prepare(
      `SELECT rpm_override FROM user_group_rpm_overrides WHERE group_id = 'group-2'`,
    ).get()).toEqual({ rpm_override: 999 })
  })

  it('treats an empty PUT collection as an idempotent group-scoped replacement', async () => {
    const test = fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'one@example.test', 'One', 'user', 'active', ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
       VALUES ('group-1', 'Primary', 'openai', 1, ?, ?),
              ('group-2', 'Other', 'openai', 1, ?, ?)`,
    ).run(now, now, now, now)
    test.raw.prepare(
      `INSERT INTO user_group_rpm_overrides
         (user_id, group_id, rpm_override, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'group-1', 10, ?, ?),
              ('user-1', 'group-2', 20, ?, ?)`,
    ).run(now, now, now, now)

    const request = {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-overrides-empty-0001',
      },
      body: JSON.stringify({ entries: [] }),
    }
    const first = await test.app.request('/groups/group-1/rpm-overrides', request, test.env)
    const replay = await test.app.request('/groups/group-1/rpm-overrides', request, test.env)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({ data: { updated: 0 } })
    await expect(replay.json()).resolves.toMatchObject({ data: { updated: 0 } })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM user_group_rpm_overrides WHERE group_id = 'group-1'`,
    ).get()).toEqual({ total: 0 })
    expect(test.raw.prepare(
      `SELECT rpm_override FROM user_group_rpm_overrides WHERE group_id = 'group-2'`,
    ).get()).toEqual({ rpm_override: 20 })
  })

  it('validates every user before replacing and rolls the whole D1 batch back on failure', async () => {
    const test = fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'one@example.test', 'One', 'user', 'active', ?, ?),
              ('user-2', 'two@example.test', 'Two', 'user', 'active', ?, ?)`,
    ).run(now, now, now, now)
    test.raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
       VALUES ('group-1', 'Primary', 'openai', 1, ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO user_group_rpm_overrides
         (user_id, group_id, rpm_override, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'group-1', 10, ?, ?),
              ('user-2', 'group-1', 20, ?, ?)`,
    ).run(now, now, now, now)

    const missingUser = await test.app.request('/groups/group-1/rpm-overrides', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-overrides-missing-user',
      },
      body: JSON.stringify({ entries: [{ user_id: 'missing-user', rpm_override: 30 }] }),
    }, test.env)
    expect(missingUser.status).toBe(404)
    expect(test.raw.prepare(
      `SELECT user_id, rpm_override FROM user_group_rpm_overrides
        WHERE group_id = 'group-1' ORDER BY user_id`,
    ).all()).toEqual([
      { user_id: 'user-1', rpm_override: 10 },
      { user_id: 'user-2', rpm_override: 20 },
    ])

    test.raw.exec(
      `CREATE TRIGGER reject_group_rpm_update
       BEFORE UPDATE ON user_group_rpm_overrides
       BEGIN
         SELECT RAISE(ABORT, 'forced update failure');
       END`,
    )
    const failedBatch = await test.app.request('/groups/group-1/rpm-overrides', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-overrides-failed-batch',
      },
      body: JSON.stringify({ entries: [{ user_id: 'user-1', rpm_override: 40 }] }),
    }, test.env)
    expect(failedBatch.status).toBe(500)
    expect(test.raw.prepare(
      `SELECT user_id, rpm_override FROM user_group_rpm_overrides
        WHERE group_id = 'group-1' ORDER BY user_id`,
    ).all()).toEqual([
      { user_id: 'user-1', rpm_override: 10 },
      { user_id: 'user-2', rpm_override: 20 },
    ])
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency WHERE resource_id = 'group-1'`,
    ).get()).toEqual({ total: 0 })
  })

  it('replaces the maximum 100 entries without exceeding a statement bind budget', async () => {
    const test = fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
       VALUES ('group-1', 'Primary', 'openai', 1, ?, ?)`,
    ).run(now, now)
    const insertUser = test.raw.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'user', 'active', ?, ?)`,
    )
    const entries = Array.from({ length: 100 }, (_, index) => {
      const userId = `user-${index + 1}`
      insertUser.run(userId, `${userId}@example.test`, userId, now, now)
      return { user_id: userId, rpm_override: index }
    })

    const response = await test.app.request('/groups/group-1/rpm-overrides', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-rpm-overrides-max-batch',
      },
      body: JSON.stringify({ entries }),
    }, test.env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { updated: 100 } })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM user_group_rpm_overrides WHERE group_id = 'group-1'`,
    ).get()).toEqual({ total: 100 })
  })

  it.each([
    [{ entries: [{ user_id: 'user-1', rpm_override: -1 }] }, 'invalid_rpm_override'],
    [{ entries: [{ user_id: 'user-1', rpm_override: 1.5 }] }, 'invalid_rpm_override'],
    [{ entries: [{ user_id: 'user-1', rpm_override: 1 }, { user_id: 'user-1', rpm_override: 2 }] }, 'duplicate_user_id'],
  ])('rejects malformed override batches %j', async (body, code) => {
    const test = fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
       VALUES ('group-1', 'Primary', 'openai', 1, ?, ?)`,
    ).run(now, now)
    const response = await test.app.request('/groups/group-1/rpm-overrides', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `group-rpm-invalid-${code}`,
      },
      body: JSON.stringify(body),
    }, test.env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code } })
  })
})
