import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { normalizeOpsFeature } from '../../src/control/ops-feature-settings'
import { runOpsRetention } from '../../src/control/ops-dashboard'
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


describe('Ops dashboard persisted features and true observation/DO consumption',()=>{
 it('loads every initial dashboard endpoint, preserves real errors/TTFT, caches only non-raw queries and honors feature switches',async()=>{
  const f=await clearHarness(false),app=createApp(),now=Date.now()
  const call=async(path:string,method='GET',body?:unknown)=>app.request('/api/v1/admin/ops'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env)
  const data=async(r:Response)=>{expect(r.status,await r.clone().text()).toBe(200);return(await r.json() as any).data}
  try{
   expect(()=>normalizeOpsFeature({ops_metrics_interval_seconds:0})).toThrow()
   expect(()=>normalizeOpsFeature({ops_query_mode_default:'fake'})).toThrow()
   f.raw.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").run(JSON.stringify({ops_monitoring_enabled:true,ops_realtime_monitoring_enabled:true,ops_query_mode_default:'preagg',ops_metrics_interval_seconds:30}))
   const insert=f.raw.prepare(`INSERT INTO request_observations(id,request_id,bucket_day,occurred_at_ms,completed_at_ms,lifecycle,user_id,method,request_path,platform,requested_model,status_code,outcome,duration_ms,ttft_ms,input_tokens,output_tokens,error_type,updated_at_ms) VALUES(?,?,20260907,?,?,?,'clear-admin','POST','/v1/chat/completions','openai','model-a',?,?,?,?,?,?,?,?)`)
   insert.run('a'.repeat(32),'ops-ok',now-1000,now-500,'completed',200,'completed',500,125,100,20,'',now)
   insert.run('b'.repeat(32),'ops-error',now-900,now-400,'failed',401,'failed',500,null,0,0,'invalid_api_key',now)
   const first=await data(await call('/dashboard/snapshot-v2?time_range=1h'))
   expect(first.overview).toMatchObject({success_count:1,error_count_total:1,error_count_sla:1,request_count_total:2,sla:.5,error_rate:.5,token_consumed:120,ttft:{p99_ms:125},duration:{p99_ms:500}})
   expect(first.throughput_trend.bucket).toBe('30s')
   expect((await data(await call('/dashboard/snapshot-v2?time_range=1h'))).query_source).toBe('cached_aggregate')
   insert.run('c'.repeat(32),'ops-new',now-800,now-300,'completed',200,'completed',500,200,10,10,'',now)
   expect((await data(await call('/dashboard/snapshot-v2?time_range=1h'))).overview.request_count_total).toBe(2)
   expect((await data(await call('/dashboard/snapshot-v2?time_range=1h&mode=raw'))).overview.request_count_total).toBe(3)
   for(const path of ['/advanced-settings','/settings/metric-thresholds','/dashboard/overview','/dashboard/throughput-trend','/dashboard/latency-histogram','/dashboard/error-trend','/dashboard/error-distribution','/dashboard/openai-token-stats','/realtime-traffic'])await data(await call(path))
   const advanced=await data(await call('/advanced-settings'))
   expect((await call('/advanced-settings','PUT',{auto_refresh_enabled:true})).status).toBe(428)
   await data(await call('/advanced-settings','PUT',{...advanced,auto_refresh_enabled:true,auto_refresh_interval_seconds:45,ignore_invalid_api_key_errors:true}))
   expect((await data(await call('/dashboard/overview?mode=raw'))).error_count_sla).toBe(0)
   expect((await data(await call('/advanced-settings'))).auto_refresh_interval_seconds).toBe(45)
   const alertDisplay=await data(await call('/advanced-settings'));await data(await call('/advanced-settings','PUT',{...alertDisplay,display_alert_events:true}))
   const thresholds=await data(await call('/settings/metric-thresholds'));await data(await call('/settings/metric-thresholds','PUT',{...thresholds,sla_percent_min:98}))
   expect((await data(await call('/settings/metric-thresholds'))).sla_percent_min).toBe(98)
   f.raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.ops_realtime_monitoring_enabled',json('false'))").run()
   expect(await data(await call('/realtime-traffic'))).toMatchObject({enabled:false,summary:null})
   expect(await data(await call('/concurrency'))).toMatchObject({enabled:false})
   expect(await data(await call('/user-concurrency'))).toMatchObject({enabled:false})
   expect(await data(await call('/account-availability'))).toMatchObject({enabled:false})
   f.raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.ops_monitoring_enabled',json('false'))").run()
   expect((await call('/dashboard/overview')).status).toBe(404)
   expect((await call('/advanced-settings')).status).toBe(200)
  }finally{f.raw.close()}
 })
 it('uses authoritative pool/admission snapshots for concurrency and observes configured cleanup behavior',async()=>{
  const f=await clearHarness(false),app=createApp(),now=Date.now()
  const call=async(path:string)=>app.request('/api/v1/admin/ops'+path,{headers:{authorization:`Bearer ${f.accessToken}`}},f.env)
  const data=async(r:Response)=>{expect(r.status,await r.clone().text()).toBe(200);return(await r.json() as any).data}
  try{
   f.raw.exec(`INSERT INTO "groups"(id,name,platform,created_at_ms,updated_at_ms) VALUES('ops-group','Ops','openai',1,1);INSERT INTO models(id,platform,public_name,upstream_name,endpoint,created_at_ms,updated_at_ms) VALUES('ops-model','openai','ops-model','ops-model','chat_completions',1,1);INSERT INTO accounts(id,name,platform,credential_ref,max_concurrency,created_at_ms,updated_at_ms) VALUES('ops-account','Ops account','openai','test',5,1,1);INSERT INTO pool_state_registry VALUES('ops-group','ops-model','chat_completions',1,1);`)
   f.env.POOL_STATE={idFromName:(name:string)=>name,get:()=>({fetch:vi.fn(async()=>Response.json({accounts:[{account_id:'ops-account',enabled:true,max_concurrency:5,active_leases:2,cooldown_until_ms:0}],waiting:[{account_id:'ops-account',request_id:'waiting'}]}))})}
   f.env.API_KEY_LIMIT_STATE={idFromName:(name:string)=>name,get:()=>({fetch:vi.fn(async()=>Response.json({active_concurrency:3,leases:[{request_id:'waiting'}]}))})}
   const concurrency=await data(await call('/concurrency'));expect(concurrency.enabled).toBe(true);expect(concurrency.account['ops-group:ops-account']).toMatchObject({current_in_use:2,max_capacity:5,waiting_in_queue:1})
   expect((await data(await call('/user-concurrency'))).user['clear-admin']).toMatchObject({current_in_use:3,waiting_in_queue:1})
   expect((await data(await call('/account-availability'))).account['ops-group:ops-account']).toMatchObject({is_available:true})
   f.env.POOL_STATE={idFromName:(name:string)=>name,get:()=>({fetch:vi.fn(async()=>new Response(null,{status:503}))})}
   expect((await data(await call('/concurrency'))).enabled).toBe(false)
   f.raw.prepare("INSERT INTO ops_dashboard_settings VALUES('advanced',?,1,?)").run(JSON.stringify({data_retention:{cleanup_enabled:false,cleanup_schedule:'* * * * *',error_log_retention_days:1,minute_metrics_retention_days:1,hourly_metrics_retention_days:1}}),now)
   expect(await runOpsRetention(f.env,now)).toMatchObject({skipped:true})
   f.raw.prepare(`INSERT INTO request_observations(id,request_id,bucket_day,occurred_at_ms,completed_at_ms,lifecycle,method,request_path,status_code,outcome,updated_at_ms) VALUES(?, 'old-ops-error',20260905,?,?,'failed','POST','/v1/chat/completions',500,'failed',?)`).run('d'.repeat(32),now-2*86400000,now-2*86400000+100,now-2*86400000+100)
   f.raw.prepare("INSERT INTO ops_dashboard_cache VALUES('minute',?,?,?)").run(JSON.stringify({throughput_trend:{bucket:'60s'}}),now-2*86400000,now-86400000)
   f.raw.prepare("INSERT INTO ops_dashboard_cache VALUES('hour',?,?,?)").run(JSON.stringify({throughput_trend:{bucket:'3600s'}}),now-2*86400000,now-86400000)
   f.raw.prepare("UPDATE ops_dashboard_settings SET config_json=json_set(config_json,'$.data_retention.cleanup_enabled',json('true'),'$.data_retention.hourly_metrics_retention_days',3) WHERE id='advanced'").run()
   expect(await runOpsRetention(f.env,now)).toMatchObject({deleted:1})
   expect(f.raw.prepare('SELECT cache_key FROM ops_dashboard_cache').all()).toEqual([{cache_key:'hour'}])

  }finally{f.raw.close()}
 })
})
