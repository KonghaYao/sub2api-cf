import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('embeddings capability migration', () => {
  it('adds disabled-by-default model and account capabilities to an existing D1 database', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 7)
    raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, enabled, created_at_ms, updated_at_ms
      ) VALUES ('model-old', 'openai', 'text-old', 'text-upstream', 'both', 1, 1, 1);
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
      ) VALUES (
        'account-old', 'openai', 'old', 'secret-old', 1, 1,
        1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
      );
      INSERT INTO account_models (
        account_id, model_id, chat_completions, responses, created_at_ms, updated_at_ms
      ) VALUES ('account-old', 'model-old', 1, 1, 1, 1);
    `)

    applyMigrations(raw)

    expect(raw.prepare('SELECT embeddings FROM models WHERE id = ?').get('model-old')).toEqual({ embeddings: 0 })
    expect(raw.prepare('SELECT embeddings FROM account_models WHERE account_id = ?').get('account-old')).toEqual({ embeddings: 0 })
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 8').get()).toEqual({
      name: 'embeddings_capability',
    })
    raw.close()
  })

  it('applies all migrations to a fresh D1 database and persists explicit embeddings capabilities', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, embeddings,
        enabled, created_at_ms, updated_at_ms
      ) VALUES ('model-embed', 'openai', 'embed-public', 'embed-upstream', 'both', 1, 1, 1, 1);
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
      ) VALUES (
        'account-embed', 'openai', 'embed', 'secret-embed', 1, 1,
        1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
      );
      INSERT INTO account_models (
        account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
      ) VALUES ('account-embed', 'model-embed', 0, 0, 1, 1, 1);
    `)

    expect(raw.prepare('SELECT embeddings FROM models WHERE id = ?').get('model-embed')).toEqual({ embeddings: 1 })
    expect(raw.prepare('SELECT embeddings FROM account_models WHERE account_id = ?').get('account-embed')).toEqual({ embeddings: 1 })
    const before = raw.prepare('SELECT revision FROM gateway_config_revision WHERE singleton = 1').get() as {
      revision: number
    }
    raw.prepare('UPDATE models SET embeddings = 0, updated_at_ms = 2 WHERE id = ?').run('model-embed')
    raw.prepare(
      'UPDATE account_models SET embeddings = 0, updated_at_ms = 2 WHERE account_id = ? AND model_id = ?',
    ).run('account-embed', 'model-embed')
    expect(raw.prepare('SELECT revision FROM gateway_config_revision WHERE singleton = 1').get()).toEqual({
      revision: before.revision + 2,
    })
    expect(() => raw.prepare('UPDATE models SET embeddings = 2 WHERE id = ?').run('model-embed')).toThrow()
    raw.close()
  })
})
