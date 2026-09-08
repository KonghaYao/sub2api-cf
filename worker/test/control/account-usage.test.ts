import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { accountUsage, getAdminAccountUsage, getBatchAdminAccountUsage } from '../../src/control/account-usage'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function fixture() {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  const master = 'm'.repeat(32)
  const secret = await encryptCredential({ api_key: 'access', access_token: 'access' } as never,master,'test/account/secret/1')
  raw.exec("INSERT INTO accounts(id,platform,name,credential_ref,credential_kind,protocol,base_url,auth_scheme,created_at_ms,updated_at_ms) VALUES('account','openai','Usage','secret','oauth','openai','https://api.openai.com','bearer',1,1)")
  raw.prepare('INSERT INTO account_secrets(id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(?,?,1,?,?,1,1)').run('secret','account',secret.nonce_b64,secret.ciphertext_b64)
  const env = { DB: d1,ENVIRONMENT: 'test',CREDENTIALS_MASTER_KEY: master } as Env
  const app = new Hono<{ Bindings: Env }>().get('/accounts/:id/usage',getAdminAccountUsage).post('/accounts/usage/batch',getBatchAdminAccountUsage)
  return { raw,env,app }
}
const quota = () => new Response(null,{ headers: { 'x-codex-primary-used-percent': '50', 'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-after-seconds': '604800',
  'x-codex-secondary-used-percent': '25', 'x-codex-secondary-window-minutes': '300', 'x-codex-secondary-reset-after-seconds': '18000' } })
it('serves measured windows, caches ordinary reads and honors force refresh',async () => {
  const { raw,env,app } = await fixture(); const fetcher = vi.fn(async () => quota()); vi.stubGlobal('fetch',fetcher)
  try {
    const get = (query='') => app.request(`/accounts/account/usage${query}`,{},env)
    expect((await (await get()).json() as any).data).toMatchObject({ five_hour: { utilization: 25,window_stats: { requests: 0 } },seven_day: { utilization: 50 } })
    await get(); expect(fetcher).toHaveBeenCalledTimes(1)
    await get('?force=true'); expect(fetcher).toHaveBeenCalledTimes(2)
    expect(raw.prepare("SELECT control_version FROM accounts WHERE id='account'").get().control_version).toBe(0)
  } finally { raw.close() }
})
it('throttles missing-data failures across calls without inventing measured utilization',async () => {
  const { raw,env } = await fixture(); const fetcher = vi.fn(async () => new Response(null,{ status: 500 })); vi.stubGlobal('fetch',fetcher)
  try {
    await accountUsage(env,'account'); await accountUsage(env,'account')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(raw.prepare("SELECT ui_config_json FROM accounts WHERE id='account'").get().ui_config_json).extra?.codex_5h_used_percent).toBeUndefined()
    await accountUsage(env,'account','active',true); expect(fetcher).toHaveBeenCalledTimes(2)
  } finally { raw.close() }
})
it('prevents forced refreshes from overlapping the same active account lease',async () => {
  const { raw,env } = await fixture()
  let release!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started=resolve }), pending = new Promise<void>(resolve => { release=resolve })
  const fetcher = vi.fn(async () => { started(); await pending; return quota() }); vi.stubGlobal('fetch',fetcher)
  try {
    const first = accountUsage(env,'account','active',true); await ready
    await accountUsage(env,'account','active',true); expect(fetcher).toHaveBeenCalledTimes(1)
    release(); await first
    expect(raw.prepare("SELECT lease_token FROM account_usage_probe_state WHERE account_id='account'").get().lease_token).toBeNull()
  } finally { release(); raw.close() }
})
it('keeps missing and unsupported account errors isolated in a deduplicated batch',async () => {
  const { raw,env,app } = await fixture(); const fetcher = vi.fn(async () => quota()); vi.stubGlobal('fetch',fetcher)
  try {
    const response = await app.request('/accounts/usage/batch',{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account_ids:['account','missing','account',0],force:true}) },env)
    expect(response.status).toBe(200)
    expect((await response.json() as any).data).toMatchObject({ usage: { account: { five_hour: { utilization:25 } } },errors:{ missing:'Account not found' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await app.request('/accounts/missing/usage',{},env)).status).toBe(404)
  } finally { raw.close() }
})
it('reads Anthropic passive samples and separates account, standard and user cost',async () => {
  const { raw,env,app } = await fixture(); const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
  try {
    raw.prepare("UPDATE accounts SET platform='anthropic',protocol='anthropic',auth_scheme='x-api-key',ui_config_json=? WHERE id='account'").run(JSON.stringify({session_window_end:new Date(Date.now()+18000000).toISOString(),extra:{session_window_utilization:0.4}}))
    raw.exec("INSERT INTO users(id,email,created_at_ms,updated_at_ms) VALUES('u','usage@test.invalid',1,1)")
    raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,account_id,model,input_tokens,output_tokens,cache_read_tokens,amount_micros,standard_cost_micros,account_cost_micros,occurred_at_ms,projected_at_ms)
      VALUES('event','request','u','account','model',10,5,2,3000000,5000000,4000000,?,?)`).run(Date.now(),Date.now())
    const result = await (await app.request('/accounts/account/usage?source=passive',{},env)).json() as any
    expect(result.data).toMatchObject({source:'passive',five_hour:{utilization:40,window_stats:{requests:1,tokens:15,cost:4,standard_cost:5,user_cost:3}}})
    expect(fetcher).not.toHaveBeenCalled()
  } finally { raw.close() }
})
it.each(['null','{"account_ids":1}','{"account_ids":[],"force":"true"}','not json'])('rejects malformed batch input %s',async body => {
  const {raw,env,app}=await fixture()
  try { expect((await app.request('/accounts/usage/batch',{method:'POST',headers:{'content-type':'application/json'},body},env)).status).toBe(400) } finally {raw.close()}
})

it.each(['success','failure','malformed','race','concurrent'])('handles Anthropic active %s with shared cache and passive synchronization',async scenario => {
  const {raw,env,app}=await fixture()
  raw.prepare("UPDATE accounts SET platform='anthropic',protocol='anthropic',auth_scheme='x-api-key',ui_config_json=? WHERE id='account'")
    .run(JSON.stringify({extra:{keep:true,passive_usage_7d_oi_utilization:0.25,passive_usage_7d_oi_reset:Math.floor(Date.now()/1000)+500}}))
  const reset=new Date(Date.now()+600000).toISOString()
  const fetcher=vi.fn(async (url:unknown,init?:RequestInit)=>{
    expect(String(url)).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(init?.method).toBe('GET')
    const headers=new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer access')
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    if(scenario==='race') raw.exec("UPDATE accounts SET control_version=control_version+1 WHERE id='account'")
    if(scenario==='concurrent') await new Promise(resolve=>setTimeout(resolve,20))
    if(scenario==='failure') return new Response('sensitive upstream detail',{status:429})
    if(scenario==='malformed') return Response.json({five_hour:{utilization:'40'}})
    return Response.json({five_hour:{utilization:40,resets_at:reset},seven_day:{utilization:60,resets_at:reset},seven_day_sonnet:{utilization:15,resets_at:reset}})
  });vi.stubGlobal('fetch',fetcher)
  const get=()=>app.request('/accounts/account/usage?force=true',{},env)
  try {
    const [first,second]=scenario==='concurrent' ? await Promise.all([get(),get()]) : [await get(),await get()]
    expect(fetcher).toHaveBeenCalledTimes(scenario==='race'?2:1)
    if(['failure','malformed','race'].includes(scenario)) {
      expect(first.status).toBe(scenario==='race'?412:502)
      expect(await first.text()).not.toContain('sensitive upstream detail')
      expect(JSON.parse(raw.prepare("SELECT ui_config_json FROM accounts WHERE id='account'").get().ui_config_json).extra).not.toHaveProperty('session_window_utilization')
    } else {
      expect(first.status).toBe(200);expect(second.status).toBe(200)
      expect((await first.json() as any).data).toMatchObject({five_hour:{utilization:40},seven_day:{utilization:60},seven_day_sonnet:{utilization:15},seven_day_fable:{utilization:25}})
      const passive=await (await app.request('/accounts/account/usage?source=passive',{},env)).json() as any
      expect(passive.data).toMatchObject({source:'passive',five_hour:{utilization:40},seven_day:{utilization:60}})
      expect(raw.prepare("SELECT control_version FROM accounts WHERE id='account'").get().control_version).toBe(0)
      raw.exec("UPDATE account_usage_probe_state SET cache_until_ms=0 WHERE account_id='account'")
      await get();expect(fetcher).toHaveBeenCalledTimes(2)
    }
  } finally {raw.close()}
})
it('keeps setup-token active usage local because it has no OAuth profile scope',async()=>{
  const {raw,env,app}=await fixture();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
  try {
    raw.prepare("UPDATE accounts SET platform='anthropic',protocol='anthropic',auth_scheme='x-api-key',credential_kind='setup_token',ui_config_json=? WHERE id='account'")
      .run(JSON.stringify({session_window_end:new Date(Date.now()+10000).toISOString(),session_window_status:'allowed_warning'}))
    const response=await app.request('/accounts/account/usage?force=true',{},env)
    expect(response.status).toBe(200)
    expect((await response.json() as any).data.five_hour.utilization).toBe(80)
    expect(fetcher).not.toHaveBeenCalled()
  }finally{raw.close()}
})
