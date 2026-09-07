import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('redeem admin parity migration', () => {
  it('preserves existing claims while extending types and statuses', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 78)
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'user@example.test', 'User', 'user', 'active', ?, ?)`,
    ).run(now, now)
    raw.prepare(
      `INSERT INTO redeem_codes (
         id, code_hash, code_prefix, type, value_micros, status,
         created_at_ms, updated_at_ms
       ) VALUES ('code-1', ?, 'EXISTING', 'balance', 1000000, 'unused', ?, ?)`,
    ).run('a'.repeat(64), now, now)
    raw.prepare(
      `UPDATE redeem_codes SET status = 'processing', used_by_user_id = 'user-1',
         claimed_by_redemption_id = 'claim-1', used_at_ms = ? WHERE id = 'code-1'`,
    ).run(now)
    raw.prepare(
      `INSERT INTO redemptions (
         id, code_id, user_id, idempotency_key_hash, status, type,
         value_micros, created_at_ms
       ) VALUES ('claim-1', 'code-1', 'user-1', ?, 'processing', 'balance', 1000000, ?)`,
    ).run('b'.repeat(64), now)

    applyMigrations(raw)

    expect(raw.prepare('SELECT type, status FROM redeem_codes WHERE id = ?').get('code-1')).toEqual({
      type: 'balance', status: 'processing',
    })
    expect(raw.prepare('SELECT code_id FROM redemptions WHERE id = ?').get('claim-1')).toEqual({
      code_id: 'code-1',
    })
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 79',
    ).get()).toEqual({ version: 79, name: 'redeem_admin_parity' })
    expect(() => raw.prepare(
      `INSERT INTO redeem_codes (
         id, code_hash, code_prefix, type, value_micros, status,
         created_at_ms, updated_at_ms
       ) VALUES ('invite-1', ?, 'INVITE', 'invitation', 0, 'disabled', ?, ?)`,
    ).run('c'.repeat(64), now, now)).not.toThrow()
    expect(raw.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'redeem_code_secrets'`,
    ).get()).toEqual({ name: 'redeem_code_secrets' })
    raw.close()
  })
})
