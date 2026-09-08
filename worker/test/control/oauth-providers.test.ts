import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAdminSession } from '../../src/control/admin-auth'
import {
  disableAdminOAuthProvider,
  getAdminOAuthProvider,
  listAdminOAuthProviders,
  upsertAdminOAuthProvider,
} from '../../src/control/oauth-providers'
import type { Env } from '../../src/env'
import { apiKeyDigest, decryptCredential } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const ADMIN_ID = 'admin-oauth-provider'
const SESSION_ID = 'admin-oauth-provider-session'
const SESSION_TOKEN = 'oauth-provider-admin-session-token'
const PEPPER = 'oauth-provider-test-api-key-pepper'
const MASTER_KEY = 'oauth-provider-test-master-key-value'

interface Harness {
  app: Hono<{ Bindings: Env }>
  env: Env
  raw: any
}

async function harness(): Promise<Harness> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, balance_micros,
       state_version, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 'admin', 'active', 0, 0, ?, ?)`,
  ).run(ADMIN_ID, 'oauth-admin@example.test', 'OAuth Admin', now, now)
  raw.prepare(
    `INSERT INTO admin_sessions (
       id, user_id, token_hash, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    SESSION_ID,
    ADMIN_ID,
    await apiKeyDigest(`admin-session:v1:${SESSION_TOKEN}`, PEPPER),
    now,
    now + 60_000,
  )

  const env: Env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ASSETS: {} as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
  const app = new Hono<{ Bindings: Env }>()
  app.use('/providers/*', requireAdminSession)
  app.get('/providers', listAdminOAuthProviders)
  app.put('/providers/:provider', upsertAdminOAuthProvider)
  app.get('/providers/:provider', getAdminOAuthProvider)
  app.post('/providers/:provider/disable', disableAdminOAuthProvider)
  return { app, env, raw }
}

function adminHeaders(idempotencyKey?: string, version?: number): Record<string, string> {
  return {
    authorization: `Bearer ${SESSION_TOKEN}`,
    'content-type': 'application/json',
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
  }
}

function githubInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapter: 'github',
    enabled: true,
    issuer: 'github',
    authorization_endpoint: 'https://github.example.test/login/oauth/authorize',
    token_endpoint: 'https://github.example.test/login/oauth/access_token',
    userinfo_endpoint: 'https://api.github.example.test/user',
    emails_endpoint: 'https://api.github.example.test/user/emails',
    jwks_endpoint: null,
    client_id: 'github-client-id',
    client_secret: 'github-client-secret',
    scopes: ['read:user', 'user:email'],
    allowed_hosts: ['github.example.test', 'api.github.example.test'],
    frontend_callback_path: '/auth/oauth/callback',
    pkce_enabled: true,
    ...overrides,
  }
}

describe('admin OAuth provider control plane', () => {
  it('migrates existing provider credentials and in-flight OAuth references without loss', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 81)
    raw.exec(`INSERT INTO oauth_providers (provider,adapter,issuer,authorization_endpoint,token_endpoint,userinfo_endpoint,jwks_endpoint,client_id,allowed_hosts_json,frontend_callback_path,created_at_ms,updated_at_ms,secret_key_version,secret_nonce_b64,secret_ciphertext_b64) VALUES ('oidc','oidc','https://id.example.test','https://id.example.test/auth','https://id.example.test/token','https://id.example.test/user','https://id.example.test/jwks','client','["id.example.test"]','/auth/oidc/callback',1,1,1,'nonce','ciphertext')`)
    raw.prepare(`INSERT INTO oauth_flows (id,provider,intent,state_hash,browser_token_hash,redirect_to,expires_at_ms,created_at_ms) VALUES ('flow','oidc','login',?,?,'/dashboard',2,1)`).run('a'.repeat(64), 'b'.repeat(64))
    raw.exec('BEGIN')
    applyMigrations(raw, 82)
    raw.exec('COMMIT')
    expect(raw.prepare('SELECT id, provider FROM oauth_flows').get()).toEqual({ id: 'flow', provider: 'oidc' })
    expect(raw.prepare('SELECT secret_ciphertext_b64 FROM oauth_providers').get()).toEqual({ secret_ciphertext_b64: 'ciphertext' })
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    raw.exec(`UPDATE oauth_providers SET jwks_endpoint = NULL`)
  })

  it('allows an OIDC public client with UserInfo only and no client secret', async () => {
    const test = await harness()
    const response = await test.app.request('/providers/oidc', { method: 'PUT', headers: adminHeaders('oidc-public-client', 0), body: JSON.stringify(githubInput({ adapter: 'oidc', issuer: 'https://github.example.test', client_secret: null, advanced: { oidc_connect_token_auth_method: 'none', oidc_connect_validate_id_token: false } })) }, test.env)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ data: { enabled: true, client_secret_configured: false, jwks_endpoint: null } })
  })

  it('resolves OIDC discovery into validated live endpoints and rejects issuer mismatch', async () => {
    const test = await harness()
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token', userinfo_endpoint: 'https://identity.example.test/user', jwks_uri: 'https://identity.example.test/jwks' }))
    try {
      const input = githubInput({ adapter: 'oidc', issuer: 'https://identity.example.test', authorization_endpoint: '', token_endpoint: '', userinfo_endpoint: '', emails_endpoint: null, jwks_endpoint: null, allowed_hosts: ['identity.example.test'], advanced: { oidc_connect_discovery_url: 'https://identity.example.test/.well-known/openid-configuration', oidc_connect_provider_name: 'Company login' } })
      const response = await test.app.request('/providers/oidc', { method: 'PUT', headers: adminHeaders('discovery-create', 0), body: JSON.stringify(input) }, test.env)
      expect(response.status).toBe(201)
      const result = await response.json() as { data: { token_endpoint: string; advanced: Record<string, unknown> } }
      expect(result.data.token_endpoint).toBe('https://identity.example.test/token')
      expect(result.data.advanced.oidc_connect_provider_name).toBe('Company login')
      mock.mockResolvedValue(Response.json({ issuer: 'https://attacker.example.test' }))
      const bad = await test.app.request('/providers/oidc', { method: 'PUT', headers: adminHeaders('discovery-mismatch', 1), body: JSON.stringify(input) }, test.env)
      expect(bad.status).toBe(400)
    } finally { mock.mockRestore() }
  })

  let subject: Harness

  beforeEach(async () => {
    subject = await harness()
  })

  it('atomically saves separate WeChat app credentials and redacts them on read', async () => {
    const body = githubInput({ adapter: 'wechat', issuer: 'wechat', client_id: 'open-app', client_secret: 'base-secret', wechat_variants: { open: { enabled: true, client_id: 'open-app', client_secret: 'open-secret' }, mp: { enabled: true, client_id: 'mp-app', client_secret: 'mp-secret' } } })
    const created = await subject.app.request('/providers/wechat', { method: 'PUT', headers: adminHeaders('wechat-create-variants', 0), body: JSON.stringify(body) }, subject.env)
    expect(created.status, await created.clone().text()).toBe(201)
    const data = (await created.json() as any).data
    expect(data.wechat_variants.mp).toEqual({ enabled: true, client_id: 'mp-app', client_secret_configured: true })
    expect(JSON.stringify(data)).not.toContain('mp-secret')
    const kept = await subject.app.request('/providers/wechat', { method: 'PUT', headers: adminHeaders('wechat-keep-variants', data.control_version), body: JSON.stringify({ ...body, client_secret: undefined, wechat_variants: { mp: { enabled: true, client_id: 'mp-app', client_secret: '' } } }) }, subject.env)
    expect(kept.status).toBe(200)
    const row = subject.raw.prepare("SELECT nonce_b64,ciphertext_b64 FROM oauth_wechat_variants WHERE mode='mp'").get()
    expect(await decryptCredential(row.nonce_b64,row.ciphertext_b64,MASTER_KEY,'wechat-variant:v1:test:mp')).toEqual({ api_key: 'mp-secret' })
    const fetched = await subject.app.request('/providers/wechat', { headers: adminHeaders() }, subject.env)
    expect((await fetched.json() as any).data.wechat_variants).toMatchObject({ open: { client_secret_configured: true }, mp: { client_secret_configured: true } })
  })

  it('creates, gets, and lists a provider without exposing its encrypted client secret', async () => {
    const created = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-create-github', 0),
      body: JSON.stringify(githubInput()),
    }, subject.env)

    expect(created.status).toBe(201)
    expect(created.headers.get('etag')).toMatch(/^"\d+"$/)
    const createdBody = await created.json() as any
    expect(createdBody).toMatchObject({
      code: 0,
      data: {
        schema_version: 1,
        provider: 'github',
        adapter: 'github',
        enabled: true,
        client_id: 'github-client-id',
        client_secret_configured: true,
        scopes: ['read:user', 'user:email'],
        allowed_hosts: ['github.example.test', 'api.github.example.test'],
      },
    })
    expect(JSON.stringify(createdBody)).not.toContain('github-client-secret')

    const stored = subject.raw.prepare(
      `SELECT secret_key_version, secret_nonce_b64, secret_ciphertext_b64
         FROM oauth_providers WHERE provider = 'github'`,
    ).get()
    expect(stored.secret_ciphertext_b64).not.toContain('github-client-secret')
    await expect(decryptCredential(
      stored.secret_nonce_b64,
      stored.secret_ciphertext_b64,
      MASTER_KEY,
      `oauth-provider-secret/test/github/${stored.secret_key_version}`,
    )).resolves.toEqual({ api_key: 'github-client-secret' })

    const fetched = await subject.app.request('/providers/github', {
      headers: adminHeaders(),
    }, subject.env)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('etag')).toBe(created.headers.get('etag'))
    await expect(fetched.json()).resolves.toEqual(createdBody)

    const listed = await subject.app.request('/providers', {
      headers: adminHeaders(),
    }, subject.env)
    expect(listed.status).toBe(200)
    const listedBody = await listed.json() as any
    expect(listedBody).toMatchObject({
      code: 0,
      data: { total: 1, items: [{ provider: 'github', client_secret_configured: true }] },
    })
    expect(JSON.stringify(listedBody)).not.toContain('github-client-secret')
  })

  it('rejects enabling a new provider without a client secret', async () => {
    const response = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-create-without-secret', 0),
      body: JSON.stringify(githubInput({ client_secret: undefined })),
    }, subject.env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'oauth_client_secret_required' })
    expect(subject.raw.prepare(
      `SELECT COUNT(*) AS total FROM oauth_providers WHERE provider = 'github'`,
    ).get()).toEqual({ total: 0 })
  })

  it('retains an existing secret when enabling but rejects clearing it while enabled', async () => {
    const created = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-create-disabled', 0),
      body: JSON.stringify(githubInput({ enabled: false })),
    }, subject.env)
    const createdBody = await created.json() as any
    const enabled = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-enable-retained-secret', createdBody.data.control_version),
      body: JSON.stringify(githubInput({ enabled: true, client_secret: undefined })),
    }, subject.env)
    const enabledBody = await enabled.json() as any

    expect(enabled.status).toBe(200)
    expect(enabledBody.data).toMatchObject({ enabled: true, client_secret_configured: true })

    const rejected = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-clear-enabled-secret', enabledBody.data.control_version),
      body: JSON.stringify(githubInput({ enabled: true, client_secret: null })),
    }, subject.env)

    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({ code: 'oauth_client_secret_required' })
    const fetched = await subject.app.request('/providers/github', { headers: adminHeaders() }, subject.env)
    await expect(fetched.json()).resolves.toMatchObject({
      data: {
        control_version: enabledBody.data.control_version,
        enabled: true,
        client_secret_configured: true,
      },
    })
  })

  it('rejects enabling an existing provider that has no stored client secret', async () => {
    const created = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-create-disabled-without-secret', 0),
      body: JSON.stringify(githubInput({ enabled: false, client_secret: undefined })),
    }, subject.env)
    const createdBody = await created.json() as any
    expect(created.status).toBe(201)
    expect(createdBody.data).toMatchObject({ enabled: false, client_secret_configured: false })

    const rejected = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-enable-without-stored-secret', createdBody.data.control_version),
      body: JSON.stringify(githubInput({ enabled: true, client_secret: undefined })),
    }, subject.env)

    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({ code: 'oauth_client_secret_required' })
  })

  it('replays identical mutations and applies update and disable with optimistic concurrency', async () => {
    const createRequest = {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-cas-create', 0),
      body: JSON.stringify(githubInput()),
    }
    const created = await subject.app.request('/providers/github', createRequest, subject.env)
    const createdBody = await created.json() as any
    const firstVersion = createdBody.data.control_version as number

    const replayed = await subject.app.request('/providers/github', createRequest, subject.env)
    expect(replayed.status).toBe(200)
    await expect(replayed.json()).resolves.toEqual(createdBody)
    expect(subject.raw.prepare(
      "SELECT COUNT(*) AS total FROM auth_audit_events WHERE event_type = 'admin.oauth_provider.upsert'",
    ).get()).toEqual({ total: 1 })

    const updated = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-cas-update', firstVersion),
      body: JSON.stringify(githubInput({ client_secret: undefined, scopes: ['read:user'] })),
    }, subject.env)
    expect(updated.status).toBe(200)
    const updatedBody = await updated.json() as any
    expect(updatedBody.data).toMatchObject({
      enabled: true,
      client_secret_configured: true,
      scopes: ['read:user'],
    })
    expect(updatedBody.data.control_version).toBeGreaterThan(firstVersion)

    const stale = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-cas-stale', firstVersion),
      body: JSON.stringify(githubInput({ client_secret: undefined, scopes: ['user:email'] })),
    }, subject.env)
    expect(stale.status).toBe(412)
    await expect(stale.json()).resolves.toMatchObject({ code: 'oauth_provider_version_conflict' })

    const idempotencyConflict = await subject.app.request('/providers/github', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-cas-update', updatedBody.data.control_version),
      body: JSON.stringify(githubInput({ client_secret: undefined, scopes: ['user:email'] })),
    }, subject.env)
    expect(idempotencyConflict.status).toBe(409)
    await expect(idempotencyConflict.json()).resolves.toMatchObject({ code: 'idempotency_conflict' })

    const disabled = await subject.app.request('/providers/github/disable', {
      method: 'POST',
      headers: adminHeaders('oauth-provider-disable', updatedBody.data.control_version),
      body: '{}',
    }, subject.env)
    expect(disabled.status).toBe(200)
    const disabledBody = await disabled.json() as any
    expect(disabledBody.data).toMatchObject({ enabled: false, client_secret_configured: true })
    expect(disabledBody.data.control_version).toBeGreaterThan(updatedBody.data.control_version)
    expect(subject.raw.prepare(
      "SELECT COUNT(*) AS total FROM auth_audit_events WHERE event_type LIKE 'admin.oauth_provider.%'",
    ).get()).toEqual({ total: 3 })
  })

  it('rejects unsafe endpoints, host drift, malformed callbacks, invalid adapters, and oversized scopes', async () => {
    const cases: Array<{
      name: string
      provider?: string
      input: Record<string, unknown>
      code: string
    }> = [
      {
        name: 'plain HTTP endpoint',
        input: githubInput({ authorization_endpoint: 'http://github.example.test/authorize' }),
        code: 'invalid_authorization_endpoint',
      },
      {
        name: 'endpoint host outside allow-list',
        input: githubInput({ token_endpoint: 'https://tokens.example.test/token' }),
        code: 'invalid_token_endpoint',
      },
      {
        name: 'OIDC without JWKS',
        provider: 'oidc',
        input: githubInput({
          adapter: 'oidc',
          issuer: 'https://id.example.test',
          authorization_endpoint: 'https://id.example.test/authorize',
          token_endpoint: 'https://id.example.test/token',
          userinfo_endpoint: 'https://id.example.test/userinfo',
          emails_endpoint: null,
          jwks_endpoint: null,
          allowed_hosts: ['id.example.test'],
        }),
        code: 'invalid_jwks_endpoint',
      },
      {
        name: 'external callback',
        input: githubInput({ frontend_callback_path: 'https://attacker.example/callback' }),
        code: 'invalid_frontend_callback_path',
      },
      {
        name: 'provider adapter mismatch',
        input: githubInput({ adapter: 'standard' }),
        code: 'invalid_adapter',
      },
      {
        name: 'too many scopes',
        input: githubInput({ scopes: Array.from({ length: 33 }, (_, index) => `scope-${index}`) }),
        code: 'invalid_scopes',
      },
    ]

    for (const [index, testCase] of cases.entries()) {
      const response = await subject.app.request(`/providers/${testCase.provider ?? 'github'}`, {
        method: 'PUT',
        headers: adminHeaders(`oauth-provider-invalid-${index}`, 0),
        body: JSON.stringify(testCase.input),
      }, subject.env)
      expect(response.status, testCase.name).toBe(400)
      await expect(response.json(), testCase.name).resolves.toMatchObject({ code: testCase.code })
    }

    const unsupported = await subject.app.request('/providers/not-a-provider', {
      method: 'PUT',
      headers: adminHeaders('oauth-provider-invalid-name', 0),
      body: JSON.stringify(githubInput()),
    }, subject.env)
    expect(unsupported.status).toBe(400)
    await expect(unsupported.json()).resolves.toMatchObject({ code: 'invalid_oauth_provider' })
  })
})
