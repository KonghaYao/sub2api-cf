import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('passkey D1 migration', () => {
  it('adds owner-bound credentials and one-time ceremony challenges', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 28)
    applyMigrations(raw, 29)

    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 29').get()).toEqual({
      name: 'passkeys',
    })
    const credentials = raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'passkey_credentials'`,
    ).get().sql as string
    expect(credentials).toContain('credential_id_b64 TEXT NOT NULL UNIQUE')
    expect(credentials).toContain('sign_count INTEGER NOT NULL')
    expect(credentials).toContain('version INTEGER NOT NULL')
    expect(credentials).toContain('REFERENCES users(id) ON DELETE CASCADE')

    const challenges = raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'passkey_challenges'`,
    ).get().sql as string
    expect(challenges).toContain("status TEXT NOT NULL DEFAULT 'pending'")
    expect(challenges).toContain('token_hash TEXT NOT NULL UNIQUE')
    expect(challenges).toContain('registration_session_id TEXT REFERENCES user_sessions(id)')
    expect(challenges).toContain('registration_auth_version INTEGER')
    expect(challenges).not.toContain('session_token')
  })
})
