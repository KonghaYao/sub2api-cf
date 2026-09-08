import { describe, it, expect, vi } from 'vitest'
import { clearHarness, setupRisk } from '../helpers/risk-control-fixture'
import { createApp } from '../../src/app'
import { moderateGatewayRequest, consumeRiskModeration, recoverRiskJobs } from '../../src/gateway/risk-moderation'
import { cleanupRiskData } from '../../src/risk/maintenance'
import { deliverRiskNotifications } from '../../src/risk/effects'
import { readRiskConfig } from '../../src/risk/config'
import { callModeration } from '../../src/risk/moderator'

async function enable(f:any,r:any,extra:Record<string,unknown>={}) {
 const config=await r.data(await r.call('/config'))
 return r.data(await r.call('/config','PUT',{...config,enabled:true,mode:'observe',api_keys:['first-moderation-key','second-moderation-key'],base_url:'https://moderation.example.com',record_non_hits:true,...extra}))
}
describe('Risk-control negative lifecycle boundaries',()=>{
 it('rejects non-admin access to configuration, logs and destructive actions',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   f.raw.prepare("UPDATE user_sessions SET user_id='risk-user' WHERE id='clear-session'").run()
   for(const [path,method] of [['/config','GET'],['/config','PUT'],['/logs','GET'],['/hashes/all','DELETE'],['/users/risk-user/unban','POST']]) expect((await r.call(path!,method!)).status).toBe(403)
   expect((await createApp().request('/api/v1/admin/risk-control/config',{},f.env)).status).toBe(401)
  }finally{f.raw.close()}
 })
 it('rotates off a rejected key, persists freeze and never loops over the newly frozen key',async()=>{
  const f=await clearHarness(false),r=setupRisk(f),credentials:string[]=[]
  try {
   await enable(f,r,{retry_count:5});const keys=f.raw.prepare('SELECT key_hash FROM risk_api_keys ORDER BY created_at_ms,key_hash').all();let first:string|undefined
   vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const credential=new Headers(init?.headers).get('authorization')!;credentials.push(credential);first??=credential;return credential===first?new Response('denied',{status:401}):Response.json({results:[{category_scores:{violence:.1}}]})})
   const result=await callModeration(f.env,await readRiskConfig(f.env),{text:'ordinary',images:[]});expect(result.result.error).toBe('');expect(credentials).toHaveLength(2);expect(new Set(credentials).size).toBe(2)
   expect(f.raw.prepare("SELECT COUNT(*) AS count FROM risk_api_keys WHERE frozen_until_ms>?").get(Date.now()).count).toBe(1)
   credentials.length=0;await callModeration(f.env,await readRiskConfig(f.env),{text:'ordinary',images:[]});expect(credentials).toHaveLength(1);expect(credentials[0]).not.toBe(first);expect(keys).toHaveLength(2)
  }finally{vi.restoreAllMocks();f.raw.close()}
 })
 it('recovers lost queue delivery, limits job admission, and cancels disabled policy without contacting the provider',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   await enable(f,r,{queue_size:1});f.env.EVENTS_QUEUE.send=vi.fn(async()=>{throw new Error('queue unavailable')})
   expect(await moderateGatewayRequest(f.env,r.input('durable-job'))).toEqual({allowed:true});expect(r.objects.size).toBe(1)
   expect(await moderateGatewayRequest(f.env,r.input('overflow'))).toEqual({allowed:true});expect(r.objects.size).toBe(1);expect(f.raw.prepare('SELECT COUNT(*) AS count FROM risk_jobs').get().count).toBe(1)
   const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({results:[{category_scores:{violence:.1}}]}));await recoverRiskJobs(f.env);expect(fetch).toHaveBeenCalledTimes(1);expect(r.objects.size).toBe(0)
   await moderateGatewayRequest(f.env,r.input('policy-disabled'));f.raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.risk_control_enabled',json('false'))").run();await recoverRiskJobs(f.env);expect(fetch).toHaveBeenCalledTimes(1);expect(r.objects.size).toBe(0);expect(f.raw.prepare("SELECT status FROM risk_jobs WHERE request_id='policy-disabled'").get().status).toBe('done')
  }finally{vi.restoreAllMocks();f.raw.close()}
 })
 it('deletes encrypted payload if database admission fails and never stores an untracked prompt',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   await enable(f,r);const db=f.env.DB;f.env.DB=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>{if(sql.includes('INSERT INTO risk_jobs'))throw new Error('database unavailable');return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
   await expect(moderateGatewayRequest(f.env,r.input('admission-failed','private prompt'))).rejects.toThrow('database unavailable');expect(r.objects.size).toBe(0)
  }finally{f.raw.close()}
 })
 it('bounds provider response size and cancels its reader without recording false flags',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   await enable(f,r,{retry_count:0});vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('x'.repeat(262145),{status:200}));await moderateGatewayRequest(f.env,r.input('oversized-result'));await consumeRiskModeration(r.queue[0],f.env)
   expect(f.raw.prepare('SELECT flagged,error FROM risk_logs').get()).toMatchObject({flagged:0,error:'moderation_response_too_large'});expect(f.raw.prepare('SELECT COUNT(*) AS count FROM risk_ban_commands').get().count).toBe(0)
  }finally{vi.restoreAllMocks();f.raw.close()}
 })
 it('holds one durable execution lease under duplicate delivery and stays within 50 D1 statements under six provider failures',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   await enable(f,r,{retry_count:5,api_keys_mode:'replace',api_keys:Array.from({length:8},(_,i)=>'test-risk-key-'+i)})
   await moderateGatewayRequest(f.env,r.input('six-failures'))
   let queries=0;const db=f.env.DB;f.env.DB=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>{queries++;return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
   const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('rate limited',{status:429}))
   await consumeRiskModeration(r.queue[0],f.env);expect(fetch).toHaveBeenCalledTimes(6);expect(queries).toBeLessThanOrEqual(50);expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_logs').get().n).toBe(1)
   await consumeRiskModeration(r.queue[0],f.env);expect(fetch).toHaveBeenCalledTimes(6)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_api_keys WHERE frozen_until_ms>?').get(Date.now()).n).toBe(6)
  }finally{vi.restoreAllMocks();f.raw.close()}
 })
 it('cancels an in-flight provider request at the configured timeout and fails open with a recorded error',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   await enable(f,r,{mode:'pre_block',timeout_ms:100,retry_count:5})
   const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})}))
   expect(await moderateGatewayRequest(f.env,r.input('timeout'))).toEqual({allowed:true});expect(fetch).toHaveBeenCalledTimes(1)
   expect(f.raw.prepare('SELECT flagged,error FROM risk_logs').get()).toMatchObject({flagged:0,error:'moderation_timeout'});expect(f.raw.prepare('SELECT status FROM risk_jobs').get().status).toBe('done')
  }finally{vi.restoreAllMocks();f.raw.close()}
 })

 it('allows only one in-flight provider execution for duplicate queue delivery',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   await enable(f,r);await moderateGatewayRequest(f.env,r.input('duplicate-concurrent'))
   let release!:(value:Response)=>void;let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve})
   const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{started();return new Promise<Response>(resolve=>{release=resolve})})
   const first=consumeRiskModeration(r.queue[0],f.env);await began;await consumeRiskModeration(r.queue[0],f.env)
   expect(fetch).toHaveBeenCalledTimes(1);expect(f.raw.prepare("SELECT COUNT(*) AS n FROM risk_jobs WHERE status='processing'").get().n).toBe(1)
   release(Response.json({results:[{category_scores:{violence:.1}}]}));await first;expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_logs').get().n).toBe(1)
  }finally{vi.restoreAllMocks();f.raw.close()}
 })
 it('cancels pending notification under the current global switch, and preserves expired logs referenced by pending ban commands',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   await enable(f,r,{mode:'pre_block',keyword_blocking_mode:'keyword_only',blocked_keywords:['danger'],email_on_hit:true,auto_ban_enabled:true,ban_threshold:1})
   await moderateGatewayRequest(f.env,r.input('retain-command','danger'))
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_ban_commands').get().n).toBe(1)
   f.raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.risk_control_enabled',json('false'))").run();await deliverRiskNotifications(f.env);expect(r.mail).toHaveLength(0)
   f.raw.prepare('UPDATE risk_logs SET created_at_ms=1').run();await cleanupRiskData(f.env);expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_logs').get().n).toBe(1)
   f.raw.prepare("UPDATE risk_ban_commands SET status='cancelled'").run();await cleanupRiskData(f.env);expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_logs').get().n).toBe(0)
  }finally{f.raw.close()}
 })

 it('rejects an unsupported test image and non-boolean key clearing without changing saved secrets',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try {
   const saved=await enable(f,r)
   expect((await r.call('/api-keys/test','POST',{images:['http://plain.example/image.png']})).status).toBe(400)
   expect((await r.call('/config','PUT',{expected_control_version:saved.control_version,clear_api_key:'true'})).status).toBe(400)
   expect((await r.data(await r.call('/config'))).api_key_count).toBe(2)
  }finally{f.raw.close()}
 })

})
