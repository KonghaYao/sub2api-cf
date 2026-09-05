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

  it('keeps unknown accounts schedulable while excluding unhealthy accounts from every route seam', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version,
        health_status
      ) VALUES (
        'account-2', 'openai', 'unknown-health', 'secret-2', 1, 4,
        1, 1, 'openai', 'https://upstream-two.example/v1', 'bearer', 1,
        'unknown'
      );
      INSERT INTO account_secrets (
        id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
      ) VALUES ('secret-2', 'account-2', 1, 'nonce-2', 'ciphertext-2', 1, 1);
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-2', 'group-1', 1, 1, 1, 1);
      INSERT INTO account_models (
        account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
      ) VALUES ('account-2', 'model-1', 0, 0, 1, 1, 1);
      UPDATE accounts SET health_status = 'unhealthy' WHERE id = 'account-1';
    `)
    const testEnv = { DB: d1 } as Env

    await expect(listModels(testEnv, 'group-1')).resolves.toHaveLength(1)
    const route = await resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-2'])
    await expect(
      getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-1'),
    ).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })
    await expect(
      getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-2'),
    ).resolves.toMatchObject({ account_id: 'account-2' })

    raw.prepare("UPDATE accounts SET health_status = 'unhealthy' WHERE id = ?").run('account-2')
    await expect(listModels(testEnv, 'group-1')).resolves.toEqual([])
    await expect(resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )).rejects.toMatchObject({ status: 503, code: 'no_upstream_accounts' })
    raw.close()
  })
})

describe('gateway repository image routing', () => {
  it('lists, resolves and loads credentials only when model and account image capabilities are enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedImageRoute(raw)
    const testEnv = { DB: d1 } as Env

    await expect(listModels(testEnv, 'group-images')).resolves.toEqual([
      expect.objectContaining({
        model_id: 'model-images',
        public_name: 'gpt-image-public',
        image_generation: 1,
      }),
    ])
    const route = await resolveGatewayRoute(
      testEnv,
      'group-images',
      'gpt-image-public',
      'images',
      'user-1',
    )
    expect(route.upstream_endpoint).toBe('images')
    expect(route.model).toMatchObject({ model_id: 'model-images', image_generation: 1 })
    expect(route.candidates).toEqual([
      expect.objectContaining({
        account_id: 'account-images',
        image_adapter: 'direct_images',
        credential_kind: 'api_key',
      }),
    ])
    await expect(getAccountCredential(
      testEnv,
      'group-images',
      'model-images',
      'images',
      'account-images',
    )).resolves.toMatchObject({
      account_id: 'account-images',
      secret_id: 'secret-images',
      image_adapter: 'direct_images',
      credential_kind: 'api_key',
    })

    raw.prepare(`UPDATE account_models SET image_generation = 0 WHERE account_id = 'account-images'`)
      .run()
    await expect(resolveGatewayRoute(
      testEnv,
      'group-images',
      'gpt-image-public',
      'images',
      'user-1',
    )).rejects.toMatchObject({ status: 503, code: 'no_upstream_accounts' })
    await expect(getAccountCredential(
      testEnv,
      'group-images',
      'model-images',
      'images',
      'account-images',
    )).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })
    raw.close()
  })

  it('does not resolve an image route when only the account capability is enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedImageRoute(raw)
    raw.prepare(`UPDATE models SET image_generation = 0 WHERE id = 'model-images'`).run()

    await expect(resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-images',
      'gpt-image-public',
      'images',
      'user-1',
    )).rejects.toMatchObject({ status: 404, code: 'model_not_found' })
    raw.close()
  })
})

describe('gateway repository provider routing', () => {
  it('keeps primary protocol cohorts separate and falls back from Chat to Responses explicitly', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.prepare("UPDATE models SET endpoint = 'both' WHERE id = ?").run('model-openai')
    const testEnv = { DB: d1 } as Env

    await expect(listModels(testEnv, 'group-openai')).resolves.toEqual([
      expect.objectContaining({ public_name: 'openai-public', endpoint: 'both' }),
    ])
    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'chat_completions',
      'user-1',
    )).rejects.toMatchObject({ status: 503, code: 'no_upstream_accounts' })

    const bridged = await resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'chat_completions',
      'user-1',
      'responses',
    )
    expect(bridged.upstream_endpoint).toBe('responses')
    expect(bridged.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    await expect(getAccountCredential(
      testEnv,
      'group-openai',
      'model-openai',
      'responses',
      'account-openai',
    )).resolves.toMatchObject({ account_id: 'account-openai' })
    await expect(getAccountCredential(
      testEnv,
      'group-openai',
      'model-openai',
      'chat_completions',
      'account-openai',
    )).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })

    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
      ) VALUES (
        'account-chat', 'openai', 'chat-primary', 'secret-chat', 1, 4,
        1, 1, 'openai', 'https://chat.upstream.example/v1', 'bearer', 1
      );
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-chat', 'group-openai', 9, 1, 1, 1);
      INSERT INTO account_models (
        account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
      ) VALUES ('account-chat', 'model-openai', 1, 0, 0, 1, 1);
    `)
    const primary = await resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'chat_completions',
      'user-1',
      'responses',
    )
    expect(primary.upstream_endpoint).toBe('chat_completions')
    expect(primary.candidates.map((candidate) => candidate.account_id)).toEqual(['account-chat'])
    raw.close()
  })

  it.each([
    ['openai', 'openai', 'bearer', '{}'],
    ['anthropic', 'anthropic', 'x-api-key', '{}'],
    ['gemini', 'gemini', 'x-goog-api-key', '{}'],
    ['codex', 'codex', 'bearer', '{"account_id":"org-codex"}'],
  ] as const)(
    'selects %s accounts for a same-platform group and projects the provider contract',
    async (platform, protocol, authScheme, providerConfigJson) => {
      const { raw, d1 } = createSqliteD1()
      applyMigrations(raw)
      seedProviderRoute(raw, platform, protocol, authScheme, providerConfigJson)
      const testEnv = { DB: d1 } as Env

      const route = await resolveGatewayRoute(
        testEnv,
        `group-${platform}`,
        `${platform}-public`,
        'responses',
        'user-1',
      )

      expect(route.model).toMatchObject({
        platform,
        model_id: `model-${platform}`,
        public_name: `${platform}-public`,
      })
      expect(route.candidates).toEqual([
        expect.objectContaining({
          account_id: `account-${platform}`,
          platform,
          protocol,
          auth_scheme: authScheme,
          provider_config: JSON.parse(providerConfigJson),
        }),
      ])
      const credential = await getAccountCredential(
        testEnv,
        `group-${platform}`,
        `model-${platform}`,
        'responses',
        `account-${platform}`,
      )
      expect(credential).toMatchObject({
        account_id: `account-${platform}`,
        platform,
        protocol,
        auth_scheme: authScheme,
        provider_config: JSON.parse(providerConfigJson),
      })
      raw.close()
    },
  )
})

describe('gateway repository channel model policy', () => {
  it('resolves an exact channel alias outside the catalog through its backing model', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES (
        'channel-openai', 'openai', 'customer-alias', 'openai-public',
        0, 0, 0, 1
      );
      INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'alias@example.test', 'Alias user', 1, 1);
      INSERT INTO user_platform_quotas (
        user_id, platform, enabled, daily_limit_micros, weekly_limit_micros,
        monthly_limit_micros, control_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'openai', 1, 1000, 2000, 3000, 7, 1, 1);
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'customer-alias',
      'responses',
      'user-1',
    )

    expect(route.model).toMatchObject({
      model_id: 'model-openai',
      platform: 'openai',
      public_name: 'customer-alias',
      upstream_name: 'openai-upstream',
      price_id: 'price-openai',
      account_cost_base_price_id: 'price-openai',
      account_cost_base_price_version: 1,
      account_cost_base_input_micros_per_million: 1000,
      account_cost_base_output_micros_per_million: 2000,
    })
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    expect(route.platform_quota).toMatchObject({
      platform: 'openai',
      control_version: 7,
      daily_limit_micros: 1000,
      weekly_limit_micros: 2000,
      monthly_limit_micros: 3000,
    })
    await expect(getAccountCredential(
      { DB: d1 } as Env,
      'group-openai',
      route.model.model_id,
      'responses',
      'account-openai',
    )).resolves.toMatchObject({
      account_id: 'account-openai',
      platform: 'openai',
      secret_id: 'secret-openai',
    })
    raw.close()
  })

  it('expands a suffix wildcard channel alias before resolving its backing model', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.prepare("UPDATE models SET upstream_name = 'vendor-sol' WHERE id = 'model-openai'").run()
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES (
        'channel-openai', 'openai', 'customer-*', 'vendor-*',
        1, 1, 0, 1
      );
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'customer-sol',
      'responses',
      'user-1',
    )

    expect(route.model).toMatchObject({
      model_id: 'model-openai',
      public_name: 'customer-sol',
      upstream_name: 'vendor-sol',
    })
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    raw.close()
  })

  it.each(['requested', 'upstream', 'response_model'])(
    'fails closed when an active channel selects unsupported %s billing',
    async (billingSource) => {
      const { raw, d1 } = createSqliteD1()
      applyMigrations(raw)
      seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
      seedChannel(raw, { restrictModels: false })
      raw.prepare('UPDATE channels SET billing_model_source = ? WHERE id = ?')
        .run(billingSource, 'channel-openai')

      await expect(resolveGatewayRoute(
        { DB: d1 } as Env,
        'group-openai',
        'openai-public',
        'responses',
        'user-1',
      )).rejects.toMatchObject({
        status: 409,
        code: 'unsupported_billing_model_source',
      })
      raw.close()
    },
  )

  it('fails closed when a composite channel alias resolves to multiple provider platforms', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.prepare("UPDATE models SET upstream_name = 'shared-upstream' WHERE id = 'model-openai'").run()
    raw.prepare("UPDATE \"groups\" SET platform = 'composite' WHERE id = 'group-openai'").run()
    seedProviderRoute(raw, 'anthropic', 'anthropic', 'x-api-key', '{}')
    raw.prepare("UPDATE models SET upstream_name = 'shared-upstream' WHERE id = 'model-anthropic'").run()
    raw.exec(`
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('group-openai', 'model-anthropic', 1, 1, 1, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES (
        'price-composite-anthropic', 'group-openai', 'model-anthropic', 1, 1,
        3000, 4000, 0, 0, 1, 1, 1
      );
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-anthropic', 'group-openai', 0, 1, 1, 1);
    `)
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('channel-openai', 'openai', 'shared-alias', 'shared-upstream', 0, 0, 0, 1),
        ('channel-openai', 'anthropic', 'shared-alias', 'shared-upstream', 0, 0, 0, 1);
    `)

    await expect(resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'shared-alias',
      'responses',
      'user-1',
    )).rejects.toMatchObject({
      status: 409,
      code: 'ambiguous_model_alias',
    })

    raw.exec(`
      DELETE FROM channel_model_mappings
       WHERE channel_id = 'channel-openai' AND platform = 'openai';
      INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'composite-alias@example.test', 'Composite alias user', 1, 1);
      INSERT INTO user_platform_quotas (
        user_id, platform, enabled, daily_limit_micros, weekly_limit_micros,
        monthly_limit_micros, control_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'anthropic', 1, 1100, 2200, 3300, 9, 1, 1);
    `)
    const resolved = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'shared-alias',
      'responses',
      'user-1',
    )
    expect(resolved).toMatchObject({
      model: {
        model_id: 'model-anthropic',
        platform: 'anthropic',
        public_name: 'shared-alias',
        upstream_name: 'shared-upstream',
      },
      platform_quota: {
        platform: 'anthropic',
        control_version: 9,
        daily_limit_micros: 1100,
      },
    })
    expect(resolved.candidates.map((candidate) => [candidate.account_id, candidate.platform]))
      .toEqual([['account-anthropic', 'anthropic']])
    raw.close()
  })

  it('keeps customer pricing on the requested model and snapshots a uniquely mapped catalog model for account cost', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, embeddings,
        enabled, created_at_ms, updated_at_ms
      ) VALUES (
        'model-account-cost', 'openai', 'account-cost-public', 'exact-upstream',
        'responses', 0, 1, 1, 1
      );
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('group-openai', 'model-account-cost', 1, 1, 1, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES (
        'price-account-cost', 'group-openai', 'model-account-cost', 7, 1,
        3000, 5000, 700, 11, 1, 1, 1
      );
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('channel-openai', 'openai', 'openai-*', 'wildcard-*', 1, 1, 0, 1),
        ('channel-openai', 'openai', 'openai-public', 'exact-upstream', 0, 0, 99, 1);
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )

    expect(route.model).toMatchObject({
      public_name: 'openai-public',
      upstream_name: 'exact-upstream',
      price_id: 'price-openai',
      input_micros_per_million: 1000,
      output_micros_per_million: 2000,
      account_cost_base_price_id: 'price-account-cost',
      account_cost_base_price_version: 7,
      account_cost_base_input_micros_per_million: 3000,
      account_cost_base_output_micros_per_million: 5000,
      account_cost_base_cache_read_micros_per_million: 700,
      account_cost_base_per_request_micros: 11,
    })
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    raw.close()
  })

  it('falls back to requested-model account-cost pricing for unknown or ambiguous mapped targets', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'openai-public', 'unknown-upstream', 0, 0, 0, 1);
    `)
    const testEnv = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      testEnv, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).resolves.toMatchObject({
      model: {
        upstream_name: 'unknown-upstream',
        account_cost_base_price_id: 'price-openai',
        account_cost_base_input_micros_per_million: 1000,
        account_cost_base_output_micros_per_million: 2000,
      },
    })

    raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, embeddings,
        enabled, created_at_ms, updated_at_ms
      ) VALUES
        ('ambiguous-one', 'openai', 'ambiguous-public-one', 'ambiguous-upstream', 'responses', 0, 1, 1, 1),
        ('ambiguous-two', 'openai', 'ambiguous-upstream', 'other-upstream', 'responses', 0, 1, 1, 1);
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES
        ('group-openai', 'ambiguous-one', 1, 1, 1, 1, 1),
        ('group-openai', 'ambiguous-two', 1, 1, 2, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES
        ('ambiguous-price-one', 'group-openai', 'ambiguous-one', 1, 1, 9000, 9000, 0, 0, 1, 1, 1),
        ('ambiguous-price-two', 'group-openai', 'ambiguous-two', 1, 1, 8000, 8000, 0, 0, 1, 1, 1);
      UPDATE channel_model_mappings SET target_pattern = 'ambiguous-upstream';
    `)

    await expect(resolveGatewayRoute(
      testEnv, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).resolves.toMatchObject({
      model: {
        upstream_name: 'ambiguous-upstream',
        account_cost_base_price_id: 'price-openai',
        account_cost_base_input_micros_per_million: 1000,
        account_cost_base_output_micros_per_million: 2000,
      },
    })
    raw.close()
  })

  it('expands the requested suffix into a wildcard mapping target', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'openai-*', 'vendor-*', 1, 1, 0, 1);
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )

    expect(route.model.upstream_name).toBe('vendor-public')
    raw.close()
  })

  it('rejects an unmapped restricted model unless channel pricing explicitly covers it', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: true })
    const testEnv = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).rejects.toMatchObject({ status: 404, code: 'model_not_found' })

    raw.exec(`
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, control_version, created_at_ms, updated_at_ms
      ) VALUES ('channel-price-openai', 'channel-openai', 'openai', 'token', 0, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-price-openai', 'openai-*', 1, 0, 1);
    `)

    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({
      model: { upstream_name: 'openai-upstream', price_id: 'price-openai' },
    })
    raw.close()
  })

  it('allows a mapped restricted model and leaves inactive channels as pass-through', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: true })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'openai-public', 'mapped-upstream', 0, 0, 0, 1);
    `)
    const testEnv = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({ model: { upstream_name: 'mapped-upstream' } })

    raw.prepare("UPDATE channels SET status = 'inactive', updated_at_ms = 2 WHERE id = 'channel-openai'").run()
    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({ model: { upstream_name: 'openai-upstream' } })
    raw.close()
  })

  it('uses the resolved concrete model platform for composite channel mapping and pricing', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.exec(`
      INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'composite@example.test', 'Composite user', 1, 1);
      INSERT INTO user_platform_quotas (
        user_id, platform, enabled, daily_limit_micros, weekly_limit_micros,
        monthly_limit_micros, control_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'openai', 1, 1000, 2000, 3000, 4, 1, 1);
    `)
    raw.prepare("UPDATE \"groups\" SET platform = 'composite' WHERE id = 'group-openai'").run()
    seedProviderRoute(raw, 'anthropic', 'anthropic', 'x-api-key', '{}')
    raw.exec(`
      UPDATE models SET public_name = 'openai-public'
       WHERE id = 'model-anthropic';
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('group-openai', 'model-anthropic', 1, 1, 1, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES (
        'price-composite-anthropic', 'group-openai', 'model-anthropic', 1, 1,
        3000, 4000, 0, 0, 1, 1, 1
      );
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-anthropic', 'group-openai', 0, 1, 1, 1);
    `)
    seedChannel(raw, { restrictModels: true })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('channel-openai', 'composite', 'openai-public', 'wrong-upstream', 0, 0, 0, 1),
        ('channel-openai', 'openai', 'openai-public', 'resolved-upstream', 0, 0, 0, 1);
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, control_version, created_at_ms, updated_at_ms
      ) VALUES ('channel-price-openai', 'channel-openai', 'openai', 'token', 0, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-price-openai', 'openai-public', 0, 0, 1);
    `)
    const testEnv = { DB: d1 } as Env

    const route = await resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )
    expect(route).toMatchObject({
      model: { platform: 'openai', upstream_name: 'resolved-upstream' },
      platform_quota: {
        platform: 'openai', control_version: 4,
        daily_limit_micros: 1000, weekly_limit_micros: 2000, monthly_limit_micros: 3000,
      },
    })
    expect(route.candidates.map((candidate) => [candidate.account_id, candidate.platform]))
      .toEqual([['account-openai', 'openai']])
    await expect(getAccountCredential(
      testEnv,
      'group-openai',
      'model-openai',
      'responses',
      'account-openai',
    )).resolves.toMatchObject({
      account_id: 'account-openai', platform: 'openai', secret_id: 'secret-openai',
    })
    await expect(listModels(testEnv, 'group-openai')).resolves.toEqual([
      expect.objectContaining({ model_id: 'model-openai', platform: 'openai' }),
      expect.objectContaining({ model_id: 'model-anthropic', platform: 'anthropic' }),
    ])

    raw.prepare('DELETE FROM channel_model_mappings WHERE channel_id = ?').run('channel-openai')
    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({
      model: { platform: 'openai', upstream_name: 'openai-upstream' },
    })
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

function seedImageRoute(database: any): void {
  database.exec(`
    INSERT INTO "groups" (
      id, name, platform, enabled, created_at_ms, updated_at_ms
    ) VALUES ('group-images', 'images', 'openai', 1, 1, 1);
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings, image_generation,
      enabled, created_at_ms, updated_at_ms
    ) VALUES (
      'model-images', 'openai', 'gpt-image-public', 'gpt-image-upstream',
      'responses', 0, 1, 1, 1, 1
    );
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES ('group-images', 'model-images', 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES (
      'price-images', 'group-images', 'model-images', 1, 1,
      0, 0, 0, 0, 1, 1, 1
    );
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
    ) VALUES (
      'account-images', 'openai', 'images-primary', 'secret-images', 1, 4,
      1, 1, 'openai', 'https://images.upstream.example/v1', 'bearer', 1
    );
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES ('secret-images', 'account-images', 1, 'nonce', 'ciphertext', 1, 1);
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES ('account-images', 'group-images', 0, 1, 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, image_generation,
      created_at_ms, updated_at_ms
    ) VALUES ('account-images', 'model-images', 0, 0, 0, 1, 1, 1);
  `)
}

function seedProviderRoute(
  database: any,
  platform: 'openai' | 'anthropic' | 'gemini' | 'codex',
  protocol: 'openai' | 'anthropic' | 'gemini' | 'codex',
  authScheme: 'bearer' | 'x-api-key' | 'x-goog-api-key',
  providerConfigJson: string,
): void {
  database.prepare(`
    INSERT INTO "groups" (
      id, name, platform, enabled, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, 1, 1)
  `).run(`group-${platform}`, `group-${platform}`, platform)
  database.prepare(`
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings,
      enabled, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'responses', 0, 1, 1, 1)
  `).run(`model-${platform}`, platform, `${platform}-public`, `${platform}-upstream`)
  database.prepare(`
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, 1, 1, 1)
  `).run(`group-${platform}`, `model-${platform}`)
  database.prepare(`
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES (?, ?, ?, 1, 1, 1000, 2000, 0, 0, 1, 1, 1)
  `).run(`price-${platform}`, `group-${platform}`, `model-${platform}`)
  database.prepare(`
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
      config_version, provider_config_json
    ) VALUES (?, ?, ?, ?, 1, 4, 1, 1, ?, ?, ?, 1, ?)
  `).run(
    `account-${platform}`,
    platform,
    `account-${platform}`,
    `secret-${platform}`,
    protocol,
    `https://${platform}.upstream.example`,
    authScheme,
    providerConfigJson,
  )
  database.prepare(`
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, 'nonce', 'ciphertext', 1, 1)
  `).run(`secret-${platform}`, `account-${platform}`)
  database.prepare(`
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 0, 1, 1, 1)
  `).run(`account-${platform}`, `group-${platform}`)
  database.prepare(`
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 0, 1, 0, 1, 1)
  `).run(`account-${platform}`, `model-${platform}`)
}

function seedChannel(
  database: any,
  options: { restrictModels: boolean },
): void {
  database.prepare(`
    INSERT INTO channels (
      id, name, status, restrict_models, created_at_ms, updated_at_ms
    ) VALUES ('channel-openai', 'OpenAI channel', 'active', ?, 1, 1)
  `).run(options.restrictModels ? 1 : 0)
  database.exec(`
    INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
    VALUES ('channel-openai', 'group-openai', 1);
  `)
}
