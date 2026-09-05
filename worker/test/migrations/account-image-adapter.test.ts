import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('account image adapter migration', () => {
  it('backfills legacy OpenAI and Codex accounts without changing their image execution behavior', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 44)
    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
        provider_config_json
      ) VALUES
        ('legacy-openai', 'openai', 'Legacy API key', 'openai-secret', 1, 2,
         1, 1, 'openai', 'https://api.openai.com/v1', 'bearer', '{}'),
        ('legacy-codex', 'codex', 'Legacy OAuth', 'codex-secret', 1, 2,
         1, 1, 'codex', 'https://chatgpt.com', 'bearer',
         '{"account_id":"workspace-legacy"}');
    `)

    applyMigrations(raw, 45)

    expect(raw.prepare(`
      SELECT id, image_adapter, credential_kind FROM accounts ORDER BY id
    `).all()).toEqual([
      {
        id: 'legacy-codex',
        image_adapter: 'responses_image_tool',
        credential_kind: 'oauth',
      },
      {
        id: 'legacy-openai',
        image_adapter: 'direct_images',
        credential_kind: 'api_key',
      },
    ])
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 45').get())
      .toEqual({ name: 'account_image_adapter' })
    raw.close()
  })

  it('constrains persisted adapter values and advances the gateway revision on updates', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme
      ) VALUES (
        'account-1', 'openai', 'Primary', 'secret-1', 1, 2,
        1, 1, 'openai', 'https://api.openai.com/v1', 'bearer'
      );
    `)
    const before = raw.prepare(
      'SELECT revision FROM gateway_config_revision WHERE singleton = 1',
    ).get().revision
    raw.exec(`
      UPDATE accounts
         SET image_adapter = 'responses_image_tool', credential_kind = 'setup_token',
             updated_at_ms = 2
       WHERE id = 'account-1';
    `)
    const after = raw.prepare(
      'SELECT revision FROM gateway_config_revision WHERE singleton = 1',
    ).get().revision
    expect(after - before).toBe(1)
    expect(() => raw.exec(`UPDATE accounts SET image_adapter = 'unknown'`)).toThrow()
    expect(() => raw.exec(`UPDATE accounts SET credential_kind = 'password'`)).toThrow()
    raw.close()
  })
})
