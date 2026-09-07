import type { Env } from '../env'
import { redactDiagnosticText } from '../observability/redaction'
import { deterministicUuid } from '../control/http'
import { deliverPlatformEmail, emailDeliveryFailure } from '../email/delivery'
import { readEmailTemplate, renderTemplate, templateHTMLToText } from '../email/templates'
import { readRiskConfig, type RiskConfig } from './config'
import type { ModerationResult } from './moderator'
export type RiskInput={request_id:string;user_id:string;api_key_id:string;group_id:string|null;endpoint:string;provider:string;model:string;body:Record<string,unknown>}
export async function persistRiskResult(env:Env,config:RiskConfig,input:RiskInput,result:ModerationResult,details:{text:string;hash:string;action:string;queue_delay_ms?:number;side_effects?:boolean;created_at_ms?:number}){
 const now=Date.now(),flagged=result.flagged,sideEffects=flagged&&details.side_effects!==false,banAllowed=sideEffects&&config.auto_ban_enabled&&!(details.action==='cyber_policy'&&config.cyber_policy_exclude_from_ban_count)
 const statements:D1PreparedStatement[]=[env.DB.prepare(`INSERT INTO risk_logs(request_id,user_id,api_key_id,group_id,endpoint,provider,model,mode,action,flagged,highest_category,highest_score,matched_keyword,category_scores_json,threshold_snapshot_json,input_excerpt,input_hash,upstream_latency_ms,error,queue_delay_ms,created_at_ms)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`).bind(input.request_id,input.user_id,input.api_key_id,input.group_id,input.endpoint,input.provider,input.model,config.mode,details.action,Number(flagged),result.highest_category,result.highest_score,result.matched_keyword??'',JSON.stringify(result.category_scores),JSON.stringify(config.thresholds),[...redactDiagnosticText(details.text)].slice(0,240).join(''),details.hash,result.latency_ms,result.error,details.queue_delay_ms??null,details.created_at_ms??now)]
 if(flagged&&details.hash&&details.action!=='keyword_block'&&details.action!=='hash_block')statements.push(env.DB.prepare('INSERT INTO risk_hashes(input_hash,created_at_ms,expires_at_ms) VALUES(?,?,?) ON CONFLICT(input_hash) DO UPDATE SET expires_at_ms=MAX(risk_hashes.expires_at_ms,excluded.expires_at_ms)').bind(details.hash,now,now+config.hit_retention_days*86400000))
 if(sideEffects){
  statements.push(env.DB.prepare(`UPDATE risk_logs SET violation_count=(SELECT COUNT(*) FROM risk_logs WHERE user_id=? AND flagged=1 AND action<>'hash_block' AND created_at_ms>=? AND (?=0 OR action<>'cyber_policy')) WHERE request_id=?`).bind(input.user_id,now-config.violation_window_hours*3600000,Number(config.cyber_policy_exclude_from_ban_count),input.request_id))
  if(banAllowed){
   const commandId=await deterministicUuid('risk-ban',input.request_id)
   statements.push(env.DB.prepare(`INSERT INTO risk_ban_commands(id,user_id,log_id,direction,expected_state_version,expected_control_version,expected_auth_version,created_at_ms,updated_at_ms)
    SELECT ?,u.id,l.id,'ban',u.state_version,u.control_version,u.auth_version,?,? FROM users u JOIN risk_logs l ON l.request_id=? WHERE u.id=? AND u.status='active' AND u.role<>'admin' AND l.effects_applied=0 AND l.violation_count>=?
    ON CONFLICT(id) DO NOTHING`).bind(commandId,now,now,input.request_id,input.user_id,config.ban_threshold))
  }
  if(config.email_on_hit){const id=await deterministicUuid('risk-email',input.request_id);statements.push(env.DB.prepare(`INSERT INTO risk_outbox(id,log_id,user_id,event,due_at_ms) SELECT ?,id,user_id,CASE WHEN auto_banned=1 THEN 'risk.account_disabled' ELSE 'risk.violation' END,? FROM risk_logs WHERE request_id=? AND (?=1 OR auto_banned=1) ON CONFLICT(id) DO NOTHING`).bind(id,now,input.request_id,Number(config.email_on_hit)))}
 }
 statements.push(env.DB.prepare('UPDATE risk_logs SET effects_applied=1 WHERE request_id=?').bind(input.request_id))
 await env.DB.batch(statements)
}
export async function deliverRiskNotifications(env:Env,now=Date.now()){
 const config=await readRiskConfig(env),owner=crypto.randomUUID(),row=await env.DB.prepare(`UPDATE risk_outbox SET lease_owner=?,lease_expires_at_ms=? WHERE id=(SELECT id FROM risk_outbox WHERE sent_at_ms IS NULL AND due_at_ms<=? AND lease_expires_at_ms<=? ORDER BY due_at_ms,id LIMIT 1) RETURNING *`).bind(owner,now+60000,now,now).first<Record<string,any>>();if(!row)return
 try{
  const log=await env.DB.prepare(`SELECT l.*,u.email,u.display_name,u.status AS user_status,b.cleared_at_ms,b.log_id AS ban_log_id FROM risk_logs l JOIN users u ON u.id=l.user_id LEFT JOIN risk_bans b ON b.user_id=u.id WHERE l.id=?`).bind(row.log_id).first<Record<string,any>>()
  const enabled=(await env.DB.prepare("SELECT json_extract(gateway_json,'$.risk_control_enabled') AS enabled FROM system_settings WHERE id='global'").first<{enabled:number}>())?.enabled===1
  if(!log||!enabled||row.event==='risk.violation'&&!config.email_on_hit||row.event==='risk.account_disabled'&&(log.user_status!=='disabled'||log.cleared_at_ms!==null||log.ban_log_id!==log.id)){await env.DB.prepare("UPDATE risk_outbox SET sent_at_ms=?,last_error='cancelled_by_current_policy' WHERE id=? AND lease_owner=?").bind(now,row.id,owner).run();return}
  const event=row.event==='risk.account_disabled'?'content_moderation.account_disabled':'content_moderation.violation_notice',site=await env.DB.prepare("SELECT json_extract(public_json,'$.site_name') AS name FROM system_settings WHERE id='global'").first<{name:string}>()
  let subject=row.event==='risk.account_disabled'?'账户已被风控禁用':'账户触发风险审核规则',html=`<p>${subject}</p><p>Request ID: ${String(log.request_id).replace(/[&<>"']/g,'')}</p><p>累计命中：${log.violation_count}</p>`
  try{const template=await readEmailTemplate(env,event,'zh'),rendered=renderTemplate(template,{site_name:site?.name??'Sub2API',recipient_name:log.display_name,recipient_email:log.email,request_id:log.request_id,violation_count:String(log.violation_count),ban_threshold:String(config.ban_threshold),moderation_category:log.highest_category,moderation_score:String(log.highest_score),triggered_at:new Date(log.created_at_ms).toISOString(),group_name:log.group_id??'-',model:log.model});subject=rendered.subject;html=rendered.html}catch{/* Built-in content contains no user prompt or credentials. */}
  const text=templateHTMLToText(html)
  await deliverPlatformEmail({eventId:row.id,recipient:log.email,subject,html,text,compatibilityPayload:{purpose:'risk_notification',recipient:log.email,subject,text,html,event_id:row.id}},env)
  await env.DB.batch([env.DB.prepare("UPDATE risk_outbox SET sent_at_ms=?,attempts=attempts+1,last_error='' WHERE id=? AND lease_owner=?").bind(now,row.id,owner),env.DB.prepare('UPDATE risk_logs SET email_sent=1 WHERE id=?').bind(row.log_id)])
 }catch(error){const failure=emailDeliveryFailure(error);await env.DB.prepare('UPDATE risk_outbox SET attempts=attempts+1,last_error=?,due_at_ms=?,sent_at_ms=? WHERE id=? AND lease_owner=?').bind(failure.code,now+Math.min(3600000,60000*2**Math.min(row.attempts,6)),failure.retryable?null:now,row.id,owner).run()}
 finally{await env.DB.prepare('UPDATE risk_outbox SET lease_owner=NULL,lease_expires_at_ms=0 WHERE id=? AND lease_owner=?').bind(row.id,owner).run()}
}
