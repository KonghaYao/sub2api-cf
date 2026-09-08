import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { normalizeOpsFeature } from '../../src/control/ops-feature-settings'
import { runOpsAlerts, opsEmailDefaults, opsAlertRuntimeDefaults } from '../../src/control/ops-alerts'
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


describe('Operations alerts real SQLite lifecycle',()=>{
 it('loads config, applies CAS, evaluates sustained breach, retries one batched delivery, resolves and honors current recipients/silences',async()=>{
  const f=await clearHarness(false), app=createApp(), now=Date.now(), deliveries:any[]=[]
  let fail=true
  f.env.EMAIL_DELIVERY={fetch:vi.fn(async(request:Request)=>{deliveries.push(await request.json());return new Response(null,{status:fail?503:204})})}
  const call=(path:string,method='GET',body?:unknown)=>app.request('/api/v1/admin/ops'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env)
  const data=async(r:Response)=>{expect(r.status,await r.clone().text()).toBe(200);return (await r.json() as any).data}
  try{
   const runtime=await data(await call('/runtime/alert')), email=await data(await call('/email-notification/config'))
   expect(runtime.evaluation_interval_seconds).toBe(60)
   expect((await call('/runtime/alert','PUT',{evaluation_interval_seconds:60})).status).toBe(428)
   await data(await call('/runtime/alert','PUT',{...runtime,evaluation_interval_seconds:60}))
   expect((await call('/runtime/alert','PUT',runtime)).status).toBe(412)
   await data(await call('/email-notification/config','PUT',{...email,alert:{...email.alert,enabled:true,recipients:['ops@example.com'],batching_window_seconds:0,include_resolved_alerts:true}}))
   const rule=await data(await call('/alert-rules','POST',{name:'Error ratio',description:'test',enabled:true,metric_type:'error_rate',operator:'>',threshold:50,window_minutes:5,sustained_minutes:1,severity:'P1',cooldown_minutes:1,notify_email:true,filters:{platform:'openai'}}))
   const insert=f.raw.prepare(`INSERT INTO request_observations(id,request_id,bucket_day,occurred_at_ms,completed_at_ms,lifecycle,method,request_path,platform,status_code,outcome,updated_at_ms) VALUES(?,?,20260907,?,?,'failed','POST','/v1/chat/completions','openai',500,'failed',?)`)
   insert.run('1'.repeat(32),'alert-error',now-1000,now-500,now)
   await runOpsAlerts(f.env,now)
   expect(await data(await call('/alert-events'))).toEqual([])
   await runOpsAlerts(f.env,now+60000)
   const event=(await data(await call('/alert-events')))[0]
   expect(event).toMatchObject({status:'firing',metric_value:100,email_sent:false})
   expect(deliveries).toHaveLength(1)
   expect(f.raw.prepare('SELECT attempts,last_error FROM ops_alert_outbox').get()).toMatchObject({attempts:1})
   fail=false
   await runOpsAlerts(f.env,now+120000)
   expect(deliveries).toHaveLength(2)
   expect(deliveries[0].event_id).toBe(deliveries[1].event_id)
   expect((await data(await call('/alert-events/'+event.id))).email_sent).toBe(true)
   f.raw.prepare("UPDATE request_observations SET lifecycle='completed',status_code=200").run()
   await runOpsAlerts(f.env,now+180000)
   expect((await data(await call('/alert-events/'+event.id))).status).toBe('resolved')
   expect(deliveries).toHaveLength(3)
   f.raw.prepare("UPDATE request_observations SET lifecycle='failed',status_code=500").run()
   await data(await call('/alert-silences','POST',{rule_id:rule.id,platform:'openai',until:new Date(now+3600000).toISOString(),reason:'maintenance'}))
   await runOpsAlerts(f.env,now+240000);await runOpsAlerts(f.env,now+300000)
   expect((await data(await call('/alert-events'))).length).toBe(1)
   expect((await call('/alert-rules/'+rule.id,'PUT',{...rule,threshold:25})).status).toBe(200)
   expect((await call('/alert-rules/'+rule.id,'PUT',rule)).status).toBe(412)
   expect((await call('/alert-rules','POST',{...rule,metric_type:'cpu_usage_percent'})).status).toBe(422)
   await data(await call('/alert-rules/'+rule.id,'DELETE'))
   expect(await data(await call('/alert-rules'))).toEqual([])
   expect((await call('/realtime-traffic?window=1min')).status).toBe(200)
  }finally{f.raw.close()}
 })
 it('pages all due rules, produces real reports and bounds maximum recipient/retry queries',async()=>{
  const f=await clearHarness(false),now=Date.now(),deliveries:any[]=[]
  f.env.EMAIL_DELIVERY={fetch:vi.fn(async(request:Request)=>{deliveries.push(await request.json());return new Response(null,{status:204})})}
  try{
   const settings=structuredClone(opsEmailDefaults);settings.alert={...settings.alert,enabled:true,recipients:Array.from({length:20},(_,i)=>`ops${i}@example.com`),batching_window_seconds:0};settings.report={...settings.report,enabled:true,recipients:settings.alert.recipients,daily_summary_enabled:true,daily_summary_schedule:'* * * * *',weekly_summary_enabled:true,weekly_summary_schedule:'* * * * *',error_digest_enabled:true,error_digest_schedule:'* * * * *',error_digest_min_count:0,account_health_enabled:true,account_health_schedule:'* * * * *'}
   f.raw.prepare("INSERT INTO ops_alert_config VALUES('email',?,1,?)").run(JSON.stringify(settings),now)
   f.raw.prepare(`INSERT INTO request_observations(id,request_id,bucket_day,occurred_at_ms,completed_at_ms,lifecycle,method,request_path,platform,status_code,outcome,updated_at_ms) VALUES(?,'budget-alert',20260907,?,?,'failed','POST','/v1/chat/completions','openai',500,'failed',?)`).run('2'.repeat(32),now-100,now,now)
   const rule={name:'Alert budget',description:'safe',enabled:true,metric_type:'error_rate',operator:'>',threshold:1,window_minutes:5,sustained_minutes:0,severity:'P1',cooldown_minutes:1,notify_email:true,filters:{}}
   for(let i=0;i<5;i++)f.raw.prepare('INSERT INTO ops_alert_rules(config_json,created_at_ms,updated_at_ms) VALUES(?,?,?)').run(JSON.stringify(rule),now,now)
   let count=0;const db=f.env.DB;f.env.DB=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>{count++;return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
   let result=await runOpsAlerts(f.env,now);expect(count).toBeLessThanOrEqual(50);expect(result.has_more_due_rules).toBe(true)
   count=0;result=await runOpsAlerts(f.env,now);expect(count).toBeLessThanOrEqual(50);expect(result.has_more_due_rules).toBe(true)
   for(let i=0;i<3;i++){count=0;result=await runOpsAlerts(f.env,now);expect(count).toBeLessThanOrEqual(50)};expect(result.has_more_due_rules).toBe(false)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM ops_alert_events').get().n).toBe(5)
   expect(f.raw.prepare("SELECT COUNT(*) AS n FROM ops_alert_outbox WHERE category='report'").get().n).toBe(80)
   expect(deliveries.length).toBeGreaterThan(0)
   const email=f.raw.prepare("SELECT config_json FROM ops_alert_config WHERE id='email'").get();const removed=JSON.parse(email.config_json);removed.alert.recipients=[];removed.report.recipients=[];f.raw.prepare("UPDATE ops_alert_config SET config_json=? WHERE id='email'").run(JSON.stringify(removed))
   const before=deliveries.length;count=0;await runOpsAlerts(f.env,now);expect(deliveries.length).toBe(before);expect(count).toBeLessThanOrEqual(50)
  }finally{f.raw.close()}
 })
 it('recovers a committed event after outbox insertion fails, and uses authoritative Pool metrics without fake unavailable zeros',async()=>{
  const f=await clearHarness(false),now=Date.now(),db=f.env.DB;let fail=true
  try{
   const email=structuredClone(opsEmailDefaults);email.alert={...email.alert,enabled:true,recipients:['recovery@example.com'],batching_window_seconds:3600}
   f.raw.prepare("INSERT INTO ops_alert_config VALUES('email',?,1,?)").run(JSON.stringify(email),now)
   f.raw.exec(`INSERT INTO "groups"(id,name,platform,created_at_ms,updated_at_ms) VALUES('uuid-group','Group','openai',1,1);INSERT INTO models(id,platform,public_name,upstream_name,endpoint,created_at_ms,updated_at_ms) VALUES('pool-model','openai','pool-model','pool-model','chat_completions',1,1);INSERT INTO pool_state_registry VALUES('uuid-group','pool-model','chat_completions',1,1)`)
   f.env.POOL_STATE={idFromName:(name:string)=>name,get:()=>({fetch:vi.fn(async()=>Response.json({accounts:[{account_id:'a',enabled:true,max_concurrency:2,active_leases:2,cooldown_until_ms:0}],waiting:[{request_id:'queued',account_id:null}]}))})}
   const rule={name:'Queue depth',description:'actual',enabled:true,metric_type:'concurrency_queue_depth',operator:'>',threshold:0,window_minutes:5,sustained_minutes:0,severity:'P1',cooldown_minutes:1,notify_email:true,filters:{group_id:'uuid-group'}}
   f.raw.prepare('INSERT INTO ops_alert_rules(config_json,created_at_ms,updated_at_ms) VALUES(?,?,?)').run(JSON.stringify(rule),now,now)
   f.env.DB=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>{if(fail&&sql.startsWith('INSERT INTO ops_alert_outbox')){fail=false;throw new Error('simulated D1 transient failure')}return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
   await expect(runOpsAlerts(f.env,now)).rejects.toThrow('simulated D1')
   expect(f.raw.prepare('SELECT metric_value,notification_state FROM ops_alert_events').get()).toEqual({metric_value:1,notification_state:''})
   await runOpsAlerts(f.env,now)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM ops_alert_events').get().n).toBe(1)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM ops_alert_outbox').get().n).toBe(1)
   f.env.POOL_STATE={idFromName:(name:string)=>name,get:()=>({fetch:vi.fn(async()=>new Response(null,{status:503}))})}
   await runOpsAlerts(f.env,now+60000)
   expect(f.raw.prepare('SELECT last_value,last_error FROM ops_alert_rules').get()).toEqual({last_value:null,last_error:'no_metric_samples'})
   expect(f.raw.prepare('SELECT status FROM ops_alert_events').get().status).toBe('firing')
  }finally{f.raw.close()}
 })

 it('retains the original report schedule across a delayed queue delivery and continuation',async()=>{
  const f=await clearHarness(false),scheduled=Date.UTC(2026,8,7,9,0),deliveries:any[]=[]
  f.env.EMAIL_DELIVERY={fetch:vi.fn(async(request:Request)=>{deliveries.push(await request.json());return new Response(null,{status:204})})}
  try{
   const email=structuredClone(opsEmailDefaults);email.report={...email.report,enabled:true,recipients:['report@example.com'],daily_summary_enabled:true,daily_summary_schedule:'0 9 * * *'}
   f.raw.prepare("INSERT INTO ops_alert_config VALUES('email',?,1,?)").run(JSON.stringify(email),scheduled)
   await runOpsAlerts(f.env,scheduled+120000,scheduled)
   await runOpsAlerts(f.env,scheduled+180000,scheduled)
   expect(deliveries).toHaveLength(1)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM ops_alert_outbox').get().n).toBe(1)
  }finally{f.raw.close()}
 })

})
