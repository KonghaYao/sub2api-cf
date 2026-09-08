import { proxyFetch } from '../proxy/transport'
import { resolveRequestProxy } from '../proxy/request-selection'
import type { Context } from 'hono'
import type { Env } from '../env'
import { encryptCredential,decryptCredential,sha256Hex } from '../gateway/crypto'
import { asGatewayError,GatewayError } from '../gateway/errors'
import { controlError,controlSuccess,readJsonObject,requireExpectedControlVersion,requireIdempotencyKey } from './http'

export interface ProxyConfig {
 id:number; name:string; protocol:'http'|'https'|'socks5'|'socks5h'; host:string; port:number;
 username:string|null; password:string|null; status:'active'|'inactive';
 expires_at:number|null; fallback_mode:'none'|'proxy'|'direct'; backup_proxy_id:number|null; expiry_warn_days:number;
 control_version:number
}
type PublicConfig=Omit<ProxyConfig,'id'|'password'|'control_version'>
type Row={id:number;name:string;config_json:string;nonce_b64:string;ciphertext_b64:string;control_version:number;created_at_ms:number;updated_at_ms:number;creation_key:string}
type C=Context<{Bindings:Env}>
function invalid(message:string):never{throw new GatewayError(400,'invalid_proxy',message)}
async function reply(work:()=>Promise<unknown>,status:200|201=200):Promise<Response>{try{return controlSuccess(await work(),status)}catch(error){if(error instanceof Error&&error.message.includes('UNIQUE constraint failed: proxies.name'))return controlError(new GatewayError(409,'proxy_name_conflict','A proxy with this name already exists'));if(error instanceof Error&&error.message.includes('proxy_in_use'))return controlError(new GatewayError(409,'proxy_in_use','Detach accounts before deleting this proxy'));return controlError(asGatewayError(error))}}
async function requireRow(env:Env,id:unknown):Promise<Row>{if(!Number.isSafeInteger(Number(id))||Number(id)<=0)invalid('Proxy ID is invalid');const row=await env.DB.prepare('SELECT * FROM proxies WHERE id=?').bind(Number(id)).first<Row>();if(!row)throw new GatewayError(404,'proxy_not_found','Proxy not found');return row}
async function publicRow(env:Env,row:Row,count?:number):Promise<Record<string,unknown>>{const config=JSON.parse(row.config_json) as PublicConfig;const resolved=await full(env,row);return {id:row.id,...config,name:config.name??row.name,expires_at:config.expires_at?new Date(config.expires_at*1000).toISOString():null,status:config.expires_at&&config.expires_at<=Date.now()/1000?'expired':config.status,control_version:row.control_version,password:resolved.password,password_configured:JSON.parse(row.config_json).password_configured===true,...(count!==undefined?{account_count:count}:{}),created_at:new Date(row.created_at_ms).toISOString(),updated_at:new Date(row.updated_at_ms).toISOString()}}
async function full(env:Env,row:Row):Promise<ProxyConfig>{const secret=await decryptCredential(row.nonce_b64,row.ciphertext_b64,env.CREDENTIALS_MASTER_KEY!,`proxy:v1:${row.creation_key}`);return {id:row.id,name:row.name,...JSON.parse(row.config_json),password:decodeProxyPassword(secret.api_key),control_version:row.control_version}}
function decodeProxyPassword(value:string):string|null{try{const payload=JSON.parse(value);if(payload?.schema_version===1&&typeof payload.password==='string')return payload.password||null}catch{}return value||null}
export async function validateAccountProxy(env:Env,id:unknown):Promise<void>{if(id===null||id===undefined)return;await loadProxyForRequest(env,id)}
export async function loadProxyForRequest(env:Env,id:unknown):Promise<ProxyConfig|null>{
 if(id===null||id===undefined)return null
 if(!Number.isSafeInteger(Number(id))||Number(id)<=0)invalid('Proxy ID is invalid')
 const selected=await resolveRequestProxy(env,Number(id))
 return selected===null?null:full(env,selected)
}

async function normalize(env:Env,body:Record<string,unknown>,current?:ProxyConfig):Promise<{config:PublicConfig;password:string}>{
 const candidate={name:'',protocol:'http',host:'',port:8080,username:null,password:null,status:'active',expires_at:null,fallback_mode:'none',backup_proxy_id:null,expiry_warn_days:7,...current,...body}
 if(current){for(const field of ['name','protocol','host','port','username','password','status'] as const){if(!body[field])Object.assign(candidate,{[field]:current[field]})}}
 if(!['http','https','socks5','socks5h'].includes(String(candidate.protocol)))invalid('Invalid proxy protocol')
 for(const field of ['name','host'])if(typeof candidate[field as keyof typeof candidate]!=='string'||String(candidate[field as keyof typeof candidate]).length>255||/[\r\n\0]/.test(String(candidate[field as keyof typeof candidate])))invalid(`Invalid proxy ${field}`)
 const host=String(candidate.host).trim(),name=String(candidate.name).trim()
 if(!name||!host||!(/^[a-zA-Z0-9.-]+$/.test(host)||/^\[[a-fA-F0-9:]+\]$/.test(host)))invalid('Proxy name and hostname are required')
 if(!Number.isInteger(candidate.port)||Number(candidate.port)<1||Number(candidate.port)>65535)invalid('Invalid proxy port')
 if(!['active','inactive'].includes(String(candidate.status)))invalid('Invalid proxy status')
 for(const field of ['username','password']){const value=candidate[field as keyof typeof candidate];if(value!==null&&value!==undefined&&(typeof value!=='string'||new TextEncoder().encode(value).byteLength>255||/[\r\n\0]/.test(value)))invalid(`Invalid proxy ${field}`)}
 if(candidate.expires_at!==null&&(!Number.isSafeInteger(candidate.expires_at)||Number(candidate.expires_at)<0||Number(candidate.expires_at)>8640000000000))invalid('Invalid proxy expiry')
 if(!['none','proxy','direct'].includes(String(candidate.fallback_mode)))invalid('Invalid proxy fallback')
 if(!Number.isInteger(candidate.expiry_warn_days)||Number(candidate.expiry_warn_days)<0||Number(candidate.expiry_warn_days)>365)invalid('Invalid expiry warning period')
 if(candidate.backup_proxy_id!==null){if(!Number.isSafeInteger(candidate.backup_proxy_id)||candidate.backup_proxy_id===current?.id)invalid('Invalid backup proxy');await requireRow(env,candidate.backup_proxy_id)}
 if(candidate.fallback_mode==='proxy'&&candidate.backup_proxy_id===null)invalid('Select a backup proxy')
 const password=body.password===''&&current?current.password??'':String(candidate.password??'')
 return {config:{name,protocol:candidate.protocol as ProxyConfig['protocol'],host,port:Number(candidate.port),username:candidate.username?String(candidate.username):null,status:candidate.status as 'active'|'inactive',expires_at:Number(candidate.expires_at)||null,fallback_mode:candidate.fallback_mode as PublicConfig['fallback_mode'],backup_proxy_id:candidate.backup_proxy_id as number|null,expiry_warn_days:Number(candidate.expiry_warn_days)},password}
}
export const listProxies=(c:C)=>reply(async()=>{
 const all=c.req.path.endsWith('/all'),page=Math.max(1,Number(c.req.query('page'))||1),size=Math.min(100,Math.max(1,Number(c.req.query('page_size'))||20)),clauses:string[]=[],values:unknown[]=[]
 for(const key of ['protocol','status']){const value=c.req.query(key);if(!value)continue;if(key==='status'&&value==='expired'){clauses.push("CAST(json_extract(p.config_json,'$.expires_at') AS INTEGER)>0 AND CAST(json_extract(p.config_json,'$.expires_at') AS INTEGER)<=?");values.push(Math.floor(Date.now()/1000))}else{clauses.push(`json_extract(p.config_json,'$.${key}')=?`);values.push(value);if(key==='status'){clauses.push("(json_extract(p.config_json,'$.expires_at') IS NULL OR json_extract(p.config_json,'$.expires_at')>?)");values.push(Math.floor(Date.now()/1000))}}}
 if(all){clauses.push("json_extract(p.config_json,'$.status')='active' AND (json_extract(p.config_json,'$.expires_at') IS NULL OR json_extract(p.config_json,'$.expires_at')>?)");values.push(Math.floor(Date.now()/1000))}
 if(c.req.query('search')){clauses.push("instr(lower(COALESCE(json_extract(p.config_json,'$.name'),p.name)||' '||json_extract(p.config_json,'$.host')||' '||COALESCE(json_extract(p.config_json,'$.username'),'')),lower(?))>0");values.push(c.req.query('search'))}
 const sortColumns:Record<string,string>={id:'p.id',name:"COALESCE(json_extract(p.config_json,'$.name'),p.name)",protocol:"json_extract(p.config_json,'$.protocol')",host:"json_extract(p.config_json,'$.host')",port:"json_extract(p.config_json,'$.port')",status:"json_extract(p.config_json,'$.status')",expires_at:"json_extract(p.config_json,'$.expires_at')",created_at:'p.created_at_ms',updated_at:'p.updated_at_ms',account_count:'account_count'}
 const sort=c.req.query('sort_by')||'created_at',direction=c.req.query('sort_order')||'desc'
 if(!Object.hasOwn(sortColumns,sort)||!['asc','desc'].includes(direction))invalid('Invalid proxy sort order')
 const where=clauses.length?'WHERE '+clauses.join(' AND '):''
 const result=await c.env.DB.prepare(`SELECT p.*,COUNT(*) OVER() AS total,(SELECT COUNT(*) FROM accounts a WHERE json_extract(a.ui_config_json,'$.proxy_id')=p.id) AS account_count FROM proxies p ${where} ORDER BY ${sortColumns[sort]} ${direction},p.id DESC LIMIT ? OFFSET ?`).bind(...values,all?1000:size,all?0:(page-1)*size).all<Row&{total:number;account_count:number}>()
 const total=all?0:(result.results[0]?.total??Number((await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM proxies p ${where}`).bind(...values).first<{total:number}>())?.total??0))
 const items=await Promise.all(result.results.map(row=>publicRow(c.env,row,row.account_count)));if(all)return items
 return {items,total,page,page_size:size,pages:Math.ceil(total/size)}
})
export const getProxy=(c:C)=>reply(async()=>publicRow(c.env,await requireRow(c.env,c.req.param('id'))))
async function proxyIdentity(env:Env,config:Pick<ProxyConfig,'host'|'port'|'username'>,password:string):Promise<string>{
 if(!env.CREDENTIALS_MASTER_KEY)throw new GatewayError(503,'credential_secret_not_configured','Credential encryption secret is not configured')
 const encoder=new TextEncoder(),key=await crypto.subtle.importKey('raw',encoder.encode(env.CREDENTIALS_MASTER_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign'])
 const data=JSON.stringify(['proxy-identity:v1',config.host,config.port,config.username??'',password])
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(data)))].map(byte=>byte.toString(16).padStart(2,'0')).join('')
}
async function indexLegacyProxyIdentities(env:Env,config:PublicConfig):Promise<void>{
 const rows=await env.DB.prepare(`SELECT * FROM proxies WHERE identity_digest IS NULL
   AND json_extract(config_json,'$.host')=? AND json_extract(config_json,'$.port')=?
   AND COALESCE(json_extract(config_json,'$.username'),'')=?`).bind(config.host,config.port,config.username??'').all<Row>()
 for(const row of rows.results){
  const value=await full(env,row),digest=await proxyIdentity(env,value,value.password??'')
  const changed=await env.DB.prepare(`UPDATE proxies SET identity_digest=? WHERE id=? AND identity_digest IS NULL
    AND config_json=? AND ciphertext_b64=?`).bind(digest,row.id,row.config_json,row.ciphertext_b64).run()
  if(!changed.meta.changes)throw new GatewayError(409,'proxy_changed','Proxy changed during duplicate detection; retry the import')
 }
}
async function createProxyRecord(env:Env,body:Record<string,unknown>,idempotencyKey:string,deduplicate=false):Promise<{proxy:Record<string,unknown>;created:boolean}>{
 const key=await sha256Hex(idempotencyKey),normalized=await normalize(env,body),fingerprint=await sha256Hex(JSON.stringify(normalized))
 const previous=await env.DB.prepare('SELECT fingerprint,proxy_id,created FROM proxy_creation_requests WHERE key_hash=?').bind(key).first<{fingerprint:string;proxy_id:number;created:number}>()
 if(previous){if(previous.fingerprint!==fingerprint)throw new GatewayError(409,'idempotency_conflict','Idempotency key was used with different proxy data');return {proxy:await publicRow(env,await requireRow(env,previous.proxy_id)),created:previous.created===1}}
 const digest=await proxyIdentity(env,normalized.config,normalized.password)
 if(deduplicate)await indexLegacyProxyIdentities(env,normalized.config)
 const now=Date.now(),encrypted=await encryptCredential({api_key:JSON.stringify({schema_version:1,password:normalized.password})},env.CREDENTIALS_MASTER_KEY!,`proxy:v1:${key}`)
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO proxies(name,config_json,nonce_b64,ciphertext_b64,creation_key,created_at_ms,updated_at_ms,identity_digest)
    SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM proxy_creation_requests WHERE key_hash=?)
    AND (?=0 OR NOT EXISTS(SELECT 1 FROM proxies WHERE identity_digest=?)) ON CONFLICT(creation_key) DO NOTHING`)
    .bind(`proxy-${key}`,JSON.stringify({...normalized.config,password_configured:normalized.password!==''}),encrypted.nonce_b64,encrypted.ciphertext_b64,key,now,now,digest,key,deduplicate?1:0,digest),
  env.DB.prepare(`INSERT INTO proxy_creation_requests(key_hash,fingerprint,proxy_id,created_at_ms,created)
    SELECT ?,?,id,?,CASE WHEN creation_key=? THEN 1 ELSE 0 END FROM proxies
    WHERE creation_key=? OR (?=1 AND identity_digest=?)
    ORDER BY CASE WHEN creation_key=? THEN 0 ELSE 1 END,id LIMIT 1 ON CONFLICT(key_hash) DO NOTHING`).bind(key,fingerprint,now,key,key,deduplicate?1:0,digest,key),
 ])
 const recorded=await env.DB.prepare('SELECT fingerprint,proxy_id,created FROM proxy_creation_requests WHERE key_hash=?').bind(key).first<{fingerprint:string;proxy_id:number;created:number}>()
 if(!recorded||recorded.fingerprint!==fingerprint)throw new GatewayError(409,'idempotency_conflict','Idempotency key was used with different proxy data')
 return {proxy:await publicRow(env,await requireRow(env,recorded.proxy_id)),created:recorded.created===1}
}
export const createProxy=(c:C)=>reply(async()=>(await createProxyRecord(c.env,await readJsonObject(c.req.raw,16384),requireIdempotencyKey(c.req.raw))).proxy,201)
export const updateProxy=(c:C)=>reply(async()=>{
 const body=await readJsonObject(c.req.raw,16384),expected=requireExpectedControlVersion(c.req.raw,body),row=await requireRow(c.env,c.req.param('id'))
 if(row.control_version!==expected)throw new GatewayError(412,'control_version_conflict','Proxy changed; reload before saving')
 const {config,password}=await normalize(c.env,body,await full(c.env,row)),encrypted=await encryptCredential({api_key:JSON.stringify({schema_version:1,password})},c.env.CREDENTIALS_MASTER_KEY!,`proxy:v1:${row.creation_key}`)
 const result=await c.env.DB.prepare('UPDATE proxies SET identity_digest=?,config_json=?,nonce_b64=?,ciphertext_b64=?,control_version=control_version+1,updated_at_ms=? WHERE id=? AND control_version=?').bind(await proxyIdentity(c.env,config,password),JSON.stringify({...config,password_configured:password!==''}),encrypted.nonce_b64,encrypted.ciphertext_b64,Date.now(),row.id,expected).run()
 if(!result.meta.changes)throw new GatewayError(412,'control_version_conflict','Proxy changed; reload before saving')
 return publicRow(c.env,await requireRow(c.env,row.id))
})
async function deleteProxyRecord(env:Env,proxyId:unknown,expected:number):Promise<{message:string}>{const id=Number(proxyId);if(!Number.isSafeInteger(id)||id<=0)invalid('Proxy ID is invalid');const row=await env.DB.prepare('SELECT * FROM proxies WHERE id=?').bind(id).first<Row>();if(!row){const deleted=await env.DB.prepare('SELECT control_version FROM proxy_deletions WHERE proxy_id=?').bind(id).first<{control_version:number}>();if(deleted?.control_version===expected)return {message:'Proxy deleted'};throw new GatewayError(deleted?412:404,deleted?'control_version_conflict':'proxy_not_found','Proxy not found or version changed')}if(row.control_version!==expected)throw new GatewayError(412,'control_version_conflict','Proxy changed; reload');const result=await env.DB.prepare('DELETE FROM proxies WHERE id=? AND control_version=?').bind(row.id,expected).run();if(!result.meta.changes)throw new GatewayError(412,'control_version_conflict','Proxy changed; reload');return {message:'Proxy deleted'}}
export const deleteProxy=(c:C)=>reply(()=>deleteProxyRecord(c.env,c.req.param('id'),requireExpectedControlVersion(c.req.raw,{})))
export const proxyAccounts=(c:C)=>reply(async()=>{const row=await requireRow(c.env,c.req.param('id'));const result=await c.env.DB.prepare("SELECT id,name,platform,COALESCE(json_extract(ui_config_json,'$.type'),CASE credential_kind WHEN 'api_key' THEN 'apikey' ELSE credential_kind END) AS type,CASE WHEN enabled=1 THEN 'active' ELSE 'inactive' END AS status FROM accounts WHERE json_extract(ui_config_json,'$.proxy_id')=? ORDER BY id").bind(row.id).all();return result.results})

async function connectivity(env:Env,row:Row):Promise<Record<string,unknown>>{
 const started=Date.now(),proxy=await full(env,row)
 try{
  const response=await proxyFetch(proxy,'https://www.cloudflare.com/cdn-cgi/trace',{signal:AbortSignal.timeout(15000)})
  const text=await response.text()
  if(!response.ok||text.length>16384)return {success:false,message:'Proxy trace endpoint did not return a valid response',latency_ms:Date.now()-started}
  const trace=Object.fromEntries(text.split('\n').filter(line=>line.includes('=')).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)]}))
  if(!trace.ip||!/^[:.a-fA-F0-9]+$/.test(trace.ip))return {success:false,message:'Proxy exit IP was not present in trace',latency_ms:Date.now()-started}
  return {success:true,message:'Proxy connection succeeded',latency_ms:Date.now()-started,ip_address:trace.ip,country_code:trace.loc,country:trace.loc}
 }catch{return {success:false,message:'Proxy connection failed or timed out',latency_ms:Date.now()-started}}
}
export const testProxy=(c:C)=>reply(async()=>connectivity(c.env,await requireRow(c.env,c.req.param('id'))))
export const proxyStats=(c:C)=>reply(async()=>{
 const row=await requireRow(c.env,c.req.param('id'))
 const accounts=await c.env.DB.prepare("SELECT COUNT(*) AS total_accounts,COALESCE(SUM(enabled),0) AS active_accounts FROM accounts WHERE json_extract(ui_config_json,'$.proxy_id')=?").bind(row.id).first<Record<string,number>>()
 const stats=await c.env.DB.prepare("SELECT COUNT(*) AS total_requests,AVG(CASE WHEN lifecycle='completed' AND status_code<400 THEN 100.0 ELSE 0 END) AS success_rate,AVG(duration_ms) AS average_latency FROM request_observations WHERE account_id IN(SELECT id FROM accounts WHERE json_extract(ui_config_json,'$.proxy_id')=?) AND lifecycle<>'started'").bind(row.id).first<Record<string,number>>()
 return {...accounts,...stats,success_rate:stats?.success_rate??0,average_latency:stats?.average_latency??0,scope:'retained_requests_for_currently_assigned_accounts'}
})
export const checkProxyQuality=(c:C)=>reply(async()=>{
 const row=await requireRow(c.env,c.req.param('id')),proxy=await full(c.env,row),trace=await connectivity(c.env,row)
 const targets=[['OpenAI','https://api.openai.com/v1/models'],['Anthropic','https://api.anthropic.com/v1/models'],['Gemini','https://generativelanguage.googleapis.com/v1beta/models']]
 const items=await Promise.all(targets.map(async([target,url])=>{
  const started=Date.now()
  try{
   const response=await proxyFetch(proxy,url,{signal:AbortSignal.timeout(15000)}),status=response.status,challenge=response.headers.get('cf-mitigated')==='challenge'
   await response.body?.cancel()
   return {target,status:challenge?'challenge':status===401||status===200?'pass':status===400||status===403?'warn':'fail',http_status:status,latency_ms:Date.now()-started,message:challenge?'Cloudflare challenge':status===401?'Target reachable; unauthenticated probe':`HTTP ${status}`}
  }catch{return {target,status:'fail',latency_ms:Date.now()-started,message:'Connection failed or timed out'}}
 }))
 const count=(status:string)=>items.filter(item=>item.status===status).length,passed=count('pass'),warn=count('warn'),failed=count('fail'),challenge=count('challenge'),score=Math.round((passed+warn*0.5)/items.length*100)
 return {proxy_id:row.id,score,grade:score>=90?'A':score>=60?'B':'C',summary:`${passed}/${items.length} target probes passed`,exit_ip:trace.ip_address,country:trace.country,country_code:trace.country_code,base_latency_ms:trace.latency_ms,passed_count:passed,warn_count:warn,failed_count:failed,challenge_count:challenge,checked_at:Math.floor(Date.now()/1000),items}
})

export const batchCreateProxies=(c:C)=>reply(async()=>{
 const body=await readJsonObject(c.req.raw,81920),key=requireIdempotencyKey(c.req.raw)
 if(!Array.isArray(body.proxies)||body.proxies.length<1||body.proxies.length>5)invalid('A proxy batch must contain at most five entries')
 let created=0,skipped=0
 const errors:Array<{index:number;code:string}>=[]
 for(const [index,value]of body.proxies.entries()){
  if(!value||typeof value!=='object'||Array.isArray(value))invalid('Invalid proxy entry')
  const proxy=value as Record<string,unknown>
  try{const input:Record<string,unknown>={...proxy,name:'default'};for(const field of ['host','protocol','username','password'])if(typeof input[field]==='string')input[field]=(input[field] as string).trim();const outcome=await createProxyRecord(c.env,input,`${key}:${index}`,true);if(outcome.created)created++;else skipped++}
  catch(error){skipped++;errors.push({index,code:error instanceof GatewayError?error.code:'proxy_creation_failed'})}
 }
 return {created,skipped,errors}
})
export const exportProxyData=(c:C)=>reply(async()=>{
 const ids=c.req.query('ids')?.split(',').map(Number)
 if(ids&&(ids.length>1000||ids.some(id=>!Number.isSafeInteger(id)||id<=0)))invalid('Invalid selected proxy IDs')
 const clauses:string[]=[],values:unknown[]=[]
 if(ids?.length){clauses.push('id IN(SELECT value FROM json_each(?))');values.push(JSON.stringify(ids))}
 else{
  const search=c.req.query('search');if(search){clauses.push("instr(lower(COALESCE(json_extract(config_json,'$.name'),name)),lower(?))>0");values.push(search)}
  for(const field of ['protocol','status'])if(c.req.query(field)){const value=c.req.query(field);if(field==='status'&&value==='expired'){clauses.push("json_extract(config_json,'$.expires_at')>0 AND json_extract(config_json,'$.expires_at')<=?");values.push(Math.floor(Date.now()/1000))}else{clauses.push(`json_extract(config_json,'$.${field}')=?`);values.push(value)}}
 }
 const rows=await c.env.DB.prepare(`SELECT * FROM proxies ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY id LIMIT 1001`).bind(...values).all<Row>()
 if(rows.results.length>1000)throw new GatewayError(413,'proxy_export_too_large','Select at most 1000 proxies for one export')
 const proxies=await Promise.all(rows.results.map(async row=>{const value=await full(c.env,row);return {proxy_key:`worker-proxy-${row.id}`,name:value.name,protocol:value.protocol,host:value.host,port:value.port,username:value.username,password:value.password,status:value.status,expires_at:value.expires_at,fallback_mode:value.fallback_mode,backup_proxy_key:value.backup_proxy_id===null?null:`worker-proxy-${value.backup_proxy_id}`,expiry_warn_days:value.expiry_warn_days}}))
 return {type:'sub2api-data',version:1,exported_at:new Date().toISOString(),proxies,accounts:[]}
})
export const importProxyData=(c:C)=>reply(async()=>{
 const body=await readJsonObject(c.req.raw,81920),key=requireIdempotencyKey(c.req.raw),data=body.data as Record<string,unknown>|undefined
 if(!data||!Array.isArray(data.proxies)||data.proxies.length>5||(Array.isArray(data.accounts)&&data.accounts.length>0))invalid('Import at most five proxies per batch; account data must use the account importer')
 let proxy_created=0,proxy_reused=0,proxy_failed=0
 const errors:Array<{kind:string;name:string;message:string}>=[]
 for(const [index,item]of data.proxies.entries()){
  if(!item||typeof item!=='object')invalid('Invalid proxy import item')
  const proxy=item as Record<string,unknown>
  if(proxy.fallback_mode==='proxy'){proxy_failed++;errors.push({kind:'proxy',name:String(proxy.name??''),message:'Import fallback targets first, then assign the backup proxy explicitly'});continue}
  try{
   const old=await c.env.DB.prepare('SELECT proxy_id FROM proxy_creation_requests WHERE key_hash=?').bind(await sha256Hex(`${key}:${index}`)).first()
   await createProxyRecord(c.env,proxy,`${key}:${index}`)
   if(old)proxy_reused++;else proxy_created++
  }catch(error){proxy_failed++;errors.push({kind:'proxy',name:String(proxy.name??''),message:error instanceof GatewayError?error.message:'Proxy import failed; check duplicate names or invalid fields'})}
 }
 return {proxy_created,proxy_reused,proxy_failed,account_created:0,account_failed:0,errors}
})

export const batchDeleteProxies=(c:C)=>reply(async()=>{
 const body=await readJsonObject(c.req.raw,16384),ids=body.ids,versions=body.expected_control_versions as Record<string,unknown>|undefined
 if(!Array.isArray(ids)||ids.length>10||ids.some(id=>!Number.isSafeInteger(id)||id<=0))invalid('Delete at most ten valid proxy IDs per batch')
 if(!versions||typeof versions!=='object'||ids.some(id=>!Number.isSafeInteger(versions[String(id)])))throw new GatewayError(428,'control_version_required','Each proxy requires its expected control version')
 const deleted_ids:number[]=[],skipped:Array<{id:number;reason:string;code:string}>=[]
 for(const id of [...new Set(ids)]){
  try{await deleteProxyRecord(c.env,id,Number(versions[String(id)]));deleted_ids.push(id)}
  catch(error){const code=error instanceof GatewayError?error.code:error instanceof Error&&error.message.includes('proxy_in_use')?'proxy_in_use':'proxy_delete_failed';const reason=code==='proxy_in_use'?'Proxy is referenced by accounts or fallback proxies':code==='proxy_not_found'?'Proxy not found':code==='control_version_conflict'?'Proxy changed; reload before deleting':'Proxy deletion failed';skipped.push({id,code,reason})}
 }
 return {deleted_ids,skipped}
})

// Both router naming conventions use the same authoritative production catalog.
export {
 listProxies as listAdminProxies, getProxy as getAdminProxy,
 createProxy as createAdminProxy, updateProxy as updateAdminProxy,
 deleteProxy as deleteAdminProxy, proxyAccounts as listAdminProxyAccounts,
 batchCreateProxies as batchCreateAdminProxies, batchDeleteProxies as batchDeleteAdminProxies,
}
