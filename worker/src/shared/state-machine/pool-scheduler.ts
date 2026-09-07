export interface PoolSchedulerPolicy {
  legacy_low_rate_priority?: boolean
  enabled: boolean
  sticky_weighted: boolean
  top_k: number
  weights: { priority: number; load: number; error_rate: number; ttft: number; session_sticky: number; upstream_cost?: number; previous_response?:number; reset?:number; quota_headroom?:number; queue?:number }
}
export interface PoolSchedulerMetric { error_rate: number; ttft_ms: number | null; quota_headroom?:number; quota_reset_at_ms?:number; queue_depth?:number }
export function parsePoolSchedulerPolicy(value: unknown): PoolSchedulerPolicy {
  const p = value as PoolSchedulerPolicy
  if (!p || typeof p !== 'object' || Object.keys(p).some(k=>!['enabled','sticky_weighted','top_k','weights','legacy_low_rate_priority'].includes(k)) ||
    (p.legacy_low_rate_priority!==undefined && typeof p.legacy_low_rate_priority!=='boolean') ||
    typeof p.enabled !== 'boolean' || typeof p.sticky_weighted !== 'boolean' || !Number.isSafeInteger(p.top_k) || p.top_k < 1 || p.top_k > 100 ||
    !p.weights || typeof p.weights !== 'object' || Object.keys(p.weights).some(k=>!['priority','load','error_rate','ttft','session_sticky','upstream_cost','previous_response','reset','quota_headroom','queue'].includes(k)) ||
    ['priority','load','error_rate','ttft','session_sticky'].some(k=>!Number.isFinite(p.weights[k as keyof typeof p.weights]) || p.weights[k as keyof typeof p.weights]! < 0 || p.weights[k as keyof typeof p.weights]! > 1000000) ||
    ['reset','quota_headroom','queue'].some(k=>p.weights[k as 'reset'|'quota_headroom'|'queue']!==undefined && (!Number.isFinite(p.weights[k as 'reset'|'quota_headroom'|'queue']) || p.weights[k as 'reset'|'quota_headroom'|'queue']!<0 || p.weights[k as 'reset'|'quota_headroom'|'queue']!>1000000)) ||
    (p.weights.previous_response !== undefined && (!Number.isFinite(p.weights.previous_response) || p.weights.previous_response<0 || p.weights.previous_response>1000000)) ||
    (p.weights.upstream_cost !== undefined && (!Number.isFinite(p.weights.upstream_cost) || p.weights.upstream_cost < 0 || p.weights.upstream_cost > 1000000)) ||
    p.weights.priority+p.weights.load+p.weights.error_rate+p.weights.ttft+(p.weights.upstream_cost??0)+(p.weights.reset??0)+(p.weights.quota_headroom??0)+(p.weights.queue??0) <= 0) throw new Error('Invalid advanced scheduler policy')
  return p
}
/** Deterministic request-seeded draw: retries of the same lease select identically. */
export function schedulerDraw(requestId: string): number {
  let hash=2166136261
  for(let i=0;i<requestId.length;i++) hash=Math.imul(hash^requestId.charCodeAt(i),16777619)
  return (hash>>>0)/4294967296
}

/** Go's log-median upstream billing-rate factor; unknown accounts remain neutral. */
export function upstreamCostFactors(accountIds:string[],rates:Record<string,number>):Record<string,number> {
 const samples=accountIds.filter(id=>Number.isFinite(rates[id])&&rates[id]>=0).map(id=>({id,rate:rates[id]}))
 const output:Record<string,number>=Object.fromEntries(accountIds.map(id=>[id,0.5]))
 if(samples.length<2 || samples.every(s=>s.rate===samples[0]!.rate))return output
 const logs=samples.filter(s=>s.rate>0).map(s=>Math.log(s.rate)).sort((a,b)=>a-b)
 if(logs.length===0)return output
 const middle=Math.floor(logs.length/2),center=Math.exp(logs.length%2?logs[middle]!:(logs[middle-1]!+logs[middle]!)/2)
 const coverage=samples.length/accountIds.length
 for(const s of samples)output[s.id]=0.5+coverage*((s.rate===0?1:1/(1+s.rate/center))-0.5)
 return output
}
