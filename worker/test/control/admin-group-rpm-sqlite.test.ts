import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import {
  createAdminGroup,
  updateAdminGroupSortOrder,
  listAdminGroups,
  deleteAdminGroup,
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
  app.put('/groups/sort-order', updateAdminGroupSortOrder)
  app.get('/groups', listAdminGroups)
  app.delete('/groups/:id', deleteAdminGroup)
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
  it('atomically sorts groups, replays idempotently and rejects stale batches', async () => {
    const test = fixture()
    for (const id of ['sort-a', 'sort-b']) test.raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, 'openai', 1, 1, 1)`,
    ).run(id, id)
    const request = (key: string, updates: unknown[]) => test.app.request('/groups/sort-order', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ updates }),
    }, test.env)
    const updates = [{ id: 'sort-a', sort_order: 20, control_version: 0 }, { id: 'sort-b', sort_order: 10, control_version: 0 }]
    const saved = await request('group-sort-success', updates)
    expect(saved.status, await saved.clone().text()).toBe(200)
    const replay = await request('group-sort-success', updates)
    expect(await replay.json()).toEqual(await saved.json())
    const stale = await request('group-sort-stale', updates)
    expect(stale.status).toBe(412)
    const originalBatch = test.env.DB.batch.bind(test.env.DB)
    test.env.DB.batch = async statements => {
      test.raw.exec(`UPDATE "groups" SET control_version = 2 WHERE id = 'sort-b'`)
      return originalBatch(statements)
    }
    const raced = await request('group-sort-race', updates.map(update => ({ ...update, sort_order: 99, control_version: 1 })))
    expect(raced.status).toBe(412)
    const rows = test.raw.prepare('SELECT id, sort_order FROM "groups" ORDER BY sort_order').all()
    expect(rows).toEqual([{ id: 'sort-b', sort_order: 10 }, { id: 'sort-a', sort_order: 20 }])
  })

  it('preserves group UI configuration through CRUD, filtering and CAS updates', async () => {
    const test = fixture()
    const headers = (key: string, version?: number) => ({
      'content-type': 'application/json', 'idempotency-key': key,
      ...(version === undefined ? {} : { 'if-match': String(version) }),
    })
    const created = await test.app.request('/groups', {
      method: 'POST', headers: headers('groups-ui-create'),
      body: JSON.stringify({ name: 'UI Group', platform: 'openai', is_exclusive: false,
        max_reasoning_effort: 'high', supported_model_scopes: ['text'],
        models_list_config: { enabled: true, models: ['gpt-test'] },
        model_routing_enabled: true, model_routing: { 'gpt-*': [7, 'account-8'] } }),
    }, test.env)
    expect(created.status, await created.clone().text()).toBe(201)
    const group = (await created.json() as any).data
    expect(group).toMatchObject({ max_reasoning_effort: 'high', supported_model_scopes: ['text'],
      models_list_config: { enabled: true, models: ['gpt-test'] },
      model_routing_enabled: true, model_routing: { 'gpt-*': ['7', 'account-8'] } })
    expect(group).not.toHaveProperty('ui_config_json')
    const updated = await test.app.request(`/groups/${group.id}`, {
      method: 'PUT', headers: headers('groups-ui-update', 0),
      body: JSON.stringify({ supported_model_scopes: [], models_list_config: null }),
    }, test.env)
    expect(updated.status, await updated.clone().text()).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({ data: {
      max_reasoning_effort: 'high', supported_model_scopes: [], models_list_config: null, control_version: 1,
    } })
    const stale = await test.app.request(`/groups/${group.id}`, {
      method: 'PUT', headers: headers('groups-ui-stale', 0), body: JSON.stringify({ name: 'stale' }),
    }, test.env)
    expect(stale.status).toBe(412)
    const list = await test.app.request('/groups?search=UI&is_exclusive=false&sort_by=name&sort_order=asc', {}, test.env)
    await expect(list.json()).resolves.toMatchObject({ data: { total: 1, items: [{ id: group.id, max_reasoning_effort: 'high' }] } })
    const detail = await test.app.request(`/groups/${group.id}`, {}, test.env)
    await expect(detail.json()).resolves.toMatchObject({ data: { supported_model_scopes: [] } })
    const deleted = await test.app.request(`/groups/${group.id}`, {
      method: 'DELETE', headers: headers('groups-ui-delete', 1),
    }, test.env)
    expect(deleted.status, await deleted.clone().text()).toBe(200)
    const unknown = await test.app.request('/groups', {
      method: 'POST', headers: headers('groups-ui-unknown'), body: JSON.stringify({ name: 'unknown', invented: true }),
    }, test.env)
    expect(unknown.status).toBe(400)
    const invalidModelList = await test.app.request('/groups', {
      method: 'POST', headers: headers('groups-ui-invalid-model-list'),
      body: JSON.stringify({ name: 'invalid model list', models_list_config: { enabled: true, models: ['gpt-test', 'gpt-test'] } }),
    }, test.env)
    expect(invalidModelList.status).toBe(400)
    await expect(invalidModelList.json()).resolves.toMatchObject({ code: 'invalid_models_list_config' })
    const invalidRouting = await test.app.request('/groups', {
      method: 'POST', headers: headers('groups-ui-invalid-routing'),
      body: JSON.stringify({ name: 'invalid routing', model_routing: { 'g*pt': ['account-1'] } }),
    }, test.env)
    expect(invalidRouting.status).toBe(400)
    await expect(invalidRouting.json()).resolves.toMatchObject({ code: 'invalid_model_routing' })
  })

  it('round-trips exact image generation policy and rejects an underfunded hold', async () => {
    const test = fixture()
    const created = await test.app.request('/groups', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-image-policy-create-0001',
      },
      body: JSON.stringify({
        name: 'Gemini images',
        platform: 'gemini',
        is_exclusive: false,
        allow_image_generation: true,
        allow_batch_image_generation: true,
        image_rate_independent: true,
        image_rate_multiplier_ppm: 1_250_000,
        batch_image_discount_multiplier_ppm: 500_000,
        batch_image_hold_multiplier_ppm: 600_000,
        image_price_1k_micros: 20_000,
        image_price_2k_micros: 30_000,
        image_price_4k_micros: null,
      }),
    }, test.env)
    expect(created.status).toBe(201)
    const group = (await created.json() as any).data
    expect(group).toMatchObject({
      allow_image_generation: true,
      allow_batch_image_generation: true,
      image_rate_independent: true,
      image_rate_multiplier_ppm: 1_250_000,
      batch_image_discount_multiplier_ppm: 500_000,
      batch_image_hold_multiplier_ppm: 600_000,
      image_price_1k_micros: 20_000,
      image_price_2k_micros: 30_000,
      image_price_4k_micros: null,
    })
    expect(test.raw.prepare(
      `SELECT allow_batch_image_generation, image_price_2k_micros
         FROM "groups" WHERE id = ?`,
    ).get(group.id)).toEqual({ allow_batch_image_generation: 1, image_price_2k_micros: 30_000 })

    const invalid = await test.app.request(`/groups/${group.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'group-image-policy-invalid-hold',
        'if-match': '"0"',
      },
      body: JSON.stringify({
        batch_image_discount_multiplier_ppm: 700_000,
        batch_image_hold_multiplier_ppm: 600_000,
      }),
    }, test.env)
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'invalid_batch_image_hold_multiplier' })
  })

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
