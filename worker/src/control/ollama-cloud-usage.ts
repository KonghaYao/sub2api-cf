import type { Context } from 'hono'
import type { Env } from '../env'
import { accountFetcher, accountProxyId } from '../proxy/account-fetch'
import { decryptCredential, encryptCredential, sha256Hex } from '../gateway/crypto'
import { credentialAad } from '../gateway/repository'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateAdminSession } from './admin-auth'
import { controlError, controlSuccess, readJsonObject } from './http'
import { parseOllamaUsageHTML, type OllamaUsageData } from './ollama-cloud-usage-parser'

type C = Context<{ Bindings: Env }>
interface Settings { enabled: boolean; interval_minutes: number; debounce_minutes: number }
interface Account { id: string; platform: string; credential_kind: string; base_url: string; ui_config_json: string; credential_ref: string; config_version: number; secret_id: string; key_version: number; nonce_b64: string; ciphertext_b64: string }
interface Snapshot { status: 'ok'|'failed'|'unauthorized'; data?: OllamaUsageData; fetched_at?: string; last_attempt_at: string; next_refresh_at: string; failure_count?: number; http_status?: number; last_error?: string }
interface Group { group_key: string; nonce_b64: string|null; ciphertext_b64: string|null; auto_refresh: number; snapshot_json: string|null; control_version: number; last_attempt_at_ms: number; lease_until_ms: number }
const NAME='ollama-cloud-usage', DEFAULTS:Settings={enabled:false,interval_minutes:60,debounce_minutes:1}, DAY=86400000
const conflict=()=>new GatewayError(409,'OLLAMA_CLOUD_USAGE_IDENTITY_CHANGED','Account identity or session changed; retry')
const required=()=>new GatewayError(400,'OLLAMA_CLOUD_USAGE_SESSION_REQUIRED','Configure an Ollama web session first')
const key=(env:Env)=>{if(!env.CREDENTIALS_MASTER_KEY)throw new GatewayError(503,'OLLAMA_CLOUD_USAGE_ENCRYPTION_KEY_NOT_CONFIGURED','Session encryption is not configured');return env.CREDENTIALS_MASTER_KEY}
const aad=(env:Env,group:string)=>`ollama-cloud-session:v1:${env.ENVIRONMENT}:${group}`
const snapshot=(group:Group|null):Snapshot|undefined=>group?.snapshot_json?JSON.parse(group.snapshot_json):undefined
async function reply(c:C, work:()=>Promise<unknown>):Promise<Response>{try{await authenticateAdminSession(c.req.raw,c.env);return controlSuccess(await work())}catch(error){return controlError(asGatewayError(error))}}
function normalizeSettings(value:Record<string,unknown>):Settings {
  if(Object.keys(value).some(k=>!['enabled','interval_minutes','debounce_minutes'].includes(k))||typeof value.enabled!=='boolean'||!Number.isInteger(value.interval_minutes)||!Number.isInteger(value.debounce_minutes)||Number(value.interval_minutes)<15||Number(value.interval_minutes)>1440||Number(value.debounce_minutes)<1||Number(value.debounce_minutes)>60)throw new GatewayError(400,'INVALID_OLLAMA_CLOUD_USAGE_SETTINGS','Interval must be 15–1440 minutes and debounce 1–60 minutes')
  return {enabled:value.enabled,interval_minutes:Number(value.interval_minutes),debounce_minutes:Number(value.debounce_minutes)}
}
export async function readOllamaCloudUsageSettings(env:Env):Promise<Settings>{const row=await env.DB.prepare('SELECT value_json FROM runtime_settings WHERE name=?').bind(NAME).first<{value_json:string}>();return row?normalizeSettings(JSON.parse(row.value_json)):{...DEFAULTS}}
export const getOllamaCloudUsageSettings=(c:C)=>reply(c,()=>readOllamaCloudUsageSettings(c.env))
export const putOllamaCloudUsageSettings=(c:C)=>reply(c,async()=>{const value=normalizeSettings(await readJsonObject(c.req.raw));const actor=await authenticateAdminSession(c.req.raw,c.env);const previous=await c.env.DB.prepare('SELECT control_version FROM runtime_settings WHERE name=?').bind(NAME).first<{control_version:number}>();const result=await c.env.DB.prepare(`INSERT INTO runtime_settings(name,value_json,control_version,updated_by,updated_at_ms) VALUES(?,?,1,?,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,control_version=runtime_settings.control_version+1,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms WHERE runtime_settings.control_version=? RETURNING control_version`).bind(NAME,JSON.stringify(value),actor.user_id,Date.now(),previous?.control_version??0).first();if(!result)throw conflict();return value})
function eligible(account:Account):boolean{try{const url=new URL(account.base_url);return account.credential_kind==='api_key'&&['openai','anthropic','kimi','zhipu','deepseek'].includes(account.platform)&&url.protocol==='https:'&&['ollama.com','www.ollama.com'].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&['/','/v1'].includes(url.pathname)}catch{return false}}
async function account(env:Env,id:string|undefined):Promise<Account>{const row=await env.DB.prepare(`SELECT a.id,a.platform,a.credential_kind,a.base_url,a.ui_config_json,a.credential_ref,a.config_version,s.id AS secret_id,s.key_version,s.nonce_b64,s.ciphertext_b64 FROM accounts a LEFT JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id WHERE a.id=?`).bind(id).first<Account>();if(!row)throw new GatewayError(404,'account_not_found','Account not found');return row}
async function identify(env:Env,row:Account):Promise<string>{if(!eligible(row))throw new GatewayError(400,'OLLAMA_CLOUD_USAGE_ACCOUNT_INVALID','An Ollama API-key account is required');const credential=await decryptCredential(row.nonce_b64,row.ciphertext_b64,key(env),credentialAad(env.ENVIRONMENT,row.id,row.secret_id,row.key_version));if(!credential.api_key)throw required();return sha256Hex(`ollama.com\0${credential.api_key}`)}
async function group(env:Env,id:string):Promise<Group|null>{return env.DB.prepare('SELECT * FROM ollama_cloud_usage_groups WHERE group_key=?').bind(id).first<Group>()}
async function state(env:Env,row:Account):Promise<Record<string,unknown>>{const valid=eligible(row),record=valid&&env.CREDENTIALS_MASTER_KEY?await group(env,await identify(env,row)):null;return {account_id:row.id,eligible:valid,configured:Boolean(record?.ciphertext_b64),auto_refresh_enabled:Boolean(record?.ciphertext_b64&&record.auto_refresh),encryption_key_configured:Boolean(env.CREDENTIALS_MASTER_KEY),...(snapshot(record)?{snapshot:snapshot(record)}:{})}}
export const getOllamaCloudUsage=(c:C)=>reply(c,async()=>state(c.env,await account(c.env,c.req.param('id'))))
export function normalizeOllamaCookie(value:unknown):string {
  if(typeof value!=='string'||new TextEncoder().encode(value).length>16384||/[\r\n\0]/.test(value))throw new GatewayError(400,'INVALID_OLLAMA_CLOUD_USAGE_SESSION','Paste a valid Cookie header')
  const values:string[]=[],seen=new Set<string>();for(const raw of value.trim().replace(/^Cookie:\s*/i,'').split(';')){const match=/^\s*([!#$%&'*+.^_`|~0-9a-zA-Z-]+)=([^;]*)$/.exec(raw);if(!match||seen.has(match[1].toLowerCase())||/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(match[1]))throw new GatewayError(400,'INVALID_OLLAMA_CLOUD_USAGE_SESSION','Cookie header contains invalid or duplicate names');seen.add(match[1].toLowerCase());if(/^(?:wos-session|__Secure-session|session|ollama_session|__Host-ollama_session|(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.[0-9]+)?)$/.test(match[1])){if(!match[2].trim())throw required();values.push(`${match[1]}=${match[2].trim()}`)}}if(!values.length)throw required();return values.join('; ')
}
export const saveOllamaCloudUsageSession=(c:C)=>reply(c,async()=>{const body=await readJsonObject(c.req.raw,20000),cookie=normalizeOllamaCookie(body.session),row=await account(c.env,c.req.param('id')),id=await identify(c.env,row),current=await group(c.env,id),encrypted=await encryptCredential({api_key:cookie},key(c.env),aad(c.env,id));const now=Date.now();const results=await c.env.DB.batch([
 c.env.DB.prepare(`INSERT INTO ollama_cloud_usage_groups(group_key,nonce_b64,ciphertext_b64,control_version,updated_at_ms) VALUES(?,?,?,1,?) ON CONFLICT(group_key) DO UPDATE SET nonce_b64=excluded.nonce_b64,ciphertext_b64=excluded.ciphertext_b64,snapshot_json=NULL,last_attempt_at_ms=0,lease_until_ms=0,control_version=ollama_cloud_usage_groups.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE ollama_cloud_usage_groups.control_version=? RETURNING group_key`).bind(id,encrypted.nonce_b64,encrypted.ciphertext_b64,now,current?.control_version??0),
 c.env.DB.prepare('INSERT INTO ollama_cloud_usage_accounts(account_id,group_key) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET group_key=excluded.group_key').bind(row.id,id),
 ]);if(!results[0].results.length)throw conflict();return state(c.env,row)})
export const deleteOllamaCloudUsageSession=(c:C)=>reply(c,async()=>{const row=await account(c.env,c.req.param('id')),id=await identify(c.env,row);await c.env.DB.prepare('UPDATE ollama_cloud_usage_groups SET nonce_b64=NULL,ciphertext_b64=NULL,auto_refresh=0,snapshot_json=NULL,control_version=control_version+1,lease_until_ms=0,updated_at_ms=? WHERE group_key=?').bind(Date.now(),id).run();return state(c.env,row)})
export const setOllamaCloudUsageAutoRefresh=(c:C)=>reply(c,async()=>{const body=await readJsonObject(c.req.raw);if(typeof body.enabled!=='boolean')throw new GatewayError(400,'invalid_enabled','enabled must be boolean');const row=await account(c.env,c.req.param('id')),id=await identify(c.env,row);const updated=await c.env.DB.prepare('UPDATE ollama_cloud_usage_groups SET auto_refresh=?,control_version=control_version+1,updated_at_ms=? WHERE group_key=? AND ciphertext_b64 IS NOT NULL RETURNING group_key').bind(body.enabled?1:0,Date.now(),id).first();if(!updated&&body.enabled)throw required();return state(c.env,row)})
export const refreshOllamaCloudUsage=(c:C)=>reply(c,async()=>{const row=await account(c.env,c.req.param('id'));await refresh(c.env,row,await readOllamaCloudUsageSettings(c.env),true);return state(c.env,row)})
async function refresh(env:Env,row:Account,settings:Settings,manual:boolean):Promise<void>{
 const id=await identify(env,row),current=await group(env,id);if(!current?.ciphertext_b64||!current.nonce_b64)throw required();const now=Date.now(),previous=snapshot(current)
 const lease=await env.DB.prepare('UPDATE ollama_cloud_usage_groups SET lease_until_ms=?,last_attempt_at_ms=? WHERE group_key=? AND control_version=? AND lease_until_ms<=? AND last_attempt_at_ms<=? RETURNING group_key').bind(now+30000,now,id,current.control_version,now,manual?now-30000:now).first();if(!lease)throw new GatewayError(429,'OLLAMA_CLOUD_USAGE_REFRESH_RATE_LIMITED','A refresh is already running or was attempted recently')
 let http=0,retryAfter=0,reason='request_failed',data:OllamaUsageData|undefined,status:Snapshot['status']='failed'
 try{
  const credential=await decryptCredential(current.nonce_b64,current.ciphertext_b64,key(env),aad(env,id))
  const response=await accountFetcher(env,accountProxyId(row.ui_config_json))('https://ollama.com/settings',{headers:{accept:'text/html',cookie:credential.api_key,'user-agent':'Mozilla/5.0 (compatible; Sub2API)'},redirect:'manual',signal:AbortSignal.timeout(15000)})
  http=response.status;const retry=response.headers.get('retry-after');if(retry){retryAfter=/^[0-9]+$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-now)}
  if(http===401||http===403){status='unauthorized';reason='unauthorized';await response.body?.cancel()}
  else if(http>=300&&http<400){reason='redirect_blocked';await response.body?.cancel()}
  else if(!response.ok){reason='http_error';await response.body?.cancel()}
  else{const reader=response.body?.getReader();if(!reader)throw new Error('empty_response');let html='',size=0;const decoder=new TextDecoder();try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>524288){reason='response_too_large';await reader.cancel();throw new Error(reason)}html+=decoder.decode(chunk.value,{stream:true})}html+=decoder.decode()}finally{reader.releaseLock()}try{data=parseOllamaUsageHTML(html);status='ok'}catch(error){if(error instanceof GatewayError&&error.code==='ollama_unauthorized'){status='unauthorized';reason='unauthorized'}else reason='unrecognized_html'}}
 }catch{/* Never persist HTML, cookies, URLs, or exception strings. */}
 const failures=status==='ok'?0:Math.min(1000,(previous?.failure_count??0)+1),delay=Math.max(Math.min(DAY,Math.max(15*60000,settings.interval_minutes*60000*Math.pow(2,Math.min(6,Math.max(0,failures-1))))),Number.isFinite(retryAfter)?retryAfter:0)
 const value:Snapshot={status,last_attempt_at:new Date(now).toISOString(),next_refresh_at:new Date(now+delay).toISOString(),http_status:http,...(failures?{failure_count:failures,last_error:reason}:{}),...(data?{data,fetched_at:new Date(now).toISOString()}:previous?.data?{data:previous.data,fetched_at:previous.fetched_at}:{})}
 const latest=await account(env,row.id);if(latest.config_version!==row.config_version||await identify(env,latest)!==id)throw conflict()
 const updated=await env.DB.prepare('UPDATE ollama_cloud_usage_groups SET snapshot_json=?,lease_until_ms=0,updated_at_ms=? WHERE group_key=? AND control_version=? AND last_attempt_at_ms=? RETURNING group_key').bind(JSON.stringify(value),Date.now(),id,current.control_version,now).first();if(!updated)throw conflict()
}
export async function runOllamaCloudUsageMaintenance(env:Env):Promise<{attempted:number;failed:number}>{
 const settings=await readOllamaCloudUsageSettings(env);if(!settings.enabled)return {attempted:0,failed:0}
 const groups=await env.DB.prepare(`SELECT g.*,MIN(l.account_id) AS account_id,(SELECT MAX(u.occurred_at_ms) FROM usage_projection u JOIN ollama_cloud_usage_accounts linked ON linked.account_id=u.account_id WHERE linked.group_key=g.group_key) AS last_used FROM ollama_cloud_usage_groups g JOIN ollama_cloud_usage_accounts l ON l.group_key=g.group_key JOIN accounts a ON a.id=l.account_id WHERE g.auto_refresh=1 AND g.ciphertext_b64 IS NOT NULL AND g.lease_until_ms<=? AND a.enabled=1 GROUP BY g.group_key HAVING g.snapshot_json IS NULL OR last_used > CAST(unixepoch(CASE WHEN json_extract(g.snapshot_json,'$.status')='ok' THEN json_extract(g.snapshot_json,'$.fetched_at') ELSE json_extract(g.snapshot_json,'$.last_attempt_at') END)*1000 AS INTEGER) ORDER BY g.last_attempt_at_ms LIMIT 200`).bind(Date.now()).all<Group&{account_id:string;last_used:number|null}>()
 let attempted=0,failed=0
 for(const record of groups.results){if(attempted>=4)break;const old=snapshot(record),baseline=old?.status==='ok'?Date.parse(old.fetched_at??''):Date.parse(old?.last_attempt_at??'');if(old&&Number.isFinite(baseline)){if(record.last_used===null||record.last_used<=baseline)continue;let due=Math.min(record.last_used+settings.debounce_minutes*60000,baseline+settings.interval_minutes*60000);due=Math.max(due,old.status==='ok'?baseline+15*60000:Date.parse(old.next_refresh_at));if(Date.now()<due)continue}attempted++;try{await refresh(env,await account(env,record.account_id),settings,false)}catch{failed++}}
 return {attempted,failed}
}

/** Uses the account projection's existing ciphertext columns, then one group read and one link batch. */
export async function enrichAccountOllamaUsage(env:Env,rows:Account[]):Promise<Map<string,Record<string,unknown>>>{
 const result=new Map<string,Record<string,unknown>>(),identities=new Map<string,string>()
 for(const row of rows){if(!eligible(row))continue;result.set(row.id,{account_id:row.id,eligible:true,configured:false,auto_refresh_enabled:false,encryption_key_configured:Boolean(env.CREDENTIALS_MASTER_KEY)});if(env.CREDENTIALS_MASTER_KEY)identities.set(row.id,await identify(env,row))}
 if(!identities.size)return result
 const groups=(await env.DB.prepare('SELECT * FROM ollama_cloud_usage_groups WHERE group_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(identities.values())])).all<Group>()).results
 const lookup=new Map(groups.map(value=>[value.group_key,value])),links:Array<{account_id:string;group_key:string}>=[]
 for(const [accountId,id] of identities){const value=lookup.get(id);if(!value)continue;result.set(accountId,{...result.get(accountId),configured:Boolean(value.ciphertext_b64),auto_refresh_enabled:Boolean(value.ciphertext_b64&&value.auto_refresh),...(snapshot(value)?{snapshot:snapshot(value)}:{})});links.push({account_id:accountId,group_key:id})}
 if(links.length)await env.DB.prepare(`INSERT INTO ollama_cloud_usage_accounts(account_id,group_key) SELECT json_extract(value,'$.account_id'),json_extract(value,'$.group_key') FROM json_each(?) WHERE 1 ON CONFLICT(account_id) DO UPDATE SET group_key=excluded.group_key`).bind(JSON.stringify(links)).run()
 return result
}
