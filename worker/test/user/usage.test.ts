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
describe('user usage HTTP contract',()=>{
 it('isolates logs/details and converts micros for dashboard aggregates',async()=>{const t=await fixture(),app=createApp(); const list=await app.request('/api/v1/usage?page=1&page_size=20&model=gpt-test',{headers:t.headers},t.env); expect((await list.json() as any).data).toMatchObject({total:1,items:[{id:'alice-event',actual_cost:1.5,input_tokens:10}]}); expect((await app.request('/api/v1/usage/bob-event',{headers:t.headers},t.env)).status).toBe(404); const stats=await app.request('/api/v1/usage/dashboard/stats',{headers:t.headers},t.env); await expect(stats.json()).resolves.toMatchObject({data:{total_requests:1,total_actual_cost:1.5,total_tokens:15,total_api_keys:1}}); expect((await app.request('/api/v1/usage/stats?period=quarter',{headers:t.headers},t.env)).status).toBe(400) })
 it('returns UTC snapshot flags, owner-scoped key data, and honest empty errors',async()=>{const t=await fixture(),app=createApp(); await expect((await app.request('/api/v1/usage/dashboard/trend?start_date=2026-09-04&end_date=2026-09-04',{headers:t.headers},t.env)).json()).resolves.toMatchObject({data:{granularity:'day',trend:[{date:'2026-09-04',actual_cost:1.5}]}}); await expect((await app.request('/api/v1/usage/dashboard/models',{headers:t.headers},t.env)).json()).resolves.toMatchObject({data:{models:[{model:'gpt-test',actual_cost:1.5}]}}); const snapshot=await app.request('/api/v1/usage/dashboard/snapshot-v2?include_trend=false&include_model_stats=true&include_group_stats=true',{headers:t.headers},t.env); const snapshotJson=await snapshot.json() as any; expect(snapshotJson.data).toMatchObject({models:[{model:'gpt-test'}],groups:[{group_id:'group-a'}]}); expect(snapshotJson.data).not.toHaveProperty('trend'); const daily=await app.request('/api/v1/user/api-keys/alice-key/usage/daily?days=1',{headers:t.headers},t.env); await expect(daily.json()).resolves.toMatchObject({data:{days:1,items:[{actual_cost:1.5}]}}); expect((await app.request('/api/v1/user/api-keys/bob-key/usage/daily',{headers:t.headers},t.env)).status).toBe(404); const batch=await app.request('/api/v1/usage/dashboard/api-keys-usage',{method:'POST',headers:{...t.headers,'content-type':'application/json'},body:JSON.stringify({api_key_ids:['alice-key']})},t.env); await expect(batch.json()).resolves.toMatchObject({data:{stats:{'alice-key':{total_actual_cost:1.5}}}}); await expect((await app.request('/api/v1/usage/errors',{headers:t.headers},t.env)).json()).resolves.toMatchObject({data:{items:[],total:0}}) })
})
