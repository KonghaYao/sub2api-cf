import { executeAccountCreate } from '../../src/control/accounts'
import { decryptCredential } from '../../src/gateway/crypto'
import { credentialAad } from '../../src/gateway/repository'
import { Hono } from 'hono'
import { afterEach,expect,it,vi } from 'vitest'
import type { Env } from '../../src/env'
import { importAdminCodexSession } from '../../src/control/codex-session-import'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
afterEach(()=>vi.restoreAllMocks())
function fixture() {
  const {raw,d1}=createSqliteD1();applyMigrations(raw)
  const env={DB:d1,ENVIRONMENT:'test',CREDENTIALS_MASTER_KEY:'m'.repeat(32)} as Env
  const app=new Hono<{Bindings:Env}>().post('/import',importAdminCodexSession)
  const request=(body:Record<string,unknown>,key='test-import')=>app.request('/import',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)},env)
  const payload={name:'Imported',content:JSON.stringify({access_token:'test-access',refresh_token:'test-refresh',email:'one@test.local'})}
  return {raw,env,request,payload}
}
it('creates encrypted OAuth accounts, replays results and resumes committed entries without rewriting credentials',async()=>{
  const t=fixture()
  try {
    const response=await t.request(t.payload);expect(response.status,await response.clone().text()).toBe(200)
    const result=await response.json() as any;expect(result).toMatchObject({data:{created:1,failed:0}})
    const accounts=t.raw.prepare('SELECT * FROM accounts').all(),secrets=t.raw.prepare('SELECT * FROM account_secrets').all()
    expect(accounts).toHaveLength(1);expect(JSON.stringify(secrets)).not.toContain('test-access')
    expect(await (await t.request(t.payload)).json()).toEqual(result)
    t.raw.exec('UPDATE codex_import_operations SET result_json=NULL')
    expect(await (await t.request(t.payload)).json()).toMatchObject({data:{created:1,updated:0,failed:0}})
    expect(t.raw.prepare('SELECT * FROM accounts').all()).toEqual(accounts)
    expect(t.raw.prepare('SELECT * FROM account_secrets').all()).toEqual(secrets)
    expect(JSON.stringify(t.raw.prepare('SELECT * FROM codex_import_operations').all())).not.toContain('test-refresh')
    expect((await t.request({...t.payload,name:'Changed'})).status).toBe(409)
  } finally {t.raw.close()}
})
it('updates a matching identity once, handles duplicates and preserves partial failures',async()=>{
  const t=fixture()
  try {
    expect(await (await t.request(t.payload)).json()).toMatchObject({data:{created:1}})
    const content=JSON.stringify([{access_token:'rotated-access',refresh_token:'rotated-refresh',email:'one@test.local'}, {access_token:'rotated-access',refresh_token:'rotated-refresh',email:'one@test.local'}, {}])
    const payload={content,name:'Do not rename'}
    expect(await (await t.request(payload,'update')).json()).toMatchObject({data:{created:0,updated:1,skipped:1,failed:1}})
    const account=t.raw.prepare('SELECT name,control_version FROM accounts').get()
    expect(account).toMatchObject({name:'Imported',control_version:1})
    expect(t.raw.prepare('SELECT key_version FROM account_secrets').get()).toMatchObject({key_version:2})
    t.raw.exec("UPDATE codex_import_operations SET result_json=NULL WHERE id IN(SELECT operation_id FROM codex_import_items WHERE action='updated')")
    expect(await (await t.request(payload,'update')).json()).toMatchObject({data:{updated:1,skipped:1,failed:1}})
    expect(t.raw.prepare('SELECT key_version FROM account_secrets').get()).toMatchObject({key_version:2})
  } finally {t.raw.close()}
})
it('rolls back the entire account write if its import receipt cannot commit',async()=>{
  const t=fixture()
  try {
    t.raw.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON codex_import_items BEGIN SELECT RAISE(ABORT,'receipt failure'); END")
    expect(await (await t.request(t.payload)).json()).toMatchObject({data:{created:0,failed:1}})
    expect(t.raw.prepare('SELECT * FROM accounts').all()).toHaveLength(0)
    expect(t.raw.prepare('SELECT * FROM account_secrets').all()).toHaveLength(0)
    expect(t.raw.prepare('SELECT * FROM control_idempotency').all()).toHaveLength(0)
  } finally {t.raw.close()}
})
it('rejects a concurrent owner and fences an expired lease before writing',async()=>{
  const t=fixture()
  try {
    const batch=t.env.DB.batch.bind(t.env.DB)
    let concurrentStatus=0
    vi.spyOn(t.env.DB,'batch').mockImplementation(async statements=>{
      concurrentStatus=(await t.request(t.payload)).status
      t.raw.exec('UPDATE codex_import_operations SET lease_until_ms=0')
      return batch(statements)
    })
    expect((await t.request(t.payload)).status).toBe(409)
    expect(concurrentStatus).toBe(409)
    expect(t.raw.prepare('SELECT * FROM accounts').all()).toHaveLength(0)
    expect(t.raw.prepare('SELECT result_json FROM codex_import_operations').get()).toMatchObject({result_json:null})
  } finally {t.raw.close()}
})
it('accepts nullable optional metadata and rejects invalid top-level input before creating an operation',async()=>{
  const t=fixture()
  try {
    expect((await t.request({content:'',concurrency:-1})).status).toBe(400)
    expect(t.raw.prepare('SELECT * FROM codex_import_operations').all()).toHaveLength(0)
    expect(await (await t.request({...t.payload,extra:null,credential_extras:null})).json()).toMatchObject({data:{created:1,failed:0}})
  } finally {t.raw.close()}
})
it('recovers an update committed before its database response is lost',async()=>{
  const t=fixture()
  try {
    expect(await (await t.request(t.payload)).json()).toMatchObject({data:{created:1}})
    const payload={name:'Still original',content:JSON.stringify({access_token:'second-access',refresh_token:'second-refresh',email:'one@test.local'})}
    const batch=t.env.DB.batch.bind(t.env.DB)
    const spy=vi.spyOn(t.env.DB,'batch').mockImplementationOnce(async statements=>{
      await batch(statements)
      throw new Error('Database response lost after commit')
    })
    expect((await t.request(payload,'recover-update')).status).toBe(409)
    expect(t.raw.prepare('SELECT key_version FROM account_secrets').get()).toMatchObject({key_version:2})
    spy.mockRestore()
    expect(await (await t.request(payload,'recover-update')).json()).toMatchObject({data:{updated:1,created:0,failed:0}})
    expect(t.raw.prepare('SELECT key_version FROM account_secrets').get()).toMatchObject({key_version:2})
  } finally {t.raw.close()}
})
it('does not overwrite a concurrently edited account or commit its operation receipt',async()=>{
  const t=fixture()
  try {
    expect(await (await t.request(t.payload)).json()).toMatchObject({data:{created:1}})
    const batch=t.env.DB.batch.bind(t.env.DB)
    vi.spyOn(t.env.DB,'batch').mockImplementationOnce(async statements=>{
      t.raw.exec("UPDATE accounts SET name='Admin edited',control_version=control_version+1")
      return batch(statements)
    })
    const payload={content:JSON.stringify({access_token:'third-access',refresh_token:'third-refresh',email:'one@test.local'})}
    expect(await (await t.request(payload,'concurrent-update')).json()).toMatchObject({data:{failed:1,updated:0}})
    expect(t.raw.prepare('SELECT name,control_version FROM accounts').get()).toMatchObject({name:'Admin edited',control_version:1})
    expect(t.raw.prepare('SELECT key_version FROM account_secrets').get()).toMatchObject({key_version:1})
    expect(t.raw.prepare("SELECT * FROM codex_import_items WHERE action='updated'").all()).toHaveLength(0)
  } finally {t.raw.close()}
})
it('binds the original active platform default only on creation unless explicitly skipped',async()=>{
  const t=fixture()
  try {
    t.raw.exec("INSERT INTO \"groups\"(id,name,platform,enabled,created_at_ms,updated_at_ms) VALUES('default-group','openai-default','openai',1,1,1)")
    expect(await (await t.request(t.payload)).json()).toMatchObject({data:{created:1,failed:0}})
    expect(t.raw.prepare('SELECT group_id FROM account_groups').all()).toEqual([{group_id:'default-group'}])
    const payload={...t.payload,name:'Unbound import',update_existing:false,skip_default_group_bind:true,proxy_id:0}
    expect(await (await t.request(payload,'unbound')).json()).toMatchObject({data:{created:1,failed:0}})
    expect(t.raw.prepare('SELECT group_id FROM account_groups').all()).toHaveLength(1)
    expect(t.raw.prepare('SELECT id FROM accounts').all()).toHaveLength(2)
  } finally {t.raw.close()}
})

it('removes stale client and ID tokens from access-only accounts while keeping renewable credentials',async()=>{
  for(const renewable of [false,true]) {
    const t=fixture()
    try {
      const created=await executeAccountCreate(t.env,{name:'Existing session',platform:'openai',type:'oauth',
        credentials:{access_token:'same-access',client_id:'old-client',id_token:'old-id',...(renewable?{refresh_token:'keep-refresh'}:{})}},'existing-session',true)
      const response=await t.request({content:JSON.stringify({access_token:'same-access',expires_at:'2099-01-01T00:00:00Z'})})
      expect(await response.json()).toMatchObject({data:{updated:1,failed:0}})
      const secret=t.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(created.account.id) as any
      const credentials=await decryptCredential(secret.nonce_b64,secret.ciphertext_b64,t.env.CREDENTIALS_MASTER_KEY!,
        credentialAad(t.env.ENVIRONMENT,created.account.id,secret.id,secret.key_version)) as unknown as Record<string,unknown>
      expect(credentials).not.toHaveProperty('id_token')
      if(renewable) expect(credentials).toMatchObject({refresh_token:'keep-refresh',client_id:'old-client'})
      else {expect(credentials).not.toHaveProperty('refresh_token');expect(credentials).not.toHaveProperty('client_id')}
      expect(credentials.api_key).toBe('same-access')
    } finally {t.raw.close()}
  }
})

it('checks lease time at database execution, including a batch queued before expiry',async()=>{
  const t=fixture()
  try {
    let databaseTime=Date.now()
    t.raw.function('unixepoch',{varargs:true},()=>databaseTime/1000)
    const batch=t.env.DB.batch.bind(t.env.DB)
    const spy=vi.spyOn(t.env.DB,'batch').mockImplementationOnce(async statements=>{
      // Prepared with a valid lease; execution is delayed beyond the deadline.
      databaseTime+=300001
      return batch(statements)
    })
    expect((await t.request(t.payload)).status).toBe(409)
    expect(t.raw.prepare('SELECT * FROM accounts').all()).toHaveLength(0)
    expect(t.raw.prepare('SELECT * FROM account_secrets').all()).toHaveLength(0)
    expect(t.raw.prepare('SELECT * FROM codex_import_items').all()).toHaveLength(0)
    spy.mockRestore()
    expect(await (await t.request(t.payload)).json()).toMatchObject({data:{created:1,failed:0}})
  } finally {t.raw.close()}
})

it('imports and updates original Agent Identity sessions without synthesizing OAuth tokens',async()=>{
  const t=fixture()
  try {
    const agent={auth_mode:'agentIdentity',agent_runtime_id:'import-runtime',agent_private_key:'MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f',account_id:'agent-workspace',chatgpt_user_id:'agent-user',task_id:'first-task'}
    const first=await (await t.request({name:'Agent import',content:JSON.stringify(agent)},'agent-import')).json() as any
    expect(first).toMatchObject({data:{created:1,updated:0,failed:0}})
    expect(await (await t.request({content:JSON.stringify({...agent,task_id:'second-task'})},'agent-update')).json()).toMatchObject({data:{created:0,updated:1,failed:0}})
    const account=t.raw.prepare('SELECT ui_config_json FROM accounts WHERE id=?').get(first.data.items[0].account_id)
    const ui=JSON.parse(account.ui_config_json)
    expect(ui.credentials).toMatchObject({auth_mode:'agentIdentity',task_id:'second-task'})
    expect(ui.credentials).not.toHaveProperty('agent_private_key')
    expect(ui.credentials_status.has_api_key).toBe(false)
    expect(ui.credentials_status.has_agent_private_key).toBe(true)
    expect(t.raw.prepare('SELECT key_version FROM account_secrets').get()).toMatchObject({key_version:2})
  } finally {t.raw.close()}
})
