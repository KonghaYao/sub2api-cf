import * as proxyTransport from '../../src/gateway/proxy-fetch'
import { afterEach,expect,it,vi } from 'vitest'
import type {Env} from '../../src/env'
import {createApp} from '../../src/app'
import {createOpaqueToken,tokenDigest} from '../../src/auth/tokens'
import {encryptCredential} from '../../src/gateway/crypto'
import {credentialAad} from '../../src/gateway/repository'
import * as probe from '../../src/control/upstream-billing-probe'
import {applyMigrations,createSqliteD1} from '../helpers/sqlite-d1'
const PEPPER='p'.repeat(32),MASTER='m'.repeat(32)
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()})
async function fixture(count=1){
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const now=Date.now(),access=createOpaqueToken('access'),refresh=createOpaqueToken('refresh')
 raw.prepare("INSERT INTO users(id,email,role,created_at_ms,updated_at_ms) VALUES('admin','probe@test.invalid','admin',?,?)").run(now,now)
 raw.prepare("INSERT INTO user_sessions(id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms) VALUES('admin','admin','admin',1,?,?,?,?,?)").run(await tokenDigest(access,PEPPER,'access'),await tokenDigest(refresh,PEPPER,'refresh'),now,now+600000,now+1200000)
 const ids=[]
 for(let i=0;i<count;i++){
  const id='account-'+i,secret='secret-'+i;ids.push(id)
  const credential=await encryptCredential({api_key:'local-fixture-key'},MASTER,credentialAad('test',id,secret,1))
  raw.prepare('INSERT INTO accounts(id,name,platform,credential_ref,base_url,ui_config_json,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?,?,?)').run(id,id,'openai',secret,'https://upstream.e2e.invalid/v1',JSON.stringify({extra:{upstream_billing_probe_enabled:true,upstream_billing_rate_sync_enabled:true,keep_me:'unchanged'}}),now,now)
  raw.prepare('INSERT INTO account_secrets(id,account_id,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?)').run(secret,id,credential.nonce_b64,credential.ciphertext_b64,now,now)
 }
 const env={ENVIRONMENT:'test',APP_VERSION:'test',DB:d1,API_KEY_PEPPER:PEPPER,CREDENTIALS_MASTER_KEY:MASTER,CONFIG_KV:{get:async()=>null},ASSETS:{fetch:async()=>new Response('asset')}} as unknown as Env
 const app=createApp()
 const request=(path:string,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={})=>app.request('/api/v1/admin/accounts'+path,{method,headers:{authorization:`Bearer ${access}`,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)},env)
 return {raw,env,ids,app,request}
}
function billing(rate=0.5){return {object:'sub2api.key_billing',schema_version:1,billing_scope:'token',group_rate_multiplier:rate,resolved_rate_multiplier:rate,effective_rate_multiplier:rate,peak_rate_enabled:false,observed_at:new Date().toISOString(),ignored_secret:'never persist'}}
it('uses real authenticated settings/routes, persists only sanitized billing data and opt-in rate sync',async()=>{
 const t=await fixture(),seen:Request[]=[]
 vi.stubGlobal('fetch',async(url:string|URL,init:RequestInit)=>{seen.push(new Request(url,init));return Response.json(billing())})
 expect((await t.request('/upstream-billing-probe/settings')).status).toBe(200)
 expect((await t.request('/upstream-billing-probe/settings',{enabled:true,interval_minutes:1},'PUT')).status).toBe(400)
 expect((await t.request('/upstream-billing-probe/settings',{enabled:true,interval_minutes:5},'PUT')).status).toBe(200)
 const response=await t.request('/account-0/upstream-billing-probe',{},'POST')
 expect(response.status,await response.clone().text()).toBe(200)
 const data=(await response.json() as any).data
 expect(data.snapshot).toMatchObject({status:'ok',synced_rate_multiplier:0.5})
 expect(JSON.stringify(data)).not.toContain('ignored_secret')
 expect(seen[0].url).toBe('https://upstream.e2e.invalid/v1/sub2api/billing')
 expect(seen[0].headers.get('authorization')).toBe('Bearer local-fixture-key')
 const account=t.raw.prepare('SELECT * FROM accounts WHERE id=?').get(t.ids[0])
 expect(account.billing_rate_multiplier_ppm).toBe(500000)
 expect(JSON.parse(account.ui_config_json).extra.keep_me).toBe('unchanged')
 expect(account.billing_probe_claim_token).toBeNull()
 const listing=await t.request('/upstream-billing-rates?page=1&page_size=1')
 expect((await listing.json() as any).data).toMatchObject({total:1,page:1,page_size:1,items:[{account_id:'account-0',snapshot:{status:'ok'}}]})
 expect((await t.request('/upstream-billing-rates?page=1&page_size=1',undefined,'GET',{'if-none-match':listing.headers.get('etag')!})).status).toBe(304)
 const changed=await t.request('/account-0',{rate_multiplier:2},'PUT',{'if-match':`"${account.control_version}"`,'idempotency-key':'manual-sync-conflict'})
 expect(changed.status,await changed.clone().text()).toBe(409)
 t.raw.close()
})
it('preserves rates for >100 declarations and account identity changes while the actual probe is in flight',async()=>{
 const t=await fixture()
 vi.stubGlobal('fetch',async()=>Response.json(billing(101)))
 expect((await (await t.request('/account-0/upstream-billing-probe',{})).json() as any).data.snapshot).toMatchObject({status:'ok'})
 expect(t.raw.prepare('SELECT billing_rate_multiplier_ppm FROM accounts').get().billing_rate_multiplier_ppm).toBe(1000000)
 vi.stubGlobal('fetch',async()=>{t.raw.prepare("UPDATE accounts SET config_version=config_version+1,control_version=control_version+1,name='changed' WHERE id='account-0'").run();return Response.json(billing(2))})
 const changedProbe=await t.request('/account-0/upstream-billing-probe',{})
 expect(changedProbe.status).toBe(409)
 expect(await changedProbe.json()).toMatchObject({error:{code:'UPSTREAM_BILLING_PROBE_IDENTITY_CHANGED'}})
 const account=t.raw.prepare('SELECT * FROM accounts').get();expect(account.billing_rate_multiplier_ppm).toBe(1000000);expect(account.billing_probe_claim_token).toBeNull();expect(account.name).toBe('changed')
 t.raw.close()
})
it('bounds manual 20-account batch D1 statements and runs scheduled probes only when enabled and due',async()=>{
 const t=await fixture(20);let statements=0,maxInFlight=0,inFlight=0
 const original=t.env.DB
 const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>({bind:(...v:unknown[])=>wrap(statement.bind(...v)),first:async()=>{statements++;return statement.first()},all:async()=>{statements++;return statement.all()},run:async()=>{statements++;return statement.run()}} as D1PreparedStatement)
 t.env.DB={prepare:(sql:string)=>wrap(original.prepare(sql)),batch:async(items:D1PreparedStatement[])=>{const results=[];for(const item of items)results.push(await item.all());return results}} as D1Database
 vi.stubGlobal('fetch',async()=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(resolve=>setTimeout(resolve,2));inFlight--;return Response.json(billing())})
 const response=await t.request('/upstream-billing-probe/batch',{account_ids:t.ids})
 expect(response.status,await response.clone().text()).toBe(200)
 expect((await response.json() as any).data.results.every((r:any)=>r.snapshot?.status==='ok')).toBe(true)
 expect(statements).toBeLessThanOrEqual(50)
 expect(maxInFlight).toBeLessThanOrEqual(4)
 expect(await probe.runUpstreamBillingProbes(t.env)).toEqual({checked:0})
 await t.request('/upstream-billing-probe/settings',{enabled:false,interval_minutes:5},'PUT')
 t.raw.prepare('UPDATE accounts SET billing_probe_next_at_ms=0').run()
 expect(await probe.runUpstreamBillingProbes(t.env)).toEqual({checked:0})
 await t.request('/upstream-billing-probe/settings',{enabled:true,interval_minutes:5},'PUT')
 expect(await probe.runUpstreamBillingProbes(t.env)).toEqual({checked:1})
 t.raw.close()
})
it('records unsupported endpoints without following redirects and aborts a real delayed provider fixture after ten seconds',async()=>{
 const t=await fixture()
 vi.stubGlobal('fetch',async()=>new Response('',{status:404}))
 const unsupported=(await (await t.request('/account-0/upstream-billing-probe',{})).json() as any).data.snapshot
 expect(unsupported.status).toBe('unsupported')
 expect(Date.parse(unsupported.next_probe_at)-Date.parse(unsupported.last_attempt_at)).toBe(30*60000*8)
 vi.useFakeTimers();let aborted=false
 const delayed=vi.fn(async(_url:unknown,init:RequestInit)=>new Promise<Response>((resolve,reject)=>{
  const timer=setTimeout(()=>resolve(Response.json(billing())),12000)
  init.signal!.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);reject(new Error('fixture abort'))},{once:true})
 }))
 vi.stubGlobal('fetch',delayed)
 const pending=t.request('/account-0/upstream-billing-probe',{})
 await vi.waitFor(()=>expect(delayed).toHaveBeenCalledTimes(1))
 await vi.advanceTimersByTimeAsync(10001)
 const timed=(await (await pending).json() as any).data.snapshot
 expect(aborted).toBe(true);expect(timed).toMatchObject({status:'failed',last_error:'request_timeout'})
 expect(t.raw.prepare('SELECT billing_probe_claim_token FROM accounts').get().billing_probe_claim_token).toBeNull()
 t.raw.close()
})

it('never forwards credentials across redirects and repairs a nullable legacy extra object when enabling a probe',async()=>{
 const t=await fixture()
 t.raw.prepare("UPDATE accounts SET ui_config_json='{\"extra\":null}'").run()
 expect((await t.request('/account-0/upstream-billing-probe',{enabled:true},'PUT')).status).toBe(200)
 expect(JSON.parse(t.raw.prepare('SELECT ui_config_json FROM accounts').get().ui_config_json).extra.upstream_billing_probe_enabled).toBe(true)
 const upstream=vi.fn(async(_url:unknown,init:RequestInit)=>{expect(init.redirect).toBe('manual');return new Response('',{status:302,headers:{location:'https://different.example.test/steal'}})})
 vi.stubGlobal('fetch',upstream)
 const response=await t.request('/account-0/upstream-billing-probe',{})
 expect((await response.json() as any).data.snapshot).toMatchObject({status:'failed',http_status:302,last_error:'http_error'})
 expect(upstream).toHaveBeenCalledTimes(1)
 t.raw.close()
})

it('bounds twenty distinct encrypted proxies and explicitly defers unclaimed accounts within the D1 budget',async()=>{
 const t=await fixture(20)
 for(let i=0;i<20;i++){
  const creationKey='proxy-'+i,secret=await encryptCredential({api_key:'proxy-secret'},MASTER,`proxy:v1:${creationKey}`)
  t.raw.prepare('INSERT INTO proxies(id,name,config_json,nonce_b64,ciphertext_b64,creation_key,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)').run(i+1,'proxy-'+i,JSON.stringify({protocol:'http',host:'proxy.example',port:8080,username:'proxy-user',status:'active',expires_at:null,fallback_mode:'none',backup_proxy_id:null}),secret.nonce_b64,secret.ciphertext_b64,creationKey,Date.now(),Date.now())
  t.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id',?) WHERE id=?").run(i+1,t.ids[i])
 }
 let statements=0;const original=t.env.DB
 const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>({bind:(...v:unknown[])=>wrap(statement.bind(...v)),first:async()=>{statements++;return statement.first()},all:async()=>{statements++;return statement.all()},run:async()=>{statements++;return statement.run()}} as D1PreparedStatement)
 t.env.DB={prepare:(sql:string)=>wrap(original.prepare(sql)),batch:async(items:D1PreparedStatement[])=>{const results=[];for(const item of items)results.push(await item.all());return results}} as D1Database
 const tunnels=vi.fn(async():Promise<proxyTransport.ProxySocket>=>{
  const encoder=new TextEncoder(),decoder=new TextDecoder()
  let plain!:ReadableStreamDefaultController<Uint8Array>,secure!:ReadableStreamDefaultController<Uint8Array>
  const base={opened:Promise.resolve(),closed:new Promise(()=>undefined),close:async()=>undefined}
  const tls:proxyTransport.ProxySocket={...base,readable:new ReadableStream({start(c){secure=c}}),writable:new WritableStream({write(bytes){
   expect(decoder.decode(bytes)).toContain('Bearer local-fixture-key')
   const body=JSON.stringify(billing());secure.enqueue(encoder.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`))
  }}),startTls(){throw Error('Unexpected nested TLS')}}
  return {...base,readable:new ReadableStream({start(c){plain=c}}),writable:new WritableStream({write(bytes){
   expect(decoder.decode(bytes)).toContain('Basic '+btoa('proxy-user:proxy-secret'))
   expect(decoder.decode(bytes)).not.toContain('local-fixture-key')
   plain.enqueue(encoder.encode('HTTP/1.1 200 Connection Established\r\n\r\n'))
  }}),startTls({expectedServerHostname}){expect(expectedServerHostname).toBe('upstream.e2e.invalid');return tls}}
 })
 const execute=proxyTransport.fetchAccountProxy
 vi.spyOn(proxyTransport,'fetchAccountProxy').mockImplementation((env,id,url,init,signal)=>execute(env,id,url,init,signal,tunnels))
 const direct=vi.fn(()=>{throw Error('proxy silently bypassed')});vi.stubGlobal('fetch',direct)
 const response=await t.request('/upstream-billing-probe/batch',{account_ids:t.ids})
 expect(response.status,await response.clone().text()).toBe(200)
 const results=(await response.json() as any).data.results
 expect(results.filter((r:any)=>r.snapshot?.status==='ok')).toHaveLength(13)
 expect(results.filter((r:any)=>r.pending&&r.error==='probe_deferred_query_budget')).toHaveLength(7)
 expect(statements).toBeLessThanOrEqual(50);expect(tunnels).toHaveBeenCalledTimes(13);expect(direct).not.toHaveBeenCalled()
 expect(t.raw.prepare('SELECT count(*) AS count FROM accounts WHERE billing_probe_claim_token IS NOT NULL').get().count).toBe(0)
 t.raw.close()
})

it('never carries a fresh upstream rate across an account upstream identity change',async()=>{
 const t=await fixture()
 vi.stubGlobal('fetch',async()=>Response.json(billing(.25)))
 expect((await t.request('/account-0/upstream-billing-probe',{})).status).toBe(200)
 t.raw.prepare("UPDATE accounts SET base_url='https://changed.e2e.invalid/v1',control_version=control_version+1,config_version=config_version+1 WHERE id='account-0'").run()
 vi.stubGlobal('fetch',async()=>Response.json({error:'fixture denied'},{status:401}))
 const response=await t.request('/account-0/upstream-billing-probe',{})
 expect(response.status,await response.clone().text()).toBe(200)
 const snapshot=(await response.json() as any).data.snapshot
 expect(snapshot.status).toBe('failed');expect(snapshot.data).toBeUndefined();expect(snapshot.received_at).toBeUndefined()
 expect(snapshot.identity.base_url).toBe('https://changed.e2e.invalid/v1')
 t.raw.close()
})
