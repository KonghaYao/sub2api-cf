import { expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

it('invalidates old pool snapshots once without altering account configuration', () => {
  const { raw } = createSqliteD1()
  applyMigrations(raw, 117)
  const before = raw.prepare('SELECT revision FROM gateway_config_revision WHERE singleton = 1').get().revision
  const accounts = raw.prepare('SELECT * FROM accounts').all()
  applyMigrations(raw, 118)
  expect(raw.prepare('SELECT revision FROM gateway_config_revision WHERE singleton = 1').get().revision).toBe(before + 1)
  expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 118').get()).toEqual({ name: 'pool_load_factor_revision' })
  expect(raw.prepare('SELECT * FROM accounts').all()).toEqual(accounts)
  applyMigrations(raw, 118)
  expect(raw.prepare('SELECT revision FROM gateway_config_revision WHERE singleton = 1').get().revision).toBe(before + 1)
  raw.close()
})
