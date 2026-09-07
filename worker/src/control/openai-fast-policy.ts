import { GatewayError } from '../gateway/errors'
export type FastAction='pass'|'filter'|'block'|'force_priority'
export interface OpenAIFastRule {
 service_tier:'all'|'priority'|'flex'|'auto'|'default'|'scale'
 action:FastAction
 scope:'all'|'oauth'|'apikey'
 user_ids?:string[]
 error_message?:string
 model_whitelist?:string[]
 fallback_action?:FastAction
 fallback_error_message?:string
}
export interface OpenAIFastPolicy {rules:OpenAIFastRule[]}
export const fastPolicyDefaults={openai_fast_policy_settings:{rules:[]} as OpenAIFastPolicy}
const actions=['pass','filter','block','force_priority']
function invalid():never{throw new GatewayError(400,'invalid_openai_fast_policy','Invalid OpenAI service tier policy')}
export function normalizeOpenAIFastPolicy(value:unknown):OpenAIFastPolicy {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='rules'))invalid()
 const rules=(value as OpenAIFastPolicy).rules
 if(!Array.isArray(rules)||rules.length>100)invalid()
 return {rules:rules.map(rule=>{
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).some(k=>!['service_tier','action','scope','user_ids','error_message','model_whitelist','fallback_action','fallback_error_message'].includes(k)))invalid()
  if(!['all','priority','flex','auto','default','scale'].includes(rule.service_tier)||!actions.includes(rule.action)||!['all','oauth','apikey'].includes(rule.scope))invalid()
  if(rule.fallback_action!==undefined&&!actions.includes(rule.fallback_action))invalid()
  for(const key of ['error_message','fallback_error_message'] as const)if(rule[key]!==undefined&&(typeof rule[key]!=='string'||rule[key].length>1024||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(rule[key])))invalid()
  if(rule.user_ids!==undefined&&(!Array.isArray(rule.user_ids)||rule.user_ids.length>100||rule.user_ids.some(id=>typeof id!=='string'||!id||id.length>128||!/^[a-zA-Z0-9_-]+$/.test(id))))invalid()
  if(rule.model_whitelist!==undefined&&(!Array.isArray(rule.model_whitelist)||rule.model_whitelist.length>100||rule.model_whitelist.some(model=>typeof model!=='string'||!model||model.length>256||/[\s\x00-\x1f]/.test(model)||model.slice(0,-1).includes('*'))))invalid()
  return {...rule,...(rule.user_ids?{user_ids:[...new Set(rule.user_ids)]}:{}),...(rule.model_whitelist?{model_whitelist:[...new Set(rule.model_whitelist)]}:{})}
 })}
}
/** Trusted user exceptions precede global rules; configured order is retained within each group. */
export function evaluateOpenAIFastPolicy(policy:OpenAIFastPolicy,userId:string,kind:string,model:string,tier:unknown):{action:FastAction;message?:string} {
 if(typeof tier!=='string'||!tier)return {action:'pass'}
 for(const userScoped of [true,false])for(const rule of policy.rules){
  const ids=rule.user_ids??[]
  if((ids.length>0)!==userScoped||(ids.length>0&&!ids.includes(userId)))continue
  if(rule.scope!=='all'&&rule.scope!==(kind==='oauth'?'oauth':'apikey'))continue
  if(rule.service_tier!=='all'&&rule.service_tier!==tier)continue
  const models=rule.model_whitelist??[]
  const matches=models.length===0||models.some(pattern=>pattern.endsWith('*')?model.startsWith(pattern.slice(0,-1)):model===pattern)
  return matches?{action:rule.action,message:rule.error_message}:{action:rule.fallback_action??'pass',message:rule.fallback_error_message}
 }
 return {action:'pass'}
}
export function applyOpenAIFastPolicy(policy:OpenAIFastPolicy,userId:string,kind:string,model:string,body:Record<string,unknown>):Record<string,unknown> {
 const decision=evaluateOpenAIFastPolicy(policy,userId,kind,model,body.service_tier)
 if(decision.action==='block')throw new GatewayError(403,'openai_service_tier_blocked',decision.message||'Requested OpenAI service tier is blocked by policy')
 const output={...body}
 if(decision.action==='filter')delete output.service_tier
 else if(decision.action==='force_priority')output.service_tier='priority'
 return output
}
