import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { getModelPlaza } from '../../src/gateway/model-plaza'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'model-plaza-test-pepper-value-32-bytes'

async function fixture(): Promise<{ raw: any; env: Env; authorization: string }> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
     VALUES ('alice', 'alice@example.test', 'Alice', ?, ?)`,
  ).run(now, now)
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('session-alice', 'family-alice', 'alice', 1, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    now, now + 60_000, now + 600_000,
  )
  seedCatalog(raw)
  return {
    raw,
    authorization: `Bearer ${access}`,
    env: {
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER, DB: d1,
      ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function app(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/model-plaza', getModelPlaza)
  return app
}

function setSettings(raw: any, enabled: boolean, requireAuth: boolean): void {
  raw.prepare(
    `UPDATE system_settings SET public_json = ? WHERE id = 'global'`,
  ).run(JSON.stringify({
    site_name: 'Test', registration_enabled: false, email_verification_enabled: false,
    turnstile_enabled: false, turnstile_site_key: '',
    model_plaza_enabled: enabled,
    model_plaza_require_auth: requireAuth,
    model_plaza_description: 'Prices **include** group multipliers.',
  }))
}

function seedCatalog(raw: any): void {
  raw.exec(`
    INSERT INTO "groups" (
      id, name, description, platform, enabled, sort_order, rate_multiplier_ppm,
      catalog_mode, group_type, is_exclusive, created_at_ms, updated_at_ms
    ) VALUES
      ('public-group', 'Public', 'Visible', 'openai', 1, 1, 1500000, 'allowlist', 'standard', 0, 1, 1),
      ('private-group', 'Private', 'Members', 'openai', 1, 2, 2000000, 'all_routable', 'standard', 1, 1, 1);
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings, enabled,
      created_at_ms, updated_at_ms
    ) VALUES
      ('public-model', 'openai', 'friendly-alias', 'secret-upstream-model', 'both', 1, 1, 1, 1),
      ('private-model', 'openai', 'members-model', 'members-upstream', 'responses', 0, 1, 1, 1);
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
    ) VALUES
      ('public-group', 'public-model', 1, 1, 1, 1, 1),
      ('private-group', 'private-model', 1, 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, retired_at_ms, created_at_ms
    ) VALUES
      ('retired-price', 'public-group', 'public-model', 1, 0, 999999, 999999, 0, 0, 1, 1, 2, 1),
      ('active-price', 'public-group', 'public-model', 2, 1, 2000000, 4000000, 500000, 0, 1, 2, NULL, 2),
      ('private-price', 'private-group', 'private-model', 1, 1, 3000000, 6000000, 0, 0, 1, 1, NULL, 1);
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version,
      health_status
    ) VALUES
      ('account-public', 'openai', 'Internal Public', 'secret-public', 1, 2,
       1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1, 'healthy'),
      ('account-private', 'openai', 'Internal Private', 'secret-private', 1, 2,
       1, 1, 'openai', 'https://private.example/v1', 'bearer', 1, 'unknown');
    INSERT INTO account_groups (account_id, group_id, created_at_ms, updated_at_ms)
    VALUES ('account-public', 'public-group', 1, 1), ('account-private', 'private-group', 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
    ) VALUES
      ('account-public', 'public-model', 1, 1, 1, 1, 1),
      ('account-private', 'private-model', 0, 1, 0, 1, 1);
    INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
    VALUES ('alice', 'private-group', 1);
    INSERT INTO user_group_rate_overrides (
      user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
    ) VALUES ('alice', 'private-group', 1250000, 1, 1);
  `)
}

describe('model plaza HTTP contract', () => {
  it('reflects original-form model routing, whitelist changes and explicit closure without exposing private configuration', async () => {
    const test = await fixture()
    try {
      setSettings(test.raw, true, false)
      test.raw.exec("DELETE FROM account_models WHERE account_id='account-public'")
      const set = (value: unknown) => test.raw.prepare("UPDATE accounts SET ui_config_json=? WHERE id='account-public'").run(JSON.stringify(value))
      const read = async () => (await (await app().request('/model-plaza', undefined, test.env)).json() as any).data
      set({ original_model_routing: true, credentials: { model_mapping: { 'secret-upstream-model': 'mapped-private-name' } } })
      const available = await read()
      expect(available.groups).toHaveLength(1)
      expect(available.groups[0].models[0].name).toBe('friendly-alias')
      expect(JSON.stringify(available)).not.toContain('mapped-private-name')
      set({ original_model_routing: true, credentials: { model_mapping: { excluded: 'other' } } })
      expect((await read()).groups).toEqual([])
      set({ original_model_routing: true, credentials: { model_mapping: {} }, schedulable: false })
      expect((await read()).groups).toEqual([])
      set({ original_model_routing: false, credentials: { model_mapping: {} } })
      expect((await read()).groups).toEqual([])
      set({ original_model_routing: true, credentials: { model_mapping: { 'group-override': 'private-target' } } })
      test.raw.exec("UPDATE group_models SET upstream_name_override='group-override' WHERE group_id='public-group'")
      expect((await read()).groups).toHaveLength(1)
    } finally { test.raw.close() }
  })

  it('fails closed when settings are missing/disabled and requires auth when configured', async () => {
    const test = await fixture()
    expect((await app().request('/model-plaza', undefined, test.env)).status).toBe(404)
    setSettings(test.raw, true, true)
    expect((await app().request('/model-plaza', undefined, test.env)).status).toBe(401)
    expect((await app().request('/model-plaza', {
      headers: { authorization: test.authorization },
    }, test.env)).status).toBe(200)
    test.raw.close()
  })

  it('shows anonymous public catalog with alias and active effective price without secrets', async () => {
    const test = await fixture()
    setSettings(test.raw, true, false)
    const response = await app().request('/model-plaza', undefined, test.env)
    expect(response.status).toBe(200)
    const payload = await response.json() as any
    expect(payload.data.description).toContain('include')
    expect(payload.data.groups).toHaveLength(1)
    expect(payload.data.groups[0]).toMatchObject({
      id: 'public-group', rate_multiplier: 1.5, is_exclusive: false,
      models: [{
        name: 'friendly-alias', platform: 'openai',
        pricing: { input_price: 0.000003, output_price: 0.000006, cache_read_price: 0.00000075 },
      }],
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('secret-upstream-model')
    expect(serialized).not.toContain('Internal Public')
    expect(serialized).not.toContain('upstream.example')
    expect(serialized).not.toContain('999999')
    test.raw.close()
  })

  it('adds explicitly visible groups and the effective user multiplier when logged in', async () => {
    const test = await fixture()
    setSettings(test.raw, true, false)
    const response = await app().request('/model-plaza', {
      headers: { authorization: test.authorization },
    }, test.env)
    const payload = await response.json() as any
    expect(payload.data.groups.map((group: any) => group.id)).toEqual(['public-group', 'private-group'])
    expect(payload.data.groups[1]).toMatchObject({
      user_rate_multiplier: 1.25,
      models: [{ name: 'members-model', pricing: { input_price: 0.00000375 } }],
    })
    test.raw.close()
  })

  it('publishes concrete provider models from a composite group', async () => {
    const test = await fixture()
    setSettings(test.raw, true, false)
    test.raw.prepare("UPDATE \"groups\" SET platform = 'composite' WHERE id = 'public-group'").run()

    const response = await app().request('/model-plaza', undefined, test.env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        groups: [expect.objectContaining({
          id: 'public-group', platform: 'composite',
          models: [expect.objectContaining({ name: 'friendly-alias', platform: 'openai' })],
        })],
      },
    })
    test.raw.close()
  })
})
