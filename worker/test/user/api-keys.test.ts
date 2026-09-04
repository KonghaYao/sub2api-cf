import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import {
  createUserApiKey,
  getUserApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  updateUserApiKey,
} from '../../src/user/api-keys'
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

function app(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/keys', listUserApiKeys)
  app.get('/keys/:id', getUserApiKey)
  app.post('/keys', createUserApiKey)
  app.put('/keys/:id', updateUserApiKey)
  app.delete('/keys/:id', revokeUserApiKey)
  return app
}

function seedKey(
  raw: any,
  input: { id: string; userId: string; name: string; hashByte: string },
): void {
  raw.prepare(
    `INSERT INTO api_keys (
       id, user_id, key_hash, name, enabled, expires_at_ms,
       created_at_ms, updated_at_ms, group_id, key_prefix
     ) VALUES (?, ?, ?, ?, 1, NULL, 100, 100, 'group-a', ?)`,
  ).run(input.id, input.userId, input.hashByte.repeat(64), input.name, `sk-sub2api-${input.hashByte.repeat(5)}`)
}

describe('user API keys', () => {
  it('requires a user session and lists only the authenticated user keys without secrets', async () => {
    const test = await fixture()
    seedKey(test.raw, { id: 'alice-key', userId: 'alice', name: 'Alice key', hashByte: 'a' })
    seedKey(test.raw, { id: 'bob-key', userId: 'bob', name: 'Bob key', hashByte: 'b' })

    const unauthorized = await app().request('/keys', undefined, test.env)
    const response = await app().request('/keys', {
      headers: { authorization: test.authorization.alice },
    }, test.env)

    expect(unauthorized.status).toBe(401)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      data: { items: Array<Record<string, unknown>>; total: number }
    }
    expect(body.data.total).toBe(1)
    expect(body.data.items).toEqual([
      expect.objectContaining({ id: 'alice-key', user_id: 'alice', name: 'Alice key' }),
    ])
    expect(JSON.stringify(body)).not.toContain('Bob key')
    expect(body.data.items[0]).not.toHaveProperty('key')
    expect(body.data.items[0]).not.toHaveProperty('key_hash')

    const owned = await app().request('/keys/alice-key', {
      headers: { authorization: test.authorization.alice },
    }, test.env)
    const foreign = await app().request('/keys/bob-key', {
      headers: { authorization: test.authorization.alice },
    }, test.env)
    expect(owned.status).toBe(200)
    await expect(owned.json()).resolves.toMatchObject({ data: { id: 'alice-key' } })
    expect(foreign.status).toBe(404)
  })

  it('returns a new key once while persisting only its digest and prefix', async () => {
    const test = await fixture()
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    const request = {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'alice-create-key-0001',
      },
      body: JSON.stringify({ name: 'Automation', group_id: 'group-a', expires_at: expiresAt }),
    }

    const created = await app().request('/keys', request, test.env)
    const replayed = await app().request('/keys', request, test.env)

    expect(created.status).toBe(201)
    const createdBody = await created.json() as {
      data: Record<string, unknown> & { id: string; key: string }
    }
    expect(createdBody.data).toMatchObject({
      user_id: 'alice',
      name: 'Automation',
      group_id: 'group-a',
      expires_at: expiresAt,
      status: 'active',
    })
    expect(createdBody.data.key).toMatch(/^sk-sub2api-[A-Za-z0-9_-]{48}$/)
    expect(createdBody.data).not.toHaveProperty('key_hash')

    expect(replayed.status).toBe(200)
    const replayedBody = await replayed.json() as { data: Record<string, unknown> }
    expect(replayedBody.data).toMatchObject({ id: createdBody.data.id, expires_at: expiresAt })
    expect(replayedBody.data).not.toHaveProperty('key')
    expect(replayedBody.data).not.toHaveProperty('key_hash')

    const persisted = test.raw.prepare(
      `SELECT key_hash, key_prefix, expires_at_ms FROM api_keys WHERE id = ?`,
    ).get(createdBody.data.id) as { key_hash: string; key_prefix: string; expires_at_ms: number }
    expect(persisted.key_hash).toBe(await apiKeyDigest(createdBody.data.key, PEPPER))
    expect(persisted.key_hash).not.toContain(createdBody.data.key)
    expect(persisted.key_prefix).toBe(createdBody.data.key.slice(0, 16))
    expect(persisted.expires_at_ms).toBe(Date.parse(expiresAt))
    expect(JSON.stringify(persisted)).not.toContain(createdBody.data.key)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM api_keys').get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT event_type, outcome, user_id FROM auth_audit_events
       WHERE event_type = 'user.api_keys.create'`,
    ).get()).toEqual({ event_type: 'user.api_keys.create', outcome: 'succeeded', user_id: 'alice' })
  })

  it('accepts expires_at_ms for compatibility but exposes only RFC3339 expires_at', async () => {
    const test = await fixture()
    const expiresAtMs = Date.now() + 86_400_000
    const response = await app().request('/keys', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'alice-create-key-ms-0001',
      },
      body: JSON.stringify({ name: 'CLI', group_id: 'group-a', expires_at_ms: expiresAtMs }),
    }, test.env)

    expect(response.status).toBe(201)
    const body = await response.json() as { data: Record<string, unknown> }
    expect(body.data.expires_at).toBe(new Date(expiresAtMs).toISOString())
    expect(body.data).not.toHaveProperty('expires_at_ms')
  })

  it('updates only an owned key and accepts name, group_id, and RFC3339 expires_at', async () => {
    const test = await fixture()
    seedKey(test.raw, { id: 'alice-key', userId: 'alice', name: 'Alice key', hashByte: 'a' })
    seedKey(test.raw, { id: 'bob-key', userId: 'bob', name: 'Bob key', hashByte: 'b' })
    const expiresAt = new Date(Date.now() + 172_800_000).toISOString()
    const request = {
      method: 'PUT',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Renamed', group_id: 'group-b', expires_at: expiresAt }),
    }

    const forbidden = await app().request('/keys/bob-key', request, test.env)
    const response = await app().request('/keys/alice-key', request, test.env)

    expect(forbidden.status).toBe(404)
    await expect(forbidden.json()).resolves.toMatchObject({ code: 'api_key_not_found' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: {
        id: 'alice-key',
        user_id: 'alice',
        name: 'Renamed',
        group_id: 'group-b',
        expires_at: expiresAt,
      },
    })
    const alice = test.raw.prepare(
      `SELECT name, group_id, expires_at_ms, auth_version, control_version
       FROM api_keys WHERE id = 'alice-key'`,
    ).get()
    expect(alice).toEqual({
      name: 'Renamed',
      group_id: 'group-b',
      expires_at_ms: Date.parse(expiresAt),
      auth_version: 2,
      control_version: 1,
    })
    expect(test.raw.prepare(`SELECT name FROM api_keys WHERE id = 'bob-key'`).get()).toEqual({
      name: 'Bob key',
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_audit_events
       WHERE event_type = 'user.api_keys.update' AND user_id = 'alice'`,
    ).get()).toEqual({ total: 1 })
  })

  it('rejects direct binding to inaccessible groups and accepts an explicit permission', async () => {
    const test = await fixture()
    seedKey(test.raw, { id: 'alice-key', userId: 'alice', name: 'Alice key', hashByte: 'a' })
    const createdAt = Date.now()
    test.raw.prepare(
      `INSERT INTO "groups" (
         id, name, platform, enabled, group_type, is_exclusive, created_at_ms, updated_at_ms
       ) VALUES ('private-group', 'Private', 'openai', 1, 'standard', 1, ?, ?)`,
    ).run(createdAt, createdAt)

    const create = (idempotencyKey: string) => app().request('/keys', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ name: 'Private key', group_id: 'private-group' }),
    }, test.env)
    const update = () => app().request('/keys/alice-key', {
      method: 'PUT',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ group_id: 'private-group' }),
    }, test.env)

    const deniedCreate = await create('private-create-denied')
    const deniedUpdate = await update()
    expect(deniedCreate.status).toBe(403)
    expect(deniedUpdate.status).toBe(403)
    await expect(deniedCreate.json()).resolves.toMatchObject({ code: 'group_access_denied' })
    await expect(deniedUpdate.json()).resolves.toMatchObject({ code: 'group_access_denied' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM api_keys WHERE group_id = 'private-group'`,
    ).get()).toEqual({ total: 0 })
    expect(test.raw.prepare(
      `SELECT group_id FROM api_keys WHERE id = 'alice-key'`,
    ).get()).toEqual({ group_id: 'group-a' })

    test.raw.prepare(
      `INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
       VALUES ('alice', 'private-group', ?)`,
    ).run(createdAt)

    const allowedCreate = await create('private-create-allowed')
    const allowedUpdate = await update()
    expect(allowedCreate.status).toBe(201)
    expect(allowedUpdate.status).toBe(200)
    await expect(allowedCreate.json()).resolves.toMatchObject({
      data: { group_id: 'private-group', status: 'active' },
    })
    await expect(allowedUpdate.json()).resolves.toMatchObject({
      data: { id: 'alice-key', group_id: 'private-group' },
    })
  })

  it('lets the owner deactivate and reactivate a non-revoked key through status', async () => {
    const test = await fixture()
    seedKey(test.raw, { id: 'alice-key', userId: 'alice', name: 'Alice key', hashByte: 'a' })
    seedKey(test.raw, { id: 'bob-key', userId: 'bob', name: 'Bob key', hashByte: 'b' })

    const update = (id: string, status: string) => app().request(`/keys/${id}`, {
      method: 'PUT',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status }),
    }, test.env)

    const foreign = await update('bob-key', 'inactive')
    const deactivated = await update('alice-key', 'inactive')
    const reactivated = await update('alice-key', 'active')

    expect(foreign.status).toBe(404)
    await expect(deactivated.json()).resolves.toMatchObject({
      code: 0,
      data: { id: 'alice-key', status: 'inactive' },
    })
    await expect(reactivated.json()).resolves.toMatchObject({
      code: 0,
      data: { id: 'alice-key', status: 'active' },
    })
    expect(test.raw.prepare(
      `SELECT enabled, auth_version, control_version, revoked_at_ms
       FROM api_keys WHERE id = 'alice-key'`,
    ).get()).toEqual({ enabled: 1, auth_version: 3, control_version: 2, revoked_at_ms: null })
    expect(test.raw.prepare(
      `SELECT enabled, auth_version, control_version
       FROM api_keys WHERE id = 'bob-key'`,
    ).get()).toEqual({ enabled: 1, auth_version: 1, control_version: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_audit_events
       WHERE event_type = 'user.api_keys.update' AND user_id = 'alice'`,
    ).get()).toEqual({ total: 2 })
  })

  it('rechecks access before reactivating a key in the same group', async () => {
    const test = await fixture()
    seedKey(test.raw, { id: 'alice-key', userId: 'alice', name: 'Alice key', hashByte: 'a' })
    const update = (status: 'active' | 'inactive') => app().request('/keys/alice-key', {
      method: 'PUT',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status }),
    }, test.env)

    expect((await update('inactive')).status).toBe(200)
    test.raw.prepare(
      `UPDATE "groups" SET is_exclusive = 1, updated_at_ms = ? WHERE id = 'group-a'`,
    ).run(Date.now())

    const denied = await update('active')

    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ code: 'group_access_denied' })
    expect(test.raw.prepare(
      `SELECT enabled, auth_version FROM api_keys WHERE id = 'alice-key'`,
    ).get()).toEqual({ enabled: 0, auth_version: 2 })
  })

  it('rejects invalid status and cannot reactivate a revoked key', async () => {
    const test = await fixture()
    seedKey(test.raw, { id: 'alice-key', userId: 'alice', name: 'Alice key', hashByte: 'a' })

    const invalid = await app().request('/keys/alice-key', {
      method: 'PUT',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'paused' }),
    }, test.env)
    await app().request('/keys/alice-key', {
      method: 'DELETE',
      headers: { authorization: test.authorization.alice },
    }, test.env)
    const revoked = await app().request('/keys/alice-key', {
      method: 'PUT',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'active' }),
    }, test.env)

    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'invalid_status' })
    expect(revoked.status).toBe(409)
    await expect(revoked.json()).resolves.toMatchObject({ code: 'api_key_revoked' })
  })

  it('does not reveal another user key and makes revocation idempotent', async () => {
    const test = await fixture()
    seedKey(test.raw, { id: 'alice-key', userId: 'alice', name: 'Alice key', hashByte: 'a' })
    seedKey(test.raw, { id: 'bob-key', userId: 'bob', name: 'Bob key', hashByte: 'b' })
    const request = {
      method: 'DELETE',
      headers: { authorization: test.authorization.alice },
    }

    const forbidden = await app().request('/keys/bob-key', request, test.env)
    const first = await app().request('/keys/alice-key', request, test.env)
    const replay = await app().request('/keys/alice-key', request, test.env)

    expect(forbidden.status).toBe(404)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      code: 0,
      data: { id: 'alice-key', user_id: 'alice', status: 'inactive' },
    })
    expect(test.raw.prepare(
      `SELECT enabled, auth_version, control_version,
              CASE WHEN revoked_at_ms IS NULL THEN 0 ELSE 1 END AS revoked
       FROM api_keys WHERE id = 'alice-key'`,
    ).get()).toEqual({ enabled: 0, auth_version: 2, control_version: 1, revoked: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_audit_events
       WHERE event_type = 'user.api_keys.revoke' AND user_id = 'alice'`,
    ).get()).toEqual({ total: 1 })
  })
})
