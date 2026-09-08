import { initializeAccountNow } from '../../src/control/account-initialization'
import { setAdminAccountPrivacy } from '../../src/control/accounts'
import { Hono } from 'hono'
import { testAdminAccount } from '../../src/control/accounts'
import { resolveAccountRequestAuthentication } from '../../src/control/account-request-authentication'
import { buildAccountProviderRequest } from '../../src/gateway/account-provider-request'
import type { AccountCredential } from '../../src/gateway/types'
import { afterEach,expect,it,vi } from 'vitest'
import type { Env } from '../../src/env'
import { executeAccountCreate,executeAccountUpdate } from '../../src/control/accounts'
import { ensureAccountAgentTask } from '../../src/control/account-agent-task'
import { decryptCredentialPayload,encryptCredential } from '../../src/gateway/crypto'
import { credentialAad } from '../../src/gateway/repository'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
const privateKey='MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f'
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
async function fixture(task='old-task') {
  const {raw,d1}=createSqliteD1();applyMigrations(raw)
  const env={DB:d1,ENVIRONMENT:'test',CREDENTIALS_MASTER_KEY:'m'.repeat(32)} as Env
  const {account}=await executeAccountCreate(env,{name:'Agent persistence fixture',platform:'openai',type:'oauth',credentials:{
    chatgpt_account_id:'workspace',chatgpt_user_id:'user',auth_mode:'agentIdentity',agent_runtime_id:'runtime',agent_private_key:privateKey,task_id:task}},'agent-fixture',true)
  return {raw,env,id:account.id}
}
it('registers and encrypts a missing task without overwriting scheduling settings',async()=>{
  const t=await fixture('')
  try {
    const fetcher=vi.fn().mockResolvedValue(Response.json({task_id:'new-task'}));vi.stubGlobal('fetch',fetcher)
    t.raw.exec("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.schedulable',0)")
    expect(await ensureAccountAgentTask(t.env,t.id)).toMatchObject({task_id:'new-task'})
    expect(await ensureAccountAgentTask(t.env,t.id)).toMatchObject({task_id:'new-task'})
    expect(fetcher).toHaveBeenCalledTimes(1)
    const row=t.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(t.id)
    expect(row.key_version).toBe(2);expect(row.ciphertext_b64).not.toContain('new-task')
    const stored=await decryptCredentialPayload(row.nonce_b64,row.ciphertext_b64,t.env.CREDENTIALS_MASTER_KEY!,credentialAad(t.env.ENVIRONMENT,t.id,row.id,row.key_version))
    expect(stored).toMatchObject({task_id:'new-task',agent_private_key:privateKey})
    expect(stored).not.toHaveProperty('api_key')
    expect(stored).not.toHaveProperty('access_token')
    const account=t.raw.prepare('SELECT control_version,ui_config_json FROM accounts WHERE id=?').get(t.id)
    expect(account.control_version).toBe(0);expect(JSON.parse(account.ui_config_json).schedulable).toBe(0)
    expect(JSON.parse(account.ui_config_json).credentials.task_id).toBe('new-task')
    expect(account.ui_config_json).not.toContain(privateKey)
  } finally {t.raw.close()}
})
it('shares a recovered task between requests with the same failed-task snapshot',async()=>{
  const t=await fixture()
  try {
    let started!:()=>void,finish!:(response:Response)=>void
    const fetching=new Promise<void>(resolve=>{started=resolve})
    const fetcher=vi.fn().mockImplementation(()=>{started();return new Promise<Response>(resolve=>{finish=resolve})});vi.stubGlobal('fetch',fetcher)
    const first=ensureAccountAgentTask(t.env,t.id,'old-task');await fetching
    const second=ensureAccountAgentTask(t.env,t.id,'old-task')
    finish(Response.json({task_id:'recovered-task'}))
    for(const result of await Promise.all([first,second])) expect(result).toMatchObject({task_id:'recovered-task'})
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally {t.raw.close()}
})
it.each(['admin-edit','key-edit','lease-expired'])('discards registration after %s',async scenario=>{
  const t=await fixture()
  try {
    const before=t.raw.prepare('SELECT * FROM account_secrets').get()
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{
      if(scenario==='admin-edit') t.raw.exec("UPDATE accounts SET name='Admin changed',control_version=control_version+1")
      if(scenario==='key-edit') t.raw.exec('UPDATE account_secrets SET key_version=key_version+1')
      if(scenario==='lease-expired') t.raw.exec('UPDATE account_agent_task_registration SET lease_until_ms=0')
      return Response.json({task_id:'must-not-save'})
    }))
    await expect(ensureAccountAgentTask(t.env,t.id,'old-task')).rejects.toMatchObject({code:'agent_task_persistence_conflict'})
    const after=t.raw.prepare('SELECT * FROM account_secrets').get()
    expect(after.ciphertext_b64).toBe(before.ciphertext_b64)
    expect(after.key_version).toBe(before.key_version+(scenario==='key-edit'?1:0))
  } finally {t.raw.close()}
})

it('materializes a key-only account into a Codex request with AgentAssertion authentication',async()=>{
  const t=await fixture()
  try {
    vi.stubGlobal('fetch',vi.fn())
    const secret=t.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(t.id)
    const account={account_id:t.id,platform:'openai',credential_kind:'oauth',secret_id:secret.id,key_version:secret.key_version,
      nonce_b64:secret.nonce_b64,ciphertext_b64:secret.ciphertext_b64,base_url:'https://api.openai.com',protocol:'openai',auth_scheme:'bearer',provider_config:{}} as AccountCredential
    const auth=await resolveAccountRequestAuthentication(t.env,account)
    const plan=buildAccountProviderRequest({account,...auth,operation:'responses',model:'gpt-5.4',body:{input:'test'}})
    expect(plan.headers.get('authorization')).toMatch(/^AgentAssertion /)
    expect(plan.headers.get('authorization')).not.toContain('Bearer')
    expect(plan.url).toContain('chatgpt.com')
    expect(JSON.stringify(plan.body)).not.toContain(privateKey)
    expect(JSON.stringify(plan.body)).not.toContain('AgentAssertion')
    expect(fetch).not.toHaveBeenCalled()
  } finally {t.raw.close()}
})

it('updates the displayed task atomically while retaining newer background account observations',async()=>{
  const t=await fixture()
  try {
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{
      t.raw.exec("UPDATE accounts SET config_version=config_version+1,ui_config_json=json_set(ui_config_json,'$.extra.latest_observation','keep-new','$.priority',77)")
      return Response.json({task_id:'new-visible-task'})
    }))
    await ensureAccountAgentTask(t.env,t.id,'old-task')
    const row=t.raw.prepare('SELECT ui_config_json,control_version FROM accounts WHERE id=?').get(t.id)
    expect(JSON.parse(row.ui_config_json)).toMatchObject({credentials:{task_id:'new-visible-task'},extra:{latest_observation:'keep-new'},priority:77})
    expect(row.control_version).toBe(0)
  } finally {t.raw.close()}
})
it('creates an original Agent Identity account without a token alias and rejects invalid keys before writing',async()=>{
  const {raw,d1}=createSqliteD1();applyMigrations(raw)
  const env={DB:d1,ENVIRONMENT:'test',CREDENTIALS_MASTER_KEY:'m'.repeat(32)} as Env
  const credentials={auth_mode:'agentIdentity',agent_runtime_id:'runtime',agent_private_key:privateKey,chatgpt_account_id:'workspace',chatgpt_user_id:'user',task_id:'task'}
  try {
    const {account}=await executeAccountCreate(env,{name:'Real Agent account',platform:'openai',type:'oauth',credentials},'real-agent',true)
    const secret=raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(account.id)
    const decoded=await decryptCredentialPayload(secret.nonce_b64,secret.ciphertext_b64,env.CREDENTIALS_MASTER_KEY!,credentialAad(env.ENVIRONMENT,account.id,secret.id,secret.key_version))
    expect(decoded).toMatchObject(credentials);expect(decoded).not.toHaveProperty('api_key')
    expect(JSON.stringify(account)).not.toContain(privateKey)
    await expect(executeAccountCreate(env,{name:'Bad Agent',platform:'openai',type:'oauth',credentials:{...credentials,agent_private_key:'invalid-private-key'}},'bad-agent',true)).rejects.toMatchObject({code:'invalid_agent_identity'})
    expect(raw.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toMatchObject({count:1})
  } finally {raw.close()}
})

it('updates Agent metadata and task while preserving an omitted private key and rejecting invalid replacements',async()=>{
  const t=await fixture()
  try {
    const updated=await executeAccountUpdate(t.env,t.id,{credentials:{task_id:'admin-task'},notes:'updated note'},0)
    expect(updated).toMatchObject({credentials:{task_id:'admin-task'},notes:'updated note',control_version:1})
    expect(JSON.stringify(updated)).not.toContain(privateKey)
    const secret=t.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(t.id)
    const decoded=await decryptCredentialPayload(secret.nonce_b64,secret.ciphertext_b64,t.env.CREDENTIALS_MASTER_KEY!,credentialAad(t.env.ENVIRONMENT,t.id,secret.id,secret.key_version))
    expect(decoded).toMatchObject({agent_private_key:privateKey,task_id:'admin-task'})
    expect(decoded).not.toHaveProperty('api_key')
    for(const patch of [{agent_private_key:'bad-key'},{agent_private_key:null},{agent_runtime_id:''}]) {
      await expect(executeAccountUpdate(t.env,t.id,{credentials:patch},1)).rejects.toBeDefined()
      expect(t.raw.prepare('SELECT * FROM account_secrets WHERE account_id=?').get(t.id)).toEqual(secret)
    }
    await expect(executeAccountUpdate(t.env,t.id,{credentials:{task_id:'stale-task'}},0)).rejects.toMatchObject({status:412})
  } finally {t.raw.close()}
})

it.each(['old-task',''])('runs the admin text test with key-only Agent credentials and task %j',async task=>{
  const t=await fixture(task)
  try {
    const fetcher=vi.fn().mockResolvedValue(new Response('data: {"type":"response.completed","response":{"status":"completed","output":[{"content":[{"type":"output_text","text":"Agent diagnostic works"}]}]}}\n\n',{headers:{'content-type':'text/event-stream'}}))
    if(!task) fetcher.mockResolvedValueOnce(Response.json({task_id:'registered-for-test'}))
    vi.stubGlobal('fetch',fetcher)
    const app=new Hono<{Bindings:Env}>().post('/accounts/:id/test',testAdminAccount)
    const response=await app.request(`/accounts/${t.id}/test`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model_id:'gpt-5.4'})},t.env)
    const text=await response.text()
    expect(response.status,text).toBe(200);expect(text).toContain('Agent diagnostic works');expect(text).toContain('"success":true')
    expect(new Headers(fetcher.mock.calls.at(-1)![1].headers).get('authorization')).toMatch(/^AgentAssertion /)
    expect(String(fetcher.mock.calls.at(-1)![0])).toContain('chatgpt.com/backend-api/codex/responses')
  } finally {t.raw.close()}
})

it.each([{mode:'default',failsAgain:false},{mode:'default',failsAgain:true},{mode:'compact',failsAgain:false},{mode:'compact',failsAgain:true}])('recovers an invalid task once during admin diagnostics %j',async({mode,failsAgain})=>{
  const t=await fixture()
  try {
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({code:'task_expired'},{status:401}))
      .mockResolvedValueOnce(Response.json({task_id:'diagnostic-recovered-task'}))
      .mockResolvedValueOnce(failsAgain?Response.json({code:'task_expired',message:privateKey},{status:401}):
        new Response('data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"test-compaction"}]}}\n\n',{headers:{'content-type':'text/event-stream'}}))
    vi.stubGlobal('fetch',fetcher)
    const app=new Hono<{Bindings:Env}>().post('/accounts/:id/test',testAdminAccount)
    const response=await app.request(`/accounts/${t.id}/test`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model_id:'gpt-5.4',mode})},t.env)
    const text=await response.text()
    expect(text).toContain(`"success":${!failsAgain}`);expect(text).not.toContain(privateKey)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(String(fetcher.mock.calls[1][0])).toContain('/task/register')
    const first=new Headers(fetcher.mock.calls[0][1].headers).get('authorization')
    const last=new Headers(fetcher.mock.calls[2][1].headers).get('authorization')
    expect(last).toMatch(/^AgentAssertion /);expect(last).not.toBe(first)
    expect(t.raw.prepare('SELECT key_version FROM account_secrets WHERE account_id=?').get(t.id)).toMatchObject({key_version:2})
    if(mode==='compact') {
      const ui=JSON.parse(t.raw.prepare('SELECT ui_config_json FROM accounts WHERE id=?').get(t.id).ui_config_json)
      expect(ui.extra.openai_compact_supported).toBe(failsAgain?undefined:true)
      expect(ui.extra.openai_compact_last_status).toBe(failsAgain?401:200)
    }
  } finally {t.raw.close()}
})

it('skips automatic privacy without access_token but preserves the original manual error',async()=>{
  const t=await fixture()
  try {
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
    const before=t.raw.prepare('SELECT * FROM accounts WHERE id=?').get(t.id)
    await initializeAccountNow(t.env,t.id,false)
    expect(t.raw.prepare('SELECT status,result_mode FROM account_initialization_jobs WHERE account_id=?').get(t.id)).toMatchObject({status:'completed',result_mode:'not_applicable'})
    expect(t.raw.prepare('SELECT * FROM accounts WHERE id=?').get(t.id)).toEqual(before)
    const app=new Hono<{Bindings:Env}>().post('/accounts/:id/privacy',setAdminAccountPrivacy)
    const response=await app.request(`/accounts/${t.id}/privacy`,{method:'POST'},t.env)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Cannot set privacy: missing access_token')
    expect(fetcher).not.toHaveBeenCalled()
  } finally {t.raw.close()}
})
