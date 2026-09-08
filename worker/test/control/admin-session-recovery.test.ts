import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

class RecoveryStatement {
  values: unknown[] = []

  constructor(
    readonly query: string,
    private readonly database: RecoveryDatabase,
  ) {}

  bind(...values: unknown[]): RecoveryStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM runtime_settings')) return null
    if (this.query.includes('FROM users')) return this.database.activeAdmin as T | null
    throw new Error(`Unexpected first query: ${this.query}`)
  }

  async run(): Promise<D1Result<unknown>> {
    this.database.executed.push(this)
    return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
  }
}

class RecoveryDatabase {
  readonly prepared: RecoveryStatement[] = []
  readonly executed: RecoveryStatement[] = []

  constructor(readonly activeAdmin: { id: string } | null) {}

  prepare(query: string): RecoveryStatement {
    const statement = new RecoveryStatement(query, this)
    this.prepared.push(statement)
    return statement
  }
}

const adminToken = 'a'.repeat(32)
const apiKeyPepper = 'p'.repeat(32)

function env(database: RecoveryDatabase): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN: adminToken,
    API_KEY_PEPPER: apiKeyPepper,
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

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('admin session recovery', () => {
  it('exchanges the break-glass token for a hashed 12-hour session of an active admin', async () => {
    const database = new RecoveryDatabase({ id: 'admin-1' })
    const response = await createApp().request('/api/v1/admin/session/recover', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    }, env(database))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as {
      data: { admin_session: string; admin_session_expires_at_ms: number }
    }
    expect(body.data.admin_session).toMatch(/^adm-sub2api-[A-Za-z0-9_-]{48}$/)

    expect(database.executed).toHaveLength(1)
    const insert = database.executed[0]
    expect(insert.query).toContain('INSERT INTO admin_sessions')
    const [, userId, tokenHash, createdAtMs, expiresAtMs] = insert.values
    expect(userId).toBe('admin-1')
    expect(tokenHash).toBe(
      await hmacSha256Hex(apiKeyPepper, `admin-session:v1:${body.data.admin_session}`),
    )
    expect(tokenHash).not.toBe(body.data.admin_session)
    expect(expiresAtMs).toBe(Number(createdAtMs) + 12 * 60 * 60 * 1_000)
    expect(body.data.admin_session_expires_at_ms).toBe(expiresAtMs)
    expect(database.executed.flatMap((statement) => statement.values)).not.toContain(
      body.data.admin_session,
    )
  })

  it('accepts only the break-glass ADMIN_TOKEN at the recovery boundary', async () => {
    const database = new RecoveryDatabase({ id: 'admin-1' })
    const app = createApp()

    const missing = await app.request(
      '/api/v1/admin/session/recover',
      { method: 'POST' },
      env(database),
    )
    const adminSession = await app.request('/api/v1/admin/session/recover', {
      method: 'POST',
      headers: { authorization: `Bearer adm-sub2api-${'s'.repeat(48)}` },
    }, env(database))

    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'admin_token_required' },
    })
    expect(adminSession.status).toBe(401)
    await expect(adminSession.json()).resolves.toMatchObject({
      error: { code: 'invalid_admin_token' },
    })
    expect(database.prepared).toEqual([])
  })

  it('fails without creating a session when no active admin exists', async () => {
    const database = new RecoveryDatabase(null)
    const response = await createApp().request('/api/v1/admin/session/recover', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    }, env(database))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'active_admin_not_found' },
    })
    expect(database.executed).toEqual([])
  })
})
