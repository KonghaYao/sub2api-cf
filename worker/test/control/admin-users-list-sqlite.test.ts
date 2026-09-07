import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { listAdminUsers } from '../../src/control/users'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

interface Fixture {
  app: Hono<{ Bindings: Env }>
  env: Env
  raw: any
  now: number
}

function fixture(): Fixture {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  const now = Date.now()
  database.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
       restrict_public_groups, last_login_at_ms, created_at_ms, updated_at_ms
     ) VALUES
       ('user-alpha', 'alpha@example.test', 'Alpha', 'user', 'active', 3000000, 3, 30, 1, ?, ?, ?),
       ('user-beta', 'beta@example.test', 'Beta', 'user', 'active', 2000000, 2, 20, 0, ?, ?, ?),
       ('user-gamma', 'gamma@example.test', 'Gamma', 'user', 'active', 1000000, 1, 10, 0, NULL, ?, ?)`,
  ).run(now - 2_000, now - 3_000, now - 2_000, now - 1_000, now - 2_000, now - 1_000, now - 1_000, now - 1_000)
  database.raw.prepare(
    `INSERT INTO "groups" (
       id, name, description, platform, enabled, rate_multiplier_ppm,
       group_type, is_exclusive, daily_quota_micros, weekly_quota_micros,
       monthly_quota_micros, created_at_ms, updated_at_ms
     ) VALUES
       ('group-alpha', 'Alpha Premium', 'alpha access', 'openai', 1, 1000000,
        'standard', 1, NULL, NULL, NULL, ?, ?),
       ('group-beta', 'Beta Standard', 'beta access', 'anthropic', 1, 1000000,
        'standard', 1, NULL, NULL, NULL, ?, ?),
       ('group-sub', 'Pro Subscription', 'paid plan', 'gemini', 1, 1500000,
        'subscription', 1, 90000000, 95000000, 99000000, ?, ?)`,
  ).run(now, now, now, now, now, now)
  database.raw.prepare(
    `INSERT INTO user_group_permissions (user_id, group_id, created_at_ms) VALUES
       ('user-alpha', 'group-alpha', ?),
       ('user-beta', 'group-beta', ?)`,
  ).run(now, now)
  database.raw.prepare(
    `INSERT INTO user_group_rate_overrides (
       user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
     ) VALUES ('user-alpha', 'group-alpha', 1250000, ?, ?)`,
  ).run(now, now)
  database.raw.prepare(
    `INSERT INTO api_keys (
       id, user_id, key_hash, key_prefix, name, enabled, group_id,
       created_at_ms, updated_at_ms
     ) VALUES
       ('key-alpha', 'user-alpha', ?, 'sk-alpha', 'Alpha key', 1, 'group-alpha', ?, ?),
       ('key-beta', 'user-beta', ?, 'sk-beta', 'Beta key', 1, 'group-beta', ?, ?),
       ('key-gamma-disabled', 'user-gamma', ?, 'sk-gamma', 'Disabled key', 0, 'group-alpha', ?, ?)`,
  ).run('a'.repeat(64), now, now, 'b'.repeat(64), now, now, 'c'.repeat(64), now, now)
  database.raw.prepare(
    `INSERT INTO user_attribute_definitions (
       id, key, name, type, created_at_ms, updated_at_ms
     ) VALUES
       (1, 'company', 'Company', 'text', ?, ?),
       (2, 'department', 'Department', 'text', ?, ?)`,
  ).run(now, now, now, now)
  database.raw.prepare(
    `INSERT INTO user_attribute_values (
       user_id, attribute_id, value, created_at_ms, updated_at_ms
     ) VALUES
       ('user-alpha', 1, 'Acme Corporation', ?, ?),
       ('user-alpha', 2, 'Engineering', ?, ?),
       ('user-beta', 1, 'Acme Corporation', ?, ?),
       ('user-beta', 2, 'Marketing', ?, ?),
       ('user-gamma', 1, 'Other', ?, ?),
       ('user-gamma', 2, 'Engineering', ?, ?)`,
  ).run(now, now, now, now, now, now, now, now, now, now, now, now)
  database.raw.prepare(
    `INSERT INTO user_subscriptions (
       id, user_id, group_id, status, starts_at_ms, expires_at_ms,
       daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
       daily_used_micros, weekly_used_micros, monthly_used_micros,
       daily_anchor_ms, daily_window_start_ms, weekly_window_start_ms,
       monthly_window_start_ms, source_type, source_id, notes,
       created_at_ms, updated_at_ms
     ) VALUES (
       'subscription-alpha', 'user-alpha', 'group-sub', 'active', ?, ?,
       10000000, 50000000, 100000000, 1500000, 2500000, 3500000,
       ?, ?, ?, ?, 'admin', 'seed', 'test subscription', ?, ?
     )`,
  ).run(
    now - 3_600_000,
    now + 82_800_000,
    now - 3_600_000,
    now - 3_600_000,
    now - 3_600_000,
    now - 3_600_000,
    now - 3_600_000,
    now,
  )
  database.raw.prepare(
    `INSERT INTO usage_projection (
       event_id, request_id, user_id, api_key_id, model,
       amount_micros, occurred_at_ms, projected_at_ms
     ) VALUES
       ('usage-alpha', 'request-alpha', 'user-alpha', 'key-alpha', 'gpt-test', 1, ?, ?),
       ('usage-beta', 'request-beta', 'user-beta', 'key-beta', 'claude-test', 1, ?, ?)`,
  ).run(now - 500, now - 500, now - 1_500, now - 1_500)

  const env = {
    DB: database.d1,
    API_KEY_LIMIT_STATE: {
      idFromName(name: string) { return name },
      get(name: string) {
        return {
          async fetch() {
            const userId = name.replace(/^user:/, '')
            return Response.json({
              schema_version: 1,
              active_concurrency: userId === 'user-alpha' ? 2 : 0,
            })
          },
        }
      },
    },
  } as unknown as Env
  const app = new Hono<{ Bindings: Env }>()
  app.get('/users', listAdminUsers)
  return { app, env, raw: database.raw, now }
}

describe('admin users D1 list contract', () => {
  it('hydrates allowed groups, group rates, activity, and active subscriptions', async () => {
    const test = fixture()
    const response = await test.app.request(
      '/users?page=1&page_size=1&sort_by=email&sort_order=asc&include_subscriptions=true',
      {},
      test.env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        total: 3,
        page: 1,
        page_size: 1,
        pages: 3,
        items: [{
          id: 'user-alpha',
          restrict_public_groups: 1,
          allowed_groups: ['group-alpha'],
          group_rates: { 'group-alpha': 1.25 },
          current_concurrency: 2,
          last_active_at: new Date(test.now - 2_000).toISOString(),
          last_used_at: new Date(test.now - 500).toISOString(),
          subscriptions: [{
            id: 'subscription-alpha',
            user_id: 'user-alpha',
            group_id: 'group-sub',
            status: 'active',
            daily_usage_usd: 1.5,
            weekly_usage_usd: 2.5,
            monthly_usage_usd: 3.5,
            group: {
              id: 'group-sub',
              name: 'Pro Subscription',
              platform: 'gemini',
              subscription_type: 'subscription',
              rate_multiplier: 1.5,
              daily_limit_usd: 10,
              weekly_limit_usd: 50,
              monthly_limit_usd: 100,
            },
          }],
        }],
      },
    })
  })

  it('intersects allowed-group, API-key-group, and every fuzzy attribute filter', async () => {
    const test = fixture()
    const response = await test.app.request(
      '/users?page=1&page_size=20&group_name=alpha&api_key_group_id=group-alpha&attr%5B1%5D=corp&attr%5B2%5D=engine',
      {},
      test.env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        total: 1,
        pages: 1,
        items: [{ id: 'user-alpha' }],
      },
    })
  })

  it('loads subscriptions by default and omits them only when explicitly disabled', async () => {
    const test = fixture()
    const defaultResponse = await test.app.request(
      '/users?page=1&page_size=1&sort_by=email&sort_order=asc', {}, test.env,
    )
    const disabledResponse = await test.app.request(
      '/users?page=1&page_size=1&sort_by=email&sort_order=asc&include_subscriptions=false',
      {},
      test.env,
    )

    const defaultUser = (await defaultResponse.json() as any).data.items[0]
    const disabledUser = (await disabledResponse.json() as any).data.items[0]
    expect(defaultUser.subscriptions).toMatchObject([{ id: 'subscription-alpha' }])
    expect(disabledUser).not.toHaveProperty('subscriptions')
  })

  it('matches a disabled API key until that key is revoked', async () => {
    const test = fixture()
    const response = await test.app.request(
      '/users?api_key_group_id=group-alpha&sort_by=email&sort_order=asc', {}, test.env,
    )

    expect((await response.json() as any).data.items.map((user: any) => user.id)).toEqual([
      'user-alpha', 'user-gamma',
    ])

    test.raw.prepare(
      `UPDATE api_keys SET revoked_at_ms = ?, updated_at_ms = ? WHERE id = 'key-gamma-disabled'`,
    ).run(test.now, test.now)
    const afterRevoke = await test.app.request(
      '/users?api_key_group_id=group-alpha&sort_by=email&sort_order=asc', {}, test.env,
    )
    expect((await afterRevoke.json() as any).data.items.map((user: any) => user.id)).toEqual([
      'user-alpha',
    ])
  })

  it('searches the reversible API-key name and prefix projections', async () => {
    const test = fixture()
    const byName = await test.app.request('/users?search=disabled%20key', {}, test.env)
    const byPrefix = await test.app.request('/users?search=sk-gamma', {}, test.env)

    expect((await byName.json() as any).data.items.map((user: any) => user.id)).toEqual(['user-gamma'])
    expect((await byPrefix.json() as any).data.items.map((user: any) => user.id)).toEqual(['user-gamma'])
  })

  it('sorts last activity and projected usage with stable null placement', async () => {
    const test = fixture()
    const active = await test.app.request(
      '/users?sort_by=last_active_at&sort_order=asc', {}, test.env,
    )
    const used = await test.app.request(
      '/users?sort_by=last_used_at&sort_order=asc', {}, test.env,
    )
    const usedDescending = await test.app.request(
      '/users?sort_by=last_used_at&sort_order=desc', {}, test.env,
    )

    expect((await active.json() as any).data.items.map((user: any) => user.id)).toEqual([
      'user-alpha', 'user-beta', 'user-gamma',
    ])
    expect((await used.json() as any).data.items.map((user: any) => user.id)).toEqual([
      'user-gamma', 'user-beta', 'user-alpha',
    ])
    expect((await usedDescending.json() as any).data.items.map((user: any) => user.id)).toEqual([
      'user-alpha', 'user-beta', 'user-gamma',
    ])
  })

  it('keeps the original scalar user sorts', async () => {
    const test = fixture()
    const cases: Array<[string, string[]]> = [
      ['balance', ['user-gamma', 'user-beta', 'user-alpha']],
      ['concurrency', ['user-gamma', 'user-beta', 'user-alpha']],
      ['rpm', ['user-gamma', 'user-beta', 'user-alpha']],
      ['created_at', ['user-alpha', 'user-beta', 'user-gamma']],
      ['email', ['user-alpha', 'user-beta', 'user-gamma']],
      ['username', ['user-alpha', 'user-beta', 'user-gamma']],
    ]

    for (const [sortBy, expected] of cases) {
      const response = await test.app.request(
        `/users?sort_by=${sortBy}&sort_order=asc&include_subscriptions=false`, {}, test.env,
      )
      expect((await response.json() as any).data.items.map((user: any) => user.id)).toEqual(expected)
    }
  })

  it('keeps an unknown sort as a typed validation error', async () => {
    const test = fixture()
    const response = await test.app.request('/users?sort_by=definitely_unknown', {}, test.env)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'unsupported_user_sort' },
    })
  })
})
