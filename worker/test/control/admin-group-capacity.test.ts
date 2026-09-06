import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { getAdminGroupCapacitySummary } from '../../src/control/group-capacity'
import { poolStateName } from '../../src/gateway/state-client'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

class Stub {
  constructor(private readonly count: number, private readonly fails = false) {}
  async fetch(): Promise<Response> {
    if (this.fails) return new Response('unavailable', { status: 503 })
    return Response.json({ accounts: [{ account_id: 'account', active_leases: this.count }] })
  }
}

describe('group capacity summary', () => {
  it('aggregates active pool leases in bounded batches and marks failed snapshots unknown', async () => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
    raw.exec(`
      INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms) VALUES
        ('g-known', 'Known', 'openai', 1, 1, 1), ('g-unknown', 'Unknown', 'openai', 1, 1, 1), ('g-inactive', 'Inactive', 'openai', 0, 1, 1);
      INSERT INTO accounts (id, platform, name, credential_ref, enabled, max_concurrency, health_status, created_at_ms, updated_at_ms) VALUES
        ('a-known', 'openai', 'Known', 'secret-known', 1, 5, 'healthy', 1, 1), ('a-unknown', 'openai', 'Unknown', 'secret-unknown', 1, 7, 'healthy', 1, 1);
      INSERT INTO account_groups (account_id, group_id, created_at_ms, updated_at_ms) VALUES
        ('a-known', 'g-known', 1, 1), ('a-unknown', 'g-unknown', 1, 1);
      INSERT INTO models (id, platform, public_name, upstream_name, endpoint, created_at_ms, updated_at_ms) VALUES
        ('m', 'openai', 'model', 'model', 'both', 1, 1);
      INSERT INTO pool_state_registry (group_id, model_id, endpoint, config_revision, last_synced_at_ms) VALUES
        ('g-known', 'm', 'chat_completions', 1, 1), ('g-known', 'm', 'responses', 1, 1), ('g-unknown', 'm', 'responses', 1, 1);
    `)
    const names: string[] = []
    const namespace = {
      idFromName(name: string) { names.push(name); return name },
      get(name: string) { return new Stub(name.includes('g-unknown') ? 0 : name.includes('responses') ? 2 : 1, name.includes('g-unknown')) },
    } as unknown as DurableObjectNamespace
    const app = new Hono<{ Bindings: Env }>(); app.get('/capacity', getAdminGroupCapacitySummary)
    const response = await app.request('/capacity', {}, { DB: d1, POOL_STATE: namespace } as Env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 0, data: [
      { group_id: 'g-known', concurrency_status: 'known', concurrency_used: 3, concurrency_max: 5,
        sessions_status: 'unknown', sessions_used: null, sessions_max: null, rpm_status: 'unknown', rpm_used: null, rpm_max: null },
      { group_id: 'g-unknown', concurrency_status: 'unknown', concurrency_used: null, concurrency_max: 7,
        sessions_status: 'unknown', sessions_used: null, sessions_max: null, rpm_status: 'unknown', rpm_used: null, rpm_max: null },
    ] })
    expect(names).toEqual([
      poolStateName('g-known', 'm', 'chat_completions'), poolStateName('g-known', 'm', 'responses'), poolStateName('g-unknown', 'm', 'responses'),
    ])
  })
})
