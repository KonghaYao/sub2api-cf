import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { allAdminGroups, getAdminGroup, listAdminGroups } from '../../src/control/catalog'
import { putAdminAccountGroupLink } from '../../src/control/accounts'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('group account counts', () => {
  it('returns actual bound account counts in lists, selectors and details and refreshes after unlinking', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES ('bound', 'Bound', 'openai', 1, 1), ('empty', 'Empty', 'openai', 1, 1)`)
    const accounts = [
      ['healthy', 1, 'healthy', {}],
      ['unknown', 1, 'unknown', {}],
      ['disabled', 0, 'healthy', {}],
      ['unhealthy', 1, 'unhealthy', {}],
      ['paused', 1, 'healthy', { schedulable: false }],
      ['expired', 1, 'healthy', { expires_at: 1 }],
      ['expiry-opt-out', 1, 'healthy', { expires_at: 1, auto_pause_on_expired: false }],
      ['limited', 1, 'healthy', { rate_limit_reset_at: '2999-01-01T00:00:00Z' }],
      ['overloaded', 1, 'healthy', { overload_until: '2999-01-01T00:00:00Z' }],
      ['temp-blocked', 1, 'healthy', { temp_unschedulable_until: '2999-01-01T00:00:00Z' }],
      ['recovered', 1, 'healthy', { rate_limit_reset_at: '2000-01-01T00:00:00Z' }],
    ] as const
    for (const [id, enabled, health, ui] of accounts) {
      raw.prepare(`INSERT INTO accounts (id, name, platform, credential_ref, enabled,
        health_status, ui_config_json, created_at_ms, updated_at_ms) VALUES (?, ?, 'openai', ?, ?, ?, ?, 1, 1)`)
        .run(id, id, `secret-${id}`, enabled, health, JSON.stringify(ui))
      raw.prepare(`INSERT INTO account_groups (account_id, group_id, created_at_ms, updated_at_ms)
        VALUES (?, 'bound', 1, 1)`).run(id)
    }
    const app = new Hono<{ Bindings: Env }>()
    app.get('/groups', listAdminGroups)
    app.get('/groups/all', allAdminGroups)
    app.get('/groups/:id', getAdminGroup)
    app.put('/accounts/:id/groups/:group_id', putAdminAccountGroupLink)
    const env = { DB: d1 } as Env
    for (const path of ['/groups', '/groups/all', '/groups/bound']) {
      const response = await app.request(path, {}, env)
      expect(response.status).toBe(200)
      const { data } = await response.json() as { data: any }
      const rows = path === '/groups' ? data.items : Array.isArray(data) ? data : [data]
      expect(rows.find((row: any) => row.id === 'bound')).toMatchObject({
        account_count: 11, active_account_count: 4, rate_limited_account_count: 3,
      })
      if (rows.length > 1) expect(rows.find((row: any) => row.id === 'empty')).toMatchObject({
        account_count: 0, active_account_count: 0, rate_limited_account_count: 0,
      })
    }
    raw.exec("DELETE FROM account_groups WHERE account_id = 'healthy'")
    const response = await app.request('/groups/bound', {}, env)
    expect((await response.json() as { data: any }).data).toMatchObject({
      account_count: 10, active_account_count: 3, rate_limited_account_count: 3,
    })
    raw.exec("UPDATE accounts SET base_url = 'https://upstream.example/v1' WHERE id = 'healthy'")
    raw.exec(`INSERT INTO account_secrets (id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms)
      VALUES ('secret-healthy', 'healthy', 1, 'test-nonce', 'test-ciphertext', 1, 1)`)
    const linked = await app.request('/accounts/healthy/groups/bound', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"0"' },
      body: JSON.stringify({ priority: 0, weight: 1 }),
    }, env)
    expect(linked.status).toBe(200)
    const refreshed = await app.request('/groups/bound', {}, env)
    expect((await refreshed.json() as { data: any }).data).toMatchObject({
      account_count: 11, active_account_count: 4, rate_limited_account_count: 3,
    })
    raw.close()
  })
})
