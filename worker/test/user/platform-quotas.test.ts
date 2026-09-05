import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import {
  getAdminPlatformQuotaDefaults,
  getAdminUserPlatformQuotas,
  getMyPlatformQuotas,
  initialPlatformQuotaStatements,
  replaceAdminPlatformQuotaDefaults,
  replaceAdminUserPlatformQuotas,
  resetAdminUserPlatformQuotaWindow,
} from '../../src/user/platform-quotas'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'platform-quota-test-pepper-value-32-bytes'

async function fixture(): Promise<{
  raw: any
  env: Env
  auth: Record<'admin' | 'alice' | 'bob', string>
}> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', ?, ?),
            ('alice', 'alice@example.test', 'Alice', 'user', ?, ?),
            ('bob', 'bob@example.test', 'Bob', 'user', ?, ?)`,
  ).run(now, now, now, now, now, now)
  const auth = {} as Record<'admin' | 'alice' | 'bob', string>
  for (const user of ['admin', 'alice', 'bob'] as const) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `session-${user}`, `family-${user}`, user,
      await tokenDigest(access, PEPPER, 'access'),
      await tokenDigest(refresh, PEPPER, 'refresh'),
      now, now + 60_000, now + 600_000,
    )
    auth[user] = `Bearer ${access}`
  }
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch: async () => Response.json({}) }),
  } as unknown as DurableObjectNamespace
  return {
    raw, auth,
    env: {
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
      DB: d1, API_KEY_LIMIT_STATE: namespace,
      ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function app(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/user/platform-quotas', getMyPlatformQuotas)
  app.get('/admin/users/:id/platform-quotas', getAdminUserPlatformQuotas)
  app.put('/admin/users/:id/platform-quotas', replaceAdminUserPlatformQuotas)
  app.post('/admin/users/:id/platform-quotas/reset', resetAdminUserPlatformQuotaWindow)
  app.get('/admin/platform-quota-defaults', getAdminPlatformQuotaDefaults)
  app.put('/admin/platform-quota-defaults', replaceAdminPlatformQuotaDefaults)
  return app
}

function json(method: string, authorization: string, body: unknown, version = 0, key = 'mutation-key-0001'): RequestInit {
  return {
    method,
    headers: {
      authorization, 'content-type': 'application/json',
      'if-match': `"${version}"`, 'idempotency-key': key,
    },
    body: JSON.stringify(body),
  }
}

describe('platform quota HTTP boundaries', () => {
  it('keeps user reads owner-scoped and returns aligned window metadata', async () => {
    const test = await fixture()
    test.raw.exec(`
      INSERT INTO user_platform_quota_sets (user_id, control_version, updated_at_ms)
      VALUES ('alice', 1, 1), ('bob', 1, 1);
      INSERT INTO user_platform_quotas (
        user_id, platform, enabled, daily_limit_micros, daily_used_micros,
        daily_window_start_ms, control_version, created_at_ms, updated_at_ms
      ) VALUES
        ('alice', 'openai', 1, 5000000, 1000000, 1000, 1, 1, 1),
        ('bob', 'anthropic', 1, 9000000, 2000000, 1000, 1, 1, 1);
    `)

    const response = await app().request('/user/platform-quotas', {
      headers: { authorization: test.auth.alice },
    }, test.env)

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"1"')
    const payload = await response.json() as any
    expect(payload.data.platform_quotas).toHaveLength(1)
    expect(payload.data.platform_quotas[0]).toMatchObject({
      platform: 'openai', daily_limit_usd: 5,
    })
    expect(JSON.stringify(payload)).not.toContain('anthropic')
    expect(payload.data.platform_quotas[0]).not.toHaveProperty('daily_window_start')
    test.raw.close()
  })

  it('replaces and resets an admin target with CAS, idempotency, audit, and micros storage', async () => {
    const test = await fixture()
    const input = { quotas: [{
      platform: 'openai', daily_limit_usd: 1.25,
      weekly_limit_usd: null, monthly_limit_usd: 10,
    }] }
    const first = await app().request(
      '/admin/users/alice/platform-quotas',
      json('PUT', test.auth.admin, input),
      test.env,
    )
    expect(first.status).toBe(200)
    expect(first.headers.get('etag')).toBe('"1"')
    expect(test.raw.prepare(
      `SELECT daily_limit_micros, monthly_limit_micros
         FROM user_platform_quotas WHERE user_id = 'alice' AND platform = 'openai'`,
    ).get()).toEqual({ daily_limit_micros: 1_250_000, monthly_limit_micros: 10_000_000 })

    const replay = await app().request(
      '/admin/users/alice/platform-quotas',
      json('PUT', test.auth.admin, input),
      test.env,
    )
    expect(replay.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM admin_platform_quota_audit_events`,
    ).get()).toEqual({ total: 1 })

    const reset = await app().request(
      '/admin/users/alice/platform-quotas/reset',
      json('POST', test.auth.admin, { platform: 'openai', window: 'daily' }, 1, 'reset-key-000001'),
      test.env,
    )
    expect(reset.status).toBe(200)
    expect(reset.headers.get('etag')).toBe('"2"')
    expect(test.raw.prepare(
      `SELECT daily_used_micros, daily_reset_epoch
         FROM user_platform_quotas WHERE user_id = 'alice' AND platform = 'openai'`,
    ).get()).toEqual({ daily_used_micros: 0, daily_reset_epoch: 1 })

    const stale = await app().request(
      '/admin/users/alice/platform-quotas',
      json('PUT', test.auth.admin, input, 1, 'stale-key-000001'),
      test.env,
    )
    expect(stale.status).toBe(409)
    test.raw.close()
  })

  it('returns a precondition conflict to the losing concurrent reset without partial writes', async () => {
    const test = await fixture()
    const api = app()
    const quotas = { quotas: [{
      platform: 'openai', daily_limit_usd: 5,
      weekly_limit_usd: 20, monthly_limit_usd: 50,
    }] }
    const replaced = await api.request(
      '/admin/users/alice/platform-quotas',
      json('PUT', test.auth.admin, quotas, 0, 'reset-race-setup-0001'),
      test.env,
    )
    expect(replaced.status).toBe(200)
    test.raw.prepare(
      `UPDATE user_platform_quotas
          SET daily_used_micros = 3000000, daily_window_start_ms = 1
        WHERE user_id = 'alice' AND platform = 'openai'`,
    ).run()

    const reset = (key: string) => api.request(
      '/admin/users/alice/platform-quotas/reset',
      json(
        'POST',
        test.auth.admin,
        { platform: 'openai', window: 'daily' },
        1,
        key,
      ),
      test.env,
    )
    const responses = await Promise.all([
      reset('concurrent-reset-writer-0001'),
      reset('concurrent-reset-writer-0002'),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412])
    const loser = responses.find((response) => response.status === 412) as Response
    await expect(loser.json()).resolves.toMatchObject({
      error: { code: 'control_version_conflict' },
    })
    expect(test.raw.prepare(
      `SELECT control_version FROM user_platform_quota_sets WHERE user_id = 'alice'`,
    ).get()).toEqual({ control_version: 2 })
    expect(test.raw.prepare(
      `SELECT daily_used_micros, daily_reset_epoch, control_version
         FROM user_platform_quotas WHERE user_id = 'alice' AND platform = 'openai'`,
    ).get()).toEqual({ daily_used_micros: 0, daily_reset_epoch: 1, control_version: 2 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM admin_platform_quota_audit_events
        WHERE action = 'platform_quota.reset'`,
    ).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'admin.user-platform-quota.reset.v1'`,
    ).get()).toEqual({ total: 1 })
    test.raw.close()
  })

  it('recovers the losing concurrent reset when both requests share an idempotency key', async () => {
    const test = await fixture()
    const api = app()
    const quotas = { quotas: [{
      platform: 'openai', daily_limit_usd: 5,
      weekly_limit_usd: 20, monthly_limit_usd: 50,
    }] }
    expect((await api.request(
      '/admin/users/alice/platform-quotas',
      json('PUT', test.auth.admin, quotas, 0, 'reset-replay-setup-0001'),
      test.env,
    )).status).toBe(200)
    test.raw.prepare(
      `UPDATE user_platform_quotas
          SET weekly_used_micros = 4000000, weekly_window_start_ms = 1
        WHERE user_id = 'alice' AND platform = 'openai'`,
    ).run()

    const request = json(
      'POST',
      test.auth.admin,
      { platform: 'openai', window: 'weekly' },
      1,
      'concurrent-reset-replay-0001',
    )
    const responses = await Promise.all([
      api.request('/admin/users/alice/platform-quotas/reset', request, test.env),
      api.request('/admin/users/alice/platform-quotas/reset', request, test.env),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const payloads = await Promise.all(responses.map((response) => response.json()))
    expect(payloads[0]).toEqual(payloads[1])
    expect(responses.map((response) => response.headers.get('etag'))).toEqual(['"2"', '"2"'])
    expect(test.raw.prepare(
      `SELECT weekly_used_micros, weekly_reset_epoch, control_version
         FROM user_platform_quotas WHERE user_id = 'alice' AND platform = 'openai'`,
    ).get()).toEqual({ weekly_used_micros: 0, weekly_reset_epoch: 1, control_version: 2 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM admin_platform_quota_audit_events
        WHERE action = 'platform_quota.reset'`,
    ).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'admin.user-platform-quota.reset.v1'`,
    ).get()).toEqual({ total: 1 })
    test.raw.close()
  })

  it('updates private registration defaults by CAS and atomically copies them into a new user', async () => {
    const test = await fixture()
    const body = { platform_quotas: {
      openai: { daily_limit_usd: 2.5, weekly_limit_usd: null, monthly_limit_usd: 30 },
      anthropic: { daily_limit_usd: null, weekly_limit_usd: 9, monthly_limit_usd: null },
    } }
    const first = await app().request(
      '/admin/platform-quota-defaults',
      json('PUT', test.auth.admin, body),
      test.env,
    )
    expect(first.status).toBe(200)
    const payload = await first.json() as any
    expect(payload.data).toMatchObject({
      schema_version: 1, control_version: 1,
      platform_quotas: { openai: { daily_limit_usd: 2.5, monthly_limit_usd: 30 } },
    })

    const now = Date.now()
    await test.env.DB.batch([
      test.env.DB.prepare(
        `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
         VALUES ('new-user', 'new@example.test', 'New', ?, ?)`,
      ).bind(now, now),
      ...initialPlatformQuotaStatements(test.env, 'new-user', now),
    ])
    const copied = test.raw.prepare(
      `SELECT platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
         FROM user_platform_quotas WHERE user_id = 'new-user' ORDER BY platform`,
    ).all()
    expect(copied).toHaveLength(5)
    expect(copied).toEqual(expect.arrayContaining([
      { platform: 'anthropic', daily_limit_micros: null, weekly_limit_micros: 9_000_000, monthly_limit_micros: null },
      { platform: 'openai', daily_limit_micros: 2_500_000, weekly_limit_micros: null, monthly_limit_micros: 30_000_000 },
    ]))
    expect(test.raw.prepare(
      `SELECT control_version FROM user_platform_quota_sets WHERE user_id = 'new-user'`,
    ).get()).toEqual({ control_version: 1 })

    const conflict = await app().request(
      '/admin/platform-quota-defaults',
      json('PUT', test.auth.admin, body, 0, 'defaults-stale-001'),
      test.env,
    )
    expect(conflict.status).toBe(409)
    test.raw.close()
  })
})
