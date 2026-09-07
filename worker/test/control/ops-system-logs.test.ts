import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { normalizeOpsFeature } from '../../src/control/ops-feature-settings'
import { consumeOpsSystemLog, runOpsSystemLogRetention } from '../../src/control/ops-system-logs'
import { recordRequestStart, recordRequestOutcome } from '../../src/observability/recorder'
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


describe('Worker system diagnostics actual recording and settings consumption',()=>{
 it('captures outcomes through queue, filters/samples/redacts logs, exposes real health and cleans only diagnostics',async()=>{
  const f=await clearHarness(false),app=createApp(),queue:any[]=[],now=Date.now()
  f.env.EVENTS_QUEUE={send:vi.fn(async(message:any)=>{queue.push(message)})}
  const call=(path:string,method='GET',body?:unknown)=>app.request('/api/v1/admin/ops'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env)
  const data=async(r:Response)=>{expect(r.status,await r.clone().text()).toBe(200);return(await r.json() as any).data}
  const record=async(id:string,status:number)=>{const handle=await recordRequestStart(f.env,{requestId:id,method:'POST',requestPath:'/v1/chat/completions',platform:'openai',requestedModel:'composer-2.5',occurredAtMs:now-100});expect(handle).not.toBeNull();expect(await recordRequestOutcome(f.env,handle!,{lifecycle:status===200?'completed':'failed',statusCode:status,completedAtMs:now,error:status===200?undefined:{type:'upstream_error',message:'Authorization: Bearer secret-do-not-log',phase:'upstream',owner:'provider',source:'upstream_http',severity:'error'}})).toBe(true);return queue.at(-1)}
  try{
   const config=await data(await call('/runtime/logging'));expect(config.source).toBe('worker_gateway_diagnostics')
   expect((await call('/runtime/logging','PUT',{...config,control_version:undefined,level:'error'})).status).toBe(428)
   const saved=await data(await call('/runtime/logging','PUT',{...config,level:'error',caller:true,stacktrace_level:'error',enable_sampling:true,sampling_initial:1,sampling_thereafter:2}))
   const ok=await record('log-ok',200);await consumeOpsSystemLog(ok,f.env)
   const error=await record('log-error',500);await consumeOpsSystemLog(error,f.env);await consumeOpsSystemLog(error,f.env)
   await consumeOpsSystemLog(await record('log-error-two',500),f.env)
   const page=await data(await call('/system-logs?level=error&model=composer-2.5&page_size=1'))
   expect(page.total).toBe(1);expect(page.items[0].request_id).toBe('log-error');expect(JSON.stringify(page)).not.toContain('secret-do-not-log');expect(page.items[0].extra.caller).toContain('recordRequestOutcome')
   const health=await data(await call('/system-logs/health'));expect(health).toMatchObject({written_count:1,dropped_count:2,queue_depth:null})
   expect((await data(await call('/system-logs?q=does-not-exist'))).total).toBe(0)
   expect((await call('/runtime/logging','PUT',config)).status).toBe(412)
   await data(await call('/runtime/logging/reset','POST',{expected_control_version:saved.control_version}))
   const res=await data(await call('/system-logs/cleanup','POST',{request_id:'log-error'}));expect(res.deleted).toBe(1)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM request_observations').get().n).toBe(3)
   await consumeOpsSystemLog(await record('retained-log',200),f.env)
   f.raw.prepare('UPDATE ops_system_logs SET created_at_ms=?').run(now-31*86400000)
   await runOpsSystemLogRetention(f.env,now)
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM ops_system_logs').get().n).toBe(0)
  }finally{f.raw.close()}
 })
})
