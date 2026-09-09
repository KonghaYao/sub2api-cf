import { recordRequestStart } from '../../src/observability/recorder'
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
  const {raw,d1}=createSqliteD1(); applyMigrations(raw); const now=Date.now()
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
 it.each([0,1234,null])('returns measured first-token latency %s without cross-user request correlation',async latency=>{
  const t=await fixture(),app=createApp()
  const own=await recordRequestStart(t.env,{requestId:'alice-event',userId:'alice',apiKeyId:'alice-key',method:'POST',requestPath:'/v1/chat/completions',occurredAtMs:TEST_NOW})
  const other=await recordRequestStart(t.env,{requestId:'alice-event',userId:'bob',apiKeyId:'bob-key',method:'POST',requestPath:'/v1/chat/completions',occurredAtMs:TEST_NOW+1})
  await t.env.DB.prepare('UPDATE request_observations SET ttft_ms=? WHERE id=?').bind(latency,own!.id).run()
  await t.env.DB.prepare('UPDATE request_observations SET ttft_ms=9999 WHERE id=?').bind(other!.id).run()
  for(const path of ['/api/v1/usage','/api/v1/usage?limit=10','/api/v1/usage/alice-event']){
   const response=await app.request(path,{headers:t.headers},t.env)
   expect(response.status).toBe(200)
   const data=(await response.json() as any).data
   expect(data.items?.[0]??data).toMatchObject({first_token_ms:latency})
  }
 })

 it('returns reported cache TTL details in user list and detail APIs',async()=>{
  const t=await fixture(),app=createApp()
  await t.env.DB.prepare("UPDATE usage_projection SET cache_write_tokens=5,cache_write_5m_tokens=2,cache_write_1h_tokens=3 WHERE event_id='alice-event'").run()
  for(const path of ['/api/v1/usage','/api/v1/usage/alice-event']){
   const response=await app.request(path,{headers:t.headers},t.env)
   expect(response.status).toBe(200)
   const data=(await response.json() as any).data
   expect(data.items?.[0]??data).toMatchObject({cache_creation_tokens:5,cache_creation_5m_tokens:2,cache_creation_1h_tokens:3})
  }
 })

 it.each([
  ['Asia/Shanghai', '2026-09-07T16:05:00Z', '2026-09-08', '2026-09-07T16:00:00Z', '2026-09-08T16:00:00Z'],
  ['America/New_York', '2026-03-08T16:00:00Z', '2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
  ['America/New_York', '2026-11-01T17:00:00Z', '2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
 ])('aligns key history with local calendar boundaries in %s at %s',async(timezone,now,date,start,end)=>{
  vi.setSystemTime(new Date(now))
  const t=await fixture(), app=createApp()
  await t.env.DB.prepare("DELETE FROM usage_projection WHERE user_id='alice'").run()
  for(const [id,at] of [['before',Date.parse(start)-1],['start',Date.parse(start)],['last',Date.parse(end)-1],['next',Date.parse(end)]] as const){
   await t.env.DB.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,api_key_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms) VALUES(?,?,'alice','alice-key','gpt-test',1,1,1000000,?,?)`).bind(id,id,at,at).run()
  }
  const response=await app.request(`/api/v1/user/api-keys/alice-key/usage/daily?days=1&timezone=${encodeURIComponent(timezone)}`,{headers:t.headers},t.env)
  expect(response.status,await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({data:{start_date:date,end_date:date,items:[{date,requests:2,actual_cost:2}]}})
  const trend=await app.request(`/api/v1/usage/dashboard/trend?start_date=${date}&end_date=${date}&timezone=${encodeURIComponent(timezone)}`,{headers:t.headers},t.env)
  expect(await trend.json()).toMatchObject({data:{trend:[{date,requests:2,actual_cost:2}]}})
 })
 it('preserves cache creation across user logs, summaries, models and daily usage',async()=>{
  const t=await fixture(),app=createApp()
  await t.env.DB.prepare("UPDATE usage_projection SET input_tokens=100,output_tokens=2,cache_read_tokens=80,cache_write_tokens=10 WHERE user_id='alice'").run()
  for(const path of ['/api/v1/usage/stats','/api/v1/usage/dashboard/stats']) {
   const res=await app.request(path,{headers:t.headers},t.env)
   expect(res.status).toBe(200)
   expect((await res.json() as any).data).toMatchObject({total_input_tokens:10,total_cache_creation_tokens:10,total_cache_read_tokens:80,total_tokens:102})
  }
  const read=async(path:string)=>(await (await app.request(path,{headers:t.headers},t.env)).json() as any).data
  expect((await read('/api/v1/usage')).items[0]).toMatchObject({input_tokens:10,cache_creation_tokens:10,cache_read_tokens:80})
  expect((await read('/api/v1/usage/dashboard/models')).models[0]).toMatchObject({input_tokens:10,cache_creation_tokens:10,total_tokens:102})
  expect((await read('/api/v1/usage/dashboard/trend')).trend[0]).toMatchObject({input_tokens:10,cache_creation_tokens:10,total_tokens:102})
  expect((await read('/api/v1/user/api-keys/alice-key/usage/daily?days=1')).items[0]).toMatchObject({input_tokens:10,cache_write_tokens:10,total_tokens:102})
 })
 it('shows the recorded billing basis while preserving the actual debit',async()=>{
  const t=await fixture(),app=createApp()
  const snapshot={version:1,source:'channel',customer_rate_multiplier_ppm:1500000,basis_cost:{input_amount_micros:400000,output_amount_micros:300000,cache_amount_micros:100000,cache_write_amount_micros:200000,base_amount_micros:0,amount_micros:1000000}}
  await t.env.DB.prepare("INSERT INTO usage_projection(event_id,request_id,user_id,api_key_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms,customer_pricing_snapshot_json) SELECT 'basis-event','basis-request',user_id,api_key_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms,? FROM usage_projection WHERE event_id=?").bind(JSON.stringify(snapshot),'alice-event').run()
  const response=await app.request('/api/v1/usage/basis-event',{headers:t.headers},t.env)
  expect(response.status).toBe(200)
  expect((await response.json() as any).data).toMatchObject({input_cost:0.4,output_cost:0.3,cache_read_cost:0.1,cache_creation_cost:0.2,total_cost:1,actual_cost:1.5,rate_multiplier:1.5})
  for(const path of ['/api/v1/usage/stats','/api/v1/usage/dashboard/stats']) {
    const result=await app.request(path,{headers:t.headers},t.env)
    expect(result.status).toBe(200)
    expect((await result.json() as any).data).toMatchObject({total_cost:2.5,total_actual_cost:3})
  }
  const models=await app.request('/api/v1/usage/dashboard/models',{headers:t.headers},t.env)
  expect(models.status).toBe(200)
  expect((await models.json() as any).data.models[0]).toMatchObject({cost:2.5,actual_cost:3})

 })
 it('isolates logs/details and converts micros for dashboard aggregates',async()=>{const t=await fixture(),app=createApp(); const list=await app.request('/api/v1/usage?page=1&page_size=20&model=gpt-test',{headers:t.headers},t.env); expect((await list.json() as any).data).toMatchObject({total:1,items:[{id:'alice-event',actual_cost:1.5,input_tokens:10}]}); expect((await app.request('/api/v1/usage/bob-event',{headers:t.headers},t.env)).status).toBe(404); const stats=await app.request('/api/v1/usage/dashboard/stats',{headers:t.headers},t.env); await expect(stats.json()).resolves.toMatchObject({data:{total_requests:1,total_actual_cost:1.5,total_tokens:15,total_api_keys:1}}); expect((await app.request('/api/v1/usage/stats?period=quarter',{headers:t.headers},t.env)).status).toBe(400) })
 it('returns UTC snapshot flags, owner-scoped key data, and disabled error visibility by default',async()=>{const t=await fixture(),app=createApp(); await expect((await app.request('/api/v1/usage/dashboard/trend?start_date=2026-09-04&end_date=2026-09-04',{headers:t.headers},t.env)).json()).resolves.toMatchObject({data:{granularity:'day',trend:[{date:'2026-09-04',actual_cost:1.5}]}}); await expect((await app.request('/api/v1/usage/dashboard/models',{headers:t.headers},t.env)).json()).resolves.toMatchObject({data:{models:[{model:'gpt-test',actual_cost:1.5}]}}); const snapshot=await app.request('/api/v1/usage/dashboard/snapshot-v2?include_trend=false&include_model_stats=true&include_group_stats=true',{headers:t.headers},t.env); const snapshotJson=await snapshot.json() as any; expect(snapshotJson.data).toMatchObject({models:[{model:'gpt-test'}],groups:[{group_id:'group-a'}]}); expect(snapshotJson.data).not.toHaveProperty('trend'); const daily=await app.request('/api/v1/user/api-keys/alice-key/usage/daily?days=1',{headers:t.headers},t.env); await expect(daily.json()).resolves.toMatchObject({data:{days:1,items:[{actual_cost:1.5}]}}); expect((await app.request('/api/v1/user/api-keys/bob-key/usage/daily',{headers:t.headers},t.env)).status).toBe(404); const batch=await app.request('/api/v1/usage/dashboard/api-keys-usage',{method:'POST',headers:{...t.headers,'content-type':'application/json'},body:JSON.stringify({api_key_ids:['alice-key']})},t.env); await expect(batch.json()).resolves.toMatchObject({data:{stats:{'alice-key':{total_actual_cost:1.5}}}}); await expect((await app.request('/api/v1/usage/errors',{headers:t.headers},t.env)).json()).resolves.toMatchObject({code:'user_error_requests_disabled',data:null}) })
 it('offers stable bounded cursor pagination and rejects unbounded legacy pages',async()=>{
  const t=await fixture(),app=createApp()
  await t.env.DB.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,api_key_id,group_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms)VALUES('alice-z','alice-z','alice','alice-key','group-a','gpt-other',1,1,100000,?,?)`).bind(TEST_NOW,TEST_NOW).run()
  await t.env.DB.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,api_key_id,group_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms)VALUES('alice-older','alice-older','alice','alice-key','group-a','gpt-other',1,1,100000,?,?)`).bind(TEST_NOW-1,TEST_NOW).run()
  const first=await app.request('/api/v1/usage?limit=1',{headers:t.headers},t.env)
  expect(first.status).toBe(200)
  const firstBody=await first.json() as any
  expect(firstBody.data).toMatchObject({items:[{id:'alice-z'}],has_more:true,next_cursor:expect.any(String)})
  const second=await app.request(`/api/v1/usage?limit=1&cursor=${encodeURIComponent(firstBody.data.next_cursor)}`,{headers:t.headers},t.env)
  const secondBody=await second.json() as any
  expect(secondBody.data).toMatchObject({items:[{id:'alice-event'}],has_more:true,next_cursor:expect.any(String)})
  const third=await app.request(`/api/v1/usage?limit=1&cursor=${encodeURIComponent(secondBody.data.next_cursor)}`,{headers:t.headers},t.env)
  await expect(third.json()).resolves.toMatchObject({data:{items:[{id:'alice-older'}],has_more:false,next_cursor:null}})
  expect((await app.request('/api/v1/usage?limit=1&cursor=not-a-cursor',{headers:t.headers},t.env)).status).toBe(400)
  expect((await app.request('/api/v1/usage?page=101&page_size=20',{headers:t.headers},t.env)).status).toBe(400)
 })
 it('honors supported legacy list sorting and rejects unknown sort fields',async()=>{
  const t=await fixture(),app=createApp()
  await t.env.DB.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,api_key_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms)VALUES('alice-alpha','alice-alpha','alice','alice-key','alpha',1,1,1,?,?)`).bind(TEST_NOW+1,TEST_NOW).run()
  const sorted=await app.request('/api/v1/usage?page=1&page_size=20&sort_by=model&sort_order=asc',{headers:t.headers},t.env)
  expect((await sorted.json() as any).data.items.map((row:any)=>row.id)).toEqual(['alice-alpha','alice-event'])
  expect((await app.request('/api/v1/usage?page=1&sort_by=cost',{headers:t.headers},t.env)).status).toBe(400)
 })
 it('ports request-type, billing-mode, compaction, endpoint, and platform usage dimensions',async()=>{
  const t=await fixture(),app=createApp()
  await t.env.DB.prepare(`INSERT INTO usage_projection(
    event_id,request_id,user_id,api_key_id,group_id,model,input_tokens,output_tokens,
    amount_micros,occurred_at_ms,projected_at_ms,stream,platform,request_type,
    inbound_endpoint,upstream_endpoint,billing_mode,native_compaction_v2
  ) VALUES('alice-stream','alice-stream','alice','alice-key','group-a','gpt-stream',3,4,
    250000,?,?,1,'openai',2,'/v1/responses','/v1/chat/completions','token',0)`)
    .bind(TEST_NOW-1,TEST_NOW).run()
  await t.env.DB.prepare(`INSERT INTO usage_projection(
    event_id,request_id,user_id,api_key_id,group_id,model,input_tokens,output_tokens,
    amount_micros,occurred_at_ms,projected_at_ms,stream,platform,request_type,
    inbound_endpoint,upstream_endpoint,billing_mode,native_compaction_v2,dimensions_version
  ) VALUES('alice-unknown','alice-unknown','alice','alice-key','group-a','gpt-unknown',1,1,
    10000,?,?,0,'openai',0,'/v1/responses','/v1/responses','token',0,1)`)
    .bind(TEST_NOW-2,TEST_NOW).run()

  const filtered=await app.request('/api/v1/usage?limit=20&request_type=stream&stream=bad&billing_mode=token&native_compaction_v2=false',{headers:t.headers},t.env)
  expect(filtered.status).toBe(200)
  await expect(filtered.json()).resolves.toMatchObject({data:{items:[{
    id:'alice-stream',request_type:'stream',stream:true,billing_mode:'token',
    native_compaction_v2:false,inbound_endpoint:'/v1/responses',
  }]}})
  expect((await app.request('/api/v1/usage?request_type=invalid',{headers:t.headers},t.env)).status).toBe(400)
  expect((await app.request('/api/v1/usage?request_type=constructor',{headers:t.headers},t.env)).status).toBe(400)
  expect((await app.request('/api/v1/usage?native_compaction_v2=invalid',{headers:t.headers},t.env)).status).toBe(400)
  await expect((await app.request('/api/v1/usage?limit=20&billing_mode=video',{headers:t.headers},t.env)).json())
    .resolves.toMatchObject({data:{items:[]}})
  expect((await app.request('/api/v1/usage/dashboard/models?model_source=upstream',{headers:t.headers},t.env)).status).toBe(400)

  await expect((await app.request('/api/v1/usage/stats?request_type=stream',{headers:t.headers},t.env)).json())
    .resolves.toMatchObject({data:{total_requests:1,endpoints:[{endpoint:'/v1/responses',requests:1}]}})
  await expect((await app.request('/api/v1/usage?limit=20&request_type=sync',{headers:t.headers},t.env)).json())
    .resolves.toMatchObject({data:{items:[{id:'alice-event',request_type:'sync'}]}})
  const unknown = await (await app.request('/api/v1/usage?limit=20&request_type=unknown',{headers:t.headers},t.env)).json() as any
  expect(unknown.data.items).toEqual([expect.objectContaining({id:'alice-unknown',request_type:'unknown'})])
  await expect((await app.request('/api/v1/usage/dashboard/stats',{headers:t.headers},t.env)).json())
    .resolves.toMatchObject({data:{by_platform:[{platform:'openai',total_requests:3}]}})
 })
 it('returns persisted image billing dimensions instead of synthetic zero values',async()=>{
  const t=await fixture(),app=createApp()
  await t.env.DB.prepare(`INSERT INTO usage_projection(
    event_id,request_id,user_id,api_key_id,group_id,model,input_tokens,output_tokens,
    amount_micros,occurred_at_ms,projected_at_ms,billing_mode,image_count,image_size,
    image_input_size,image_output_size,image_size_source,image_size_breakdown
  ) VALUES('alice-image','alice-image','alice','alice-key','group-a','gpt-image-2',0,0,
    500000,?,?,'image',2,'4K','2048x2048','3840x2160','output','{"1K":1,"4K":1}')`)
    .bind(TEST_NOW+1,TEST_NOW+1).run()
  const response=await app.request('/api/v1/usage?limit=1',{headers:t.headers},t.env)
  await expect(response.json()).resolves.toMatchObject({data:{items:[{
    id:'alice-image',billing_mode:'image',image_count:2,image_size:'4K',
    image_input_size:'2048x2048',image_output_size:'3840x2160',image_size_source:'output',
    image_size_breakdown:{'1K':1,'4K':1},
  }]}})
 })
})
