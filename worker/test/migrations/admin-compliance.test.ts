import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('migration 0061 administrator compliance acknowledgements', () => {
  it('installs strict, versioned acknowledgements with a current-version index', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw)
      expect(raw.prepare(
        'SELECT name FROM schema_migrations WHERE version = 61',
      ).get()).toEqual({ name: 'admin_compliance_acknowledgements' })
      expect(raw.prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'admin_compliance_acknowledgements'`,
      ).get()).toMatchObject({ sql: expect.stringContaining('STRICT') })
      expect(raw.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_admin_compliance_acknowledgements_current'`,
      ).get()).toEqual({ name: 'idx_admin_compliance_acknowledgements_current' })
    } finally {
      raw.close()
    }
  })
})
