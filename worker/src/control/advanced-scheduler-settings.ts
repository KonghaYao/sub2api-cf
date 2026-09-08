import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import type { PoolSchedulerPolicy } from '../shared/state-machine/pool-scheduler'
export const schedulerDefaults = {
  openai_low_upstream_rate_priority_enabled: false,
  openai_oauth_scheduling_rate_multiplier: 1,
  openai_advanced_scheduler_enabled: false,
  openai_advanced_scheduler_sticky_weighted_enabled: false,
  openai_advanced_scheduler_lb_top_k: '',
  openai_advanced_scheduler_weight_priority: '',
  openai_advanced_scheduler_weight_load: '',
  openai_advanced_scheduler_weight_error_rate: '',
  openai_advanced_scheduler_weight_ttft: '',
  openai_advanced_scheduler_weight_session_sticky: '',
  openai_advanced_scheduler_weight_queue: '',
  openai_advanced_scheduler_weight_reset: '',
  openai_advanced_scheduler_weight_quota_headroom: '',
  openai_advanced_scheduler_weight_upstream_cost: '',
  openai_advanced_scheduler_weight_previous_response: '',
}
export type SchedulerSettings = typeof schedulerDefaults
const unsupported:readonly string[] = []
const defaults = {priority:1,load:1,error_rate:0.8,ttft:0.5,session_sticky:3,upstream_cost:0,previous_response:5,reset:0,quota_headroom:0,queue:0.7}
function invalid(key:string):never {throw new GatewayError(400,'invalid_settings',`Invalid advanced scheduler setting: ${key}`)}
export function parseSchedulerSettingsPatch(value: unknown): Partial<SchedulerSettings> {
  if(!value || typeof value!=='object' || Array.isArray(value)) invalid('scheduler')
  const result:Record<string,unknown>={}
  for(const [key,item] of Object.entries(value as Record<string,unknown>)) {
    if(!(key in schedulerDefaults)) invalid(key)
    if(typeof item !== typeof schedulerDefaults[key as keyof SchedulerSettings]) invalid(key)
    if(typeof item==='number' && (!Number.isFinite(item) || item<0 || item>1000000)) invalid(key)
    if(typeof item==='string') {
      if(item.length>32 || (item!=='' && (!/^\d+(?:\.\d+)?$/.test(item) || !Number.isFinite(Number(item)) || Number(item)>1000000))) invalid(key)
      if(key.endsWith('lb_top_k') && item!=='' && (!Number.isInteger(Number(item)) || Number(item)<1 || Number(item)>100)) invalid(key)
      if(unsupported.some(k=>key===`openai_advanced_scheduler_weight_${k}`) && item!=='' && Number(item)!==0) throw new GatewayError(400,'unsupported_scheduler_metric',`Worker does not yet collect ${key}; a nonzero weight cannot be applied`)
    }
    result[key]=item
  }
  return result
}
export function normalizeSchedulerSettings(value:unknown):SchedulerSettings {
  const result={...schedulerDefaults,...parseSchedulerSettingsPatch(value ?? {})}
  schedulerPolicy(result)
  return result
}
export function schedulerPolicy(value:SchedulerSettings):PoolSchedulerPolicy {
  const weights={...defaults}
  for(const key of Object.keys(weights) as Array<keyof typeof weights>) {
    const item=value[`openai_advanced_scheduler_weight_${key}`]
    if(item!=='') weights[key]=Number(item)
  }
  if(weights.priority+weights.load+weights.error_rate+weights.ttft+weights.upstream_cost+weights.reset+weights.quota_headroom+weights.queue<=0) invalid('base_weights')
  return {legacy_low_rate_priority:value.openai_low_upstream_rate_priority_enabled,enabled:value.openai_advanced_scheduler_enabled,sticky_weighted:value.openai_advanced_scheduler_sticky_weighted_enabled,top_k:Number(value.openai_advanced_scheduler_lb_top_k||7),weights}
}
export function schedulerEffectiveSettings(value:SchedulerSettings):Record<string,string> {
 const policy=schedulerPolicy(value)
 return Object.fromEntries([
  ['openai_advanced_scheduler_effective_lb_top_k',String(policy.top_k)],
  ...Object.entries(policy.weights).map(([k,v])=>[`openai_advanced_scheduler_effective_weight_${k}`,String(v)]),
  ...unsupported.map(k=>[`openai_advanced_scheduler_effective_weight_${k}`,'0']),
 ])
}
export async function loadSchedulerPolicy(env:Env):Promise<PoolSchedulerPolicy> {
  const row=await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<{gateway_json:string}>()
  const source=row?.gateway_json ? JSON.parse(row.gateway_json) : {}
  return schedulerPolicy(normalizeSchedulerSettings(Object.fromEntries(Object.entries(source).filter(([k])=>k in schedulerDefaults))))
}
