import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import {
  authenticateGatewayRequest,
  resolveGatewayRoute,
} from '../../src/gateway/repository'
import { calculateCost } from '../../src/gateway/usage'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'gateway-entitlement-test-pepper-value-32-bytes'
const RAW_KEY = 'sk-sub2api-entitlement-test-key'

async function fixture(): Promise<{ raw: any; env: Env }> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, balance_micros, created_at_ms, updated_at_ms
     ) VALUES ('alice', 'alice@example.test', 'Alice', 10000000, ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, rate_multiplier_ppm,
       group_type, is_exclusive, created_at_ms, updated_at_ms
     ) VALUES ('group-1', 'Group 1', 'openai', 1, 1250000, 'standard', 0, ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO api_keys (
       id, user_id, key_hash, name, enabled, created_at_ms, updated_at_ms,
       group_id, key_prefix, auth_version
     ) VALUES ('key-1', 'alice', ?, 'Gateway key', 1, ?, ?, 'group-1', 'sk-sub2api-enti', 1)`,
  ).run(await apiKeyDigest(RAW_KEY, PEPPER), now, now)
  return {
    raw,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function gatewayRequest(): Request {
  return new Request('https://gateway.test/v1/models', {
    headers: { authorization: `Bearer ${RAW_KEY}` },
  })
}

function seedRoute(raw: any): void {
  raw.exec(`
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, enabled, created_at_ms, updated_at_ms
    ) VALUES ('model-1', 'openai', 'gpt-public', 'gpt-upstream', 'responses', 1, 1, 1);
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'model-1', 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES ('price-1', 'group-1', 'model-1', 1, 1, 2000000, 4000000, 0, 100000, 1, 1, 1);
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
    ) VALUES (
      'account-1', 'openai', 'Primary', 'secret-1', 1, 4,
      1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
    );
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'group-1', 0, 1, 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'model-1', 0, 1, 0, 1, 1);
  `)
}

describe('gateway entitlement and effective billing', () => {
  it('revalidates public, permission, and active-subscription access on every authentication', async () => {
    const test = await fixture()
    const now = Date.now()

    await expect(authenticateGatewayRequest(gatewayRequest(), test.env)).resolves.toMatchObject({
      user_id: 'alice',
      group_id: 'group-1',
    })

    test.raw.prepare(
      `UPDATE "groups" SET is_exclusive = 1, updated_at_ms = ? WHERE id = 'group-1'`,
    ).run(now)
    await expect(authenticateGatewayRequest(gatewayRequest(), test.env)).rejects.toMatchObject({
      status: 403,
      code: 'group_access_denied',
    })

    test.raw.prepare(
      `INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
       VALUES ('alice', 'group-1', ?)`,
    ).run(now)
    await expect(authenticateGatewayRequest(gatewayRequest(), test.env)).resolves.toMatchObject({
      billing: { type: 'balance' },
    })
    test.raw.prepare(
      `DELETE FROM user_group_permissions WHERE user_id = 'alice' AND group_id = 'group-1'`,
    ).run()
    await expect(authenticateGatewayRequest(gatewayRequest(), test.env)).rejects.toMatchObject({
      code: 'group_access_denied',
    })

    test.raw.prepare(
      `UPDATE "groups"
          SET group_type = 'subscription', is_exclusive = 0, updated_at_ms = ?
        WHERE id = 'group-1'`,
    ).run(now)
    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES ('subscription-1', 'alice', 'group-1', 'active', ?, ?,
                 'admin', 'grant-1', ?, ?)`,
    ).run(now - 60_000, now + 60_000, now, now)
    await expect(authenticateGatewayRequest(gatewayRequest(), test.env)).resolves.toMatchObject({
      billing: {
        type: 'subscription',
        subscription_id: 'subscription-1',
        starts_at_ms: now - 60_000,
        expires_at_ms: now + 60_000,
      },
    })

    test.raw.prepare(
      `UPDATE user_subscriptions SET expires_at_ms = ?, updated_at_ms = ? WHERE id = 'subscription-1'`,
    ).run(now - 1, now)
    await expect(authenticateGatewayRequest(gatewayRequest(), test.env)).rejects.toMatchObject({
      code: 'group_access_denied',
    })
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET status = 'revoked', expires_at_ms = ?, updated_at_ms = ?
        WHERE id = 'subscription-1'`,
    ).run(now + 60_000, now)
    await expect(authenticateGatewayRequest(gatewayRequest(), test.env)).rejects.toMatchObject({
      code: 'group_access_denied',
    })
  })

  it('uses the user override for route cost and reports it as the effective billing rate', async () => {
    const test = await fixture()
    seedRoute(test.raw)
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO user_group_rate_overrides (
         user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
       ) VALUES ('alice', 'group-1', 800000, ?, ?)`,
    ).run(now, now)

    const principal = await authenticateGatewayRequest(gatewayRequest(), test.env)
    const route = await resolveGatewayRoute(
      test.env,
      principal.group_id,
      'gpt-public',
      'responses',
      principal.user_id,
    )
    expect(route.model.rate_multiplier_ppm).toBe(800_000)
    expect(calculateCost(route.model, {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      cache_read_tokens: 0,
      estimated: false,
    })).toMatchObject({
      input_amount_micros: 1_600_000,
      output_amount_micros: 1_600_000,
      base_amount_micros: 80_000,
      amount_micros: 3_280_000,
    })

    const response = await createApp().request('/v1/sub2api/billing', {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      group_rate_multiplier: 1.25,
      user_rate_multiplier: 0.8,
      resolved_rate_multiplier: 0.8,
      effective_rate_multiplier: 0.8,
      group_rate_multiplier_ppm: 1_250_000,
      effective_rate_multiplier_ppm: 800_000,
    })
  })

  it('uses an enabled composite route to constrain provider selection and rewrite the upstream model', async () => {
    const test = await fixture()
    seedRoute(test.raw)
    test.raw.prepare(`UPDATE "groups" SET platform = 'composite' WHERE id = 'group-1'`).run()
    test.raw.prepare(`INSERT INTO composite_model_routes (
      id, group_id, public_model, match_type, target_platform, upstream_model, endpoint, priority, enabled, notes, created_at_ms, updated_at_ms
    ) VALUES ('route-1', 'group-1', 'gpt-public', 'exact', 'openai', 'gpt-5-routed', 'responses', 10, 1, '', 1, 1)`).run()
    const route = await resolveGatewayRoute(test.env, 'group-1', 'gpt-public', 'responses', 'alice')
    expect(route.model).toMatchObject({ platform: 'openai', upstream_name: 'gpt-5-routed' })
    expect(route.candidates).toHaveLength(1)
    expect(route.candidates[0]).toMatchObject({ platform: 'openai', account_id: 'account-1' })
  })
})
