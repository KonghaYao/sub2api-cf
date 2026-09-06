import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('user group access audit migration', () => {
  it('keeps group access audit events after target deletion and prevents rewrites', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
       VALUES ('admin', 'admin@example.test', 'Admin', 'admin', ?, ?),
              ('target', 'target@example.test', 'Target', 'user', ?, ?)`,
    ).run(now, now, now, now)
    raw.prepare(
      `INSERT INTO admin_user_group_access_audit_events (
         id, actor_user_id, actor_session_id, action, target_user_id, control_version,
         idempotency_key_hash, metadata_json, occurred_at_ms
       ) VALUES ('audit-1', 'admin', 'session-admin', 'user.group_access.replace', 'target', 2,
                 ?, '{"allowed_group_ids":["group-1"]}', ?)`,
    ).run('a'.repeat(64), now)

    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 74',
    ).get()).toEqual({ version: 74, name: 'user_group_access_audit' })
    expect(() => raw.prepare(
      "UPDATE admin_user_group_access_audit_events SET metadata_json = '{}' WHERE id = 'audit-1'",
    ).run()).toThrow(/admin_user_group_access_audit_immutable/)
    expect(() => raw.prepare(
      "DELETE FROM admin_user_group_access_audit_events WHERE id = 'audit-1'",
    ).run()).toThrow(/admin_user_group_access_audit_immutable/)
    raw.prepare("DELETE FROM users WHERE id = 'target'").run()
    expect(raw.prepare(
      "SELECT target_user_id FROM admin_user_group_access_audit_events WHERE id = 'audit-1'",
    ).get()).toEqual({ target_user_id: 'target' })
    raw.close()
  })
})
