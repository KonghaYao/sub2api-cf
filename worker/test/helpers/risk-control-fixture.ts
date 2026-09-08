import { sqliteUserStateNamespace } from './sqlite-user-state'
import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { normalizeOpsFeature } from '../../src/control/ops-feature-settings'
import { moderateGatewayRequest,consumeRiskModeration,recoverRiskJobs } from '../../src/gateway/risk-moderation'
import { persistRiskResult,deliverRiskNotifications } from '../../src/risk/effects'
import { readRiskConfig } from '../../src/risk/config'
import { cleanupRiskData,projectCyberRiskEvents } from '../../src/risk/maintenance'
import { applyMigrations, createSqliteD1 } from './sqlite-d1'
const PEPPER = 'p'.repeat(32)
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'
export async function clearHarness(enableTotp = true): Promise<any> {
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
    USER_STATE: sqliteUserStateNamespace().namespace, POOL_STATE: {} as DurableObjectNamespace,
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


export function setupRisk(f:any){
 const objects=new Map<string,string>(),queue:any[]=[],mail:any[]=[]
 f.env.OBJECTS={put:vi.fn(async(key:string,value:string)=>{objects.set(key,value)}),get:vi.fn(async(key:string)=>objects.has(key)?{json:async()=>JSON.parse(objects.get(key)!)}:null),delete:vi.fn(async(key:string)=>{objects.delete(key)})}
 f.env.EVENTS_QUEUE={send:vi.fn(async(message:any)=>{queue.push(message)})}
 f.env.EMAIL_DELIVERY={fetch:vi.fn(async(request:Request)=>{mail.push(await request.json());return new Response(null,{status:204})})}
 f.raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.risk_control_enabled',json('true'))").run()
 f.raw.exec(`INSERT INTO users(id,email,display_name,role,status,created_at_ms,updated_at_ms) VALUES('risk-user','risk@example.com','Risk User','user','active',1,1);INSERT INTO "groups"(id,name,platform,created_at_ms,updated_at_ms) VALUES('risk-group','Risk Group','openai',1,1);`)
 const input=(requestId:string,text='ordinary input')=>({request_id:requestId,user_id:'risk-user',api_key_id:'risk-key',group_id:'risk-group',endpoint:'/v1/chat/completions',provider:'openai',model:'test-model',body:{messages:[{role:'user',content:text}]}})
 const app=createApp(),call=(path:string,method='GET',body?:unknown)=>app.request('/api/v1/admin/risk-control'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env)
 const data=async(r:Response)=>{expect(r.status,await r.clone().text()).toBe(200);return(await r.json() as any).data}
 return {objects,queue,mail,input,call,data}
}
