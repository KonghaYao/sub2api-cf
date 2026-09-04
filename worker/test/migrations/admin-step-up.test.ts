import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('admin step-up migration', () => {
  it('defaults existing settings off and remains compatible with old-Worker updates', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 26)
    const before = raw.prepare(
      "SELECT control_version, public_json FROM system_settings WHERE id = 'global'",
    ).get() as { control_version: number; public_json: string }

    applyMigrations(raw, 27)

    expect(raw.prepare(
      "SELECT step_up_enabled FROM system_settings WHERE id = 'global'",
    ).get()).toEqual({ step_up_enabled: 0 })
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 27').get())
      .toEqual({ name: 'admin_step_up' })

    // A still-running old Worker does not name the new column. Its write must
    // retain the safe migration default during a rolling deployment.
    raw.prepare(
      `UPDATE system_settings SET control_version = ?, public_json = ?, updated_at_ms = ?
        WHERE id = 'global'`,
    ).run(before.control_version + 1, before.public_json, Date.now())
    expect(raw.prepare(
      "SELECT step_up_enabled FROM system_settings WHERE id = 'global'",
    ).get()).toEqual({ step_up_enabled: 0 })

    expect(() => raw.prepare(
      "UPDATE system_settings SET step_up_enabled = -1 WHERE id = 'global'",
    ).run()).toThrow(/CHECK constraint failed/)
    expect(() => raw.prepare(
      "UPDATE system_settings SET step_up_enabled = 2 WHERE id = 'global'",
    ).run()).toThrow(/CHECK constraint failed/)
    raw.close()
  })
})
