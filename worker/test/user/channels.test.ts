import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { listAvailableUserChannels } from '../../src/user/channels'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'user-channels-test-pepper-value-32-bytes'

async function fixture(enabled = true): Promise<{ raw: any; env: Env; authorization: string }> {
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
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
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
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
      ASSETS: {} as Fetcher, DB: d1,
      CONFIG_KV: { get: async () => ({ available_channels_enabled: enabled }) } as unknown as KVNamespace,
      OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function app(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/channels/available', listAvailableUserChannels)
  return app
}

function seedGroup(
  raw: any,
  id: string,
  name: string,
  platform: string,
  options: { enabled?: boolean; exclusive?: boolean; type?: 'standard' | 'subscription' } = {},
): void {
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, sort_order, rate_multiplier_ppm,
       group_type, is_exclusive, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, 0, 1000000, ?, ?, 1, 1)`,
  ).run(
    id, name, platform, options.enabled === false ? 0 : 1,
    options.type ?? 'standard', options.exclusive === true ? 1 : 0,
  )
}

function seedChannel(raw: any, id: string, name: string, status: 'active' | 'inactive' = 'active'): void {
  raw.prepare(
    `INSERT INTO channels (id, name, description, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 1)`,
  ).run(id, name, `${name} description`, status)
}

function linkGroup(raw: any, channelId: string, groupId: string): void {
  raw.prepare(
    `INSERT INTO channel_groups (channel_id, group_id, created_at_ms) VALUES (?, ?, 1)`,
  ).run(channelId, groupId)
}

describe('user available channels', () => {
  it('requires an authenticated user before evaluating the feature flag', async () => {
    const test = await fixture(false)
    const get = vi.spyOn(test.env.CONFIG_KV, 'get')

    const response = await app().request('/channels/available', undefined, test.env)

    expect(response.status).toBe(401)
    expect(get).not.toHaveBeenCalled()
  })

  it('fails closed to an empty list when the opt-in flag is absent, false, malformed, or unavailable', async () => {
    for (const value of [undefined, false, 'true'] as const) {
      const test = await fixture()
      test.env.CONFIG_KV = {
        get: async () => value === undefined ? null : { available_channels_enabled: value },
      } as unknown as KVNamespace
      const response = await app().request('/channels/available', {
        headers: { authorization: test.authorization },
      }, test.env)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ code: 0, data: [] })
    }
    const test = await fixture()
    test.env.CONFIG_KV = { get: async () => { throw new Error('KV unavailable') } } as unknown as KVNamespace
    const response = await app().request('/channels/available', {
      headers: { authorization: test.authorization },
    }, test.env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 0, data: [] })
  })

  it('returns only visible channel sections with exact public pricing and no admin fields', async () => {
    const test = await fixture()
    seedGroup(test.raw, 'open-public', 'Open Public', 'openai')
    seedGroup(test.raw, 'open-private', 'Open Private', 'openai', { exclusive: true })
    seedGroup(test.raw, 'gem-sub', 'Gem Subscription', 'gemini', { type: 'subscription' })
    seedGroup(test.raw, 'composite', 'Composite', 'composite', { exclusive: true })
    seedGroup(test.raw, 'hidden', 'Hidden', 'anthropic', { exclusive: true })
    seedGroup(test.raw, 'disabled', 'Disabled', 'openai', { enabled: false })

    seedChannel(test.raw, 'channel-alpha', 'Alpha')
    seedChannel(test.raw, 'channel-beta', 'beta')
    seedChannel(test.raw, 'channel-hidden', 'Hidden Channel')
    seedChannel(test.raw, 'channel-disabled', 'Disabled Channel', 'inactive')
    for (const group of ['open-public', 'open-private', 'gem-sub', 'composite']) {
      linkGroup(test.raw, 'channel-alpha', group)
    }
    linkGroup(test.raw, 'channel-beta', 'disabled')
    linkGroup(test.raw, 'channel-hidden', 'hidden')

    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
       VALUES ('alice', 'open-private', ?), ('alice', 'composite', ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES ('sub-1', 'alice', 'gem-sub', 'active', ?, ?, 'admin', 'grant-1', ?, ?)`,
    ).run(now - 1_000, now + 60_000, now, now)

    test.raw.prepare(
      `INSERT INTO channel_model_pricing (
         id, channel_id, platform, billing_mode, input_micros_per_million,
         output_micros_per_million, cache_read_micros_per_million,
         per_request_micros, created_at_ms, updated_at_ms
       ) VALUES
         ('price-open', 'channel-alpha', 'openai', 'token', 1000000, 2000000, 250000, NULL, 1, 1),
         ('price-alias', 'channel-alpha', 'openai', 'token', 3000000, 4000000, NULL, NULL, 1, 1),
         ('price-gem', 'channel-alpha', 'gemini', 'per_request', NULL, NULL, NULL, 50000, 1, 1)`,
    ).run()
    test.raw.prepare(
      `INSERT INTO channel_pricing_models (
         pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
       ) VALUES
         ('price-open', 'gpt-5', 0, 0, 1),
         ('price-open', 'gpt-*', 1, 1, 1),
         ('price-alias', 'internal-alpha', 0, 0, 1),
         ('price-alias', 'GPT-CASE', 0, 1, 1),
         ('price-gem', 'gemini-pro', 0, 0, 1)`,
    ).run()
    test.raw.prepare(
      `INSERT INTO channel_pricing_intervals (
         id, pricing_id, min_tokens, max_tokens, tier_label,
         input_micros_per_million, output_micros_per_million,
         sort_order, created_at_ms, updated_at_ms
       ) VALUES ('interval-open', 'price-open', 0, 200000, 'standard', 800000, 1600000, 0, 1, 1)`,
    ).run()
    test.raw.prepare(
      `INSERT INTO channel_model_mappings (
         channel_id, platform, source_pattern, target_pattern,
         source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
       ) VALUES
         ('channel-alpha', 'openai', 'gpt-public', 'gpt-5', 0, 0, 0, 1),
         ('channel-alpha', 'openai', 'gpt-case', 'GPT-CASE', 0, 0, 1, 1),
         ('channel-alpha', 'openai', 'public-*', 'internal-*', 1, 1, 2, 1),
         ('channel-alpha', 'openai', 'gpt-*', 'gpt-*', 1, 1, 3, 1)`,
    ).run()

    const response = await app().request('/channels/available', {
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<Record<string, unknown>> }
    expect(body.data).toEqual([{
      name: 'Alpha', description: 'Alpha description',
      platforms: [
        {
          platform: 'gemini',
          groups: [
            visibleGroup('gem-sub', 'Gem Subscription', 'gemini', 'subscription', false),
            visibleGroup('composite', 'Composite', 'composite', 'standard', true),
          ],
          supported_models: [{
            name: 'gemini-pro', platform: 'gemini',
            pricing: publicPricing('per_request', null, null, null, 0.05, []),
          }],
        },
        {
          platform: 'openai',
          groups: [
            visibleGroup('open-private', 'Open Private', 'openai', 'standard', true),
            visibleGroup('open-public', 'Open Public', 'openai', 'standard', false),
            visibleGroup('composite', 'Composite', 'composite', 'standard', true),
          ],
          supported_models: [
            {
              name: 'gpt-5', platform: 'openai',
              pricing: publicPricing('token', 0.000001, 0.000002, 2.5e-7, null, [{
                min_tokens: 0, max_tokens: 200000, tier_label: 'standard',
                input_price: 8e-7, output_price: 0.0000016,
                cache_write_price: null, cache_write_1h_price: null,
                cache_read_price: null, per_request_price: null,
              }]),
            },
            {
              name: 'GPT-CASE', platform: 'openai',
              pricing: publicPricing('token', 0.000003, 0.000004, null, null, []),
            },
            {
              name: 'gpt-public', platform: 'openai',
              pricing: publicPricing('token', 0.000001, 0.000002, 2.5e-7, null, [{
                min_tokens: 0, max_tokens: 200000, tier_label: 'standard',
                input_price: 8e-7, output_price: 0.0000016,
                cache_write_price: null, cache_write_1h_price: null,
                cache_read_price: null, per_request_price: null,
              }]),
            },
            {
              name: 'internal-alpha', platform: 'openai',
              pricing: publicPricing('token', 0.000003, 0.000004, null, null, []),
            },
            {
              name: 'public-alpha', platform: 'openai',
              pricing: publicPricing('token', 0.000003, 0.000004, null, null, []),
            },
          ],
        },
      ],
    }])
    expect(JSON.stringify(body)).not.toContain('channel-alpha')
    expect(JSON.stringify(body)).not.toContain('billing_model_source')
    expect(JSON.stringify(body)).not.toContain('restrict_models')
    expect(JSON.stringify(body)).not.toContain('Hidden Channel')
    expect(JSON.stringify(body)).not.toContain('Disabled Channel')
  })
})

function visibleGroup(
  id: string,
  name: string,
  platform: string,
  subscriptionType: string,
  exclusive: boolean,
): Record<string, unknown> {
  return {
    id, name, platform, subscription_type: subscriptionType, rate_multiplier: 1,
    peak_rate_enabled: false, peak_start: '', peak_end: '',
    peak_rate_multiplier: 1, is_exclusive: exclusive,
  }
}

function publicPricing(
  billingMode: string,
  inputPrice: number | null,
  outputPrice: number | null,
  cacheReadPrice: number | null,
  perRequestPrice: number | null,
  intervals: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    billing_mode: billingMode, input_price: inputPrice, output_price: outputPrice,
    cache_write_price: null, cache_write_1h_price: null, cache_read_price: cacheReadPrice,
    image_input_price: null, image_output_price: null, per_request_price: perRequestPrice,
    intervals,
  }
}
