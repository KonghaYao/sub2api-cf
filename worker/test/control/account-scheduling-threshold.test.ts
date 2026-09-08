import {expect,it} from 'vitest'
import {parseOfficialQuota,thresholdPause} from '../../src/gateway/official-account-quota'
import {parseAccountSchedulingThresholds} from '../../src/control/account-scheduling-settings'
const now=Date.parse('2026-09-07T12:00:00Z')
it('uses official window data and fails closed on settings but treats absent quota as unknown',()=>{
 for(const input of [null,{openai:0},{openai:101},{openai:1.5},{gemini:50},{openai:'80'}])expect(()=>parseAccountSchedulingThresholds(input)).toThrow()
 expect(parseAccountSchedulingThresholds({openai:80})).toEqual({openai:80,anthropic:100,grok:100})
 expect(parseOfficialQuota('openai',{rate_limit:{primary_window:{used_percent:85,limit_window_seconds:18000,reset_at:(now+60000)/1000}}},now)).toEqual([{window:'5h',used_percent:85,reset_at_ms:now+60000}])
 expect(parseOfficialQuota('anthropic',{five_hour:{utilization:85,resets_at:new Date(now+60000).toISOString()}},now)).toEqual([{window:'5h',used_percent:85,reset_at_ms:now+60000}])
 expect(parseOfficialQuota('openai',{usage_5h_micros:999999999,wallet_balance:0},now)).toEqual([])
})
it('selects latest reached reset while rejecting stale, mismatched, future and disabled snapshots',()=>{
 const snapshot={identity:'secret-v1',observed_at_ms:now,windows:[{window:'5h',used_percent:80,reset_at_ms:now+60000},{window:'7d',used_percent:95,reset_at_ms:now+120000}]}
 expect(thresholdPause(snapshot,'secret-v1',80,now)).toBe(now+120000)
 expect(thresholdPause(snapshot,'secret-v2',80,now)).toBeNull()
 expect(thresholdPause(snapshot,'secret-v1',100,now)).toBeNull()
 expect(thresholdPause(snapshot,'secret-v1',80,now-1)).toBeNull()
 expect(thresholdPause({...snapshot,observed_at_ms:now-120001},'secret-v1',80,now)).toBeNull()
 expect(thresholdPause(snapshot,'secret-v1',80,now+120000)).toBeNull()
})

it('Grok uses the most constrained real rolling header window, including alias headers and bounded reset',async()=>{
 const {grokQuotaWindow}=await import('../../src/gateway/official-account-quota')
 const headers=new Headers({'x-rate-limit-limit-tokens':'100','x-rate-limit-remaining-tokens':'5','x-rate-limit-reset-tokens':'600000','x-ratelimit-limit-requests':'100','x-ratelimit-remaining-requests':'80','x-ratelimit-reset-requests':'1m'})
 expect(grokQuotaWindow(headers,now)).toEqual({window:'rolling',used_percent:95,reset_at_ms:now+25*3600000})
 expect(grokQuotaWindow(new Headers({'x-ratelimit-limit-tokens':'100','x-ratelimit-remaining-tokens':'200','x-ratelimit-reset-tokens':'1m'}),now)).toBeNull()
})
