import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('email challenge migration', () => {
  it('upgrades a v16 database and enforces hashed, purpose-bound challenge storage', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 16)
    applyMigrations(raw, 17)

    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 17').get()).toEqual({
      name: 'email_challenges',
    })
    const sql = raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_challenges'`,
    ).get().sql as string
    expect(sql).toContain('token_hash')
    expect(sql).not.toMatch(/token\s+TEXT/i)
    expect(sql).toContain("purpose IN ('registration_email_verification', 'email_verification', 'password_reset')")
    expect(raw.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registration_email_challenge_claims'`,
    ).get()).toEqual({ name: 'registration_email_challenge_claims' })
  })
})
