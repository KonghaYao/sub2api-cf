import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

class BootstrapStatement {
  values: unknown[] = []

  constructor(readonly query: string) {}

  bind(...values: unknown[]): BootstrapStatement {
    this.values = values
    return this
  }
}

class BootstrapDatabase {
  batches: BootstrapStatement[][] = []

  prepare(query: string): BootstrapStatement {
    return new BootstrapStatement(query)
  }

  async batch(statements: BootstrapStatement[]): Promise<D1Result<unknown>[]> {
    this.batches.push(statements)
    return statements.map(() => ({
      success: true,
      results: [],
      meta: {} as D1Meta & Record<string, unknown>,
    }))
  }
}

const adminToken = 'a'.repeat(32)
const apiKeyPepper = 'p'.repeat(32)

function env(database: BootstrapDatabase): Env {
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

describe('gateway bootstrap', () => {
  it('returns an admin session once while persisting only its domain-separated HMAC', async () => {
    const database = new BootstrapDatabase()
    const response = await createApp().request('/api/v1/admin/bootstrap', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        user: {
          email: 'admin@example.com',
          display_name: 'Admin',
          balance_micros: 1_000_000,
        },
        group: { name: 'default' },
        account: {
          name: 'primary',
          base_url: 'https://upstream.example/v1',
          api_key: 'upstream-secret',
        },
        api_key: { name: 'bootstrap' },
        models: [{
          public_name: 'gpt-test',
          input_micros_per_million: 1_000,
          output_micros_per_million: 2_000,
        }],
      }),
    }, env(database))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as {
      data: { admin_session: string; warning: string }
    }
    expect(body.data.admin_session).toMatch(/^adm-sub2api-[A-Za-z0-9_-]{48}$/)
    expect(body.data.warning).toContain('shown only once')

    expect(database.batches).toHaveLength(1)
    const sessionInsert = database.batches[0].find((statement) =>
      statement.query.includes('INSERT INTO admin_sessions'),
    )
    expect(sessionInsert).toBeDefined()
    const persistedHash = sessionInsert?.values[2]
    expect(persistedHash).toBe(
      await hmacSha256Hex(apiKeyPepper, `admin-session:v1:${body.data.admin_session}`),
    )
    expect(persistedHash).not.toBe(body.data.admin_session)
    expect(database.batches[0].flatMap((statement) => statement.values)).not.toContain(
      body.data.admin_session,
    )
  })
})
