import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'admin-api-key-sqlite-pepper-at-least-32-bytes'
const ADMIN_SESSION = 's'.repeat(32)
const ADMIN_ID = 'admin-1'
const USER_ID = 'user-1'
const EXCLUSIVE_GROUP_ID = 'exclusive-group'
const SUBSCRIPTION_GROUP_ID = 'subscription-group'

interface Fixture {
  raw: any
  d1: D1Database
  env: Env
  headers: Record<string, string>
}

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
     VALUES (?, 'admin@example.test', 'Admin', 'admin', 'active', ?, ?),
            (?, 'user@example.test', 'User', 'user', 'active', ?, ?)`,
  ).run(ADMIN_ID, now, now, USER_ID, now, now)
  raw.prepare(
    `INSERT INTO admin_sessions (
       id, user_id, token_hash, created_at_ms, expires_at_ms
     ) VALUES ('admin-session-1', ?, ?, ?, ?)`,
  ).run(
    ADMIN_ID,
    await apiKeyDigest(`admin-session:v1:${ADMIN_SESSION}`, PEPPER),
    now,
    now + 60_000,
  )
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, description, platform, enabled, rate_multiplier_ppm,
       group_type, is_exclusive, created_at_ms, updated_at_ms
     ) VALUES
       (?, 'Exclusive', 'Private standard group', 'openai', 1, 1250000,
        'standard', 1, ?, ?),
       (?, 'Subscription', 'Paid subscription group', 'openai', 1, 1000000,
        'subscription', 1, ?, ?)`,
  ).run(EXCLUSIVE_GROUP_ID, now, now, SUBSCRIPTION_GROUP_ID, now, now)
  const environment = env(d1)
  return {
    raw,
    d1,
    env: environment,
    headers: {
      authorization: `Bearer ${ADMIN_SESSION}`,
      'content-type': 'application/json',
    },
  }
}

function env(database: D1Database): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN: 'a'.repeat(32),
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: database,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
    AUTH_RATE_LIMIT: {} as DurableObjectNamespace,
  }
}


describe('API key last used IP through actual Worker routes', () => {
  it('returns the latest recorded IP to its owner and admin, without crossing key ownership', async () => {
    const test = await fixture()
    const now = Date.now()
    const accessToken = createOpaqueToken('access')
    test.raw.prepare(`INSERT INTO user_sessions (
      id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
      created_at_ms, access_expires_at_ms, refresh_expires_at_ms
    ) VALUES ('ip-session', 'ip-family', ?, 1, ?, ?, ?, ?, ?)`)
      .run(USER_ID, await tokenDigest(accessToken, PEPPER, 'access'),
        await tokenDigest(createOpaqueToken('refresh'), PEPPER, 'refresh'), now, now + 60000, now + 600000)
    test.raw.prepare(`INSERT INTO api_keys (
      id, user_id, key_hash, key_prefix, name, enabled, group_id, created_at_ms, updated_at_ms
    ) VALUES ('ip-key', ?, ?, 'sk-ip', 'IP key', 1, ?, ?, ?),
             ('unused-key', ?, ?, 'sk-unused', 'Unused', 1, ?, ?, ?)`)
      .run(USER_ID, '1'.repeat(64), EXCLUSIVE_GROUP_ID, now, now,
        USER_ID, '2'.repeat(64), EXCLUSIVE_GROUP_ID, now, now)
    const insertObservation = test.raw.prepare(`INSERT INTO request_observations (
      id, request_id, bucket_day, occurred_at_ms, lifecycle, user_id, api_key_id,
      method, request_path, updated_at_ms, client_ip
    ) VALUES (?, ?, 20260907, ?, 'started', ?, 'ip-key', 'POST', '/v1/chat/completions', ?, ?)`)
    insertObservation.run('a'.repeat(32), 'older', now - 3000, USER_ID, now - 3000, '203.0.113.1')
    insertObservation.run('b'.repeat(32), 'latest', now - 2000, USER_ID, now - 2000, '2001:db8::2')
    insertObservation.run('c'.repeat(32), 'missing-ip', now - 1000, USER_ID, now - 1000, null)
    insertObservation.run('d'.repeat(32), 'other-owner', now, ADMIN_ID, now, '203.0.113.99')

    for (const [path, headers] of [
      [`/api/v1/admin/users/${USER_ID}/api-keys`, test.headers],
      ['/api/v1/keys', { authorization: `Bearer ${accessToken}` }],
    ] as const) {
      const response = await createApp().request(path, { headers }, test.env)
      expect(response.status).toBe(200)
      const body = await response.json() as { data: { items: Array<{ id: string; last_used_ip: string | null }> } }
      expect(body.data.items.find((row) => row.id === 'ip-key')?.last_used_ip).toBe('2001:db8::2')
      expect(body.data.items.find((row) => row.id === 'unused-key')?.last_used_ip).toBeNull()
    }
    test.raw.close()
  })
})
