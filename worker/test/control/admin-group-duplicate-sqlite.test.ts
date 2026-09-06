import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { duplicateAdminGroup } from '../../src/control/catalog'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

vi.mock('../../src/control/admin-auth', () => ({
  authenticateAdminSession: async (request: Request) => ({ user_id: request.headers.get('x-test-actor') ?? 'admin-a' }),
}))

function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`
    INSERT INTO "groups" (id, name, platform, enabled, rate_multiplier_ppm, ui_config_json, created_at_ms, updated_at_ms)
    VALUES ('source', 'Primary', 'openai', 1, 1250000, '{"max_reasoning_effort":"high"}', 1, 1);
    INSERT INTO accounts (id, platform, name, credential_ref, created_at_ms, updated_at_ms)
    VALUES ('account', 'openai', 'Account', 'existing-secret', 1, 1);
    INSERT INTO account_groups (account_id, group_id, priority, weight, created_at_ms, updated_at_ms)
    VALUES ('account', 'source', 37, 5, 1, 1);
    INSERT INTO models (id, platform, public_name, upstream_name, endpoint, created_at_ms, updated_at_ms)
    VALUES ('model', 'openai', 'public', 'upstream', 'both', 1, 1);
    INSERT INTO group_models (group_id, model_id, upstream_name_override, created_at_ms, updated_at_ms)
    VALUES ('source', 'model', 'mapped', 1, 1);
    INSERT INTO model_prices (id, group_id, model_id, version, active, input_micros_per_million,
      output_micros_per_million, effective_at_ms, created_at_ms, retired_at_ms)
    VALUES ('old-price', 'source', 'model', 1, 0, 1, 2, 1, 1, 2), ('active-price', 'source', 'model', 2, 1, 3, 4, 1, 1, NULL);
  `)
  const app = new Hono<{ Bindings: Env }>()
  app.post('/groups/:id/duplicate', duplicateAdminGroup)
  const request = (key: string, actor = 'admin-a') => app.request('/groups/source/duplicate', {
    method: 'POST', headers: { 'idempotency-key': key, 'x-test-actor': actor },
  }, { DB: d1 } as Env)
  return { raw, request }
}

describe('group duplication on D1', () => {
  it('copies configuration and bindings into an inactive independent group with actor-scoped replay', async () => {
    const { raw, request } = fixture()
    const created = await request('duplicate-first')
    expect(created.status, await created.clone().text()).toBe(201)
    const body = await created.json() as any
    const group = body.data
    expect(group).toMatchObject({ name: 'Primary (Copy)', enabled: false, control_version: 0,
      rate_multiplier_ppm: 1250000, max_reasoning_effort: 'high' })
    expect(group.id).not.toBe('source')
    expect(group.created_at_ms).toBeGreaterThan(1)
    expect(raw.prepare('SELECT account_id, priority, weight FROM account_groups WHERE group_id = ?').all(group.id))
      .toEqual([{ account_id: 'account', priority: 37, weight: 5 }])
    expect(raw.prepare('SELECT upstream_name_override FROM group_models WHERE group_id = ?').get(group.id))
      .toMatchObject({ upstream_name_override: 'mapped' })
    const prices = raw.prepare('SELECT id, version, input_micros_per_million FROM model_prices WHERE group_id = ?').all(group.id)
    expect(prices).toHaveLength(1)
    expect(prices[0]).toMatchObject({ version: 1, input_micros_per_million: 3 })
    expect(prices[0].id).not.toBe('active-price')
    expect(raw.prepare('SELECT count(*) AS n FROM accounts').get().n).toBe(1)
    raw.exec(`UPDATE "groups" SET name = 'Changed' WHERE id = 'source'`)
    const replay = await request('duplicate-first')
    expect(await replay.json()).toEqual(body)
    const anotherActor = await request('duplicate-first', 'admin-b')
    expect((await anotherActor.json() as any).data.id).not.toBe(group.id)
  })

  it('advances conflicting names and rolls back group creation if a relation fails', async () => {
    const { raw, request } = fixture()
    raw.exec(`INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES ('collision', 'Primary (Copy)', 'openai', 1, 1)`)
    const result = await request('duplicate-conflict')
    expect((await result.json() as any).data.name).toBe('Primary (Copy 2)')
    raw.exec(`CREATE TRIGGER fail_duplicate_binding BEFORE INSERT ON account_groups
      WHEN NEW.group_id <> 'source' BEGIN SELECT RAISE(ABORT, 'binding failure'); END;`)
    const before = raw.prepare('SELECT count(*) AS n FROM "groups"').get().n
    const failed = await request('duplicate-failed')
    expect(failed.status).toBe(500)
    expect(raw.prepare('SELECT count(*) AS n FROM "groups"').get().n).toBe(before)
    raw.exec('DROP TRIGGER fail_duplicate_binding')
    const retry = await request('duplicate-failed')
    expect(retry.status).toBe(201)
    expect((await retry.json() as any).data.name).toBe('Primary (Copy 3)')
  })
})
