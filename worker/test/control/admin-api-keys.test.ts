import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

interface ApiKeyRow {
  id: string
  user_id: string
  key_hash: string
  name: string
  enabled: number
  expires_at_ms: number | null
  last_used_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
  group_id: string
  key_prefix: string
  auth_version: number
  control_version: number
  revoked_at_ms: number | null
}

class KeyStatement {
  values: unknown[] = []

  constructor(
    readonly query: string,
    private readonly database: KeyDatabase,
  ) {}

  bind(...values: unknown[]): KeyStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM admin_sessions')) {
      return { session_id: 'session-1', user_id: 'admin-1' } as T
    }
    if (this.query.includes('FROM control_idempotency')) {
      return (this.database.idempotency.get(`${this.values[0]}:${this.values[1]}`) ?? null) as T | null
    }
    if (this.query.includes('COUNT(*) AS total')) {
      const userId = String(this.values[0])
      return { total: [...this.database.keys.values()].filter((key) => key.user_id === userId).length } as T
    }
    if (this.query.includes('FROM users')) {
      return (this.values[0] === 'user-1'
        ? { id: 'user-1', status: 'active' }
        : null) as T | null
    }
    if (this.query.includes('FROM "groups"')) {
      return (['group-1', 'group-2'].includes(String(this.values[0]))
        ? { id: String(this.values[0]), enabled: 1 }
        : null) as T | null
    }
    if (this.query.includes('FROM api_keys')) {
      return (this.database.keys.get(String(this.values[0])) ?? null) as T | null
    }
    throw new Error(`Unexpected first query: ${this.query}`)
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.query.includes('INSERT INTO control_idempotency')) {
      if (this.database.failControlIdempotencyInsertOnce) {
        this.database.failControlIdempotencyInsertOnce = false
        throw new Error('simulated idempotency insert failure')
      }
      const [scope, keyHash, requestHash, resourceType, resourceId, responseJson, createdAt, expiresAt] = this.values
      this.database.idempotency.set(`${scope}:${keyHash}`, {
        scope,
        key_hash: keyHash,
        request_hash: requestHash,
        resource_type: resourceType,
        resource_id: resourceId,
        response_json: responseJson,
        created_at_ms: createdAt,
        expires_at_ms: expiresAt,
      })
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('UPDATE api_keys') && this.query.includes('revoked_at_ms')) {
      const [now, _updatedAt, id] = this.values
      const key = this.database.keys.get(String(id))
      if (key !== undefined && key.revoked_at_ms === null) {
        key.enabled = 0
        key.revoked_at_ms = Number(now)
        key.updated_at_ms = Number(now)
        key.auth_version += 1
        key.control_version += 1
      }
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('UPDATE api_keys') && this.query.includes('SET name = ?')) {
      const [
        name,
        groupId,
        enabled,
        expiresAt,
        authVersion,
        expectedControlVersion,
        controlVersion,
        updatedAt,
        id,
      ] = this.values
      const key = this.database.keys.get(String(id))
      let changes = 0
      if (key !== undefined && key.control_version !== Number(expectedControlVersion)) {
        throw new Error('CHECK constraint failed: control_version >= 0')
      }
      if (key !== undefined) {
        key.name = String(name)
        key.group_id = String(groupId)
        key.enabled = Number(enabled)
        key.expires_at_ms = expiresAt === null ? null : Number(expiresAt)
        key.auth_version = Number(authVersion)
        key.control_version = Number(controlVersion)
        key.updated_at_ms = Number(updatedAt)
        changes = 1
      }
      return {
        success: true,
        results: [],
        meta: { changes } as D1Meta & Record<string, unknown>,
      }
    }
    if (this.query.includes('INSERT INTO api_keys')) {
      const [id, userId, keyHash, name, expiresAt, now, _updatedAt, groupId, keyPrefix] = this.values
      this.database.keys.set(String(id), {
        id: String(id),
        user_id: String(userId),
        key_hash: String(keyHash),
        name: String(name),
        enabled: 1,
        expires_at_ms: expiresAt === null ? null : Number(expiresAt),
        last_used_at_ms: null,
        created_at_ms: Number(now),
        updated_at_ms: Number(now),
        group_id: String(groupId),
        key_prefix: String(keyPrefix),
        auth_version: 1,
        control_version: 0,
        revoked_at_ms: null,
      })
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    throw new Error(`Unexpected run query: ${this.query}`)
  }

  async all<T>(): Promise<D1Result<T>> {
    if (!this.query.includes('FROM api_keys')) {
      throw new Error(`Unexpected all query: ${this.query}`)
    }
    const userId = String(this.values[0])
    const limit = Number(this.values.at(-2))
    const offset = Number(this.values.at(-1))
    return {
      success: true,
      results: [...this.database.keys.values()]
        .filter((key) => key.user_id === userId)
        .slice(offset, offset + limit) as T[],
      meta: {} as D1Meta & Record<string, unknown>,
    }
  }
}

class KeyDatabase {
  readonly keys = new Map<string, ApiKeyRow>()
  readonly idempotency = new Map<string, Record<string, unknown>>()
  beforeApiKeyUpdate: (() => void) | undefined
  failControlIdempotencyInsertOnce = false

  prepare(query: string): KeyStatement {
    return new KeyStatement(query, this)
  }

  async batch(statements: KeyStatement[]): Promise<D1Result<unknown>[]> {
    this.beforeApiKeyUpdate?.()
    this.beforeApiKeyUpdate = undefined
    const keysBefore = new Map([...this.keys].map(([id, key]) => [id, { ...key }]))
    const idempotencyBefore = new Map(
      [...this.idempotency].map(([key, value]) => [key, { ...value }]),
    )
    try {
      const results: D1Result<unknown>[] = []
      for (const statement of statements) {
        if (statement.query.includes('COUNT(*) AS total')) {
          const userId = String(statement.values[0])
          results.push({
            success: true,
            results: [{ total: [...this.keys.values()].filter((key) => key.user_id === userId).length }],
            meta: {} as D1Meta & Record<string, unknown>,
          })
        } else if (statement.query.includes('INSERT INTO') || statement.query.includes('UPDATE ')) {
          results.push(await statement.run())
        } else {
          results.push(await statement.all())
        }
      }
      return results
    } catch (error) {
      this.keys.clear()
      for (const [id, key] of keysBefore) this.keys.set(id, key)
      this.idempotency.clear()
      for (const [key, value] of idempotencyBefore) this.idempotency.set(key, value)
      throw error
    }
  }
}

function env(database: KeyDatabase): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN: 'a'.repeat(32),
    API_KEY_PEPPER: 'p'.repeat(32),
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: database as unknown as D1Database,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
}

const headers = {
  authorization: `Bearer ${'s'.repeat(32)}`,
  'content-type': 'application/json',
  'idempotency-key': 'create-key-alice-0001',
}

describe('admin API keys', () => {
  it('creates one retry-safe API key while persisting only its digest', async () => {
    const database = new KeyDatabase()
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'automation', group_id: 'group-1' }),
    }

    const first = await createApp().request('/api/v1/admin/users/user-1/api-keys', request, env(database))
    const persistedAfterCreate = [...database.keys.values()][0]
    persistedAfterCreate.name = 'changed-later'
    persistedAfterCreate.expires_at_ms = 1
    const second = await createApp().request('/api/v1/admin/users/user-1/api-keys', request, env(database))

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    const firstBody = (await first.json()) as { data: ApiKeyRow & { api_key: string } }
    const secondBody = (await second.json()) as { data: ApiKeyRow & { api_key: string } }
    expect(firstBody.data).toMatchObject({
      user_id: 'user-1',
      name: 'automation',
      group_id: 'group-1',
      enabled: 1,
      auth_version: 1,
    })
    expect(firstBody.data.api_key).toMatch(/^sk-sub2api-[A-Za-z0-9_-]{48}$/)
    expect(secondBody.data).toMatchObject({
      id: firstBody.data.id,
      name: 'automation',
      expires_at_ms: null,
    })
    expect(secondBody.data).not.toHaveProperty('api_key')
    expect(database.keys).toHaveLength(1)
    const persisted = [...database.keys.values()][0]
    expect(persisted.key_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(persisted)).not.toContain(firstBody.data.api_key)
    expect(firstBody.data).not.toHaveProperty('key_hash')
  })

  it('lists redacted keys and revokes a key without incrementing its auth version twice', async () => {
    const database = new KeyDatabase()
    database.keys.set('key-1', {
      id: 'key-1',
      user_id: 'user-1',
      key_hash: 'f'.repeat(64),
      name: 'automation',
      enabled: 1,
      expires_at_ms: null,
      last_used_at_ms: null,
      created_at_ms: 100,
      updated_at_ms: 100,
      group_id: 'group-1',
      key_prefix: 'sk-sub2api-abcd',
      auth_version: 1,
      control_version: 0,
      revoked_at_ms: null,
    })
    const testEnv = env(database)

    const listed = await createApp().request(
      '/api/v1/admin/users/user-1/api-keys?page=1&page_size=20',
      { headers: { authorization: headers.authorization } },
      testEnv,
    )
    const revoked = await createApp().request('/api/v1/admin/api-keys/key-1', {
      method: 'DELETE',
      headers: { authorization: headers.authorization },
    }, testEnv)
    const replayed = await createApp().request('/api/v1/admin/api-keys/key-1', {
      method: 'DELETE',
      headers: { authorization: headers.authorization },
    }, testEnv)

    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as { data: { items: Array<Record<string, unknown>> } }
    expect(listBody.data.items).toHaveLength(1)
    expect(listBody.data.items[0]).not.toHaveProperty('key_hash')
    expect(revoked.status).toBe(200)
    expect(replayed.status).toBe(200)
    await expect(replayed.json()).resolves.toMatchObject({
      code: 0,
      data: { id: 'key-1', enabled: 0, auth_version: 2 },
    })
    expect(database.keys.get('key-1')).toMatchObject({
      enabled: 0,
      auth_version: 2,
    })
  })

  it('updates an API key group and increments auth_version only for the actual change', async () => {
    const database = new KeyDatabase()
    database.keys.set('key-1', {
      id: 'key-1',
      user_id: 'user-1',
      key_hash: 'f'.repeat(64),
      name: 'automation',
      enabled: 1,
      expires_at_ms: null,
      last_used_at_ms: null,
      created_at_ms: 100,
      updated_at_ms: 100,
      group_id: 'group-1',
      key_prefix: 'sk-sub2api-abcd',
      auth_version: 1,
      control_version: 0,
      revoked_at_ms: null,
    })
    const testEnv = env(database)
    const request = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ group_id: 'group-2' }),
    }

    const first = await createApp().request('/api/v1/admin/api-keys/key-1', request, testEnv)
    const replay = await createApp().request('/api/v1/admin/api-keys/key-1', request, testEnv)

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      code: 0,
      data: { id: 'key-1', group_id: 'group-2', auth_version: 2, control_version: 1 },
    })
    expect(database.keys.get('key-1')).toMatchObject({
      group_id: 'group-2',
      auth_version: 2,
      control_version: 1,
    })
  })

  it('rejects a stale API key update instead of rolling back a concurrent change', async () => {
    const database = new KeyDatabase()
    database.keys.set('key-1', {
      id: 'key-1',
      user_id: 'user-1',
      key_hash: 'f'.repeat(64),
      name: 'automation',
      enabled: 1,
      expires_at_ms: null,
      last_used_at_ms: null,
      created_at_ms: 100,
      updated_at_ms: 100,
      group_id: 'group-1',
      key_prefix: 'sk-sub2api-abcd',
      auth_version: 1,
      control_version: 0,
      revoked_at_ms: null,
    })
    database.beforeApiKeyUpdate = () => {
      const key = database.keys.get('key-1')!
      key.enabled = 0
      key.auth_version = 2
      key.control_version = 1
    }

    const response = await createApp().request('/api/v1/admin/api-keys/key-1', {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': 'stale-key-update-0001' },
      body: JSON.stringify({ name: 'renamed' }),
    }, env(database))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'api_key_update_conflict' },
    })
    expect(database.keys.get('key-1')).toMatchObject({
      name: 'automation',
      enabled: 0,
      auth_version: 2,
      control_version: 1,
    })
  })

  it('rolls back an API key update when its idempotency record cannot commit', async () => {
    const database = new KeyDatabase()
    database.keys.set('key-1', {
      id: 'key-1',
      user_id: 'user-1',
      key_hash: 'f'.repeat(64),
      name: 'automation',
      enabled: 1,
      expires_at_ms: null,
      last_used_at_ms: null,
      created_at_ms: 100,
      updated_at_ms: 100,
      group_id: 'group-1',
      key_prefix: 'sk-sub2api-abcd',
      auth_version: 1,
      control_version: 0,
      revoked_at_ms: null,
    })
    database.failControlIdempotencyInsertOnce = true
    const request = {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': 'atomic-key-update-0001' },
      body: JSON.stringify({ group_id: 'group-2' }),
    }

    const failed = await createApp().request('/api/v1/admin/api-keys/key-1', request, env(database))
    expect(failed.status).toBe(500)
    expect(database.keys.get('key-1')).toMatchObject({
      group_id: 'group-1',
      auth_version: 1,
      control_version: 0,
    })
    expect(database.idempotency).toHaveLength(0)

    const retry = await createApp().request('/api/v1/admin/api-keys/key-1', request, env(database))
    expect(retry.status).toBe(200)
    expect(database.keys.get('key-1')).toMatchObject({
      group_id: 'group-2',
      auth_version: 2,
      control_version: 1,
    })
    expect(database.idempotency).toHaveLength(1)
  })
})
