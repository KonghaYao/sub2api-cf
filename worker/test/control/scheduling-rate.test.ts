import {expect,it} from 'vitest'
import {freshUpstreamRate,accountSchedulingRates} from '../../src/gateway/scheduling-rate'
import {normalizeSchedulerSettings,schedulerPolicy} from '../../src/control/advanced-scheduler-settings'
import {applyPoolCommand,createPoolMachineState} from '../../src/shared/state-machine/pool'
import type {AccountCandidate} from '../../src/gateway/types'
const now=Date.parse('2026-09-07T12:00:00Z')
const snapshot=(extra:Record<string,unknown>={})=>JSON.stringify({status:'ok',received_at:new Date(now-1000).toISOString(),fresh_until:new Date(now+1000).toISOString(),data:{billing_scope:'token',resolved_rate_multiplier:0.5,peak_rate_enabled:false},...extra})
it('accepts only fresh actual upstream token rates and recomputes peak at dispatch time',()=>{
 expect(freshUpstreamRate(snapshot(),now)).toBe(.5)
 expect(freshUpstreamRate(snapshot({status:'failed'}),now)).toBe(.5)
 expect(freshUpstreamRate(snapshot(),now+1001)).toBeNull()
 expect(freshUpstreamRate(snapshot(),now-1001)).toBeNull()
 expect(freshUpstreamRate(snapshot({data:{billing_scope:'subscription',resolved_rate_multiplier:.5,peak_rate_enabled:false}}),now)).toBeNull()
 const peak=snapshot({data:{billing_scope:'token',resolved_rate_multiplier:.5,peak_rate_enabled:true,peak_start:'20:00',peak_end:'21:00',timezone:'Asia/Shanghai',peak_rate_multiplier:2,effective_rate_multiplier:999}})
 expect(freshUpstreamRate(peak,now)).toBe(1)
 expect(freshUpstreamRate(peak,now-1)).toBe(.5)
})
it('OAuth reference never mutates local billing and non-OpenAI platforms remain excluded',()=>{
 const candidate=(account_id:string,platform:string,credential_kind:string)=>({account_id,platform,credential_kind,billing_rate_multiplier_ppm:777000,upstream_billing_probe_json:snapshot()}) as AccountCandidate
 const accounts=[candidate('oauth','codex','oauth'),candidate('key','openai','api_key'),candidate('claude','anthropic','oauth'),candidate('gemini','gemini','api_key')]
 expect(accountSchedulingRates(accounts,2,now)).toEqual({oauth:2000000,key:500000})
 expect(accounts.every(a=>a.billing_rate_multiplier_ppm===777000)).toBe(true)
 const stale={...accounts[1]!,upstream_billing_probe_json:null}
 expect(accountSchedulingRates([stale],1,now)).toEqual({})
 for(const value of [-1,Infinity,NaN,'1',1000001])expect(()=>normalizeSchedulerSettings({openai_oauth_scheduling_rate_multiplier:value})).toThrow()
})
it('legacy lower price precedes priority only with two distinct known rates; stickiness and capacity remain enforced',()=>{
 let state=createPoolMachineState()
 for(const [account_id,priority]of [['costly',1],['cheap',10],['unknown',0]] as const)state=applyPoolCommand(state,{schema_version:1,type:'upsert_account',account_id,enabled:true,max_concurrency:1,priority},1000).state
 const command={schema_version:1 as const,type:'reserve' as const,request_id:'select',lease_ttl_ms:60000,scheduler:schedulerPolicy(normalizeSchedulerSettings({openai_low_upstream_rate_priority_enabled:true})),account_cost_rates:{costly:2000000,cheap:500000}}
 expect(applyPoolCommand(state,command,1001).lease?.account_id).toBe('cheap')
 expect(applyPoolCommand(state,{...command,account_cost_rates:{cheap:500000}},1001).lease?.account_id).toBe('unknown')
 expect(applyPoolCommand(state,{...command,scheduler:{...command.scheduler,legacy_low_rate_priority:false}},1001).lease?.account_id).toBe('unknown')
 expect(applyPoolCommand(state,{...command,preferred_account_id:'costly'},1001).lease?.account_id).toBe('costly')
 state=applyPoolCommand(state,command,1001).state
 expect(applyPoolCommand(state,{...command,request_id:'next'},1002).lease?.account_id).toBe('unknown')
})
