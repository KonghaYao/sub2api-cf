import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  batchDeleteAdminAccounts,
  createAdminAccount,
  duplicateAdminAccount,
  getAdminAccount,
  listAdminAccounts,
  putAdminAccountModelCapability,
  refreshAdminAccountCredentials,
  testAdminAccount,
  updateAdminAccount,
} from '../../src/control/accounts'
import type { Env } from '../../src/env'
import { decryptCredential } from '../../src/gateway/crypto'
import { credentialAad } from '../../src/gateway/repository'
import type { ProviderPlatform } from '../../src/gateway/providers'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const MASTER_KEY = 'm'.repeat(32)

interface Fixture {
  raw: any
  env: Env
  app: Hono<{ Bindings: Env }>
}

function fixture(): Fixture {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const app = new Hono<{ Bindings: Env }>()
  app.get('/accounts', listAdminAccounts)
  app.post('/accounts', createAdminAccount)
  app.post('/accounts/:id/duplicate', duplicateAdminAccount)
  app.post('/accounts/batch-delete', batchDeleteAdminAccounts)
  app.post('/accounts/:id/refresh', refreshAdminAccountCredentials)
  app.get('/accounts/:id', getAdminAccount)
  app.put('/accounts/:id', updateAdminAccount)
  app.put('/accounts/:id/models/:model_id', putAdminAccountModelCapability)
  app.post('/accounts/:id/test', testAdminAccount)
  return {
    raw,
    app,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      CREDENTIALS_MASTER_KEY: MASTER_KEY,
      ASSETS: {} as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
      AUTH_RATE_LIMIT: {} as DurableObjectNamespace,
      API_KEY_LIMIT_STATE: {} as DurableObjectNamespace,
    },
  }
}

const providerInputs = {
  openai: {
    protocol: 'openai',
    auth_scheme: 'bearer',
    base_url: 'https://api.openai.test/v1',
  },
  anthropic: {
    protocol: 'anthropic',
    auth_scheme: 'x-api-key',
    base_url: 'https://api.anthropic.test',
  },
  gemini: {
    protocol: 'gemini',
    auth_scheme: 'x-goog-api-key',
    base_url: 'https://generativelanguage.test',
  },
  codex: {
    protocol: 'codex',
    auth_scheme: 'bearer',
    base_url: 'https://chatgpt.test',
    provider_config: { account_id: 'workspace_123' },
  },
} as const

async function createProvider(test: Fixture, platform: ProviderPlatform): Promise<any> {
  const response = await test.app.request('/accounts', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `provider-${platform}-create`,
    },
    body: JSON.stringify({
      name: `${platform}-primary`,
      platform,
      ...providerInputs[platform],
      api_key: `${platform}-secret-value`,
      max_concurrency: 3,
    }),
  }, test.env)
  const payload = await response.json() as any
  expect(response.status, JSON.stringify(payload)).toBe(201)
  return payload.data
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('admin provider account control plane on D1', () => {
  it('creates, reads and updates the persisted image adapter and credential kind', async () => {
    const test = fixture()
    const createResponse = await test.app.request('/accounts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'image-adapter-account-create',
      },
      body: JSON.stringify({
        name: 'responses-setup-token',
        platform: 'codex',
        protocol: 'codex',
        base_url: 'https://chatgpt.test',
        auth_scheme: 'bearer',
        provider_config: { account_id: 'workspace_123' },
        api_key: 'oauth-access-token',
        image_adapter: 'responses_image_tool',
        credential_kind: 'setup_token',
      }),
    }, test.env)
    const created = await createResponse.json() as any
    expect(createResponse.status, JSON.stringify(created)).toBe(201)
    expect(created.data).toMatchObject({
      image_adapter: 'responses_image_tool',
      credential_kind: 'setup_token',
      control_version: 0,
    })

    const detailResponse = await test.app.request(`/accounts/${created.data.id}`, {}, test.env)
    const detail = await detailResponse.json() as any
    expect(detailResponse.status, JSON.stringify(detail)).toBe(200)
    expect(detail.data).toMatchObject({
      image_adapter: 'responses_image_tool',
      credential_kind: 'setup_token',
    })

    const updateResponse = await test.app.request(`/accounts/${created.data.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-match': '"0"',
      },
      body: JSON.stringify({
        credential_kind: 'oauth',
      }),
    }, test.env)
    const updated = await updateResponse.json() as any
    expect(updateResponse.status, JSON.stringify(updated)).toBe(200)
    expect(updated.data).toMatchObject({
      image_adapter: 'responses_image_tool',
      credential_kind: 'oauth',
      config_version: 2,
      control_version: 1,
    })
  })

  it.each([
    [{ image_adapter: 'responses_image_tool', credential_kind: 'setup_token' }],
    [{ platform: 'codex', protocol: 'codex', base_url: 'https://chatgpt.test',
      provider_config: { account_id: 'workspace_123' }, image_adapter: 'direct_images', credential_kind: 'api_key' }],
  ])('rejects an account execution tuple that no runtime executor can serve', async (execution) => {
    const test = fixture()
    const response = await test.app.request('/accounts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `invalid-execution-${JSON.stringify(execution)}`,
      },
      body: JSON.stringify({
        name: 'invalid-execution',
        base_url: 'https://api.openai.test/v1',
        api_key: 'not-persisted-secret',
        ...execution,
      }),
    }, test.env)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'account_execution_mismatch' })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 0 })
  })

  it('validates a partial discriminator update against the persisted execution tuple', async () => {
    const test = fixture()
    const codex = await createProvider(test, 'codex')
    const response = await test.app.request(`/accounts/${codex.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '"0"' },
      body: JSON.stringify({ credential_kind: 'api_key' }),
    }, test.env)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'account_execution_mismatch' })
    const persisted = await test.app.request(`/accounts/${codex.id}`, {}, test.env)
    await expect(persisted.json()).resolves.toMatchObject({ data: { credential_kind: 'oauth' } })
  })

  it('creates, reads and updates an image-only model capability', async () => {
    const test = fixture()
    test.raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, image_generation,
        enabled, created_at_ms, updated_at_ms
      ) VALUES (
        'image-model', 'openai', 'gpt-image-public', 'gpt-image-upstream',
        'responses', 1, 1, 1, 1
      );
    `)
    const createResponse = await test.app.request('/accounts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'image-account-create',
      },
      body: JSON.stringify({
        name: 'image-primary',
        base_url: 'https://api.openai.test/v1',
        api_key: 'image-secret',
        model_capabilities: [{
          model_id: 'image-model',
          chat_completions: false,
          responses: false,
          image_generation: true,
        }],
      }),
    }, test.env)
    const created = await createResponse.json() as any
    expect(createResponse.status, JSON.stringify(created)).toBe(201)
    expect(created.data.model_capabilities).toEqual([
      expect.objectContaining({
        model_id: 'image-model',
        chat_completions: false,
        responses: false,
        embeddings: false,
        image_generation: true,
      }),
    ])
    expect(test.raw.prepare(`
      SELECT image_generation FROM account_models
       WHERE account_id = ? AND model_id = 'image-model'
    `).get(created.data.id)).toEqual({ image_generation: 1 })

    const updateResponse = await test.app.request(
      `/accounts/${created.data.id}/models/image-model`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': '"0"' },
        body: JSON.stringify({
          chat_completions: false,
          responses: false,
          embeddings: true,
          image_generation: false,
        }),
      },
      test.env,
    )
    const updated = await updateResponse.json() as any
    expect(updateResponse.status, JSON.stringify(updated)).toBe(200)
    expect(updated.data.model_capabilities).toEqual([
      expect.objectContaining({
        model_id: 'image-model',
        embeddings: true,
        image_generation: false,
      }),
    ])
  })

  it('persists all provider contracts with encrypted credentials and safe projections', async () => {
    const test = fixture()
    const created = await Promise.all(
      (Object.keys(providerInputs) as ProviderPlatform[]).map((platform) => createProvider(test, platform)),
    )

    for (const account of created) {
      const serialized = JSON.stringify(account)
      expect(serialized).not.toContain(`${account.platform}-secret-value`)
      expect(account).toMatchObject({
        platform: account.platform,
        protocol: providerInputs[account.platform as ProviderPlatform].protocol,
        auth_scheme: providerInputs[account.platform as ProviderPlatform].auth_scheme,
        credentials_status: { has_api_key: true },
      })
      const row = test.raw.prepare(
        `SELECT a.id, a.credential_ref, a.provider_config_json,
                s.key_version, s.nonce_b64, s.ciphertext_b64
           FROM accounts a JOIN account_secrets s ON s.id = a.credential_ref
          WHERE a.id = ?`,
      ).get(account.id)
      expect(JSON.stringify(row)).not.toContain(`${account.platform}-secret-value`)
      await expect(decryptCredential(
        row.nonce_b64,
        row.ciphertext_b64,
        MASTER_KEY,
        credentialAad('test', row.id, row.credential_ref, row.key_version),
      )).resolves.toEqual({ api_key: `${account.platform}-secret-value` })
    }

    const list = await test.app.request('/accounts?platform=anthropic', {}, test.env)
    await expect(list.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ platform: 'anthropic' }] },
    })
    const all = await test.app.request('/accounts', {}, test.env)
    await expect(all.json()).resolves.toMatchObject({ data: { total: 4 } })
    expect(created.find((account) => account.platform === 'codex')).toMatchObject({
      provider_config: { account_id: 'workspace_123' },
    })
  })

  it('round-trips the original account form without persisting or projecting secrets', async () => {
    const test = fixture()
    test.raw.exec(`
      INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
      VALUES ('legacy-group', 'Legacy group', 'openai', 1, 1, 1);
    `)
    const originalCredentials = {
      base_url: 'https://legacy-openai.test/v1',
      api_key: 'legacy-api-secret',
      access_token: 'legacy-access-secret',
      refresh_token: 'legacy-refresh-secret',
      cookie: 'legacy-cookie-secret',
      model_mapping: { public: 'upstream' },
      pool_mode: true,
    }
    const createResponse = await test.app.request('/accounts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'original-form-round-trip',
      },
      body: JSON.stringify({
        name: 'Original form',
        notes: 'keep this note',
        platform: 'openai',
        type: 'apikey',
        credentials: originalCredentials,
        extra: { web_search_emulation: 'force_off', labels: ['one'] },
        proxy_id: null,
        concurrency: 7,
        load_factor: 1.25,
        priority: 9,
        rate_multiplier: 1.5,
        group_ids: ['legacy-group'],
        expires_at: 1_900_000_000,
        auto_pause_on_expired: true,
        upstream_billing_probe_enabled: false,
      }),
    }, test.env)
    const created = await createResponse.json() as any
    expect(createResponse.status, JSON.stringify(created)).toBe(201)
    expect(created.data).toMatchObject({
      name: 'Original form',
      notes: 'keep this note',
      platform: 'openai',
      type: 'apikey',
      credentials: {
        base_url: 'https://legacy-openai.test/v1',
        model_mapping: { public: 'upstream' },
        pool_mode: true,
      },
      credentials_status: {
        has_api_key: true,
        has_access_token: true,
        has_refresh_token: true,
        has_cookie: true,
      },
      extra: { web_search_emulation: 'force_off', labels: ['one'] },
      proxy_id: null,
      concurrency: 7,
      load_factor: 1.25,
      priority: 9,
      rate_multiplier: 1.5,
      group_ids: ['legacy-group'],
      expires_at: 1_900_000_000,
      auto_pause_on_expired: true,
      upstream_billing_probe_enabled: false,
      status: 'active',
      control_version: 0,
    })
    const createdSerialized = JSON.stringify(created)
    for (const secret of ['legacy-api-secret', 'legacy-access-secret', 'legacy-refresh-secret', 'legacy-cookie-secret']) {
      expect(createdSerialized).not.toContain(secret)
    }

    const persisted = test.raw.prepare(
      `SELECT a.*, s.key_version, s.nonce_b64, s.ciphertext_b64
         FROM accounts a JOIN account_secrets s ON s.id = a.credential_ref
        WHERE a.id = ?`,
    ).get(created.data.id)
    const persistedSerialized = JSON.stringify(persisted)
    for (const secret of ['legacy-api-secret', 'legacy-access-secret', 'legacy-refresh-secret', 'legacy-cookie-secret']) {
      expect(persistedSerialized).not.toContain(secret)
    }
    const persistedUiConfig = String(persisted.ui_config_json)
    expect(persistedUiConfig).toContain('model_mapping')
    for (const secret of ['legacy-api-secret', 'legacy-access-secret', 'legacy-refresh-secret', 'legacy-cookie-secret']) {
      expect(persistedUiConfig).not.toContain(secret)
    }
    expect(persisted.max_concurrency).toBe(7)
    expect(persisted.billing_rate_multiplier_ppm).toBe(1_500_000)
    await expect(decryptCredential(
      persisted.nonce_b64,
      persisted.ciphertext_b64,
      MASTER_KEY,
      credentialAad('test', persisted.id, persisted.credential_ref, persisted.key_version),
    )).resolves.toMatchObject(originalCredentials)

    const detailResponse = await test.app.request(`/accounts/${created.data.id}`, {}, test.env)
    const detail = await detailResponse.json() as any
    expect(detailResponse.status, JSON.stringify(detail)).toBe(200)
    expect(detail).toMatchObject({ data: created.data })
    const listResponse = await test.app.request('/accounts?search=Original&page=1&page_size=20', {}, test.env)
    expect(listResponse.status).toBe(200)
    const listed = await listResponse.json() as any
    expect(listed.data).toMatchObject({ total: 1, page: 1 })
    expect(listed.data.items).toHaveLength(1)
    expect(listed.data.items[0]).toMatchObject({
      id: created.data.id,
      credentials: created.data.credentials,
      credentials_status: created.data.credentials_status,
      group_ids: created.data.group_ids,
    })

    const updateResponse = await test.app.request(`/accounts/${created.data.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '"0"' },
      body: JSON.stringify({
        notes: '',
        credentials: {
          access_token: null,
          refresh_token: '',
          cookie: null,
          model_mapping: {},
          pool_mode: false,
        },
        extra: {},
        proxy_id: null,
        concurrency: 11,
        load_factor: null,
        priority: 0,
        group_ids: [],
        expires_at: null,
        auto_pause_on_expired: false,
        upstream_billing_probe_enabled: false,
        upstream_billing_rate_sync_enabled: false,
        status: 'inactive',
      }),
    }, test.env)
    const updated = await updateResponse.json() as any
    expect(updateResponse.status, JSON.stringify(updated)).toBe(200)
    expect(updated.data).toMatchObject({
      notes: '',
      credentials: {
        base_url: 'https://legacy-openai.test/v1',
        model_mapping: {},
        pool_mode: false,
      },
      credentials_status: {
        has_api_key: true,
        has_access_token: false,
        has_refresh_token: false,
        has_cookie: false,
      },
      extra: {},
      concurrency: 11,
      load_factor: null,
      priority: 0,
      group_ids: [],
      expires_at: null,
      auto_pause_on_expired: false,
      upstream_billing_probe_enabled: false,
      upstream_billing_rate_sync_enabled: false,
      status: 'inactive',
      control_version: 1,
    })
    expect(JSON.stringify(updated)).not.toContain('legacy-access-secret')
    const updatedDetail = await test.app.request(`/accounts/${created.data.id}`, {}, test.env)
    await expect(updatedDetail.json()).resolves.toMatchObject({ data: updated.data })

    const stale = await test.app.request(`/accounts/${created.data.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '"0"' },
      body: JSON.stringify({ notes: 'stale' }),
    }, test.env)
    expect(stale.status).toBe(412)
    await expect(stale.json()).resolves.toMatchObject({ code: 'account_version_conflict' })
  })

  it('filters account lists by group binding and applies stable allowlisted sorting', async () => {
    const test = fixture()
    const ungrouped = await createProvider(test, 'openai')
    const linkedResponse = await test.app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'linked-openai-create' },
      body: JSON.stringify({
        name: 'Zulu linked account',
        base_url: 'https://api.openai.test/v1',
        api_key: 'linked-openai-secret',
      }),
    }, test.env)
    expect(linkedResponse.status).toBe(201)
    const linked = (await linkedResponse.json() as any).data
    test.raw.exec(`
      INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
      VALUES ('group-plan', 'Subscription Plan', 'openai', 1, 1, 1);
      INSERT INTO account_groups (account_id, group_id, priority, weight, created_at_ms, updated_at_ms)
      VALUES ('${linked.id}', 'group-plan', 0, 1, 1, 1);
    `)

    const bound = await test.app.request(
      '/accounts?group=group-plan&sort_by=name&sort_order=asc', {}, test.env,
    )
    expect(bound.status, await bound.clone().text()).toBe(200)
    await expect(bound.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ id: linked.id, name: 'Zulu linked account' }] },
    })

    const withoutGroup = await test.app.request(
      '/accounts?group=ungrouped&sort_by=name&sort_order=asc', {}, test.env,
    )
    expect(withoutGroup.status, await withoutGroup.clone().text()).toBe(200)
    await expect(withoutGroup.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ id: ungrouped.id }] },
    })

    const invalidSort = await test.app.request('/accounts?sort_by=sql_expression', {}, test.env)
    expect(invalidSort.status).toBe(400)
    await expect(invalidSort.json()).resolves.toMatchObject({ code: 'invalid_sort_by' })
  })

  it('filters stored account type and privacy before pagination and sorts UI fields', async () => {
    const test = fixture()
    const first = await createProvider(test, 'openai')
    const second = await createProvider(test, 'anthropic')
    test.raw.prepare('UPDATE accounts SET ui_config_json = ? WHERE id = ?').run(
      JSON.stringify({ priority: 20, extra: { privacy_mode: 'training_off' }, expires_at: 200 }), first.id,
    )
    test.raw.prepare('UPDATE accounts SET ui_config_json = ? WHERE id = ?').run(
      JSON.stringify({ priority: 10, extra: { privacy_mode: '  ' }, expires_at: 100 }), second.id,
    )
    const filtered = await test.app.request(
      '/accounts?type=apikey&privacy_mode=training_off&page_size=1&sort_by=priority', {}, test.env,
    )
    expect(filtered.status).toBe(200)
    await expect(filtered.json()).resolves.toMatchObject({
      data: { total: 1, pages: 1, items: [{ id: first.id }] },
    })
    const unset = await test.app.request('/accounts?privacy_mode=__unset__', {}, test.env)
    await expect(unset.json()).resolves.toMatchObject({ data: { total: 1, items: [{ id: second.id }] } })
    const oauth = await test.app.request('/accounts?type=oauth', {}, test.env)
    await expect(oauth.json()).resolves.toMatchObject({ data: { total: 0, items: [] } })
    for (const sort of ['priority', 'expires_at']) {
      const sorted = await test.app.request(`/accounts?sort_by=${sort}&sort_order=asc&page_size=1`, {}, test.env)
      await expect(sorted.json()).resolves.toMatchObject({
        data: { total: 2, items: [{ id: second.id }] },
      })
    }
    const invalid = await test.app.request('/accounts?type=invalid', {}, test.env)
    expect(invalid.status).toBe(400)
  })

  it('accepts the original account page empty filter values', async () => {
    const test = fixture()
    const account = await createProvider(test, 'openai')

    const response = await test.app.request(
      '/accounts?page=1&page_size=20&platform=&type=&status=&privacy_mode=&group=&search=&include_scheduler_score=0&sort_by=name&sort_order=asc&lite=1',
      {},
      test.env,
    )

    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ id: account.id }] },
    })
  })

  it('keeps legacy OpenAI defaults and rotates provider credentials with versioned AAD', async () => {
    const test = fixture()
    const legacyResponse = await test.app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'legacy-openai-create' },
      body: JSON.stringify({
        name: 'legacy-openai',
        base_url: 'https://api.openai.test/v1',
        api_key: 'legacy-openai-secret',
      }),
    }, test.env)
    const legacy = (await legacyResponse.json() as any).data
    expect(legacyResponse.status).toBe(201)
    expect(legacy).toMatchObject({
      platform: 'openai', protocol: 'openai', auth_scheme: 'bearer', provider_config: {},
      image_adapter: 'direct_images', credential_kind: 'api_key',
    })

    const codex = await createProvider(test, 'codex')
    expect(codex).toMatchObject({
      image_adapter: 'responses_image_tool', credential_kind: 'oauth',
    })
    const response = await test.app.request(`/accounts/${codex.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({
        api_key: 'rotated-codex-secret',
        provider_config: { account_id: 'workspace_456' },
      }),
    }, test.env)
    const updated = (await response.json() as any).data
    expect(response.status).toBe(200)
    expect(updated).toMatchObject({
      platform: 'codex',
      provider_config: { account_id: 'workspace_456' },
      credential_key_version: 2,
      config_version: 2,
      control_version: 1,
    })
    expect(JSON.stringify(updated)).not.toContain('rotated-codex-secret')

    const secret = test.raw.prepare(
      `SELECT a.id, a.credential_ref, s.key_version, s.nonce_b64, s.ciphertext_b64
         FROM accounts a JOIN account_secrets s ON s.id = a.credential_ref
        WHERE a.id = ?`,
    ).get(codex.id)
    await expect(decryptCredential(
      secret.nonce_b64,
      secret.ciphertext_b64,
      MASTER_KEY,
      credentialAad('test', secret.id, secret.credential_ref, 2),
    )).resolves.toEqual({ api_key: 'rotated-codex-secret' })
  })

  it('duplicates an account transactionally and replays the same idempotent response', async () => {
    const test = fixture()
    const source = await createProvider(test, 'openai')
    const request = () => test.app.request(`/accounts/${source.id}/duplicate`, {
      method: 'POST', headers: { 'idempotency-key': 'duplicate-openai-provider' },
    }, test.env)
    const first = await request()
    const duplicated = (await first.json() as any).data
    expect(first.status).toBe(201)
    expect(duplicated).toMatchObject({ platform: 'openai', provider_config: {}, group_links: [], model_capabilities: [] })
    expect(duplicated.id).not.toBe(source.id)
    expect(duplicated.name).toContain('copy')
    const replay = await request()
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ data: { id: duplicated.id } })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 2 })
  })

  it('deletes a versioned account batch atomically and replays its idempotent result', async () => {
    const test = fixture()
    const first = await createProvider(test, 'openai')
    const second = await createProvider(test, 'anthropic')
    test.raw.prepare(
      `INSERT INTO account_synthetic_probe_jobs (
        id, account_id, model_id, capability, generation, account_config_version,
        account_control_version, credential_ref, account_model_control_version,
        model_updated_at_ms, upstream_model, requested_by_user_id, status,
        next_dispatch_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'chat_completions', 1, 1, 0, ?, 0, 1, ?, 'admin', 'queued', 1, 1, 1)`,
    ).run('synthetic-delete-job', first.id, 'model', 'secret', 'model')
    const request = () => test.app.request('/accounts/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'atomic-account-batch-delete' },
      body: JSON.stringify({ accounts: [
        { id: second.id, expected_control_version: 0 },
        { id: first.id, expected_control_version: 0 },
        { id: first.id, expected_control_version: 0 },
      ] }),
    }, test.env)
    const firstResponse = await request()
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200)
    await expect(firstResponse.json()).resolves.toMatchObject({
      data: { total: 2, success: 2, failed: 0, success_ids: expect.arrayContaining([first.id, second.id]) },
    })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 0 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM account_secrets').get()).toEqual({ total: 0 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM account_synthetic_probe_jobs').get()).toEqual({ total: 0 })
    const replay = await request()
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      data: { success_ids: expect.arrayContaining([first.id, second.id]) },
    })
  })

  it('leaves every account intact when a batch target is missing, stale, or a delete aborts', async () => {
    const test = fixture()
    const first = await createProvider(test, 'openai')
    const second = await createProvider(test, 'anthropic')
    const request = (key: string, accounts: unknown) => test.app.request('/accounts/batch-delete', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ accounts }),
    }, test.env)

    const missing = await request('batch-delete-missing', [
      { id: first.id, expected_control_version: 0 },
      { id: 'missing-account', expected_control_version: 0 },
    ])
    expect(missing.status).toBe(404)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 2 })

    const updated = await test.app.request(`/accounts/${first.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' },
      body: JSON.stringify({ notes: 'concurrent update' }),
    }, test.env)
    expect(updated.status).toBe(200)
    const stale = await request('batch-delete-stale', [
      { id: first.id, expected_control_version: 0 },
      { id: second.id, expected_control_version: 0 },
    ])
    expect(stale.status).toBe(412)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 2 })

    test.raw.exec(`CREATE TRIGGER abort_batch_delete BEFORE DELETE ON accounts
      WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'forced_delete_failure'); END;`)
    const aborted = await request('batch-delete-abort', [
      { id: first.id, expected_control_version: 1 },
      { id: second.id, expected_control_version: 0 },
    ])
    expect(aborted.status).toBeGreaterThanOrEqual(500)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 2 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM account_secrets').get()).toEqual({ total: 2 })
  })

  it('refreshes an OpenAI OAuth vault credential with rotation and safe idempotent replay', async () => {
    const test = fixture()
    const create = await test.app.request('/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-refresh-create' },
      body: JSON.stringify({
        name: 'oauth-refresh', platform: 'openai', type: 'oauth', credential_kind: 'oauth',
        base_url: 'https://api.openai.test/v1', api_key: 'old-access', credentials: {
          access_token: 'old-access', refresh_token: 'old-refresh', client_id: 'custom-client', profile: 'preserved',
        },
      }),
    }, test.env)
    const account = (await create.json() as any).data
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-access', refresh_token: 'new-refresh',
      id_token: `header.eyJlbWFpbCI6Im5ld0BleGFtcGxlLnRlc3QiLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1uZXciLCJjaGF0Z3B0X3VzZXJfaWQiOiJ1c2VyLW5ldyIsImNoYXRncHRfcGxhbl90eXBlIjoicHJvIiwib3JnYW5pemF0aW9ucyI6W3siaWQiOiJvcmctb3RoZXIifSx7ImlkIjoib3JnLWRlZmF1bHQiLCJpc19kZWZhdWx0Ijp0cnVlfV19fQ.signature`,
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const request = () => test.app.request(`/accounts/${account.id}/refresh`, {
      method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'oauth-refresh-account' }, body: '{}',
    }, test.env)
    const refreshed = await request()
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
    const safe = (await refreshed.json() as any).data
    expect(JSON.stringify(safe)).not.toContain('new-access')
    expect(fetchMock).toHaveBeenCalledWith('https://auth.openai.com/oauth/token', expect.objectContaining({ method: 'POST' }))
    const stored = test.raw.prepare('SELECT id, key_version, nonce_b64, ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)
    await expect(decryptCredential(
      stored.nonce_b64, stored.ciphertext_b64, MASTER_KEY, credentialAad('test', account.id, stored.id, 2),
    )).resolves.toMatchObject({
      access_token: 'new-access', refresh_token: 'new-refresh', client_id: 'custom-client', profile: 'preserved',
      email: 'new@example.test', chatgpt_account_id: 'acct-new', chatgpt_user_id: 'user-new',
      plan_type: 'pro', organization_id: 'org-default',
    })
    const replay = await request()
    expect(replay.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not modify credentials when OAuth refresh cannot run or the provider rejects it', async () => {
    const test = fixture()
    const account = await createProvider(test, 'openai')
    const before = test.raw.prepare('SELECT ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)
    const missing = await test.app.request(`/accounts/${account.id}/refresh`, {
      method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'oauth-refresh-missing' }, body: '{}',
    }, test.env)
    expect(missing.status).toBe(409)
    expect(test.raw.prepare('SELECT ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)).toEqual(before)
    const oauth = await test.app.request('/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-refresh-rejected-create' },
      body: JSON.stringify({ name: 'oauth-refresh-rejected', platform: 'openai', type: 'oauth', credential_kind: 'oauth', base_url: 'https://api.openai.test/v1', api_key: 'old', credentials: { access_token: 'old', refresh_token: 'refresh' } }),
    }, test.env)
    const oauthAccount = (await oauth.json() as any).data
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad"}', { status: 401 })))
    const rejected = await test.app.request(`/accounts/${oauthAccount.id}/refresh`, {
      method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'oauth-refresh-rejected' }, body: '{}',
    }, test.env)
    expect(rejected.status).toBe(401)
    const persisted = test.raw.prepare('SELECT key_version FROM account_secrets WHERE account_id = ?').get(oauthAccount.id)
    expect(persisted).toEqual({ key_version: 1 })
  })

  it('rejects stale refreshes before calling OpenAI and preserves credentials for upstream failures', async () => {
    const test = fixture()
    const create = await test.app.request('/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-refresh-errors-create' },
      body: JSON.stringify({ name: 'oauth-refresh-errors', platform: 'openai', type: 'oauth', credential_kind: 'oauth', base_url: 'https://api.openai.test/v1', api_key: 'old', credentials: { access_token: 'old', refresh_token: 'refresh' } }),
    }, test.env)
    const account = (await create.json() as any).data
    const before = test.raw.prepare('SELECT key_version, ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)
    const fetchMock = vi.fn(async () => new Response('{"error":"unavailable"}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const stale = await test.app.request(`/accounts/${account.id}/refresh`, {
      method: 'POST', headers: { 'if-match': '"1"', 'idempotency-key': 'oauth-refresh-stale' }, body: '{}',
    }, test.env)
    expect(stale.status).toBe(412)
    expect(fetchMock).not.toHaveBeenCalled()

    const upstream = await test.app.request(`/accounts/${account.id}/refresh`, {
      method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'oauth-refresh-upstream' }, body: '{}',
    }, test.env)
    expect(upstream.status).toBe(502)
    expect(test.raw.prepare('SELECT key_version, ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)).toEqual(before)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') }))
    const timedOut = await test.app.request(`/accounts/${account.id}/refresh`, {
      method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'oauth-refresh-timeout' }, body: '{}',
    }, test.env)
    expect(timedOut.status).toBe(504)
    expect(test.raw.prepare('SELECT key_version, ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)).toEqual(before)
  })

  it('rolls the account refresh back when the vault write fails', async () => {
    const test = fixture()
    const create = await test.app.request('/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-refresh-rollback-create' },
      body: JSON.stringify({ name: 'oauth-refresh-rollback', platform: 'openai', type: 'oauth', credential_kind: 'oauth', base_url: 'https://api.openai.test/v1', api_key: 'old', credentials: { access_token: 'old', refresh_token: 'refresh' } }),
    }, test.env)
    const account = (await create.json() as any).data
    const beforeAccount = test.raw.prepare('SELECT control_version, config_version FROM accounts WHERE id = ?').get(account.id)
    const beforeSecret = test.raw.prepare('SELECT key_version, ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 })))
    test.raw.exec(`CREATE TRIGGER abort_oauth_refresh_secret BEFORE UPDATE ON account_secrets
      WHEN OLD.account_id = '${account.id}' BEGIN SELECT RAISE(ABORT, 'forced_refresh_vault_failure'); END;`)

    const response = await test.app.request(`/accounts/${account.id}/refresh`, {
      method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'oauth-refresh-rollback' }, body: '{}',
    }, test.env)
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(test.raw.prepare('SELECT control_version, config_version FROM accounts WHERE id = ?').get(account.id)).toEqual(beforeAccount)
    expect(test.raw.prepare('SELECT key_version, ciphertext_b64 FROM account_secrets WHERE account_id = ?').get(account.id)).toEqual(beforeSecret)
  })

  it('persists a typed OpenAI OAuth subscription plan and rejects other account kinds', async () => {
    const test = fixture()
    const created = await test.app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'openai-oauth-subscription' },
      body: JSON.stringify({
        name: 'openai-oauth-subscription',
        platform: 'openai', type: 'oauth', credential_kind: 'oauth',
        base_url: 'https://api.openai.test/v1', api_key: 'oauth-access-token', subscription_plan: 'chatgptpro',
      }),
    }, test.env)
    const createdPayload = await created.json() as any
    const account = createdPayload.data
    expect(created.status, JSON.stringify(createdPayload)).toBe(201)
    expect(account.provider_config).toEqual({ subscription_plan: 'pro' })

    const cleared = await test.app.request(`/accounts/${account.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' },
      body: JSON.stringify({ subscription_plan: null }),
    }, test.env)
    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toMatchObject({ data: { provider_config: {}, control_version: 1 } })

    const unsupported = await test.app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'apikey-subscription' },
      body: JSON.stringify({ name: 'apikey-subscription', base_url: 'https://api.openai.test/v1', api_key: 'sk-test', subscription_plan: 'plus' }),
    }, test.env)
    expect(unsupported.status).toBe(409)
    await expect(unsupported.json()).resolves.toMatchObject({ error: { code: 'subscription_plan_not_supported' } })

    const directConfig = await test.app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'apikey-direct-provider-config-subscription' },
      body: JSON.stringify({
        name: 'apikey-direct-provider-config-subscription',
        base_url: 'https://api.openai.test/v1',
        api_key: 'sk-test',
        provider_config: { subscription_plan: 'plus' },
      }),
    }, test.env)
    expect(directConfig.status).toBe(409)
    await expect(directConfig.json()).resolves.toMatchObject({ error: { code: 'subscription_plan_not_supported' } })

    const apiKeyCreated = await test.app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'apikey-update-provider-config-subscription' },
      body: JSON.stringify({
        name: 'apikey-update-provider-config-subscription',
        base_url: 'https://api.openai.test/v1',
        api_key: 'sk-test',
      }),
    }, test.env)
    const apiKeyPayload = await apiKeyCreated.json() as any
    expect(apiKeyCreated.status, JSON.stringify(apiKeyPayload)).toBe(201)
    const directConfigPatch = await test.app.request(`/accounts/${apiKeyPayload.data.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' },
      body: JSON.stringify({ provider_config: { subscription_plan: 'plus' } }),
    }, test.env)
    expect(directConfigPatch.status).toBe(409)
    await expect(directConfigPatch.json()).resolves.toMatchObject({ error: { code: 'subscription_plan_not_supported' } })
  })

  it('rejects provider contract mismatches and secret-like provider config fields', async () => {
    const test = fixture()
    const cases = [
      { platform: 'anthropic', protocol: 'openai', auth_scheme: 'x-api-key' },
      { platform: 'gemini', protocol: 'gemini', auth_scheme: 'bearer' },
      { platform: 'vertex', protocol: 'gemini', auth_scheme: 'x-goog-api-key' },
      {
        platform: 'codex', protocol: 'codex', auth_scheme: 'bearer',
        provider_config: { api_key: 'plaintext-is-forbidden' },
      },
    ]
    for (const [index, provider] of cases.entries()) {
      const response = await test.app.request('/accounts', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `invalid-provider-${index}`,
        },
        body: JSON.stringify({
          name: `invalid-${index}`,
          base_url: 'https://provider.test',
          api_key: 'not-persisted-secret',
          ...provider,
        }),
      }, test.env)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
    }
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 0 })
  })

  it.each([
    [{ image_adapter: 'unknown' }, 'invalid_image_adapter'],
    [{ credential_kind: 'password' }, 'invalid_credential_kind'],
  ])('rejects an invalid persisted account execution discriminator', async (fields, code) => {
    const test = fixture()
    const response = await test.app.request('/accounts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `invalid-account-discriminator-${code}`,
      },
      body: JSON.stringify({
        name: 'invalid-discriminator',
        base_url: 'https://api.openai.test/v1',
        api_key: 'not-persisted-secret',
        ...fields,
      }),
    }, test.env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 0 })
  })

  it('uses each provider adapter for bounded health probes and records upstream errors', async () => {
    const test = fixture()
    const created = await Promise.all(
      (Object.keys(providerInputs) as ProviderPlatform[]).map((platform) => createProvider(test, platform)),
    )
    const fetchMock = vi.fn(async (request: string | URL | Request, _init?: RequestInit) => {
      const url = String(request)
      return new Response('{}', { status: url.includes('anthropic') ? 401 : 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    for (const account of created) {
      const response = await test.app.request(`/accounts/${account.id}/test`, { method: 'POST' }, test.env)
      const payload = await response.json() as any
      expect(response.status).toBe(200)
      expect(payload.data.health_status).toBe(account.platform === 'anthropic' ? 'unhealthy' : 'healthy')
      expect(payload.data.last_health_error).toBe(
        account.platform === 'anthropic' ? 'Upstream returned HTTP 401' : null,
      )
    }

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      headers: Object.fromEntries(new Headers((init as RequestInit).headers)),
      redirect: (init as RequestInit).redirect,
    }))
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://api.openai.test/v1/models',
        headers: expect.objectContaining({ authorization: 'Bearer openai-secret-value' }),
        redirect: 'manual',
      }),
      expect.objectContaining({
        url: 'https://api.anthropic.test/v1/models',
        headers: expect.objectContaining({ 'x-api-key': 'anthropic-secret-value' }),
      }),
      expect.objectContaining({
        url: 'https://generativelanguage.test/v1beta/models',
        headers: expect.objectContaining({ 'x-goog-api-key': 'gemini-secret-value' }),
      }),
      expect.objectContaining({
        url: 'https://chatgpt.test/backend-api/codex/models',
        headers: expect.objectContaining({
          authorization: 'Bearer codex-secret-value',
          'chatgpt-account-id': 'workspace_123',
        }),
      }),
    ]))
  })

  it('classifies an aborted provider health probe as a timeout', async () => {
    const test = fixture()
    const account = await createProvider(test, 'gemini')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError')
    }))

    const response = await test.app.request(
      `/accounts/${account.id}/test`,
      { method: 'POST' },
      test.env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        health_status: 'unhealthy',
        last_health_error: 'Upstream probe timed out',
      },
    })
  })
})
