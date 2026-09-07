import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken,tokenDigest } from '../../src/auth/tokens'
import { encryptCredential } from '../../src/gateway/crypto'
import { credentialAad } from '../../src/gateway/repository'
import * as transport from '../../src/proxy/transport'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
import type { Env } from '../../src/env'
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
it('saved account model sync decrypts its assigned proxy, crosses CONNECT/TLS, and rejects the same binding immediately after deactivation',async()=>{
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const now=Date.now(),pepper='p'.repeat(32),master='m'.repeat(32),access=createOpaqueToken('access')
 raw.prepare("INSERT INTO users(id,email,role,created_at_ms,updated_at_ms) VALUES('admin','proxy@test.invalid','admin',?,?)").run(now,now)
 raw.prepare("INSERT INTO user_sessions(id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms) VALUES('s','s','admin',1,?,?, ?,?,?)").run(await tokenDigest(access,pepper,'access'),'f'.repeat(64),now,now+600000,now+1200000)
 const key=await encryptCredential({api_key:'upstream-secret'},master,credentialAad('test','account','secret',1))
 raw.prepare("INSERT INTO accounts(id,name,platform,credential_ref,base_url,ui_config_json,created_at_ms,updated_at_ms)VALUES('account','account','openai','secret','https://upstream.example/v1','{}',?,?)").run(now,now)
 raw.prepare("INSERT INTO account_secrets(id,account_id,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms)VALUES('secret','account',?,?,?,?)").run(key.nonce_b64,key.ciphertext_b64,now,now)
 const env={ENVIRONMENT:'test',DB:d1,API_KEY_PEPPER:pepper,CREDENTIALS_MASTER_KEY:master,CONFIG_KV:{get:async()=>null},ASSETS:{fetch:async()=>new Response('asset')}} as unknown as Env
 const app=createApp(),request=(path:string,body?:unknown,method=body===undefined?'GET':'POST',headers={})=>app.request('/api/v1/admin'+path,{method,headers:{authorization:`Bearer ${access}`,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)},env)
 const created=await request('/proxies',{name:'local proxy',protocol:'http',host:'proxy.example',port:8080,username:'proxy-user',password:'proxy-secret'},'POST',{'idempotency-key':'proxy-create'})
 expect(created.status,await created.clone().text()).toBe(201)
 const id=(await created.json() as any).data.id
 const version=raw.prepare("SELECT control_version FROM accounts WHERE id='account'").get()!.control_version
 const invalid=await request('/accounts/account',{proxy_id:99999},'PUT',{'if-match':`"${version}"`,'idempotency-key':'invalid-proxy'})
 expect(invalid.status).toBe(404)
 const saved=await request('/accounts/account',{proxy_id:id},'PUT',{'if-match':`"${version}"`,'idempotency-key':'valid-proxy'})
 expect(saved.status,await saved.clone().text()).toBe(200)
 let tlsHost='',plainText='',tlsText='',closeCount=0
 const enc=new TextEncoder(),dec=new TextDecoder();let plain!:ReadableStreamDefaultController<Uint8Array>,tls!:ReadableStreamDefaultController<Uint8Array>
 const tlsSocket:transport.ProxySocket={readable:new ReadableStream({start(c){tls=c}}),writable:new WritableStream({write(bytes){tlsText+=dec.decode(bytes);const body=JSON.stringify({data:[{id:'composer-2.5'}]});tls.enqueue(enc.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`))}}),close:async()=>{closeCount++},startTls(){throw Error('nested TLS')}}
 const plainSocket:transport.ProxySocket={readable:new ReadableStream({start(c){plain=c}}),writable:new WritableStream({write(bytes){plainText+=dec.decode(bytes);plain.enqueue(enc.encode('HTTP/1.1 200 Connection Established\r\n\r\n'))}}),close:async()=>{closeCount++},startTls({expectedServerHostname}){tlsHost=expectedServerHostname;return tlsSocket}}
 const original=transport.proxyFetch
 const tunnel=vi.spyOn(transport,'proxyFetch').mockImplementation((proxy,url,init)=>original(proxy,url,init,()=>plainSocket))
 const direct=vi.fn(()=>{throw Error('unexpected direct connection')});vi.stubGlobal('fetch',direct)
 const models=await request('/accounts/account/models')
 expect(models.status,await models.clone().text()).toBe(200);expect(await models.text()).toContain('composer-2.5')
 expect(tunnel).toHaveBeenCalledOnce();expect(tlsHost).toBe('upstream.example');expect(plainText).not.toContain('upstream-secret');expect(tlsText).toContain('Bearer upstream-secret');expect(closeCount).toBe(1)
 const disabled=await request('/proxies/'+id,{status:'inactive'},'PUT',{'if-match':'"1"'})
 expect(disabled.status).toBe(200)
 const blocked=await request('/accounts/account/models');expect(blocked.status).toBe(503);expect(tunnel).toHaveBeenCalledOnce();expect(direct).not.toHaveBeenCalled()
 raw.close()
})
