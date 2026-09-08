import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
import type { Env } from '../../src/env'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../frontend/src/api/client', () => ({ apiClient: { get } }))
vi.mock('../../../frontend/src/utils/format', () => ({ getBrowserTimeZone: () => 'Asia/Shanghai' }))
// Load browser adapters at runtime so Worker typechecking stays WebWorker-only.
const usageModulePath = '../../../frontend/src/api/usage'
const dashboardModulePath = '../../../frontend/src/api/admin/dashboard'
const { getDashboardStats, getDashboardTrend, getDashboardModels, getByDateRange } = await vi.importActual<Record<string, (...args: any[]) => Promise<any>>>(usageModulePath)
const { getSnapshotV2, getUserUsageTrend, getUserSpendingRanking } = await vi.importActual<Record<string, (...args: any[]) => Promise<any>>>(dashboardModulePath)

const PEPPER = 'dashboard-browser-contract-pepper-at-least-32-bytes'
let database: ReturnType<typeof createSqliteD1>['raw']
afterEach(() => { database?.close(); vi.clearAllMocks(); vi.useRealTimers() })

async function connectBrowserApiToWorker() {
  const { raw, d1 } = createSqliteD1()
  database = raw
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(`INSERT INTO users (id,email,display_name,role,created_at_ms,updated_at_ms)
    VALUES ('admin','admin@example.test','Admin','admin',?,?)`).run(now, now)
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  raw.prepare(`INSERT INTO user_sessions (id,family_id,user_id,auth_version,access_token_hash,
    refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms)
    VALUES ('session','family','admin',1,?,?,?,?,?)`).run(
    await tokenDigest(access, PEPPER, 'access'), await tokenDigest(refresh, PEPPER, 'refresh'),
    now, now + 60_000, now + 600_000,
  )
  raw.prepare(`INSERT INTO usage_projection (event_id,request_id,user_id,model,input_tokens,
    output_tokens,amount_micros,occurred_at_ms,projected_at_ms)
    VALUES ('event','request','admin','composer-2.5',100,50,75000,?,?)`).run(now, now)
  const env = { APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    DB: d1, CONFIG_KV: {}, OBJECTS: {}, EVENTS_QUEUE: {}, USER_STATE: {}, POOL_STATE: {},
    ASSETS: { fetch: async () => new Response('asset') },
  } as unknown as Env
  const app = createApp()
  get.mockImplementation(async (path: string, config?: { params?: Record<string, unknown> }) => {
    const url = new URL(`/api/v1${path}`, 'http://localhost')
    for (const [key, value] of Object.entries(config?.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    url.searchParams.set('timezone', 'Asia/Shanghai')
    const response = await app.request(url, { headers: { authorization: `Bearer ${access}` } }, env)
    const body = await response.json() as { code: number; data: unknown }
    expect(response.status, `Dashboard API ${path}: ${JSON.stringify(body)}`).toBe(200)
    expect(body.code).toBe(0)
    return { data: body.data }
  })
}

describe('admin dashboard browser API against Worker routes', () => {
  it('loads the initial snapshot, user chart, and ranking without an API error', async () => {
    await connectBrowserApiToWorker()
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const params = { start_date: today, end_date: today, granularity: 'hour' as const }
    const results = await Promise.allSettled([
      getSnapshotV2({ ...params, include_stats: true, include_trend: true,
        include_model_stats: true, include_group_stats: false, include_users_trend: false }),
      getUserUsageTrend({ ...params, limit: 12 }),
      getUserSpendingRanking({ start_date: today, end_date: today, limit: 10 }),
    ])
    const failures = results.filter(result => result.status === 'rejected')
    expect(failures.map(result => String(result.reason))).toEqual([])
    const [snapshot, users, ranking] = results.map(result =>
      result.status === 'fulfilled' ? result.value : undefined,
    ) as [Awaited<ReturnType<typeof getSnapshotV2>>, Awaited<ReturnType<typeof getUserUsageTrend>>, Awaited<ReturnType<typeof getUserSpendingRanking>>]
    expect(snapshot.stats).toMatchObject({ total_requests: 1, total_tokens: 150,
      total_actual_cost: 0.075, today_requests: 1, total_users: 1 })
    expect(snapshot.trend).toEqual([expect.objectContaining({ requests: 1, total_tokens: 150 })])
    expect(snapshot.models).toEqual([expect.objectContaining({ model: 'composer-2.5', requests: 1 })])
    expect(users.trend).toEqual([expect.objectContaining({ user_id: 'admin', requests: 1, tokens: 150 })])
    expect(ranking).toMatchObject({ total_requests: 1, total_tokens: 150, total_actual_cost: 0.075,
      ranking: [{ user_id: 'admin', username: 'Admin', requests: 1, tokens: 150, actual_cost: 0.075 }] })
  })
})


describe('user dashboard browser API against Worker routes', () => {
  it.each(['2026-09-07T16:05:00Z', '2026-09-08T15:55:00Z'])('loads owner statistics, charts, and recent usage across Shanghai date boundaries at %s', async now => {
    vi.setSystemTime(new Date(now))
    await connectBrowserApiToWorker()
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const results = await Promise.allSettled([
      getDashboardStats(),
      getDashboardTrend({ start_date: today, end_date: today, granularity: 'hour' }),
      getDashboardModels({ start_date: today, end_date: today }),
      getByDateRange(today, today),
    ])
    expect(results.filter(result => result.status === 'rejected').map(result => String(result.reason))).toEqual([])
    const [stats, trend, models, recent] = results.map(result =>
      result.status === 'fulfilled' ? result.value : undefined,
    ) as [Awaited<ReturnType<typeof getDashboardStats>>, Awaited<ReturnType<typeof getDashboardTrend>>,
      Awaited<ReturnType<typeof getDashboardModels>>, Awaited<ReturnType<typeof getByDateRange>>]
    expect(stats).toMatchObject({ total_requests: 1, total_tokens: 150, total_actual_cost: 0.075 })
    expect(trend.trend).toEqual([expect.objectContaining({ requests: 1, total_tokens: 150 })])
    expect(trend.trend[0].date).toMatch(new RegExp(`^${today}`))
    expect(models.models).toEqual([expect.objectContaining({ model: 'composer-2.5', requests: 1 })])
    expect(recent.items).toEqual([expect.objectContaining({ id: 'event', actual_cost: 0.075 })])
  })
})
