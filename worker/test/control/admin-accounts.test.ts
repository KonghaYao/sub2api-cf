import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { decryptCredential } from '../../src/gateway/crypto'
import { credentialAad } from '../../src/gateway/repository'
import {
  createAdminAccount,
  deleteAdminAccount,
  deleteAdminAccountGroupLink,
  deleteAdminAccountModelCapability,
  getAdminAccount,
  listAdminAccounts,
  putAdminAccountGroupLink,
  putAdminAccountModelCapability,
  testAdminAccount,
  updateAdminAccount,
} from '../../src/control/accounts'

type Row = Record<string, any>

class Statement {
  values: unknown[] = []
  constructor(readonly sql: string, private readonly db: MemoryDb) {}
  bind(...values: unknown[]) { this.values = values; return this }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM control_idempotency')) {
      return (this.db.idempotency.get(`${this.values[0]}:${this.values[1]}`) ?? null) as T | null
    }
    if (this.sql.includes('FROM accounts a') && this.sql.includes('WHERE a.id = ?')) {
      return this.db.project(String(this.values[0])) as T | null
    }
    if (this.sql.includes('SELECT COUNT(*) AS total') && this.sql.includes('FROM "groups"')) {
      const [expectedPlatform, ...ids] = this.values
      const platforms = ids
        .map((id) => this.db.groups.get(String(id)))
        .filter((platform): platform is string => platform !== undefined)
      return {
        total: platforms.length,
        mismatched: platforms.filter((platform) => platform !== expectedPlatform).length,
      } as T
    }
    if (this.sql.includes('SELECT COUNT(*) AS total') && this.sql.includes('FROM models')) {
      const [expectedPlatform, ...ids] = this.values
      const platforms = ids
        .map((id) => this.db.models.get(String(id)))
        .filter((platform): platform is string => platform !== undefined)
      return {
        total: platforms.length,
        mismatched: platforms.filter((platform) => platform !== expectedPlatform).length,
      } as T
    }
    if (this.sql.includes('FROM "groups"')) {
      const platform = this.db.groups.get(String(this.values[0]))
      return (platform ? { id: this.values[0], platform } : null) as T | null
    }
    if (this.sql.includes('FROM models')) {
      const platform = this.db.models.get(String(this.values[0]))
      return (platform ? { id: this.values[0], platform } : null) as T | null
    }
    const relation = this.sql.includes('FROM account_groups') ? this.db.groupLinks : this.db.modelCaps
    if (this.sql.includes('FROM account_groups') || this.sql.includes('FROM account_models')) {
      return (relation.has(`${this.values[0]}:${this.values[1]}`) ? { id: this.values[1] } : null) as T | null
    }
    throw new Error(`Unexpected first SQL: ${this.sql}`)
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.db.failOn && this.sql.includes(this.db.failOn)) {
      this.db.failOn = undefined
      throw new Error('forced batch failure')
    }
    if (this.sql.includes('SELECT COUNT(*) AS total')) {
      return result([{ total: [...this.db.accounts.values()].filter((row) => supported(row) && this.db.secrets.get(String(row.credential_ref))?.account_id === row.id).length }], 0)
    }
    if (this.sql.includes('FROM accounts a') && this.sql.includes('ORDER BY a.updated_at_ms')) {
      const limit = Number(this.values.at(-2)); const offset = Number(this.values.at(-1))
      return result([...this.db.accounts.values()].filter(supported).slice(offset, offset + limit).map((row) => this.db.project(row.id)!), 0)
    }
    if (this.sql.includes('INSERT INTO accounts')) {
      const [
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
        provider_config_json, image_adapter, credential_kind, billing_rate_multiplier_ppm,
      ] = this.values
      if ([...this.db.accounts.values()].some((row) => row.name === name)) {
        throw new Error('UNIQUE constraint failed: accounts.platform, accounts.name')
      }
      this.db.accounts.set(String(id), {
        id, name, credential_ref, enabled, max_concurrency, created_at_ms, updated_at_ms, base_url,
        platform, protocol, auth_scheme, provider_config_json, image_adapter, credential_kind,
        billing_rate_multiplier_ppm,
        config_version: 1,
        control_version: 0, health_status: 'unknown', last_checked_at_ms: null,
        last_latency_ms: null, last_health_error: null,
      })
      return result()
    }
    if (this.sql.includes('UPDATE accounts') && this.sql.includes('SET health_status = ?')) {
      const [health_status, checked, latency, error, id, config, credential] = this.values
      this.db.beforeHealth?.(); this.db.beforeHealth = undefined
      const row = this.db.accounts.get(String(id))
      if (!row || row.config_version !== config || row.credential_ref !== credential) return result([], 0)
      Object.assign(row, { health_status, last_checked_at_ms: checked, last_latency_ms: latency, last_health_error: error })
      return result()
    }
    if (this.sql.includes('UPDATE accounts') && this.sql.includes('control_version = CASE')) {
      const [
        name, enabled, max, base, providerConfig, imageAdapter, credentialKind,
        billingRateMultiplier, config, expected, control, reset, , , , updated, id,
      ] = this.values
      const row = this.db.accounts.get(String(id))
      if (!row) return result([], 0)
      if (row.control_version !== expected) throw new Error('CHECK constraint failed: control_version >= 0')
      Object.assign(row, {
        name,
        enabled,
        max_concurrency: max,
        base_url: base,
        provider_config_json: providerConfig,
        image_adapter: imageAdapter,
        credential_kind: credentialKind,
        billing_rate_multiplier_ppm: billingRateMultiplier,
        config_version: config,
        control_version: control,
        updated_at_ms: updated,
      })
      if (reset === 1) Object.assign(row, { health_status: 'unknown', last_checked_at_ms: null, last_latency_ms: null, last_health_error: null })
      return result()
    }
    if (this.sql.includes('INSERT INTO account_secrets')) {
      const [id, account_id, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms] = this.values
      this.db.secrets.set(String(id), { id, account_id, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms, key_version: 1 })
      return result()
    }
    if (this.sql.includes('UPDATE account_secrets')) {
      const [expected, key_version, nonce_b64, ciphertext_b64, updated_at_ms, id, account_id] = this.values
      const row = this.db.secrets.get(String(id))
      if (!row || row.account_id !== account_id) return result([], 0)
      if (row.key_version !== expected) throw new Error('CHECK constraint failed: key_version > 0')
      Object.assign(row, { key_version, nonce_b64, ciphertext_b64, updated_at_ms }); return result()
    }
    if (this.sql.includes('INSERT INTO account_groups')) {
      const [account_id, group_id, priority, weight, created_at_ms, updated_at_ms] = this.values
      const key = `${account_id}:${group_id}`; const old = this.db.groupLinks.get(key)
      this.db.groupLinks.set(key, { account_id, group_id, priority, weight, created_at_ms: old?.created_at_ms ?? created_at_ms, updated_at_ms, control_version: old ? old.control_version + 1 : 0 })
      return result()
    }
    if (this.sql.includes('DELETE FROM account_groups')) {
      this.deleteRelations(this.db.groupLinks); return result()
    }
    if (this.sql.includes('INSERT INTO account_models')) {
      const [
        account_id, model_id, chat_completions, responses, embeddings, image_generation,
        created_at_ms, updated_at_ms,
      ] = this.values
      const key = `${account_id}:${model_id}`; const old = this.db.modelCaps.get(key)
      this.db.modelCaps.set(key, { account_id, model_id, chat_completions, responses, embeddings, image_generation, created_at_ms: old?.created_at_ms ?? created_at_ms, updated_at_ms, control_version: old ? old.control_version + 1 : 0 })
      return result()
    }
    if (this.sql.includes('DELETE FROM account_models')) {
      this.deleteRelations(this.db.modelCaps); return result()
    }
    if (this.sql.includes('INSERT INTO control_idempotency')) {
      const [scope, keyHash, requestHash, resourceType, resourceId, responseJson, createdAt, expiresAt] = this.values
      this.db.idempotency.set(`${scope}:${keyHash}`, { scope, key_hash: keyHash, request_hash: requestHash, resource_type: resourceType, resource_id: resourceId, response_json: responseJson, created_at_ms: createdAt, expires_at_ms: expiresAt })
      return result()
    }
    throw new Error(`Unexpected run SQL: ${this.sql}`)
  }

  private deleteRelations(map: Map<string, Row>) {
    const accountId = String(this.values[0]); const resourceId = this.values[1]
    for (const [key, row] of map) if (row.account_id === accountId && (resourceId === undefined || row.group_id === resourceId || row.model_id === resourceId)) map.delete(key)
  }
}

class MemoryDb {
  accounts = new Map<string, Row>()
  secrets = new Map<string, Row>()
  groupLinks = new Map<string, Row>()
  modelCaps = new Map<string, Row>()
  idempotency = new Map<string, Row>()
  groups = new Map([['group-a', 'openai'], ['group-b', 'openai']])
  models = new Map([['model-a', 'openai'], ['model-b', 'openai']])
  failOn?: string
  beforeHealth?: () => void
  prepare(sql: string) { return new Statement(sql, this) }
  async batch(statements: Statement[]) {
    const snapshot = structuredClone({ accounts: this.accounts, secrets: this.secrets, groupLinks: this.groupLinks, modelCaps: this.modelCaps, idempotency: this.idempotency })
    try { return await Promise.all(statements.map((statement) => statement.run())) }
    catch (error) {
      this.accounts = snapshot.accounts; this.secrets = snapshot.secrets; this.groupLinks = snapshot.groupLinks
      this.modelCaps = snapshot.modelCaps; this.idempotency = snapshot.idempotency; throw error
    }
  }
  project(id: string): Row | null {
    const account = this.accounts.get(id); if (!account) return null
    const secret = this.secrets.get(String(account.credential_ref)); if (!secret) return null
    const links = [...this.groupLinks.values()].filter((row) => row.account_id === id).map(stripInternal)
    const caps = [...this.modelCaps.values()].filter((row) => row.account_id === id).map(stripInternal)
    return { ...account, provider_config_json: account.provider_config_json ?? '{}', secret_id: secret.id, key_version: secret.key_version, nonce_b64: secret.nonce_b64, ciphertext_b64: secret.ciphertext_b64, group_links_json: JSON.stringify(links), model_capabilities_json: JSON.stringify(caps) }
  }
}

function stripInternal({ account_id: _account, created_at_ms: _created, updated_at_ms: _updated, ...row }: Row) { return row }
function supported(row: Row) {
  return row.base_url != null && (
    (row.platform === 'openai' && row.protocol === 'openai' && row.auth_scheme === 'bearer') ||
    (row.platform === 'anthropic' && row.protocol === 'anthropic' && row.auth_scheme === 'x-api-key') ||
    (row.platform === 'gemini' && row.protocol === 'gemini' && row.auth_scheme === 'x-goog-api-key') ||
    (row.platform === 'codex' && row.protocol === 'codex' && row.auth_scheme === 'bearer')
  )
}
function result(results: unknown[] = [], changes = 1): D1Result<unknown> { return { success: true, results, meta: { changes } as D1Meta & Record<string, unknown> } }
function env(db: MemoryDb): Env {
  return { APP_VERSION: 'test', ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: 'm'.repeat(32), ASSETS: {} as Fetcher, DB: db as unknown as D1Database, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace, API_KEY_LIMIT_STATE: {} as DurableObjectNamespace }
}
function createApp() {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/accounts', listAdminAccounts); app.post('/accounts', createAdminAccount)
  app.get('/accounts/:id', getAdminAccount); app.put('/accounts/:id', updateAdminAccount); app.delete('/accounts/:id', deleteAdminAccount)
  app.put('/accounts/:id/groups/:group_id', putAdminAccountGroupLink); app.delete('/accounts/:id/groups/:group_id', deleteAdminAccountGroupLink)
  app.put('/accounts/:id/models/:model_id', putAdminAccountModelCapability); app.delete('/accounts/:id/models/:model_id', deleteAdminAccountModelCapability)
  app.post('/accounts/:id/test', testAdminAccount); return app
}
const input = { name: 'primary', base_url: 'https://api.example.com/v1/', api_key: 'upstream-secret-value', max_concurrency: 7, group_links: [{ group_id: 'group-a', priority: 2, weight: 3 }], model_capabilities: [{ model_id: 'model-a', chat_completions: true, responses: false }] }
function create(db: MemoryDb, key = 'account-create-1') { return createApp().request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input) }, env(db)) }
async function json(response: Response): Promise<any> { return response.json() }

afterEach(() => vi.unstubAllGlobals())

describe('admin account control plane', () => {
  it('creates idempotently with encrypted, never-returned credentials', async () => {
    const db = new MemoryDb(); const created = await create(db); const payload = await json(created)
    const replay = await create(db)
    expect(created.status).toBe(201); expect(replay.status).toBe(200); expect(await json(replay)).toEqual(payload)
    expect(JSON.stringify(payload)).not.toContain(input.api_key); expect(db.accounts).toHaveLength(1); expect(db.secrets).toHaveLength(1)
    const account = [...db.accounts.values()][0]; const secret = [...db.secrets.values()][0]
    expect(JSON.stringify([account, secret])).not.toContain(input.api_key)
    expect((await decryptCredential(secret.nonce_b64, secret.ciphertext_b64, 'm'.repeat(32), credentialAad('test', account.id, secret.id, 1))).api_key).toBe(input.api_key)
    expect(payload.data).toMatchObject({ base_url: 'https://api.example.com/v1', status: 'active', config_version: 1, control_version: 0, credentials_status: { has_api_key: true } })
    expect(payload.data.model_capabilities).toEqual([
      expect.objectContaining({ model_id: 'model-a', embeddings: false, image_generation: false }),
    ])
  })

  it('creates and updates an embeddings-only account model capability', async () => {
    const db = new MemoryDb()
    const createdResponse = await createApp().request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'account-embeddings' },
      body: JSON.stringify({
        ...input,
        model_capabilities: [{
          model_id: 'model-a',
          chat_completions: false,
          responses: false,
          embeddings: true,
        }],
      }),
    }, env(db))
    const created = await json(createdResponse)

    expect(createdResponse.status).toBe(201)
    expect(created.data.model_capabilities).toEqual([
      expect.objectContaining({
        model_id: 'model-a',
        chat_completions: false,
        responses: false,
        embeddings: true,
      }),
    ])

    const updatedResponse = await createApp().request(`/accounts/${created.data.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({
        model_capabilities: [{
          model_id: 'model-b',
          chat_completions: false,
          responses: false,
          embeddings: true,
        }],
      }),
    }, env(db))
    const updated = await json(updatedResponse)

    expect(updatedResponse.status).toBe(200)
    expect(updated.data.model_capabilities).toEqual([
      expect.objectContaining({ model_id: 'model-b', embeddings: true }),
    ])
  })

  it('lists/details safe projections and replaces routing plus credential atomically on partial update', async () => {
    const db = new MemoryDb(); const created = await json(await create(db)); const id = created.data.id
    db.accounts.set('unsupported', { ...db.accounts.get(id), id: 'unsupported', credential_ref: 'unsupported-secret', platform: 'vertex' })
    db.secrets.set('unsupported-secret', { ...db.secrets.values().next().value, id: 'unsupported-secret', account_id: 'unsupported' })
    const list = await json(await createApp().request('/accounts', {}, env(db)))
    expect(list.data.total).toBe(1); expect(list.data.items[0].group_links[0]).toMatchObject({ group_id: 'group-a' })
    const detail = await json(await createApp().request(`/accounts/${id}`, {}, env(db)))
    expect(detail.data).toMatchObject({ id, credentials_status: { has_api_key: true } })
    const response = await createApp().request(`/accounts/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"0"' }, body: JSON.stringify({ api_key: 'rotated-secret', max_concurrency: 11, group_links: [{ group_id: 'group-b' }], model_capabilities: [{ model_id: 'model-b' }] }) }, env(db))
    const updated = await json(response)
    expect(response.status).toBe(200); expect(updated.data).toMatchObject({ name: 'primary', max_concurrency: 11, config_version: 2, control_version: 1, credential_key_version: 2, group_links: [{ group_id: 'group-b' }], model_capabilities: [{ model_id: 'model-b' }] })
    expect(JSON.stringify(updated)).not.toContain('rotated-secret')
    const secret = [...db.secrets.values()][0]
    expect((await decryptCredential(secret.nonce_b64, secret.ciphertext_b64, 'm'.repeat(32), credentialAad('test', id, secret.id, 2))).api_key).toBe('rotated-secret')
  })

  it('round-trips an exact decimal account rate multiplier through ppm storage', async () => {
    const db = new MemoryDb()
    const createdResponse = await createApp().request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'account-rate-create' },
      body: JSON.stringify({ ...input, rate_multiplier: 1.25 }),
    }, env(db))
    const created = await json(createdResponse)
    expect(createdResponse.status).toBe(201)
    expect(created.data.rate_multiplier).toBe(1.25)
    expect(created.data).not.toHaveProperty('billing_rate_multiplier_ppm')
    expect(db.accounts.get(created.data.id)?.billing_rate_multiplier_ppm).toBe(1_250_000)

    const updatedResponse = await createApp().request(`/accounts/${created.data.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ rate_multiplier: 0 }),
    }, env(db))
    expect(updatedResponse.status).toBe(200)
    expect((await json(updatedResponse)).data.rate_multiplier).toBe(0)
    expect(db.accounts.get(created.data.id)?.billing_rate_multiplier_ppm).toBe(0)

    const maximumResponse = await createApp().request(`/accounts/${created.data.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '1' },
      body: JSON.stringify({ rate_multiplier: 10 }),
    }, env(db))
    expect(maximumResponse.status).toBe(200)
    expect((await json(maximumResponse)).data.rate_multiplier).toBe(10)

    for (const invalid of [-1, 0.0000001, 10.000001, Number.MAX_SAFE_INTEGER]) {
      const response = await createApp().request(`/accounts/${created.data.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '2' },
        body: JSON.stringify({ rate_multiplier: invalid }),
      }, env(db))
      expect(response.status).toBe(400)
      expect((await json(response)).code).toBe('invalid_rate_multiplier')
    }
  })

  it('enforces If-Match, rolls failed batches back, and soft-disables without deleting links/secrets', async () => {
    const db = new MemoryDb(); const created = await json(await create(db)); const id = created.data.id
    const stale = await createApp().request(`/accounts/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '4' }, body: JSON.stringify({ name: 'bad' }) }, env(db))
    expect(stale.status).toBe(412); expect(db.accounts.get(id)?.name).toBe('primary')
    const removed = await json(await createApp().request(`/accounts/${id}`, { method: 'DELETE', headers: { 'if-match': '0' } }, env(db)))
    expect(removed.data).toMatchObject({ status: 'inactive', config_version: 2, control_version: 1 }); expect(db.secrets).toHaveLength(1); expect(db.groupLinks).toHaveLength(1)
    const failed = new MemoryDb(); failed.failOn = 'INSERT INTO account_models'
    expect((await create(failed, 'account-create-fails')).status).toBe(500)
    expect(failed.accounts).toHaveLength(0); expect(failed.secrets).toHaveLength(0); expect(failed.idempotency).toHaveLength(0)
  })

  it('mutates individual group/model links while advancing the parent CAS versions', async () => {
    const db = new MemoryDb(); const created = await json(await create(db)); const id = created.data.id
    expect((await createApp().request(`/accounts/${id}/groups/group-b`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '0' }, body: JSON.stringify({ priority: 8, weight: 2 }) }, env(db))).status).toBe(200)
    expect((await createApp().request(`/accounts/${id}/models/model-b`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '1' }, body: JSON.stringify({ chat_completions: false, responses: true }) }, env(db))).status).toBe(200)
    expect((await createApp().request(`/accounts/${id}/groups/group-b`, { method: 'DELETE', headers: { 'if-match': '2' } }, env(db))).status).toBe(200)
    expect((await createApp().request(`/accounts/${id}/models/model-b`, { method: 'DELETE', headers: { 'if-match': '3' } }, env(db))).status).toBe(200)
    expect(db.groupLinks.has(`${id}:group-b`)).toBe(false); expect(db.modelCaps.has(`${id}:model-b`)).toBe(false)
    expect(db.accounts.get(id)).toMatchObject({ config_version: 5, control_version: 4 })
  })

  it('probes strict HTTPS /models with bearer auth, without overwriting concurrently changed config', async () => {
    const db = new MemoryDb(); const created = await json(await create(db)); const id = created.data.id
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}')); vi.stubGlobal('fetch', fetchMock)
    const healthy = await json(await createApp().request(`/accounts/${id}/test`, { method: 'POST' }, env(db)))
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.objectContaining({ redirect: 'manual' }))
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${input.api_key}`)
    expect(healthy.data).toMatchObject({ health_status: 'healthy', config_version: 1, control_version: 0 })
    db.beforeHealth = () => { db.accounts.get(id)!.config_version += 1; db.accounts.get(id)!.control_version += 1 }
    const stale = await createApp().request(`/accounts/${id}/test`, { method: 'POST' }, env(db))
    expect(stale.status).toBe(409); expect((await json(stale)).code).toBe('account_probe_stale')
    expect(db.accounts.get(id)).toMatchObject({ health_status: 'healthy', config_version: 2, control_version: 1 })
  })

  it('rejects unsupported/private upstream configuration', async () => {
    const db = new MemoryDb()
    const invalid = await createApp().request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-account-1' }, body: JSON.stringify({ ...input, base_url: 'http://127.0.0.1/v1' }) }, env(db))
    const unsupported = await createApp().request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-account-2' }, body: JSON.stringify({ ...input, platform: 'vertex' }) }, env(db))
    expect(invalid.status).toBe(400); expect(unsupported.status).toBe(409); expect(db.accounts).toHaveLength(0)
  })

  it('bounds relationship replacement batches before querying D1', async () => {
    const db = new MemoryDb()
    const tooManyGroups = Array.from({ length: 41 }, (_, index) => ({ group_id: `group-${index}` }))
    const tooManyModels = Array.from({ length: 41 }, (_, index) => ({ model_id: `model-${index}` }))

    const groupResponse = await createApp().request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'too-many-groups' },
      body: JSON.stringify({ ...input, group_links: tooManyGroups }),
    }, env(db))
    const modelResponse = await createApp().request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'too-many-models' },
      body: JSON.stringify({ ...input, model_capabilities: tooManyModels }),
    }, env(db))

    expect(groupResponse.status).toBe(400)
    expect((await json(groupResponse)).code).toBe('invalid_group_links')
    expect(modelResponse.status).toBe(400)
    expect((await json(modelResponse)).code).toBe('invalid_model_capabilities')
    expect(db.accounts).toHaveLength(0)
  })
})
