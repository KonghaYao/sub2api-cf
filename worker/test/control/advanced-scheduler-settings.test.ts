import {expect,it} from 'vitest'
import {normalizeSchedulerSettings,schedulerEffectiveSettings,schedulerPolicy} from '../../src/control/advanced-scheduler-settings'
import {FirstTokenTimer,upstreamQuotaSnapshot,canMovePreviousResponse} from '../../src/gateway/scheduler-telemetry'
import {applyPoolCommand,createPoolMachineState} from '../../src/shared/state-machine/pool'
it('validates every numeric override and requires a nonzero base-score sum',()=>{
 const defaults=normalizeSchedulerSettings({})
 expect(schedulerEffectiveSettings(defaults)).toMatchObject({openai_advanced_scheduler_effective_weight_queue:'0.7',openai_advanced_scheduler_effective_lb_top_k:'7'})
 for(const value of [-1,'NaN','Infinity','1e309','-1','1.5','0'])expect(()=>normalizeSchedulerSettings({openai_advanced_scheduler_lb_top_k:value})).toThrow()
 for(const metric of ['queue','reset','quota_headroom','upstream_cost','previous_response'])expect(normalizeSchedulerSettings({[`openai_advanced_scheduler_weight_${metric}`]:'1'})).toHaveProperty(`openai_advanced_scheduler_weight_${metric}`,'1')
 expect(()=>normalizeSchedulerSettings(Object.fromEntries(['priority','load','error_rate','ttft','queue'].map(k=>[`openai_advanced_scheduler_weight_${k}`,'0'])))).toThrow()
})
it('times split generated tokens, excluding roles, heartbeat, usage and error frames',()=>{
 const timer=new FirstTokenTimer(1000),enc=new TextEncoder()
 timer.push(enc.encode(':ping\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"usage":{"output_tokens":1}}\n\n'),1100)
 expect(timer.firstTokenMs).toBeNull()
 timer.push(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"a'),1200)
 timer.push(enc.encode('b"}}]}\n\n'),1250)
 expect(timer.firstTokenMs).toBe(250)
 timer.push(enc.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'),1500)
 expect(timer.firstTokenMs).toBe(250)
})
it('uses load weights across priorities and moves weighted affinity only when its score loses',()=>{
 let state=createPoolMachineState()
 for(const [account_id,priority] of [['a',0],['b',10]] as const)state=applyPoolCommand(state,{schema_version:1,type:'upsert_account',account_id,enabled:true,max_concurrency:2,priority},1000).state
 const affinity_key='a'.repeat(64)
 state=applyPoolCommand(state,{schema_version:1,type:'reserve',request_id:'busy',lease_ttl_ms:60000,preferred_account_id:'a',affinity_key,affinity_ttl_ms:60000},1001).state
 const policy=schedulerPolicy(normalizeSchedulerSettings({openai_advanced_scheduler_enabled:true,openai_advanced_scheduler_sticky_weighted_enabled:true,openai_advanced_scheduler_lb_top_k:'1',openai_advanced_scheduler_weight_priority:'0',openai_advanced_scheduler_weight_load:'1',openai_advanced_scheduler_weight_error_rate:'0',openai_advanced_scheduler_weight_ttft:'0',openai_advanced_scheduler_weight_session_sticky:'0'}))
 const command={schema_version:1 as const,type:'reserve' as const,request_id:'pick',lease_ttl_ms:60000,affinity_key,affinity_ttl_ms:60000,scheduler:policy}
 expect(applyPoolCommand(state,command,1002).lease?.account_id).toBe('b')
 policy.weights.session_sticky=3
 expect(applyPoolCommand(state,command,1002).lease?.account_id).toBe('a')
})

it('prefers real lower upstream billing rates without modifying the customer price',()=>{
 let state=createPoolMachineState()
 for(const account_id of ['expensive','cheap'])state=applyPoolCommand(state,{schema_version:1,type:'upsert_account',account_id,enabled:true,max_concurrency:1},1000).state
 const policy=schedulerPolicy(normalizeSchedulerSettings({openai_advanced_scheduler_enabled:true,openai_advanced_scheduler_lb_top_k:'1',openai_advanced_scheduler_weight_priority:'0',openai_advanced_scheduler_weight_load:'0',openai_advanced_scheduler_weight_error_rate:'0',openai_advanced_scheduler_weight_ttft:'0',openai_advanced_scheduler_weight_upstream_cost:'1'}))
 expect(applyPoolCommand(state,{schema_version:1,type:'reserve',request_id:'cost',lease_ttl_ms:60000,scheduler:policy,account_cost_rates:{expensive:1000000,cheap:500000}},1001).lease?.account_id).toBe('cheap')
})

it('reads actual upstream quota headers and rejects fabricated or expired windows',()=>{
 expect(upstreamQuotaSnapshot(new Headers({'x-ratelimit-limit-tokens':'1000','x-ratelimit-remaining-tokens':'900','x-ratelimit-reset-tokens':'1m30s'}),1000)).toEqual({headroom:0.9,reset_at_ms:91000,observed_at_ms:1000})
 expect(upstreamQuotaSnapshot(new Headers({'x-ratelimit-limit-tokens':'1000','x-ratelimit-remaining-tokens':'1001','x-ratelimit-reset-tokens':'1s'}),1000)).toBeNull()
 expect(upstreamQuotaSnapshot(new Headers(),1000)).toBeNull()
 expect(canMovePreviousResponse({input:[{type:'function_call_output',call_id:'missing'}]})).toBe(false)
 expect(canMovePreviousResponse({input:[{role:'assistant',content:'context'},{type:'function_call',call_id:'a'},{type:'function_call_output',call_id:'a'}]})).toBe(true)
})
