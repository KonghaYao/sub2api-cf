import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  getAccountCredential,
  listModels,
  resolveGatewayRoute,
} from '../../src/gateway/repository'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('gateway repository embeddings routing', () => {
  it('lists and resolves an embeddings route only when both model and account capabilities are enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    const testEnv = { DB: d1 } as Env

    const models = await listModels(testEnv, 'group-1')
    expect(models).toEqual([
      expect.objectContaining({
        model_id: 'model-1',
        public_name: 'embed-public',
        upstream_name: 'embed-upstream',
        embeddings: 1,
      }),
    ])

    const route = await resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )
    expect(route.model).toMatchObject({ model_id: 'model-1', embeddings: 1 })
    expect(route.candidates).toEqual([
      expect.objectContaining({ account_id: 'account-1', base_url: 'https://upstream.example/v1' }),
    ])

    const credential = await getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-1')
    expect(credential).toMatchObject({ account_id: 'account-1', secret_id: 'secret-1' })

    raw.prepare('UPDATE account_models SET embeddings = 0, updated_at_ms = 2 WHERE account_id = ? AND model_id = ?')
      .run('account-1', 'model-1')
    await expect(resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )).rejects.toMatchObject({
      status: 503,
      code: 'no_upstream_accounts',
    })
    await expect(
      getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-1'),
    ).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })
    raw.close()
  })

  it('does not resolve embeddings when only the account capability is enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    raw.prepare('UPDATE models SET embeddings = 0, updated_at_ms = 2 WHERE id = ?').run('model-1')

    await expect(
      resolveGatewayRoute(
        { DB: d1 } as Env,
        'group-1',
        'embed-public',
        'embeddings',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 404, code: 'model_not_found' })
    raw.close()
  })
})

function seedEmbeddingRoute(database: any): void {
  database.exec(`
    INSERT INTO "groups" (
      id, name, platform, enabled, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'default', 'openai', 1, 1, 1);
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings,
      enabled, created_at_ms, updated_at_ms
    ) VALUES ('model-1', 'openai', 'embed-public', 'embed-upstream', 'both', 1, 1, 1, 1);
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'model-1', 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES ('price-1', 'group-1', 'model-1', 1, 1, 1000, 0, 0, 0, 1, 1, 1);
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
    ) VALUES (
      'account-1', 'openai', 'primary', 'secret-1', 1, 4,
      1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
    );
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES ('secret-1', 'account-1', 1, 'nonce', 'ciphertext', 1, 1);
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'group-1', 0, 1, 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'model-1', 0, 0, 1, 1, 1);
  `)
}
