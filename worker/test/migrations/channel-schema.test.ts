import { afterEach, describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const databases: any[] = []

function createChannelDatabase(): any {
  const { raw } = createSqliteD1()
  databases.push(raw)
  applyMigrations(raw)
  raw.exec(`
    INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
    VALUES
      ('group-channel-1', 'Channel group 1', 'openai', 1, 1),
      ('group-channel-2', 'Channel group 2', 'anthropic', 1, 1);

    INSERT INTO channels (
      id, name, description, status, billing_model_source,
      restrict_models, features_config_json,
      apply_pricing_to_account_stats, control_version,
      created_at_ms, updated_at_ms
    ) VALUES (
      'channel-1', 'Primary Channel', 'Public catalog entry', 'active',
      'channel_mapped', 1, '{"web_search":true}', 1, 7, 1, 2
    );
  `)
  return raw
}

function seedNormalizedPricing(raw: any): void {
  raw.exec(`
    INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
    VALUES ('channel-1', 'group-channel-1', 2);

    INSERT INTO channel_model_pricing (
      id, channel_id, platform, billing_mode,
      input_micros_per_million, output_micros_per_million,
      cache_write_micros_per_million, cache_write_1h_micros_per_million,
      cache_read_micros_per_million, image_input_micros_per_million,
      image_output_micros_per_million, per_request_micros,
      fast_multiplier_ppm, flex_multiplier_ppm, time_pricing_json,
      control_version, created_at_ms, updated_at_ms
    ) VALUES (
      'pricing-1', 'channel-1', 'openai', 'token',
      1500000, 6000000, 1875000, 3000000, 150000,
      250000, 500000, 12500, 2000000, 500000,
      '{"peak":{"start":"09:00","end":"18:00","multiplier_ppm":1250000}}',
      3, 2, 3
    );

    INSERT INTO channel_pricing_models (
      pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
    ) VALUES
      ('pricing-1', 'gpt-5', 0, 0, 2),
      ('pricing-1', 'gpt-5-*', 1, 1, 2);

    INSERT INTO channel_pricing_intervals (
      id, pricing_id, min_tokens, max_tokens, tier_label,
      input_micros_per_million, output_micros_per_million,
      cache_write_micros_per_million, cache_write_1h_micros_per_million,
      cache_read_micros_per_million, input_multiplier_ppm,
      output_multiplier_ppm, cache_write_multiplier_ppm,
      cache_read_multiplier_ppm, per_request_micros,
      sort_order, created_at_ms, updated_at_ms
    ) VALUES (
      'interval-1', 'pricing-1', 0, 999999, 'base',
      1500000, 6000000, 1875000, 3000000, 150000,
      1000000, 1000000, 1000000, 1000000, 12500,
      0, 2, 3
    );

    INSERT INTO channel_model_mappings (
      channel_id, platform, source_pattern, target_pattern,
      source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
    ) VALUES
      ('channel-1', 'openai', 'gpt-5-*', 'gpt-5-*', 1, 1, 0, 2),
      ('channel-1', 'anthropic', 'claude-sonnet', 'claude-3-7-sonnet', 0, 0, 1, 2);
  `)
}

afterEach(() => {
  while (databases.length > 0) databases.pop().close()
})

describe('normalized channel storage migration', () => {
  it('creates strict normalized tables and preserves exact integer pricing', () => {
    const raw = createChannelDatabase()
    seedNormalizedPricing(raw)

    const tables = raw.prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'channels', 'channel_groups', 'channel_model_pricing',
          'channel_pricing_models', 'channel_pricing_intervals',
          'channel_model_mappings'
        )
        ORDER BY name`,
    ).all() as Array<{ name: string; sql: string }>
    expect(tables.map(({ name }) => name)).toEqual([
      'channel_groups',
      'channel_model_mappings',
      'channel_model_pricing',
      'channel_pricing_intervals',
      'channel_pricing_models',
      'channels',
    ])
    expect(tables.every(({ sql }) => sql.endsWith('STRICT'))).toBe(true)
    expect(raw.prepare(
      'SELECT name FROM schema_migrations WHERE version = 50',
    ).get()).toEqual({ name: 'channels' })

    expect(raw.prepare(
      `SELECT input_micros_per_million, output_micros_per_million,
              fast_multiplier_ppm, flex_multiplier_ppm, time_pricing_json
         FROM channel_model_pricing WHERE id = 'pricing-1'`,
    ).get()).toEqual({
      input_micros_per_million: 1_500_000,
      output_micros_per_million: 6_000_000,
      fast_multiplier_ppm: 2_000_000,
      flex_multiplier_ppm: 500_000,
      time_pricing_json:
        '{"peak":{"start":"09:00","end":"18:00","multiplier_ppm":1250000}}',
    })
  })

  it('enforces case-insensitive identities, one channel per group, and foreign keys', () => {
    const raw = createChannelDatabase()
    seedNormalizedPricing(raw)

    expect(() => raw.exec(`
      INSERT INTO channels (id, name, created_at_ms, updated_at_ms)
      VALUES ('channel-name-clash', 'primary channel', 1, 1)
    `)).toThrow(/UNIQUE/)
    expect(() => raw.exec(`
      INSERT INTO channels (id, name, created_at_ms, updated_at_ms)
      VALUES ('channel-2', 'Secondary Channel', 1, 1);
      INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
      VALUES ('channel-2', 'group-channel-1', 2)
    `)).toThrow(/UNIQUE/)
    expect(() => raw.exec(`
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, created_at_ms
      ) VALUES ('pricing-1', 'GPT-5', 0, 2)
    `)).toThrow(/UNIQUE/)
    expect(() => raw.exec(`
      INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
      VALUES ('channel-missing', 'group-channel-2', 2)
    `)).toThrow(/FOREIGN KEY/)
    expect(() => raw.exec(`
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, created_at_ms, updated_at_ms
      ) VALUES ('pricing-missing', 'channel-missing', 'openai', 'token', 2, 2)
    `)).toThrow(/FOREIGN KEY/)
  })

  it('rejects malformed JSON, invalid enums, imprecise money, and bad patterns', () => {
    const raw = createChannelDatabase()

    const insertChannelWithFeatures = raw.prepare(
      `INSERT INTO channels (
         id, name, features_config_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, 1)`,
    )
    expect(() => insertChannelWithFeatures.run(
      'channel-json-invalid', 'Invalid JSON', '{',
    )).toThrow(/CHECK/)
    expect(() => insertChannelWithFeatures.run(
      'channel-json-array', 'Array JSON', '[]',
    )).toThrow(/CHECK/)
    expect(() => raw.exec(`
      INSERT INTO channels (
        id, name, status, billing_model_source, created_at_ms, updated_at_ms
      ) VALUES ('channel-enum', 'Bad enum', 'paused', 'group', 1, 1)
    `)).toThrow(/CHECK/)

    const insertPricing = raw.prepare(
      `INSERT INTO channel_model_pricing (
         id, channel_id, platform, billing_mode,
         input_micros_per_million, time_pricing_json,
         created_at_ms, updated_at_ms
       ) VALUES (?, 'channel-1', 'openai', ?, ?, ?, 2, 2)`,
    )
    expect(() => insertPricing.run(
      'pricing-bad-mode', 'minute', 1, '{}',
    )).toThrow(/CHECK/)
    expect(() => insertPricing.run(
      'pricing-negative', 'token', -1, '{}',
    )).toThrow(/CHECK/)
    expect(() => insertPricing.run(
      'pricing-fraction', 'token', 1.25, '{}',
    )).toThrow(/cannot store REAL|datatype mismatch/)
    expect(() => insertPricing.run(
      'pricing-time-array', 'token', 1, '[]',
    )).toThrow(/CHECK/)

    raw.exec(`
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, created_at_ms, updated_at_ms
      ) VALUES ('pricing-valid', 'channel-1', 'openai', 'token', 2, 2)
    `)
    const insertModel = raw.prepare(
      `INSERT INTO channel_pricing_models (
         pricing_id, model_pattern, is_wildcard, created_at_ms
       ) VALUES ('pricing-valid', ?, ?, 2)`,
    )
    expect(() => insertModel.run('gpt-*', 0)).toThrow(/CHECK/)
    expect(() => insertModel.run('gpt-*-mini', 1)).toThrow(/CHECK/)
    insertModel.run('*', 1)

    expect(() => raw.exec(`
      INSERT INTO channel_pricing_intervals (
        id, pricing_id, min_tokens, max_tokens,
        input_multiplier_ppm, created_at_ms, updated_at_ms
      ) VALUES ('interval-order', 'pricing-valid', 100, 99, 1000000, 2, 2)
    `)).toThrow(/CHECK/)
    expect(() => raw.exec(`
      INSERT INTO channel_pricing_intervals (
        id, pricing_id, input_multiplier_ppm, created_at_ms, updated_at_ms
      ) VALUES ('interval-negative', 'pricing-valid', -1, 2, 2)
    `)).toThrow(/CHECK/)
    expect(() => raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, created_at_ms
      ) VALUES ('channel-1', 'openai', 'gpt-*-bad', 'target', 1, 0, 2)
    `)).toThrow(/CHECK/)
    expect(() => raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, created_at_ms
      ) VALUES ('channel-1', 'openai', 'gpt', '', 0, 1, 2)
    `)).toThrow(/CHECK/)
  })

  it('indexes available reads and cascades normalized children', () => {
    const raw = createChannelDatabase()
    seedNormalizedPricing(raw)

    const indexes = raw.prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_channels_available',
          'idx_channel_groups_one_channel_per_group',
          'idx_channel_groups_channel',
          'idx_channel_model_pricing_available',
          'idx_channel_pricing_models_read',
          'idx_channel_pricing_intervals_read',
          'idx_channel_model_mappings_read'
        )
        ORDER BY name`,
    ).all() as Array<{ name: string; sql: string }>
    expect(indexes.map(({ name }) => name)).toEqual([
      'idx_channel_groups_channel',
      'idx_channel_groups_one_channel_per_group',
      'idx_channel_model_mappings_read',
      'idx_channel_model_pricing_available',
      'idx_channel_pricing_intervals_read',
      'idx_channel_pricing_models_read',
      'idx_channels_available',
    ])
    expect(indexes.find(({ name }) => name === 'idx_channels_available')?.sql)
      .toContain("WHERE status = 'active'")
    expect(indexes.find(({ name }) => name === 'idx_channel_model_pricing_available')?.sql)
      .toContain('channel_id, platform, billing_mode, id')

    raw.prepare('DELETE FROM channel_model_pricing WHERE id = ?').run('pricing-1')
    expect(raw.prepare(
      `SELECT
         (SELECT COUNT(*) FROM channel_pricing_models) AS models,
         (SELECT COUNT(*) FROM channel_pricing_intervals) AS intervals,
         (SELECT COUNT(*) FROM channel_model_mappings) AS mappings`,
    ).get()).toEqual({ models: 0, intervals: 0, mappings: 2 })

    raw.prepare('DELETE FROM channels WHERE id = ?').run('channel-1')
    expect(raw.prepare(
      `SELECT
         (SELECT COUNT(*) FROM channel_groups) AS groups,
         (SELECT COUNT(*) FROM channel_model_mappings) AS mappings,
         (SELECT COUNT(*) FROM channel_model_pricing) AS pricing`,
    ).get()).toEqual({ groups: 0, mappings: 0, pricing: 0 })
    expect(raw.prepare(
      `SELECT COUNT(*) AS groups FROM "groups"
        WHERE id = 'group-channel-1'`,
    ).get()).toEqual({ groups: 1 })
  })
})
