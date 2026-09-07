import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { runScheduledChannelMonitors } from '../../src/control/channel-monitors'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
const PEPPER = 'p'.repeat(32)
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'
async function clearHarness(enableTotp = true): Promise<any> {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  const now = Date.now()
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  database.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
     ) VALUES ('clear-admin', 'clear@example.com', 'Clear Admin', 'admin', 'active', 1, ?, ?)`,
  ).run(now, now)
  database.raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, step_up_expires_at_ms
     ) VALUES ('clear-session', 'clear-family', 'clear-admin', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now,
    now + 60_000,
    now + 120_000,
    now + 60_000,
  )
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    DB: database.d1, ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  if (enableTotp) {
    const encrypted = await encryptTotpSecret(env, 'clear-admin', TOTP_SECRET)
    database.raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, secret_version, nonce_b64, ciphertext_b64,
         enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('clear-admin', ?, ?, ?, ?, ?, ?)`,
    ).run(
      encrypted.secret_version,
      encrypted.nonce_b64,
      encrypted.ciphertext_b64,
      now,
      now,
      now,
    )
  }
  return { env, raw: database.raw, accessToken }
}


describe('original monitor UI and actual synthetic probe lifecycle',()=>{
 it('bounds scheduled D1 work for eleven models and records malformed upstream bodies as failures',async()=>{
  const f=await clearHarness(false),app=createApp(),now=Date.now()
  const call=async(path:string,method:string,body:unknown)=>app.request('/api/v1/admin'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json'},body:JSON.stringify(body)},f.env)
  const fetcher=vi.fn(async()=>Response.json({choices:[]}));vi.stubGlobal('fetch',fetcher)
  try{
   expect((await call('/settings/channel-monitor','PUT',{expected_control_version:0,channel_monitor_enabled:true})).status).toBe(200)
   const created=await call('/channel-monitors','POST',{name:'Budget monitor',provider:'openai',endpoint:'https://api.example.test',api_key:'budget-secret',primary_model:'primary',extra_models:Array.from({length:10},(_,i)=>`extra-${i}`),interval_seconds:300})
   expect(created.status).toBe(200)
   let count=0;const database=f.env.DB;f.env.DB=new Proxy(database,{get(target,key){if(key==='prepare')return(sql:string)=>{count++;return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
   await runScheduledChannelMonitors(f.env,now+1000);expect(count).toBeLessThanOrEqual(50);expect(fetcher).toHaveBeenCalledTimes(11)
   expect(f.raw.prepare("SELECT COUNT(*) AS n FROM channel_monitor_history WHERE status='failed' AND message='upstream_invalid_response'").get().n).toBe(11)
   count=0;await runScheduledChannelMonitors(f.env,now+2000);expect(count).toBeLessThanOrEqual(50);expect(fetcher).toHaveBeenCalledTimes(11)
  }finally{vi.unstubAllGlobals();f.raw.close()}
 })
 it('creates template and monitor, probes real request, changes template snapshot, duplicates, disables and deletes',async()=>{
  const f=await clearHarness(false),app=createApp();
  const call=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>app.request('/api/v1'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env)
  const data=async(response:Response)=>{expect(response.status,await response.clone().text()).toBe(200);return(await response.json() as any).data}
  const fetcher=vi.fn(async(_url:unknown,_init?:RequestInit)=>Response.json({choices:[{message:{content:'OK'}}]}));vi.stubGlobal('fetch',fetcher)
  try{
   await data(await call('/admin/settings/channel-monitor','PUT',{channel_monitor_enabled:true},{'if-match':'"0"'}))
   const template=await data(await call('/admin/channel-monitor-templates','POST',{name:'Probe defaults',provider:'openai',extra_headers:{'x-probe':'initial'},body_override_mode:'merge',body_override:{max_tokens:8}}))
   const monitor=await data(await call('/admin/channel-monitors','POST',{name:'Live monitor',provider:'openai',endpoint:'https://api.example.test',api_key:'private-monitor-secret',primary_model:'model-a',extra_models:['model-b'],interval_seconds:300,template_id:template.id}))
   expect(JSON.stringify(monitor)).not.toContain('private-monitor-secret');expect(JSON.stringify(f.raw.prepare('SELECT * FROM channel_monitors').get())).not.toContain('private-monitor-secret')
   const run=await data(await call(`/admin/channel-monitors/${monitor.id}/run`,'POST'))
   expect(run.results).toHaveLength(2);expect(run.results[0].status).toBe('operational')
   expect(fetcher).toHaveBeenCalledTimes(2)
   const init=fetcher.mock.calls[0][1]!;expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-monitor-secret');expect(new Headers(init.headers).get('x-probe')).toBe('initial');expect(JSON.parse(init.body as string)).toMatchObject({model:'model-a',max_tokens:8,stream:false})
   expect((await data(await call(`/admin/channel-monitors/${monitor.id}/history?model=model-a`))).items).toHaveLength(1)
   const list=await data(await call('/admin/channel-monitors?search=Live&page_size=1'));expect(list).toMatchObject({total:1,page_size:1});expect(list.items[0]).toMatchObject({primary_status:'operational',availability_7d:100})
   await data(await call(`/admin/channel-monitor-templates/${template.id}`,'PUT',{extra_headers:{'x-probe':'changed'}}))
   expect((await data(await call(`/admin/channel-monitors/${monitor.id}`))).extra_headers).toEqual({'x-probe':'initial'})
   expect((await data(await call(`/admin/channel-monitor-templates/${template.id}/monitors`))).items[0].id).toBe(monitor.id)
   await data(await call(`/admin/channel-monitor-templates/${template.id}/apply`,'POST',{monitor_ids:[monitor.id]}))
   await data(await call(`/admin/channel-monitors/${monitor.id}`,'PUT',{api_key:'',enabled:true}))
   await data(await call(`/admin/channel-monitors/${monitor.id}/run`,'POST'))
   expect(new Headers(fetcher.mock.calls[2][1]!.headers).get('x-probe')).toBe('changed')
   const copies=await Promise.all([1,2].map(()=>call(`/admin/channel-monitors/${monitor.id}/duplicate`,'POST',{}, {'idempotency-key':'same-copy'}).then(data)))
   expect(copies[0].id).toBe(copies[1].id);expect(copies[0].enabled).toBe(false)
   expect((await app.request('/api/v1/channel-monitors',{},f.env)).status).toBe(401)
   const userList=await data(await call('/channel-monitors'));expect(userList.items).toHaveLength(1);expect(JSON.stringify(userList)).not.toContain('api.example.test');expect(userList.items[0].timeline.length).toBeGreaterThan(0)
   expect((await data(await call(`/channel-monitors/${monitor.id}/status`))).models[0].availability_7d).toBe(100)
   await data(await call(`/admin/channel-monitors/${monitor.id}`,'PUT',{enabled:false}));expect((await call(`/admin/channel-monitors/${monitor.id}/run`,'POST')).status).toBe(409)
   const before=fetcher.mock.calls.length;await runScheduledChannelMonitors(f.env);expect(fetcher).toHaveBeenCalledTimes(before)
   await data(await call(`/admin/channel-monitor-templates/${template.id}`,'DELETE'));expect((await data(await call(`/admin/channel-monitors/${monitor.id}`))).template_id).toBeNull()
   await data(await call(`/admin/channel-monitors/${monitor.id}`,'DELETE'));expect((await call(`/admin/channel-monitors/${monitor.id}/history`)).status).toBe(404)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM channel_monitor_history WHERE monitor_id=?').get(monitor.id).n).toBe(0)
  }finally{vi.unstubAllGlobals();f.raw.close()}
 })
})
