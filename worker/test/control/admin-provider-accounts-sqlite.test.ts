import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createAdminAccount,
  getAdminAccount,
  listAdminAccounts,
  putAdminAccountModelCapability,
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
    })

    const codex = await createProvider(test, 'codex')
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
