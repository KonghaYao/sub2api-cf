import { afterEach, describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const databases: any[] = []

function databaseThrough(version = Number.POSITIVE_INFINITY): any {
  const { raw } = createSqliteD1()
  databases.push(raw)
  applyMigrations(raw, version)
  return raw
}

function seedAuthorities(raw: any): void {
  raw.exec(`
    INSERT INTO users (id, email, created_at_ms, updated_at_ms)
    VALUES ('user-stats', 'stats@example.test', 1, 1);

    INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
    VALUES ('group-stats', 'Stats group', 'openai', 1, 1);

    INSERT INTO accounts (
      id, platform, name, credential_ref, created_at_ms, updated_at_ms
    ) VALUES ('account-stats', 'openai', 'Stats account', 'secret:stats', 1, 1);

    INSERT INTO channels (id, name, created_at_ms, updated_at_ms)
    VALUES ('channel-stats', 'Stats channel', 1, 1);

    INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
    VALUES ('channel-stats', 'group-stats', 1);
  `)
}

function seedRuleGraph(raw: any): void {
  raw.exec(`
    INSERT INTO channel_account_stats_pricing_rules (
      id, channel_id, name, sort_order, created_at_ms, updated_at_ms
    ) VALUES ('rule-stats', 'channel-stats', 'Preferred provider cost', 2, 2, 2);

    INSERT INTO channel_account_stats_rule_groups (rule_id, group_id, created_at_ms)
    VALUES ('rule-stats', 'group-stats', 2);

    INSERT INTO channel_account_stats_rule_accounts (rule_id, account_id, created_at_ms)
    VALUES ('rule-stats', 'account-stats', 2);

    INSERT INTO channel_account_stats_model_pricing (
      id, rule_id, platform, billing_mode,
      input_micros_per_million, output_micros_per_million,
      cache_write_micros_per_million, cache_write_1h_micros_per_million,
      cache_read_micros_per_million, image_output_micros_per_million,
      per_request_micros, sort_order, created_at_ms, updated_at_ms
    ) VALUES (
      'rule-price', 'rule-stats', 'openai', 'token',
      1250000, 5000000, 1562500, 2500000, 125000, 4000000,
      25000, 3, 2, 2
    );

    INSERT INTO channel_account_stats_pricing_models (
      pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
    ) VALUES
      ('rule-price', 'gpt-5', 0, 0, 2),
      ('rule-price', 'gpt-5-*', 1, 1, 2);

    INSERT INTO channel_account_stats_pricing_intervals (
      id, pricing_id, min_tokens, max_tokens, tier_label,
      input_micros_per_million, output_micros_per_million,
      cache_write_micros_per_million, cache_write_1h_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      sort_order, created_at_ms, updated_at_ms
    ) VALUES (
      'rule-interval', 'rule-price', 0, 999999, 'base',
      1250000, 5000000, 1562500, 2500000, 125000, 25000,
      0, 2, 2
    );
  `)
}

afterEach(() => {
  while (databases.length > 0) databases.pop().close()
})

describe('account statistics pricing storage migration', () => {
  it('creates strict normalized rule storage with exact integer prices', () => {
    const raw = databaseThrough()
    seedAuthorities(raw)
    seedRuleGraph(raw)

    const tables = raw.prepare(`
      SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'channel_account_stats_%'
       ORDER BY name
    `).all() as Array<{ name: string; sql: string }>
    expect(tables.map(({ name }) => name)).toEqual([
      'channel_account_stats_model_pricing',
      'channel_account_stats_pricing_intervals',
      'channel_account_stats_pricing_models',
      'channel_account_stats_pricing_rules',
      'channel_account_stats_rule_accounts',
      'channel_account_stats_rule_groups',
    ])
    expect(tables.every(({ sql }) => sql.endsWith('STRICT'))).toBe(true)
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 53',
    ).get()).toEqual({ version: 53, name: 'account_stats_pricing' })
    expect(raw.prepare(`
      SELECT input_micros_per_million, cache_write_1h_micros_per_million,
             image_output_micros_per_million, per_request_micros
        FROM channel_account_stats_model_pricing WHERE id = 'rule-price'
    `).get()).toEqual({
      input_micros_per_million: 1_250_000,
      cache_write_1h_micros_per_million: 2_500_000,
      image_output_micros_per_million: 4_000_000,
      per_request_micros: 25_000,
    })
  })

  it('reuses the existing account-time index without rebuilding historical usage indexes', () => {
    const raw = databaseThrough()
    const plan = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT event_id
        FROM usage_projection
       WHERE account_id = ? AND account_stats_rollup_version = 0
         AND occurred_at_ms >= ? AND occurred_at_ms < ?
       ORDER BY occurred_at_ms, event_id
       LIMIT 10001
    `).all('account-stats', 0, 1_000) as Array<{ detail: string }>

    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'idx_usage_projection_account_time',
    )
  })

  it('normalizes scopes and cascades every child without deleting authorities', () => {
    const raw = databaseThrough()
    seedAuthorities(raw)
    seedRuleGraph(raw)

    expect(() => raw.exec(`
      INSERT INTO channel_account_stats_rule_groups (rule_id, group_id, created_at_ms)
      VALUES ('rule-stats', 'group-stats', 3)
    `)).toThrow(/UNIQUE/)
    expect(() => raw.exec(`
      INSERT INTO channel_account_stats_rule_accounts (rule_id, account_id, created_at_ms)
      VALUES ('missing-rule', 'account-stats', 3)
    `)).toThrow(/FOREIGN KEY/)

    raw.prepare('DELETE FROM channel_account_stats_model_pricing WHERE id = ?').run('rule-price')
    expect(raw.prepare(`
      SELECT
        (SELECT COUNT(*) FROM channel_account_stats_pricing_models) AS models,
        (SELECT COUNT(*) FROM channel_account_stats_pricing_intervals) AS intervals
    `).get()).toEqual({ models: 0, intervals: 0 })

    raw.prepare('DELETE FROM channels WHERE id = ?').run('channel-stats')
    expect(raw.prepare(`
      SELECT
        (SELECT COUNT(*) FROM channel_account_stats_pricing_rules) AS rules,
        (SELECT COUNT(*) FROM channel_account_stats_rule_groups) AS groups,
        (SELECT COUNT(*) FROM channel_account_stats_rule_accounts) AS accounts
    `).get()).toEqual({ rules: 0, groups: 0, accounts: 0 })
    expect(raw.prepare(
      `SELECT COUNT(*) AS total FROM accounts WHERE id = 'account-stats'`,
    ).get()).toEqual({ total: 1 })
    expect(raw.prepare(
      `SELECT COUNT(*) AS total FROM "groups" WHERE id = 'group-stats'`,
    ).get()).toEqual({ total: 1 })
  })

  it('rejects invalid modes, prices, intervals, patterns, and account multipliers', () => {
    const raw = databaseThrough()
    seedAuthorities(raw)
    raw.exec(`
      INSERT INTO channel_account_stats_pricing_rules (
        id, channel_id, name, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('rule-stats', 'channel-stats', '', 0, 2, 2)
    `)

    const price = raw.prepare(`
      INSERT INTO channel_account_stats_model_pricing (
        id, rule_id, platform, billing_mode, input_micros_per_million,
        created_at_ms, updated_at_ms
      ) VALUES (?, 'rule-stats', '', ?, ?, 2, 2)
    `)
    expect(() => price.run('price-mode', 'video', 1)).toThrow(/CHECK/)
    expect(() => price.run('price-negative', 'token', -1)).toThrow(/CHECK/)
    expect(() => price.run('price-real', 'token', 1.25)).toThrow(/cannot store REAL|datatype mismatch/)
    price.run('price-valid', 'token', 1)

    const model = raw.prepare(`
      INSERT INTO channel_account_stats_pricing_models (
        pricing_id, model_pattern, is_wildcard, created_at_ms
      ) VALUES ('price-valid', ?, ?, 2)
    `)
    expect(() => model.run('gpt-*', 0)).toThrow(/CHECK/)
    expect(() => model.run('gpt-*-mini', 1)).toThrow(/CHECK/)
    model.run('*', 1)
    expect(() => model.run('*', 1)).toThrow(/UNIQUE/)

    expect(() => raw.exec(`
      INSERT INTO channel_account_stats_pricing_intervals (
        id, pricing_id, min_tokens, max_tokens, created_at_ms, updated_at_ms
      ) VALUES ('bad-range', 'price-valid', 100, 99, 2, 2)
    `)).toThrow(/CHECK/)
    expect(() => raw.exec(`
      INSERT INTO channel_account_stats_pricing_intervals (
        id, pricing_id, min_tokens, max_tokens, created_at_ms, updated_at_ms
      ) VALUES ('empty-range', 'price-valid', 100, 100, 2, 2)
    `)).toThrow(/CHECK/)
    expect(() => raw.exec(`
      INSERT INTO channel_account_stats_pricing_intervals (
        id, pricing_id, per_request_micros, created_at_ms, updated_at_ms
      ) VALUES ('bad-price', 'price-valid', -1, 2, 2)
    `)).toThrow(/CHECK/)
    expect(() => raw.prepare(
      'UPDATE accounts SET billing_rate_multiplier_ppm = ? WHERE id = ?',
    ).run(-1, 'account-stats')).toThrow(/CHECK/)
    expect(() => raw.prepare(
      'UPDATE accounts SET billing_rate_multiplier_ppm = ? WHERE id = ?',
    ).run(1.5, 'account-stats')).toThrow(/cannot store REAL|datatype mismatch/)
  })

  it('backfills exact usage economics, indexes reads, and freezes their snapshot', () => {
    const raw = databaseThrough(52)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-stats', 'stats@example.test', 1, 1);
      INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES ('group-stats', 'Stats group', 'openai', 1, 1);
      INSERT INTO accounts (
        id, platform, name, credential_ref, created_at_ms, updated_at_ms
      ) VALUES ('account-stats', 'openai', 'Stats account', 'secret:stats', 1, 1);
      INSERT INTO usage_projection (
        event_id, request_id, user_id, account_id, group_id, model,
        amount_micros, occurred_at_ms, projected_at_ms
      ) VALUES (
        'usage-before-stats', 'request-before-stats', 'user-stats',
        'account-stats', 'group-stats', 'gpt-5', 123456, 2, 2
      );
    `)

    applyMigrations(raw, 53)

    expect(raw.prepare(`
      SELECT standard_cost_micros, account_stats_cost_micros,
             account_rate_multiplier_ppm, account_cost_micros
        FROM usage_projection WHERE event_id = 'usage-before-stats'
    `).get()).toEqual({
      standard_cost_micros: null,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: null,
      account_cost_micros: null,
    })
    expect(raw.prepare(`
      SELECT billing_rate_multiplier_ppm FROM accounts WHERE id = 'account-stats'
    `).get()).toEqual({ billing_rate_multiplier_ppm: 1_000_000 })

    const indexes = raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
        'idx_account_stats_rules_channel_order',
        'idx_account_stats_rule_groups_lookup',
        'idx_account_stats_rule_accounts_lookup',
        'idx_account_stats_pricing_rule_platform',
        'idx_account_stats_pricing_models_read',
        'idx_account_stats_pricing_intervals_read',
        'idx_usage_projection_account_time'
      ) ORDER BY name
    `).all() as Array<{ name: string }>
    expect(indexes.map(({ name }) => name)).toEqual([
      'idx_account_stats_pricing_intervals_read',
      'idx_account_stats_pricing_models_read',
      'idx_account_stats_pricing_rule_platform',
      'idx_account_stats_rule_accounts_lookup',
      'idx_account_stats_rule_groups_lookup',
      'idx_account_stats_rules_channel_order',
      'idx_usage_projection_account_time',
    ])
    expect(raw.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'index' AND name IN (
         'idx_usage_projection_account_cost_time',
         'idx_usage_projection_account_rollup_time',
         'idx_usage_projection_rollup_pending'
       )
    `).get()).toEqual({ count: 0 })

    expect(() => raw.prepare(`
      UPDATE usage_projection SET account_cost_micros = 1 WHERE event_id = ?
    `).run('usage-before-stats')).toThrow(/usage_account_cost_immutable/)
  })
})
