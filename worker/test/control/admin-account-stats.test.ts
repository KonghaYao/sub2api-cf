import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAdminAccountStats } from '../../src/control/accounts'
import type { Env } from '../../src/env'
import { recoverAccountStatsRollups } from '../../src/gateway/account-stats-rollup'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.UTC(2026, 8, 6, 12)
const DAY_MS = 86_400_000

function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
     VALUES ('user-a', 'user-a@example.test', 'User A', 'user', 'active', ?, ?)`,
  ).run(NOW - 200 * 86_400_000, NOW - 200 * 86_400_000)
  raw.prepare(
    `INSERT INTO accounts (
       id, platform, name, credential_ref, enabled, max_concurrency,
       created_at_ms, updated_at_ms, protocol, base_url, auth_scheme
     ) VALUES ('account-a', 'openai', 'Account A', 'account-a-secret', 1, 4,
       ?, ?, 'openai', 'https://api.example.test/v1', 'bearer')`,
  ).run(NOW - 200 * 86_400_000, NOW - 200 * 86_400_000)
  raw.prepare(
    `INSERT INTO account_secrets (
       id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
     ) VALUES ('account-a-secret', 'account-a', 1, 'nonce', 'ciphertext', ?, ?)`,
  ).run(NOW, NOW)
  const insert = raw.prepare(
    `INSERT INTO usage_projection (
       event_id, request_id, user_id, account_id, model, input_tokens, output_tokens,
       cache_read_tokens,
       amount_micros, occurred_at_ms, projected_at_ms, standard_cost_micros,
       account_stats_cost_micros, account_rate_multiplier_ppm, account_cost_micros,
       inbound_endpoint, upstream_endpoint, duration_ms
     ) VALUES (?, ?, 'user-a', 'account-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insert.run('event-1', 'request-1', 'gpt-a', 100, 50, 25, 900_000, NOW, NOW, 1_000_000, null, 800_000, 800_000, '/v1/chat/completions', '/chat', 100)
  insert.run('event-2', 'request-2', 'gpt-a', 20, 30, 0, 400_000, NOW - 86_400_000, NOW, 500_000, 600_000, 1_500_000, 900_000, '/v1/chat/completions', '/chat', 200)
  insert.run('event-3', 'request-3', 'gpt-b', 10, 10, 0, 200_000, NOW - 86_400_000, NOW, 250_000, null, 1_000_000, 250_000, '/v1/responses', '/responses', 300)
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', DB: d1,
    ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace, API_KEY_LIMIT_STATE: {} as DurableObjectNamespace,
  } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.get('/accounts/:id/stats', getAdminAccountStats)
  return { app, env, raw }
}

beforeEach(() => vi.setSystemTime(NOW))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('admin account statistics projection', () => {
  it('returns the legacy-shaped daily and model account-cost view in USD', async () => {
    const test = fixture()
    const response = await test.app.request('/accounts/account-a/stats?days=2', {}, test.env)
    const payload = await response.json() as any

    expect(response.status).toBe(200)
    expect(payload.data.history).toEqual([
      {
        date: '2026-09-05', label: '09/05', requests: 2, tokens: 70,
        cost: 0.75, actual_cost: 1.15, user_cost: 0.6,
      },
      {
        date: '2026-09-06', label: '09/06', requests: 1, tokens: 150,
        cost: 1, actual_cost: 0.8, user_cost: 0.9,
      },
    ])
    expect(payload.data.summary).toMatchObject({
      days: 2, actual_days_used: 2,
      total_cost: 1.95, total_user_cost: 1.5, total_standard_cost: 1.75,
      total_requests: 3, total_tokens: 220,
      avg_daily_cost: 0.975, avg_daily_user_cost: 0.75,
      avg_daily_requests: 1.5, avg_daily_tokens: 110, avg_duration_ms: 200,
      today: { date: '2026-09-06', cost: 0.8, user_cost: 0.9, requests: 1, tokens: 150 },
      highest_cost_day: { date: '2026-09-05', cost: 1.15 },
      highest_request_day: { date: '2026-09-05', requests: 2 },
    })
    expect(payload.data.models).toEqual([
      expect.objectContaining({ model: 'gpt-a', requests: 2, input_tokens: 95, cache_read_tokens: 25, total_tokens: 200, cost: 1.5, actual_cost: 1.7, account_cost: 1.7 }),
      expect.objectContaining({ model: 'gpt-b', requests: 1, total_tokens: 20, cost: 0.25, actual_cost: 0.25, account_cost: 0.25 }),
    ])
    expect(payload.data.endpoints).toEqual([
      { endpoint: '/v1/chat/completions', requests: 2, total_tokens: 200, cost: 1.5, actual_cost: 1.7 },
      { endpoint: '/v1/responses', requests: 1, total_tokens: 20, cost: 0.25, actual_cost: 0.25 },
    ])
    expect(payload.data.upstream_endpoints).toEqual([
      { endpoint: '/chat', requests: 2, total_tokens: 200, cost: 1.5, actual_cost: 1.7 },
      { endpoint: '/responses', requests: 1, total_tokens: 20, cost: 0.25, actual_cost: 0.25 },
    ])
  })

  it('bounds days and returns 404 for an unknown account', async () => {
    const test = fixture()
    for (const days of ['0', '91', '1.5', 'not-a-number']) {
      const response = await test.app.request(`/accounts/account-a/stats?days=${days}`, {}, test.env)
      expect(response.status).toBe(400)
    }
    expect((await test.app.request('/accounts/missing/stats?days=30', {}, test.env)).status).toBe(404)
  })

  it('reuses one timezone formatter across a 90-day window', async () => {
    const test = fixture()
    const RealDateTimeFormat = Intl.DateTimeFormat
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      (function (...arguments_: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        return new RealDateTimeFormat(...arguments_)
      }) as typeof Intl.DateTimeFormat,
    )

    const response = await test.app.request(
      '/accounts/account-a/stats?days=90&timezone=Asia%2FShanghai', {}, test.env,
    )

    expect(response.status).toBe(200)
    expect(formatter).toHaveBeenCalledTimes(1)
  })

  it('uses one bounded usage statement instead of rescanning the base projection', async () => {
    const test = fixture()
    const database = test.env.DB
    const queries: string[] = []
    let batches = 0
    test.env.DB = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            queries.push(query)
            return target.prepare(query)
          }
        }
        if (property === 'batch') {
          return (statements: D1PreparedStatement[]) => {
            batches += 1
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const response = await test.app.request(
      '/accounts/account-a/stats?days=90&timezone=Asia%2FShanghai', {}, test.env,
    )
    const usageQueries = queries.filter((query) => query.includes('FROM usage_projection'))

    expect(response.status).toBe(200)
    expect(batches).toBe(0)
    expect(usageQueries).toHaveLength(1)
    expect(usageQueries[0].match(/FROM usage_projection/g)).toHaveLength(1)
    expect(usageQueries[0]).toContain('FROM account_usage_15m_rollup')
    expect(usageQueries[0]).toContain('AND account_stats_rollup_version = 0')
    expect(usageQueries[0]).not.toContain('account_stats_rollup_version = 0 OR')
    expect(usageQueries[0]).toContain('LIMIT 10001')
  })

  it('merges new sparse rollups with bounded legacy history without double counting', async () => {
    const test = fixture()
    const bucketStart = Math.floor(NOW / 900_000) * 900_000
    test.raw.prepare(
      `INSERT INTO usage_projection (
         event_id, request_id, user_id, account_id, model, input_tokens, output_tokens,
         cache_read_tokens, amount_micros, occurred_at_ms, projected_at_ms,
         standard_cost_micros, account_cost_micros, account_stats_rollup_version
       ) VALUES ('rolled-event', 'rolled-request', 'user-a', 'account-a', 'rolled-model',
         5, 3, 1, 7, ?, ?, 11, 13, 1)`,
    ).run(NOW, NOW)
    test.raw.prepare(
      `INSERT INTO account_usage_15m_rollup (
         account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint,
         requests, input_tokens, output_tokens, cache_read_tokens,
         standard_cost_micros, account_cost_micros, user_cost_micros,
         duration_total_ms, duration_count
       ) VALUES ('account-a', ?, 'rolled-model', '', '', 1, 5, 3, 1, 11, 13, 7, 40, 1)`,
    ).run(bucketStart)

    const response = await test.app.request(
      '/accounts/account-a/stats?days=1&timezone=UTC', {}, test.env,
    )
    const payload = await response.json() as any

    expect(response.status).toBe(200)
    expect(payload.data.summary).toMatchObject({
      total_requests: 2, total_tokens: 158, total_standard_cost: 1.000011,
      total_cost: 0.800013, total_user_cost: 0.900007,
    })
    expect(payload.data.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'rolled-model', requests: 1, total_tokens: 8 }),
    ]))
  })

  it('uses the strict persisted event watermark to exclude already rolled legacy rows', async () => {
    const test = fixture()
    const maintenance = test.raw.prepare(`
      SELECT migration_started_at_ms FROM account_stats_rollup_maintenance WHERE id='global'
    `).get() as { migration_started_at_ms: number }
    test.raw.prepare(`
      INSERT INTO account_stats_rollup_progress (
        account_id, cutoff_ms, cursor_occurred_at_ms, cursor_event_id, status, updated_at_ms
      ) VALUES ('account-a', ?, ?, 'event-1', 'active', ?)
    `).run(maintenance.migration_started_at_ms - 100 * 86_400_000, NOW, NOW)
    test.raw.prepare(`
      INSERT INTO account_usage_15m_rollup (
        account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint,
        requests, input_tokens, output_tokens, cache_read_tokens,
        standard_cost_micros, account_cost_micros, user_cost_micros,
        duration_total_ms, duration_count
      ) VALUES ('account-a', ?, 'gpt-a', '/v1/chat/completions', '/chat',
        1, 100, 50, 25, 1000000, 800000, 900000, 100, 1)
    `).run(Math.floor(NOW / 900_000) * 900_000)

    const response = await test.app.request(
      '/accounts/account-a/stats?days=2&timezone=UTC', {}, test.env,
    )
    const payload = await response.json() as any

    expect(response.status).toBe(200)
    expect(payload.data.summary).toMatchObject({
      total_requests: 3, total_tokens: 220, total_cost: 1.95,
    })
    expect(payload.data.models.find((row: any) => row.model === 'gpt-a')).toMatchObject({
      requests: 2, total_tokens: 200,
    })
  })

  it('keeps rolling-deploy version-zero writes visible through grace and rolls them once', async () => {
    const test = fixture()
    const graceUntil = NOW + 60 * 60_000
    test.raw.exec('DELETE FROM usage_projection; DELETE FROM account_usage_15m_rollup; DELETE FROM account_stats_rollup_progress')
    test.raw.prepare(`
      UPDATE account_stats_rollup_maintenance SET
        migration_started_at_ms = ?, legacy_write_grace_until_ms = ?,
        discovery_cursor = '', active_account_id = NULL, backfill_complete = 0,
        backfill_writes_used = 0, retention_writes_used = 0
      WHERE id = 'global'
    `).run(NOW - DAY_MS, graceUntil)
    test.raw.prepare(`
      INSERT INTO usage_projection (
        event_id, request_id, user_id, account_id, model,
        input_tokens, output_tokens, amount_micros, standard_cost_micros,
        account_cost_micros, occurred_at_ms, projected_at_ms,
        account_stats_rollup_version
      ) VALUES ('grace-event', 'grace-request', 'user-a', 'account-a', 'grace-model',
        7, 5, 13, 11, 12, ?, ?, 0)
    `).run(NOW, NOW)

    const duringGrace = await test.app.request(
      '/accounts/account-a/stats?days=1&timezone=UTC', {}, test.env,
    )
    expect(duringGrace.status).toBe(200)
    expect((await duringGrace.json() as any).data.summary).toMatchObject({
      total_requests: 1, total_tokens: 12, total_cost: 0.000012,
    })
    expect(await recoverAccountStatsRollups(test.env, { nowMs: NOW })).toEqual({ selected: 0 })
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM account_stats_rollup_progress').get())
      .toEqual({ count: 0 })

    expect(await recoverAccountStatsRollups(test.env, { nowMs: graceUntil, limit: 0 }))
      .toEqual({ selected: 0 })
    expect(test.raw.prepare(`
      SELECT cursor_occurred_at_ms FROM account_stats_rollup_progress WHERE account_id = 'account-a'
    `).get()).toEqual({ cursor_occurred_at_ms: graceUntil })
    expect(await recoverAccountStatsRollups(test.env, { nowMs: graceUntil })).toEqual({ selected: 1 })

    const afterRollup = await test.app.request(
      '/accounts/account-a/stats?days=1&timezone=UTC', {}, test.env,
    )
    expect(afterRollup.status).toBe(200)
    expect((await afterRollup.json() as any).data.summary).toMatchObject({
      total_requests: 1, total_tokens: 12, total_cost: 0.000012,
    })
    expect(test.raw.prepare('SELECT SUM(requests) AS requests FROM account_usage_15m_rollup').get())
      .toEqual({ requests: 1 })
  })

  it('fails explicitly instead of returning partial legacy history over the cap', async () => {
    const test = fixture()
    const insert = test.raw.prepare(
      `INSERT INTO usage_projection (
         event_id, request_id, user_id, account_id, model, input_tokens, output_tokens,
         amount_micros, occurred_at_ms, projected_at_ms
       ) VALUES (?, ?, 'user-a', 'account-a', 'legacy-model', 1, 1, 1, ?, ?)`,
    )
    test.raw.exec('BEGIN')
    for (let index = 0; index < 10_000; index += 1) {
      insert.run(`legacy-event-${index}`, `legacy-request-${index}`, NOW, NOW)
    }
    test.raw.exec('COMMIT')

    const response = await test.app.request(
      '/accounts/account-a/stats?days=1&timezone=UTC', {}, test.env,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'account_stats_history_not_rolled_up' },
    })
  })

  it('uses the requested IANA timezone for the local day boundary', async () => {
    const test = fixture()
    const localDayStart = Date.UTC(2026, 8, 5, 16)
    const insert = test.raw.prepare(
      `INSERT INTO usage_projection (
         event_id, request_id, user_id, account_id, model, input_tokens, output_tokens,
         cache_read_tokens, amount_micros, occurred_at_ms, projected_at_ms,
         standard_cost_micros, account_cost_micros
       ) VALUES (?, ?, 'user-a', 'account-a', 'boundary-model', 1, 1, 0, 1, ?, ?, 1, 1)`,
    )
    insert.run('event-before-boundary', 'request-before-boundary', localDayStart - 1, NOW)
    insert.run('event-at-boundary', 'request-at-boundary', localDayStart, NOW)

    const response = await test.app.request(
      '/accounts/account-a/stats?days=1&timezone=Asia%2FShanghai', {}, test.env,
    )
    const payload = await response.json() as any
    expect(response.status).toBe(200)
    expect(payload.data.history).toEqual([
      expect.objectContaining({ date: '2026-09-06', requests: 2, tokens: 152 }),
    ])
    expect(payload.data.summary).toMatchObject({
      days: 1, total_requests: 2,
      today: { date: '2026-09-06', requests: 2 },
    })
  })

  it('starts a day at its first real instant when DST skips local midnight', async () => {
    vi.setSystemTime(Date.UTC(2026, 8, 6, 16))
    const test = fixture()
    const firstInstant = Date.UTC(2026, 8, 6, 4)
    const insert = test.raw.prepare(
      `INSERT INTO usage_projection (
         event_id, request_id, user_id, account_id, model, input_tokens, output_tokens,
         cache_read_tokens, amount_micros, occurred_at_ms, projected_at_ms,
         standard_cost_micros, account_cost_micros
       ) VALUES (?, ?, 'user-a', 'account-a', 'dst-model', 1, 1, 0, 1, ?, ?, 1, 1)`,
    )
    insert.run('event-before-dst-day', 'request-before-dst-day', firstInstant - 1, NOW)
    insert.run('event-at-dst-day', 'request-at-dst-day', firstInstant, NOW)

    const response = await test.app.request(
      '/accounts/account-a/stats?days=1&timezone=America%2FSantiago', {}, test.env,
    )
    const payload = await response.json() as any
    expect(response.status).toBe(200)
    expect(payload.data.history).toEqual([
      expect.objectContaining({ date: '2026-09-06', requests: 2, tokens: 152 }),
    ])
  })
})
