import { Hono } from 'hono'
import { describe,expect,it,vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken,tokenDigest } from '../../src/auth/tokens'
import { runtimeDefaults,runtimeSettingNames,runtimeSettingHandlers,loadRuntimeSetting } from '../../src/control/runtime-settings'
import { enforcePanelRateLimit } from '../../src/control/panel-rate-limit'
import { configuredFailureCooldown,applyBetaPolicy,rectifyAnthropicRequest,applyStreamTimeoutPolicy,recordConfiguredUpstreamFailure } from '../../src/gateway/runtime-policies'
import { GatewayError } from '../../src/gateway/errors'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
const PEPPER='runtime-settings-fixture-pepper-32-bytes'
async function fixture() {
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const now=Date.now(),auth:Record<string,string>={}
 for(const id of ['admin','alice','bob']) {
  raw.prepare('INSERT INTO users(id,email,role,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?)').run(id,`${id}@test.invalid`,id==='admin'?'admin':'user',now,now)
  const access=createOpaqueToken('access'),refresh=createOpaqueToken('refresh')
  raw.prepare('INSERT INTO user_sessions(id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms)VALUES(?,?,?,1,?,?,?,?,?)').run(id,id,id,await tokenDigest(access,PEPPER,'access'),await tokenDigest(refresh,PEPPER,'refresh'),now,now+600000,now+1200000)
  auth[id]=`Bearer ${access}`
 }
 const env={DB:d1,API_KEY_PEPPER:PEPPER,ENVIRONMENT:'test'} as Env
 const app=new Hono<{Bindings:Env}>();app.use('*',enforcePanelRateLimit)
 for(const name of runtimeSettingNames){const handlers=runtimeSettingHandlers(name);app.get(`/api/v1/admin/settings/${name}`,handlers.get);app.put(`/api/v1/admin/settings/${name}`,handlers.put)}
 app.get('/api/v1/usage/stats',c=>c.json({ok:true}));app.get('/api/v1/settings/public',c=>c.json({ok:true}))
 const put=(name:string,body:unknown,authorization=auth.admin,extra:Record<string,string>={})=>app.request(`/api/v1/admin/settings/${name}`,{method:'PUT',headers:{authorization,'content-type':'application/json',...extra},body:JSON.stringify(body)},env)
 return {raw,env,app,auth,put}
}

describe('runtime auxiliary settings with real authenticated routes and SQLite',()=>{
 it('loads defaults, persists exact policy fields and rejects non-admin/invalid changes',async()=>{
  const t=await fixture()
  for(const name of runtimeSettingNames){const response=await t.app.request(`/api/v1/admin/settings/${name}`,{headers:{authorization:t.auth.admin}},t.env);expect(response.status).toBe(200);expect((await response.json() as any).data).toEqual(runtimeDefaults[name])}
  expect((await t.put('overload-cooldown',{enabled:true,cooldown_minutes:3},t.auth.alice)).status).toBe(403)
  expect((await t.put('overload-cooldown',{enabled:true,cooldown_minutes:0})).status).toBe(400)
  expect((await t.put('overload-cooldown',{enabled:true,cooldown_minutes:3})).status).toBe(200)
  expect(await configuredFailureCooldown(t.env,new Response('',{status:529}))).toBe(180000)
  expect((await t.put('overload-cooldown',{enabled:false,cooldown_minutes:3},t.auth.admin,{'if-match':'"0"'})).status).toBe(409)
  expect(await configuredFailureCooldown(t.env,new Response('',{status:529}))).toBe(180000)
  t.raw.close()
 })
 it('applies configured overload and 429 durations to the actual Pool command, preserving Retry-After',async()=>{
  const t=await fixture(),calls:any[]=[]
  const pool={fetch:async(req:Request)=>{calls.push(await req.json());return Response.json({schema_version:1,ok:true})}} as unknown as DurableObjectStub
  await t.put('rate-limit-429-cooldown',{enabled:true,cooldown_seconds:7})
  await recordConfiguredUpstreamFailure(t.env,pool,'account','req1',new Response('',{status:429}))
  expect(calls[0]).toMatchObject({cooldown_ms:7000})
  expect(await configuredFailureCooldown(t.env,new Response('',{status:429,headers:{'retry-after':'12'}}))).toBe(12000)
  await t.put('rate-limit-429-cooldown',{enabled:false,cooldown_seconds:7})
  await recordConfiguredUpstreamFailure(t.env,pool,'account','req2',new Response('',{status:429}))
  expect(calls).toHaveLength(1)
  t.raw.close()
 })
 it('enforces per-user/heavy limits immediately without coupling users behind the same IP',async()=>{
  const t=await fixture();await t.put('panel-rate-limit',{enabled:true,user_rpm:20,heavy_rpm:1,exempt_admin:true,public_ip_rpm:1})
  const request=(user:string)=>t.app.request('/api/v1/usage/stats',{headers:{authorization:t.auth[user],'cf-connecting-ip':'8.8.8.8'}},t.env)
  expect((await request('alice')).status).toBe(200);expect((await request('alice')).status).toBe(429);expect((await request('bob')).status).toBe(200);expect((await request('admin')).status).toBe(200)
  expect((await t.app.request('/api/v1/settings/public',{headers:{'cf-connecting-ip':'8.8.8.8'}},t.env)).status).toBe(200)
  expect((await t.app.request('/api/v1/settings/public',{headers:{'cf-connecting-ip':'8.8.8.8'}},t.env)).status).toBe(429)
  await t.put('panel-rate-limit',{enabled:false,user_rpm:20,heavy_rpm:1,exempt_admin:true,public_ip_rpm:1});expect((await request('alice')).status).toBe(200)
  t.raw.close()
 })
 it('enforces beta scope, model whitelist, fallback and block from saved configuration',async()=>{
  const t=await fixture();await t.put('beta-policy',{rules:[{beta_token:'feature-v1',action:'pass',scope:'apikey',model_whitelist:['claude-good*'],fallback_action:'block',fallback_error_message:'unsupported model'}]})
  const config=await loadRuntimeSetting(t.env,'beta-policy')
  expect(applyBetaPolicy(config,'feature-v1','claude-good-1','api_key')).toBe('feature-v1')
  expect(()=>applyBetaPolicy(config,'feature-v1','claude-other','api_key')).toThrow('unsupported model')
  expect(applyBetaPolicy(config,'feature-v1','claude-other','oauth')).toBe('feature-v1')
  expect(applyBetaPolicy(runtimeDefaults['beta-policy'],'fast-mode-2026-02-01,other-v1','claude-other','api_key')).toBe('other-v1')
  t.raw.close()
 })
 it('applies stream timeout threshold once per request, expires old events and supports error/none actions',async()=>{
  const t=await fixture(),calls:Array<{path:string;body:any}>=[],now=Date.now()
  t.raw.prepare('INSERT INTO accounts(id,name,platform,credential_ref,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?)').run('timeout-account','Timeout','openai','fixture',now,now)
  const pool={fetch:async(req:Request)=>{calls.push({path:new URL(req.url).pathname,body:await req.json()});return Response.json({schema_version:1,ok:true})}} as unknown as DurableObjectStub
  await t.put('stream-timeout',{enabled:true,action:'temp_unsched',temp_unsched_minutes:9,threshold_count:2,threshold_window_minutes:1})
  const timeout=new GatewayError(504,'upstream_idle_timeout','fixture timeout')
  expect(await applyStreamTimeoutPolicy(t.env,pool,'timeout-account','one',timeout)).toBe(true)
  await applyStreamTimeoutPolicy(t.env,pool,'timeout-account','one',timeout)
  expect(calls).toHaveLength(0)
  await applyStreamTimeoutPolicy(t.env,pool,'timeout-account','two',timeout)
  expect(calls).toEqual([{path:'/failure',body:expect.objectContaining({cooldown_ms:540000})}])
  t.raw.prepare('UPDATE stream_timeout_events SET occurred_at_ms=?').run(now-120000)
  await applyStreamTimeoutPolicy(t.env,pool,'timeout-account','three',timeout)
  expect(calls).toHaveLength(1)
  await t.put('stream-timeout',{enabled:true,action:'error',temp_unsched_minutes:9,threshold_count:2,threshold_window_minutes:1})
  await applyStreamTimeoutPolicy(t.env,pool,'timeout-account','four',timeout)
  expect(t.raw.prepare('SELECT health_status FROM accounts WHERE id=?').get('timeout-account')).toEqual({health_status:'unhealthy'})
  expect(calls.at(-1)).toMatchObject({path:'/accounts/upsert',body:{enabled:false,account_id:'timeout-account'}})
  await t.put('stream-timeout',{enabled:true,action:'none',temp_unsched_minutes:9,threshold_count:1,threshold_window_minutes:1})
  const count=calls.length;await applyStreamTimeoutPolicy(t.env,pool,'timeout-account','five',timeout);expect(calls).toHaveLength(count)
  expect(await applyStreamTimeoutPolicy(t.env,pool,'timeout-account','transport',new Error('not a timeout'))).toBe(false)
  t.raw.close()
 })

 it('rectifies only matching enabled errors and never expands the authorized token budget',async()=>{
  const t=await fixture();await t.put('rectifier',{...runtimeDefaults.rectifier,apikey_signature_enabled:true,apikey_signature_patterns:['custom broken history']})
  const config=await loadRuntimeSetting(t.env,'rectifier'),body={max_tokens:4096,thinking:{type:'enabled',budget_tokens:10},messages:[{role:'assistant',content:[{type:'thinking',thinking:'old',signature:'bad'},{type:'text',text:'answer'}]}]}
  expect(rectifyAnthropicRequest(config,body,{error:{message:'custom broken history'}},'api_key','claude-test')?.messages).toEqual([{role:'assistant',content:[{type:'text',text:'answer'}]}])
  expect(rectifyAnthropicRequest(config,body,{error:{message:'thinking budget_tokens >= 1024'}},'api_key','claude-test')).toMatchObject({max_tokens:4096,thinking:{budget_tokens:4095}})
  expect(rectifyAnthropicRequest({...config,enabled:false},body,{error:{message:'invalid signature'}},'api_key','claude-test')).toBeNull()
  expect(rectifyAnthropicRequest(config,body,{error:{message:'invalid signature'}},'api_key','deepseek')).toBeNull()
  t.raw.close()
 })
})
