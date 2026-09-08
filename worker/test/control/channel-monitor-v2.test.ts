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


describe('passive monitor actual request observations',()=>{
 it('counts failed and successful traffic with true TTFT, applies policy and protects user identities',async()=>{
  const f=await clearHarness(false),app=createApp(),now=Date.now()
  const call=async(path:string,method='GET',body?:unknown)=>app.request('/api/v1'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env)
  const data=async(r:Response)=>{expect(r.status,await r.clone().text()).toBe(200);return(await r.json() as any).data}
  try{
   await data(await call('/admin/settings/channel-monitor','PUT',{expected_control_version:0,channel_monitor_enabled:true,channel_monitor_mode:'v2'}))
   const original=await data(await call('/admin/channel-monitor-v2/config'))
   const cfg={...original,health_thresholds:{...original.health_thresholds,minimum_sample:1}}
   await data(await call('/admin/channel-monitor-v2/config','PUT',cfg));expect((await call('/admin/channel-monitor-v2/config','PUT',cfg)).status).toBe(412)
   const insert=f.raw.prepare(`INSERT INTO request_observations(id,request_id,bucket_day,occurred_at_ms,completed_at_ms,lifecycle,user_id,method,request_path,platform,requested_model,status_code,outcome,duration_ms,ttft_ms,input_tokens,output_tokens,cache_read_tokens,error_type,updated_at_ms) VALUES(?,?,20260907,?,?,?,'clear-admin','POST','/v1/chat/completions','openai',?,?,?,?,?,?,?,?,?,?)`)
   insert.run('a'.repeat(32),'req-success',now-1000,now-500,'completed','model-a',200,'completed',500,120,100,20,40,'',now)
   insert.run('b'.repeat(32),'req-failure',now-900,now-400,'failed','model-a',502,'failed',500,null,0,0,0,'upstream_http_error',now)
   insert.run('c'.repeat(32),'req-other-model',now-800,now-300,'completed','model-b',200,'completed',500,200,10,10,0,'',now)
   const snap=await data(await call('/admin/channel-monitor-v2/snapshot?range=90m&model=model-a'))
   expect(snap.metrics).toMatchObject({request_count:2,success_requests:1,error_requests:1,error_rate:.5,cache_rate:.4,ttft:{sample_count:1,p50_ms:120},duration:{sample_count:2,p95_ms:500}})
   expect(snap.health.overall).toBe('critical');expect(snap.coverage.coverage_complete).toBe(true)
   expect((await data(await call('/admin/channel-monitor-v2/dimensions?range=90m'))).models).toHaveLength(2)
   expect((await data(await call('/admin/channel-monitor-v2/models?model=model-a'))).items).toHaveLength(1)
   expect((await data(await call('/admin/channel-monitor-v2/matrix?group_by=platform_model'))).items).toHaveLength(2)
   expect((await data(await call('/admin/channel-monitor-v2/errors'))).items[0].count).toBe(1)
   expect((await data(await call('/admin/channel-monitor-v2/users'))).items[0].email).toBe('clear@example.com')
   const user=await data(await call('/channel-monitor-v2/users?user_id=clear-admin'));expect(JSON.stringify(user)).not.toContain('clear@example.com');expect(user.items[0]).toMatchObject({display_label:'You',is_self:true,can_drilldown:false,metrics:{request_count:0,success_requests:0,error_requests:0,token_count:0,ttft:{sample_count:0}}})
   const publicSnap=await data(await call('/channel-monitor-v2/snapshot'));expect(publicSnap.config.group_ids).toEqual([]);expect(publicSnap.metrics.cache_rate_denominator).toBe(0)
   expect((await data(await call('/channel-monitor-v2/errors'))).items[0]).toMatchObject({count:0})
   expect((await app.request('/api/v1/channel-monitor-v2/snapshot',{},f.env)).status).toBe(401)
   const fresh=await data(await call('/admin/channel-monitor-v2/config'))
   await data(await call('/admin/channel-monitor-v2/config','PUT',{...fresh,platforms:[{platform:'openai',enabled:true,models:['model-b']}]}))
   expect((await data(await call('/admin/channel-monitor-v2/snapshot'))).metrics.request_count).toBe(1)
   await data(await call('/admin/settings/channel-monitor','PUT',{expected_control_version:1,channel_monitor_enabled:false}))
   expect((await call('/channel-monitor-v2/snapshot')).status).toBe(404)
   expect((await call('/admin/channel-monitor-v2/config')).status).toBe(200)
  }finally{f.raw.close()}
 })
})
