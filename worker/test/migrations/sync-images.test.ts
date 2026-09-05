import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('sync image capability migration', () => {
  it('adds fail-closed model/account flags and advances routing revision on changes', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)

    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 44').get())
      .toEqual({ name: 'sync_images' })
    const modelColumns = raw.prepare(`PRAGMA table_info('models')`).all()
    const accountModelColumns = raw.prepare(`PRAGMA table_info('account_models')`).all()
    expect(modelColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'image_generation', notnull: 1, dflt_value: '0' }),
    ]))
    expect(accountModelColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'image_generation', notnull: 1, dflt_value: '0' }),
    ]))

    raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, enabled,
        created_at_ms, updated_at_ms
      ) VALUES ('image-model', 'openai', 'image-public', 'image-upstream', 'responses', 1, 1, 1);
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms
      ) VALUES (
        'image-account', 'openai', 'image-account', 'image-secret', 1, 1, 1, 1
      );
      INSERT INTO account_models (
        account_id, model_id, created_at_ms, updated_at_ms
      ) VALUES ('image-account', 'image-model', 1, 1);
    `)
    const before = raw.prepare(
      'SELECT revision FROM gateway_config_revision WHERE singleton = 1',
    ).get().revision
    raw.exec(`
      UPDATE models SET image_generation = 1, updated_at_ms = 2 WHERE id = 'image-model';
      UPDATE account_models SET image_generation = 1, updated_at_ms = 2
       WHERE account_id = 'image-account' AND model_id = 'image-model';
    `)
    const after = raw.prepare(
      'SELECT revision FROM gateway_config_revision WHERE singleton = 1',
    ).get().revision
    expect(after - before).toBe(2)

    expect(() => raw.exec(`UPDATE models SET image_generation = 2 WHERE id = 'image-model'`))
      .toThrow()
    expect(() => raw.exec(`UPDATE account_models SET image_generation = -1`)).toThrow()
    raw.close()
  })
})
