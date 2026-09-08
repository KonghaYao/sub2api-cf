import { createApp } from '../../src/app'
import { authenticateGatewayRequest } from '../../src/gateway/repository'
import { describe, expect, it, vi } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'user-api-key-test-pepper-value-32-bytes-minimum'

interface TestFixture {
  raw: any
  env: Env
  authorization: Record<'alice' | 'bob', string>
}

async function fixture(): Promise<TestFixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  for (const [id, email] of [['alice', 'alice@example.test'], ['bob', 'bob@example.test']]) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, email, id, now, now)
  }
  for (const id of ['group-a', 'group-b']) {
    raw.prepare(
      `INSERT INTO "groups" (id, name, platform, is_exclusive, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'openai', 0, ?, ?)`,
    ).run(id, id, now, now)
  }

  const authorization = {} as TestFixture['authorization']
  for (const userId of ['alice', 'bob'] as const) {
    const accessToken = createOpaqueToken('access')
    const refreshToken = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version,
         access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `session-${userId}`,
      `family-${userId}`,
      userId,
      await tokenDigest(accessToken, PEPPER, 'access'),
      await tokenDigest(refreshToken, PEPPER, 'refresh'),
      now,
      now + 60_000,
      now + 600_000,
    )
    authorization[userId] = `Bearer ${accessToken}`
  }

  return {
    raw,
    authorization,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

describe('same user key lifecycle through production routes and SQLite', () => {
  it('keeps displayed, filtered, and gateway authorization state consistent through all transitions', async () => {
    const test = await fixture()
    try {
      const app = createApp()
      const call = (path: string, method = 'GET', body?: unknown, version?: number, owner: 'alice' | 'bob' = 'alice') =>
        app.request(`/api/v1/keys${path}`, {
          method,
          headers: { authorization: test.authorization[owner], 'content-type': 'application/json',
            'idempotency-key': `lifecycle-${method}-${version ?? 'create'}`,
            ...(version === undefined ? {} : { 'if-match': `"${version}"` }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, test.env)
      const input = { name: 'Lifecycle', group_id: 'group-a', quota_micros: 100 }
      const created = await call('', 'POST', input)
      expect(created.status).toBe(201)
      const { data: key } = await created.json() as { data: { id: string; key: string } }
      expect(key.key).toMatch(/^sk-sub2api-/)
      expect((await (await call('', 'POST', input)).json() as any).data).not.toHaveProperty('key')
      expect(test.raw.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 1 })
      const authenticate = (ip = '203.0.113.1') => authenticateGatewayRequest(new Request('https://test/v1/models', {
        headers: { authorization: `Bearer ${key.key}`, 'cf-connecting-ip': ip },
      }), test.env)
      const checkStatus = async (status: string) => {
        const projection = (await (await call(`/${key.id}`)).json() as any).data
        expect(projection.status).toBe(status)
        expect(projection).not.toHaveProperty('key')
        for (const filter of ['active', 'inactive', 'expired', 'quota_exhausted']) {
          const listed = await call(`?status=${filter}`)
          expect(listed.status, `filter ${filter} while ${status}`).toBe(200)
          const page = (await listed.json() as any).data
          expect(page.total, `filter ${filter} while ${status}`).toBe(filter === status ? 1 : 0)
          expect(page.items.map((item: any) => item.id)).toEqual(filter === status ? [key.id] : [])
        }
      }
      await expect(authenticate()).resolves.toMatchObject({ user_id: 'alice', api_key_id: key.id })
      await checkStatus('active')
      for (const method of ['GET', 'PUT', 'DELETE']) {
        expect((await call(`/${key.id}`, method, method === 'PUT' ? { name: 'stolen' } : undefined, 0, 'bob')).status).toBe(404)
      }
      expect((await call(`/${key.id}`, 'PUT', { group_id: 'group-b', ip_whitelist: ['203.0.113.1'] }, 0)).status).toBe(200)
      await expect(authenticate()).resolves.toMatchObject({ group_id: 'group-b' })
      await expect(authenticate('203.0.113.2')).rejects.toMatchObject({ status: 403 })
      expect((await call(`/${key.id}`, 'PUT', { name: 'stale' }, 0)).status).toBe(412)
      test.raw.prepare('UPDATE api_keys SET quota_used_micros = 100 WHERE id = ?').run(key.id)
      await checkStatus('quota_exhausted')
      expect((await call(`/${key.id}`, 'PUT', { reset_quota: true }, 1)).status).toBe(200)
      await checkStatus('active')
      const expiresAt = Date.now() + 5000
      expect((await call(`/${key.id}`, 'PUT', { expires_at_ms: expiresAt }, 2)).status).toBe(200)
      vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
      await checkStatus('expired')
      const unchanged = await call(`/${key.id}`, 'PUT', { name: 'renamed expired key' }, 3)
      expect(unchanged.status).toBe(200)
      expect((await unchanged.json() as any).data.expires_at).toBe(new Date(expiresAt).toISOString())
      await expect(authenticate()).rejects.toMatchObject({ status: 401 })
      expect((await call(`/${key.id}`, 'PUT', { expires_at_ms: null, status: 'inactive' }, 4)).status).toBe(200)
      await checkStatus('inactive')
      await expect(authenticate()).rejects.toMatchObject({ status: 401 })
      expect((await call(`/${key.id}`, 'PUT', { status: 'active' }, 5)).status).toBe(200)
      await expect(authenticate()).resolves.toMatchObject({ api_key_id: key.id })
      expect((await call(`/${key.id}`, 'DELETE')).status).toBe(200)
      expect((await call(`/${key.id}`, 'DELETE')).status).toBe(200)
      await expect(authenticate()).rejects.toMatchObject({ status: 401 })
      expect((await (await call('')).json() as any).data.total).toBe(0)
      expect((await call(`/${key.id}`, 'PUT', { status: 'active' }, 7)).status).toBe(409)
    } finally { vi.restoreAllMocks(); test.raw.close() }
  })
})
