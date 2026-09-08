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
  group_id: string | null
  key_prefix: string
  auth_version: number
  control_version: number
  revoked_at_ms: number | null
  quota_micros?: number
  quota_used_micros?: number
  rate_limit_5h_micros?: number
  rate_limit_1d_micros?: number
  rate_limit_7d_micros?: number
  usage_5h_micros?: number
  usage_1d_micros?: number
  usage_7d_micros?: number
  window_5h_start_ms?: number | null
  window_1d_start_ms?: number | null
  window_7d_start_ms?: number | null
  quota_reset_epoch?: number
  rate_limit_reset_epoch?: number
  ip_allowlist_json?: string
  ip_denylist_json?: string
}

interface GroupRow {
  id: string
  name: string
  description: string | null
  platform: string
  enabled: number
  rate_multiplier_ppm: number
  group_type: 'standard' | 'subscription'
  is_exclusive: number
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
    if (this.query.includes('FROM runtime_settings')) return null
    if (this.query.includes('SELECT 1 AS allowed') && this.query.includes('FROM admin_user_roles')) {
      return { allowed: 1 } as T
    }
    if (this.query.includes('FROM admin_sessions')) {
      return { session_id: 'session-1', user_id: 'admin-1' } as T
    }
    if (this.query.includes('FROM control_idempotency')) {
      return (this.database.idempotency.get(`${this.values[0]}:${this.values[1]}`) ?? null) as T | null
    }
    if (this.query.includes('COUNT(*) AS total')) {
      const userId = String(this.values[0])
      return {
        total: [...this.database.keys.values()]
          .filter((key) => key.user_id === userId && key.revoked_at_ms === null).length,
      } as T
    }
    if (this.query.includes('FROM users')) {
      return (this.values[0] === 'user-1'
        ? { id: 'user-1', status: 'active' }
        : null) as T | null
    }
    if (this.query.includes('FROM "groups"')) {
      const group = this.database.groups.get(String(this.values[0]))
      return (group === undefined ? null : {
        ...group,
        has_permission: this.database.permissions.has(`${this.values[1]}:${group.id}`) ? 1 : 0,
        has_active_subscription: this.database.activeSubscriptions.has(`${this.values[2]}:${group.id}`) ? 1 : 0,
      }) as T | null
    }
    if (this.query.includes('FROM user_group_permissions')) {
      return (this.database.permissions.has(`${this.values[0]}:${this.values[1]}`)
        ? { user_id: String(this.values[0]) }
        : null) as T | null
    }
    if (this.query.includes('FROM user_subscriptions')) return null
    if (this.query.includes('FROM api_keys')) {
      const key = this.database.keys.get(String(this.values[0]))
      return (key === undefined ? null : this.database.hydrate(key)) as T | null
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
    if (this.query.includes('INSERT INTO auth_audit_events')) {
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('UPDATE api_keys') && this.query.includes('revoked_at_ms')) {
      const [tombstoneHash, now, _updatedAt, id] = this.values
      const key = this.database.keys.get(String(id))
      if (key !== undefined && key.revoked_at_ms === null) {
        key.key_hash = String(tombstoneHash)
        key.enabled = 0
        key.revoked_at_ms = Number(now)
        key.updated_at_ms = Number(now)
        key.auth_version += 1
        key.control_version += 1
      }
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('UPDATE api_keys') && this.query.includes('SET name =')) {
      const guarded = this.query.includes('SET name = CASE')
      const offset = guarded ? 5 : 0
      const [
        name,
        groupId,
        enabled,
        expiresAt,
        authVersion,
        quotaMicros,
        rateLimit5hMicros,
        rateLimit1dMicros,
        rateLimit7dMicros,
        resetQuota,
        resetUsage5h,
        resetUsage1d,
        resetUsage7d,
        resetWindow5h,
        resetWindow1d,
        resetWindow7d,
        bumpQuotaEpoch,
        bumpRateLimitEpoch,
        ipAllowlistJson,
        ipDenylistJson,
        expectedControlVersion,
        controlVersion,
        updatedAt,
        id,
      ] = this.values.slice(offset)
      const key = this.database.keys.get(String(id))
      let changes = 0
      if (guarded && !this.database.isAuthorized(
        String(this.values[1]),
        String(this.values[0]),
      )) {
        throw new Error('NOT NULL constraint failed: api_keys.name')
      }
      if (key !== undefined && key.control_version !== Number(expectedControlVersion)) {
        throw new Error('CHECK constraint failed: control_version >= 0')
      }
      if (key !== undefined) {
        key.name = String(name)
        key.group_id = groupId === null ? null : String(groupId)
        key.enabled = Number(enabled)
        key.expires_at_ms = expiresAt === null ? null : Number(expiresAt)
        key.auth_version = Number(authVersion)
        key.quota_micros = Number(quotaMicros)
        key.rate_limit_5h_micros = Number(rateLimit5hMicros)
        key.rate_limit_1d_micros = Number(rateLimit1dMicros)
        key.rate_limit_7d_micros = Number(rateLimit7dMicros)
        if (Number(resetQuota) === 1) key.quota_used_micros = 0
        if (Number(resetUsage5h) === 1) key.usage_5h_micros = 0
        if (Number(resetUsage1d) === 1) key.usage_1d_micros = 0
        if (Number(resetUsage7d) === 1) key.usage_7d_micros = 0
        if (Number(resetWindow5h) === 1) key.window_5h_start_ms = null
        if (Number(resetWindow1d) === 1) key.window_1d_start_ms = null
        if (Number(resetWindow7d) === 1) key.window_7d_start_ms = null
        if (Number(bumpQuotaEpoch) === 1) {
          key.quota_reset_epoch = (key.quota_reset_epoch ?? 0) + 1
        }
        if (Number(bumpRateLimitEpoch) === 1) {
          key.rate_limit_reset_epoch = (key.rate_limit_reset_epoch ?? 0) + 1
        }
        key.ip_allowlist_json = String(ipAllowlistJson)
        key.ip_denylist_json = String(ipDenylistJson)
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
      const [
        id,
        userId,
        keyHash,
        groupId,
        permissionUserId,
        subscriptionUserId,
        _startsAt,
        _expiresAt,
        name,
        expiresAt,
        now,
        _updatedAt,
        persistedGroupId,
        keyPrefix,
        quotaMicros,
        rateLimit5hMicros,
        rateLimit1dMicros,
        rateLimit7dMicros,
        ipAllowlistJson,
        ipDenylistJson,
      ] = this.values
      if (
        permissionUserId !== userId ||
        subscriptionUserId !== userId ||
        groupId !== persistedGroupId ||
        !this.database.isAuthorized(String(userId), String(groupId))
      ) {
        throw new Error('NOT NULL constraint failed: api_keys.name')
      }
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
        group_id: String(persistedGroupId),
        key_prefix: String(keyPrefix),
        auth_version: 1,
        control_version: 0,
        revoked_at_ms: null,
        quota_micros: Number(quotaMicros),
        quota_used_micros: 0,
        rate_limit_5h_micros: Number(rateLimit5hMicros),
        rate_limit_1d_micros: Number(rateLimit1dMicros),
        rate_limit_7d_micros: Number(rateLimit7dMicros),
        ip_allowlist_json: String(ipAllowlistJson),
        ip_denylist_json: String(ipDenylistJson),
        usage_5h_micros: 0,
        usage_1d_micros: 0,
        usage_7d_micros: 0,
        window_5h_start_ms: null,
        window_1d_start_ms: null,
        window_7d_start_ms: null,
        quota_reset_epoch: 0,
        rate_limit_reset_epoch: 0,
      })
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('INSERT OR IGNORE INTO user_group_permissions')) {
      const group = this.database.groups.get(String(this.values[2]))
      if (group?.enabled === 1 && group.group_type === 'standard' && group.is_exclusive === 1) {
        this.database.permissions.add(`${this.values[0]}:${this.values[2]}`)
      }
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
        .filter((key) => key.user_id === userId && key.revoked_at_ms === null)
        .slice(offset, offset + limit)
        .map((key) => this.database.hydrate(key)) as T[],
      meta: {} as D1Meta & Record<string, unknown>,
    }
  }
}

class KeyDatabase {
  readonly keys = new Map<string, ApiKeyRow>()
  readonly idempotency = new Map<string, Record<string, unknown>>()
  readonly permissions = new Set<string>()
  readonly activeSubscriptions = new Set<string>()
  readonly groups = new Map<string, GroupRow>(['group-1', 'group-2'].map((id) => [id, {
    id,
    name: id,
    description: `${id} description`,
    platform: 'openai',
    enabled: 1,
    rate_multiplier_ppm: 1_000_000,
    group_type: 'standard' as const,
    is_exclusive: 1,
  }]))
  beforeApiKeyUpdate: (() => void) | undefined
  failControlIdempotencyInsertOnce = false

  hydrate(key: ApiKeyRow): ApiKeyRow & Record<string, unknown> {
    const group = key.group_id === null ? undefined : this.groups.get(key.group_id)
    return {
      ...key,
      group_name: group?.name ?? null,
      group_description: group?.description ?? null,
      group_platform: group?.platform ?? null,
      group_enabled: group?.enabled ?? null,
      group_rate_multiplier_ppm: group?.rate_multiplier_ppm ?? null,
      group_type: group?.group_type ?? null,
      group_is_exclusive: group?.is_exclusive ?? null,
    }
  }

  isAuthorized(userId: string, groupId: string): boolean {
    const group = this.groups.get(groupId)
    if (group?.enabled !== 1) return false
    if (group.group_type === 'subscription') {
      return this.activeSubscriptions.has(`${userId}:${groupId}`)
    }
    return group.is_exclusive === 0 || this.permissions.has(`${userId}:${groupId}`)
  }

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
    const permissionsBefore = new Set(this.permissions)
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
        } else if (statement.query.includes('INSERT') || statement.query.includes('UPDATE ')) {
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
      this.permissions.clear()
      for (const permission of permissionsBefore) this.permissions.add(permission)
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
  'if-match': '"0"',
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
    expect(database.permissions).toContain('user-1:group-1')
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
      headers: {
        authorization: headers.authorization,
        'idempotency-key': 'revoke-key-1',
      },
    }, testEnv)
    const replayed = await createApp().request('/api/v1/admin/api-keys/key-1', {
      method: 'DELETE',
      headers: {
        authorization: headers.authorization,
        'idempotency-key': 'revoke-key-1',
      },
    }, testEnv)

    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as { data: { items: Array<Record<string, unknown>> } }
    expect(listBody.data.items).toHaveLength(1)
    expect(listBody.data.items[0]).not.toHaveProperty('key_hash')
    expect(listBody.data.items[0]).toMatchObject({
      group: {
        id: 'group-1',
        name: 'group-1',
        platform: 'openai',
        subscription_type: 'standard',
      },
    })
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
      data: {
        api_key: {
          id: 'key-1',
          group_id: 'group-2',
          status: 'active',
          auth_version: 2,
          control_version: 1,
        },
        auto_granted_group_access: true,
        granted_group_id: 'group-2',
        granted_group_name: 'group-2',
      },
    })
    expect(database.keys.get('key-1')).toMatchObject({
      group_id: 'group-2',
      auth_version: 2,
      control_version: 1,
    })
    expect(database.permissions).toContain('user-1:group-2')
  })

  it.each([false,true])('maps null only to an enabled isolated ungrouped catalog (enabled=%s)', async (enabled) => {
    const database = new KeyDatabase()
    if(enabled)database.groups.set('worker-ungrouped-default',{...database.groups.get('group-1')!,id:'worker-ungrouped-default',platform:'composite',is_exclusive:0})
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

    const response = await createApp().request('/api/v1/admin/api-keys/key-1', {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': 'unbind-key-update-0001' },
      body: JSON.stringify({ group_id: null }),
    }, env(database))

    if(!enabled){expect(response.status).toBe(404);expect(database.keys.get('key-1')?.group_id).toBe('group-1');return}
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: {
        api_key: { id: 'key-1', group_id: 'worker-ungrouped-default', status: 'active', auth_version: 2 },
        auto_granted_group_access: false,
      },
    })
    expect(database.keys.get('key-1')).toMatchObject({
      group_id: 'worker-ungrouped-default',
      auth_version: 2,
      control_version: 1,
    })
  })

  it('requires an active subscription for create and same-group reactivation', async () => {
    const database = new KeyDatabase()
    database.groups.get('group-2')!.group_type = 'subscription'
    database.permissions.add('user-1:group-2')
    database.keys.set('subscription-key', {
      id: 'subscription-key',
      user_id: 'user-1',
      key_hash: 'e'.repeat(64),
      name: 'subscription',
      enabled: 0,
      expires_at_ms: null,
      last_used_at_ms: null,
      created_at_ms: 100,
      updated_at_ms: 100,
      group_id: 'group-2',
      key_prefix: 'sk-sub2api-sub',
      auth_version: 1,
      control_version: 0,
      revoked_at_ms: null,
    })

    const deniedCreate = await createApp().request('/api/v1/admin/users/user-1/api-keys', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'subscription-create-denied' },
      body: JSON.stringify({ name: 'subscription', group_id: 'group-2' }),
    }, env(database))
    const deniedReactivation = await createApp().request(
      '/api/v1/admin/api-keys/subscription-key',
      {
        method: 'PUT',
        headers: { ...headers, 'idempotency-key': 'subscription-reactivate-denied' },
        body: JSON.stringify({ status: 'active' }),
      },
      env(database),
    )

    expect(deniedCreate.status).toBe(409)
    expect(deniedReactivation.status).toBe(409)
    await expect(deniedCreate.json()).resolves.toMatchObject({ code: 'subscription_required' })
    await expect(deniedReactivation.json()).resolves.toMatchObject({ code: 'subscription_required' })
    expect(database.keys.get('subscription-key')?.enabled).toBe(0)

    database.activeSubscriptions.add('user-1:group-2')
    const created = await createApp().request('/api/v1/admin/users/user-1/api-keys', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'subscription-create-allowed' },
      body: JSON.stringify({ name: 'subscription', group_id: 'group-2' }),
    }, env(database))
    const reactivated = await createApp().request('/api/v1/admin/api-keys/subscription-key', {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': 'subscription-reactivate-allowed' },
      body: JSON.stringify({ status: 'active' }),
    }, env(database))
    expect(created.status).toBe(201)
    expect(reactivated.status).toBe(200)
    expect(database.keys.get('subscription-key')?.enabled).toBe(1)
  })

  it('rolls back an exclusive-group grant if authorization changes before the guarded CAS', async () => {
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
      database.groups.get('group-2')!.enabled = 0
    }

    const response = await createApp().request('/api/v1/admin/api-keys/key-1', {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': 'group-disabled-during-update' },
      body: JSON.stringify({ group_id: 'group-2' }),
    }, env(database))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'group_disabled' })
    expect(database.keys.get('key-1')).toMatchObject({ group_id: 'group-1', control_version: 0 })
    expect(database.permissions).not.toContain('user-1:group-2')
    expect(database.idempotency).toHaveLength(0)
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

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'control_version_conflict' },
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
