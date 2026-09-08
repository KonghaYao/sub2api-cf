import { reservePoolAccount } from '../../src/gateway/state-client'
import { env } from 'cloudflare:workers'
import { expect,it,vi } from 'vitest'
import type { PoolSchedulerPolicy } from '../../src/shared/state-machine/pool-scheduler'

it('uses persisted outcomes and generated-token latency in real Pool selection, preserves capacity and restart-safe telemetry idempotency',async()=>{
 const pool=env.POOL_STATE.get(env.POOL_STATE.idFromName('scheduler-real-'+crypto.randomUUID()))
 async function post(path:string,body:unknown){const response=await pool.fetch('https://pool.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema_version:1,...body as object})});expect(response.status,await response.clone().text()).toBe(200);return response.json() as Promise<any>}
 for(const account_id of ['slow','fast'])await post('/accounts/upsert',{account_id,enabled:true,max_concurrency:1,priority:account_id==='slow'?0:10})
 await post('/reserve',{request_id:'sample-slow',lease_ttl_ms:60000,preferred_account_id:'slow'})
 await post('/telemetry',{request_id:'sample-slow',failed:true,ttft_ms:1000})
 expect(await post('/telemetry',{request_id:'sample-slow',failed:false,ttft_ms:1})).toMatchObject({idempotent:true})
 await post('/release',{request_id:'sample-slow'})
 await post('/reserve',{request_id:'sample-fast',lease_ttl_ms:60000,preferred_account_id:'fast'})
 await post('/telemetry',{request_id:'sample-fast',failed:false,ttft_ms:10})
 await post('/release',{request_id:'sample-fast'})
 const policy:PoolSchedulerPolicy={enabled:true,sticky_weighted:true,top_k:1,weights:{priority:0,load:0,error_rate:1,ttft:0,session_sticky:0}}
 expect((await post('/reserve',{request_id:'select-error',lease_ttl_ms:60000,scheduler:policy})).lease.account_id).toBe('fast')
 // A full fast account is never selected even when it has the highest score.
 expect((await post('/reserve',{request_id:'capacity-fallback',lease_ttl_ms:60000,scheduler:policy})).lease.account_id).toBe('slow')
 await post('/release',{request_id:'select-error'});await post('/release',{request_id:'capacity-fallback'})
 policy.weights.error_rate=0;policy.weights.ttft=1
 expect((await post('/reserve',{request_id:'select-ttft',lease_ttl_ms:60000,scheduler:policy})).lease.account_id).toBe('fast')
 await post('/release',{request_id:'select-ttft'})
 policy.enabled=false
 expect((await post('/reserve',{request_id:'legacy-priority',lease_ttl_ms:60000,scheduler:policy})).lease.account_id).toBe('slow')
 const unknown=await pool.fetch('https://pool.test/telemetry',{method:'POST',body:JSON.stringify({schema_version:1,request_id:'unleased',failed:false})})
 expect(unknown.status).toBe(404)
})

it('persists provider quota windows and response affinity on an actual lease',async()=>{
 const pool=env.POOL_STATE.get(env.POOL_STATE.idFromName('scheduler-window-'+crypto.randomUUID()))
 async function post(path:string,body:unknown){const r=await pool.fetch('https://pool.test'+path,{method:'POST',body:JSON.stringify({schema_version:1,...body as object})});expect(r.status,await r.clone().text()).toBe(200);return r.json() as Promise<any>}
 for(const account_id of ['soon','headroom'])await post('/accounts/upsert',{account_id,enabled:true,max_concurrency:2})
 for(const [account_id,headroom,remaining] of [['soon',0.1,60000],['headroom',0.9,120000]] as const){
  await post('/reserve',{request_id:account_id,lease_ttl_ms:60000,preferred_account_id:account_id})
  await post('/quota-snapshot',{request_id:account_id,headroom,reset_at_ms:Date.now()+remaining,observed_at_ms:Date.now()})
  await post('/release',{request_id:account_id})
 }
 const policy:PoolSchedulerPolicy={enabled:true,sticky_weighted:true,top_k:1,weights:{priority:0,load:0,error_rate:0,ttft:0,session_sticky:0,quota_headroom:1,reset:0,previous_response:5}}
 expect((await post('/reserve',{request_id:'quota-select',lease_ttl_ms:60000,scheduler:policy})).lease.account_id).toBe('headroom')
 await post('/release',{request_id:'quota-select'})
 policy.weights.quota_headroom=0;policy.weights.reset=1
 expect((await post('/reserve',{request_id:'reset-select',lease_ttl_ms:60000,scheduler:policy})).lease.account_id).toBe('soon')
 await post('/response-affinity',{request_id:'reset-select',response_key:'a'.repeat(64)})
 expect(await post('/response-affinity',{response_key:'a'.repeat(64)})).toMatchObject({account_id:'soon'})
 expect(await post('/response-affinity',{response_key:'b'.repeat(64)})).toMatchObject({account_id:null})
 policy.weights.quota_headroom=1;policy.weights.reset=0
 expect((await post('/reserve',{request_id:'previous-select',lease_ttl_ms:60000,scheduler:policy,previous_account_id:'soon',require_previous_account:false})).lease.account_id).toBe('soon')
})

it('balances actual bounded wait queues and wakes queued calls after capacity is released',async()=>{
 const pool=env.POOL_STATE.get(env.POOL_STATE.idFromName('scheduler-queue-'+crypto.randomUUID()))
 async function post(path:string,body:unknown,signal?:AbortSignal){return pool.fetch('https://pool.test'+path,{method:'POST',signal,body:JSON.stringify({schema_version:1,...body as object})})}
 for(const account_id of ['a','b']){
  expect((await post('/accounts/upsert',{account_id,enabled:true,max_concurrency:1})).status).toBe(200)
  expect((await post('/reserve',{request_id:'busy-'+account_id,lease_ttl_ms:60000,preferred_account_id:account_id})).status).toBe(200)
 }
 const scheduler:PoolSchedulerPolicy={enabled:true,sticky_weighted:false,top_k:1,weights:{priority:0,load:0,error_rate:0,ttft:0,session_sticky:0,queue:1}}
 const waiting=async()=>((await (await pool.fetch('https://pool.test/snapshot')).json()) as {waiting:Array<{request_id:string;account_id:string}>}).waiting
 const first=post('/reserve',{request_id:'wait-a',lease_ttl_ms:60000,scheduler})
 await vi.waitFor(async()=>expect(await waiting()).toEqual([expect.objectContaining({request_id:'wait-a',account_id:'a'})]))
 const second=post('/reserve',{request_id:'wait-b',lease_ttl_ms:60000,scheduler})
 await vi.waitFor(async()=>expect(await waiting()).toHaveLength(2))
 expect((await waiting()).find(x=>x.request_id==='wait-b')?.account_id).toBe('b')
 await post('/release',{request_id:'busy-b'})
 expect(await (await second).json()).toMatchObject({lease:{account_id:'b'}})
 await post('/release',{request_id:'busy-a'})
 expect(await (await first).json()).toMatchObject({lease:{account_id:'a'}})
 expect(await waiting()).toEqual([])
 const cancelled=new AbortController()
 const pending=reservePoolAccount(pool,'cancel-wait',undefined,undefined,scheduler,undefined,undefined,false,cancelled.signal).catch(()=>null)
 await vi.waitFor(async()=>expect(await waiting()).toHaveLength(1))
 cancelled.abort()
 await pending
 await vi.waitFor(async()=>expect(await waiting()).toEqual([]),{timeout:1000})
 const snapshot=await (await pool.fetch('https://pool.test/snapshot')).json() as {active_leases:Array<{request_id:string}>}
 expect(snapshot.active_leases.some(x=>x.request_id==='cancel-wait')).toBe(false)
},10000)

it('enforces legacy low-rate policy in the real Pool DO without bypassing capacity',async()=>{
 const pool=env.POOL_STATE.get(env.POOL_STATE.idFromName('legacy-cost-'+crypto.randomUUID()))
 async function post(path:string,body:object){const response=await pool.fetch('https://pool.test'+path,{method:'POST',body:JSON.stringify({schema_version:1,...body})});expect(response.status,await response.clone().text()).toBe(200);return response.json() as Promise<any>}
 await post('/accounts/upsert',{account_id:'expensive',enabled:true,max_concurrency:1,priority:0})
 await post('/accounts/upsert',{account_id:'cheap',enabled:true,max_concurrency:1,priority:10})
 const scheduler:PoolSchedulerPolicy={enabled:false,legacy_low_rate_priority:true,sticky_weighted:false,top_k:1,weights:{priority:1,load:1,error_rate:1,ttft:1,session_sticky:0}}
 const body={lease_ttl_ms:60000,scheduler,account_cost_rates:{expensive:2000000,cheap:500000}}
 expect((await post('/reserve',{...body,request_id:'low'})).lease.account_id).toBe('cheap')
 expect((await post('/reserve',{...body,request_id:'full'})).lease.account_id).toBe('expensive')
 await post('/release',{request_id:'low'});await post('/release',{request_id:'full'})
 expect((await post('/reserve',{...body,request_id:'off',scheduler:{...scheduler,legacy_low_rate_priority:false}})).lease.account_id).toBe('expensive')
})
