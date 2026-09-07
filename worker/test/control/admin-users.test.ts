import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

interface UserRow {
  id: string
  email: string
  email_verified_at_ms?: number | null
  display_name: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  balance_micros: number
  concurrency?: number
  rpm_limit?: number
  password_credential?: string | null
  auth_version?: number
  password_changed_at_ms?: number | null
  state_version: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

class UserStatement {
  values: unknown[] = []

  constructor(
    readonly query: string,
    private readonly database: UserDatabase,
  ) {}

  bind(...values: unknown[]): UserStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
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
      return { total: this.database.users.size } as T
    }
    if (this.query.includes("role = 'admin'") && this.query.includes('id <> ?')) {
      const excludedId = String(this.values[0])
      return ([...this.database.users.values()].find((user) =>
        user.id !== excludedId && user.role === 'admin' && user.status === 'active') ?? null) as T | null
    }
    if (this.query.includes('FROM users') && this.query.includes('WHERE id = ?')) {
      return (this.database.users.get(String(this.values[0])) ?? null) as T | null
    }
    if (this.query.includes('FROM users') && this.query.includes('WHERE email = ?')) {
      const email = String(this.values[0]).toLowerCase()
      return ([...this.database.users.values()].find((user) => user.email === email) ?? null) as T | null
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
    if (this.query.includes('UPDATE users') && this.query.includes('SET email = ?')) {
      const [email, displayName, role] = this.values
      const expectedControlVersion = this.values.at(-4)
      const controlVersion = this.values.at(-3)
      const updatedAt = this.values.at(-2)
      const id = this.values.at(-1)
      const user = this.database.users.get(String(id))
      let changes = 0
      if (user !== undefined && user.control_version !== Number(expectedControlVersion)) {
        throw new Error('CHECK constraint failed: control_version >= 0')
      }
      if (user !== undefined) {
        if (
          user.role === 'admin' &&
          user.status === 'active' &&
          role !== 'admin' &&
          !this.database.hasOtherActiveAdmin(user.id)
        ) {
          throw new Error('last_active_admin')
        }
        if (user.email !== email && this.query.includes('email_verified_at_ms = CASE')) {
          user.email_verified_at_ms = null
        }
        user.email = String(email)
        user.display_name = String(displayName)
        user.role = role as UserRow['role']
        user.concurrency = Number(this.values[3])
        user.rpm_limit = Number(this.values[4])
        user.control_version = Number(controlVersion)
        user.updated_at_ms = Number(updatedAt)
        changes = 1
      }
      return {
        success: true,
        results: [],
        meta: { changes } as D1Meta & Record<string, unknown>,
      }
    }
    if (this.query.includes('UPDATE user_sessions')) {
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('UPDATE users') && this.query.includes('SET status = ?')) {
      const [status, balanceMicros, stateVersion, updatedAt, id] = this.values
      const user = this.database.users.get(String(id))
      if (user !== undefined && user.state_version < Number(stateVersion)) {
        if (
          user.role === 'admin' &&
          user.status === 'active' &&
          status !== 'active' &&
          !this.database.hasOtherActiveAdmin(user.id)
        ) {
          throw new Error('last_active_admin')
        }
        user.status = status as UserRow['status']
        user.balance_micros = Number(balanceMicros)
        user.state_version = Number(stateVersion)
        user.updated_at_ms = Number(updatedAt)
      }
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('UPDATE users') && this.query.includes('balance_micros')) {
      const [balanceMicros, stateVersion, updatedAt, id] = this.values
      const user = this.database.users.get(String(id))
      if (user !== undefined && user.state_version < Number(stateVersion)) {
        user.balance_micros = Number(balanceMicros)
        user.state_version = Number(stateVersion)
        user.updated_at_ms = Number(updatedAt)
      }
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (this.query.includes('INSERT INTO users')) {
      const [
        id,
        email,
        displayName,
        role,
        balanceMicros,
        concurrency,
        rpmLimit,
        now,
        ,
        passwordCredential,
        passwordChangedAt,
      ] = this.values
      this.database.users.set(String(id), {
        id: String(id),
        email: String(email),
        display_name: String(displayName),
        role: role as UserRow['role'],
        status: 'active',
        balance_micros: Number(balanceMicros),
        concurrency: Number(concurrency),
        rpm_limit: Number(rpmLimit),
        password_credential: passwordCredential === null ? null : String(passwordCredential),
        auth_version: 1,
        password_changed_at_ms: passwordChangedAt === null ? null : Number(passwordChangedAt),
        state_version: 0,
        control_version: 0,
        created_at_ms: Number(now),
        updated_at_ms: Number(now),
      })
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    throw new Error(`Unexpected run query: ${this.query}`)
  }

  async all<T>(): Promise<D1Result<T>> {
    if (
      this.query.includes('FROM user_group_permissions') ||
      this.query.includes('FROM user_group_rate_overrides') ||
      this.query.includes('FROM user_subscriptions')
    ) {
      return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
    }
    if (!this.query.includes('FROM users')) {
      throw new Error(`Unexpected all query: ${this.query}`)
    }
    const limit = Number(this.values.at(-2))
    const offset = Number(this.values.at(-1))
    return {
      success: true,
      results: [...this.database.users.values()].slice(offset, offset + limit) as T[],
      meta: {} as D1Meta & Record<string, unknown>,
    }
  }
}

class UserDatabase {
  readonly users = new Map<string, UserRow>()
  readonly idempotency = new Map<string, Record<string, unknown>>()
  beforeUserUpdate: (() => void) | undefined
  failControlIdempotencyInsertOnce = false
  failNextUserUpdateWithLastSuperAdmin = false

  prepare(query: string): UserStatement {
    return new UserStatement(query, this)
  }

  hasOtherActiveAdmin(userId: string): boolean {
    return [...this.users.values()].some((user) =>
      user.id !== userId && user.role === 'admin' && user.status === 'active')
  }

  async batch(statements: UserStatement[]): Promise<D1Result<unknown>[]> {
    this.beforeUserUpdate?.()
    this.beforeUserUpdate = undefined
    const usersBefore = new Map([...this.users].map(([id, user]) => [id, { ...user }]))
    const idempotencyBefore = new Map(
      [...this.idempotency].map(([key, value]) => [key, { ...value }]),
    )
    try {
      const results: D1Result<unknown>[] = []
      for (const statement of statements) {
        if (statement.query.includes('COUNT(*) AS total')) {
          results.push({
            success: true,
            results: [{ total: this.users.size }],
            meta: {} as D1Meta & Record<string, unknown>,
          })
        } else if (statement.query.includes('INSERT INTO') || statement.query.includes('UPDATE ')) {
          if (
            this.failNextUserUpdateWithLastSuperAdmin &&
            statement.query.includes('UPDATE users')
          ) {
            this.failNextUserUpdateWithLastSuperAdmin = false
            throw new Error('last_super_admin')
          }
          results.push(await statement.run())
        } else {
          results.push(await statement.all())
        }
      }
      return results
    } catch (error) {
      this.users.clear()
      for (const [id, user] of usersBefore) this.users.set(id, user)
      this.idempotency.clear()
      for (const [key, value] of idempotencyBefore) this.idempotency.set(key, value)
      throw error
    }
  }
}

class UserStateStub {
  readonly calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  snapshotBody: Record<string, unknown> | null = null
  adjustedBalanceMicros = 0
  currentUserId = 'user-1'
  enabledResponses: Array<{ enabled: boolean; state_version: number; idempotent?: boolean }> = []

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/snapshot') {
      this.calls.push({ method: 'GET', path, body: {} })
      if (this.snapshotBody === null) {
        return Response.json({ error: { code: 'user_not_configured' } }, { status: 404 })
      }
      return Response.json(this.snapshotBody)
    }
    const body = (await request.json()) as Record<string, unknown>
    this.calls.push({ method: request.method, path, body })
    if (path === '/balance/adjust') {
      return Response.json({
        schema_version: 1,
        idempotent: this.calls.filter((call) => call.path === path).length > 1,
        profile: {
          user_id: this.currentUserId,
          enabled: true,
          balance_micros: this.adjustedBalanceMicros,
          reserved_micros: 0,
          settled_micros: 0,
        },
        state_version: 4,
      })
    }
    if (path === '/enabled') {
      const override = this.enabledResponses.shift()
      return Response.json({
        schema_version: 1,
        idempotent: override?.idempotent ?? this.calls.filter((call) => call.path === path).length > 1,
        profile: {
          user_id: this.currentUserId,
          enabled: override?.enabled ?? body.enabled,
          balance_micros: this.adjustedBalanceMicros,
          reserved_micros: 0,
          settled_micros: 0,
        },
        state_version: override?.state_version ?? 4,
      })
    }
    return Response.json({
      schema_version: 1,
      idempotent: this.calls.length > 1,
      profile: {
        user_id: body.user_id,
        enabled: body.enabled,
        balance_micros: body.balance_micros,
        reserved_micros: 0,
        settled_micros: 0,
      },
    })
  }
}

function harness() {
  const database = new UserDatabase()
  const state = new UserStateStub()
  const stateNames: string[] = []
  const env: Env = {
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
    USER_STATE: {
      idFromName: (name: string) => {
        stateNames.push(name)
        state.currentUserId = name
        return name
      },
      get: () => state,
    } as unknown as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
  return { database, env, state, stateNames }
}

const adminHeaders = {
  authorization: `Bearer ${'s'.repeat(32)}`,
  'content-type': 'application/json',
  'idempotency-key': 'create-alice-0001',
}

describe('admin users', () => {
  it('rejects a list sort that has no Worker projection', async () => {
    const { env } = harness()
    const response = await createApp().request('/api/v1/admin/users?sort_by=definitely_unknown', {
      headers: adminHeaders,
    }, env)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unsupported_user_sort' },
    })
  })

  it('creates a gateway user idempotently in D1 and UserStateDO', async () => {
    const { database, env, state, stateNames } = harness()
    const request = {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email: ' Alice@Example.com ',
        display_name: 'Alice',
        role: 'user',
        balance_micros: 5_000_000,
      }),
    }

    const first = await createApp().request('/api/v1/admin/users', request, env)
    const persistedAfterCreate = [...database.users.values()][0]
    persistedAfterCreate.display_name = 'Changed Later'
    persistedAfterCreate.balance_micros = 1
    const second = await createApp().request('/api/v1/admin/users', request, env)

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    const firstBody = (await first.json()) as { data: UserRow }
    const secondBody = (await second.json()) as { data: UserRow }
    expect(firstBody.data).toMatchObject({
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 5_000_000,
    })
    expect(secondBody.data.id).toBe(firstBody.data.id)
    expect(secondBody.data).toMatchObject({ display_name: 'Alice', balance_micros: 5_000_000 })
    expect(database.users.get(firstBody.data.id)).toMatchObject({
      display_name: 'Changed Later',
      balance_micros: 1,
    })
    expect(database.users).toHaveLength(1)
    expect(stateNames).toEqual([firstBody.data.id, firstBody.data.id])
    expect(state.calls).toHaveLength(2)
    expect(state.calls[0]).toMatchObject({
      method: 'POST',
      path: '/configure',
      body: {
        schema_version: 1,
        user_id: firstBody.data.id,
        balance_micros: 5_000_000,
        enabled: true,
      },
    })
    expect(state.calls[1].body.mutation_id).toBe(state.calls[0].body.mutation_id)
  })

  it('lists a bounded D1 projection without fan-out calls to UserStateDO', async () => {
    const { database, env, state } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_500_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })

    const response = await createApp().request(
      '/api/v1/admin/users?page=1&page_size=20&status=active&role=user&search=alice',
      { headers: { authorization: adminHeaders.authorization } },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: {
        items: [{
          ...database.users.get('user-1'),
          allowed_groups: [],
          group_rates: {},
          current_concurrency: 0,
          last_active_at: null,
          last_used_at: null,
          subscriptions: [],
        }],
        total: 1,
        page: 1,
        page_size: 20,
        pages: 1,
      },
    })
    expect(state.calls).toEqual([])
  })

  it('returns user detail with the authoritative Durable Object balance', async () => {
    const { database, env, state, stateNames } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_500_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })
    state.snapshotBody = {
      schema_version: 1,
      state_version: 3,
      profile: {
        user_id: 'user-1',
        enabled: true,
        balance_micros: 2_000_000,
        reserved_micros: 100_000,
        settled_micros: 500_000,
        updated_at_ms: 300,
      },
      available_micros: 1_900_000,
      requests: [],
      ledger: [],
    }

    const response = await createApp().request(
      '/api/v1/admin/users/user-1',
      { headers: { authorization: adminHeaders.authorization } },
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: {
        id: 'user-1',
        balance_micros: 2_000_000,
        reserved_micros: 100_000,
        settled_micros: 500_000,
        available_micros: 1_900_000,
      },
    })
    expect(stateNames).toEqual(['user-1'])
    expect(state.calls).toEqual([{ method: 'GET', path: '/snapshot', body: {} }])
  })

  it('adjusts the authoritative balance once and then updates the D1 projection', async () => {
    const { database, env, state } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_000_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })
    state.adjustedBalanceMicros = 2_500_000

    const request = {
      method: 'POST',
      headers: { ...adminHeaders, 'idempotency-key': 'balance-alice-0001' },
      body: JSON.stringify({ amount_delta_micros: 500_000 }),
    }
    const response = await createApp().request('/api/v1/admin/users/user-1/balance', request, env)
    const replay = await createApp().request('/api/v1/admin/users/user-1/balance', request, env)

    expect(response.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: { id: 'user-1', balance_micros: 2_500_000 },
    })
    await expect(replay.json()).resolves.toMatchObject({
      code: 0,
      data: { id: 'user-1', balance_micros: 2_500_000, state_version: 4 },
    })
    expect(state.calls.map((call) => call.path)).toEqual([
      '/configure',
      '/balance/adjust',
      '/configure',
      '/balance/adjust',
    ])
    expect(state.calls[1].body).toMatchObject({
      schema_version: 1,
      amount_delta_micros: 500_000,
      actor_user_id: 'admin-1',
      actor_session_id: 'session-1',
    })
    expect(String(state.calls[1].body.mutation_id)).toContain('admin-balance:')
    expect(database.users.get('user-1')).toMatchObject({
      balance_micros: 2_500_000,
      state_version: 4,
    })
  })

  it('updates metadata and disables the Durable Object with one replayable mutation', async () => {
    const { database, env, state } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_000_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })
    state.adjustedBalanceMicros = 2_000_000

    const request = {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'disable-alice-0001' },
      body: JSON.stringify({ display_name: 'Alice Updated', status: 'disabled' }),
    }
    const response = await createApp().request('/api/v1/admin/users/user-1', request, env)
    const replay = await createApp().request('/api/v1/admin/users/user-1', request, env)
    const conflictingReplay = await createApp().request('/api/v1/admin/users/user-1', {
      ...request,
      body: JSON.stringify({ display_name: 'Different Value', status: 'disabled' }),
    }, env)

    expect(response.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(conflictingReplay.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: {
        id: 'user-1',
        display_name: 'Alice Updated',
        status: 'disabled',
        balance_micros: 2_000_000,
        state_version: 4,
      },
    })
    await expect(replay.json()).resolves.toMatchObject({
      code: 0,
      data: { display_name: 'Alice Updated', status: 'disabled', control_version: 1 },
    })
    await expect(conflictingReplay.json()).resolves.toMatchObject({
      error: { code: 'idempotency_conflict' },
    })
    expect(state.calls.map((call) => call.path)).toEqual(['/configure', '/enabled'])
    expect(state.calls[1].body).toMatchObject({ schema_version: 1, enabled: false })
    expect(database.users.get('user-1')).toMatchObject({
      display_name: 'Alice Updated',
      status: 'disabled',
      state_version: 4,
      control_version: 1,
    })
  })

  it('clears email verification when an administrator changes the user email', async () => {
    const { database, env } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      email_verified_at_ms: 123,
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_000_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })

    const response = await createApp().request('/api/v1/admin/users/user-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'change-alice-email-0001' },
      body: JSON.stringify({ email: 'changed@example.com' }),
    }, env)

    expect(response.status).toBe(200)
    expect(database.users.get('user-1')).toMatchObject({
      email: 'changed@example.com',
      email_verified_at_ms: null,
    })
  })

  it('rejects a stale metadata update instead of overwriting a concurrent edit', async () => {
    const { database, env } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_000_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })
    database.beforeUserUpdate = () => {
      const user = database.users.get('user-1')!
      user.email = 'concurrent@example.com'
      user.control_version = 1
    }

    const response = await createApp().request('/api/v1/admin/users/user-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'stale-user-update-0001' },
      body: JSON.stringify({ display_name: 'Stale Rename' }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'user_update_conflict' },
    })
    expect(database.users.get('user-1')).toMatchObject({
      email: 'concurrent@example.com',
      display_name: 'Alice',
      control_version: 1,
    })
  })

  it('rejects an edit based on a stale control version before mutating user state', async () => {
    const { database, env } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_000_000,
      state_version: 3,
      control_version: 2,
      created_at_ms: 100,
      updated_at_ms: 200,
    })

    const response = await createApp().request('/api/v1/admin/users/user-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'stale-user-version-0001' },
      body: JSON.stringify({
        display_name: 'Stale Rename',
        expected_control_version: 1,
      }),
    }, env)

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'user_version_conflict' },
    })
    expect(database.users.get('user-1')).toMatchObject({
      display_name: 'Alice',
      control_version: 2,
    })
  })

  it('conditionally compensates a DO status change when the D1 metadata batch loses CAS', async () => {
    const { database, env, state } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_000_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })
    database.beforeUserUpdate = () => {
      const user = database.users.get('user-1')!
      user.email = 'concurrent@example.com'
      user.control_version = 1
    }

    const response = await createApp().request('/api/v1/admin/users/user-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'mixed-user-update-0001' },
      body: JSON.stringify({ display_name: 'Rejected Rename', status: 'disabled' }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'user_update_conflict' },
    })
    expect(database.users.get('user-1')).toMatchObject({
      email: 'concurrent@example.com',
      display_name: 'Alice',
      status: 'active',
      control_version: 1,
    })
    expect(state.calls.map((call) => call.path)).toEqual([
      '/configure',
      '/enabled',
      '/enabled',
    ])
    expect(state.calls[2].body).toMatchObject({ enabled: true, expected_state_version: 4 })
  })

  it('refuses to disable the last active admin', async () => {
    const { database, env, state } = harness()
    database.users.set('admin-1', {
      id: 'admin-1',
      email: 'admin@example.com',
      display_name: 'Admin',
      role: 'admin',
      status: 'active',
      balance_micros: 0,
      state_version: 0,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 100,
    })

    const response = await createApp().request('/api/v1/admin/users/admin-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'disable-last-admin-0001' },
      body: JSON.stringify({ status: 'disabled' }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'last_active_admin' },
    })
    expect(database.users.get('admin-1')).toMatchObject({ status: 'active', role: 'admin' })
    expect(state.calls).toEqual([])
  })

  it('maps the D1 last-super-admin trigger to a conflict and compensates the Durable Object', async () => {
    const { database, env, state } = harness()
    for (const id of ['admin-1', 'admin-2']) {
      database.users.set(id, {
        id,
        email: `${id}@example.com`,
        display_name: id,
        role: 'admin',
        status: 'active',
        balance_micros: 0,
        state_version: 0,
        control_version: 0,
        created_at_ms: 100,
        updated_at_ms: 100,
      })
    }
    database.failNextUserUpdateWithLastSuperAdmin = true

    const response = await createApp().request('/api/v1/admin/users/admin-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'disable-last-super-admin-0001' },
      body: JSON.stringify({ status: 'disabled' }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'last_super_admin' },
    })
    expect(database.users.get('admin-1')).toMatchObject({ status: 'active', role: 'admin' })
    expect(state.calls.map((call) => call.path)).toEqual([
      '/configure',
      '/enabled',
      '/enabled',
    ])
    expect(state.calls[2].body).toMatchObject({ enabled: true })
  })

  it('rolls back a metadata update when its idempotency record cannot commit', async () => {
    const { database, env } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 2_000_000,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 200,
    })
    database.failControlIdempotencyInsertOnce = true
    const request = {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'atomic-user-update-0001' },
      body: JSON.stringify({ display_name: 'Committed Together' }),
    }

    const failed = await createApp().request('/api/v1/admin/users/user-1', request, env)
    expect(failed.status).toBe(500)
    expect(database.users.get('user-1')).toMatchObject({ display_name: 'Alice', control_version: 0 })
    expect(database.idempotency).toHaveLength(0)

    const retry = await createApp().request('/api/v1/admin/users/user-1', request, env)
    expect(retry.status).toBe(200)
    expect(database.users.get('user-1')).toMatchObject({
      display_name: 'Committed Together',
      control_version: 1,
    })
    expect(database.idempotency).toHaveLength(1)
  })

  it('keeps one admin active when another admin changes during a disable request', async () => {
    const { database, env, state } = harness()
    for (const id of ['admin-1', 'admin-2']) {
      database.users.set(id, {
        id,
        email: `${id}@example.com`,
        display_name: id,
        role: 'admin',
        status: 'active',
        balance_micros: 0,
        state_version: 0,
        control_version: 0,
        created_at_ms: 100,
        updated_at_ms: 100,
      })
    }
    database.beforeUserUpdate = () => {
      database.users.get('admin-2')!.status = 'disabled'
    }

    const response = await createApp().request('/api/v1/admin/users/admin-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'concurrent-admin-disable-0001' },
      body: JSON.stringify({ status: 'disabled' }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'last_active_admin' },
    })
    expect(database.users.get('admin-1')).toMatchObject({ status: 'active' })
    expect(database.users.get('admin-2')).toMatchObject({ status: 'disabled' })
    expect(state.calls.map((call) => call.path)).toEqual([
      '/configure',
      '/enabled',
      '/enabled',
    ])
    expect(state.calls[2].body).toMatchObject({ enabled: true })
  })

  it('projects the current DO status when an old mutation retries after a newer change', async () => {
    const { database, env, state } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 0,
      state_version: 3,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 100,
    })
    state.enabledResponses.push(
      { enabled: false, state_version: 4 },
      { enabled: true, state_version: 5 },
      { enabled: true, state_version: 5 },
    )
    database.failControlIdempotencyInsertOnce = true
    const oldRequest = {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'old-disable-0001' },
      body: JSON.stringify({ status: 'disabled' }),
    }

    const interrupted = await createApp().request('/api/v1/admin/users/user-1', oldRequest, env)
    expect(interrupted.status).toBe(500)

    const newer = await createApp().request('/api/v1/admin/users/user-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'new-enable-0001' },
      body: JSON.stringify({ status: 'active' }),
    }, env)
    expect(newer.status).toBe(200)

    const retried = await createApp().request('/api/v1/admin/users/user-1', oldRequest, env)
    expect(retried.status).toBe(200)
    await expect(retried.json()).resolves.toMatchObject({
      code: 0,
      data: { status: 'active', state_version: 5 },
    })
    expect(database.users.get('user-1')).toMatchObject({ status: 'active', state_version: 5 })
  })

  it('does not compensate an idempotent status replay that reports a newer ABA version', async () => {
    const { database, env, state } = harness()
    database.users.set('user-1', {
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      status: 'active',
      balance_micros: 0,
      state_version: 0,
      control_version: 0,
      created_at_ms: 100,
      updated_at_ms: 100,
    })
    state.enabledResponses.push({ enabled: false, state_version: 3, idempotent: true })
    database.failControlIdempotencyInsertOnce = true

    const response = await createApp().request('/api/v1/admin/users/user-1', {
      method: 'PUT',
      headers: { ...adminHeaders, 'idempotency-key': 'aba-disable-0001' },
      body: JSON.stringify({ status: 'disabled' }),
    }, env)

    expect(response.status).toBe(500)
    expect(state.calls.map((call) => call.path)).toEqual(['/configure', '/enabled'])
    expect(database.users.get('user-1')).toMatchObject({ status: 'active', state_version: 0 })
  })
})
