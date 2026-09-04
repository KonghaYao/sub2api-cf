import { beforeEach, describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'subscription-plans-test-pepper-value-at-least-32-bytes'
const DAY_MS = 86_400_000

interface Fixture {
  raw: any
  env: Env
  adminHeaders: Record<string, string>
}

let now = Date.now()

beforeEach(() => {
  now = Date.now()
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', 'active', ?, ?)`,
  ).run(now, now)
  for (const [id, type] of [['subscription-pro', 'subscription'], ['standard', 'standard']] as const) {
    raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, group_type, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'openai', 1, ?, ?, ?)`,
    ).run(id, id, type, now, now)
  }
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('admin-session', 'admin-family', 'admin', 1, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    now,
    now + DAY_MS,
    now + 30 * DAY_MS,
  )
  return {
    raw,
    adminHeaders: { authorization: `Bearer ${access}` },
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

async function adminRequest(test: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return await createApp().request(path, {
    ...init,
    headers: { ...test.adminHeaders, ...init.headers },
  }, test.env)
}

function mutationHeaders(key: string, version?: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': key,
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
  }
}

async function body(response: Response): Promise<any> {
  return response.json()
}

describe('subscription plan HTTP contract', () => {
  it('serves only enabled plans publicly and projects Worker values into the existing payment shape', async () => {
    const test = await fixture()
    const created = await adminRequest(test, '/api/v1/admin/payment/plans', {
      method: 'POST',
      headers: mutationHeaders('subscription-plan-create-1'),
      body: JSON.stringify({
        group_id: 'subscription-pro', name: 'Pro', description: 'Full access', price: 12.345678,
        validity_days: 4, validity_unit: 'weeks', daily_limit_usd: 1.5, for_sale: true, sort_order: 2,
        currency: '', features: 'legacy value is intentionally not persisted',
      }),
    })
    expect(created.status).toBe(201)
    const plan = (await body(created)).data
    expect(plan).toMatchObject({
      group_id: 'subscription-pro', price: 12.345678, price_micros: 12_345_678,
      validity_days: 28, validity_unit: 'days', currency: 'USD', daily_limit_usd: 1.5, for_sale: true,
      control_version: 0,
    })

    const listed = await createApp().request('/api/v1/payment/plans', {}, test.env)
    expect(listed.status).toBe(200)
    const publicPlan = (await body(listed)).data[0]
    expect(publicPlan).toMatchObject({
      id: plan.id,
      features: [],
      for_sale: true,
      group_name: 'subscription-pro',
      group_platform: 'openai',
      rate_multiplier: 1,
    })
    expect(publicPlan).not.toHaveProperty('control_version')
    expect((await createApp().request(`/api/v1/payment/plans/${plan.id}`, {}, test.env)).status).toBe(200)

    const disabled = await adminRequest(test, `/api/v1/admin/payment/plans/${plan.id}`, {
      method: 'PUT', headers: mutationHeaders('subscription-plan-disable-via-update', 0),
      body: JSON.stringify({ for_sale: false, expected_control_version: 0 }),
    })
    expect(disabled.status).toBe(200)
    expect((await body(disabled)).data).toMatchObject({ for_sale: false, control_version: 1 })
    await expect(body(await createApp().request('/api/v1/payment/plans', {}, test.env))).resolves.toMatchObject({ data: [] })
    expect((await createApp().request(`/api/v1/payment/plans/${plan.id}`, {}, test.env)).status).toBe(404)
  })

  it('requires an admin session, idempotency for creates, and matching versions for writes', async () => {
    const test = await fixture()
    expect((await createApp().request('/api/v1/admin/payment/plans', {}, test.env)).status).toBe(401)
    expect((await adminRequest(test, '/api/v1/admin/payment/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group_id: 'subscription-pro', name: 'No key', price: 1, validity_days: 1 }),
    })).status).toBe(400)

    const request = {
      method: 'POST', headers: mutationHeaders('subscription-plan-create-replay'),
      body: JSON.stringify({ group_id: 'subscription-pro', name: 'Replay', price_micros: 2_000_000, validity_days: 30 }),
    } as const
    const first = await adminRequest(test, '/api/v1/admin/payment/plans', request)
    const replay = await adminRequest(test, '/api/v1/admin/payment/plans', request)
    const plan = (await body(first)).data
    expect(replay.status).toBe(200)
    expect((await body(replay)).data).toEqual(plan)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM subscription_plans').get()).toEqual({ total: 1 })

    const missing = await adminRequest(test, `/api/v1/admin/payment/plans/${plan.id}`, {
      method: 'PUT', headers: mutationHeaders('subscription-plan-missing-version'), body: JSON.stringify({ name: 'Missing' }),
    })
    expect(missing.status).toBe(428)
    const stale = await adminRequest(test, `/api/v1/admin/payment/plans/${plan.id}`, {
      method: 'PUT', headers: mutationHeaders('subscription-plan-stale-version', 9), body: JSON.stringify({ name: 'Stale' }),
    })
    expect(stale.status).toBe(412)
  })

  it('soft-disables a referenced plan instead of deleting its historical identity', async () => {
    const test = await fixture()
    const created = await adminRequest(test, '/api/v1/admin/payment/plans', {
      method: 'POST', headers: mutationHeaders('subscription-plan-create-referenced'),
      body: JSON.stringify({ group_id: 'subscription-pro', name: 'Referenced', price: 1, validity_days: 30 }),
    })
    const plan = (await body(created)).data
    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, plan_id, status, starts_at_ms, expires_at_ms, source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES ('subscription-1', 'admin', 'subscription-pro', ?, 'active', ?, ?, 'admin', 'test', ?, ?)`,
    ).run(plan.id, now, now + DAY_MS, now, now)

    const deleted = await adminRequest(test, `/api/v1/admin/payment/plans/${plan.id}`, {
      method: 'DELETE', headers: mutationHeaders('subscription-plan-soft-delete', 0),
      body: JSON.stringify({ expected_control_version: 0 }),
    })
    expect(deleted.status).toBe(200)
    expect((await body(deleted)).data).toMatchObject({ id: plan.id, enabled: false, for_sale: false, control_version: 1 })
    expect(test.raw.prepare('SELECT enabled FROM subscription_plans WHERE id = ?').get(plan.id)).toEqual({ enabled: 0 })
    expect(test.raw.prepare('SELECT plan_id FROM user_subscriptions WHERE id = ?').get('subscription-1')).toEqual({ plan_id: plan.id })
  })

  it('rejects invalid input and plans for non-subscription groups', async () => {
    const test = await fixture()
    const response = await adminRequest(test, '/api/v1/admin/payment/plans', {
      method: 'POST', headers: mutationHeaders('subscription-plan-invalid-group'),
      body: JSON.stringify({ group_id: 'standard', name: 'Wrong group', price: 1, validity_days: 30 }),
    })
    expect(response.status).toBe(409)
    const amount = await adminRequest(test, '/api/v1/admin/payment/plans', {
      method: 'POST', headers: mutationHeaders('subscription-plan-invalid-amount'),
      body: JSON.stringify({ group_id: 'subscription-pro', name: 'Bad amount', price: -1, validity_days: 30 }),
    })
    expect(amount.status).toBe(400)
  })
})
