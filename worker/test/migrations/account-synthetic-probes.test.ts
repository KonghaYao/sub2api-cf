import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('migration 0060 account synthetic probes', () => {
  it('installs durable monitor, outbox, history, alert, and audit state', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw)
      expect(raw.prepare(
        'SELECT name FROM schema_migrations WHERE version = 60',
      ).get()).toEqual({ name: 'account_synthetic_probes' })
      for (const table of [
        'account_synthetic_probe_monitors',
        'account_synthetic_probe_jobs',
        'account_synthetic_probe_history',
        'account_synthetic_alert_events',
        'admin_account_synthetic_probe_audit_events',
      ]) {
        expect(raw.prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        ).get(table)).toEqual({ name: table })
      }
    } finally {
      raw.close()
    }
  })
})
