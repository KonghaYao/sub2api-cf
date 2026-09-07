import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { uploadConfiguredImage } from '../../src/control/backup-storage'
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


describe('backup object storage real signed consumption',()=>{
 it('persists encrypted config with CAS, verifies write/read/delete and uploads images with saved credentials',async()=>{
  const f=await clearHarness(false),app=createApp(),objects=new Map<string,Uint8Array>(),requests:Array<{method:string;headers:Headers}>=[]
  vi.stubGlobal('fetch',vi.fn(async(input:Request)=>{const request=input.clone();requests.push(request);const path=new URL(request.url).pathname;if(request.method==='PUT'){objects.set(path,new Uint8Array(await request.arrayBuffer()));return new Response(null,{status:200})}if(request.method==='GET')return objects.has(path)?new Response(objects.get(path) as BodyInit):new Response(null,{status:404});objects.delete(path);return new Response(null,{status:204})}))
  const call=async(path:string,method='GET',body?:unknown)=>app.request('/api/v1/admin/backups'+path,{method,headers:{authorization:`Bearer ${f.accessToken}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env)
  const data=async(r:Response)=>{expect(r.status,await r.clone().text()).toBe(200);return(await r.json() as any).data}
  try{
   expect(await data(await call('/s3-config'))).toMatchObject({control_version:0,secret_access_key:''})
   const config={endpoint:'https://storage.example.test',region:'auto',bucket:'test-bucket',access_key_id:'TESTACCESS',secret_access_key:'only-test-secret',prefix:'backups/',force_path_style:true}
   expect((await call('/s3-config','PUT',config)).status).toBe(428)
   expect(await data(await call('/s3-config','PUT',{...config,expected_control_version:0}))).toMatchObject({control_version:1,secret_configured:true})
   expect(JSON.stringify(f.raw.prepare('SELECT * FROM object_storage_settings').all())).not.toContain(config.secret_access_key)
   expect(JSON.stringify(await data(await call('/s3-config')))).not.toContain(config.secret_access_key)
   expect((await call('/s3-config','PUT',{...config,expected_control_version:0})).status).toBe(412)
   await data(await call('/s3-config','PUT',{...config,secret_access_key:'',expected_control_version:1}))
   expect(await data(await call('/s3-config/test','POST',{...config,secret_access_key:''}))).toMatchObject({ok:true})
   expect(objects.size).toBe(0);expect(requests.map(r=>r.method)).toEqual(['PUT','GET','DELETE'])
   expect(requests[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=TESTACCESS\//)
   expect(requests[0].headers.get('authorization')).not.toContain(config.secret_access_key)
   const image={enabled:true,reuse_backup_s3:true,bucket:'image-bucket',prefix:'images/',public_base_url:'',presign_expiry_hours:24,max_download_bytes:1024,expected_control_version:0}
   await data(await call('/image-storage','PUT',image))
   const bytes=new Uint8Array([1,2,3]);const uploaded=await uploadConfiguredImage(f.env,'image-task',0,bytes,'image/png')
   expect(uploaded).not.toBeNull();expect(objects.get('/image-bucket/images/image-task/0.png')).toEqual(bytes)
   expect(uploaded!.url).toContain('X-Amz-Signature=');expect(uploaded!.url).toContain('X-Amz-Expires=86400');expect(uploaded!.url).not.toContain(config.secret_access_key)
   await uploaded!.cleanup();expect(objects.size).toBe(0)
   await expect(uploadConfiguredImage(f.env,'image-task',0,new Uint8Array(1025),'image/png')).rejects.toThrow('size limit')
   expect(await data(await call('/schedule'))).toMatchObject({enabled:false})
   expect((await call('/schedule','PUT',{enabled:true,cron_expr:'0 2 * * *',retain_days:14,retain_count:10,expected_control_version:0})).status).toBe(503)
   expect((await call('','POST',{})).status).toBe(503);expect((await data(await call(''))).items).toEqual([])
  }finally{vi.unstubAllGlobals();f.raw.close()}
 })
})
