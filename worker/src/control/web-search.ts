import { accountFetcher } from '../proxy/account-fetch'
import { validateAccountProxy } from './proxies'
import type { Context } from 'hono'
import type { Env } from '../env'
import { encryptCredential, decryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlSuccess, controlError, readJsonObject, requireExpectedControlVersion } from './http'

type Provider = { type: 'brave'|'tavily'; api_key: string; quota_limit: number|null; subscribed_at: number|null; expires_at: number|null; proxy_id: number|null }
type Config = { enabled: boolean; providers: Provider[]; control_version: number }
export type SearchResult = { url: string; title: string; snippet: string; page_age?: string }
const aad = 'web-search-settings:v1'
const invalid = (message: string) => new GatewayError(400,'invalid_search_settings',message)
async function readConfig(env: Env): Promise<Config> {
 const row=await env.DB.prepare("SELECT enabled,nonce_b64,ciphertext_b64,control_version FROM web_search_settings WHERE id='global'").first<{enabled:number;nonce_b64:string;ciphertext_b64:string;control_version:number}>()
 if(!row) return {enabled:false,providers:[],control_version:0}
 const secret=await decryptCredential(row.nonce_b64,row.ciphertext_b64,env.CREDENTIALS_MASTER_KEY!,aad)
 return {enabled:row.enabled===1,providers:JSON.parse(secret.api_key),control_version:row.control_version}
}
function windowStart(provider: Provider, now: number): number {
 if(!provider.subscribed_at) return 0
 const anchor=new Date(provider.subscribed_at*1000),current=new Date(now)
 const day=anchor.getUTCDate()
 const at=(year:number,month:number)=>Date.UTC(year,month,Math.min(day,new Date(Date.UTC(year,month+1,0)).getUTCDate()),anchor.getUTCHours(),anchor.getUTCMinutes(),anchor.getUTCSeconds())
 const start=at(current.getUTCFullYear(),current.getUTCMonth())
 return start<=now?start:at(current.getUTCFullYear(),current.getUTCMonth()-1)
}
async function publicConfig(env:Env,config:Config):Promise<unknown> {
 return {...config,providers:await Promise.all(config.providers.map(async ({api_key,...provider})=>{
  const row=await env.DB.prepare('SELECT used FROM web_search_usage WHERE provider=? AND window_start_ms=?').bind(provider.type,windowStart({...provider,api_key},Date.now())).first<{used:number}>()
  return {...provider,api_key:'',api_key_configured:api_key.length>0,quota_used:row?.used??0}
 }))}
}
async function respond(action:()=>Promise<unknown>):Promise<Response>{try{return controlSuccess(await action())}catch(error){return controlError(asGatewayError(error))}}
type C=Context<{Bindings:Env}>
export function getWebSearchConfig(c:C):Promise<Response>{return respond(async()=>publicConfig(c.env,await readConfig(c.env)))}
export function updateWebSearchConfig(c:C):Promise<Response>{return respond(async()=>{
 const body=await readJsonObject(c.req.raw,32768),current=await readConfig(c.env)
 if(typeof body.enabled!=='boolean'||!Array.isArray(body.providers)||body.providers.length>2) throw invalid('Invalid search provider configuration')
 const seen=new Set<string>()
 const providers:Provider[]=body.providers.map(value=>{
  if(!value||typeof value!=='object') throw invalid('Invalid search provider')
  const p=value as Record<string,unknown>
  if((p.type!=='brave'&&p.type!=='tavily')||seen.has(p.type)) throw invalid('Search providers must be unique Brave or Tavily entries')
  seen.add(p.type)
  if(p.proxy_id!=null&&(!Number.isSafeInteger(p.proxy_id)||Number(p.proxy_id)<=0))throw invalid('Invalid search proxy ID')
  const apiKey=p.api_key===''||p.api_key===undefined?current.providers.find(item=>item.type===p.type)?.api_key??'':p.api_key
  if(typeof apiKey!=='string'||apiKey.length>4096||/[\r\n]/.test(apiKey)) throw invalid('Invalid search API key')
  for(const key of ['quota_limit','subscribed_at','expires_at']) if(p[key]!=null&&(!Number.isSafeInteger(p[key])||Number(p[key])<0)) throw invalid(`Invalid ${key}`)
  return {type:p.type,api_key:apiKey,proxy_id:p.proxy_id as number|null??null,quota_limit:p.quota_limit as number|null??null,subscribed_at:p.subscribed_at as number|null??null,expires_at:p.expires_at as number|null??null}
 })
 for(const provider of providers)await validateAccountProxy(c.env,provider.proxy_id)
 if(body.enabled&&!providers.some(p=>p.api_key)) throw invalid('Configure a search provider key before enabling search')
 const expected=requireExpectedControlVersion(c.req.raw,body)
 if(expected!==current.control_version) throw new GatewayError(412,'control_version_conflict','Search configuration changed; reload')
 if(!c.env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503,'credential_encryption_unavailable','Credential encryption is not configured')
 const encrypted=await encryptCredential({api_key:JSON.stringify(providers)},c.env.CREDENTIALS_MASTER_KEY,aad)
 const result=await c.env.DB.prepare(`INSERT INTO web_search_settings(id,enabled,nonce_b64,ciphertext_b64,control_version,updated_at_ms) VALUES('global',?,?,?,1,?)
 ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,nonce_b64=excluded.nonce_b64,ciphertext_b64=excluded.ciphertext_b64,control_version=web_search_settings.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE web_search_settings.control_version=?`).bind(body.enabled?1:0,encrypted.nonce_b64,encrypted.ciphertext_b64,Date.now(),current.control_version).run()
 if(!result.meta.changes) throw new GatewayError(412,'control_version_conflict','Search configuration changed; reload')
 return publicConfig(c.env,{enabled:body.enabled,providers,control_version:current.control_version+1})
})}
export function resetWebSearchUsage(c:C):Promise<Response>{return respond(async()=>{
 const body=await readJsonObject(c.req.raw),config=await readConfig(c.env)
 const provider=config.providers.find(p=>p.type===body.provider_type)
 if(!provider) throw invalid('Search provider is not configured')
 await c.env.DB.prepare('DELETE FROM web_search_usage WHERE provider=?').bind(provider.type).run()
 return {reset:true}
})}
export function testWebSearch(c:C):Promise<Response>{return respond(async()=>{
 const body=await readJsonObject(c.req.raw)
 return searchWeb(c.env,body.query)
})}
export async function searchWeb(env:Env,input:unknown,signal?:AbortSignal):Promise<{provider:string;query:string;results:SearchResult[]}> {
 if(typeof input!=='string'||!input.trim()||input.length>4096) throw invalid('Search query must contain 1–4096 characters')
 if(signal?.aborted)throw new GatewayError(499,'request_cancelled','Search request was cancelled')
 const query=input.trim(),config=await readConfig(env),now=Date.now()
 if(!config.enabled) throw new GatewayError(409,'search_disabled','Web search emulation is disabled')
 for(const p of config.providers) {
  if(signal?.aborted)throw new GatewayError(499,'request_cancelled','Search request was cancelled')
  if(!p.api_key||(p.expires_at!==null&&p.expires_at*1000<=now)) continue
  const reservation=await env.DB.prepare(`INSERT INTO web_search_usage(provider,window_start_ms,used) SELECT ?,?,1 WHERE ? IS NULL OR ?>0
    ON CONFLICT(provider,window_start_ms) DO UPDATE SET used=web_search_usage.used+1 WHERE ? IS NULL OR web_search_usage.used<? RETURNING used`).bind(p.type,windowStart(p,now),p.quota_limit,p.quota_limit,p.quota_limit,p.quota_limit).first()
  if(!reservation) continue
  try {
   const timeout=AbortSignal.timeout(20000),combined=signal?AbortSignal.any([timeout,signal]):timeout
   const url=p.type==='brave'?`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`:'https://api.tavily.com/search'
   const response=await accountFetcher(env,p.proxy_id)(url,{method:p.type==='brave'?'GET':'POST',headers:p.type==='brave'?{'X-Subscription-Token':p.api_key,accept:'application/json'}:{'content-type':'application/json'},body:p.type==='brave'?undefined:JSON.stringify({api_key:p.api_key,query,max_results:5,search_depth:'basic'}),redirect:'manual',signal:combined})
   if(signal?.aborted){await response.body?.cancel();throw new GatewayError(499,'request_cancelled','Search request was cancelled')}
   if(!response.ok){await response.body?.cancel();continue}
   const reader=response.body?.getReader();if(!reader)continue
   let size=0,text='';const decoder=new TextDecoder()
   try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2097152)throw new Error('Search response exceeds limit');text+=decoder.decode(value,{stream:true})}text+=decoder.decode()} finally {await reader.cancel().catch(()=>{});reader.releaseLock()}
   const raw=JSON.parse(text),items=p.type==='brave'?raw.web?.results:raw.results
   if(!Array.isArray(items))continue
   const results:SearchResult[]=items.slice(0,5).filter((item:Record<string,unknown>)=>item!==null&&typeof item==='object'&&typeof item.url==='string'&&/^https?:\/\//.test(item.url)).map((item:Record<string,unknown>)=>({url:String(item.url).slice(0,4096),title:String(item.title??'').slice(0,1024),snippet:String(item.description??item.content??'').slice(0,8192),...(typeof item.age==='string'?{page_age:item.age.slice(0,100)}:{})}))
   return {provider:p.type,query,results}
  } catch {if(signal?.aborted)throw new GatewayError(499,'request_cancelled','Search request was cancelled')}
 }
 throw new GatewayError(502,'search_unavailable','No configured search provider returned a valid result or quota is exhausted','server_error')
}
