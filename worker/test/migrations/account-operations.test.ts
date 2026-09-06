import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('migration 0058 account operations', () => {
  it('adds a continuous immutable account audit log', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw, 57)
      applyMigrations(raw, 58)

      expect(raw.prepare(
        `SELECT version, name FROM schema_migrations WHERE version = 58`,
      ).get()).toEqual({ version: 58, name: 'account_operations' })
      expect(raw.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_account_operation_guards'`,
      ).get().sql).toContain('target_count INTEGER NOT NULL')
      expect(raw.prepare(
        `SELECT name FROM pragma_table_info('account_health_probes')
          WHERE name = 'pool_sync_cursor_json'`,
      ).get()).toEqual({ name: 'pool_sync_cursor_json' })

      raw.exec(`
        INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
        VALUES ('account-admin', 'account-admin@example.test', 'Admin', 'admin', 'active', 1, 1);
        INSERT INTO admin_account_audit_events (
          id, actor_user_id, actor_session_id, action, resource_id,
          resource_version, idempotency_key_hash, metadata_json, occurred_at_ms
        ) VALUES (
          'account-audit-1', 'account-admin', 'session-secret', 'account.enable',
          'account-1', 4, '${'a'.repeat(64)}',
          '{"enabled":true,"quota":"fake"}', 2
        );
        INSERT INTO admin_account_operation_guards (
          scope, idempotency_key_hash, request_hash, action,
          target_count, created_at_ms, expires_at_ms
        ) VALUES (
          'admin.accounts.bulk-status.v1', '${'c'.repeat(64)}', '${'d'.repeat(64)}',
          'account.enable', 1, 2, 3
        );
      `)

      expect(() => raw.prepare(
        `UPDATE admin_account_audit_events SET resource_version = 5 WHERE id = 'account-audit-1'`,
      ).run()).toThrow(/admin_account_audit_immutable/)
      expect(() => raw.prepare(
        `DELETE FROM admin_account_audit_events WHERE id = 'account-audit-1'`,
      ).run()).toThrow(/admin_account_audit_immutable/)
      expect(() => raw.prepare(
        `UPDATE admin_account_operation_guards SET target_count = 2`,
      ).run()).toThrow(/admin_account_operation_guard_immutable/)
    } finally {
      raw.close()
    }
  })
})
