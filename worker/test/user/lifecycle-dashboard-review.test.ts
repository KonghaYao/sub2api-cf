import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const pepper = 'usage-contract-test-pepper-at-least-thirty-two-bytes'
const TEST_NOW = Date.UTC(2026, 8, 4, 12)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(TEST_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

async function fixture() {
  const {raw,d1}=createSqliteD1(); applyMigrations(raw); const now=TEST_NOW
  for(const id of ['alice','bob']) raw.prepare(`INSERT INTO users(id,email,display_name,created_at_ms,updated_at_ms)VALUES(?,?,?, ?,?)`).run(id,`${id}@test.local`,id,now,now)
  raw.prepare(`INSERT INTO api_keys(id,user_id,key_hash,created_at_ms,updated_at_ms)VALUES('alice-key','alice',?, ?,?)`).run('a'.repeat(64),now,now)
  raw.prepare(`INSERT INTO api_keys(id,user_id,key_hash,created_at_ms,updated_at_ms)VALUES('bob-key','bob',?, ?,?)`).run('b'.repeat(64),now,now)
  raw.prepare(`INSERT INTO "groups"(id,name,platform,created_at_ms,updated_at_ms)VALUES('group-a','Usage group','openai',?,?)`).run(now,now)
  const access=createOpaqueToken('access'),refresh=createOpaqueToken('refresh'); raw.prepare(`INSERT INTO user_sessions(id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms)VALUES('s','f','alice',1,?,?,?, ?,?)`).run(await tokenDigest(access,pepper,'access'),await tokenDigest(refresh,pepper,'refresh'),now,now+86400000,now+2*86400000)
  for(const [event,user,key,amount,at] of [['alice-event','alice','alice-key',1_500_000,now],['bob-event','bob',null,9_000_000,now]] as const)raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,api_key_id,group_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms)VALUES(?,?,?,?,?,'gpt-test',10,5,?,?,?)`).run(event,event,user,key,user==='alice'?'group-a':null,amount,at,at)
  const env={APP_VERSION:'test',ENVIRONMENT:'test',API_KEY_PEPPER:pepper,ASSETS:{fetch:async()=>new Response('asset')} as unknown as Fetcher,DB:d1,CONFIG_KV:{} as KVNamespace,OBJECTS:{} as R2Bucket,EVENTS_QUEUE:{} as Queue,USER_STATE:{} as DurableObjectNamespace,POOL_STATE:{} as DurableObjectNamespace} as Env
  return {env,headers:{authorization:`Bearer ${access}`}}
}
it('review: China today includes requests after China midnight before UTC midnight', async () => {
  const t = await fixture()
  await t.env.DB.prepare("UPDATE usage_projection SET occurred_at_ms = ? WHERE event_id = 'alice-event'")
    .bind(Date.parse('2026-09-03T18:00:00Z')).run()
  const response = await createApp().request('/api/v1/usage/dashboard/stats?timezone=Asia%2FShanghai', { headers: t.headers }, t.env)
  expect(response.status).toBe(200)
  expect((await response.json() as any).data.today_actual_cost).toBe(1.5)
})

it.each([
  ['/api/v1/usage/stats?period=today', (data: any) => data.total_actual_cost],
  ['/api/v1/usage?start_date=2026-09-04&end_date=2026-09-04', (data: any) => data.items[0]?.actual_cost],
  ['/api/v1/usage/dashboard/trend?start_date=2026-09-04&end_date=2026-09-04', (data: any) => data.trend[0]?.actual_cost],
  ['/api/v1/usage/dashboard/snapshot-v2?start_date=2026-09-04&end_date=2026-09-04', (data: any) => data.groups[0]?.actual_cost],
  ['/api/v1/user/api-keys/alice-key/usage/daily?days=1', (data: any) => data.items[0]?.actual_cost],
])('uses the same China calendar day in %s', async (path, amount) => {
  const t = await fixture()
  await t.env.DB.prepare("UPDATE usage_projection SET occurred_at_ms=? WHERE event_id='alice-event'").bind(Date.parse('2026-09-03T18:00:00Z')).run()
  const response = await createApp().request(`${path}&timezone=Asia%2FShanghai`, { headers: t.headers }, t.env)
  expect(response.status).toBe(200)
  const data = (await response.json() as any).data
  expect(amount(data)).toBe(1.5)
  if (data.trend) expect(data.trend[0].date).toBe('2026-09-04')
  if (data.start_date) expect(data.start_date).toBe('2026-09-04')
  if (data.end_date) expect(data.end_date).toBe('2026-09-04')
})

it('uses China midnight for batch Key today cost', async () => {
  const t = await fixture()
  await t.env.DB.prepare("UPDATE usage_projection SET occurred_at_ms=? WHERE event_id='alice-event'").bind(Date.parse('2026-09-03T18:00:00Z')).run()
  const response = await createApp().request('/api/v1/usage/dashboard/api-keys-usage?timezone=Asia%2FShanghai', { method: 'POST', headers: { ...t.headers, 'content-type': 'application/json' }, body: JSON.stringify({ api_key_ids: ['alice-key', 'bob-key'] }) }, t.env)
  expect((await response.json() as any).data.stats).toEqual({ 'alice-key': { api_key_id: 'alice-key', today_actual_cost: 1.5, total_actual_cost: 1.5 } })
})

it('uses calendar boundaries across the 23-hour New York DST day', async () => {
  vi.setSystemTime(Date.parse('2026-03-08T18:00:00Z'))
  const t = await fixture()
  // Session fixture is intentionally later; expiry remains valid for this historical query.
  await t.env.DB.prepare("UPDATE usage_projection SET occurred_at_ms=? WHERE event_id='alice-event'").bind(Date.parse('2026-03-09T03:59:00Z')).run()
  const response = await createApp().request('/api/v1/usage/dashboard/trend?start_date=2026-03-08&end_date=2026-03-08&timezone=America%2FNew_York', { headers: t.headers }, t.env)
  expect((await response.json() as any).data).toMatchObject({ start_date: '2026-03-08', end_date: '2026-03-08', trend: [{ date: '2026-03-08', actual_cost: 1.5 }] })
  await t.env.DB.prepare("UPDATE usage_projection SET occurred_at_ms=? WHERE event_id='alice-event'").bind(Date.parse('2026-03-09T04:00:00Z')).run()
  const excluded = await createApp().request('/api/v1/usage/dashboard/trend?start_date=2026-03-08&end_date=2026-03-08&timezone=America%2FNew_York', { headers: t.headers }, t.env)
  expect((await excluded.json() as any).data.trend).toEqual([])
})

it.each(['timezone=Not%2FAZone', 'start_date=2026-02-30&end_date=2026-03-02'])('rejects invalid calendar input %s', async query => {
  const t = await fixture()
  expect((await createApp().request(`/api/v1/usage/dashboard/trend?${query}`, { headers: t.headers }, t.env)).status).toBe(400)
})

it('keeps the actual local-hour bucket instant in a quarter-hour timezone', async () => {
  const t = await fixture()
  await t.env.DB.prepare("UPDATE usage_projection SET occurred_at_ms=? WHERE event_id='alice-event'").bind(Date.parse('2026-09-04T00:10:00Z')).run()
  const response = await createApp().request('/api/v1/usage/dashboard/trend?start_date=2026-09-04&end_date=2026-09-04&granularity=hour&timezone=Asia%2FKathmandu', { headers: t.headers }, t.env)
  expect((await response.json() as any).data.trend).toMatchObject([{ date: '2026-09-03T23:15:00Z', actual_cost: 1.5 }])
})
