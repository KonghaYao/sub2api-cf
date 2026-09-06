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

function synchronizeFirstBatches(database: D1Database, count: number): D1Database {
  let arrivals = 0
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  return {
    prepare: (query: string) => database.prepare(query),
    batch: async (statements: D1PreparedStatement[]) => {
      arrivals += 1
      if (arrivals === count) release()
      await ready
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
  it('creates, lists, and CAS-updates the same normalized IP policy used by gateway auth', async () => {
    const test = await fixture()
    const created = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
      method: 'POST',
      headers: { ...test.headers, 'idempotency-key': 'admin-ip-policy-create' },
      body: JSON.stringify({
        name: 'restricted',
        group_id: EXCLUSIVE_GROUP_ID,
        ip_whitelist: ['10.2.3.4/8', '2001:0db8::1/32'],
        ip_blacklist: ['10.9.0.0/16'],
      }),
    }, test.env)
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { data: { id: string } & Record<string, unknown> }
    expect(createdBody.data).toMatchObject({
      ip_whitelist: ['10.0.0.0/8', '2001:db8::/32'],
      ip_blacklist: ['10.9.0.0/16'],
    })

    const listed = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
      headers: { authorization: test.headers.authorization },
    }, test.env)
    await expect(listed.json()).resolves.toMatchObject({
      data: { items: [{ ip_whitelist: ['10.0.0.0/8', '2001:db8::/32'] }] },
    })

    const updated = await createApp().request(`/api/v1/admin/api-keys/${createdBody.data.id}`, {
      method: 'PUT',
      headers: {
        ...test.headers,
        'idempotency-key': 'admin-ip-policy-update',
        'if-match': '"0"',
      },
      body: JSON.stringify({ ip_whitelist: [], ip_blacklist: ['2001:db8:ffff::/48'] }),
    }, test.env)
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        api_key: {
          ip_whitelist: [],
          ip_blacklist: ['2001:db8:ffff::/48'],
          auth_version: 2,
          control_version: 1,
        },
      },
    })
  })

  it('rejects admin custom-token input instead of silently creating a different key', async () => {
    const test = await fixture()
    const response = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
      method: 'POST',
      headers: { ...test.headers, 'idempotency-key': 'admin-custom-rejected' },
      body: JSON.stringify({
        name: 'custom',
        group_id: EXCLUSIVE_GROUP_ID,
        custom_key: 'admin-chosen-token-1234567890',
      }),
    }, test.env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'admin_custom_key_not_supported' })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM api_keys').get()).toEqual({ total: 0 })
  })

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
      headers: {
        ...test.headers,
        'idempotency-key': 'sqlite-subscription-reenable',
        'if-match': '"0"',
      },
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

  it('creates and lists a complete integer monetary policy projection', async () => {
    const test = await fixture()
    const response = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
      method: 'POST',
      headers: { ...test.headers, 'idempotency-key': 'admin-monetary-create-0001' },
      body: JSON.stringify({
        name: 'Budgeted',
        group_id: EXCLUSIVE_GROUP_ID,
        quota_micros: 10_000_000,
        rate_limit_5h_micros: 1_000_000,
        rate_limit_1d_micros: 2_000_000,
        rate_limit_7d_micros: 3_000_000,
      }),
    }, test.env)

    expect(response.status).toBe(201)
    const body = await response.json() as { data: { id: string } & Record<string, unknown> }
    expect(body.data).toMatchObject({
      status: 'active',
      control_version: 0,
      quota_micros: 10_000_000,
      quota_used_micros: 0,
      rate_limit_5h_micros: 1_000_000,
      rate_limit_1d_micros: 2_000_000,
      rate_limit_7d_micros: 3_000_000,
      usage_5h_micros: 0,
      usage_1d_micros: 0,
      usage_7d_micros: 0,
      window_5h_start_ms: null,
      window_1d_start_ms: null,
      window_7d_start_ms: null,
      reset_5h_at_ms: null,
      reset_1d_at_ms: null,
      reset_7d_at_ms: null,
      quota_reset_epoch: 0,
      rate_limit_reset_epoch: 0,
    })
    expect(test.raw.prepare(
      `SELECT quota_micros, quota_used_micros,
              rate_limit_5h_micros, rate_limit_1d_micros, rate_limit_7d_micros
         FROM api_keys WHERE id = ?`,
    ).get(body.data.id)).toEqual({
      quota_micros: 10_000_000,
      quota_used_micros: 0,
      rate_limit_5h_micros: 1_000_000,
      rate_limit_1d_micros: 2_000_000,
      rate_limit_7d_micros: 3_000_000,
    })

    const listed = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
      headers: { authorization: test.headers.authorization },
    }, test.env)
    await expect(listed.json()).resolves.toMatchObject({
      data: { items: [{ id: body.data.id, quota_micros: 10_000_000, control_version: 0 }] },
    })
  })

  it('rejects unsafe and legacy float monetary contracts', async () => {
    const test = await fixture()
    for (const [index, monetary] of [
      { quota_micros: -1 },
      { rate_limit_5h_micros: 0.5 },
      { rate_limit_7d_micros: Number.MAX_SAFE_INTEGER + 1 },
      { quota: 1.25 },
      { quota_used_micros: 1 },
    ].entries()) {
      const response = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
        method: 'POST',
        headers: { ...test.headers, 'idempotency-key': `admin-invalid-monetary-${index}` },
        body: JSON.stringify({ name: 'Invalid', group_id: EXCLUSIVE_GROUP_ID, ...monetary }),
      }, test.env)
      expect(response.status).toBe(400)
    }
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM api_keys').get()).toEqual({ total: 0 })
  })

  it('preserves racing hot usage, then resets counters and epochs through idempotent CAS', async () => {
    const test = await fixture()
    const created = await createKey(test, EXCLUSIVE_GROUP_ID, 'admin-monetary-update-create')
    const keyId = ((await created.json()) as { data: { id: string } }).data.id
    const now = Date.now()
    test.raw.prepare(
      `UPDATE api_keys
          SET quota_micros = 100, quota_used_micros = 70,
              rate_limit_5h_micros = 200, rate_limit_1d_micros = 300,
              rate_limit_7d_micros = 400,
              usage_5h_micros = 20, usage_1d_micros = 30, usage_7d_micros = 40,
              window_5h_start_ms = ?, window_1d_start_ms = ?, window_7d_start_ms = ?
        WHERE id = ?`,
    ).run(now, now, now, keyId)

    const racingEnv = env(failSafeDatabase(test.d1, () => {
      test.raw.prepare(
        `UPDATE api_keys
            SET quota_used_micros = quota_used_micros + 30,
                usage_5h_micros = usage_5h_micros + 22,
                usage_1d_micros = usage_1d_micros + 22,
                usage_7d_micros = usage_7d_micros + 22
          WHERE id = ?`,
      ).run(keyId)
    }))
    const renamed = await createApp().request(`/api/v1/admin/api-keys/${keyId}`, {
      method: 'PUT',
      headers: {
        ...test.headers,
        'idempotency-key': 'admin-monetary-name-update',
        'if-match': '"0"',
      },
      body: JSON.stringify({ name: 'After hot charge' }),
    }, racingEnv)
    expect(renamed.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT name, quota_used_micros, usage_5h_micros, usage_1d_micros, usage_7d_micros
         FROM api_keys WHERE id = ?`,
    ).get(keyId)).toEqual({
      name: 'After hot charge',
      quota_used_micros: 100,
      usage_5h_micros: 42,
      usage_1d_micros: 52,
      usage_7d_micros: 62,
    })

    const resetRequest = {
      method: 'PUT',
      headers: {
        ...test.headers,
        'idempotency-key': 'admin-monetary-reset-0001',
        'if-match': '"1"',
      },
      body: JSON.stringify({
        quota_micros: 50,
        reset_quota: true,
        reset_rate_limit_usage: true,
      }),
    }
    const reset = await createApp().request(`/api/v1/admin/api-keys/${keyId}`, resetRequest, test.env)
    const replay = await createApp().request(`/api/v1/admin/api-keys/${keyId}`, resetRequest, test.env)
    expect(reset.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      data: {
        api_key: {
          id: keyId,
          status: 'active',
          quota_micros: 50,
          quota_used_micros: 0,
          usage_5h_micros: 0,
          usage_1d_micros: 0,
          usage_7d_micros: 0,
          window_5h_start_ms: null,
          window_1d_start_ms: null,
          window_7d_start_ms: null,
          quota_reset_epoch: 1,
          rate_limit_reset_epoch: 1,
          control_version: 2,
        },
      },
    })
    expect(test.raw.prepare(
      `SELECT enabled, auth_version, quota_micros, quota_used_micros,
              usage_5h_micros, usage_1d_micros, usage_7d_micros,
              window_5h_start_ms, window_1d_start_ms, window_7d_start_ms,
              quota_reset_epoch, rate_limit_reset_epoch, control_version
         FROM api_keys WHERE id = ?`,
    ).get(keyId)).toEqual({
      enabled: 1,
      auth_version: 1,
      quota_micros: 50,
      quota_used_micros: 0,
      usage_5h_micros: 0,
      usage_1d_micros: 0,
      usage_7d_micros: 0,
      window_5h_start_ms: null,
      window_1d_start_ms: null,
      window_7d_start_ms: null,
      quota_reset_epoch: 1,
      rate_limit_reset_epoch: 1,
      control_version: 2,
    })
  })

  it('reports quota exhaustion without mutating authentication state', async () => {
    const test = await fixture()
    const created = await createKey(test, EXCLUSIVE_GROUP_ID, 'admin-quota-status-create')
    const keyId = ((await created.json()) as { data: { id: string } }).data.id
    test.raw.prepare(
      'UPDATE api_keys SET quota_micros = 100, quota_used_micros = 100 WHERE id = ?',
    ).run(keyId)

    const listed = await createApp().request(`/api/v1/admin/users/${USER_ID}/api-keys`, {
      headers: { authorization: test.headers.authorization },
    }, test.env)
    await expect(listed.json()).resolves.toMatchObject({
      data: { items: [{ id: keyId, status: 'quota_exhausted', enabled: 1, auth_version: 1 }] },
    })

    const expanded = await createApp().request(`/api/v1/admin/api-keys/${keyId}`, {
      method: 'PUT',
      headers: {
        ...test.headers,
        'idempotency-key': 'admin-quota-expand-0001',
        'if-match': '"0"',
      },
      body: JSON.stringify({ quota_micros: 101 }),
    }, test.env)
    await expect(expanded.json()).resolves.toMatchObject({
      data: { api_key: { status: 'active', enabled: 1, auth_version: 1, control_version: 1 } },
    })
  })

  it('requires an If-Match control version and rejects a stale admin edit', async () => {
    const test = await fixture()
    const created = await createKey(test, EXCLUSIVE_GROUP_ID, 'admin-cas-create-0001')
    const keyId = ((await created.json()) as { data: { id: string } }).data.id
    const request = (ifMatch?: string) => createApp().request(`/api/v1/admin/api-keys/${keyId}`, {
      method: 'PUT',
      headers: {
        ...test.headers,
        'idempotency-key': `admin-cas-update-${ifMatch ?? 'missing'}`,
        ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
      },
      body: JSON.stringify({ name: 'Renamed' }),
    }, test.env)

    const missing = await request()
    const stale = await request('"1"')
    expect(missing.status).toBe(428)
    await expect(missing.json()).resolves.toMatchObject({ code: 'control_version_required' })
    expect(stale.status).toBe(412)
    await expect(stale.json()).resolves.toMatchObject({ code: 'control_version_conflict' })
    expect(test.raw.prepare('SELECT name, control_version FROM api_keys WHERE id = ?').get(keyId))
      .toEqual({ name: 'automation', control_version: 0 })
  })

  it('recovers concurrent revocations with the same idempotency key without double incrementing auth', async () => {
    const test = await fixture()
    const created = await createKey(test, EXCLUSIVE_GROUP_ID, 'admin-revoke-create-0001')
    const keyId = ((await created.json()) as { data: { id: string } }).data.id
    const racingEnv = env(synchronizeFirstBatches(test.d1, 2))
    const revoke = () => createApp().request(`/api/v1/admin/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: {
        ...test.headers,
        'idempotency-key': 'admin-revoke-concurrent-0001',
      },
    }, racingEnv)

    const [first, second] = await Promise.all([revoke(), revoke()])

    expect([first.status, second.status]).toEqual([200, 200])
    await expect(first.json()).resolves.toMatchObject({
      code: 0,
      data: { id: keyId, enabled: 0, auth_version: 2, control_version: 1 },
    })
    await expect(second.json()).resolves.toMatchObject({
      code: 0,
      data: { id: keyId, enabled: 0, auth_version: 2, control_version: 1 },
    })
    expect(test.raw.prepare(
      'SELECT enabled, auth_version, control_version FROM api_keys WHERE id = ?',
    ).get(keyId)).toEqual({ enabled: 0, auth_version: 2, control_version: 1 })
    expect(test.raw.prepare(
      "SELECT COUNT(*) AS total FROM auth_audit_events WHERE event_type = 'admin.api_keys.revoke'",
    ).get()).toEqual({ total: 1 })
  })
})
