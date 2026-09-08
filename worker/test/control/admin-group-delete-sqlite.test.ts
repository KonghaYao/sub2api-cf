import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { allAdminGroups, deleteAdminGroup, getAdminGroup, listAdminGroups, updateAdminGroup } from '../../src/control/catalog'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`
    INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
    VALUES ('deleted', 'Delete fixture', 'openai', 1, 1, 1), ('disabled', 'Disabled fixture', 'openai', 0, 1, 1);
    INSERT INTO accounts (id, platform, name, credential_ref, created_at_ms, updated_at_ms)
    VALUES ('account', 'openai', 'Account', 'secret-ref', 1, 1);
    INSERT INTO account_groups (account_id, group_id, created_at_ms, updated_at_ms)
    VALUES ('account', 'deleted', 1, 1);
    INSERT INTO users (id, email, created_at_ms, updated_at_ms)
    VALUES ('user', 'delete@example.invalid', 1, 1);
    INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
    VALUES ('user', 'deleted', 1);
    INSERT INTO api_keys (id, user_id, group_id, name, key_hash, key_prefix, created_at_ms, updated_at_ms)
    VALUES ('key', 'user', 'deleted', 'Historic key', '${'a'.repeat(64)}', 'sk-key', 1, 1);
  `)
  const app = new Hono<{ Bindings: Env }>()
  app.get('/groups', listAdminGroups)
  app.get('/groups/all', allAdminGroups)
  app.get('/groups/:id', getAdminGroup)
  app.put('/groups/:id', updateAdminGroup)
  app.delete('/groups/:id', deleteAdminGroup)
  const request = (path: string, method = 'GET', body?: unknown, key = 'delete-fixture') => app.request(path, {
    method, headers: { 'idempotency-key': key, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { DB: d1 } as Env)
  return { raw, request }
}

describe('group soft deletion on SQLite', () => {
  it('hides deleted groups from lists, selectors and details while retaining disabled groups and history', async () => {
    const { raw, request } = fixture()
    const deleted = await request('/groups/deleted', 'DELETE', { expected_control_version: 0 })
    expect(deleted.status, await deleted.clone().text()).toBe(200)
    const response = await deleted.json()
    expect(raw.prepare('SELECT enabled, deleted_at_ms FROM "groups" WHERE id = ?').get('deleted'))
      .toMatchObject({ enabled: 0, deleted_at_ms: expect.any(Number) })
    expect(raw.prepare('SELECT * FROM account_groups WHERE group_id = ?').all('deleted')).toHaveLength(0)
    expect(raw.prepare('SELECT * FROM user_group_permissions WHERE group_id = ?').all('deleted')).toHaveLength(0)
    expect(raw.prepare('SELECT group_id FROM api_keys WHERE id = ?').get('key')).toMatchObject({ group_id: 'deleted' })
    for (const path of ['/groups?search=fixture', '/groups?search=fixture&status=inactive']) {
      const result = await request(path)
      expect(result.status).toBe(200)
      const body = await result.json() as any
      expect(body.data.total).toBe(1)
      expect(body.data.items.map((item: any) => item.id)).toEqual(['disabled'])
    }
    const all = await request('/groups/all?include_inactive=true')
    expect((await all.json() as any).data.map((item: any) => item.id)).toContain('disabled')
    const selectors = await request('/groups/all?include_inactive=true')
    expect((await selectors.json() as any).data.map((item: any) => item.id)).not.toContain('deleted')
    expect((await request('/groups/deleted')).status).toBe(404)
    expect((await request('/groups/deleted', 'PUT', { expected_control_version: 1, enabled: true }, 'revive-deleted-group')).status).toBe(404)
    const replay = await request('/groups/deleted', 'DELETE', { expected_control_version: 0 })
    expect(await replay.json()).toEqual(response)
    const enabled = await request('/groups/disabled', 'PUT', { expected_control_version: 0, enabled: true }, 'enable-disabled-group')
    expect(enabled.status, await enabled.clone().text()).toBe(200)
    expect(() => raw.exec(`UPDATE "groups" SET enabled = 1 WHERE id = 'deleted'`)).toThrow()
  })

  it('keeps associations and visibility intact when deletion fails its version precondition', async () => {
    const { raw, request } = fixture()
    const deleted = await request('/groups/deleted', 'DELETE', { expected_control_version: 1 })
    expect(deleted.status).toBe(412)
    expect(raw.prepare('SELECT deleted_at_ms FROM "groups" WHERE id = ?').get('deleted')).toMatchObject({ deleted_at_ms: null })
    expect(raw.prepare('SELECT * FROM account_groups WHERE group_id = ?').all('deleted')).toHaveLength(1)
    expect((await request('/groups/deleted')).status).toBe(200)
  })
})
