import type { Env } from '../env'
import { readRiskConfig, encodeRiskSecret, decodeRiskSecret, type RiskConfig } from '../risk/config'
import { extractModerationContent, moderationHash, callModeration, type ModerationContent, type ModerationResult } from '../risk/moderator'
import { persistRiskResult, type RiskInput } from '../risk/effects'
export type RiskDecision={allowed:boolean;status?:number;message?:string;action?:string;input_hash?:string}
const allow:RiskDecision={allowed:true}
async function riskEnabled(env:Env){return(await env.DB.prepare("SELECT json_extract(gateway_json,'$.risk_control_enabled') AS enabled FROM system_settings WHERE id='global'").first<{enabled:number}>())?.enabled===1}
function inScope(config:RiskConfig,input:RiskInput){if(!config.enabled||config.mode==='off'||!config.all_groups&&!config.group_ids.includes(input.group_id??''))return false;const found=config.model_filter.models.includes(input.model);return config.model_filter.type==='all'||config.model_filter.type==='include'&&found||config.model_filter.type==='exclude'&&!found}
export async function moderateGatewayRequest(env:Env,input:RiskInput,signal?:AbortSignal):Promise<RiskDecision>{
 const config=await readRiskConfig(env);if(!inScope(config,input)||!await riskEnabled(env))return allow
 if(signal?.aborted)return allow
 const content=extractModerationContent(input.body);if(!content.text&&!content.images.length)return allow
 const hash=await moderationHash(content)
 let immediate:ModerationResult|undefined,action='allow',sideEffects=true
 if(config.mode==='pre_block'&&config.keyword_blocking_mode!=='api_only'){
  const keyword=config.blocked_keywords.find(word=>content.text.toLocaleLowerCase().includes(word.toLocaleLowerCase()))
  if(keyword){immediate={flagged:true,highest_category:'keyword',highest_score:1,category_scores:{keyword:1},error:'',latency_ms:0,matched_keyword:keyword};action='keyword_block'}
  else if(config.keyword_blocking_mode==='keyword_only')return allow
 }
 if(!immediate&&config.pre_hash_check_enabled){const hit=await env.DB.prepare('SELECT input_hash FROM risk_hashes WHERE input_hash=? AND expires_at_ms>?').bind(hash,Date.now()).first();if(hit){immediate={flagged:true,highest_category:'hash',highest_score:1,category_scores:{hash:1},error:'',latency_ms:0};action='hash_block';sideEffects=false}}
 if(!immediate&&parseInt(hash.slice(0,8),16)%100>=config.sample_rate)return allow
 if(immediate){const latest=await readRiskConfig(env);if(latest.control_version!==config.control_version||!await riskEnabled(env))return allow;const blocked=config.mode==='pre_block'||action==='hash_block';await persistRiskResult(env,config,input,immediate,{text:content.text,hash,action,side_effects:sideEffects});await metric(env,config,immediate,action);if(!blocked)return allow;return {allowed:false,status:config.block_status,message:config.block_message,action,input_hash:action==='hash_block'?hash:undefined}}
 const context={...input,body:{},moderation_mode:config.mode},now=Date.now();let objectKey:string|null=null
 if(config.mode==='observe'){objectKey='risk-jobs/'+crypto.randomUUID()+'.json';const encrypted=await encodeRiskSecret(env,content,'risk-job:'+input.request_id);await env.OBJECTS.put(objectKey,JSON.stringify(encrypted),{httpMetadata:{contentType:'application/json'}})}
 let inserted:unknown
 try{inserted=await env.DB.prepare(`INSERT INTO risk_jobs(request_id,context_json,payload_object_key,status,created_at_ms,updated_at_ms,config_version) SELECT ?,?,?,'pending',?,?,? WHERE (SELECT COUNT(*) FROM risk_jobs WHERE status IN('pending','processing'))<? ON CONFLICT(request_id) DO NOTHING RETURNING request_id`).bind(input.request_id,JSON.stringify(context),objectKey,now,now,config.control_version,config.queue_size).first()}catch(error){if(objectKey)await env.OBJECTS.delete(objectKey);throw error}
 if(!inserted){if(objectKey)await env.OBJECTS.delete(objectKey);const previous=await env.DB.prepare('SELECT result_json FROM risk_jobs WHERE request_id=?').bind(input.request_id).first<{result_json:string|null}>();if(previous?.result_json)return JSON.parse(previous.result_json);await env.DB.prepare("UPDATE risk_runtime SET dropped=dropped+1 WHERE id='global'").run();return allow}
 if(config.mode==='observe'){await env.DB.prepare("UPDATE risk_runtime SET enqueued=enqueued+1 WHERE id='global'").run();try{await env.EVENTS_QUEUE.send({schema_version:1,event_id:'risk-job:'+input.request_id,event_type:'risk.moderation.v1',occurred_at_ms:now,aggregate_type:'risk',aggregate_id:input.request_id,payload:{request_id:input.request_id}})}catch{/* Persisted pending jobs are recovered by the maintenance scan. */}return allow}
 return await executeJob(env,input.request_id,content,signal)??allow
}
async function metric(env:Env,config:RiskConfig,result:ModerationResult,action:string){const sync=config.mode==='pre_block',blocked=['block','keyword_block','hash_block'].includes(action);await env.DB.prepare(`UPDATE risk_runtime SET processed=processed+1,errors=errors+?,pre_block_checked=pre_block_checked+?,pre_block_allowed=pre_block_allowed+?,pre_block_blocked=pre_block_blocked+?,pre_block_errors=pre_block_errors+?,pre_block_latency_ms=pre_block_latency_ms+? WHERE id='global'`).bind(Number(!!result.error),Number(sync),Number(sync&&!blocked&&!result.error),Number(sync&&blocked),Number(sync&&!!result.error),sync?result.latency_ms:0).run()}
async function executeJob(env:Env,requestId:string,provided?:ModerationContent,signal?:AbortSignal):Promise<RiskDecision|null>{
 const config=await readRiskConfig(env),owner=crypto.randomUUID(),now=Date.now()
 const job=await env.DB.prepare(`UPDATE risk_jobs SET status='processing',lease_owner=?,lease_expires_at_ms=?,config_version=?,updated_at_ms=? WHERE request_id=? AND (status='pending' OR status='processing' AND lease_expires_at_ms<=?) AND (SELECT COUNT(*) FROM risk_jobs WHERE status='processing' AND lease_expires_at_ms>?)<? RETURNING *`).bind(owner,now+config.timeout_ms+60000,config.control_version,now,requestId,now,now,config.worker_count).first<Record<string,any>>()
 if(!job){if(provided){await env.DB.prepare("UPDATE risk_jobs SET status='cancelled',updated_at_ms=? WHERE request_id=? AND status='pending'").bind(now,requestId).run();await env.DB.prepare("UPDATE risk_runtime SET dropped=dropped+1 WHERE id='global'").run()}return null}
 const input=JSON.parse(job.context_json) as RiskInput
 let decision:RiskDecision=allow,complete=false
 try{
  if(!inScope(config,input)||!await riskEnabled(env)){complete=true;return allow}
  let content=provided
  if(!content){if(!job.payload_object_key){complete=true;return allow}const object=await env.OBJECTS.get(job.payload_object_key);if(!object)throw new Error('risk_payload_missing');content=await decodeRiskSecret<ModerationContent>(env,await object.json(),'risk-job:'+requestId)}
  const result=(await callModeration(env,config,content,{signal,request_id:requestId})).result,latest=await readRiskConfig(env)
  if(latest.control_version!==config.control_version||!await riskEnabled(env)){complete=true;return allow}
  const action=result.error?'error':result.flagged&&config.mode==='pre_block'?'block':'allow',hash=await moderationHash(content)
  if(result.flagged||config.record_non_hits||result.error)await persistRiskResult(env,config,input,result,{text:content.text,hash,action,queue_delay_ms:provided?undefined:now-job.created_at_ms})
  await metric(env,config,result,action)
  decision=action==='block'?{allowed:false,status:config.block_status,message:config.block_message,action}:allow
  complete=true;return decision
 }finally{
  await env.DB.prepare('UPDATE risk_jobs SET status=?,lease_owner=NULL,lease_expires_at_ms=0,api_key_hash=NULL,updated_at_ms=?,result_json=? WHERE request_id=? AND lease_owner=?').bind(complete?'done':'pending',Date.now(),complete?JSON.stringify(decision):null,requestId,owner).run()
  if(complete&&job.payload_object_key){await env.OBJECTS.delete(job.payload_object_key);await env.DB.prepare('UPDATE risk_jobs SET payload_object_key=NULL WHERE request_id=? AND status=\'done\'').bind(requestId).run()}
 }
}
export async function consumeRiskModeration(value:unknown,env:Env):Promise<boolean>{if(!value||typeof value!=='object'||(value as Record<string,unknown>).event_type!=='risk.moderation.v1')return false;const message=value as {schema_version:number;payload?:{request_id?:unknown}};if(message.schema_version!==1||typeof message.payload?.request_id!=='string'||message.payload.request_id.length>128)throw new Error('Invalid risk moderation message');await executeJob(env,message.payload.request_id);return true}
export async function recoverRiskJobs(env:Env,now=Date.now()){const jobs=await env.DB.prepare("SELECT request_id FROM risk_jobs WHERE status='pending' OR status='processing' AND lease_expires_at_ms<=? ORDER BY created_at_ms LIMIT 1").bind(now).all<{request_id:string}>();for(const job of jobs.results)await executeJob(env,job.request_id)}
