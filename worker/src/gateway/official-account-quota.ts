import { upstreamQuotaSnapshot } from './scheduler-telemetry'
import type { Env } from '../env'
import type { AccountCredential } from './types'
import { accountFetcher } from '../proxy/account-fetch'
import type { AccountSchedulingThresholds } from '../control/account-scheduling-settings'
export interface OfficialQuotaWindow {window:string;used_percent:number;reset_at_ms:number}
export interface OfficialQuotaSnapshot { identity:string; observed_at_ms:number; windows:OfficialQuotaWindow[] }
const MAX_AGE=120000
/** Parse official window payloads, never customer wallet or generic token rate limits. */
export function parseOfficialQuota(platform:string,body:unknown,now:number):OfficialQuotaWindow[] {
 const root=body as Record<string,any>,windows:OfficialQuotaWindow[]=[]
 if(!root || typeof root!=='object')return windows
 const add=(window:string,used:unknown,reset:unknown)=>{if(typeof used==='number' && Number.isFinite(used) && used>=0 && used<=100 && typeof reset==='number' && Number.isSafeInteger(reset) && reset>now && reset<=now+8*86400000)windows.push({window,used_percent:used,reset_at_ms:reset})}
 if(platform==='openai'||platform==='codex') {
  for(const window of [root.rate_limit?.primary_window,root.rate_limit?.secondary_window]) {
   if(!window || ![18000,604800].includes(window.limit_window_seconds))continue
   add(window.limit_window_seconds===18000?'5h':'7d',window.used_percent,typeof window.reset_at==='number'?window.reset_at*1000:NaN)
  }
 } else if(platform==='anthropic') {
  for(const [field,label]of [['five_hour','5h'],['seven_day','7d']]){const w=root[field!];if(w)add(label!,w.utilization,Date.parse(w.resets_at))}
 }
 return windows
}
export function thresholdPause(snapshot:OfficialQuotaSnapshot,identity:string,threshold:number,now:number):number|null {
 if(threshold>=100 || snapshot.identity!==identity || !Number.isSafeInteger(snapshot.observed_at_ms) || now<snapshot.observed_at_ms || now-snapshot.observed_at_ms>MAX_AGE)return null
 const reached=snapshot.windows.filter(w=>Number.isFinite(w.used_percent)&&w.used_percent>=threshold&&w.reset_at_ms>now)
 return reached.length?Math.max(...reached.map(w=>w.reset_at_ms)):null
}
/** Per-account cache is bound to encrypted-secret identity, provider config and URL. */
export async function accountThresholdPause(env:Env,settings:AccountSchedulingThresholds,account:AccountCredential,credential:{api_key:string},signal?:AbortSignal):Promise<number|null> {
 const platform=account.platform==='codex'?'openai':account.platform
 if(platform==='grok')return readGrokThresholdPause(env,settings.grok,account)
 if(platform!=='openai'&&platform!=='anthropic')return null
 const threshold=settings[platform]
 if(threshold>=100 || account.credential_kind!=='oauth')return null
 const base=new URL(account.base_url)
 // The token must belong to the official adapter; a custom OAuth host is not proof of that.
 if(platform==='openai' && !['chatgpt.com','api.openai.com'].includes(base.hostname))return null
 if(platform==='anthropic' && base.hostname!=='api.anthropic.com')return null
 const identity=JSON.stringify([account.secret_id,account.key_version,account.platform,account.base_url,account.provider_config])
 const name='official-account-quota:'+account.account_id
 const now=Date.now()
 const row=await env.DB.prepare('SELECT value_json FROM runtime_settings WHERE name=?').bind(name).first<{value_json:string}>()
 let cached:OfficialQuotaSnapshot|null=null
 try{cached=row?JSON.parse(row.value_json):null}catch{}
 if(cached?.identity===identity && now>=cached.observed_at_ms && now-cached.observed_at_ms<60000)return thresholdPause(cached,identity,threshold,now)
 const controller=new AbortController(),cancel=()=>controller.abort()
 if(signal?.aborted)return null
 signal?.addEventListener('abort',cancel,{once:true})
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 const timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>undefined)},8000)
 let snapshot:OfficialQuotaSnapshot={identity,observed_at_ms:now,windows:[]}
 try {
  const headers=new Headers({authorization:'Bearer '+credential.api_key,accept:'application/json'})
  if(platform==='anthropic')headers.set('anthropic-beta','oauth-2025-04-20')
  if(account.provider_config.account_id)headers.set('chatgpt-account-id',account.provider_config.account_id)
  const response=await accountFetcher(env,account.proxy_id,account)(platform==='openai'?'https://chatgpt.com/backend-api/wham/usage':'https://api.anthropic.com/api/oauth/usage',{method:'GET',headers,redirect:'manual',signal:controller.signal})
  if(!response.ok){await response.body?.cancel();throw new Error('quota_unavailable')}
  reader=response.body?.getReader();if(!reader)throw new Error('empty_quota')
  let text='',size=0;const decoder=new TextDecoder()
  while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>65536)throw new Error('quota_too_large');text+=decoder.decode(chunk.value,{stream:true})}
  text+=decoder.decode()
  const body=JSON.parse(text)
  if(platform==='openai'&&body.account_id&&account.provider_config.account_id&&body.account_id!==account.provider_config.account_id)throw new Error('quota_identity_mismatch')
  snapshot={identity,observed_at_ms:now,windows:parseOfficialQuota(platform,body,now)}
 }catch {
  // An unavailable quota source is unknown, not evidence that the account is exhausted.
  if(cached?.identity===identity && now-cached.observed_at_ms<=MAX_AGE)snapshot=cached
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);await reader?.cancel().catch(()=>undefined)}
 if(!signal?.aborted)await env.DB.prepare(`INSERT INTO runtime_settings(name,value_json,control_version,updated_at_ms) VALUES(?,?,1,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,control_version=runtime_settings.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE runtime_settings.updated_at_ms<=excluded.updated_at_ms`).bind(name,JSON.stringify(snapshot),now).run()
 return thresholdPause(snapshot,identity,threshold,Date.now())
}

function quotaIdentity(account:AccountCredential):string {return JSON.stringify([account.secret_id,account.key_version,account.platform,account.base_url,account.provider_config])}
export function grokQuotaWindow(headers:Headers,now=Date.now()):OfficialQuotaWindow|null {
 const normalized=new Headers(headers)
 for(const dimension of ['requests','tokens'])for(const field of ['limit','remaining','reset']) {
  const target=`x-ratelimit-${field}-${dimension}`
  if(!normalized.has(target)){const alias=headers.get(`x-rate-limit-${field}-${dimension}`);if(alias!==null)normalized.set(target,alias)}
 }
 const quota=upstreamQuotaSnapshot(normalized,now,25*3600000,true)
 return quota?{window:'rolling',used_percent:(1-quota.headroom)*100,reset_at_ms:quota.reset_at_ms}:null
}
export async function observeGrokQuota(env:Env,account:AccountCredential,headers:Headers):Promise<void> {
 if(account.platform!=='grok')return
 const now=Date.now(),window=grokQuotaWindow(headers,now)
 if(window===null)return
 const snapshot:OfficialQuotaSnapshot={identity:quotaIdentity(account),observed_at_ms:now,windows:[window]}
 await env.DB.prepare(`INSERT INTO runtime_settings(name,value_json,control_version,updated_at_ms) VALUES(?,?,1,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,control_version=runtime_settings.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE runtime_settings.updated_at_ms<=excluded.updated_at_ms`).bind('official-account-quota:'+account.account_id,JSON.stringify(snapshot),now).run()
}
async function readGrokThresholdPause(env:Env,threshold:number,account:AccountCredential):Promise<number|null> {
 if(threshold>=100)return null
 const row=await env.DB.prepare('SELECT value_json FROM runtime_settings WHERE name=?').bind('official-account-quota:'+account.account_id).first<{value_json:string}>()
 if(!row)return null
 try {
  const snapshot=JSON.parse(row.value_json) as OfficialQuotaSnapshot,now=Date.now()
  if(snapshot.identity!==quotaIdentity(account) || snapshot.observed_at_ms>now || now-snapshot.observed_at_ms>25*3600000)return null
  const reached=snapshot.windows.filter(w=>Number.isFinite(w.used_percent)&&w.used_percent>=threshold&&w.reset_at_ms>now&&w.reset_at_ms<=snapshot.observed_at_ms+25*3600000)
  return reached.length?Math.max(...reached.map(w=>w.reset_at_ms)):null
 }catch{return null}
}
