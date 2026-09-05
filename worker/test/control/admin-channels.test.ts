import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import {
  createAdminChannel,
  deleteAdminChannel,
  getAdminChannel,
  listAdminChannels,
  updateAdminChannel,
} from '../../src/control/channels'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'admin-channels-test-pepper-value-at-least-32-bytes'
const DAY_MS = 86_400_000

interface Fixture {
  raw: any
  env: Env
  headers: Record<string, string>
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
  for (const id of ['group-a', 'group-b', 'group-c']) {
    raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'anthropic', 1, ?, ?)`,
    ).run(id, id, now, now)
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
    headers: { authorization: `Bearer ${access}` },
    env: {
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function app() {
  const api = new Hono<{ Bindings: Env }>()
  api.get('/api/v1/admin/channels', listAdminChannels)
  api.post('/api/v1/admin/channels', createAdminChannel)
  api.get('/api/v1/admin/channels/:id', getAdminChannel)
  api.put('/api/v1/admin/channels/:id', updateAdminChannel)
  api.delete('/api/v1/admin/channels/:id', deleteAdminChannel)
  return api
}

async function request(test: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return app().request(path, {
    ...init,
    headers: { ...test.headers, ...init.headers },
  }, test.env)
}

function mutationHeaders(key: string, version?: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': key,
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
  }
}

async function json(response: Response): Promise<any> {
  return response.json()
}

const completeChannel = {
  name: 'Claude primary',
  description: 'Public catalog only',
  group_ids: ['group-b', 'group-a'],
  billing_model_source: 'channel_mapped',
  restrict_models: true,
  features_config: { batch: true },
  apply_pricing_to_account_stats: false,
  model_mapping: {
    anthropic: { 'claude-3-*': 'claude-3-5-*', 'claude-exact': 'claude-upstream' },
  },
  model_pricing: [{
    platform: 'anthropic',
    models: ['claude-3-*', 'claude-exact'],
    billing_mode: 'token',
    input_micros_per_million: 3_000_000,
    output_micros_per_million: 15_000_000,
    cache_write_micros_per_million: null,
    cache_write_1h_micros_per_million: 3_750_000,
    cache_read_micros_per_million: 300_000,
    image_input_micros_per_million: null,
    image_output_micros_per_million: null,
    per_request_micros: null,
    fast_multiplier_ppm: 1_250_000,
    flex_multiplier_ppm: null,
    time_pricing: {
      timezone: 'Asia/Shanghai', weekdays_only: true,
      periods: [{ start_time: '09:00', end_time: '18:00', multiplier_ppm: 900_000 }],
    },
    intervals: [{
      min_tokens: 0, max_tokens: 199_999, tier_label: 'small',
      input_micros_per_million: 2_500_000,
      output_micros_per_million: null,
      cache_write_micros_per_million: null,
      cache_write_1h_micros_per_million: null,
      cache_read_micros_per_million: null,
      input_multiplier_ppm: null, output_multiplier_ppm: 1_100_000,
      cache_write_multiplier_ppm: null, cache_read_multiplier_ppm: null,
      per_request_micros: null, sort_order: 0,
    }],
  }],
}

describe('admin channels HTTP contract', () => {
  it('creates and reads a normalized channel graph exactly, with idempotency and audit', async () => {
    const test = await fixture()
    const init = {
      method: 'POST', headers: mutationHeaders('channel-create-complete'),
      body: JSON.stringify(completeChannel),
    }
    const created = await request(test, '/api/v1/admin/channels', init)
    expect(created.status).toBe(201)
    expect(created.headers.get('etag')).toBe('"0"')
    const channel = (await json(created)).data
    expect(channel).toMatchObject({
      ...completeChannel,
      status: 'active', control_version: 0,
      group_ids: ['group-a', 'group-b'],
      account_stats_pricing_rules: [],
    })
    expect(channel.model_pricing[0].id).toEqual(expect.any(String))
    expect(channel.model_pricing[0].intervals[0].id).toEqual(expect.any(String))
    expect(channel).not.toHaveProperty('credentials')
    expect(channel).not.toHaveProperty('api_key')

    const replay = await request(test, '/api/v1/admin/channels', init)
    expect(replay.status).toBe(200)
    expect((await json(replay)).data).toEqual(channel)
    const conflictingReplay = await request(test, '/api/v1/admin/channels', {
      ...init,
      body: JSON.stringify({ ...completeChannel, name: 'Different request' }),
    })
    expect(conflictingReplay.status).toBe(409)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM channels').get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      "SELECT action, resource_id FROM admin_channel_audit_events WHERE action = 'channel.create'",
    ).get()).toEqual({ action: 'channel.create', resource_id: channel.id })

    const fetched = await request(test, `/api/v1/admin/channels/${channel.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('etag')).toBe('"0"')
    expect((await json(fetched)).data).toEqual(channel)
  })

  it('lists with legacy disabled filtering, replaces child graphs under CAS, and hard deletes', async () => {
    const test = await fixture()
    const created = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-create-lifecycle'),
      body: JSON.stringify(completeChannel),
    })
    const channel = (await json(created)).data

    const updateInit = {
      method: 'PUT', headers: mutationHeaders('channel-update-lifecycle', 0),
      body: JSON.stringify({
        expected_control_version: 0,
        name: 'Claude inactive', status: 'disabled', group_ids: ['group-c'],
        model_mapping: {}, model_pricing: [],
      }),
    }
    const updated = await request(test, `/api/v1/admin/channels/${channel.id}`, updateInit)
    expect(updated.status).toBe(200)
    expect(updated.headers.get('etag')).toBe('"1"')
    const updatedChannel = (await json(updated)).data
    expect(updatedChannel).toMatchObject({
      name: 'Claude inactive', status: 'disabled', control_version: 1,
      group_ids: ['group-c'], model_mapping: {}, model_pricing: [],
    })
    const updateReplay = await request(test, `/api/v1/admin/channels/${channel.id}`, updateInit)
    expect(updateReplay.status).toBe(200)
    expect((await json(updateReplay)).data).toEqual(updatedChannel)

    const stale = await request(test, `/api/v1/admin/channels/${channel.id}`, {
      method: 'PUT', headers: mutationHeaders('channel-update-stale', 0),
      body: JSON.stringify({ name: 'stale' }),
    })
    expect(stale.status).toBe(412)
    const missingVersion = await request(test, `/api/v1/admin/channels/${channel.id}`, {
      method: 'PUT', headers: mutationHeaders('channel-update-missing-version'),
      body: JSON.stringify({ name: 'missing version' }),
    })
    expect(missingVersion.status).toBe(428)

    const listed = await request(test, '/api/v1/admin/channels?status=disabled&search=inactive&sort_by=name&sort_order=asc')
    expect(listed.status).toBe(200)
    expect((await json(listed)).data).toMatchObject({ total: 1, page: 1, page_size: 20 })

    const deleteInit = {
      method: 'DELETE', headers: mutationHeaders('channel-delete-lifecycle', 1),
    }
    const deleted = await request(test, `/api/v1/admin/channels/${channel.id}`, deleteInit)
    expect(deleted.status).toBe(200)
    expect((await json(deleted)).data).toEqual({ message: 'Channel deleted successfully' })
    const deleteReplay = await request(test, `/api/v1/admin/channels/${channel.id}`, deleteInit)
    expect(deleteReplay.status).toBe(200)
    expect((await json(deleteReplay)).data).toEqual({ message: 'Channel deleted successfully' })
    expect((await request(test, `/api/v1/admin/channels/${channel.id}`)).status).toBe(404)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM channel_groups').get()).toEqual({ total: 0 })
  })

  it('rejects unbounded or inexact commerce input and conflicting group ownership', async () => {
    const test = await fixture()
    const first = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-create-conflict-owner'),
      body: JSON.stringify({ name: 'Owner', group_ids: ['group-a'] }),
    })
    expect(first.status).toBe(201)
    expect((await app().request('/api/v1/admin/channels', {}, test.env)).status).toBe(401)

    const conflict = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-create-conflict-loser'),
      body: JSON.stringify({ name: 'Loser', group_ids: ['group-a'] }),
    })
    expect(conflict.status).toBe(409)

    const floatMoney = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-create-float-money'),
      body: JSON.stringify({
        name: 'Float',
        model_pricing: [{ platform: 'anthropic', models: ['x'], input_micros_per_million: 0.25 }],
      }),
    })
    expect(floatMoney.status).toBe(400)

    const tooManyModels = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-create-too-many-models'),
      body: JSON.stringify({
        name: 'Huge',
        model_pricing: [{ platform: 'anthropic', models: Array.from({ length: 81 }, (_, index) => `m-${index}`) }],
      }),
    })
    expect(tooManyModels.status).toBe(400)
  })

  it('rejects ambiguous wildcard pricing and incomplete billing configurations', async () => {
    const test = await fixture()
    const wildcardConflict = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-pricing-wildcard-conflict'),
      body: JSON.stringify({
        name: 'Ambiguous pricing',
        model_pricing: [
          { platform: 'anthropic', models: ['claude-*'], billing_mode: 'token' },
          { platform: 'anthropic', models: ['claude-3-opus'], billing_mode: 'token' },
        ],
      }),
    })
    expect(wildcardConflict.status).toBe(400)

    const missingPerRequestPrice = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-pricing-missing-per-request'),
      body: JSON.stringify({
        name: 'Incomplete per request',
        model_pricing: [{ platform: 'anthropic', models: ['claude'], billing_mode: 'per_request' }],
      }),
    })
    expect(missingPerRequestPrice.status).toBe(400)

    const emptyInterval = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-pricing-empty-interval'),
      body: JSON.stringify({
        name: 'Empty interval',
        model_pricing: [{
          platform: 'anthropic', models: ['claude'], billing_mode: 'token',
          intervals: [{ min_tokens: 0, max_tokens: null }],
        }],
      }),
    })
    expect(emptyInterval.status).toBe(400)
  })

  it('bounds normalized graph writes to the free-plan D1 query budget', async () => {
    const test = await fixture()
    const mappings = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`public-${index}`, `upstream-${index}`]),
    )

    const response = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-graph-query-budget'),
      body: JSON.stringify({ name: 'Oversized graph', model_mapping: { openai: mappings } }),
    })

    expect(response.status).toBe(400)
    expect((await json(response)).error).toMatchObject({ code: 'invalid_channel_graph' })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM channels').get()).toEqual({ total: 0 })

    const safeMappings = Object.fromEntries(Object.entries(mappings).slice(0, 31))
    const safe = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-graph-safe-query-budget'),
      body: JSON.stringify({ name: 'Bounded graph', model_mapping: { openai: safeMappings } }),
    })
    expect(safe.status).toBe(201)
  })

  it('accepts adjacent token intervals but rejects intervals that truly overlap', async () => {
    const test = await fixture()
    const adjacent = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-token-intervals-adjacent'),
      body: JSON.stringify({
        name: 'Adjacent token tiers',
        model_pricing: [{
          platform: 'anthropic', models: ['claude-adjacent'], billing_mode: 'token',
          intervals: [
            { min_tokens: 0, max_tokens: 100, input_micros_per_million: 1 },
            { min_tokens: 100, max_tokens: 200, input_micros_per_million: 2 },
          ],
        }],
      }),
    })
    expect(adjacent.status).toBe(201)

    const overlap = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-token-intervals-overlap'),
      body: JSON.stringify({
        name: 'Overlapping token tiers',
        model_pricing: [{
          platform: 'anthropic', models: ['claude-overlap'], billing_mode: 'token',
          intervals: [
            { min_tokens: 0, max_tokens: 101, input_micros_per_million: 1 },
            { min_tokens: 100, max_tokens: 200, input_micros_per_million: 2 },
          ],
        }],
      }),
    })
    expect(overlap.status).toBe(400)

    const zeroWidth = await request(test, '/api/v1/admin/channels', {
      method: 'POST', headers: mutationHeaders('channel-token-interval-zero-width'),
      body: JSON.stringify({
        name: 'Zero-width token tier',
        model_pricing: [{
          platform: 'anthropic', models: ['claude-zero-width'], billing_mode: 'token',
          intervals: [{ min_tokens: 100, max_tokens: 100, input_micros_per_million: 1 }],
        }],
      }),
    })
    expect(zeroWidth.status).toBe(400)
  })

  it('treats per-request, image, and video intervals as label tiers instead of token ranges', async () => {
    const test = await fixture()
    for (const mode of ['per_request', 'image', 'video'] as const) {
      const response = await request(test, '/api/v1/admin/channels', {
        method: 'POST', headers: mutationHeaders(`channel-${mode}-label-tiers`),
        body: JSON.stringify({
          name: `${mode} label tiers`,
          model_pricing: [{
            platform: 'anthropic', models: [`claude-${mode}`], billing_mode: mode,
            intervals: [
              { min_tokens: 0, max_tokens: 100, tier_label: '1K', per_request_micros: 40_000 },
              { min_tokens: 0, max_tokens: 100, tier_label: '2K', per_request_micros: 80_000 },
            ],
          }],
        }),
      })
      expect(response.status).toBe(201)
      expect((await json(response)).data.model_pricing[0].intervals).toHaveLength(2)
    }
  })
})
