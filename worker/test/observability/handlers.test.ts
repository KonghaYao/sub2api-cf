import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import {
  getAdminErrorAggregation,
  getAdminRequestDetail,
  getAdminRequestErrorDetail,
  getAdminUpstreamErrorDetail,
  getOwnerErrorDetail,
  listAdminUsage,
  getOwnerRequestDetail,
  listAdminRequestErrors,
  listAdminRequests,
  listAdminUpstreamErrors,
  listOwnerErrors,
  listOwnerRequests,
  listRelatedUpstreamErrors,
} from '../../src/observability/handlers'
import { recordRequestOutcome, recordRequestStart } from '../../src/observability/recorder'
import {
  actOnAdminRequestError,
  actOnAdminUpstreamError,
} from '../../src/observability/resolution'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'observability-handler-pepper-32-bytes'

async function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`UPDATE system_settings SET public_json=json_set(public_json,'$.allow_user_view_error_requests',json('true')) WHERE id='global'`)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', ?, ?),
            ('alice', 'alice@example.test', 'Alice', 'user', ?, ?),
            ('bob', 'bob@example.test', 'Bob', 'user', ?, ?)`,
  ).run(now, now, now, now, now, now)
  const auth: Record<string, string> = {}
  for (const user of ['admin', 'alice', 'bob']) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `session-${user}`, `family-${user}`, user,
      await tokenDigest(access, PEPPER, 'access'), await tokenDigest(refresh, PEPPER, 'refresh'),
      now, now + 60_000, now + 600_000,
    )
    auth[user] = `Bearer ${access}`
  }
  const objects = new Map<string, string>()
  const bucket = {
    put: vi.fn(async (key: string, value: string) => { objects.set(key, value) }),
    get: vi.fn(async (key: string) => {
      const value = objects.get(key)
      return value === undefined ? null : { text: async () => value }
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key) }),
    list: vi.fn(),
  }
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch: async () => Response.json({}) }),
  } as unknown as DurableObjectNamespace
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER, DB: d1,
    OBJECTS: bucket, EVENTS_QUEUE: { send: vi.fn() }, CONFIG_KV: {} as KVNamespace,
    ASSETS: {} as Fetcher, USER_STATE: namespace, POOL_STATE: namespace,
  } as unknown as Env
  return { raw, env, auth, objects }
}

function app() {
  const api = new Hono<{ Bindings: Env }>()
  api.get('/usage', listOwnerRequests)
  api.get('/usage/errors', listOwnerErrors)
  api.get('/usage/errors/:id', getOwnerErrorDetail)
  api.get('/usage/:id', getOwnerRequestDetail)
  api.get('/admin/usage', listAdminUsage)
  api.get('/admin/ops/requests', listAdminRequests)
  api.get('/admin/ops/requests/:id', getAdminRequestDetail)
  api.get('/admin/ops/request-errors', listAdminRequestErrors)
  api.get('/admin/ops/upstream-errors', listAdminUpstreamErrors)
  api.get('/admin/ops/request-errors/:id/upstream-errors', listRelatedUpstreamErrors)
  api.get('/admin/ops/request-errors/:id', getAdminRequestErrorDetail)
  api.get('/admin/ops/upstream-errors/:id', getAdminUpstreamErrorDetail)
  api.post('/admin/ops/request-errors/:id/:action', actOnAdminRequestError)
  api.post('/admin/ops/upstream-errors/:id/:action', actOnAdminUpstreamError)
  api.get('/admin/ops/error-aggregation', getAdminErrorAggregation)
  return api
}

async function seed(test: Awaited<ReturnType<typeof fixture>>, input: {
  requestId: string; userId: string; at: number; status: number; owner?: string
}) {
  const handle = await recordRequestStart(test.env, {
    requestId: input.requestId, userId: input.userId, apiKeyId: `key-${input.userId}`,
    method: 'POST', requestPath: '/v1/responses', requestedModel: 'gpt-5.5',
    occurredAtMs: input.at,
  })
  await recordRequestOutcome(test.env, handle!, {
    lifecycle: input.status >= 400 ? 'failed' : 'completed', statusCode: input.status,
    completedAtMs: input.at + 10, durationMs: 10,
    error: input.status >= 400 ? {
      phase: input.owner === 'provider' ? 'upstream' : 'request',
      type: 'invalid_request_error', owner: input.owner ?? 'client', source: 'gateway',
      message: 'safe error', upstreamStatusCode: input.status,
    } : undefined,
    payload: { error: { body: { detail: 'safe', api_key: 'sk-hidden-value' } } },
  })
  return handle!
}

describe('request explorer HTTP contracts', () => {
  it('serves the original admin Usage table from the billing projection with exact filters and stable offset pagination', async () => {
    const test = await fixture()
    const now = Date.parse('2026-09-01T16:30:00.000Z')
    test.raw.prepare(`INSERT INTO api_keys (id,user_id,key_hash,name,created_at_ms,updated_at_ms) VALUES ('key-alice','alice',?,'Alice key',?,?)`)
      .run('a'.repeat(64), now, now)
    test.raw.prepare(`INSERT INTO "groups" (id,name,platform,created_at_ms,updated_at_ms) VALUES ('group-a','Premium','openai',?,?)`)
      .run(now, now)
    test.raw.prepare(`INSERT INTO accounts (id,platform,name,credential_ref,created_at_ms,updated_at_ms) VALUES ('account-a','openai','Primary','vault:a',?,?)`)
      .run(now, now)
    const insert = test.raw.prepare(`INSERT INTO usage_projection (
      event_id,request_id,user_id,api_key_id,account_id,model,requested_model,upstream_model,
      group_id,input_tokens,output_tokens,cache_read_tokens,input_amount_micros,output_amount_micros,
      cache_amount_micros,base_amount_micros,amount_micros,billing_type,outcome,stream,duration_ms,
      occurred_at_ms,projected_at_ms,platform,request_type,inbound_endpoint,upstream_endpoint,
      billing_mode,native_compaction_v2,dimensions_version,standard_cost_micros,
      account_stats_cost_micros,account_rate_multiplier_ppm,account_cost_micros
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    insert.run('usage-z','request-z','alice','key-alice','account-a','zeta','zeta','zeta-upstream',
      'group-a',10,2,3,100,200,300,0,900,'subscription','completed',1,50,
      now,now,'openai',2,'/v1/responses','/responses','image',1,1,600,700,1250000,875)
    insert.run('usage-a','request-a','alice','key-alice','account-a','alpha','alpha','alpha',
      'group-a',1,2,0,100,200,0,0,300,'balance','completed',0,25,
      now,now,'openai',1,'/v1/chat/completions','/chat/completions','token',0,1,300,300,1000000,300)

    const response = await app().request(
      '/admin/usage?page=1&page_size=1&sort_by=model&sort_order=desc&user_id=alice&api_key_id=key-alice&account_id=account-a&group_id=group-a&model=zeta&request_type=stream&native_compaction_v2=true&billing_type=1&billing_mode=image',
      { headers: { authorization: test.auth.admin! } },
      test.env,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        total: 1, page: 1, page_size: 1, pages: 1,
        items: [{
          id: 'usage-z', user_id: 'alice', model: 'zeta', upstream_model: 'zeta-upstream',
          input_tokens: 10, cache_read_tokens: 3, total_cost: 0.0006, actual_cost: 0.0009,
          rate_multiplier: 1.5, upstream_model_mismatch: null, upstream_response_model: null,
          account_stats_cost: 0.0007, account_rate_multiplier: 1.25,
          user: { email: 'alice@example.test' }, api_key: { name: 'Alice key' },
          account: { name: 'Primary' }, group: { name: 'Premium' },
          request_type: 'stream', billing_type: 1, billing_mode: 'image', native_compaction_v2: true,
        }],
      },
    })
    const production = createApp()
    const stats = await production.request('/api/v1/admin/usage/stats?user_id=alice&billing_type=subscription', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    await expect(stats.json()).resolves.toMatchObject({ data: { total_requests: 1, total_cost: 0.0006, total_actual_cost: 0.0009 } })
    const localDay = await production.request(
      '/api/v1/admin/usage?page=1&page_size=10&start_date=2026-09-02&end_date=2026-09-02&timezone=Asia%2FShanghai&model=zeta',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    await expect(localDay.json()).resolves.toMatchObject({ data: { total: 1, items: [{ id: 'usage-z' }] } })
    const models = await production.request(
      '/api/v1/admin/dashboard/models?user_id=alice&model=zeta&start_date=2026-09-02&end_date=2026-09-02&timezone=Asia%2FShanghai&model_source=requested',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    await expect(models.json()).resolves.toMatchObject({
      data: { models: [{ model: 'zeta', requests: 1, cost: 0.0006, actual_cost: 0.0009 }] },
    })
    const users = await production.request('/api/v1/admin/usage/search-users?q=alice', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    await expect(users.json()).resolves.toMatchObject({ data: [{ id: 'alice', email: 'alice@example.test' }] })
    const keys = await production.request('/api/v1/admin/usage/search-api-keys?user_id=alice&q=Alice', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    await expect(keys.json()).resolves.toMatchObject({ data: [{ id: 'key-alice', name: 'Alice key' }] })
    const cleanup = await production.request('/api/v1/admin/usage/cleanup-tasks', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(cleanup.status).toBe(501)
    await expect(cleanup.json()).resolves.toMatchObject({ code: 'usage_cleanup_not_migrated' })
    const mismatch = await production.request('/api/v1/admin/usage?page=1&page_size=20&upstream_model_mismatch=true', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(mismatch.status).toBe(501)
    await expect(mismatch.json()).resolves.toMatchObject({ code: 'upstream_model_audit_not_migrated' })
    const analytics = await production.request('/api/v1/admin/dashboard/snapshot-v2', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(analytics.status).toBe(200)
    await expect(analytics.json()).resolves.toMatchObject({ code: 0, data: { stats: { total_requests: 2 } } })
    test.raw.close()
  })

  it('supports the original admin Usage error tab filters, sorting, and exact offset count', async () => {
    const test = await fixture()
    const now = Date.now()
    await seed(test, { requestId: 'req-client', userId: 'alice', at: now - 2, status: 400 })
    await seed(test, { requestId: 'req-provider', userId: 'alice', at: now - 1, status: 502, owner: 'provider' })
    const response = await app().request(
      `/admin/ops/request-errors?page=1&page_size=1&user_id=alice&phase=upstream&category=upstream&status_code=502&sort_by=status&sort_order=asc&start_time=${encodeURIComponent(new Date(now - 1000).toISOString())}&end_time=${encodeURIComponent(new Date(now + 1000).toISOString())}`,
      { headers: { authorization: test.auth.admin! } },
      test.env,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { total: 1, page: 1, page_size: 1, pages: 1, items: [{ request_id: 'req-provider' }] },
    })
    const requestCategory = await app().request(
      '/admin/ops/request-errors?page=1&page_size=10&category=invalid_request',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    await expect(requestCategory.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ request_id: 'req-client' }] },
    })
    const cursorSort = await app().request('/admin/ops/request-errors?sort_by=status', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(cursorSort.status).toBe(400)
    await expect(cursorSort.json()).resolves.toMatchObject({ code: 'unsupported_pagination_or_search' })
    test.raw.close()
  })

  it('serves the original Ops offset filters, request presets, opaque ids, and bounded related details', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO api_keys (id,user_id,key_hash,key_prefix,name,created_at_ms,updated_at_ms)
       VALUES ('key-alice','alice',?,'sk-live-…cdef','Alice key',?,?)`,
    ).run('b'.repeat(64), now, now)
    test.raw.prepare(
      `INSERT INTO api_keys (id,user_id,key_hash,key_prefix,name,created_at_ms,updated_at_ms,revoked_at_ms)
       VALUES ('key-revoked','alice',?,'sk-old-…cdef','Revoked key',?,?,?)`,
    ).run('c'.repeat(64), now, now, now)
    const client = await seed(test, { requestId: 'req-needle-client', userId: 'alice', at: now - 3, status: 418 })
    const provider = await seed(test, {
      requestId: 'req-needle-client', userId: 'alice', at: now - 2, status: 502, owner: 'provider',
    })
    test.raw.prepare(
      `UPDATE request_observations
          SET status_code=599, upstream_endpoint='/responses', client_ip='203.0.113.8',
              user_agent='ops-test-agent', client_request_id='shared-client-id'
        WHERE id=?`,
    ).run(provider.id)
    const provider503 = await seed(test, {
      requestId: 'req-needle-client', userId: 'alice', at: now - 1, status: 503, owner: 'provider',
    })
    test.raw.prepare(
      `UPDATE request_observations
          SET api_key_id='key-revoked', client_request_id='shared-client-id'
        WHERE id=?`,
    ).run(provider503.id)
    const unrelated = await seed(test, {
      requestId: 'req-other', userId: 'alice', at: now, status: 504, owner: 'provider',
    })
    test.raw.prepare("UPDATE request_observations SET client_request_id='shared-client-id' WHERE id=?").run(unrelated.id)
    const largeRelated = await recordRequestStart(test.env, {
      requestId: 'req-needle-client', userId: 'alice', apiKeyId: 'key-alice', method: 'POST',
      requestPath: '/v1/responses', requestedModel: 'gpt-5.5', occurredAtMs: now,
    })
    await recordRequestOutcome(test.env, largeRelated!, {
      lifecycle: 'failed', statusCode: 501, completedAtMs: now + 10, durationMs: 10,
      error: {
        phase: 'upstream', type: 'upstream_error', owner: 'provider', source: 'upstream',
        message: 'large upstream response', upstreamStatusCode: 501,
      },
      payload: { error: { body: { detail: 'x'.repeat(20_000) } } },
    })
    const success = await seed(test, { requestId: 'req-success', userId: 'bob', at: now - 1, status: 200 })
    const started = await recordRequestStart(test.env, {
      requestId: 'req-started', userId: 'alice', method: 'POST', requestPath: '/v1/responses',
      requestedModel: 'gpt-5.5', occurredAtMs: now,
    })
    const cancelled = await recordRequestStart(test.env, {
      requestId: 'req-cancelled', userId: 'alice', method: 'POST', requestPath: '/v1/responses',
      requestedModel: 'gpt-5.5', occurredAtMs: now,
    })
    await recordRequestOutcome(test.env, cancelled!, {
      lifecycle: 'cancelled', statusCode: 499, completedAtMs: now + 1, durationMs: 1,
    })
    test.raw.prepare(
      `UPDATE request_observations
          SET group_id='group_01HZZ', duration_ms=900
        WHERE id=?`,
    ).run(success.id)
    test.raw.prepare(
      `UPDATE request_observations
          SET is_business_limited=1
        WHERE id=?`,
    ).run(client.id)

    const errors = await app().request(
      `/admin/ops/request-errors?page=1&page_size=10&q=alice%40example.test&error_owner=client&view=excluded&status_codes_other=1&sort_by=model&sort_order=asc&start_time=${encodeURIComponent(new Date(now - 1000).toISOString())}&end_time=${encodeURIComponent(new Date(now + 1000).toISOString())}`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(errors.status).toBe(200)
    await expect(errors.json()).resolves.toMatchObject({
      data: { total: 1, page: 1, page_size: 10, items: [{ id: client.id, request_id: 'req-needle-client' }] },
    })
    for (const [query, expected] of [['req-needle-client', 4], ['gpt-5.5', 5]] as const) {
      const searched = await app().request(
        `/admin/ops/request-errors?page=1&page_size=10&q=${encodeURIComponent(query)}&view=all`,
        { headers: { authorization: test.auth.admin! } }, test.env,
      )
      expect(searched.status).toBe(200)
      expect(((await searched.json()) as any).data.total).toBe(expected)
    }

    const requests = await app().request(
      `/admin/ops/requests?page=1&page_size=10&kind=success&sort=duration_desc&min_duration_ms=800&max_duration_ms=1000&group_id=group_01HZZ`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(requests.status).toBe(200)
    await expect(requests.json()).resolves.toMatchObject({
      data: { total: 1, page: 1, page_size: 10, items: [{ id: success.id, group_id: 'group_01HZZ', duration_ms: 900 }] },
    })

    const allSettledRequests = await app().request(
      '/admin/ops/requests?page=1&page_size=10&kind=all&sort=created_at_desc',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    await expect(allSettledRequests.json()).resolves.toMatchObject({ data: { total: 6 } })
    const successfulRequests = await app().request(
      '/admin/ops/requests?page=1&page_size=10&kind=success&sort=created_at_desc',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    const successfulRequestBody = await successfulRequests.json() as any
    expect(successfulRequestBody.data).toMatchObject({
      total: 1,
      items: [{ id: success.id, kind: 'success' }],
    })

    const failedRequests = await app().request(
      '/admin/ops/requests?page=1&page_size=10&kind=error&sort=created_at_desc',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    const failedRequestBody = await failedRequests.json() as any
    expect(failedRequestBody.data.total).toBe(5)
    expect(failedRequestBody.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: client.id, error_id: client.id, kind: 'error' }),
      expect.objectContaining({ id: provider.id, error_id: provider.id, kind: 'error', status_code: 502 }),
      expect.objectContaining({ id: provider503.id, error_id: provider503.id, kind: 'error', status_code: 503 }),
    ]))
    expect(failedRequestBody.data.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: started!.id }),
      expect.objectContaining({ id: cancelled!.id }),
    ]))

    const upstream = await app().request(
      '/admin/ops/upstream-errors?page=1&page_size=10&view=all&sort_by=status_code&sort_order=desc',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(upstream.status).toBe(200)
    await expect(upstream.json()).resolves.toMatchObject({
      data: {
        total: 4,
        items: [
          { id: unrelated.id, status_code: 504 },
          { id: provider503.id, status_code: 503 },
          {
            id: provider.id, status_code: 502, upstream_endpoint: '/responses',
            client_ip: '203.0.113.8', user_agent: 'ops-test-agent', api_key_deleted: false,
          },
          { id: largeRelated!.id, status_code: 501 },
        ],
      },
    })

    const exactEffectiveStatus = await app().request(
      '/admin/ops/request-errors?page=1&page_size=10&status_code=502&view=all',
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    await expect(exactEffectiveStatus.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ id: provider.id, status_code: 502 }] },
    })

    const detail = await app().request(`/admin/ops/request-errors/${client.id}`, {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    const detailBody = await detail.json() as any
    expect(detailBody.data).toMatchObject({ api_key_prefix: 'sk-live-…cdef' })
    expect(detailBody.data.error_body).toContain('[REDACTED]')
    expect(detailBody.data.error_body).not.toContain('schema_version')
    expect(detailBody.data.upstream_error_detail).toBeUndefined()

    const related = await app().request(
      `/admin/ops/request-errors/${client.id}/upstream-errors?page=1&page_size=100&view=all&include_detail=1`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(related.status).toBe(200)
    const relatedBody = await related.json() as any
    expect(relatedBody.data.total).toBe(3)
    expect(relatedBody.data.page_size).toBe(100)
    expect(relatedBody.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: provider.id,
        payload: expect.objectContaining({ state: 'available', redacted: true }),
      }),
    ]))
    expect(relatedBody.data.items[0].payload.body).not.toContain('sk-hidden-value')
    expect(relatedBody.data.items.map((item: any) => item.id)).not.toContain(unrelated.id)
    expect(relatedBody.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: provider503.id, api_key_deleted: true }),
    ]))
    const largeRelatedProjection = relatedBody.data.items.find((item: any) => item.id === largeRelated!.id)
    expect(largeRelatedProjection.payload.body.length).toBeLessThanOrEqual(16_400)
    expect(largeRelatedProjection.payload.body).toContain('…[truncated]')
    expect(largeRelatedProjection.error_body).toContain('…[truncated]')

    const unsupported = await app().request('/admin/ops/requests?page=1&page_size=10&unknown_filter=1', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(unsupported.status).toBe(400)
    await expect(unsupported.json()).resolves.toMatchObject({ code: 'unsupported_ops_parameter' })
    const invalidSort = await app().request('/admin/ops/request-errors?page=1&page_size=10&sort_by=secret', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(invalidSort.status).toBe(400)
    await expect(invalidSort.json()).resolves.toMatchObject({ code: 'unsupported_error_sort' })
    const paginationConflict = await app().request('/admin/ops/requests?page=1&cursor=forged', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(paginationConflict.status).toBe(400)
    await expect(paginationConflict.json()).resolves.toMatchObject({ code: 'pagination_mode_conflict' })
    const deepOffset = await app().request('/admin/ops/requests?page=102&page_size=100', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(deepOffset.status).toBe(400)
    await expect(deepOffset.json()).resolves.toMatchObject({ code: 'ops_offset_too_deep' })
    const wideSearch = await app().request(
      `/admin/ops/request-errors?page=1&page_size=10&q=needle&start_time=${encodeURIComponent(new Date(now - 48 * 60 * 60 * 1000).toISOString())}&end_time=${encodeURIComponent(new Date(now).toISOString())}`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(wideSearch.status).toBe(422)
    await expect(wideSearch.json()).resolves.toMatchObject({ code: 'ops_search_window_too_wide' })
    const dashboardContract = await createApp().request('/api/v1/admin/ops/dashboard/overview', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(dashboardContract.status).toBe(200)
    await expect(dashboardContract.json()).resolves.toMatchObject({ code: 0 })
    test.raw.close()
  })

  it('resolves a failed observation using an explicit version and server-derived actor', async () => {
    const test = await fixture()
    const failed = await seed(test, {
      requestId: 'req-resolution', userId: 'alice', at: Date.now() - 1_000, status: 502,
      owner: 'provider',
    })
    const api = app()
    const before = await api.request(`/admin/ops/request-errors/${failed.id}`, {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(before.status).toBe(200)
    const beforeBody = await before.json() as any
    expect(beforeBody.data).toMatchObject({ resolved: false, control_version: 0 })
    expect(before.headers.get('etag')).toBe(`"${beforeBody.data.control_version}"`)

    const resolved = await api.request(`/admin/ops/request-errors/${failed.id}/resolve`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-observation-0001',
        'if-match': `"${beforeBody.data.control_version}"`,
      },
      body: '{}',
    }, test.env)

    expect(resolved.status).toBe(200)
    const resolvedBody = await resolved.json() as any
    expect(resolvedBody.data).toMatchObject({
      id: failed.id,
      resolved: true,
      resolved_by_user_id: 'admin',
      resolved_at: expect.any(String),
      control_version: 1,
    })
    expect(resolvedBody.data.control_version).toBeGreaterThan(beforeBody.data.control_version)
    expect(resolved.headers.get('etag')).toBe(`"${resolvedBody.data.control_version}"`)

    const replay = await api.request(`/admin/ops/request-errors/${failed.id}/resolve`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-observation-0001',
        'if-match': `"${beforeBody.data.control_version}"`,
      },
      body: '{}',
    }, test.env)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toEqual(resolvedBody)

    const conflictingReplay = await api.request(`/admin/ops/request-errors/${failed.id}/reopen`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-observation-0001',
        'if-match': `"${resolvedBody.data.control_version}"`,
      },
      body: '{}',
    }, test.env)
    expect(conflictingReplay.status).toBe(409)
    await expect(conflictingReplay.json()).resolves.toMatchObject({ code: 'idempotency_conflict' })

    const stale = await api.request(`/admin/ops/request-errors/${failed.id}/reopen`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': 'reopen-observation-stale-0001',
        'if-match': `"${beforeBody.data.control_version}"`,
      },
      body: '{}',
    }, test.env)
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ code: 'request_observation_changed' })

    const forgedActor = await api.request(`/admin/ops/request-errors/${failed.id}/reopen`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': 'reopen-observation-forged-0001',
        'if-match': `"${resolvedBody.data.control_version}"`,
      },
      body: JSON.stringify({ actor_user_id: 'bob' }),
    }, test.env)
    expect(forgedActor.status).toBe(400)
    await expect(forgedActor.json()).resolves.toMatchObject({
      code: 'invalid_observation_resolution_body',
    })

    const reopened = await api.request(`/admin/ops/upstream-errors/${failed.id}/reopen`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': 'reopen-observation-0001',
        'if-match': `"${resolvedBody.data.control_version}"`,
      },
      body: '{}',
    }, test.env)
    expect(reopened.status).toBe(200)
    const reopenedBody = await reopened.json() as any
    expect(reopenedBody.data).toMatchObject({
      id: failed.id,
      resolved: false,
      resolved_at: null,
      resolved_by_user_id: null,
      control_version: 2,
    })

    const detail = await api.request(`/admin/ops/request-errors/${failed.id}`, {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    await expect(detail.json()).resolves.toMatchObject({
      data: {
        resolved: false,
        resolution_audit: [
          { resolved: false, actor_user_id: 'admin' },
          { resolved: true, actor_user_id: 'admin' },
        ],
      },
    })
    expect(() => test.raw.prepare(
      `UPDATE request_observation_resolution_audit SET actor_user_id = 'bob'`,
    ).run()).toThrow(/request_observation_resolution_audit_immutable/)
    expect(() => test.raw.prepare(
      `DELETE FROM request_observation_resolution_audit`,
    ).run()).toThrow(/request_observation_resolution_audit_immutable/)

    const notAdmin = await api.request(`/admin/ops/request-errors/${failed.id}/resolve`, {
      method: 'POST',
      headers: {
        authorization: test.auth.alice!,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-observation-user-0001',
        'if-match': `"${reopenedBody.data.control_version}"`,
      },
      body: '{}',
    }, test.env)
    expect(notAdmin.status).toBe(403)

    const productionResolve = await createApp().request(
      `/api/v1/admin/ops/request-errors/${failed.id}/resolve`,
      {
        method: 'POST',
        headers: {
          authorization: test.auth.admin!,
          'content-type': 'application/json',
          'idempotency-key': 'resolve-observation-production-0001',
          'if-match': `"${reopenedBody.data.control_version}"`,
        },
        body: '{}',
      },
      test.env,
    )
    expect(productionResolve.status).toBe(200)

    const completed = await seed(test, {
      requestId: 'req-completed-resolution', userId: 'alice', at: Date.now(), status: 200,
    })
    const completedDetail = await api.request(`/admin/ops/requests/${completed.id}`, {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    const completedBody = await completedDetail.json() as any
    const cannotResolveSuccess = await api.request(
      `/admin/ops/request-errors/${completed.id}/resolve`,
      {
        method: 'POST',
        headers: {
          authorization: test.auth.admin!,
          'content-type': 'application/json',
          'idempotency-key': 'resolve-completed-observation-0001',
          'if-match': `"${completedBody.data.control_version}"`,
        },
        body: '{}',
      },
      test.env,
    )
    expect(cannotResolveSuccess.status).toBe(409)
    await expect(cannotResolveSuccess.json()).resolves.toMatchObject({ code: 'observation_not_failed' })

    const requestOnly = await seed(test, {
      requestId: 'req-family-boundary', userId: 'alice', at: Date.now() - 2_000, status: 400,
    })
    const requestOnlyDetail = await api.request(`/admin/ops/request-errors/${requestOnly.id}`, {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    const requestOnlyVersion = ((await requestOnlyDetail.json()) as any).data.control_version
    const requestOnlyKey = 'resolve-request-family-0001'
    const requestOnlyResolve = await api.request(`/admin/ops/request-errors/${requestOnly.id}/resolve`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': requestOnlyKey,
        'if-match': `"${requestOnlyVersion}"`,
      },
      body: '{}',
    }, test.env)
    expect(requestOnlyResolve.status).toBe(200)
    const wrongFamilyReplay = await api.request(`/admin/ops/upstream-errors/${requestOnly.id}/resolve`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': requestOnlyKey,
        'if-match': `"${requestOnlyVersion}"`,
      },
      body: '{}',
    }, test.env)
    expect(wrongFamilyReplay.status).not.toBe(200)
    test.raw.close()
  })

  it('lets exactly one concurrent resolution win an observation version', async () => {
    const test = await fixture()
    const failed = await seed(test, {
      requestId: 'req-resolution-race', userId: 'alice', at: Date.now() - 1_000, status: 502,
    })
    const api = app()
    const detail = await api.request(`/admin/ops/request-errors/${failed.id}`, {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    const version = ((await detail.json()) as any).data.control_version
    const resolve = (key: string) => api.request(`/admin/ops/request-errors/${failed.id}/resolve`, {
      method: 'POST',
      headers: {
        authorization: test.auth.admin!,
        'content-type': 'application/json',
        'idempotency-key': key,
        'if-match': `"${version}"`,
      },
      body: '{}',
    }, test.env)

    const responses = await Promise.all([
      resolve('resolve-observation-race-0001'),
      resolve('resolve-observation-race-0002'),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const finalDetail = await api.request(`/admin/ops/request-errors/${failed.id}`, {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    const finalBody = await finalDetail.json() as any
    expect(finalBody.data.resolution_audit).toHaveLength(1)
    test.raw.close()
  })

  it('keeps owner lists/details isolated and exposes the stable payload projection', async () => {
    const test = await fixture()
    const now = Date.now()
    const alice = await seed(test, { requestId: 'req-alice', userId: 'alice', at: now, status: 400 })
    await seed(test, { requestId: 'req-alice-older', userId: 'alice', at: now - 2, status: 400 })
    const bob = await seed(test, { requestId: 'req-bob', userId: 'bob', at: now - 1, status: 502 })
    const api = app()
    const list = await api.request('/usage/errors?limit=1', {
      headers: { authorization: test.auth.alice! },
    }, test.env)
    expect(list.status).toBe(200)
    const listBody = await list.json() as any
    expect(listBody).toMatchObject({
      data: { items: [{ id: alice.id }], has_more: true, next_cursor: expect.any(String) },
    })
    expect(listBody.data.items[0]).not.toHaveProperty('user_id')
    expect((await api.request(`/usage/errors/${bob.id}`, {
      headers: { authorization: test.auth.alice! },
    }, test.env)).status).toBe(404)
    expect((await api.request(
      `/usage/errors?limit=1&cursor=${encodeURIComponent(listBody.data.next_cursor)}`,
      { headers: { authorization: test.auth.bob! } },
      test.env,
    )).status).toBe(400)
    const detail = await api.request(`/usage/errors/${alice.id}`, {
      headers: { authorization: test.auth.alice! },
    }, test.env)
    expect(detail.status).toBe(200)
    const payload = ((await detail.json()) as any).data.payload
    expect(payload).toMatchObject({ state: 'available', content_type: 'application/json', redacted: true })
    expect(payload.body).toContain('[REDACTED]')
    expect(payload.body).not.toContain('sk-hidden-value')
    const production = await createApp().request('/api/v1/usage/errors?limit=1', {
      headers: { authorization: test.auth.alice! },
    }, test.env)
    expect(production.status).toBe(200)
    expect(((await production.json()) as any).data.items[0].id).toBe(alice.id)
    test.raw.close()
  })

  it('preserves the original owner error table offset, filters, sorting, and detail contract', async () => {
    const test = await fixture()
    const at = Date.parse('2026-09-06T16:00:00.000Z')
    test.raw.prepare(
      `INSERT INTO api_keys (id,user_id,key_hash,key_prefix,name,created_at_ms,updated_at_ms)
       VALUES ('key-alice','alice',?,'sk-alice-…cdef','Alice key',?,?)`,
    ).run('d'.repeat(64), at, at)
    test.raw.prepare(
      `INSERT INTO "groups" (id,name,platform,created_at_ms,updated_at_ms)
       VALUES ('group-a','Premium','openai',?,?)`,
    ).run(at, at)

    const beta = await seed(test, {
      requestId: 'req-owner-beta', userId: 'alice', at: at + 2, status: 402,
    })
    const alpha = await seed(test, {
      requestId: 'req-owner-alpha', userId: 'alice', at: at + 1, status: 402,
    })
    const other = await seed(test, {
      requestId: 'req-owner-other', userId: 'alice', at, status: 400,
    })
    const countTokens = await seed(test, {
      requestId: 'req-owner-count-tokens', userId: 'alice', at: at + 3, status: 400,
    })
    test.raw.prepare(
      `UPDATE request_observations
          SET requested_model=?, group_id='group-a', error_type='subscription_error',
              is_business_limited=1, client_ip='203.0.113.42', user_agent='owner-agent'
        WHERE id=?`,
    ).run('gpt-beta', beta.id)
    test.raw.prepare(
      `UPDATE request_observations
          SET requested_model=?, group_id='group-a', error_type='subscription_error'
        WHERE id=?`,
    ).run('gpt-alpha', alpha.id)
    test.raw.prepare(
      `UPDATE request_observations SET requested_model=? WHERE id=?`,
    ).run('other-model', other.id)
    test.raw.prepare(
      `UPDATE request_observations SET request_path='/v1/messages/count_tokens' WHERE id=?`,
    ).run(countTokens.id)

    const first = await app().request(
      '/usage/errors?page=1&page_size=1&model=gpt-&category=quota&api_key_id=key-alice&status_code=402&sort_by=model&sort_order=asc&timezone=Asia%2FShanghai&start_date=2026-09-07&end_date=2026-09-07',
      { headers: { authorization: test.auth.alice! } }, test.env,
    )
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      data: {
        total: 2, page: 1, page_size: 1, pages: 2,
        items: [{
          id: alpha.id, model: 'gpt-alpha', status_code: 402, category: 'quota',
          key_name: 'Alice key', key_deleted: false, group_name: 'Premium',
        }],
      },
    })

    const second = await app().request(
      '/usage/errors?page=2&page_size=1&model=gpt-&category=quota&api_key_id=key-alice&status_code=402&sort_by=model&sort_order=asc&timezone=Asia%2FShanghai&start_date=2026-09-07&end_date=2026-09-07',
      { headers: { authorization: test.auth.alice! } }, test.env,
    )
    await expect(second.json()).resolves.toMatchObject({
      data: { total: 2, page: 2, page_size: 1, pages: 2, items: [{ id: beta.id }] },
    })

    // The original handler normalizes unsupported sort values back to created_at DESC,
    // includes business-limited failures, and omits count-token probes.
    const fallbackSort = await app().request(
      '/usage/errors?page=1&page_size=10&sort_by=secret&sort_order=nonsense',
      { headers: { authorization: test.auth.alice! } }, test.env,
    )
    expect(fallbackSort.status).toBe(200)
    await expect(fallbackSort.json()).resolves.toMatchObject({
      data: {
        total: 3,
        items: [{ id: beta.id }, { id: alpha.id }, { id: other.id }],
      },
    })

    const detail = await app().request(`/usage/errors/${beta.id}`, {
      headers: { authorization: test.auth.alice! },
    }, test.env)
    expect(detail.status).toBe(200)
    const detailBody = await detail.json() as any
    expect(detailBody.data).toMatchObject({
      id: beta.id,
      upstream_status_code: 402,
      key_name: 'Alice key',
      key_deleted: false,
      group_name: 'Premium',
      client_ip: '203.0.113.42',
      user_agent: 'owner-agent',
    })
    expect(detailBody.data.error_body).toContain('[REDACTED]')
    expect(detailBody.data.error_body).not.toContain('sk-hidden-value')

    test.raw.prepare(`UPDATE api_keys SET revoked_at_ms=? WHERE id='key-alice'`).run(at + 10)
    const afterRevoke = await app().request('/usage/errors?page=1&page_size=1', {
      headers: { authorization: test.auth.alice! },
    }, test.env)
    await expect(afterRevoke.json()).resolves.toMatchObject({
      data: { items: [{ id: beta.id, key_name: 'Alice key', key_deleted: true }] },
    })
    test.raw.close()
  })

  it('uses a stable keyset cursor and requires admin RBAC for cross-owner views', async () => {
    const test = await fixture()
    const now = Date.now()
    const clientError = await seed(test, { requestId: 'req-1', userId: 'alice', at: now, status: 400 })
    const upstreamError = await seed(test, {
      requestId: 'req-1', userId: 'alice', at: now - 1, status: 502, owner: 'provider',
    })
    await seed(test, { requestId: 'req-2', userId: 'bob', at: now, status: 502, owner: 'provider' })
    await seed(test, { requestId: 'req-3', userId: 'alice', at: now - 2, status: 200 })
    const api = app()
    expect((await api.request('/admin/ops/requests', {
      headers: { authorization: test.auth.alice! },
    }, test.env)).status).toBe(403)
    const first = await api.request('/admin/ops/requests?limit=1', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    const firstBody = (await first.json()) as any
    expect(firstBody.data).toMatchObject({ has_more: true })
    expect(firstBody.data.next_cursor).toEqual(expect.any(String))
    const second = await api.request(
      `/admin/ops/requests?limit=1&cursor=${encodeURIComponent(firstBody.data.next_cursor)}`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(((await second.json()) as any).data.items[0].id).not.toBe(firstBody.data.items[0].id)
    const changedFilter = await api.request(
      `/admin/ops/requests?limit=1&group_id=changed&cursor=${encodeURIComponent(firstBody.data.next_cursor)}`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(changedFilter.status).toBe(400)
    await expect(changedFilter.json()).resolves.toMatchObject({ code: 'invalid_cursor' })
    const cursorDurationSort = await api.request(
      `/admin/ops/requests?limit=1&sort=duration_desc&cursor=${encodeURIComponent(firstBody.data.next_cursor)}`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(cursorDurationSort.status).toBe(400)
    await expect(cursorDurationSort.json()).resolves.toMatchObject({ code: 'unsupported_pagination_or_search' })
    const related = await api.request(
      `/admin/ops/request-errors/${clientError.id}/upstream-errors`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(((await related.json()) as any).data.items).toMatchObject([{ id: upstreamError.id }])
    const oldClientError = await seed(test, {
      requestId: 'req-old', userId: 'alice', at: now - 2 * 60 * 60_000, status: 400,
    })
    const oldUpstreamError = await seed(test, {
      requestId: 'req-old', userId: 'alice', at: now - 2 * 60 * 60_000 - 1,
      status: 502, owner: 'provider',
    })
    const oldRelated = await api.request(
      `/admin/ops/request-errors/${oldClientError.id}/upstream-errors`,
      { headers: { authorization: test.auth.admin! } }, test.env,
    )
    expect(((await oldRelated.json()) as any).data.items).toMatchObject([{ id: oldUpstreamError.id }])
    const aggregate = await api.request('/admin/ops/error-aggregation', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    await expect(aggregate.json()).resolves.toMatchObject({ data: { total: 3 } })
    const productionAdmin = await createApp().request('/api/v1/admin/ops/request-errors?limit=2', {
      headers: { authorization: test.auth.admin! },
    }, test.env)
    expect(productionAdmin.status).toBe(200)
    expect(((await productionAdmin.json()) as any).data.items).toHaveLength(2)
    test.raw.close()
  })
  it('enforces the user error visibility switch for lists and details without disabling administrator access',async()=>{
    const test=await fixture()
    test.raw.exec("UPDATE system_settings SET public_json=json_set(public_json,'$.allow_user_view_error_requests',json('false')) WHERE id='global'")
    for(const path of ['/usage/errors','/usage/errors/missing']){
      const response=await app().request(path,{headers:{authorization:test.auth.alice!}},test.env)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({code:'user_error_requests_disabled'})
    }
    expect((await app().request('/admin/ops/request-errors',{headers:{authorization:test.auth.admin!}},test.env)).status).toBe(200)
    test.raw.close()
  })

})
