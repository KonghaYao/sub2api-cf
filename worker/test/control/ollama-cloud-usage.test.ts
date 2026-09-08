// @ts-expect-error Node fixture I/O is test-only.
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptCredential } from '../../src/gateway/crypto'
import { credentialAad } from '../../src/gateway/repository'
import * as service from '../../src/control/ollama-cloud-usage'
import { listAdminAccounts, getAdminAccount } from '../../src/control/accounts'
import { parseOllamaUsageHTML } from '../../src/control/ollama-cloud-usage-parser'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
const PEPPER='p'.repeat(32),MASTER='m'.repeat(32)
const HTML=readFileSync(new URL('../../../backend/internal/service/testdata/ollama_settings_usage.html',import.meta.url),'utf8')
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})
async function fixture(){
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const now=Date.now(),access=createOpaqueToken('access'),refresh=createOpaqueToken('refresh')
 raw.prepare("INSERT INTO users(id,email,role,created_at_ms,updated_at_ms) VALUES('admin','ollama@test.invalid','admin',?,?)").run(now,now)
 raw.prepare("INSERT INTO user_sessions(id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms) VALUES('admin','admin','admin',1,?,?,?,?,?)").run(await tokenDigest(access,PEPPER,'access'),await tokenDigest(refresh,PEPPER,'refresh'),now,now+6000000,now+12000000)
 for(let i=0;i<2;i++){const id='account-'+i,secret='secret-'+i;const credential=await encryptCredential({api_key:'same-official-key'},MASTER,credentialAad('test',id,secret,1));raw.prepare('INSERT INTO accounts(id,name,platform,credential_ref,base_url,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?,?)').run(id,id,'openai',secret,'https://ollama.com/v1',now,now);raw.prepare('INSERT INTO account_secrets(id,account_id,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?)').run(secret,id,credential.nonce_b64,credential.ciphertext_b64,now,now)}
 const env={ENVIRONMENT:'test',DB:d1,API_KEY_PEPPER:PEPPER,CREDENTIALS_MASTER_KEY:MASTER,CONFIG_KV:{get:async()=>null}} as unknown as Env
 const app=new Hono<{Bindings:Env}>();app.get('/catalog/list',listAdminAccounts);app.get('/catalog/detail/:id',getAdminAccount);app.get('/settings',service.getOllamaCloudUsageSettings);app.put('/settings',service.putOllamaCloudUsageSettings);app.get('/:id',service.getOllamaCloudUsage);app.put('/:id/session',service.saveOllamaCloudUsageSession);app.delete('/:id/session',service.deleteOllamaCloudUsageSession);app.put('/:id/auto-refresh',service.setOllamaCloudUsageAutoRefresh);app.post('/:id/refresh',service.refreshOllamaCloudUsage)
 const request=(path:string,method='GET',body?:unknown)=>app.request(path,{method,headers:{authorization:`Bearer ${access}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},env)
 return {raw,env,request}
}
describe('Ollama official web usage',()=>{
 it('parses the original sanitized provider fixture including two windows and scoped model counts',()=>{
  expect(parseOllamaUsageHTML(HTML)).toMatchObject({plan:'max',balance:'$0',five_hour:{used_percent:5.6,reset_at:'2026-07-23T03:00:00.000Z'},seven_day:{used_percent:14.2,reset_at:'2026-07-29T00:00:00.000Z'},models:expect.arrayContaining([{model:'qwen3-coder:480b-cloud',window:'five_hour',requests:3},{model:'qwen3-coder:480b-cloud',window:'seven_day',requests:13}])})
  expect(()=>parseOllamaUsageHTML('<h1>Sign in to Ollama</h1>')).toThrow()
  expect(()=>parseOllamaUsageHTML('<p>Unrecognized page with 90% elsewhere</p>')).toThrow()
 })
 it('matches original parser CSS, reset-element, plan and balance fallback contracts',()=>{
  expect(parseOllamaUsageHTML('<section><p>5 hour usage</p><div data-usage-track><div style="width:23.5%"><span data-model="model-a" data-requests="1,234"></span></div><div data-model="model-a" data-requests="9,999" style="width:0%"></div></div></section>')).toMatchObject({five_hour:{used_percent:23.5},models:[{model:'model-a',window:'five_hour',requests:1234}]})
  for(const element of ['<time datetime="2026-07-23T03:00:00Z">2 hours.</time>','<local-time data-time="2026-07-23T03:00:00Z">2 hours.</local-time>','<span class="local-time" data-time="2026-07-23T03:00:00Z">2 hours.</span>'])expect(parseOllamaUsageHTML('<div><div><span>Session usage</span><span>1% used</span></div><div>Resets in '+element+'</div></div>')).toMatchObject({five_hour:{used_percent:1,reset_at:'2026-07-23T03:00:00.000Z'}})
  expect(parseOllamaUsageHTML('<section><h2><span>Cloud usage</span><span>max</span></h2><div><span>Plan</span><span>Pro</span></div><p>Credits currently available: USD $9.50</p></section>')).toMatchObject({plan:'max',balance:'USD$9.50'})
  expect(parseOllamaUsageHTML('<div><span>Subscription</span><span>Pro</span></div>')).toEqual({plan:'Pro'})
 })
 it('honors provider Retry-After beyond the normal one-day exponential backoff ceiling',async()=>{
  const t=await fixture(),now=Date.now();vi.useFakeTimers();vi.setSystemTime(now)
  await t.request('/account-0/session','PUT',{session:'session=cookie'})
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:429,headers:{'Retry-After':'172800'}}))
  const response=await t.request('/account-0/refresh','POST');expect(response.status).toBe(200)
  const snapshot=JSON.parse(t.raw.prepare('SELECT snapshot_json FROM ollama_cloud_usage_groups').get().snapshot_json)
  expect(Date.parse(snapshot.next_refresh_at)).toBe(now+172800000)
 })
 it('saves and deletes an encrypted filtered session, sharing official identity without returning cookies',async()=>{
  const t=await fixture()
  const result=await t.request('/account-0/session','PUT',{session:'Cookie: analytics=discard; session=private-cookie'})
  expect(result.status,await result.clone().text()).toBe(200)
  expect(await result.json()).toMatchObject({data:{account_id:'account-0',eligible:true,configured:true,auto_refresh_enabled:false}})
  expect(JSON.stringify(t.raw.prepare('SELECT * FROM ollama_cloud_usage_groups').get())).not.toContain('private-cookie')
  expect(await (await t.request('/account-1')).json()).toMatchObject({data:{configured:true}})
  expect((await t.request('/account-0/session','PUT',{session:'session=private; Path=/'})).status).toBe(400)
  expect((await t.request('/account-0/auto-refresh','PUT',{enabled:true})).status).toBe(200)
  expect(await (await t.request('/account-1/session','DELETE')).json()).toMatchObject({data:{configured:false,auto_refresh_enabled:false}})
  expect((await t.request('/account-0/auto-refresh','PUT',{enabled:true})).status).toBe(400)
 })
 it('hydrates account list and detail snapshots in bulk without exposing API keys or cookies',async()=>{
  const t=await fixture();await t.request('/account-0/session','PUT',{session:'session=private-cookie'})
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(HTML));await t.request('/account-0/refresh','POST')
  const list=await t.request('/catalog/list');expect(list.status,await list.clone().text()).toBe(200);const body=await list.text();expect(body).not.toContain('private-cookie');expect(body).not.toContain('same-official-key')
  const items=JSON.parse(body).data.items;expect(items).toHaveLength(2);expect(items.every((item:any)=>item.ollama_cloud_usage.configured&&item.ollama_cloud_usage.snapshot.data.five_hour.used_percent===5.6)).toBe(true)
  expect(t.raw.prepare('SELECT COUNT(*) AS count FROM ollama_cloud_usage_accounts').get().count).toBe(2)
  expect(await (await t.request('/catalog/detail/account-1')).json()).toMatchObject({data:{ollama_cloud_usage:{configured:true,snapshot:{status:'ok'}}}})
 })
 it('fetches only official settings with filtered Cookie and preserves a sanitized snapshot on unauthorized responses',async()=>{
  const t=await fixture();await t.request('/account-0/session','PUT',{session:'session=private-cookie; analytics=no'})
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{expect(String(url)).toBe('https://ollama.com/settings');expect(new Headers(init?.headers).get('cookie')).toBe('session=private-cookie');expect(new Headers(init?.headers).has('authorization')).toBe(false);expect(init?.redirect).toBe('manual');return new Response(HTML)})
  const result=await t.request('/account-0/refresh','POST')
  expect(result.status,await result.clone().text()).toBe(200)
  expect(await result.json()).toMatchObject({data:{snapshot:{status:'ok',data:{five_hour:{used_percent:5.6}}}}})
  expect((await t.request('/account-0/refresh','POST')).status).toBe(429)
  t.raw.exec('UPDATE ollama_cloud_usage_groups SET last_attempt_at_ms=0')
  fetch.mockResolvedValue(new Response('secret upstream details',{status:401}))
  const failed=await t.request('/account-0/refresh','POST');const text=await failed.text();expect(text).not.toContain('secret upstream details');expect(JSON.parse(text)).toMatchObject({data:{snapshot:{status:'unauthorized',last_error:'unauthorized',data:{five_hour:{used_percent:5.6}}}}})
 })
 it('does not follow redirects or silently bypass an assigned inactive proxy',async()=>{
  const t=await fixture();await t.request('/account-0/session','PUT',{session:'session=cookie'})
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:302,headers:{location:'https://attacker.test/'}}))
  expect(await (await t.request('/account-0/refresh','POST')).json()).toMatchObject({data:{snapshot:{status:'failed',last_error:'redirect_blocked'}}})
  t.raw.prepare(`INSERT INTO proxies(id,name,config_json,nonce_b64,ciphertext_b64,creation_key,created_at_ms,updated_at_ms) VALUES(999,'inactive',?,'nonce','cipher','test-proxy',1,1)`).run(JSON.stringify({status:'inactive',fallback_mode:'none'}))
  t.raw.exec(`UPDATE accounts SET ui_config_json='{"proxy_id":999}' WHERE id='account-0'; UPDATE ollama_cloud_usage_groups SET last_attempt_at_ms=0`)
  fetch.mockClear();expect(await (await t.request('/account-0/refresh','POST')).json()).toMatchObject({data:{snapshot:{status:'failed'}}});expect(fetch).not.toHaveBeenCalled()
 })
 it('discards an in-flight snapshot if the session or account identity changed',async()=>{
  const t=await fixture();await t.request('/account-0/session','PUT',{session:'session=first'})
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{await t.request('/account-0/session','PUT',{session:'session=second'});return new Response(HTML)})
  expect((await t.request('/account-0/refresh','POST')).status).toBe(409)
  expect(t.raw.prepare('SELECT snapshot_json FROM ollama_cloud_usage_groups').get().snapshot_json).toBeNull()
 })
 it('uses activity debounce and the fifteen-minute floor while retaining official quota percentages',async()=>{
  const t=await fixture(),now=Date.now();vi.useFakeTimers();vi.setSystemTime(now)
  await t.request('/account-0/session','PUT',{session:'session=cookie'});await t.request('/account-0/auto-refresh','PUT',{enabled:true});await t.request('/settings','PUT',{enabled:true,interval_minutes:60,debounce_minutes:2})
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(HTML))
  expect(await service.runOllamaCloudUsageMaintenance(t.env)).toEqual({attempted:1,failed:0})
  t.raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,account_id,model,amount_micros,occurred_at_ms,projected_at_ms) VALUES('activity','activity','admin','account-0','ollama-model',0,?,?)`).run(now+60000,now+60000)
  vi.setSystemTime(now+3*60000)
  expect(await service.runOllamaCloudUsageMaintenance(t.env)).toEqual({attempted:0,failed:0})
  vi.setSystemTime(now+15*60000)
  expect(await service.runOllamaCloudUsageMaintenance(t.env)).toEqual({attempted:1,failed:0})
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(JSON.parse(t.raw.prepare('SELECT snapshot_json FROM ollama_cloud_usage_groups').get().snapshot_json).data.five_hour.used_percent).toBe(5.6)
 })
 it('applies saved opt-in refresh settings and does not poll idle successful accounts',async()=>{
  const t=await fixture();await t.request('/account-0/session','PUT',{session:'session=cookie'});await t.request('/account-0/auto-refresh','PUT',{enabled:true})
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(HTML))
  expect(await service.runOllamaCloudUsageMaintenance(t.env)).toEqual({attempted:0,failed:0})
  expect((await t.request('/settings','PUT',{enabled:true,interval_minutes:15,debounce_minutes:2})).status).toBe(200)
  expect(await service.runOllamaCloudUsageMaintenance(t.env)).toEqual({attempted:1,failed:0})
  expect(await service.runOllamaCloudUsageMaintenance(t.env)).toEqual({attempted:0,failed:0})
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await t.request('/settings','PUT',{enabled:true,interval_minutes:1,debounce_minutes:2})).status).toBe(400)
 })
})
