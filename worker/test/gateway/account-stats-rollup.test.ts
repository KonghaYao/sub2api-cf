import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { recoverAccountStatsRollups } from '../../src/gateway/account-stats-rollup'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const DAY_MS = 86_400_000
const NOW_MS = 200 * DAY_MS

function seedAccount(raw: any): void {
  raw.exec(`
    INSERT INTO users
      (id,email,display_name,role,status,balance_micros,state_version,created_at_ms,updated_at_ms)
    VALUES ('rollup-user','rollup@example.com','','user','active',0,0,1,1);
    INSERT INTO accounts
      (id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms)
    VALUES ('rollup-account','openai','Rollup','secret',1,1,1,1);
  `)
  raw.prepare(`
    UPDATE account_stats_rollup_maintenance SET
      migration_started_at_ms = ?, legacy_write_grace_until_ms = ?, backfill_complete = 0,
      backfill_budget_day = ?, retention_budget_day = ?,
      updated_at_ms = ? WHERE id = 'global'
  `).run(NOW_MS, NOW_MS, Math.floor(NOW_MS / DAY_MS), Math.floor(NOW_MS / DAY_MS), NOW_MS)
}

function seedPending(raw: any, count: number): void {
  const insert = raw.prepare(`
    INSERT INTO usage_projection (
      event_id, request_id, user_id, account_id, model,
      input_tokens, output_tokens, cache_read_tokens, amount_micros,
      standard_cost_micros, account_stats_cost_micros, account_cost_micros,
      occurred_at_ms, projected_at_ms, inbound_endpoint, upstream_endpoint,
      duration_ms, account_stats_rollup_version
    ) VALUES (?, ?, 'rollup-user', 'rollup-account', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `)
  for (let index = 0; index < count; index += 1) {
    const standard = index % 2 === 0 ? null : 20 + index
    const accountStats = index % 3 === 0 ? 15 + index : null
    insert.run(
      `legacy-${String(index).padStart(2, '0')}`,
      `request-${index}`,
      index % 2 === 0 ? 'gpt-a' : 'gpt-b',
      index + 1,
      index + 2,
      index,
      100 + index,
      standard,
      accountStats,
      index % 5 === 0 ? null : 18 + index,
      NOW_MS - DAY_MS + index,
      NOW_MS,
      index % 2 === 0 ? '/v1/chat/completions' : '/v1/responses',
      index % 2 === 0 ? '/v1/responses' : '/v1/chat/completions',
      index % 4 === 0 ? null : 50 + index,
    )
  }
}

describe('scheduled account-stat rollup recovery', () => {
  it('sticks to a large account in twenty-event pages and eventually completes it', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedAccount(raw)
    seedPending(raw, 25)
    raw.prepare("UPDATE usage_projection SET cache_write_tokens=3,cache_write_5m_tokens=1,cache_write_1h_tokens=2").run()
    raw.prepare(`
      INSERT INTO usage_projection (
        event_id, request_id, user_id, account_id, model, amount_micros,
        occurred_at_ms, projected_at_ms, account_stats_rollup_version
      ) VALUES ('no-account', 'no-account', 'rollup-user', NULL, 'gpt-a', 1, ?, ?, 0)
    `).run(NOW_MS - DAY_MS, NOW_MS)

    const first = await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })
    expect(first).toEqual({ selected: 20 })
    expect(raw.prepare(`
      SELECT
        SUM(account_stats_rollup_version = 1) AS complete,
        SUM(account_stats_rollup_version = 0 AND account_id IS NOT NULL) AS pending
      FROM usage_projection
    `).get()).toEqual({ complete: 0, pending: 25 })

    const second = await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })
    const settled = await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })

    expect([second.selected, settled.selected]).toEqual([5, 0])
    expect(raw.prepare("SELECT SUM(cache_write_tokens) AS written,SUM(cache_write_5m_tokens) AS five,SUM(cache_write_1h_tokens) AS hour FROM account_usage_15m_rollup").get()).toEqual({written:75,five:25,hour:50})
    expect(raw.prepare(`
      SELECT SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(standard_cost_micros) AS standard_cost_micros,
             SUM(account_cost_micros) AS account_cost_micros,
             SUM(user_cost_micros) AS user_cost_micros,
             SUM(duration_total_ms) AS duration_total_ms,
             SUM(duration_count) AS duration_count
        FROM account_usage_15m_rollup
    `).get()).toEqual({
      requests: 25,
      input_tokens: 325,
      output_tokens: 350,
      cache_read_tokens: 300,
      standard_cost_micros: raw.prepare(`
        SELECT SUM(COALESCE(standard_cost_micros, amount_micros)) AS total
          FROM usage_projection WHERE account_id = 'rollup-account'
      `).get().total,
      account_cost_micros: raw.prepare(`
        SELECT SUM(COALESCE(account_cost_micros, account_stats_cost_micros,
                   standard_cost_micros, amount_micros)) AS total
          FROM usage_projection WHERE account_id = 'rollup-account'
      `).get().total,
      user_cost_micros: 2_800,
      duration_total_ms: 1_116,
      duration_count: 25,
    })
    expect(raw.prepare(`
      SELECT COUNT(*) AS count FROM account_usage_15m_rollup
    `).get()).toEqual({ count: 2 })
    expect(raw.prepare(`
      SELECT account_stats_rollup_version
        FROM usage_projection WHERE event_id = 'no-account'
    `).get()).toEqual({ account_stats_rollup_version: 0 })
    const queries: string[] = []
    const counted = new Proxy(d1, {
      get(target, property) {
        if (property === 'prepare') return (query: string) => { queries.push(query); return target.prepare(query) }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await recoverAccountStatsRollups({ DB: counted } as Env, { nowMs: NOW_MS })
    expect(queries.some((query) => query.includes('FROM usage_projection'))).toBe(false)
    raw.close()
  })

  it('keeps the active large account until completion before advancing to the next account', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedAccount(raw)
    seedPending(raw, 25)
    raw.exec(`
      INSERT INTO accounts (id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms)
      VALUES ('rollup-z','openai','Rollup Z','secret-z',1,1,1,1);
      INSERT INTO usage_projection (
        event_id, request_id, user_id, account_id, model, amount_micros,
        occurred_at_ms, projected_at_ms, account_stats_rollup_version
      ) VALUES ('z-event','z-request','rollup-user','rollup-z','gpt-z',1,${NOW_MS - DAY_MS},${NOW_MS},0);
    `)

    expect((await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })).selected).toBe(20)
    expect(raw.prepare(`SELECT active_account_id FROM account_stats_rollup_maintenance`).get())
      .toEqual({ active_account_id: 'rollup-account' })
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM account_usage_15m_rollup WHERE account_id='rollup-z'`).get())
      .toEqual({ count: 0 })
    expect((await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })).selected).toBe(5)
    expect((await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })).selected).toBe(0)
    expect((await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })).selected).toBe(1)
    raw.close()
  })

  it('completes the recent watermark while permanently skipping expired backlog', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedAccount(raw)
    seedPending(raw, 6)
    const expired = raw.prepare(`
      INSERT INTO usage_projection (
        event_id, request_id, user_id, account_id, model, amount_micros,
        occurred_at_ms, projected_at_ms, account_stats_rollup_version
      ) VALUES (?, ?, 'rollup-user', 'rollup-account', 'expired-model', 1, ?, ?, 0)
    `)
    for (let index = 0; index < 6; index += 1) {
      expired.run(`expired-${index}`, `expired-request-${index}`, NOW_MS - 101 * DAY_MS - index, NOW_MS)
    }

    const result = await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })

    expect(result).toEqual({ selected: 6 })
    expect(raw.prepare(`
      SELECT SUM(requests) AS requests FROM account_usage_15m_rollup
    `).get()).toEqual({ requests: 6 })
    await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })
    expect(raw.prepare(`
      SELECT status, cutoff_ms FROM account_stats_rollup_progress
       WHERE account_id = 'rollup-account'
    `).get()).toEqual({ status: 'complete', cutoff_ms: NOW_MS - 100 * DAY_MS })
    expect(raw.prepare(`
      SELECT COUNT(*) AS count FROM usage_projection
       WHERE model = 'expired-model' AND account_stats_rollup_version = 0
    `).get()).toEqual({ count: 6 })
    raw.close()
  })

  it('rechecks version zero transactionally when scheduled invocations overlap', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedAccount(raw)
    seedPending(raw, 10)

    await Promise.all([
      recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS }),
      recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS }),
    ])

    expect(raw.prepare(`
      SELECT SUM(requests) AS requests FROM account_usage_15m_rollup
    `).get()).toEqual({ requests: 10 })
    raw.close()
  })

  it('raises retention from 3k to 12k after global completion and resets it next day', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedAccount(raw)
    const cutoff = NOW_MS - 100 * DAY_MS
    const insert = raw.prepare(`
      INSERT INTO account_usage_15m_rollup (
        account_id, bucket_start_ms, model, requests, input_tokens, output_tokens,
        cache_read_tokens, standard_cost_micros, account_cost_micros,
        user_cost_micros, duration_total_ms, duration_count
      ) VALUES ('rollup-account', ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 1)
    `)
    for (let index = 0; index < 15; index += 1) {
      insert.run(cutoff - ((index + 1) * 900_000), `old-${index}`)
    }
    insert.run(cutoff, 'boundary')
    raw.prepare(`
      UPDATE account_stats_rollup_maintenance SET retention_writes_used = 2998
       WHERE id = 'global'
    `).run()

    const first = await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })
    expect(first).toEqual({ selected: 0 })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM account_usage_15m_rollup').get())
      .toEqual({ count: 14 })

    const second = await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })
    expect(second).toEqual({ selected: 0 })
    expect(raw.prepare(`
      SELECT backfill_complete, retention_writes_used
        FROM account_stats_rollup_maintenance WHERE id = 'global'
    `).get()).toEqual({ backfill_complete: 1, retention_writes_used: 3010 })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM account_usage_15m_rollup').get())
      .toEqual({ count: 4 })

    raw.prepare(`
      UPDATE account_stats_rollup_maintenance SET retention_writes_used = 11998
       WHERE id = 'global'
    `).run()
    await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM account_usage_15m_rollup').get())
      .toEqual({ count: 2 })
    await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM account_usage_15m_rollup').get())
      .toEqual({ count: 2 })

    insert.run(NOW_MS, 'fresh')
    await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS + DAY_MS })
    expect(raw.prepare('SELECT model FROM account_usage_15m_rollup').get())
      .toEqual({ model: 'fresh' })
    raw.close()
  })
})

describe('account-stat scheduled statement budget', () => {
  it('uses a bounded eight-statement active-account path at the full limit', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedAccount(raw)
    seedPending(raw, 20)
    await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS, limit: 0 })
    const queries: string[] = []
    const counted = new Proxy(d1, {
      get(target, property) {
        if (property === 'prepare') return (query: string) => { queries.push(query); return target.prepare(query) }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const result = await recoverAccountStatsRollups({ DB: counted } as Env, { nowMs: NOW_MS, limit: 999 })

    expect(result.selected).toBe(20)
    expect(queries).toHaveLength(8)
    expect(queries.join('\n')).toContain('idx_usage_projection_account_time')
    expect(queries.join('\n')).toContain('cursor_occurred_at_ms = ?')
    raw.close()
  })

  it('persists the backfill daily budget and stops selecting history at the cap', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedAccount(raw)
    seedPending(raw, 20)
    await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS, limit: 0 })
    raw.prepare(`
      UPDATE account_stats_rollup_maintenance SET backfill_writes_used = 11990
       WHERE id = 'global'
    `).run()

    expect((await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })).selected).toBe(9)
    expect(raw.prepare(`
      SELECT backfill_writes_used FROM account_stats_rollup_maintenance
    `).get()).toEqual({ backfill_writes_used: 12000 })
    expect((await recoverAccountStatsRollups({ DB: d1 } as Env, { nowMs: NOW_MS })).selected).toBe(0)
    raw.close()
  })
})
