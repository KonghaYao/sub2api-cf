import type { Env } from '../env'
import { encryptCredential, decryptCredential, sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'
import { validateBaseUrl } from '../gateway/repository'
import { validateAccountProxy } from '../control/proxies'
export const thresholds = { harassment:.98,'harassment/threatening':.9,hate:.65,'hate/threatening':.65,illicit:.95,'illicit/violent':.95,'self-harm':.65,'self-harm/intent':.85,'self-harm/instructions':.65,sexual:.65,'sexual/minors':.65,violence:.95,'violence/graphic':.95 }
export const riskDefaults = {enabled:false,mode:'pre_block',base_url:'https://api.openai.com',model:'omni-moderation-latest',proxy_id:null as number|null,timeout_ms:3000,sample_rate:100,all_groups:true,group_ids:[] as string[],record_non_hits:false,thresholds,worker_count:4,queue_size:32768,block_status:403,block_message:'内容审计命中风险规则，请调整输入后重试',email_on_hit:false,auto_ban_enabled:false,ban_threshold:10,violation_window_hours:720,retry_count:2,hit_retention_days:180,non_hit_retention_days:3,pre_hash_check_enabled:false,blocked_keywords:[] as string[],keyword_blocking_mode:'keyword_and_api',model_filter:{type:'all',models:[] as string[]},cyber_policy_exclude_from_ban_count:false}
export type RiskConfig=typeof riskDefaults&{control_version:number}
export type KeyRow={key_hash:string;masked:string;nonce_b64:string;ciphertext_b64:string;status:string;failure_count:number;success_count:number;last_error:string;last_checked_at_ms:number;frozen_until_ms:number;last_latency_ms:number;last_http_status:number;last_tested:number;active:number;total:number;total_latency_ms:number}
export async function readRiskConfig(env:Env):Promise<RiskConfig>{const row=await env.DB.prepare("SELECT config_json,control_version FROM risk_settings WHERE id='global'").first<{config_json:string;control_version:number}>();return {...structuredClone(riskDefaults),...(row?JSON.parse(row.config_json):{}),control_version:row?.control_version??0}}
export async function riskKeys(env:Env){return(await env.DB.prepare('SELECT * FROM risk_api_keys ORDER BY last_checked_at_ms,key_hash LIMIT 8').all<KeyRow>()).results}
export function keyStatus(row:KeyRow,index:number){return {index,key_hash:row.key_hash,masked:row.masked,status:row.frozen_until_ms>Date.now()?'frozen':row.status,failure_count:row.failure_count,success_count:row.success_count,last_error:row.last_error,last_checked_at:row.last_checked_at_ms?new Date(row.last_checked_at_ms).toISOString():undefined,frozen_until:row.frozen_until_ms>Date.now()?new Date(row.frozen_until_ms).toISOString():undefined,last_latency_ms:row.last_latency_ms,last_http_status:row.last_http_status,last_tested:!!row.last_tested,configured:true}}
export async function configView(env:Env){const config=await readRiskConfig(env),keys=await riskKeys(env);return {...config,api_key_configured:keys.length>0,api_key_masked:keys[0]?.masked??'',api_key_count:keys.length,api_key_masks:keys.map(k=>k.masked),api_key_statuses:keys.map(keyStatus)}}
export function invalid(message:string):never{throw new GatewayError(400,'invalid_risk_config',message)}
export async function parseRiskPatch(env:Env,body:Record<string,unknown>,current:RiskConfig):Promise<RiskConfig>{
 const next=structuredClone(current) as unknown as Record<string,any>
 for(const key of Object.keys(riskDefaults)){
  if(body[key]===undefined)continue
  const value=body[key]
  if(typeof next[key]==='boolean'){if(typeof value!=='boolean')invalid('Invalid '+key);next[key]=value}
  else if(['timeout_ms','sample_rate','worker_count','queue_size','block_status','ban_threshold','violation_window_hours','retry_count','hit_retention_days','non_hit_retention_days'].includes(key)){
   const ranges:Record<string,number[]>={timeout_ms:[100,30000],sample_rate:[0,100],worker_count:[1,32],queue_size:[1,100000],block_status:[400,599],ban_threshold:[1,10000],violation_window_hours:[1,87600],retry_count:[0,5],hit_retention_days:[1,3650],non_hit_retention_days:[1,3]};const [min,max]=ranges[key];if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)invalid(`Invalid ${key} (${min}–${max})`);next[key]=value
  }else if(key==='proxy_id'){if(value===null)continue;if(!Number.isSafeInteger(value)||Number(value)<0)invalid('Invalid proxy ID');next[key]=value===0?null:value;await validateAccountProxy(env,next[key])}
  else if(key==='thresholds'){if(!value||typeof value!=='object'||Array.isArray(value))invalid('Invalid thresholds');for(const [name,score]of Object.entries(value)){if(!(name in thresholds)||typeof score!=='number'||!Number.isFinite(score)||score<0||score>1)invalid('Invalid category threshold');next.thresholds[name]=score}}
  else if(key==='group_ids'||key==='blocked_keywords'){const max=key==='group_ids'?1000:10000;if(!Array.isArray(value)||value.length>max)invalid('Invalid '+key);next[key]=[...new Set(value.map(v=>{if((key==='group_ids'&&typeof v!=='number'&&typeof v!=='string')||(key==='blocked_keywords'&&typeof v!=='string'))invalid('Invalid '+key);const text=String(v).trim();if(!text||text.length>(key==='group_ids'?128:200))invalid('Invalid '+key);return text}))]}
  else if(key==='model_filter'){if(!value||typeof value!=='object'||Array.isArray(value))invalid('Invalid model filter');const filter=value as {type:unknown;models:unknown};if(!['all','include','exclude'].includes(String(filter.type))||!Array.isArray(filter.models)||filter.models.length>1000||filter.models.some(v=>typeof v!=='string'||!v.trim()||v.length>200))invalid('Invalid model filter');next[key]={type:filter.type,models:[...new Set(filter.models)]}}
  else{if(typeof value!=='string'||value.length>2000)invalid('Invalid '+key);next[key]=value.trim()}
 }
 if(!['off','observe','pre_block'].includes(next.mode)||!['keyword_only','keyword_and_api','api_only'].includes(next.keyword_blocking_mode))invalid('Invalid moderation mode')
 next.base_url=validateBaseUrl(next.base_url).toString().replace(/\/$/,'');if(!next.model||!next.block_message)invalid('Model and block message cannot be blank')
 return next as RiskConfig
}
export async function encodeRiskSecret(env:Env,value:unknown,aad:string){return encryptCredential({api_key:JSON.stringify(value)},env.CREDENTIALS_MASTER_KEY!,aad)}
export async function decodeRiskSecret<T>(env:Env,value:{nonce_b64:string;ciphertext_b64:string},aad:string):Promise<T>{return JSON.parse((await decryptCredential(value.nonce_b64,value.ciphertext_b64,env.CREDENTIALS_MASTER_KEY!,aad)).api_key) as T}
export async function newRiskKey(env:Env,secret:string){if(!secret.trim()||secret.length>4096||/[\r\n\0]/.test(secret))invalid('Invalid moderation API key');const raw=secret.trim(),hash=await sha256Hex(raw);return {key_hash:hash,masked:raw.length<10?'••••••':raw.slice(0,4)+'••••'+raw.slice(-4),...await encodeRiskSecret(env,{key:raw},'risk-key:'+hash)}}
