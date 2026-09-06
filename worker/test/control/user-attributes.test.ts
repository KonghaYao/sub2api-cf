import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)
describe('admin user attributes', () => {
  let env: Env; let authorization: string; let raw: any
  beforeEach(async () => {
    const db=createSqliteD1();raw=db.raw;applyMigrations(raw);const now=Date.now();const access=createOpaqueToken('access');const refresh=createOpaqueToken('refresh')
    raw.prepare(`INSERT INTO users (id,email,display_name,role,status,auth_version,created_at_ms,updated_at_ms) VALUES ('admin-1','admin@test','Admin','admin','active',1,?,?),('018f3b79-0000-7000-8000-000000000001','user@test','User','user','active',1,?,?)`).run(now,now,now,now)
    raw.prepare(`INSERT INTO user_sessions (id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms) VALUES ('s','f','admin-1',1,?,?,?, ?,?)`).run(await tokenDigest(access,PEPPER,'access'),await tokenDigest(refresh,PEPPER,'refresh'),now,now+60000,now+120000)
    authorization=`Bearer ${access}`;env={APP_VERSION:'test',ENVIRONMENT:'test',API_KEY_PEPPER:PEPPER,CREDENTIALS_MASTER_KEY:'m'.repeat(32),ASSETS:{fetch:async()=>new Response('')} as any,DB:db.d1,CONFIG_KV:{} as any,OBJECTS:{} as any,EVENTS_QUEUE:{} as any,USER_STATE:{} as any,SUBSCRIPTION_STATE:{} as any,POOL_STATE:{} as any}
  })
  const request=(path:string,init:RequestInit={})=>createApp().request(path,{...init,headers:{authorization,...init.headers}},env)
  let requestNo=0
  const mutation=(path:string,body:unknown,version?:number)=>request(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':`attribute-test-key-${++requestNo}`,...(version===undefined?{}:{'if-match':String(version)})},body:JSON.stringify(body)})

  it('creates definitions, rejects duplicate keys and validates selectable values for UUID users', async () => {
    const create=await mutation('/api/v1/admin/user-attributes',{key:'department',name:'Department',type:'select',options:[{value:'eng',label:'Engineering'}],required:true})
    expect(create.status).toBe(201); const definition=(await create.json() as any).data;expect(definition.id).toBeTypeOf('number')
    const duplicate=await mutation('/api/v1/admin/user-attributes',{key:'department',name:'Again',type:'text'})
    expect(duplicate.status).toBe(409)
    const missingHeaders=await request(`/api/v1/admin/users/018f3b79-0000-7000-8000-000000000001/attributes`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({values:{[definition.id]:'eng'}})})
    expect(missingHeaders.status).toBe(400)
    const invalid=await request(`/api/v1/admin/users/018f3b79-0000-7000-8000-000000000001/attributes`,{method:'PUT',headers:{'content-type':'application/json','idempotency-key':'values-test-key','if-match':'0'},body:JSON.stringify({values:{[definition.id]:'sales'}})})
    expect(invalid.status).toBe(400)
    const updated=await request(`/api/v1/admin/users/018f3b79-0000-7000-8000-000000000001/attributes`,{method:'PUT',headers:{'content-type':'application/json','idempotency-key':'values-ok-key','if-match':'0'},body:JSON.stringify({values:{[definition.id]:'eng'}})})
    expect(updated.status).toBe(200)
    const values=await request('/api/v1/admin/users/018f3b79-0000-7000-8000-000000000001/attributes');expect((await values.json() as any).data).toMatchObject([{attribute_id:definition.id,value:'eng'}])
  })
  it('enforces bounded batch requests and permission-protected routes', async () => {
    const tooMany=await request('/api/v1/admin/user-attributes/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_ids:Array.from({length:101},(_,i)=>String(i))})});expect(tooMany.status).toBe(400)
    const denied=await createApp().request('/api/v1/admin/user-attributes',{},env);expect(denied.status).toBe(401)
  })
})
