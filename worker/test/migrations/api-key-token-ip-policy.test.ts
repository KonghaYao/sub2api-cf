import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('migration 0059 API key token and IP policy', () => {
  it('backfills empty policy and remains compatible with rolling old-Worker inserts', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 58)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'policy@example.test', 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, created_at_ms, updated_at_ms
      ) VALUES ('key-before', 'user-1', '${'a'.repeat(64)}', 'before', 1, 1);
    `)

    applyMigrations(raw, 59)
    expect(raw.prepare(
      `SELECT ip_allowlist_json, ip_denylist_json FROM api_keys WHERE id = 'key-before'`,
    ).get()).toEqual({ ip_allowlist_json: '[]', ip_denylist_json: '[]' })
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 59').get())
      .toEqual({ name: 'api_key_token_ip_policy' })

    raw.prepare(`
      INSERT INTO api_keys (id, user_id, key_hash, name, created_at_ms, updated_at_ms)
      VALUES ('key-during', 'user-1', ?, 'during', 2, 2)
    `).run('b'.repeat(64))
    expect(raw.prepare(
      `SELECT ip_allowlist_json, ip_denylist_json FROM api_keys WHERE id = 'key-during'`,
    ).get()).toEqual({ ip_allowlist_json: '[]', ip_denylist_json: '[]' })
    raw.close()
  })

  it('rejects non-array, malformed, and over-budget policy JSON', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 59)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'policy@example.test', 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, created_at_ms, updated_at_ms
      ) VALUES ('key-1', 'user-1', '${'c'.repeat(64)}', 'one', 1, 1);
    `)

    for (const value of ['not-json', '{}', JSON.stringify(Array<string>(65).fill('10.0.0.1'))]) {
      expect(() => raw.prepare(
        `UPDATE api_keys SET ip_allowlist_json = ? WHERE id = 'key-1'`,
      ).run(value)).toThrow(/CHECK constraint failed/)
    }
    raw.close()
  })
})
