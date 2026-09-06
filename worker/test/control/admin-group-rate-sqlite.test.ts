import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import {
  clearAdminGroupRateMultipliers,
  listAdminGroupRateMultipliers,
  putAdminGroupRateMultipliers,
} from '../../src/control/group-rate'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`
    INSERT INTO "groups" (id, name, platform, enabled, rate_multiplier_ppm, created_at_ms, updated_at_ms)
    VALUES ('group-a', 'Group A', 'openai', 1, 1250000, 1, 1);
    INSERT INTO users (id, email, display_name, status, created_at_ms, updated_at_ms)
    VALUES ('alice', 'alice@example.test', 'Alice', 'active', 1, 1),
           ('bob', 'bob@example.test', 'Bob', 'disabled', 1, 1);
    INSERT INTO user_group_rate_overrides (user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms)
    VALUES ('alice', 'group-a', 800000, 1, 1), ('bob', 'group-a', 900000, 1, 1);
    INSERT INTO user_group_rpm_overrides (user_id, group_id, rpm_override, created_at_ms, updated_at_ms)
    VALUES ('bob', 'group-a', 12, 1, 1);
  `)
  const app = new Hono<{ Bindings: Env }>()
  app.get('/groups/:id/rate-multipliers', listAdminGroupRateMultipliers)
  app.put('/groups/:id/rate-multipliers', putAdminGroupRateMultipliers)
  app.delete('/groups/:id/rate-multipliers', clearAdminGroupRateMultipliers)
  const env = { DB: d1 } as Env
  return { raw, app, env }
}

describe('group rate multiplier administration on D1', () => {
  it('lists legacy-shaped rows and atomically replaces only the rate half of overrides', async () => {
    const test = fixture()
    const listed = await test.app.request('/groups/group-a/rate-multipliers', {}, test.env)
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({ data: [
      { user_id: 'alice', user_name: 'Alice', rate_multiplier: 0.8 },
      { user_id: 'bob', user_name: 'Bob', rate_multiplier: 0.9, rpm_override: 12 },
    ] })

    const request = (key: string, entries: unknown[], controlVersion = 0) => test.app.request(
      '/groups/group-a/rate-multipliers', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ entries, expected_control_version: controlVersion }),
      }, test.env,
    )
    const saved = await request('group-rate-save-0001', [{ user_id: 'alice', rate_multiplier: 1.5 }])
    expect(saved.status, await saved.clone().text()).toBe(200)
    const savedBody = await saved.json()
    expect(savedBody).toMatchObject({ data: { updated: 1, control_version: 1 } })
    expect(test.raw.prepare(
      'SELECT user_id, rate_multiplier_ppm FROM user_group_rate_overrides WHERE group_id = ? ORDER BY user_id',
    ).all('group-a')).toEqual([{ user_id: 'alice', rate_multiplier_ppm: 1500000 }])
    expect(test.raw.prepare(
      'SELECT user_id, rpm_override FROM user_group_rpm_overrides WHERE group_id = ?',
    ).all('group-a')).toEqual([{ user_id: 'bob', rpm_override: 12 }])
    const replay = await request('group-rate-save-0001', [{ user_id: 'alice', rate_multiplier: 1.5 }])
    expect(await replay.json()).toEqual(savedBody)
    const stale = await request('group-rate-stale-0001', [], 0)
    expect(stale.status).toBe(412)
  })

  it('clears both override types, as the original clear endpoint does', async () => {
    const test = fixture()
    const cleared = await test.app.request('/groups/group-a/rate-multipliers', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'group-rate-clear-0001' },
      body: JSON.stringify({ expected_control_version: 0 }),
    }, test.env)
    expect(cleared.status, await cleared.clone().text()).toBe(200)
    await expect(cleared.json()).resolves.toMatchObject({ data: { deleted: 3, control_version: 1 } })
    expect(test.raw.prepare('SELECT count(*) AS total FROM user_group_rate_overrides').get()).toEqual({ total: 0 })
    expect(test.raw.prepare('SELECT count(*) AS total FROM user_group_rpm_overrides').get()).toEqual({ total: 0 })
  })

  it('supports bounded search and paged direct clients without changing the modal array contract', async () => {
    const test = fixture()
    const result = await test.app.request('/groups/group-a/rate-multipliers?search=bob&page=1&page_size=1', {}, test.env)
    await expect(result.json()).resolves.toMatchObject({ data: {
      total: 1, page: 1, page_size: 1, items: [{ user_id: 'bob', rpm_override: 12 }],
    } })
  })
})
