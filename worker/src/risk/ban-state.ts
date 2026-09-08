import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import { deterministicUuid } from '../control/http'
interface Command {id:string;user_id:string;log_id:number;direction:'ban'|'unban';expected_control_version:number;expected_auth_version:number;status:string;lease_owner:string;prepared:number;prior_enabled_mutation_id:string|null}
interface User {id:string;role:string;status:string;control_version:number;auth_version:number;state_version:number;balance_micros:number}
interface Snapshot {state_version:number;last_enabled_mutation_id:string|null;profile:{user_id:string;enabled:boolean;balance_micros:number};applied?:boolean}
const conflict=()=>new GatewayError(409,'risk_ban_changed','Account restriction changed; review it in user management')
const mutation=(command:Command)=>`risk-enabled:${command.id}`
async function state(env:Env,id:string,path:string,body?:Record<string,unknown>):Promise<Response>{return env.USER_STATE.get(env.USER_STATE.idFromName(id)).fetch(new Request('https://user-state.internal'+path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema_version:1,...body})}))}
async function snapshot(response:Response,id:string):Promise<Snapshot>{if(!response.ok){if(response.status===409)throw conflict();throw new GatewayError(503,'risk_user_state_unavailable','User state is unavailable')};const value=await response.json() as Snapshot;if(!Number.isSafeInteger(value.state_version)||value.state_version<0||value.profile?.user_id!==id||typeof value.profile.enabled!=='boolean'||!Number.isSafeInteger(value.profile.balance_micros)||(value.last_enabled_mutation_id!==null&&typeof value.last_enabled_mutation_id!=='string'))throw new GatewayError(503,'risk_user_state_invalid','User state response is invalid');return value}
async function user(env:Env,id:string):Promise<User|null>{return env.DB.prepare('SELECT id,role,status,control_version,auth_version,state_version,balance_micros FROM users WHERE id=?').bind(id).first<User>()}
async function cancel(env:Env,c:Command,reason:string):Promise<void>{await env.DB.prepare("UPDATE risk_ban_commands SET status='cancelled',lease_owner=NULL,lease_expires_at_ms=0,last_error=?,updated_at_ms=? WHERE id=? AND lease_owner=?").bind(reason,Date.now(),c.id,c.lease_owner).run()}
async function compensate(env:Env,c:Command,current:Snapshot):Promise<void>{
 const claim=await env.DB.prepare("SELECT 1 FROM risk_ban_commands WHERE id=? AND status='applying' AND lease_owner=?").bind(c.id,c.lease_owner).first();if(!claim)return
 const applied=current.last_enabled_mutation_id===mutation(c)
 if(!applied&&(!c.prepared||current.last_enabled_mutation_id!==c.prior_enabled_mutation_id))return
 // Fence an undelivered old request too: a no-op enabled command changes the owner.
 const response=await state(env,c.user_id,'/enabled',{mutation_id:`${mutation(c)}:compensate`,enabled:applied?c.direction==='ban':current.profile.enabled,expected_enabled_mutation_id:current.last_enabled_mutation_id})
 if(response.status===409)return // Another administrator already owns the state.
 const restored=await snapshot(response,c.user_id)
 // This is a projection, never a fabricated state version or balance change.
 await env.DB.prepare('UPDATE users SET status=?,balance_micros=?,state_version=?,updated_at_ms=? WHERE id=? AND state_version<?').bind(restored.profile.enabled?'active':'disabled',restored.profile.balance_micros,restored.state_version,Date.now(),c.user_id,restored.state_version).run()
}
/** Runs outside the gateway's D1 query budget. Commands and DO mutations are durable and idempotent. */
export async function applyRiskBanCommand(env:Env,commandId:string):Promise<{status:string}> {
 const now=Date.now(),owner=crypto.randomUUID()
 const c=await env.DB.prepare("UPDATE risk_ban_commands SET status='applying',lease_owner=?,lease_expires_at_ms=?,updated_at_ms=? WHERE id=? AND (status='pending' OR (status='applying' AND lease_expires_at_ms<=?)) RETURNING *").bind(owner,now+60000,now,commandId,now).first<Command>()
 if(!c)return {status:'unclaimed'}
 try{
  let u=await user(env,c.user_id);if(!u){await cancel(env,c,'user_missing');return {status:'cancelled'}}
  const configured=await state(env,u.id,'/configure',{mutation_id:`d1-user:${u.state_version}`,user_id:u.id,enabled:u.status==='active',balance_micros:u.balance_micros,initial_state_version:u.state_version})
  if(!configured.ok){let code='';try{code=(await configured.json() as {error?:{code?:string}}).error?.code??''}catch{};if(code!=='user_already_configured')throw new GatewayError(503,'risk_user_state_unavailable','User state initialization failed')}
  let current=await snapshot(await state(env,u.id,'/snapshot'),u.id)
  const active=await env.DB.prepare("SELECT 1 AS ok FROM system_settings s JOIN risk_settings r ON r.id='global' WHERE s.id='global' AND json_extract(s.gateway_json,'$.risk_control_enabled')=1 AND json_extract(r.config_json,'$.enabled')=1 AND json_extract(r.config_json,'$.auto_ban_enabled')=1").first()
  const allowed=u.role!=='admin'&&u.control_version===c.expected_control_version&&u.auth_version===c.expected_auth_version&&(c.direction==='unban'||!!active)
  if(!allowed){await compensate(env,c,current);await cancel(env,c,'user_or_policy_changed');return {status:'cancelled'}}
  if(c.direction==='unban'){
   const ban=await env.DB.prepare('SELECT enabled_mutation_id FROM risk_bans WHERE user_id=? AND cleared_at_ms IS NULL AND log_id=?').bind(u.id,c.log_id).first<{enabled_mutation_id:string}>()
   if(!ban||(current.last_enabled_mutation_id!==ban.enabled_mutation_id&&current.last_enabled_mutation_id!==mutation(c))){await cancel(env,c,'restriction_owner_changed');return {status:'cancelled'}}
  }
  if(current.last_enabled_mutation_id!==mutation(c)){
   if(current.profile.enabled!==(c.direction==='ban')){await cancel(env,c,'restriction_changed');return {status:'cancelled'}}
   if(!c.prepared){
    const prepared=await env.DB.prepare("UPDATE risk_ban_commands SET prepared=1,prior_enabled_mutation_id=?,updated_at_ms=? WHERE id=? AND status='applying' AND lease_owner=?").bind(current.last_enabled_mutation_id,Date.now(),c.id,owner).run()
    if(prepared.meta.changes!==1)return {status:'unclaimed'}
    c.prepared=1;c.prior_enabled_mutation_id=current.last_enabled_mutation_id
   }
   if(current.last_enabled_mutation_id!==c.prior_enabled_mutation_id){await cancel(env,c,'restriction_owner_changed');return {status:'cancelled'}}
   current=await snapshot(await state(env,u.id,'/enabled',{mutation_id:mutation(c),enabled:c.direction==='unban',expected_enabled_mutation_id:c.prior_enabled_mutation_id}),u.id)
  }
  if(current.last_enabled_mutation_id!==mutation(c)||current.profile.enabled!==(c.direction==='unban'))throw conflict()
  const status=c.direction==='ban'?'disabled':'active',nextControl=c.expected_control_version+1,nextAuth=c.expected_auth_version+(c.direction==='ban'?1:0),at=Date.now()
  const ownUser=`EXISTS(SELECT 1 FROM users WHERE id=? AND role<>'admin' AND status=? AND control_version=? AND auth_version=?)`
  const params=[u.id,status,nextControl,nextAuth]
  const statements=[env.DB.prepare(`UPDATE users SET control_version=control_version+1,auth_version=?,status=CASE WHEN state_version<=? THEN ? ELSE status END,balance_micros=CASE WHEN state_version<=? THEN ? ELSE balance_micros END,state_version=MAX(state_version,?),updated_at_ms=? WHERE id=? AND role<>'admin' AND control_version=? AND auth_version=? AND (state_version<=? OR status=?) AND EXISTS(SELECT 1 FROM risk_ban_commands WHERE id=? AND status='applying' AND lease_owner=?) RETURNING id`).bind(nextAuth,current.state_version,status,current.state_version,current.profile.balance_micros,current.state_version,at,u.id,c.expected_control_version,c.expected_auth_version,current.state_version,status,c.id,owner)]
  if(c.direction==='ban'){
   statements.push(env.DB.prepare(`INSERT INTO risk_bans(user_id,log_id,banned_state_version,banned_control_version,enabled_mutation_id,created_at_ms,cleared_at_ms) SELECT ?,?,?,?,?,?,NULL WHERE ${ownUser} ON CONFLICT(user_id) DO UPDATE SET log_id=excluded.log_id,banned_state_version=excluded.banned_state_version,banned_control_version=excluded.banned_control_version,enabled_mutation_id=excluded.enabled_mutation_id,created_at_ms=excluded.created_at_ms,cleared_at_ms=NULL`).bind(u.id,c.log_id,current.state_version,nextControl,mutation(c),at,...params))
   statements.push(env.DB.prepare(`UPDATE user_sessions SET revoked_at_ms=?,revoke_reason='risk_user_disabled' WHERE user_id=? AND revoked_at_ms IS NULL AND ${ownUser}`).bind(at,u.id,...params))
   statements.push(env.DB.prepare(`UPDATE admin_sessions SET revoked_at_ms=? WHERE user_id=? AND revoked_at_ms IS NULL AND ${ownUser}`).bind(at,u.id,...params))
   statements.push(env.DB.prepare(`UPDATE risk_logs SET auto_banned=1 WHERE id=? AND ${ownUser}`).bind(c.log_id,...params))
   statements.push(env.DB.prepare(`INSERT OR IGNORE INTO risk_outbox(id,log_id,user_id,event,due_at_ms) SELECT ?,?,?,'risk.account_disabled',? WHERE ${ownUser}`).bind(await deterministicUuid('risk-ban-email',c.id),c.log_id,u.id,at,...params))
  }else statements.push(env.DB.prepare(`UPDATE risk_bans SET cleared_at_ms=? WHERE user_id=? AND log_id=? AND ${ownUser}`).bind(at,u.id,c.log_id,...params))
  statements.push(env.DB.prepare(`UPDATE risk_ban_commands SET status='done',applied_state_version=?,lease_owner=NULL,lease_expires_at_ms=0,last_error='',updated_at_ms=? WHERE id=? AND lease_owner=? AND ${ownUser}`).bind(current.state_version,at,c.id,owner,...params))
  const results=await env.DB.batch(statements)
  if(!results[0].results.length){const latest=await env.DB.prepare('SELECT status,lease_owner FROM risk_ban_commands WHERE id=?').bind(c.id).first<{status:string;lease_owner:string|null}>();if(latest?.status==='done')return {status:'done'};if(latest?.lease_owner!==owner)return {status:'unclaimed'};current=await snapshot(await state(env,u.id,'/snapshot'),u.id);await compensate(env,c,current);await cancel(env,c,'user_changed_during_apply');return {status:'cancelled'}}
  return {status:'done'}
 }catch(error){
  if(error instanceof GatewayError&&error.status===409){await cancel(env,c,'restriction_owner_changed');return {status:'cancelled'}}
  await env.DB.prepare("UPDATE risk_ban_commands SET status='pending',lease_owner=NULL,lease_expires_at_ms=0,last_error='user_state_apply_failed',updated_at_ms=? WHERE id=? AND lease_owner=?").bind(Date.now(),c.id,owner).run()
  return {status:'pending'}
 }
}
export async function recoverRiskBanCommands(env:Env,now=Date.now()):Promise<{attempted:number;pending:number}>{const rows=await env.DB.prepare("SELECT id FROM risk_ban_commands WHERE status='pending' OR (status='applying' AND lease_expires_at_ms<=?) ORDER BY created_at_ms,id LIMIT 2").bind(now).all<{id:string}>();let pending=0;for(const row of rows.results){if((await applyRiskBanCommand(env,row.id)).status==='pending')pending++}return {attempted:rows.results.length,pending}}
export async function requestRiskUnban(env:Env,userId:string):Promise<{user_id:string;status:string}>{
 const u=await user(env,userId),ban=await env.DB.prepare('SELECT * FROM risk_bans WHERE user_id=?').bind(userId).first<{log_id:number;enabled_mutation_id:string;banned_control_version:number;cleared_at_ms:number|null}>();if(!u)throw new GatewayError(404,'user_not_found','User not found');if(!ban||u.role==='admin')throw conflict()
 if(ban.cleared_at_ms!==null){const previousId=await deterministicUuid('risk-unban',ban.enabled_mutation_id),current=await snapshot(await state(env,userId,'/snapshot'),userId);if(u.status==='active'&&u.control_version===ban.banned_control_version+1&&current.profile.enabled&&current.last_enabled_mutation_id===`risk-enabled:${previousId}`)return {user_id:userId,status:'active'};throw conflict()}
 if(u.control_version!==ban.banned_control_version)throw conflict()
 const id=await deterministicUuid('risk-unban',ban.enabled_mutation_id),now=Date.now()
 await env.DB.prepare("INSERT OR IGNORE INTO risk_ban_commands(id,user_id,log_id,direction,expected_state_version,expected_control_version,expected_auth_version,created_at_ms,updated_at_ms) VALUES(?,?,?,'unban',?,?,?,?,?)").bind(id,userId,ban.log_id,u.state_version,u.control_version,u.auth_version,now,now).run()
 const result=await applyRiskBanCommand(env,id);if(result.status!=='done')throw result.status==='cancelled'?conflict():new GatewayError(503,'risk_unban_pending','Account state update is pending; retry shortly')
 return {user_id:userId,status:'active'}
}
