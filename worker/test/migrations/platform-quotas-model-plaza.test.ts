import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('platform quotas and model plaza migration', () => {
  it('creates owner-scoped integer-micros quota policy, defaults, audit, and recovery state', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)

    const tables = raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'user_platform_quotas',
          'platform_quota_defaults',
          'platform_quota_defaults_control',
          'admin_platform_quota_default_audit_events',
          'admin_platform_quota_audit_events'
        )
        ORDER BY name`,
    ).all() as Array<{ name: string }>
    expect(tables.map(({ name }) => name)).toEqual([
      'admin_platform_quota_audit_events',
      'admin_platform_quota_default_audit_events',
      'platform_quota_defaults',
      'platform_quota_defaults_control',
      'user_platform_quotas',
    ])

    expect(raw.prepare(
      `SELECT control_version, last_mutation_id
         FROM platform_quota_defaults_control WHERE singleton = 1`,
    ).get()).toEqual({ control_version: 0, last_mutation_id: null })

    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'quota@example.test', 'Quota', ?, ?)`,
    ).run(now, now)
    raw.prepare(
      `INSERT INTO user_platform_quotas (
         user_id, platform, enabled,
         daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
         daily_used_micros, weekly_used_micros, monthly_used_micros,
         daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
         control_version, created_at_ms, updated_at_ms
       ) VALUES ('user-1', 'openai', 1, 1000000, NULL, 3000000,
         0, 0, 0, 0, 0, 0, 1, ?, ?)`,
    ).run(now, now)
    expect(raw.prepare(
      `SELECT platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
              control_version
         FROM user_platform_quotas WHERE user_id = 'user-1'`,
    ).get()).toEqual({
      platform: 'openai',
      daily_limit_micros: 1_000_000,
      weekly_limit_micros: null,
      monthly_limit_micros: 3_000_000,
      control_version: 1,
    })

    expect(() => raw.prepare(
      `INSERT INTO user_platform_quotas (
         user_id, platform, enabled, daily_limit_micros,
         control_version, created_at_ms, updated_at_ms
       ) VALUES ('user-1', 'unsupported', 1, 1, 1, ?, ?)`,
    ).run(now, now)).toThrow()
    expect(() => raw.prepare(
      `UPDATE user_platform_quotas SET daily_used_micros = 1.25
        WHERE user_id = 'user-1' AND platform = 'openai'`,
    ).run()).toThrow()

    const recoveryColumns = raw.prepare('PRAGMA table_info(settlement_recovery)').all() as Array<{
      name: string
      dflt_value: string | null
    }>
    expect(recoveryColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'platform_quota_settled', dflt_value: '1' }),
      expect.objectContaining({ name: 'platform_quota_projected', dflt_value: '1' }),
      expect.objectContaining({ name: 'platform_quota_usage_json' }),
    ]))
    raw.close()
  })

  it('enforces one authoritative quota row per owner and platform with monotonic versions', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'one@example.test', 'One', ?, ?),
              ('user-2', 'two@example.test', 'Two', ?, ?)`,
    ).run(now, now, now, now)
    const insert = raw.prepare(
      `INSERT INTO user_platform_quotas (
         user_id, platform, enabled, control_version, created_at_ms, updated_at_ms
       ) VALUES (?, 'anthropic', 1, 1, ?, ?)`,
    )
    insert.run('user-1', now, now)
    insert.run('user-2', now, now)
    expect(raw.prepare('SELECT COUNT(*) AS total FROM user_platform_quotas').get()).toEqual({ total: 2 })

    expect(() => raw.prepare(
      `UPDATE user_platform_quotas SET control_version = 0
        WHERE user_id = 'user-1' AND platform = 'anthropic'`,
    ).run()).toThrow(/platform_quota_control_version_regressed/)
    expect(() => insert.run('user-1', now, now)).toThrow(/UNIQUE/)
    raw.close()
  })
})
