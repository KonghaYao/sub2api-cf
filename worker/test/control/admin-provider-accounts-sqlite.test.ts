import { encryptCredential } from '../../src/gateway/crypto'
import { claimAccountOAuthRefresh } from '../../src/control/account-oauth-refresh-lock'
import { renewDueAccountTokens } from '../../src/control/account-token-renewal'
import { dispatchAccountInitializations, consumeAccountInitialization, isAccountInitializationEvent } from '../../src/control/account-initialization'
import { consumeEvents } from '../../src/gateway/queue'
import * as proxyTransport from '../../src/gateway/proxy-fetch'
import { checkAdminAccountMixedChannel } from '../../src/control/account-mixed-channel'
import { Hono } from 'hono'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import {
  batchDeleteAdminAccounts,
  batchRefreshAdminAccountCredentials,
  batchUpdateAdminAccountCredentials,
  batchCreateAdminAccounts,
  createAdminAccount,
  deleteAdminAccount,
  duplicateAdminAccount,
  getAdminAccount,
  clearAdminAccountRateLimit,
  recoverAdminAccountState,
  resetAdminAccountQuota,
  listAdminAccounts,
  putAdminAccountModelCapability,
  refreshAdminAccountCredentials,
  applyAdminAccountOAuthCredentials,
  setAdminAccountPrivacy,
  getAdminAccountTempUnschedulable,
  clearAdminAccountTempUnschedulable,
  testAdminAccount,
  updateAdminAccount,
} from '../../src/control/accounts'
import type { Env } from '../../src/env'
import { decryptCredential } from '../../src/gateway/crypto'
import { credentialAad, getAccountCredential } from '../../src/gateway/repository'
import type { ProviderPlatform as AllProviderPlatforms } from '../../src/gateway/providers'
type ProviderPlatform = Exclude<AllProviderPlatforms, 'antigravity'>
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const MASTER_KEY = 'm'.repeat(32)

interface Fixture {
  raw: any
  env: Env
  app: Hono<{ Bindings: Env }>
}

function fixture(through = Number.POSITIVE_INFINITY): Fixture {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw, through)
  const app = new Hono<{ Bindings: Env }>()
  app.get('/accounts', listAdminAccounts)
  app.post('/accounts', createAdminAccount)
  app.post('/accounts/check-mixed-channel', checkAdminAccountMixedChannel)
  app.post('/accounts/:id/duplicate', duplicateAdminAccount)
  app.post('/accounts/batch-delete', batchDeleteAdminAccounts)
  app.post('/accounts/batch-refresh', batchRefreshAdminAccountCredentials)
  app.post('/accounts/batch-update-credentials', batchUpdateAdminAccountCredentials)
  app.post('/accounts/batch', batchCreateAdminAccounts)
  app.post('/accounts/:id/refresh', refreshAdminAccountCredentials)
  app.post('/accounts/:id/apply-oauth-credentials', applyAdminAccountOAuthCredentials)
  app.post('/accounts/:id/set-privacy', setAdminAccountPrivacy)
  app.get('/accounts/:id/temp-unschedulable', getAdminAccountTempUnschedulable)
  app.delete('/accounts/:id/temp-unschedulable', clearAdminAccountTempUnschedulable)
  app.get('/accounts/:id', getAdminAccount)
  app.put('/accounts/:id', updateAdminAccount)
  app.post('/accounts/:id/schedulable', updateAdminAccount)
  app.delete('/accounts/:id', deleteAdminAccount)
  app.put('/accounts/:id/models/:model_id', putAdminAccountModelCapability)
  app.post('/accounts/:id/test', testAdminAccount)
  app.post('/accounts/:id/clear-rate-limit', clearAdminAccountRateLimit)
  app.post('/accounts/:id/recover-state', recoverAdminAccountState)
  app.post('/accounts/:id/reset-quota', resetAdminAccountQuota)
  app.post('/accounts/:id/clear-error', recoverAdminAccountState)
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
  grok: { protocol:'openai', auth_scheme:'bearer', base_url:'https://grok.provider.test/v1' },
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

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('Fixture upstream unavailable', { status: 503 }))) })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('admin provider account control plane on D1', () => {
  it.each(['oauth','setup-token'])('uses the original official Anthropic base URL for %s creation', async type => {
    const test=fixture()
    const response=await test.app.request('/accounts',{method:'POST',headers:{'content-type':'application/json','idempotency-key':`claude-default-${type}`},
      body:JSON.stringify({name:'Claude original token form',platform:'anthropic',type,credentials:{access_token:'claude-default-token'}})},test.env)
    expect(response.status,await response.clone().text()).toBe(201)
    expect((await response.json() as any).data).toMatchObject({base_url:'https://api.anthropic.com',type,credential_kind:type==='oauth'?'oauth':'setup_token'})
  })

  it('atomically rejects API-key associations with OAuth-only groups, including account creation and edits', async () => {
    const test = fixture()
    test.raw.exec(`INSERT INTO "groups"(id,name,platform,enabled,ui_config_json,created_at_ms,updated_at_ms)
      VALUES('oauth-only','OAuth only','openai',1,'{"require_oauth_only":true}',1,1)`)
    const rejected = await test.app.request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'restricted-create' },
      body: JSON.stringify({ name: 'Cannot create', platform: 'openai', type: 'apikey', credentials: { api_key: 'secret', base_url: 'https://api.openai.com' }, group_ids: ['oauth-only'] }),
    }, test.env)
    expect(rejected.status, await rejected.clone().text()).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: { code: 'account_group_oauth_only' } })
    expect(test.raw.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(0)
    expect(test.raw.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(0)
    const account = await createProvider(test, 'openai')
    const edited = await test.app.request(`/accounts/${account.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' },
      body: JSON.stringify({ name: 'Must roll back', group_ids: ['oauth-only'] }) }, test.env)
    expect(edited.status).toBe(400)
    expect(test.raw.prepare('SELECT name,control_version FROM accounts WHERE id=?').get(account.id)).toEqual({ name: account.name, control_version: 0 })
    const oauth = await test.app.request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'restricted-oauth-create' },
      body: JSON.stringify({ name: 'OAuth accepted', platform: 'openai', type: 'oauth', credentials: { access_token: 'access' }, group_ids: ['oauth-only'] }),
    }, test.env)
    expect(oauth.status, await oauth.clone().text()).toBe(201)
    expect((await oauth.json() as any).data.group_links).toMatchObject([{ group_id: 'oauth-only' }])
  })

  it('creates an OpenAI OAuth account from the original token-only form without synthetic API-key or base-url fields', async () => {
    const test = fixture()
    const response = await test.app.request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'original-oauth-create' },
      body: JSON.stringify({ name: 'Original OAuth form', platform: 'openai', type: 'oauth', concurrency: 8, priority: 50,
        rate_multiplier: 1.25, group_ids: [], extra: { privacy_mode: 'training_off' }, credentials: { access_token: 'original-access',
          refresh_token: 'original-refresh', expires_at: 1999999999, chatgpt_account_id: 'personal', email: 'oauth@example.test',
          cookie: 'discard-cookie', sso: 'discard-sso', password: 'discard-password' } }),
    }, test.env)
    expect(response.status, await response.clone().text()).toBe(201)
    const account = (await response.json() as any).data
    expect(account).toMatchObject({ platform: 'openai', type: 'oauth', credential_kind: 'oauth', base_url: 'https://api.openai.com',
      concurrency: 8, priority: 50, rate_multiplier: 1.25, credentials: { chatgpt_account_id: 'personal', expires_at: 1999999999 } })
    const secret = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id = ?').get(account.id)
    const credential = await decryptCredential(secret.nonce_b64, secret.ciphertext_b64, MASTER_KEY, credentialAad('test', account.id, secret.id, 1))
    expect(credential).toMatchObject({ api_key: 'original-access', access_token: 'original-access', refresh_token: 'original-refresh' })
    for (const word of ['discard-cookie', 'discard-sso', 'discard-password']) {
      expect(JSON.stringify(account)).not.toContain(word); expect(JSON.stringify(credential)).not.toContain(word)
    }
    expect(JSON.stringify(account)).not.toContain('original-access')
  })

  it('normalizes confirmed model mappings into global and account model records', async () => {
    const test = fixture()
    try {
      const now = Date.now()
      test.raw.prepare(
        `INSERT INTO models (id,platform,public_name,upstream_name,endpoint,image_generation,enabled,created_at_ms,updated_at_ms)
         VALUES ('existing-image','openai','gpt-image-2','admin-upstream','both',1,1,?,?)`,
      ).run(now, now)
      const response = await test.app.request('/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'model-mapping-normalization' },
        body: JSON.stringify({
          name: 'Mapped image account',
          platform: 'openai',
          type: 'apikey',
          ...providerInputs.openai,
          api_key: 'secret-value',
          credentials: { model_mapping: { 'gpt-image-2': 'gpt-image-2', 'chat-public': 'chat-upstream' } },
          model_capabilities: [{ model_id: 'existing-image', chat_completions: false, responses: false, embeddings: false, image_generation: true }],
          group_links: [],
        }),
      }, test.env)
      expect(response.status, await response.clone().text()).toBe(201)
      const account = (await response.json() as any).data
      const models = test.raw.prepare(
        `SELECT m.id,m.public_name,m.upstream_name,m.image_generation AS model_image_generation,
                am.chat_completions,am.responses,am.embeddings,
                am.image_generation AS account_image_generation,am.source
           FROM models m JOIN account_models am ON am.model_id=m.id
          WHERE am.account_id=? ORDER BY m.public_name`,
      ).all(account.id)
      expect(models).toEqual([
        { id: expect.any(String), public_name: 'chat-public', upstream_name: 'chat-upstream', model_image_generation: 0, chat_completions: 1, responses: 1, embeddings: 0, account_image_generation: 0, source: 'mapping' },
        { id: 'existing-image', public_name: 'gpt-image-2', upstream_name: 'admin-upstream', model_image_generation: 1, chat_completions: 0, responses: 0, embeddings: 0, account_image_generation: 1, source: 'explicit' },
      ])
      const imageModel = models[1]
      const explicit = await test.app.request(`/accounts/${account.id}/models/${imageModel.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': `"${account.control_version}"` },
        body: JSON.stringify({ chat_completions: false, responses: false, embeddings: false, image_generation: true }),
      }, test.env)
      expect(explicit.status, await explicit.clone().text()).toBe(200)
      const explicitlyConfigured = (await explicit.json() as any).data
      expect(test.raw.prepare('SELECT source FROM account_models WHERE account_id=? AND model_id=?').get(account.id, imageModel.id))
        .toEqual({ source: 'explicit' })

      const update = await test.app.request(`/accounts/${account.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': `"${explicitlyConfigured.control_version}"` },
        body: JSON.stringify({ credentials: { model_mapping: {} } }),
      }, test.env)
      expect(update.status, await update.clone().text()).toBe(200)
      expect(test.raw.prepare('SELECT model_id,source,image_generation FROM account_models WHERE account_id=?').all(account.id))
        .toEqual([{ model_id: imageModel.id, source: 'explicit', image_generation: 1 }])
      expect(test.raw.prepare("SELECT COUNT(*) AS count FROM models WHERE public_name='chat-public'").get()).toEqual({ count: 1 })
    } finally { test.raw.close() }
  })

  it.each(['openai', 'codex'] as const)('applies original %s re-authorization atomically with merged settings and sanitized token rotation', async platform => {
    const test = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const create = await test.app.request('/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'reauth-create' },
      body: JSON.stringify({ name: 'Reauthorize', platform, ...providerInputs[platform], type: 'oauth', credential_kind: 'oauth',
        api_key: 'old-access', enabled: false, schedulable: false, concurrency: 7,
        credentials: { access_token: 'old-access', refresh_token: 'keep-refresh', id_token: 'keep-id', cookie: 'old-cookie',
          password: 'old-password', profile: 'old-profile', model_mapping: { old: 'old-upstream' } },
        extra: { base_rpm: 22, max_sessions: 3, window_cost_limit: 4, quota_limit: 10, quota_used: 2, privacy_mode: 'training_off', retained: true } }),
    }, test.env)
    expect(create.status, await create.clone().text()).toBe(201)
    const account = (await create.json() as any).data
    test.raw.prepare(`UPDATE accounts SET health_status = 'unhealthy', last_health_error = 'Authentication failed',
      consecutive_health_failures = 4, health_probe_lease_until_ms = 9999999999999,
      ui_config_json = json_set(ui_config_json, '$.rate_limit_reset_at', '2999-01-01T00:00:00Z') WHERE id = ?`).run(account.id)
    const response = await test.app.request(`/accounts/${account.id}/apply-oauth-credentials`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        type: platform === 'codex' ? 'setup-token' : 'oauth',
        credentials: { access_token: 'fresh-access', email: 'new@example.test', sso: 'strip-sso', 'sso-rw': 'strip-sso-rw',
          clearTextPassword: 'strip-password', cookie: 'strip-cookie' }, extra: { email: 'new@example.test', added: true },
      }),
    }, test.env)
    expect(response.status, await response.clone().text()).toBe(200)
    const safe = (await response.json() as any).data
    expect(safe).toMatchObject({ enabled: false, schedulable: false, concurrency: 7, control_version: 1,
      credential_key_version: 2, health_status: 'unknown', last_health_error: null,
      type: platform === 'codex' ? 'setup-token' : 'oauth',
      extra: { base_rpm: 22, max_sessions: 3, window_cost_limit: 4, quota_limit: 10, quota_used: 2, privacy_mode: 'training_off', retained: true, added: true },
    })
    for (const secret of ['old-access', 'fresh-access', 'keep-refresh', 'keep-id', 'old-cookie', 'old-password', 'strip-sso', 'strip-cookie', 'strip-password']) {
      expect(JSON.stringify(safe)).not.toContain(secret)
    }
    const stored = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id = ?').get(account.id)
    expect(stored.key_version).toBe(2)
    const credential = await decryptCredential(stored.nonce_b64, stored.ciphertext_b64, MASTER_KEY,
      credentialAad('test', account.id, stored.id, stored.key_version))
    expect(credential).toEqual({ access_token: 'fresh-access', api_key: 'fresh-access', refresh_token: 'keep-refresh', id_token: 'keep-id', email: 'new@example.test' })
    const runtime = test.raw.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)
    expect(runtime).toMatchObject({ consecutive_health_failures: 0, health_probe_lease_until_ms: null, recovery_revision: 1, health_probe_generation: 1 })
    expect(JSON.parse(runtime.ui_config_json).rate_limit_reset_at).toBeUndefined()
    expect(runtime.ui_config_json).not.toContain('fresh-access')
  })

  it.each(['bad-extra', 'bad-billing', 'bad-type', 'stale', 'race', 'vault-failure'])('preserves the OAuth vault and settings when reauthorization fails: %s', async failure => {
    const test = fixture()
    const account = await createProvider(test, 'codex')
    if (failure === 'bad-billing') test.raw.prepare("UPDATE accounts SET platform = 'openai', protocol = 'openai', image_adapter = 'direct_images', provider_config_json = '{}' WHERE id = ?").run(account.id)
    const before = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id = ?').get(account.id)
    const beforeAccount = test.raw.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)
    const originalBatch = test.env.DB.batch.bind(test.env.DB)
    if (failure === 'race') vi.spyOn(test.env.DB, 'batch').mockImplementationOnce(async statements => {
      test.raw.prepare("UPDATE accounts SET control_version = control_version + 1, ui_config_json = json_set(ui_config_json, '$.extra.newer', 1) WHERE id = ?").run(account.id)
      return originalBatch(statements)
    })
    if (failure === 'vault-failure') test.raw.exec("CREATE TRIGGER fail_reauth BEFORE UPDATE ON account_secrets BEGIN SELECT RAISE(ABORT, 'vault failure'); END")
    const response = await test.app.request(`/accounts/${account.id}/apply-oauth-credentials`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(failure === 'stale' ? { 'if-match': '"99"' } : {}) },
      body: JSON.stringify({ type: failure === 'bad-type' ? 'apikey' : 'oauth', credentials: { access_token: 'never-save' },
        extra: failure === 'bad-extra' ? [] : failure === 'bad-billing' ? { openai_long_context_billing_enabled: 'true' } : { new_setting: 1 } }),
    }, test.env)
    expect(response.status).toBe(failure === 'race' || failure === 'stale' ? 412 : failure === 'vault-failure' ? 500 : 400)
    expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id = ?').get(account.id)).toEqual(before)
    const after = test.raw.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)
    if (failure === 'race') {
      expect(after.control_version).toBe(beforeAccount.control_version + 1)
      expect(JSON.parse(after.ui_config_json).extra).toEqual({ ...account.extra, newer: 1 })
    } else expect(after).toEqual(beforeAccount)
    expect(await response.text()).not.toContain('never-save')
  })

  it('rejects reauthorization of an API key account', async () => {
    const test = fixture(); const account = await createProvider(test, 'openai')
    const response = await test.app.request(`/accounts/${account.id}/apply-oauth-credentials`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'oauth', credentials: { access_token: 'new-access' } }),
    }, test.env)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_OAUTH' } })
  })

  it('validates saved header overrides before creating or changing account credentials', async () => {
    const test = fixture()
    try {
      const invalidCreate = await test.app.request('/accounts', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-header-create' },
        body: JSON.stringify({ name: 'Invalid headers', platform: 'openai', ...providerInputs.openai,
          api_key: 'must-not-persist', credentials: { header_override_enabled: 'true' } }),
      }, test.env)
      expect(invalidCreate.status).toBe(400)
      expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 0 })
      expect(test.raw.prepare('SELECT COUNT(*) AS total FROM account_secrets').get()).toEqual({ total: 0 })
      const account = await createProvider(test, 'openai')
      const before = test.raw.prepare('SELECT credential_ref, control_version FROM accounts WHERE id=?').get(account.id)
      const invalid = await test.app.request(`/accounts/${account.id}`, { method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': '"0"' },
        body: JSON.stringify({ credentials: { header_override_enabled: true, header_overrides: { authorization: 'wrong' } } }),
      }, test.env)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_HEADER_OVERRIDE' } })
      expect(test.raw.prepare('SELECT credential_ref, control_version FROM accounts WHERE id=?').get(account.id)).toEqual(before)
      const valid = await test.app.request(`/accounts/${account.id}`, { method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': '"0"' },
        body: JSON.stringify({ credentials: { header_overrides: { ' X-Route ': ' value ', 'x-template': '' } } }),
      }, test.env)
      expect(valid.status, await valid.clone().text()).toBe(200)
      expect(await valid.json()).toMatchObject({ data: { credentials: { header_overrides: { 'x-route': 'value', 'x-template': '' } } } })
    } finally { test.raw.close() }
  })

  it('diagnoses original OpenAI OAuth with the access token, ChatGPT account, and normalized model', async () => {
    const test = fixture()
    try {
      const create = await test.app.request('/accounts', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-diagnostic-create' },
        body: JSON.stringify({ name: 'OAuth diagnostic', platform: 'openai', type: 'oauth', credential_kind: 'oauth',
          base_url: 'https://ignored-for-oauth.test', api_key: 'legacy-wrong-token',
          credentials: { access_token: 'actual-access-token', chatgpt_account_id: 'upstream-account',
            model_mapping: { 'gpt-public-test': 'gpt-5.3-high' } },
          extra: { openai_responses_mode: 'force_chat_completions' },
        }),
      }, test.env)
      const created = await create.json() as any
      expect(create.status, JSON.stringify(created)).toBe(201)
      const fetcher = vi.fn().mockResolvedValue(new Response('data: {"type":"response.completed","response":{"status":"completed","output":[{"content":[{"type":"output_text","text":"OAuth hello"}]}]}}\n\n'))
      vi.stubGlobal('fetch', fetcher)
      const response = await test.app.request(`/accounts/${created.data.id}/test`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id: 'gpt-public-test' }),
      }, test.env)
      const text = await response.text()
      expect(response.headers.get('content-type'), text).toBe('text/event-stream')
      expect(text).toContain('OAuth hello')
      expect(text).toContain('"success":true')
      const [url, init] = fetcher.mock.calls[0]
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
      const headers = new Headers(init.headers)
      expect(headers.get('authorization')).toBe('Bearer actual-access-token')
      expect(headers.get('chatgpt-account-id')).toBe('upstream-account')
      expect(headers.get('originator')).toBe('codex-tui')
      expect(headers.get('user-agent')).toContain(`codex-tui/${headers.get('version')} `)
      expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-5.3-codex', store: false, stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })
    } finally { test.raw.close() }
  })

  it.each([false, true])('resets original quota counters and windows while preserving other blockers (shadow=%s)', async shadow => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      const extra = { quota_used: 12, quota_daily_used: 3, quota_weekly_used: 5, quota_limit: 50, quota_daily_limit: 10,
        quota_daily_reset_mode: 'fixed', quota_daily_reset_hour: 8, quota_daily_start: 'before', quota_weekly_start: 'before',
        quota_daily_reset_at: 'after', quota_weekly_reset_at: 'after', keep: 'value' }
      test.raw.prepare(`UPDATE accounts SET health_status='unhealthy',last_health_error='preserve',
        ui_config_json=json_set(ui_config_json,'$.extra',json(?),'$.schedulable',json('false'),'$.rate_limit_reset_at','2099-01-01T00:00:00Z','$.parent_account_id',?) WHERE id=?`)
        .run(JSON.stringify(extra),shadow ? 'parent-id' : null,account.id)
      const before = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id) as any
      const projected = (await (await test.app.request(`/accounts/${account.id}`, {}, test.env)).json() as any).data
      expect(projected).toMatchObject({ quota_limit: 50, quota_used: 12, quota_daily_limit: 10, quota_daily_used: 0 })
      expect(projected.extra.quota_daily_used).toBe(3)
      const response = await test.app.request(`/accounts/${account.id}/reset-quota`, { method: 'POST' }, test.env)
      if (shadow) {
        expect(response.status).toBe(400)
        expect(test.raw.prepare('SELECT ui_config_json FROM accounts WHERE id=?').get(account.id)).toEqual({ ui_config_json: before.ui_config_json })
        return
      }
      expect(response.status,await response.clone().text()).toBe(200)
      const data = (await response.json() as any).data
      expect(data).toMatchObject({ status: 'error', error_message: 'preserve', schedulable: false, extra: {
        quota_used: 0, quota_daily_used: 0, quota_weekly_used: 0, quota_limit: 50, quota_daily_limit: 10,
        quota_daily_reset_mode: 'fixed', quota_daily_reset_hour: 8, keep: 'value',
      } })
      for (const key of ['quota_daily_start','quota_weekly_start','quota_daily_reset_at','quota_weekly_reset_at']) expect(data.extra).not.toHaveProperty(key)
      expect(data.rate_limit_reset_at).toBeUndefined()
      const after = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id) as any
      expect(after.control_version).toBe(before.control_version + 1)
      expect(after.recovery_revision).toBe(before.recovery_revision)
      expect(after.credential_ref).toBe(before.credential_ref)
    } finally { test.raw.close() }
  })

  it.each(['recover-state', 'clear-error'])('restores account runtime through original %s without enabling a disabled account', async action => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      test.raw.prepare(`UPDATE accounts SET enabled=0,health_status='unhealthy',last_health_error='invalid token',
        consecutive_health_failures=3,health_probe_generation=4,health_probe_lease_until_ms=9999999999999,
        ui_config_json=json_set(ui_config_json,'$.schedulable',json('false'),'$.rate_limit_reset_at','2099-01-01T00:00:00Z','$.extra.keep','value') WHERE id=?`).run(account.id)
      const before = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id) as any
      const response = await test.app.request(`/accounts/${account.id}/${action}`, { method: 'POST' }, test.env)
      expect(response.status,await response.clone().text()).toBe(200)
      expect((await response.json() as any).data).toMatchObject({ enabled: false, schedulable: false, status: 'inactive', error_message: '', extra: { keep: 'value' } })
      const after = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id) as any
      expect(after.credential_ref).toBe(before.credential_ref)
      expect(after.health_status).toBe('unknown'); expect(after.health_probe_generation).toBe(5)
      expect(after.health_probe_lease_until_ms).toBeNull(); expect(after.consecutive_health_failures).toBe(0)
      expect(after.recovery_revision).toBe(before.recovery_revision + 1)
      expect(after.control_version).toBe(before.control_version + 1)
      expect(JSON.parse(after.ui_config_json)).not.toHaveProperty('rate_limit_reset_at')
    } finally { test.raw.close() }
  })

  it.each(['clear', 'expire', 'unknown', 'race', 'default'])('enforces account-test 429 cooldown and recovery: %s', async scenario => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      test.raw.exec(`INSERT INTO "groups" (id,name,platform,enabled,created_at_ms,updated_at_ms) VALUES ('limit-group','Limit group','openai',1,1,1);
        INSERT INTO models (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms) VALUES ('limit-model','openai','gpt-limit','gpt-limit','responses',1,1,1);`)
      test.raw.prepare("INSERT INTO account_groups (account_id,group_id,priority,weight,created_at_ms,updated_at_ms) VALUES (?,'limit-group',1,1,1,1)").run(account.id)
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.original_model_routing',1),health_status='unhealthy',last_health_error='old authentication error' WHERE id=?").run(account.id)
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (scenario === 'race') test.raw.prepare('UPDATE accounts SET control_version=control_version+1 WHERE id=?').run(account.id)
        return new Response(scenario === 'unknown' ? '{}' : JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 600 } }), { status: 429 })
      }))
      const response = await test.app.request(`/accounts/${account.id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id: 'gpt-limit', mode: scenario === 'default' ? 'default' : 'compact' }) }, test.env)
      expect(await response.text()).toContain('"success":false')
      const data = (await (await test.app.request(`/accounts/${account.id}`, {}, test.env)).json() as any).data
      if (scenario === 'unknown' || scenario === 'race') {
        expect(data.rate_limit_reset_at).toBeUndefined(); expect(data.health_status).toBe('unhealthy')
        return
      }
      expect(Date.parse(data.rate_limit_reset_at)).toBeGreaterThan(Date.now())
      expect(data.status).toBe('active'); expect(data.error_message).toBe('')
      const listed = (await (await test.app.request('/accounts?status=rate_limited', {}, test.env)).json() as any).data
      expect(listed.items.map((row: any) => row.id)).toContain(account.id)
      expect((await (await test.app.request('/accounts?status=active', {}, test.env)).json() as any).data.total).toBe(0)
      await expect(getAccountCredential(test.env,'limit-group','limit-model','responses',account.id)).rejects.toMatchObject({ code: 'credential_unavailable' })
      if (scenario === 'clear') {
        const cleared = await test.app.request(`/accounts/${account.id}/clear-rate-limit`, { method: 'POST' }, test.env)
        expect(cleared.status,await cleared.clone().text()).toBe(200)
        expect((await cleared.json() as any).data.rate_limit_reset_at).toBeUndefined()
        expect((test.raw.prepare('SELECT recovery_revision FROM accounts WHERE id=?').get(account.id) as any).recovery_revision).toBe(1)
      } else test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.rate_limit_reset_at','2000-01-01T00:00:00Z') WHERE id=?").run(account.id)
      await expect(getAccountCredential(test.env,'limit-group','limit-model','responses',account.id)).resolves.toMatchObject({ account_id: account.id })
      expect((await (await test.app.request('/accounts?status=rate_limited', {}, test.env)).json() as any).data.total).toBe(0)
    } finally { test.raw.close() }
  })

  it.each([false, true])('blocks gateway credentials after compact 401 without overwriting a concurrent edit (race=%s)', async race => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      test.raw.exec(`INSERT INTO "groups" (id,name,platform,enabled,created_at_ms,updated_at_ms) VALUES ('auth-group','Auth group','openai',1,1,1);
        INSERT INTO models (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms) VALUES ('auth-model','openai','gpt-auth','gpt-auth','responses',1,1,1);`)
      test.raw.prepare("INSERT INTO account_groups (account_id,group_id,priority,weight,created_at_ms,updated_at_ms) VALUES (?,'auth-group',1,1,1,1)").run(account.id)
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.original_model_routing',1,'$.extra.openai_compact_supported',json('true')) WHERE id=?").run(account.id)
      await expect(getAccountCredential(test.env,'auth-group','auth-model','responses',account.id)).resolves.toMatchObject({ account_id: account.id })
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (race) test.raw.prepare("UPDATE accounts SET config_version=config_version+1,control_version=control_version+1 WHERE id=?").run(account.id)
        return new Response('private token and provider details', { status: 401 })
      }))
      const response = await test.app.request(`/accounts/${account.id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model_id: 'gpt-auth', mode: 'compact' }),
      }, test.env)
      const text = await response.text()
      expect(text).toContain('"success":false'); expect(text).not.toContain('private')
      const detail = await test.app.request(`/accounts/${account.id}`, {}, test.env)
      const data = (await detail.json() as any).data
      expect(data.extra.openai_compact_supported).toBe(true)
      expect(data.enabled).toBe(true); expect(data.schedulable).toBe(true)
      if (race) {
        expect(data.status).toBe('active')
        await expect(getAccountCredential(test.env,'auth-group','auth-model','responses',account.id)).resolves.toMatchObject({ account_id: account.id })
      } else {
        expect(data).toMatchObject({ status: 'error', health_status: 'unhealthy', error_message: 'Authentication failed (401)' })
        await expect(getAccountCredential(test.env,'auth-group','auth-model','responses',account.id)).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })
        const filtered = await test.app.request('/accounts?status=error', {}, test.env)
        expect((await filtered.json() as any).data.items.map((item: any) => item.id)).toContain(account.id)
      }
    } finally { test.raw.close() }
  })

  it.each(['success', 'unsupported', 'transient', 'race'])('persists compact probe capability with snapshot protection: %s', async scenario => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.credentials',json(?),'$.extra',json(?)) WHERE id=?")
        .run(JSON.stringify({ model_mapping: { 'public-test': 'ordinary-model' }, compact_model_mapping: { 'public-test': 'wrong-legacy-model' } }),
          JSON.stringify({ openai_compact_supported: true, openai_compact_mode: 'force_on', unrelated: 'keep' }), account.id)
      const before = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id) as any
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        expect(JSON.parse(init.body)).toMatchObject({ model: 'ordinary-model', input: [{ type: 'message' }, { type: 'compaction_trigger' }] })
        if (scenario === 'race') test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.extra.unrelated','new') WHERE id=?").run(account.id)
        return new Response(scenario === 'success' || scenario === 'race' ? 'data: {"type":"response.output_item.done","item":{"type":"compaction"}}\n\n' : 'provider private details',
          { status: scenario === 'unsupported' ? 404 : scenario === 'transient' ? 503 : 200 })
      }))
      const response = await test.app.request(`/accounts/${account.id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model_id: 'public-test', mode: 'compact' }),
      }, test.env)
      const text = await response.text()
      expect(response.headers.get('content-type'), text).toBe('text/event-stream')
      expect(text).toContain(`"success":${scenario === 'success' || scenario === 'race'}`)
      const after = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id) as any
      const extra = JSON.parse(after.ui_config_json).extra
      expect(extra.openai_compact_mode).toBe('force_on')
      expect(extra.openai_compact_supported).toBe(scenario !== 'unsupported')
      if (scenario === 'race') {
        expect(extra.unrelated).toBe('new'); expect(extra).not.toHaveProperty('openai_compact_checked_at')
        expect(after.control_version).toBe(before.control_version)
        expect(text).toContain('not saved')
      } else {
        expect(extra.unrelated).toBe('keep'); expect(extra.openai_compact_checked_at).toBeTruthy()
        expect(extra.openai_compact_last_status).toBe(scenario === 'unsupported' ? 404 : scenario === 'transient' ? 503 : 200)
        expect(extra.openai_compact_last_error).not.toContain('private')
        expect(after.control_version).toBe(before.control_version + 1)
        expect(after.config_version).toBe(before.config_version + 1)
      }
    } finally { test.raw.close() }
  })

  it.each(['api_key', 'oauth'])('routes the mapped image model through the original %s diagnostic', async kind => {
    const test = fixture()
    try {
      const create = await test.app.request('/accounts', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'image-diagnostic-create' },
        body: JSON.stringify({ name: 'Image diagnostic', platform: 'openai', type: kind === 'oauth' ? 'oauth' : 'apikey', credential_kind: kind,
          base_url: 'https://api.openai.test', api_key: 'image-key',
          credentials: { api_key: 'image-key', access_token: 'image-access', model_mapping: { 'public-image': 'gpt-image-2' } },
        }),
      }, test.env)
      const created = await create.json() as any
      expect(create.status, JSON.stringify(created)).toBe(201)
      const fetcher = vi.fn().mockResolvedValue(new Response(kind === 'api_key' ? JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] })
        : 'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"image_generation_call","result":"aGVsbG8="}]}}\n\n'))
      vi.stubGlobal('fetch', fetcher)
      const response = await test.app.request(`/accounts/${created.data.id}/test`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id: 'public-image', prompt: 'A cat' }),
      }, test.env)
      const text = await response.text()
      expect(response.headers.get('content-type'), text).toBe('text/event-stream')
      expect(text).toContain('data:image/png;base64,aGVsbG8=')
      expect(text).toContain('"success":true')
      const [url, init] = fetcher.mock.calls[0]
      expect(url).toBe(kind === 'api_key' ? 'https://api.openai.test/v1/images/generations' : 'https://chatgpt.com/backend-api/codex/responses')
      expect(new Headers(init.headers).get('authorization')).toBe(kind === 'api_key' ? 'Bearer image-key' : 'Bearer image-access')
      expect(JSON.parse(init.body)).toMatchObject(kind === 'api_key' ? { model: 'gpt-image-2', prompt: 'A cat' }
        : { model: 'gpt-5.4-mini', tools: [{ model: 'gpt-image-2' }], input: [{ content: [{ text: 'A cat' }] }] })
    } finally { test.raw.close() }
  })

  it.each(['responses', 'chat', 'anthropic', 'gemini'])('executes the selected mapped text model using %s for the original streaming test modal', async protocol => {
    const test = fixture()
    try {
      const account = await createProvider(test, protocol === 'gemini' ? 'gemini' : protocol === 'anthropic' ? 'anthropic' : 'openai')
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.credentials',json(?)) WHERE id=?")
        .run(JSON.stringify({ model_mapping: { 'public-test-model': 'upstream-test-model' } }),account.id)
      if (protocol === 'chat') {
        const update = await test.app.request(`/accounts/${account.id}`, { method: 'PUT',
          headers: { 'content-type': 'application/json', 'if-match': '"0"' },
          body: JSON.stringify({ extra: { openai_responses_mode: 'force_chat_completions' } }),
        }, test.env)
        expect(update.status, await update.text()).toBe(200)
      }
      const fetcher = vi.fn().mockResolvedValue(new Response(protocol === 'responses'
        ? 'data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
        : protocol === 'gemini' ? 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n'
        : protocol === 'anthropic' ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n'))
      vi.stubGlobal('fetch', fetcher)
      const response = await test.app.request(`/accounts/${account.id}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id: 'public-test-model', mode: 'default', prompt: '' }),
      },test.env)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      const text = await response.text()
      expect(text).toContain('"model":"upstream-test-model"')
      expect(text).toContain('"type":"content","text":"Hello"')
      expect(text).toContain('"success":true')
      expect(fetcher.mock.calls[0][0]).toBe(protocol === 'gemini' ? 'https://generativelanguage.test/v1beta/models/upstream-test-model:streamGenerateContent?alt=sse'
        : protocol === 'anthropic' ? 'https://api.anthropic.test/v1/messages?beta=true'
        : `https://api.openai.test/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`)
    } finally { test.raw.close() }
  })

  it.each(['success', 'proxy_failure', 'changed'])('uses the bound proxy for manual account tests: %s', async outcome => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(11001,'Manual',json_object('protocol','https','host','proxy.test','port',443,'status','active'),'manual-proxy-key','','',1,1)")
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id',11001) WHERE id=?").run(account.id)
      if (outcome !== 'proxy_failure') vi.spyOn(proxyTransport, 'fetchAccountProxy').mockImplementation(async (_env,id,url,init) => {
        expect(id).toBe('11001')
        expect(url.pathname).toBe('/v1/models')
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer openai-secret-value')
        if (outcome === 'changed') test.raw.prepare('UPDATE accounts SET config_version=config_version+1 WHERE id=?').run(account.id)
        return Response.json({ data: [] })
      })
      const direct = vi.fn(); vi.stubGlobal('fetch', direct)
      const response = await test.app.request(`/accounts/${account.id}/test`, { method: 'POST' }, test.env)
      expect(response.status).toBe(200)
      const result = (await response.json() as any).data
      expect(result).toMatchObject({ health_status: outcome === 'proxy_failure' ? 'unhealthy' : 'healthy', persisted: outcome !== 'changed' })
      expect(direct).not.toHaveBeenCalled()
      const stored = test.raw.prepare('SELECT health_status FROM accounts WHERE id=?').get(account.id)
      expect(stored.health_status).toBe(outcome === 'changed' ? 'unknown' : result.health_status)
    } finally { test.raw.close() }
  })

  it.each([{ base_url: 'https://new-relay.example.test/v1' }, { api_key: 'replacement-key' }, { proxy_id: 11002 }])(
    'clears the old upstream billing observation when identity changes: %j', async patch => {
      const test = fixture()
      try {
        const account = await createProvider(test, 'openai')
        test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(11002,'Replacement',json_object('protocol','http','host','proxy.test','port',8080,'status','active'),'replacement-proxy-key','','',1,1)")
        const proxySecret = await encryptCredential({ api_key: JSON.stringify({ schema_version: 1, password: '' }) }, MASTER_KEY, 'proxy:v1:replacement-proxy-key')
        test.raw.prepare('UPDATE proxies SET nonce_b64=?,ciphertext_b64=? WHERE id=11002').run(proxySecret.nonce_b64,proxySecret.ciphertext_b64)
        test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.extra',json(?)) WHERE id=?")
          .run(JSON.stringify({ upstream_billing_probe: { status: 'ok' }, upstream_billing_probe_enabled: true, keep: 'safe' }),account.id)
        const response = await test.app.request(`/accounts/${account.id}`, {
          method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' }, body: JSON.stringify(patch),
        },test.env)
        expect(response.status).toBe(200)
        expect((await response.json() as any).data.extra).toEqual({ upstream_billing_probe_enabled: true, keep: 'safe' })
      } finally { test.raw.close() }
    },
  )

  it('does not resurrect a cleared billing snapshot from an old form', async () => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      const response = await test.app.request(`/accounts/${account.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' },
        body: JSON.stringify({ extra: { keep: 'safe', upstream_billing_probe: { status: 'ok', data: { old: true } } } }),
      },test.env)
      expect(response.status).toBe(200)
      expect((await response.json() as any).data.extra).toEqual({ keep: 'safe' })
    } finally { test.raw.close() }
  })

  it('migrates existing refresh cooldowns without clearing them and rejects stale claims without mutation', async () => {
    const test = fixture(110)
    try {
      const created = await test.app.request('/accounts', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'migration-refresh' },
        body: JSON.stringify({ name: 'Migration refresh', platform: 'anthropic', type: 'oauth',
          credentials: { access_token: 'old', refresh_token: 'refresh', expires_at: 1 } }) }, test.env)
      expect(created.status).toBe(201)
      const account = (await created.json() as any).data
      const until = Date.now()+300000
      test.raw.prepare('INSERT INTO account_oauth_refresh_state(account_id,next_attempt_at_ms,last_attempt_at_ms,last_error_code) VALUES (?,?,?,?)')
        .run(account.id,until,123,'oauth_refresh_rejected')
      applyMigrations(test.raw,111)
      const state = () => test.raw.prepare('SELECT * FROM account_oauth_refresh_state WHERE account_id=?').get(account.id)
      const before = state()
      expect(before).toMatchObject({ next_attempt_at_ms: until, last_attempt_at_ms: 123, last_error_code: 'oauth_refresh_rejected',
        credential_key_version: 1, credential_ref: test.raw.prepare('SELECT credential_ref FROM accounts WHERE id=?').get(account.id).credential_ref })
      await expect(claimAccountOAuthRefresh(test.env,account.id,9)).rejects.toMatchObject({ status: 412, code: 'account_version_conflict' })
      expect(state()).toEqual(before)
      expect(await renewDueAccountTokens(test.env)).toEqual({ refreshed: 0, failed: 0, skipped: 0 })
    } finally { test.raw.close() }
  })

  it.each(['claude', 'setup-token', 'openai', 'missing-rate', 'future', 'boundary', 'disabled', 'unscheduled', 'no-refresh', 'missing-expiry', 'cooldown', 'rejected', 'locked', 'replacement', 'observation-cooldown'])(
    'automatically renews only eligible accounts: %s', async scenario => {
      const test = fixture()
      try {
        const now = Date.now()
        const platform = ['openai', 'missing-rate'].includes(scenario) ? 'openai' : 'anthropic'
        const expires = scenario === 'future' ? now / 1000 + 3600 : scenario === 'boundary' ? now / 1000 + 1800 : Math.floor(now / 1000) - 1
        const created = await test.app.request('/accounts', {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'auto-create' },
          body: JSON.stringify({ name: 'Automatic renewal', platform, type: scenario === 'setup-token' ? 'setup-token' : 'oauth',
            extra: { privacy_mode: 'training_off' },
            credentials: { access_token: 'auto-old', ...(scenario === 'no-refresh' ? {} : { refresh_token: 'auto-refresh' }),
              ...(['missing-rate', 'missing-expiry'].includes(scenario) ? {} : { expires_at: scenario === 'setup-token' ? String(expires) : expires }) } }),
        }, test.env)
        expect(created.status).toBe(201)
        const account = (await created.json() as any).data
        if (scenario === 'disabled') test.raw.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(account.id)
        if (scenario === 'unscheduled') test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.schedulable',0) WHERE id=?").run(account.id)
        if (scenario === 'missing-rate') test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.rate_limit_reset_at',?) WHERE id=?").run(new Date(now+60000).toISOString(),account.id)
        if (['cooldown', 'locked', 'replacement', 'observation-cooldown'].includes(scenario)) test.raw.prepare(`INSERT INTO account_oauth_refresh_state
          (account_id,next_attempt_at_ms,lease_until_ms,credential_ref,credential_key_version,last_error_code)
          SELECT a.id,?,?,a.credential_ref,s.key_version,'oauth_refresh_rejected' FROM accounts a
          JOIN account_secrets s ON s.id=a.credential_ref WHERE a.id=?`)
          .run(scenario === 'locked' ? 0 : now+300000,scenario === 'locked' ? now+120000 : 0,account.id)
        if (scenario === 'replacement') {
          const edited = await test.app.request(`/accounts/${account.id}`, { method: 'PUT',
            headers: { 'content-type': 'application/json', 'if-match': '"0"' },
            body: JSON.stringify({ credentials: { access_token: 'replacement-access', refresh_token: 'replacement-refresh' } }) },test.env)
          expect(edited.status,await edited.clone().text()).toBe(200)
        }
        if (scenario === 'observation-cooldown') test.raw.prepare("UPDATE accounts SET config_version=config_version+1,ui_config_json=json_set(ui_config_json,'$.extra.passive_usage_7d_utilization',0.25) WHERE id=?").run(account.id)
        const before = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
        const fetcher = vi.fn(async (url: string) => {
          if (url.includes('/oauth/token')) return scenario === 'rejected' ? Response.json({ error: 'private-refresh-detail' }, { status: 400 }) :
            Response.json({ access_token: 'auto-new', refresh_token: 'auto-next-refresh', expires_in: 3600, token_type: 'Bearer' })
          return new Response('not available', { status: 503 })
        })
        vi.stubGlobal('fetch',fetcher)
        const result = await renewDueAccountTokens(test.env,now)
        const success = ['claude', 'setup-token', 'openai', 'missing-rate', 'replacement'].includes(scenario)
        expect(result).toEqual({ refreshed: success ? 1 : 0, failed: scenario === 'rejected' ? 1 : 0, skipped: 0 })
        const secret = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
        if (success) {
          expect(secret.key_version).toBe(before.key_version + 1)
          const credential = await decryptCredential(secret.nonce_b64,secret.ciphertext_b64,MASTER_KEY,credentialAad('test',account.id,secret.id,secret.key_version))
          expect(credential).toMatchObject({ access_token: 'auto-new', refresh_token: 'auto-next-refresh' })
        } else expect(secret).toEqual(before)
        if (!success && scenario !== 'rejected') expect(fetcher).not.toHaveBeenCalled()
        const calls = fetcher.mock.calls.length
        expect(await renewDueAccountTokens(test.env,now)).toEqual({ refreshed: 0, failed: 0, skipped: 0 })
        expect(fetcher).toHaveBeenCalledTimes(calls)
        const state = test.raw.prepare('SELECT * FROM account_oauth_refresh_state WHERE account_id=?').get(account.id)
        if (scenario === 'rejected') {
          expect(state).toMatchObject({ lease_token: null, lease_until_ms: 0, last_error_code: 'oauth_refresh_rejected' })
          expect(JSON.stringify(state)).not.toContain('private-refresh-detail')
        }
      } finally { test.raw.close() }
    },
  )

  it.each(['overlap', 'lease-lost', 'lease-expired'])('fences scheduled/manual token rotation: %s', async scenario => {
    const test = fixture()
    try {
      const created = await test.app.request('/accounts', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'locked-create' },
        body: JSON.stringify({ name: 'Locked renewal', platform: 'anthropic', type: 'oauth',
          credentials: { access_token: 'old', refresh_token: 'refresh', expires_at: 1 } }) },test.env)
      const account = (await created.json() as any).data
      const before = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
      let release!: () => void, started!: () => void
      const pending = new Promise<void>(resolve => { release=resolve })
      const ready = new Promise<void>(resolve => { started=resolve })
      const fetcher = vi.fn(async () => { started(); await pending; return Response.json({ access_token: 'rotated', expires_in: 3600 }) })
      vi.stubGlobal('fetch',fetcher)
      const renewal = renewDueAccountTokens(test.env)
      await ready
      if (scenario === 'overlap') {
        expect(await renewDueAccountTokens(test.env)).toEqual({ refreshed: 0, failed: 0, skipped: 0 })
        const manual = await test.app.request(`/accounts/${account.id}/refresh`, { method: 'POST',
          headers: { 'if-match': '"0"', 'idempotency-key': 'manual-overlap' }, body: '{}' }, test.env)
        expect(manual.status).toBe(409)
        expect(await manual.json()).toMatchObject({ error: { code: 'oauth_refresh_in_progress' } })
      } else if (scenario === 'lease-expired') test.raw.prepare('UPDATE account_oauth_refresh_state SET lease_until_ms=0 WHERE account_id=?').run(account.id)
      else test.raw.prepare("UPDATE account_oauth_refresh_state SET lease_token='new-owner',lease_until_ms=? WHERE account_id=?").run(Date.now()+120000,account.id)
      release()
      const result = await renewal
      expect(fetcher).toHaveBeenCalledTimes(1)
      if (scenario === 'overlap') expect(result.refreshed).toBe(1)
      else {
        expect(result.refreshed).toBe(0)
        expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)).toEqual(before)
        expect(result.skipped).toBe(1)
        expect(test.raw.prepare('SELECT lease_token FROM account_oauth_refresh_state WHERE account_id=?').get(account.id).lease_token).toBe(scenario === 'lease-expired' ? null : 'new-owner')
      }
    } finally { test.raw.close() }
  })

  it.each(['oauth', 'setup-token'].flatMap(type =>
    ['rotate', 'preserve', 'reject', 'malformed', 'edit', 'proxy', 'batch', 'observation', 'transaction-race', 'missing-refresh'].map(scenario => ({ type, scenario }))))(
    'refreshes Claude $type safely: $scenario', async ({ type, scenario }) => {
    const test = fixture()
    try {
      const created = await test.app.request('/accounts', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'claude-refresh-create' },
        body: JSON.stringify({ name: 'Claude refresh', platform: 'anthropic', type, status: 'inactive',
          credentials: { access_token: 'old-access', ...(scenario === 'missing-refresh' ? {} : { refresh_token: 'old-refresh' }), scope: 'keep-scope', intercept_warmup_requests: true } }),
      }, test.env)
      expect(created.status).toBe(201)
      const account = (await created.json() as any).data
      if (scenario === 'proxy') {
        test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(11003,'Refresh',json_object('protocol','https','host','proxy.test','port',443,'status','active'),'bad-claude-proxy-key','','',1,1)")
        test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id',11003) WHERE id=?").run(account.id)
      }
      const state = () => ({ account: test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id),
        secret: test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id) })
      const before = state()
      const observe = () => test.raw.prepare("UPDATE accounts SET config_version=config_version+1,ui_config_json=json_set(ui_config_json,'$.extra.passive_usage_7d_utilization',0.42) WHERE id=?").run(account.id)
      if (scenario === 'transaction-race') {
        const batch = test.env.DB.batch.bind(test.env.DB)
        let pending = true
        vi.spyOn(test.env.DB, 'batch').mockImplementation(async statements => {
          if (pending) { pending = false; observe() }
          return batch(statements)
        })
      }
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://platform.claude.com/v1/oauth/token')
        expect(init.redirect).toBe('manual')
        expect(new Headers(init.headers).get('user-agent')).toBe('axios/1.13.6')
        expect(new Headers(init.headers).get('content-type')).toBe('application/json')
        expect(JSON.parse(String(init.body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' })
        if (scenario === 'reject') return Response.json({ error: 'old-refresh private-provider-error' }, { status: 400 })
        if (scenario === 'malformed') return Response.json({ access_token: 'new-access', expires_in: '3600' })
        if (scenario === 'observation') observe()
        if (scenario === 'edit') test.raw.prepare('UPDATE accounts SET control_version=control_version+1,config_version=config_version+1 WHERE id=?').run(account.id)
        return Response.json({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer',
          ...(scenario === 'preserve' ? {} : { refresh_token: 'new-refresh', scope: 'new-scope' }) })
      })
      vi.stubGlobal('fetch', fetcher)
      const request = () => test.app.request(scenario === 'batch' ? '/accounts/batch-refresh' : `/accounts/${account.id}/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '"0"', 'idempotency-key': 'claude-refresh-op' },
        body: JSON.stringify(scenario === 'batch' ? { accounts: [{ id: account.id, expected_control_version: 0 }, { id: 'missing', expected_control_version: 0 }] } : {}),
      }, test.env)
      const result = await request()
      const text = await result.text()
      for (const secret of ['old-refresh', 'new-refresh', 'new-access', 'private-provider-error']) expect(text).not.toContain(secret)
      if (['reject', 'malformed', 'edit', 'proxy', 'missing-refresh'].includes(scenario)) {
        expect(result.status).toBe(scenario === 'missing-refresh' ? 409 : scenario === 'reject' ? 401 : scenario === 'edit' ? 412 : 502)
        expect(state().secret).toEqual(before.secret)
        if (scenario !== 'edit') expect(state()).toEqual(before)
        if (scenario === 'proxy' || scenario === 'missing-refresh') expect(fetcher).not.toHaveBeenCalled()
      } else {
        expect(result.status, text).toBe(200)
        if (scenario === 'batch') expect(JSON.parse(text).data).toMatchObject({ success: 1, failed: 1, success_ids: [account.id] })
        const after = state()
        expect(after.account).toMatchObject({ enabled: 0, control_version: 1 })
        if (['observation', 'transaction-race'].includes(scenario)) {
          expect(after.account.config_version).toBe(before.account.config_version + 2)
          expect(JSON.parse(after.account.ui_config_json).extra.passive_usage_7d_utilization).toBe(0.42)
          expect(JSON.parse(text).data.extra.passive_usage_7d_utilization).toBe(0.42)
        }
        expect(after.secret.key_version).toBe(2)
        const credential = await decryptCredential(after.secret.nonce_b64, after.secret.ciphertext_b64, MASTER_KEY,
          credentialAad('test', account.id, after.secret.id, 2))
        expect(credential).toMatchObject({ api_key: 'new-access', access_token: 'new-access', expires_in: '3600',
          refresh_token: scenario === 'preserve' ? 'old-refresh' : 'new-refresh', scope: scenario === 'preserve' ? 'keep-scope' : 'new-scope', intercept_warmup_requests: true })
        expect((await request()).status).toBe(200)
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(state()).toEqual(after)
      }
    } finally { test.raw.close() }
  })

  it('preserves the OAuth vault and versions when the bound proxy cannot refresh', async () => {
    const test = fixture()
    try {
      const created = await test.app.request('/accounts', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'proxy-refresh-create' },
        body: JSON.stringify({ name: 'Proxy refresh', platform: 'openai', type: 'oauth', credential_kind: 'oauth',
          base_url: 'https://api.openai.test/v1', api_key: 'old-access', credentials: { access_token: 'old-access', refresh_token: 'old-refresh' } }),
      }, test.env)
      expect(created.status).toBe(201)
      const account = (await created.json() as any).data
      test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(11004,'Refresh',json_object('protocol','https','host','proxy.test','port',443,'status','active'),'bad-refresh-proxy-key','','',1,1)")
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id',11004) WHERE id=?").run(account.id)
      const state = () => ({ account: test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id),
        secret: test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id) })
      const before = state()
      const direct = vi.fn().mockResolvedValue(Response.json({ access_token: 'unexpected-new-token' }))
      vi.stubGlobal('fetch', direct)
      const result = await test.app.request(`/accounts/${account.id}/refresh`, {
        method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'proxy-refresh-failed' }, body: '{}',
      }, test.env)
      expect(result.status).toBe(502)
      expect(await result.json()).toMatchObject({ error: { code: 'oauth_refresh_transport_failed' } })
      expect(direct).not.toHaveBeenCalled()
      expect(state()).toEqual(before)
    } finally { test.raw.close() }
  })

  it('hydrates current proxy details and fallback origin names without exposing proxy credentials', async () => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      for (const [id,name] of [[12001,'origin-proxy'], [12002,'current-proxy']] as const) test.raw.prepare(`INSERT INTO proxies
        (id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms)
        VALUES (?,?,json_object('protocol','socks5h','host','proxy.test','port',1080,'status','active','expires_at',1900000000),?,'private-nonce','private-ciphertext',1,1)`).run(id, name, name+'-key')
      test.raw.prepare(`UPDATE accounts SET ui_config_json=json_set(ui_config_json, '$.proxy_id', 12002,
        '$.proxy_fallback_origin_id', 12001) WHERE id=?`).run(account.id)
      for (const path of [`/accounts/${account.id}`, '/accounts']) {
        const response = await test.app.request(path, {}, test.env)
        expect(response.status).toBe(200)
        const payload = await response.json() as any
        const value = path === '/accounts' ? payload.data.items[0] : payload.data
        expect(value).toMatchObject({ proxy_fallback_origin_name: 'origin-proxy', proxy: {
          id: 12002, name: 'current-proxy', protocol: 'socks5h', host: 'proxy.test', port: 1080,
          expires_at: new Date(1900000000000).toISOString(),
        } })
        expect(JSON.stringify(value)).not.toContain('private-nonce')
        expect(JSON.stringify(value)).not.toContain('private-ciphertext')
        expect(value.proxy).not.toHaveProperty('password')
      }
      test.raw.prepare("UPDATE proxies SET name='Renamed' WHERE id=12002").run()
      expect((await (await test.app.request(`/accounts/${account.id}`, {}, test.env)).json() as any).data.proxy.name).toBe('Renamed')
    } finally { test.raw.close() }
  })

  it('validates original account expiration controls and clears expiration with zero', async () => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      expect(account.auto_pause_on_expired).toBe(true)
      let version = account.control_version
      let sequence = 0
      const update = (body: object) => test.app.request(`/accounts/${account.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': `"${version}"`,
          'idempotency-key': `expiry-${++sequence}` }, body: JSON.stringify(body),
      }, test.env)
      for (const body of [{ expires_at: '2030-01-01' }, { expires_at: 1.5 }, { auto_pause_on_expired: 'false' }, { load_factor: 10001 }, { load_factor: 1.5 }]) {
        expect((await update(body)).status).toBe(400)
      }
      for (const body of [{ expires_at: 1800000000, auto_pause_on_expired: false, load_factor: 20 }, { expires_at: 0, load_factor: 0 }]) {
        const response = await update(body)
        const payload = await response.json() as any
        expect(response.status, JSON.stringify(payload)).toBe(200)
        expect(payload.data.auto_pause_on_expired).toBe(false)
        expect(payload.data.expires_at).toBe(body.expires_at || null)
        expect(payload.data.load_factor).toBe(body.load_factor || null)
        version = payload.data.control_version
      }
    } finally { test.raw.close() }
  })

  it('checks mixed Claude channels by platform and excludes the edited account without changing state', async () => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'anthropic')
      test.raw.exec(`INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms) VALUES ('mixed-group', 'Mixed Group', 'anthropic', 1, 1, 1)`)
      test.raw.prepare(`INSERT INTO account_groups (account_id, group_id, priority, weight, created_at_ms, updated_at_ms) VALUES (?, 'mixed-group', 1, 1, 1, 1)`).run(account.id)
      const check = (body: unknown) => test.app.request('/accounts/check-mixed-channel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, test.env)
      const result = await check({ platform: 'antigravity', group_ids: ['mixed-group', 'mixed-group'] })
      expect(await result.json()).toMatchObject({ data: { has_risk: true, details: { group_id: 'mixed-group', current_platform: 'Antigravity', other_platform: 'Anthropic' } } })
      expect(await (await check({ platform: 'anthropic', group_ids: ['mixed-group'] })).json()).toMatchObject({ data: { has_risk: false } })
      expect(await (await check({ platform: 'antigravity', group_ids: ['mixed-group'], account_id: account.id })).json()).toMatchObject({ data: { has_risk: false } })
      expect((await check({ platform: 'anthropic', group_ids: 'invalid' })).status).toBe(400)
      expect(test.raw.prepare('SELECT control_version FROM accounts').get()).toEqual({ control_version: 0 })
    } finally { test.raw.close() }
  })

  it.each(['upstream_model_metadata', 'upstream_billing_probe'])('retains a newer %s observation when an old editor replaces extra settings', async key => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      const snapshot = { synced_at: '2026-09-07T00:00:00.000Z', models: { model: { context_window: 128000 } } }
      test.raw.prepare("UPDATE accounts SET ui_config_json = json_set(ui_config_json, '$.extra', json(?)) WHERE id = ?")
        .run(JSON.stringify({ old_setting: true, [key]: snapshot }), account.id)
      const response = await test.app.request(`/accounts/${account.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' },
        body: JSON.stringify({ extra: { new_setting: true, [key]: { stale: true } } }),
      }, test.env)
      expect(response.status).toBe(200)
      expect((await response.json() as any).data.extra).toEqual({ new_setting: true, [key]: snapshot })
    } finally { test.raw.close() }
  })

  it('changes scheduling independently of status, preserves omitted values and rejects stale or invalid changes', async () => {
    const test = fixture()
    try {
      const account = await createProvider(test, 'openai')
      expect(account.priority).toBe(50)
      const change = (body: unknown, version: number) => test.app.request(`/accounts/${account.id}/schedulable`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
        body: JSON.stringify(body),
      }, test.env)
      const paused = await change({ schedulable: false }, 0)
      expect(paused.status).toBe(200)
      expect(await paused.json()).toMatchObject({ data: {
        enabled: true, status: 'active', schedulable: false, control_version: 1,
      } })
      expect((await change({ schedulable: true }, 0)).status).toBe(412)
      expect((await change({ schedulable: null }, 1)).status).toBe(400)
      expect((await change({ schedulable: true, enabled: false }, 1)).status).toBe(400)
      const active = await test.app.request('/accounts?status=active', {}, test.env)
      expect(await active.json()).toMatchObject({ data: { total: 0, items: [] } })
      const filtered = await test.app.request('/accounts?status=unschedulable', {}, test.env)
      expect(await filtered.json()).toMatchObject({ data: { total: 1, items: [{ id: account.id }] } })
      const disabled = await test.app.request(`/accounts/${account.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"1"' },
        body: JSON.stringify({ status: 'inactive' }),
      }, test.env)
      expect(await disabled.json()).toMatchObject({ data: { enabled: false, schedulable: false, control_version: 2 } })
      const resumed = await change({ schedulable: true }, 2)
      expect(await resumed.json()).toMatchObject({ data: { enabled: false, status: 'inactive', schedulable: true, control_version: 3 } })
      expect(test.raw.prepare("SELECT json_extract(ui_config_json, '$.schedulable') AS schedulable FROM accounts WHERE id = ?").get(account.id)).toEqual({ schedulable: 1 })
    } finally { test.raw.close() }
  })

  it('pauses scheduling independently of enabled and preserves the control version', async () => {
    const test = fixture(); const created = await createProvider(test, 'openai')
    test.raw.exec(`INSERT INTO "groups"(id,name,platform,created_at_ms,updated_at_ms) VALUES('schedule-group','Scheduling','openai',1,1);
      INSERT INTO models(id,platform,public_name,upstream_name,endpoint,created_at_ms,updated_at_ms) VALUES('schedule-model','openai','gpt-test','gpt-test','both',1,1);`)
    test.raw.prepare('INSERT INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms) VALUES(?,?,1,1)').run(created.id,'schedule-group')
    test.raw.prepare('INSERT INTO account_models(account_id,model_id,created_at_ms,updated_at_ms) VALUES(?,?,1,1)').run(created.id,'schedule-model')
    await expect(getAccountCredential(test.env,'schedule-group','schedule-model','chat_completions',created.id)).resolves.toMatchObject({account_id:created.id})
    const paused = await test.app.request(`/accounts/${created.id}`, {
      method:'PUT', headers:{'content-type':'application/json','idempotency-key':'schedule-off','if-match':`"${created.control_version}"`},
      body:JSON.stringify({schedulable:false}),
    },test.env)
    expect(paused.status).toBe(200)
    expect(await paused.json()).toMatchObject({data:{enabled:true,schedulable:false,control_version:created.control_version+1}})
    expect(test.raw.prepare('SELECT enabled FROM accounts WHERE id=?').get(created.id)).toEqual({enabled:1})
    await expect(getAccountCredential(test.env,'schedule-group','schedule-model','chat_completions',created.id)).rejects.toMatchObject({code:'credential_unavailable'})
    const resumed = await test.app.request(`/accounts/${created.id}`, {
      method:'PUT', headers:{'content-type':'application/json','idempotency-key':'schedule-on','if-match':`"${created.control_version+1}"`},
      body:JSON.stringify({schedulable:true}),
    },test.env)
    expect(resumed.status).toBe(200)
    await expect(getAccountCredential(test.env,'schedule-group','schedule-model','chat_completions',created.id)).resolves.toMatchObject({account_id:created.id})
    test.raw.close()

  })

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
    await expect(all.json()).resolves.toMatchObject({ data: { total: Object.keys(providerInputs).length } })
    expect(created.find((account) => account.platform === 'codex')).toMatchObject({
      provider_config: { account_id: 'workspace_123' },
    })
  })

  it('maps account list status filters to the persisted enabled and health projections', async () => {
    const test = fixture()
    const healthy = await createProvider(test, 'openai')
    const unhealthy = await createProvider(test, 'anthropic')
    const inactive = await createProvider(test, 'gemini')
    test.raw.prepare("UPDATE accounts SET health_status = 'unhealthy' WHERE id = ?").run(unhealthy.id)
    test.raw.prepare('UPDATE accounts SET enabled = 0 WHERE id = ?').run(inactive.id)

    const active = await test.app.request('/accounts?status=active', {}, test.env)
    await expect(active.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ id: healthy.id, status: 'active' }] },
    })
    const errors = await test.app.request('/accounts?status=error', {}, test.env)
    await expect(errors.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ id: unhealthy.id, status: 'error' }] },
    })
    const inactiveAccounts = await test.app.request('/accounts?status=inactive', {}, test.env)
    await expect(inactiveAccounts.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ id: inactive.id, status: 'inactive' }] },
    })
    const limited = await test.app.request('/accounts?status=rate_limited', {}, test.env)
    expect(limited.status).toBe(200)
    await expect(limited.json()).resolves.toMatchObject({ data: { total: 0, items: [] } })
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
        load_factor: 12,
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
      load_factor: 12,
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

  it('deletes one account instead of leaving an inactive row behind', async () => {
    const test = fixture()
    const account = await createProvider(test, 'openai')

    const deleted = await test.app.request(`/accounts/${account.id}`, {
      method: 'DELETE',
      headers: { 'if-match': '"0"' },
    }, test.env)

    expect(deleted.status, await deleted.clone().text()).toBe(200)
    await expect(deleted.json()).resolves.toEqual({
      code: 0,
      data: { message: 'Account deleted successfully' },
    })
    expect((await test.app.request(`/accounts/${account.id}`, {}, test.env)).status).toBe(404)
    await expect((await test.app.request('/accounts', {}, test.env)).json()).resolves.toMatchObject({
      data: { total: 0, items: [] },
    })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM accounts').get()).toEqual({ total: 0 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM account_secrets').get()).toEqual({ total: 0 })

    const replay = await test.app.request(`/accounts/${account.id}`, {
      method: 'DELETE',
      headers: { 'if-match': '"0"' },
    }, test.env)
    expect(replay.status).toBe(404)
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

  it.each([false, true])('refreshes an OpenAI OAuth vault credential with rotation and safe idempotent replay (proxy=%s)', async useProxy => {
    const test = fixture()
    const create = await test.app.request('/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-refresh-create' },
      body: JSON.stringify({
        name: 'oauth-refresh', platform: 'openai', type: 'oauth', credential_kind: 'oauth',
        base_url: 'https://api.openai.test/v1', api_key: 'old-access', credentials: {
          access_token: 'old-access', refresh_token: 'old-refresh', client_id: 'custom-client', profile: 'preserved',
          email: 'old@example.test', chatgpt_account_id: 'acct-old', chatgpt_user_id: 'user-old', plan_type: 'plus', organization_id: 'org-old',
        },
      }),
    }, test.env)
    const account = (await create.json() as any).data
    const fetchMock = vi.fn(async (_url?: string, _init?: RequestInit) => {
      if (_url?.includes('/settings/')) {
        expect(_init?.method).toBe('PATCH')
        expect(new Headers(_init?.headers).get('authorization')).toBe('Bearer new-access')
        return new Response(null, { status: 204 })
      }
      if (_url?.includes('/accounts/check/')) return Response.json({ accounts: {} })
      if (_url?.includes('/subscriptions?')) {
        expect(new URL(_url).searchParams.get('account_id')).toBe('acct-new')
        return Response.json({ active_until: '2099-01-01T00:00:00Z' })
      }
      return new Response(JSON.stringify({
      access_token: 'new-access', refresh_token: 'new-refresh',
      id_token: `header.eyJlbWFpbCI6Im5ld0BleGFtcGxlLnRlc3QiLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1uZXciLCJjaGF0Z3B0X3VzZXJfaWQiOiJ1c2VyLW5ldyIsImNoYXRncHRfcGxhbl90eXBlIjoicHJvIiwib3JnYW5pemF0aW9ucyI6W3siaWQiOiJvcmctb3RoZXIifSx7ImlkIjoib3JnLWRlZmF1bHQiLCJpc19kZWZhdWx0Ijp0cnVlfV19fQ.signature`,
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }) })
    const proxy = vi.spyOn(proxyTransport, 'fetchAccountProxy').mockImplementation(async (_env, id, url, init) => {
      expect(id).toBe('11005')
      return fetchMock(url.href, init)
    })
    if (useProxy) {
      test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(11005,'Refresh',json_object('protocol','http','host','proxy.test','port',8080,'status','active'),'refresh-proxy-key','','',1,1)")
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id',11005) WHERE id=?").run(account.id)
    }
    const direct = useProxy ? vi.fn(() => { throw new Error('Unexpected direct refresh') }) : fetchMock
    vi.stubGlobal('fetch', direct)
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
      api_key: 'new-access', access_token: 'new-access', refresh_token: 'new-refresh', client_id: 'custom-client', profile: 'preserved',
      email: 'new@example.test', chatgpt_account_id: 'acct-new', chatgpt_user_id: 'user-new',
      plan_type: 'pro', organization_id: 'org-default', subscription_expires_at: '2099-01-01T00:00:00Z',
    })
    const replay = await request()
    expect(replay.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls.filter(([url]) => url === 'https://auth.openai.com/oauth/token')).toHaveLength(1)
    expect(proxy).toHaveBeenCalledTimes(useProxy ? 4 : 0)
    expect(safe.extra.privacy_mode).toBe('training_off')
    if (useProxy) expect(direct).not.toHaveBeenCalled()
    const init = fetchMock.mock.calls[0][1]!
    expect(init.redirect).toBe('manual')
    expect(new Headers(init.headers).get('originator')).toBe('codex-tui')
    expect(new Headers(init.headers).has('version')).toBe(false)
    expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe('old-refresh')
  })

  it('refreshes OpenAI OAuth accounts in a CAS-protected idempotent batch', async () => {
    const test = fixture()
    const createOauth = async (name: string) => {
      const response = await test.app.request('/accounts', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `batch-refresh-create-${name}` },
        body: JSON.stringify({ name, platform: 'openai', type: 'oauth', credential_kind: 'oauth', base_url: 'https://api.openai.test/v1', api_key: `${name}-old`, credentials: { access_token: `${name}-old`, refresh_token: `${name}-refresh` } }),
      }, test.env)
      return (await response.json() as any).data
    }
    const first = await createOauth('batch-first')
    const second = await createOauth('batch-second')
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/settings/')) return new Response(null, { status: 204 })
      if (url.includes('/accounts/check/')) return Response.json({ accounts: {} })
      expect(url).toBe('https://auth.openai.com/oauth/token')
      expect(new URLSearchParams(init.body as string).get('grant_type')).toBe('refresh_token')
      return new Response(JSON.stringify({ access_token: `fresh-${fetchMock.mock.calls.length}`, expires_in: 3600 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const request = () => test.app.request('/accounts/batch-refresh', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-batch-refresh' },
      body: JSON.stringify({ accounts: [
        { id: first.id, expected_control_version: 0 },
        { id: second.id, expected_control_version: 0 },
      ] }),
    }, test.env)
    const refreshed = await request()
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
    await expect(refreshed.json()).resolves.toMatchObject({
      data: { total: 2, success: 2, failed: 0, success_ids: [first.id, second.id] },
    })
    expect(test.raw.prepare('SELECT control_version FROM accounts WHERE id = ?').get(first.id)).toEqual({ control_version: 1 })
    expect(test.raw.prepare('SELECT control_version FROM accounts WHERE id = ?').get(second.id)).toEqual({ control_version: 1 })
    const replay = await request()
    expect(replay.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(fetchMock.mock.calls.filter(([url]) => url === 'https://auth.openai.com/oauth/token')).toHaveLength(2)

    const stale = await test.app.request('/accounts/batch-refresh', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oauth-batch-refresh-stale' },
      body: JSON.stringify({ accounts: [{ id: first.id, expected_control_version: 0 }] }),
    }, test.env)
    await expect(stale.json()).resolves.toMatchObject({
      data: { total: 1, success: 0, failed: 1, results: [{ error: { code: 'account_version_conflict' } }] },
    })
    expect(fetchMock).toHaveBeenCalledTimes(6)
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

  it.each(['empty-token', 'oversized-body', 'shadow', 'concurrent-edit'])('preserves the vault on unsafe saved-account refresh: %s', async scenario => {
    const test = fixture()
    const created = await test.app.request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'guarded-refresh-create' },
      body: JSON.stringify({ name: 'Guarded refresh', platform: 'openai', type: 'oauth', credentials: { access_token: 'original-access', refresh_token: 'original-refresh' } }),
    }, test.env)
    const account = (await created.json() as any).data
    if (scenario === 'shadow') test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.parent_account_id','parent') WHERE id=?").run(account.id)
    const before = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
    const fetcher = vi.fn(async (url: string) => {
      if (!url.includes('auth.openai.com')) return new Response('', { status: 503 })
      if (scenario === 'concurrent-edit') test.raw.prepare("UPDATE accounts SET control_version=control_version+1, ui_config_json=json_set(ui_config_json,'$.extra.newer',1) WHERE id=?").run(account.id)
      return scenario === 'oversized-body' ? new Response('x'.repeat(1024 * 1024 + 1))
        : Response.json({ access_token: scenario === 'empty-token' ? '' : 'rotated-access', expires_in: 3600 })
    })
    vi.stubGlobal('fetch', fetcher)
    const response = await test.app.request(`/accounts/${account.id}/refresh`, { method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'guarded-refresh' }, body: '{}' }, test.env)
    expect(response.status).toBe(scenario === 'shadow' ? 400 : scenario === 'concurrent-edit' ? 412 : 502)
    expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)).toEqual(before)
    if (scenario === 'shadow') expect(fetcher).not.toHaveBeenCalled()
    if (scenario === 'concurrent-edit') expect(JSON.parse(test.raw.prepare('SELECT ui_config_json FROM accounts WHERE id=?').get(account.id).ui_config_json).extra).toEqual({ ...account.extra, newer: 1 })
    expect(await response.text()).not.toContain('rotated-access')
  })

  it.each(['create', 'edit', 'overlap', 'rollback'])('schedules single-account Responses probes atomically: %s', async scenario => {
    const test = fixture(); const sent: any[] = []
    test.env.EVENTS_QUEUE = { send: vi.fn(async event => { sent.push(event) }) } as unknown as Queue
    const account = await createProvider(test, 'openai')
    expect(sent).toHaveLength(1)
    expect(test.raw.prepare('SELECT kind,status FROM account_initialization_jobs WHERE account_id=?').get(account.id)).toMatchObject({ kind: 'openai_responses', status: 'pending' })
    const edit = () => test.app.request(`/accounts/${account.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' }, body: JSON.stringify({ notes: 'edited while probing' }) }, test.env)
    const fetcher = vi.fn(async () => {
      if (scenario === 'overlap' && fetcher.mock.calls.length === 1) expect((await edit()).status).toBe(200)
      return Response.json({ status: 'completed', output: [{ type: 'function_call' }] })
    })
    vi.stubGlobal('fetch', fetcher)
    if (scenario === 'overlap') {
      await expect(consumeAccountInitialization(test.env, sent[0])).rejects.toMatchObject({ status: 412 })
      expect(test.raw.prepare('SELECT status,lease_token FROM account_initialization_jobs WHERE account_id=?').get(account.id)).toMatchObject({ status: 'pending', lease_token: null })
      expect(sent).toHaveLength(2)
    } else await consumeAccountInitialization(test.env, sent[0])
    if (scenario === 'edit' || scenario === 'rollback') {
      const before = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id)
      const oldJob = test.raw.prepare('SELECT * FROM account_initialization_jobs WHERE account_id=?').get(account.id)
      if (scenario === 'rollback') test.raw.exec("CREATE TRIGGER fail_reprobe BEFORE UPDATE ON account_initialization_jobs BEGIN SELECT RAISE(ABORT, 'cannot schedule'); END")
      const response = await edit()
      expect(response.status).toBe(scenario === 'rollback' ? 500 : 200)
      if (scenario === 'rollback') {
        expect(test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id)).toEqual(before)
        expect(test.raw.prepare('SELECT * FROM account_initialization_jobs WHERE account_id=?').get(account.id)).toEqual(oldJob)
        return
      }
      expect(sent).toHaveLength(2)
    }
    if (scenario !== 'create') await consumeAccountInitialization(test.env, sent[1])
    const row = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id)
    expect(row.control_version).toBe(scenario === 'create' ? 0 : 1)
    expect(JSON.parse(row.ui_config_json).extra.openai_responses_supported).toBe(true)
    expect(test.raw.prepare('SELECT status FROM account_initialization_jobs WHERE account_id=?').get(account.id).status).toBe('completed')
  })

  it.each(['supported', 'unsupported', 'incomplete', 'network', 'oversized', 'race', 'proxy'])('initializes batch API-key Responses capability truthfully: %s', async scenario => {
    const test = fixture(); const events: any[] = []
    test.env.EVENTS_QUEUE = { send: vi.fn(async event => { events.push(event) }) } as unknown as Queue
    const created = await test.app.request('/accounts/batch', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'batch-probe-key' },
      body: JSON.stringify({ accounts: [{ name: 'API probe', platform: 'openai', type: 'apikey', credentials: { api_key: 'probe-key', base_url: 'https://probe.test/coding/v3',
        model_mapping: { public: 'z-model', second: 'a-model', wildcard: '*' }, header_override_enabled: true, header_overrides: { 'x-probe-custom': 'retained' } }, extra: { keep: true } }] }) }, test.env)
    expect(created.status).toBe(200)
    const id = (await created.json() as any).data.results[0].id
    expect(events).toHaveLength(1)
    if (scenario === 'proxy') {
      test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(11006,'Probe',json_object('protocol','http','host','proxy.test','port',8080,'status','active'),'probe-proxy-key','','',1,1)")
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id',11006) WHERE id=?").run(id)
    }
    test.raw.prepare("UPDATE accounts SET health_status='unhealthy',last_health_error='preserve' WHERE id=?").run(id)
    const before = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(id)
    const upstream = vi.fn(async (url: unknown, init: RequestInit) => {
      expect(String(url)).toBe('https://probe.test/coding/v3/responses')
      const headers = new Headers(init.headers)
      expect(headers.get('authorization')).toBe('Bearer probe-key'); expect(headers.get('x-probe-custom')).toBe('retained')
      expect(headers.get('openai-beta')).toBe('responses=experimental'); expect(headers.get('x-codex-window-id')).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'a-model', tool_choice: 'required', stream: false, max_output_tokens: 512, tools: [{ name: 'probe_ping' }] })
      if (scenario === 'network') throw new Error('connection failed')
      if (scenario === 'race') test.raw.prepare("UPDATE accounts SET control_version=control_version+1,ui_config_json=json_set(ui_config_json,'$.extra.newer',1) WHERE id=?").run(id)
      return scenario === 'unsupported' ? new Response('not found', { status: 404 }) : scenario === 'oversized' ? new Response('x'.repeat(262145))
        : Response.json(scenario === 'incomplete' ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
          : { status: 'completed', output: [{ type: 'function_call' }] })
    })
    const direct = vi.fn((url: unknown, init: RequestInit) => upstream(url, init)); vi.stubGlobal('fetch', direct)
    if (scenario === 'proxy') vi.spyOn(proxyTransport, 'fetchAccountProxy').mockImplementation(async (_env, proxyId, url, init) => {
      expect(proxyId).toBe('11006'); return upstream(url, init!)
    })
    if (scenario === 'race') await expect(consumeAccountInitialization(test.env, events[0])).rejects.toMatchObject({ status: 412 })
    else await consumeAccountInitialization(test.env, events[0])
    const account = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(id)
    const extra = JSON.parse(account.ui_config_json).extra
    expect(extra.keep).toBe(true)
    expect(account).toMatchObject({ health_status: 'unhealthy', last_health_error: 'preserve' })
    expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(id)).toEqual(before)
    if (['incomplete', 'network', 'oversized', 'race'].includes(scenario)) expect(extra).not.toHaveProperty('openai_responses_supported')
    else expect(extra.openai_responses_supported).toBe(scenario !== 'unsupported')
    if (scenario === 'proxy') expect(direct).not.toHaveBeenCalled()
  })

  it('rolls back batch account and vault creation if the initialization outbox cannot commit', async () => {
    const test = fixture()
    test.raw.exec("CREATE TRIGGER fail_initialization BEFORE INSERT ON account_initialization_jobs BEGIN SELECT RAISE(ABORT, 'outbox failed'); END")
    const response = await test.app.request('/accounts/batch', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: [{ name: 'Atomic init', platform: 'openai', type: 'oauth', credentials: { access_token: 'secret' } }] }) }, test.env)
    expect(response.status).toBe(200)
    expect((await response.json() as any).data).toMatchObject({ success: 0, failed: 1 })
    for (const table of ['accounts', 'account_secrets', 'account_initialization_jobs']) expect(test.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count).toBe(0)
  })

  it.each(['success', 'blocked', 'failure', 'transport', 'interrupted'])('initializes single OAuth privacy before responding: %s', async scenario => {
    const test = fixture()
    const send = vi.fn(async () => {})
    test.env.EVENTS_QUEUE = { send } as unknown as Queue
    const fetcher = vi.fn(async () => {
      if (scenario === 'transport') throw new Error('network unavailable')
      if (scenario === 'interrupted') test.raw.exec('UPDATE accounts SET control_version=control_version+1')
      return new Response(scenario === 'blocked' ? 'Just a moment cloudflare' : '', { status: scenario === 'blocked' ? 403 : scenario === 'failure' ? 500 : 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const request = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'single-privacy-initialization' },
      body: JSON.stringify({ name: 'Single OAuth privacy', platform: 'openai', type: 'oauth', credentials: { access_token: 'single-access', refresh_token: 'single-refresh' }, extra: { keep: true, privacy_mode: 'training_off' } }) }
    const response = await test.app.request('/accounts', request, test.env)
    expect(response.status).toBe(201)
    const account = (await response.json() as any).data
    expect(fetcher).toHaveBeenCalledTimes(1)
    const job = test.raw.prepare('SELECT * FROM account_initialization_jobs WHERE account_id=?').get(account.id)
    if (scenario === 'interrupted') {
      expect(job.status).toBe('pending')
      expect(account.control_version).toBe(1)
    } else {
      const mode = scenario === 'success' ? 'training_off' : scenario === 'blocked' ? 'training_set_cf_blocked' : 'training_set_failed'
      expect(account.extra).toMatchObject({ keep: true, privacy_mode: mode })
      expect(account.control_version).toBe(0)
      expect(job).toMatchObject({ status: 'completed', result_mode: mode })
      expect(send).not.toHaveBeenCalled()
    }
    const replay = await test.app.request('/accounts', request, test.env)
    expect(replay.status).toBe(200)
    expect((await replay.json() as any).data).toEqual(account)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'blocked', 'send-failed', 'race', 'duplicate', 'rotated', 'deleted', 'lease'])('durably initializes batch OAuth privacy: %s', async scenario => {
    const test = fixture(); const sent: any[] = []
    const send = vi.fn(async (event: unknown) => { if (scenario === 'send-failed' && sent.length === 0) { sent.push(event); throw new Error('queue offline') }; sent.push(event) })
    test.env.EVENTS_QUEUE = { send } as unknown as Queue
    const response = await test.app.request('/accounts/batch', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'batch-init-key' },
      body: JSON.stringify({ accounts: [{ name: 'Queued privacy', platform: 'openai', type: 'oauth', credentials: { access_token: 'queued-access', refresh_token: 'queued-refresh' }, extra: { keep: true } }] }) }, test.env)
    expect(response.status).toBe(200)
    const id = (await response.json() as any).data.results[0].id
    expect(sent).toHaveLength(1)
    expect(isAccountInitializationEvent(sent[0])).toBe(true)
    expect(JSON.stringify(sent[0])).not.toContain('queued-access')
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe(scenario === 'rotated' ? 'Bearer rotated-access' : 'Bearer queued-access')
      if (scenario === 'race' && fetcher.mock.calls.length === 1) test.raw.prepare("UPDATE accounts SET control_version=control_version+1,ui_config_json=json_set(ui_config_json,'$.extra.newer',1) WHERE id=?").run(id)
      return scenario === 'blocked' ? new Response('Just a moment cloudflare', { status: 403 }) : new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetcher)
    if (scenario === 'rotated') {
      const updated = await test.app.request(`/accounts/${id}/apply-oauth-credentials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'oauth', credentials: { access_token: 'rotated-access' } }) }, test.env)
      expect(updated.status).toBe(200)
    }
    if (scenario === 'deleted') test.raw.prepare('DELETE FROM accounts WHERE id=?').run(id)
    if (scenario === 'lease') test.raw.prepare("UPDATE account_initialization_jobs SET status='running',lease_token='expired',lease_until_ms=0,next_dispatch_at_ms=0 WHERE account_id=?").run(id)
    if (scenario === 'send-failed' || scenario === 'lease') {
      test.raw.prepare('UPDATE account_initialization_jobs SET next_dispatch_at_ms=0 WHERE account_id=?').run(id)
      await dispatchAccountInitializations(test.env)
      expect(sent).toHaveLength(2)
    }
    if (scenario === 'race') {
      await expect(consumeAccountInitialization(test.env, sent[0])).rejects.toMatchObject({ status: 412 })
      expect(test.raw.prepare('SELECT status FROM account_initialization_jobs WHERE account_id=?').get(id).status).toBe('pending')
    }
    const ack = vi.fn(), retry = vi.fn()
    await consumeEvents({ messages: [{ body: sent[0], ack, retry }] } as unknown as MessageBatch<unknown>, test.env)
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled()
    if (scenario === 'deleted') { expect(fetcher).not.toHaveBeenCalled(); return }
    const job = test.raw.prepare('SELECT * FROM account_initialization_jobs WHERE account_id=?').get(id)
    expect(job).toMatchObject({ status: 'completed', result_mode: scenario === 'blocked' ? 'training_set_cf_blocked' : 'training_off' })
    const account = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(id)
    expect(JSON.parse(account.ui_config_json).extra).toMatchObject({ keep: true, privacy_mode: job.result_mode })
    if (scenario === 'race') expect(JSON.parse(account.ui_config_json).extra.newer).toBe(1)
    const count = fetcher.mock.calls.length
    await consumeAccountInitialization(test.env, sent[0]); await dispatchAccountInitializations(test.env)
    expect(fetcher).toHaveBeenCalledTimes(count)
  })

  it.each(['partial', 'replay', 'resume', 'changed', 'invalid-billing'])('creates accounts through the original batch contract with safe retry: %s', async scenario => {
    const test = fixture()
    const accounts = [{ name: 'First batch', platform: 'openai', type: 'apikey', credentials: { api_key: 'batch-secret', base_url: 'https://api.openai.test' } },
      { name: 'Second batch', platform: 'openai', type: 'oauth', credentials: { access_token: 'batch-oauth-secret' },
        ...(scenario === 'partial' ? { group_ids: ['missing-group'] } : {}),
        ...(scenario === 'invalid-billing' ? { extra: { openai_long_context_billing_enabled: 'invalid' } } : {}) }]
    const send = (items: unknown = accounts) => test.app.request('/accounts/batch', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'batch-create-key' }, body: JSON.stringify({ accounts: items }) }, test.env)
    if (scenario === 'resume') {
      const prepare = test.env.DB.prepare.bind(test.env.DB)
      let reject = true
      vi.spyOn(test.env.DB, 'prepare').mockImplementation(sql => {
        if (reject && sql.includes("UPDATE control_idempotency SET resource_type = 'account_batch'")) { reject = false; throw new Error('completion unavailable') }
        return prepare(sql)
      })
      expect((await send()).status).toBe(500)
      expect(test.raw.prepare('SELECT COUNT(*) AS count FROM accounts').get().count).toBe(2)
    }
    const response = await send()
    expect(response.status).toBe(scenario === 'invalid-billing' ? 400 : 200)
    if (scenario === 'invalid-billing') { expect(test.raw.prepare('SELECT COUNT(*) AS count FROM accounts').get().count).toBe(0); return }
    const text = await response.text(); expect(text).not.toContain('batch-secret'); expect(text).not.toContain('batch-oauth-secret')
    const data = JSON.parse(text).data
    expect(data).toMatchObject({ success: scenario === 'partial' ? 1 : 2, failed: scenario === 'partial' ? 1 : 0, results: [{ name: 'First batch', id: expect.any(String), success: true },
      scenario === 'partial' ? { name: 'Second batch', success: false, error: expect.any(String) } : { name: 'Second batch', id: expect.any(String), success: true }] })
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM account_secrets').get().count).toBe(data.success)
    const secret = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(data.results[0].id)
    expect(await decryptCredential(secret.nonce_b64, secret.ciphertext_b64, MASTER_KEY, credentialAad('test', data.results[0].id, secret.id, 1))).toMatchObject({ api_key: 'batch-secret' })
    if (scenario === 'changed') {
      expect((await send([{ ...accounts[0], name: 'Different' }])).status).toBe(409)
    } else {
      const replay = await send(); expect(replay.status).toBe(200); expect((await replay.json() as any).data).toEqual(data)
    }
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM accounts').get().count).toBe(data.success)
  })

  it.each(['account_uuid', 'org_uuid', 'intercept_warmup_requests', 'null', 'duplicate', 'missing', 'partial'])('implements original batch credential field update: %s', async scenario => {
    const test = fixture(); const first = await createProvider(test, 'openai'); const second = await createProvider(test, 'anthropic')
    test.raw.exec("UPDATE accounts SET enabled=0, health_status='unhealthy', last_health_error='preserve', ui_config_json=json_set(ui_config_json,'$.schedulable',json('false'),'$.extra.keep',1)")
    const beforeFirst = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(first.id)
    const beforeSecond = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(second.id)
    const field = ['account_uuid', 'org_uuid', 'intercept_warmup_requests'].includes(scenario) ? scenario : 'org_uuid'
    const value = scenario === 'null' ? null : field === 'intercept_warmup_requests' ? true : 'new-uuid'
    if (scenario === 'partial') test.raw.exec(`CREATE TRIGGER fail_batch_field BEFORE UPDATE ON account_secrets WHEN OLD.account_id='${second.id}' BEGIN SELECT RAISE(ABORT, 'vault failure'); END`)
    const ids = [first.id, scenario === 'missing' ? 'missing-account' : scenario === 'duplicate' ? first.id : second.id]
    const response = await test.app.request('/accounts/batch-update-credentials', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_ids: ids, field, value }) }, test.env)
    expect(response.status).toBe(scenario === 'missing' ? 404 : 200)
    if (scenario === 'missing') {
      expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(first.id)).toEqual(beforeFirst)
      return
    }
    const data = (await response.json() as any).data
    expect(data).toMatchObject({ success: scenario === 'partial' ? 1 : 2, failed: scenario === 'partial' ? 1 : 0, success_ids: scenario === 'partial' ? [first.id] : ids })
    if (scenario === 'partial') {
      expect(data.failed_ids).toEqual([second.id]); expect(data.results[1].success).toBe(false)
      expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(second.id)).toEqual(beforeSecond)
    }
    const stored = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(first.id)
    expect(await decryptCredential(stored.nonce_b64, stored.ciphertext_b64, MASTER_KEY, credentialAad('test', first.id, stored.id, stored.key_version)))
      .toMatchObject({ api_key: 'openai-secret-value', [field]: value })
    const account = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(first.id)
    expect(account).toMatchObject({ enabled: 0, health_status: 'unhealthy', last_health_error: 'preserve' })
    expect(JSON.parse(account.ui_config_json)).toMatchObject({ schedulable: false, extra: { keep: 1 }, credentials: { [field]: value } })
    expect(JSON.stringify(data)).not.toContain('openai-secret-value')
  })

  it.each([{ field: 'api_key', value: 'forbidden' }, { field: 'org_uuid', value: 5 }, { field: 'intercept_warmup_requests', value: 'true' }])('rejects invalid batch credential field input before writes', async input => {
    const test = fixture(); const account = await createProvider(test, 'openai')
    const before = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
    const response = await test.app.request('/accounts/batch-update-credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_ids: [account.id], ...input }) }, test.env)
    expect(response.status).toBe(400)
    expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)).toEqual(before)
  })

  it.each(['structured', 'plain', 'invalid', 'expired', 'missing', 'reason-expired'])('reads original temporary scheduling detail and list filter: %s', async scenario => {
    const test = fixture(); const account = await createProvider(test, 'openai')
    const until = Math.floor(Date.now() / 1000) + 600
    const reason = scenario === 'plain' ? 'upstream maintenance' : scenario === 'invalid' ? '{bad json'
      : JSON.stringify({ status_code: 401, matched_keyword: 'expired token', triggered_at_unix: until - 600,
        rule_index: 2, trigger_count: 3, ...(scenario === 'reason-expired' ? { until_unix: 1 } : {}) })
    const ui = scenario === 'missing' ? {} : { temp_unschedulable_until: new Date((scenario === 'expired' ? 1 : until) * 1000).toISOString(), temp_unschedulable_reason: reason }
    test.raw.prepare('UPDATE accounts SET ui_config_json=? WHERE id=?').run(JSON.stringify(ui), account.id)
    const response = await test.app.request(`/accounts/${account.id}/temp-unschedulable`, {}, test.env)
    expect(response.status).toBe(200)
    const data = (await response.json() as any).data
    const active = !['expired', 'missing', 'reason-expired'].includes(scenario)
    expect(data.active).toBe(active)
    if (active) expect(data.state).toMatchObject({ until_unix: until, error_message: ['plain', 'invalid'].includes(scenario) ? reason : '' })
    if (scenario === 'structured') expect(data.state).toMatchObject({ status_code: 401, trigger_count: 3, rule_index: 2 })
    const listing = await test.app.request('/accounts?status=temp_unschedulable', {}, test.env)
    expect(listing.status).toBe(200)
    expect((await listing.json() as any).data.total).toBe(['expired', 'missing'].includes(scenario) ? 0 : 1)
  })

  it.each(['temp', 'recover'])('clears original runtime state with distinct %s semantics', async action => {
    const test = fixture(); const account = await createProvider(test, 'openai')
    const until = '2099-01-01T00:00:00Z'
    const ui = { schedulable: false, temp_unschedulable_until: until, temp_unschedulable_reason: 'reason',
      overload_until: until, rate_limit_reset_at: until, rate_limited_at: until,
      extra: { quota_used: 4, keep: true, model_rate_limits: { model: {} }, antigravity_quota_scopes: { images: {} } } }
    test.raw.prepare("UPDATE accounts SET ui_config_json=?, enabled=0, health_status='unhealthy', last_health_error='preserve' WHERE id=?").run(JSON.stringify(ui), account.id)
    const secret = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
    const response = await test.app.request(`/accounts/${account.id}/${action === 'temp' ? 'temp-unschedulable' : 'recover-state'}`, { method: action === 'temp' ? 'DELETE' : 'POST' }, test.env)
    expect(response.status).toBe(200)
    const row = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id)
    const after = JSON.parse(row.ui_config_json)
    expect(after).not.toHaveProperty('temp_unschedulable_until'); expect(after).not.toHaveProperty('temp_unschedulable_reason')
    expect(after.extra).not.toHaveProperty('model_rate_limits')
    expect(after).toMatchObject({ schedulable: false, extra: { quota_used: 4, keep: true } })
    expect(row.enabled).toBe(0)
    if (action === 'temp') { expect(after).toMatchObject({ overload_until: until, rate_limit_reset_at: until, extra: { antigravity_quota_scopes: { images: {} } } }); expect(row.health_status).toBe('unhealthy') }
    else { expect(after).not.toHaveProperty('overload_until'); expect(after).not.toHaveProperty('rate_limit_reset_at'); expect(after.extra).not.toHaveProperty('antigravity_quota_scopes'); expect(row.health_status).toBe('unknown') }
    expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)).toEqual(secret)
    expect((await (await test.app.request(`/accounts/${account.id}/temp-unschedulable`, {}, test.env)).json() as any).data).toEqual({ active: false })
  })

  it.each(['success', 'blocked', 'failed', 'transport', 'race', 'proxy'])('persists truthful manual privacy results and preserves account state: %s', async scenario => {
    const test = fixture()
    const created = await test.app.request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'manual-privacy-create' },
      body: JSON.stringify({ name: 'Manual privacy', platform: 'openai', type: 'oauth', credentials: { access_token: 'private-access', refresh_token: 'private-refresh' },
        extra: { privacy_mode: 'training_set_failed', base_rpm: 25, quota_used: 3 } }),
    }, test.env)
    expect(created.status).toBe(201)
    const account = (await created.json() as any).data
    if (scenario === 'proxy') test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(11007,'Manual',json_object('protocol','http','host','proxy.test','port',8080,'status','active'),'bound-proxy-key','','',1,1)")
    if (scenario === 'proxy') test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json, '$.proxy_id', 11007) WHERE id=?").run(account.id)
    test.raw.prepare("UPDATE accounts SET enabled=0, ui_config_json=json_set(ui_config_json,'$.schedulable',json('false')), health_status='unhealthy', last_health_error='keep health' WHERE id=?").run(account.id)
    const before = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id)
    const secret = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://chatgpt.com/backend-api/settings/account_user_setting?feature=training_allowed&value=false')
      expect(init.method).toBe('PATCH')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-access')
      if (scenario === 'race') test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json, '$.extra.concurrent', 1), control_version=control_version+1 WHERE id=?").run(account.id)
      if (scenario === 'transport') throw new Error('private transport details')
      return scenario === 'blocked' ? new Response('Just a moment cloudflare', { status: 403 })
        : scenario === 'failed' ? new Response('denied private-access', { status: 401 }) : new Response(null, { status: 204 })
    })
    const direct = vi.fn((url: string, init: RequestInit) => upstream(url, init))
    vi.stubGlobal('fetch', direct)
    if (scenario === 'proxy') vi.spyOn(proxyTransport, 'fetchAccountProxy').mockImplementation(async (_env, proxyId, url, init) => {
      expect(proxyId).toBe('11007')
      return upstream(String(url), init!)
    })
    const response = await test.app.request(`/accounts/${account.id}/set-privacy`, { method: 'POST' }, test.env)
    expect(response.status).toBe(scenario === 'race' ? 412 : 200)
    const result = await response.text()
    expect(result).not.toContain('private-access')
    expect(result).not.toContain('private-refresh')
    const after = test.raw.prepare('SELECT * FROM accounts WHERE id=?').get(account.id)
    expect(after).toMatchObject({ enabled: 0, health_status: 'unhealthy', last_health_error: 'keep health', credential_ref: before.credential_ref })
    expect(JSON.parse(after.ui_config_json).schedulable).toBe(false)
    const expectedMode = scenario === 'blocked' ? 'training_set_cf_blocked' : ['failed', 'transport', 'race'].includes(scenario) ? 'training_set_failed' : 'training_off'
    expect(JSON.parse(after.ui_config_json).extra).toMatchObject({ privacy_mode: expectedMode, base_rpm: 25, quota_used: 3 })
    if (scenario === 'race') expect(JSON.parse(after.ui_config_json).extra.concurrent).toBe(1)
    else expect(JSON.parse(result).data.extra.privacy_mode).toBe(expectedMode)
    expect(test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)).toEqual(secret)
    expect(upstream).toHaveBeenCalledTimes(1)
    if (scenario === 'proxy') expect(direct).not.toHaveBeenCalled()
  })

  it('rejects manual privacy for an API key without contacting the provider', async () => {
    const test = fixture()
    const account = await createProvider(test, 'openai')
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await test.app.request(`/accounts/${account.id}/set-privacy`, { method: 'POST' }, test.env)).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['training_off', 'training_set_failed'])('preserves original privacy ensure semantics while refreshing %s', async previousMode => {
    const test = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: previousMode === 'training_off' ? 200 : 500 })))
    const created = await test.app.request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'privacy-refresh-create' },
      body: JSON.stringify({ name: 'Privacy refresh', platform: 'openai', type: 'oauth', credentials: { access_token: 'original-access', refresh_token: 'original-refresh' },
        extra: { privacy_mode: previousMode, base_rpm: 25 } }),
    }, test.env)
    const account = (await created.json() as any).data
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('auth.openai.com')
      ? Response.json({ access_token: 'fresh-access', expires_in: 3600 }) : new Response('Just a moment cloudflare', { status: 403 })))
    const response = await test.app.request(`/accounts/${account.id}/refresh`, { method: 'POST', headers: { 'if-match': '"0"', 'idempotency-key': 'privacy-refresh' }, body: '{}' }, test.env)
    expect(response.status).toBe(200)
    expect((await response.json() as any).data.extra).toMatchObject({ base_rpm: 25,
      privacy_mode: previousMode === 'training_off' ? 'training_off' : 'training_set_cf_blocked' })
    const stored = test.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
    expect(await decryptCredential(stored.nonce_b64, stored.ciphertext_b64, MASTER_KEY, credentialAad('test', account.id, stored.id, 2)))
      .toMatchObject({ api_key: 'fresh-access', access_token: 'fresh-access', refresh_token: 'original-refresh' })
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

it('uses the saved Grok default endpoint for real health calls and preserves explicit endpoint overrides',async()=>{
 const test=fixture()
 const create=await test.app.request('/accounts',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'grok-default'},body:JSON.stringify({name:'Grok default',platform:'grok',api_key:'grok-private-key',base_url:''})},test.env)
 expect(create.status,await create.clone().text()).toBe(201);const account=(await create.json() as any).data
 expect(account.provider_config).toMatchObject({use_default_base_url:true})
 const upstream=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{expect(new Headers(init?.headers).get('authorization')).toBe('Bearer grok-private-key');return Response.json({data:[{id:'grok-4.6'}]})})
 const probe=()=>test.app.request('/accounts/'+account.id+'/test',{method:'POST'},test.env)
 test.raw.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").run(JSON.stringify({grok_default_base_url_mode:'eu-west-1'}))
 expect((await probe()).status).toBe(200);expect(String(upstream.mock.calls.at(-1)![0])).toBe('https://eu-west-1.api.x.ai/v1/models')
 const version=test.raw.prepare('SELECT control_version FROM accounts WHERE id=?').get(account.id).control_version
 const change=await test.app.request('/accounts/'+account.id,{method:'PUT',headers:{'content-type':'application/json','if-match':'"'+version+'"','idempotency-key':'grok-explicit'},body:JSON.stringify({base_url:'https://custom-grok.test/v1'})},test.env)
 expect(change.status,await change.clone().text()).toBe(200)
 test.raw.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").run(JSON.stringify({grok_default_base_url_mode:'cli'}))
 expect((await probe()).status).toBe(200);expect(String(upstream.mock.calls.at(-1)![0])).toBe('https://custom-grok.test/v1/models')
 test.raw.close()
})
