// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function migration39(): string {
  return readFileSync(
    new URL('../../migrations/0039_auth_source_entitlements.sql', import.meta.url),
    'utf8',
  )
}

describe('migration 0039 auth source entitlements', () => {
  it('installs every supported source and an immutable exactly-once ledger', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 38)
    raw.exec(migration39())

    expect(raw.prepare('SELECT source FROM auth_source_defaults ORDER BY source').all())
      .toEqual(['dingtalk', 'email', 'github', 'google', 'linuxdo', 'oidc', 'wechat'].map((source) => ({ source })))

    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, status, balance_micros, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'u@example.com', 'U', 'user', 'active', 0, ?, ?)`,
    ).run(now, now)
    raw.prepare(
      `INSERT INTO auth_source_entitlement_grants (
         id, user_id, source, reason, attempt_nonce, balance_micros,
         concurrency, subscriptions_json, platform_quotas_json, created_at_ms
       ) VALUES ('grant-1', 'user-1', 'email', 'signup', 'attempt-1', 0, 5, '[]', '{}', ?)`,
    ).run(now)

    expect(() => raw.prepare(
      `INSERT INTO auth_source_entitlement_grants (
         id, user_id, source, reason, attempt_nonce, balance_micros,
         concurrency, subscriptions_json, platform_quotas_json, created_at_ms
       ) VALUES ('grant-2', 'user-1', 'email', 'signup', 'attempt-2', 0, 5, '[]', '{}', ?)`,
    ).run(now)).toThrow(/UNIQUE constraint failed/)
    expect(() => raw.prepare(
      "UPDATE auth_source_entitlement_grants SET balance_micros = 1 WHERE id = 'grant-1'",
    ).run()).toThrow(/auth_source_entitlement_grant_immutable/)
  })

  it('rejects non-subscription groups and invalid quota structures at the database boundary', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 38)
    raw.exec(migration39())
    const now = Date.now()
    raw.prepare(
      `INSERT INTO "groups" (id, name, platform, group_type, created_at_ms, updated_at_ms)
       VALUES ('standard', 'Standard', 'openai', 'standard', ?, ?)`,
    ).run(now, now)
    expect(() => raw.prepare(
      `INSERT INTO auth_source_default_subscriptions (source, group_id, validity_days)
       VALUES ('email', 'standard', 30)`,
    ).run()).toThrow(/auth_source_subscription_group_required/)
    expect(() => raw.prepare(
      `INSERT INTO auth_source_default_platform_quotas (
         source, platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
       ) VALUES ('email', 'not-a-platform', 1, NULL, NULL)`,
    ).run()).toThrow()
  })
})
