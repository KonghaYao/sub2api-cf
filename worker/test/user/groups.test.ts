import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { getUserGroupRates, listAvailableUserGroups } from '../../src/user/groups'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'user-groups-test-pepper-value-32-bytes-minimum'

async function fixture(): Promise<{ raw: any; env: Env; authorization: string }> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
     VALUES ('alice', 'alice@example.test', 'Alice', ?, ?)`,
  ).run(now, now)

  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version,
       access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('session-alice', 'family-alice', 'alice', 1, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now,
    now + 60_000,
    now + 600_000,
  )

  return {
    raw,
    authorization: `Bearer ${accessToken}`,
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
  app.get('/groups/available', listAvailableUserGroups)
  app.get('/groups/rates', getUserGroupRates)
  return app
}

function seedGroup(
  raw: any,
  input: {
    id: string
    name: string
    enabled?: boolean
    sortOrder?: number
    rateMultiplierPpm?: number
    description?: string | null
    groupType?: 'standard' | 'subscription'
    isExclusive?: boolean
    platform?: 'openai' | 'gemini'
    allowImageGeneration?: boolean
    allowBatchImageGeneration?: boolean
  },
): void {
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, description, platform, enabled, sort_order,
       rate_multiplier_ppm, group_type, is_exclusive, allow_image_generation,
       allow_batch_image_generation, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 100)`,
  ).run(
    input.id,
    input.name,
    input.description ?? null,
    input.platform ?? 'openai',
    input.enabled === false ? 0 : 1,
    input.sortOrder ?? 0,
    input.rateMultiplierPpm ?? 1_000_000,
    input.groupType ?? 'standard',
    input.isExclusive === true ? 1 : 0,
    input.allowImageGeneration === true ? 1 : 0,
    input.allowBatchImageGeneration === true ? 1 : 0,
  )
}

describe('user groups', () => {
  it('requires a live user session for both group endpoints', async () => {
    const test = await fixture()

    const available = await app().request('/groups/available', undefined, test.env)
    const rates = await app().request('/groups/rates', undefined, test.env)

    expect(available.status).toBe(401)
    expect(rates.status).toBe(401)
  })

  it('lists public, explicitly permitted, and actively subscribed groups in stable display order', async () => {
    const test = await fixture()
    seedGroup(test.raw, {
      id: 'standard',
      name: 'Standard',
      description: 'Default access',
      sortOrder: 30,
      rateMultiplierPpm: 1_250_000,
    })
    seedGroup(test.raw, {
      id: 'exclusive',
      name: 'Exclusive',
      isExclusive: true,
      sortOrder: 10,
    })
    seedGroup(test.raw, {
      id: 'subscription',
      name: 'Subscription',
      groupType: 'subscription',
      sortOrder: 20,
    })
    seedGroup(test.raw, {
      id: 'unavailable-exclusive',
      name: 'Unavailable exclusive',
      isExclusive: true,
      sortOrder: 0,
    })
    seedGroup(test.raw, {
      id: 'expired-subscription',
      name: 'Expired subscription',
      groupType: 'subscription',
      sortOrder: 0,
    })
    seedGroup(test.raw, { id: 'disabled', name: 'Disabled', enabled: false, sortOrder: 0 })
    seedGroup(test.raw, {
      id: 'gemini-images',
      name: 'Gemini Images',
      platform: 'gemini',
      allowImageGeneration: true,
      allowBatchImageGeneration: true,
      sortOrder: 40,
    })
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
       VALUES ('alice', 'exclusive', ?)`,
    ).run(now)
    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES (?, 'alice', ?, ?, ?, ?, 'admin', ?, ?, ?)`,
    ).run(
      'active-subscription',
      'subscription',
      'active',
      now - 10_000,
      now + 60_000,
      'grant-active',
      now,
      now,
    )
    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES (?, 'alice', ?, ?, ?, ?, 'admin', ?, ?, ?)`,
    ).run(
      'expired-subscription-record',
      'expired-subscription',
      'active',
      now - 60_000,
      now - 1,
      'grant-expired',
      now,
      now,
    )

    const response = await app().request('/groups/available', {
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-sub2api-group-access-policy')).toBe(
      'public-permission-or-active-subscription',
    )
    const body = await response.json() as { data: Array<Record<string, unknown>> }
    expect(body.data).toEqual([
      {
        id: 'exclusive',
        name: 'Exclusive',
        description: null,
        platform: 'openai',
        rate_multiplier: 1,
        is_exclusive: true,
        status: 'active',
        subscription_type: 'standard',
        allow_image_generation: false,
        allow_batch_image_generation: false,
      },
      {
        id: 'subscription',
        name: 'Subscription',
        description: null,
        platform: 'openai',
        rate_multiplier: 1,
        is_exclusive: false,
        status: 'active',
        subscription_type: 'subscription',
        allow_image_generation: false,
        allow_batch_image_generation: false,
      },
      {
        id: 'standard',
        name: 'Standard',
        description: 'Default access',
        platform: 'openai',
        rate_multiplier: 1.25,
        is_exclusive: false,
        status: 'active',
        subscription_type: 'standard',
        allow_image_generation: false,
        allow_batch_image_generation: false,
      },
      {
        id: 'gemini-images',
        name: 'Gemini Images',
        description: null,
        platform: 'gemini',
        rate_multiplier: 1,
        is_exclusive: false,
        status: 'active',
        subscription_type: 'standard',
        allow_image_generation: true,
        allow_batch_image_generation: true,
      },
    ])
    expect(JSON.stringify(body)).not.toContain('Disabled')
    expect(JSON.stringify(body)).not.toContain('Unavailable exclusive')
    expect(JSON.stringify(body)).not.toContain('Expired subscription')
    expect(body.data[0]).not.toHaveProperty('control_version')
    expect(body.data[0]).not.toHaveProperty('rate_multiplier_ppm')
  })

  it('returns only overrides for groups the user can currently access', async () => {
    const test = await fixture()
    seedGroup(test.raw, { id: 'standard', name: 'Standard', rateMultiplierPpm: 1_250_000 })
    seedGroup(test.raw, { id: 'exclusive', name: 'Exclusive', isExclusive: true })
    seedGroup(test.raw, { id: 'disabled', name: 'Disabled', enabled: false })
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO user_group_rate_overrides (
         user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
       ) VALUES ('alice', ?, ?, ?, ?)`,
    ).run('standard', 800_000, now, now)
    test.raw.prepare(
      `INSERT INTO user_group_rate_overrides (
         user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
       ) VALUES ('alice', ?, ?, ?, ?)`,
    ).run('exclusive', 700_000, now, now)
    test.raw.prepare(
      `INSERT INTO user_group_rate_overrides (
         user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
       ) VALUES ('alice', ?, ?, ?, ?)`,
    ).run('disabled', 600_000, now, now)

    const response = await app().request('/groups/rates', {
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-sub2api-group-rates-policy')).toBe('accessible-overrides-only')
    await expect(response.json()).resolves.toEqual({ code: 0, data: { standard: 0.8 } })
  })
})
