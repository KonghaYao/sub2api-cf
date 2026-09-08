import { authenticateGatewayRequest } from '../../src/gateway/repository'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { Hono } from 'hono'
import { afterEach,expect,it,vi } from 'vitest'
import type { Env } from '../../src/env'
import { replaceAdminUserGroup } from '../../src/control/user-group-replacement'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
afterEach(()=>vi.restoreAllMocks())
function fixture() {
  const { raw,d1 }=createSqliteD1();applyMigrations(raw)
  raw.exec("INSERT INTO users(id,email,display_name,created_at_ms,updated_at_ms) VALUES('user-one','one@test.local','One',1,1),('user-two','two@test.local','Two',1,1)")
  for(const id of ['old','new','other']) raw.prepare('INSERT INTO "groups"(id,name,platform,enabled,group_type,is_exclusive,created_at_ms,updated_at_ms) VALUES (?,?,?,1,?,1,1,1)').run(id,id,'openai','standard')
  for(const [id,user,group,enabled,revoked] of [['active','user-one','old',1,null],['paused','user-one','old',0,null],['deleted','user-one','old',0,1],['unrelated','user-one','other',1,null],['other-user','user-two','old',1,null]]) {
    raw.prepare('INSERT INTO api_keys(id,user_id,key_hash,key_prefix,name,enabled,revoked_at_ms,group_id,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,1,1)')
      .run(id,user,String(id).padEnd(64,'a'),'sk-test',id,enabled,revoked,group)
  }
  raw.exec("INSERT OR IGNORE INTO user_group_permissions(user_id,group_id,created_at_ms) VALUES ('user-one','old',1),('user-one','other',1)")
  const env={ DB:d1,API_KEY_PEPPER:'p'.repeat(32) } as Env
  const app=new Hono<{ Bindings:Env }>().post('/users/:id/replace-group',replaceAdminUserGroup)
  const request=(old='old',next='new',user='user-one')=>app.request(`/users/${user}/replace-group`,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({old_group_id:old,new_group_id:next}) },env)
  return {raw,env,request}
}
it('atomically replaces access and migrates live keys while preserving pause, quotas and other users',async()=>{
  const t=fixture()
  try {
    t.raw.exec("UPDATE api_keys SET quota_used_micros=123 WHERE id='paused'")
    t.raw.prepare("UPDATE api_keys SET key_hash=? WHERE id='active'").run(await apiKeyDigest('sk-live-migration',t.env.API_KEY_PEPPER!))
    const gatewayRequest = new Request('https://worker.test/v1/responses',{ headers:{ authorization:'Bearer sk-live-migration' } })
    const originalPrincipal = await authenticateGatewayRequest(gatewayRequest,t.env)
    expect(originalPrincipal.group_id).toBe('old')
    const before=t.raw.prepare('SELECT * FROM api_keys ORDER BY id').all()
    const response=await t.request();expect(response.status,await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ data:{migrated_keys:2} })
    const migratedPrincipal = await authenticateGatewayRequest(gatewayRequest,t.env)
    expect(migratedPrincipal.group_id).toBe('new')
    expect(migratedPrincipal.api_key_auth_version).toBe(originalPrincipal.api_key_auth_version+1)
    const keys=t.raw.prepare('SELECT * FROM api_keys ORDER BY id').all()
    for(const old of before) {
      const next=keys.find((k:any)=>k.id===old.id)
      if(['deleted','other-user'].includes(old.id)) expect(next).toEqual(old)
      else {
        expect(next.auth_version).toBe(old.auth_version+1)
        expect(next.enabled).toBe(old.enabled);expect(next.quota_used_micros).toBe(old.quota_used_micros)
        expect(next.group_id).toBe(old.id==='unrelated'?'other':'new')
      }
    }
    expect(t.raw.prepare("SELECT group_id FROM user_group_permissions WHERE user_id='user-one' ORDER BY group_id").all()).toEqual([{group_id:'new'},{group_id:'other'}])
    expect(await (await t.request()).json()).toMatchObject({data:{migrated_keys:0}})
  } finally {t.raw.close()}
})
it.each(['same','missing-group','missing-user','inactive','public','subscription','group-race','user-race','write-failure'])('rejects %s without partial migration',async scenario=>{
  const t=fixture()
  try {
    if(scenario==='inactive') t.raw.exec("UPDATE \"groups\" SET enabled=0 WHERE id='new'")
    if(scenario==='public') t.raw.exec("UPDATE \"groups\" SET is_exclusive=0 WHERE id='new'")
    if(scenario==='subscription') t.raw.exec("UPDATE \"groups\" SET group_type='subscription' WHERE id='new'")
    const before=t.raw.prepare('SELECT * FROM api_keys ORDER BY id').all()
    const permissions=t.raw.prepare('SELECT * FROM user_group_permissions ORDER BY user_id,group_id').all()
    if(scenario==='write-failure') t.raw.exec("CREATE TRIGGER reject_key_move BEFORE UPDATE OF group_id ON api_keys BEGIN SELECT RAISE(ABORT,'FOREIGN KEY constraint failed'); END")
    if(scenario.endsWith('-race')) {
      const batch=t.env.DB.batch.bind(t.env.DB)
      vi.spyOn(t.env.DB,'batch').mockImplementation(async statements=>{
        t.raw.exec(scenario==='group-race'?"UPDATE \"groups\" SET enabled=0 WHERE id='new'":"UPDATE users SET control_version=control_version+1 WHERE id='user-one'")
        return batch(statements)
      })
    }
    const response=await t.request('old',scenario==='same'?'old':scenario==='missing-group'?'missing':'new',scenario==='missing-user'?'missing':'user-one')
    expect(response.status).toBe(scenario.startsWith('missing-')?404:scenario.endsWith('-race')||scenario==='write-failure'?409:400)
    expect(t.raw.prepare('SELECT * FROM api_keys ORDER BY id').all()).toEqual(before)
    expect(t.raw.prepare('SELECT * FROM user_group_permissions ORDER BY user_id,group_id').all()).toEqual(permissions)
  } finally {t.raw.close()}
})
