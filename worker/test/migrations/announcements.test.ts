import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('announcement migration', () => {
  it('registers version 38 and protects bounded active state and immutable audit', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 38',
    ).get()).toEqual({ version: 38, name: 'announcements' })
    expect(raw.prepare(
      `SELECT COUNT(*) AS total FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_announcements_admin_title',
          'idx_users_announcement_email',
          'idx_users_announcement_display_name',
          'idx_users_announcement_balance',
          'idx_users_announcement_created'
        )`,
    ).get()).toEqual({ total: 5 })
    expect(raw.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'limit_total_announcement_insert'`,
    ).get()?.sql).toContain('10000')
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
       VALUES ('admin', 'admin@example.test', 'Admin', 'admin', ?, ?)`,
    ).run(now, now)
    const insert = raw.prepare(
      `INSERT INTO announcements (
         id, title, content, status, notify_mode, targeting_json,
         created_by_user_id, updated_by_user_id, created_at_ms, updated_at_ms
       ) VALUES (?, 'Notice', 'Body', ?, 'silent', '{"any_of":[]}', 'admin', 'admin', ?, ?)`,
    )
    for (let index = 0; index < 500; index += 1) {
      insert.run(`announcement-${index}`, 'active', now, now)
    }
    expect(() => insert.run('announcement-over-limit', 'active', now, now)).toThrow(/active_announcement_limit/)
    expect(() => insert.run('announcement-draft', 'draft', now, now)).not.toThrow()

    raw.prepare(
      `INSERT INTO announcement_admin_audit_events (
         id, actor_user_id, actor_session_id, action, announcement_id,
         resource_version, occurred_at_ms
       ) VALUES ('audit-1', 'admin', 'session-admin', 'announcement.create',
                 'announcement-0', 1, ?)`,
    ).run(now)
    expect(() => raw.prepare(
      `UPDATE announcement_admin_audit_events SET details_json = '{}' WHERE id = 'audit-1'`,
    ).run()).toThrow(/announcement_audit_immutable/)
    expect(() => raw.prepare(
      `DELETE FROM announcement_admin_audit_events WHERE id = 'audit-1'`,
    ).run()).toThrow(/announcement_audit_immutable/)
    raw.close()
  })
})
