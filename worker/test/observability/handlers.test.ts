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
})
