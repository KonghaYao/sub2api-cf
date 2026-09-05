import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('composite group platform integrity migration', () => {
  it('allows mixed concrete providers only through composite groups', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw)
      raw.exec(`
        INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
        VALUES
          ('group-composite', 'Composite', 'composite', 1, 1),
          ('group-openai-only', 'OpenAI only', 'openai', 1, 1);
        INSERT INTO models (
          id, platform, public_name, upstream_name, endpoint, created_at_ms, updated_at_ms
        ) VALUES
          ('model-openai', 'openai', 'public-openai', 'upstream-openai', 'responses', 1, 1),
          ('model-anthropic', 'anthropic', 'public-anthropic', 'upstream-anthropic', 'responses', 1, 1);
        INSERT INTO accounts (
          id, platform, name, credential_ref, protocol, auth_scheme, created_at_ms, updated_at_ms
        ) VALUES
          ('account-openai', 'openai', 'OpenAI', 'secret-openai', 'openai', 'bearer', 1, 1),
          ('account-anthropic', 'anthropic', 'Anthropic', 'secret-anthropic', 'anthropic', 'x-api-key', 1, 1);
        INSERT INTO group_models (group_id, model_id, created_at_ms, updated_at_ms)
        VALUES
          ('group-composite', 'model-openai', 1, 1),
          ('group-composite', 'model-anthropic', 1, 1);
        INSERT INTO account_groups (account_id, group_id, created_at_ms, updated_at_ms)
        VALUES
          ('account-openai', 'group-composite', 1, 1),
          ('account-anthropic', 'group-composite', 1, 1);
        INSERT INTO account_models (account_id, model_id, created_at_ms, updated_at_ms)
        VALUES
          ('account-openai', 'model-openai', 1, 1),
          ('account-anthropic', 'model-anthropic', 1, 1);
      `)

      expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 52').get())
        .toEqual({ name: 'composite_group_platform' })
      expect(() => raw.exec(`
        INSERT INTO group_models (group_id, model_id, created_at_ms, updated_at_ms)
        VALUES ('group-openai-only', 'model-anthropic', 1, 1)
      `)).toThrow(/invalid_group_model/)
      expect(() => raw.exec(`
        INSERT INTO account_groups (account_id, group_id, created_at_ms, updated_at_ms)
        VALUES ('account-anthropic', 'group-openai-only', 1, 1)
      `)).toThrow(/invalid_account_group/)
      expect(() => raw.prepare(
        "UPDATE \"groups\" SET platform = 'openai' WHERE id = 'group-composite'",
      ).run()).toThrow(/invalid_group_platform/)
      expect(() => raw.exec(`
        INSERT INTO account_models (account_id, model_id, created_at_ms, updated_at_ms)
        VALUES ('account-openai', 'model-anthropic', 1, 1)
      `)).toThrow(/invalid_account_model/)
    } finally {
      raw.close()
    }
  })
})
