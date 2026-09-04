import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/app'
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

function failSafeDatabase(database: D1Database, beforeFirstBatch: () => void): D1Database {
  let armed = true
  return {
    prepare: (query: string) => database.prepare(query),
    batch: async (statements: D1PreparedStatement[]) => {
      if (armed) {
        armed = false
        beforeFirstBatch()
      }
      return database.batch(statements)
    },
  } as unknown as D1Database
}

async function createKey(
  test: Fixture,
  groupId: string,
  idempotencyKey: string,
  environment = test.env,
): Promise<Response> {
  return createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
    method: 'POST',
    headers: { ...test.headers, 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ name: 'automation', group_id: groupId }),
  }, environment)
}

describe('admin API key D1 authorization', () => {
  it('atomically grants an exclusive standard group and hydrates it after a list reload', async () => {
    const test = await fixture()

    const created = await createKey(test, EXCLUSIVE_GROUP_ID, 'sqlite-exclusive-create')
    expect(created.status).toBe(201)
    await expect(created.json()).resolves.toMatchObject({
      code: 0,
      data: {
        group_id: EXCLUSIVE_GROUP_ID,
        group: {
          id: EXCLUSIVE_GROUP_ID,
          name: 'Exclusive',
          platform: 'openai',
          rate_multiplier: 1.25,
          subscription_type: 'standard',
          is_exclusive: true,
        },
      },
    })
    expect(test.raw.prepare(
      'SELECT user_id, group_id FROM user_group_permissions WHERE user_id = ? AND group_id = ?',
    ).get(USER_ID, EXCLUSIVE_GROUP_ID)).toEqual({
      user_id: USER_ID,
      group_id: EXCLUSIVE_GROUP_ID,
    })

    const listed = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
      headers: { authorization: test.headers.authorization },
    }, test.env)
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      data: {
        items: [{
          group_id: EXCLUSIVE_GROUP_ID,
          group: { id: EXCLUSIVE_GROUP_ID, name: 'Exclusive', platform: 'openai' },
        }],
      },
    })
  })

  it('does not treat a permission as a substitute for an active subscription on create or re-enable', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
       VALUES (?, ?, ?)`,
    ).run(USER_ID, SUBSCRIPTION_GROUP_ID, now)

    const denied = await createKey(test, SUBSCRIPTION_GROUP_ID, 'sqlite-subscription-denied')
    expect(denied.status).toBe(409)
    await expect(denied.json()).resolves.toMatchObject({ code: 'subscription_required' })

    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES ('subscription-1', ?, ?, 'active', ?, ?, 'admin', 'sqlite-test', ?, ?)`,
    ).run(USER_ID, SUBSCRIPTION_GROUP_ID, now - 1_000, now + 60_000, now, now)
    const created = await createKey(test, SUBSCRIPTION_GROUP_ID, 'sqlite-subscription-allowed')
    expect(created.status).toBe(201)
    const keyId = ((await created.json()) as { data: { id: string } }).data.id

    test.raw.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId)
    test.raw.prepare(
      `UPDATE user_subscriptions SET expires_at_ms = ?, status = 'expired' WHERE id = 'subscription-1'`,
    ).run(Date.now() - 1)
    const reenabled = await createApp().request(`/api/v1/admin/api-keys/${keyId}`, {
      method: 'PUT',
      headers: { ...test.headers, 'idempotency-key': 'sqlite-subscription-reenable' },
      body: JSON.stringify({ status: 'active' }),
    }, test.env)
    expect(reenabled.status).toBe(409)
    await expect(reenabled.json()).resolves.toMatchObject({ code: 'subscription_required' })
    expect(test.raw.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(keyId))
      .toEqual({ enabled: 0 })
  })

  it('does not persist a key, grant, or idempotency result if the group is disabled after preflight', async () => {
    const test = await fixture()
    const racingEnv = env(failSafeDatabase(test.d1, () => {
      test.raw.prepare('UPDATE "groups" SET enabled = 0 WHERE id = ?').run(EXCLUSIVE_GROUP_ID)
    }))

    const response = await createKey(
      test,
      EXCLUSIVE_GROUP_ID,
      'sqlite-disabled-during-create',
      racingEnv,
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'group_disabled' })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM api_keys').get()).toEqual({ total: 0 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM user_group_permissions').get())
      .toEqual({ total: 0 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM control_idempotency').get())
      .toEqual({ total: 0 })
  })
})
