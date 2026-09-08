import type { Env } from '../env'
import { readRiskConfig } from './config'
import { persistRiskResult } from './effects'
export async function projectCyberRiskEvents(env:Env){
 const enabled=(await env.DB.prepare("SELECT json_extract(gateway_json,'$.risk_control_enabled') AS enabled FROM system_settings WHERE id='global'").first<{enabled:number}>())?.enabled===1;if(!enabled)return
 const config=await readRiskConfig(env),rows=(await env.DB.prepare(`SELECT e.*,o.group_id,o.request_path,o.platform FROM gateway_risk_events e LEFT JOIN request_observations o ON o.request_id=e.request_id WHERE e.projected_at_ms IS NULL ORDER BY e.created_at_ms,e.request_id LIMIT 1`).all<Record<string,any>>()).results
 for(const row of rows){
  await persistRiskResult(env,config,{request_id:row.request_id,user_id:row.user_id,api_key_id:row.api_key_id,group_id:row.group_id??null,endpoint:row.request_path??'/v1/responses',provider:row.platform??'openai',model:row.model,body:{}},{flagged:true,highest_category:'cyber_policy',highest_score:1,category_scores:{cyber_policy:1},error:'',latency_ms:0},{text:'',hash:'',action:'cyber_policy',created_at_ms:row.created_at_ms,side_effects:Date.now()-row.created_at_ms<=config.violation_window_hours*3600000})
  await env.DB.prepare('UPDATE gateway_risk_events SET projected_at_ms=? WHERE request_id=?').bind(Date.now(),row.request_id).run()
 }
 return {projected:rows.length}
}
export async function cleanupRiskData(env:Env,now=Date.now()){
 const config=await readRiskConfig(env),hitCutoff=now-config.hit_retention_days*86400000,missCutoff=now-config.non_hit_retention_days*86400000
 const results=await env.DB.batch([
  env.DB.prepare("DELETE FROM risk_logs WHERE id IN(SELECT id FROM risk_logs WHERE flagged=1 AND created_at_ms<? AND NOT EXISTS(SELECT 1 FROM risk_outbox WHERE log_id=risk_logs.id AND sent_at_ms IS NULL) AND NOT EXISTS(SELECT 1 FROM risk_ban_commands WHERE log_id=risk_logs.id AND status IN('pending','applying')) LIMIT 50)").bind(hitCutoff),
  env.DB.prepare('DELETE FROM risk_logs WHERE id IN(SELECT id FROM risk_logs WHERE flagged=0 AND created_at_ms<? LIMIT 50)').bind(missCutoff),
  env.DB.prepare('DELETE FROM risk_hashes WHERE input_hash IN(SELECT input_hash FROM risk_hashes WHERE expires_at_ms<=? LIMIT 50)').bind(now),
  env.DB.prepare('DELETE FROM risk_outbox WHERE id IN(SELECT id FROM risk_outbox WHERE sent_at_ms<? LIMIT 50)').bind(hitCutoff),
  env.DB.prepare("DELETE FROM risk_jobs WHERE request_id IN(SELECT request_id FROM risk_jobs WHERE status IN('done','cancelled') AND payload_object_key IS NULL AND updated_at_ms<? LIMIT 50)").bind(now-86400000)
 ])
 const orphan=await env.DB.prepare("SELECT request_id,payload_object_key FROM risk_jobs WHERE status IN('done','cancelled') AND payload_object_key IS NOT NULL ORDER BY updated_at_ms LIMIT 1").first<{request_id:string;payload_object_key:string}>();if(orphan){await env.OBJECTS.delete(orphan.payload_object_key);await env.DB.prepare('UPDATE risk_jobs SET payload_object_key=NULL WHERE request_id=?').bind(orphan.request_id).run()}
 await env.DB.prepare("UPDATE risk_runtime SET last_cleanup_at_ms=?,last_cleanup_deleted_hit=?,last_cleanup_deleted_non_hit=? WHERE id='global'").bind(now,results[0].meta.changes??0,results[1].meta.changes??0).run()
}
