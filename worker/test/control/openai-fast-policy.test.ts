import {expect,it} from 'vitest'
import {normalizeOpenAIFastPolicy,evaluateOpenAIFastPolicy,applyOpenAIFastPolicy} from '../../src/control/openai-fast-policy'
import {normalizeGatewaySettings} from '../../src/control/gateway-settings'
it('prioritizes trusted user rules over globals while preserving first-match and scope',()=>{
 const policy=normalizeOpenAIFastPolicy({rules:[
  {service_tier:'all',scope:'all',action:'block'},
  {service_tier:'priority',scope:'oauth',action:'pass',user_ids:['user-uuid'],model_whitelist:['gpt-5*'],fallback_action:'filter'},
 ]})
 expect(evaluateOpenAIFastPolicy(policy,'user-uuid','oauth','gpt-5.5','priority').action).toBe('pass')
 expect(evaluateOpenAIFastPolicy(policy,'user-uuid','oauth','gpt-4','priority').action).toBe('filter')
 expect(evaluateOpenAIFastPolicy(policy,'other-user','oauth','gpt-5.5','priority').action).toBe('block')
 expect(evaluateOpenAIFastPolicy(policy,'user-uuid','api_key','gpt-5.5','priority').action).toBe('block')
 expect(evaluateOpenAIFastPolicy(policy,'user-uuid','oauth','gpt-5.5',undefined).action).toBe('pass')
})
it('filters or forces the actual body without mutating the original; rejects numeric user IDs and unsupported scope',()=>{
 const body={service_tier:'flex',model:'gpt'}
 const policy=(action:string)=>normalizeOpenAIFastPolicy({rules:[{service_tier:'all',scope:'all',action}]})
 expect(applyOpenAIFastPolicy(policy('filter'),'u','api_key','gpt',body)).toEqual({model:'gpt'})
 expect(applyOpenAIFastPolicy(policy('force_priority'),'u','api_key','gpt',body)).toEqual({...body,service_tier:'priority'})
 expect(body.service_tier).toBe('flex')
 expect(()=>applyOpenAIFastPolicy(policy('block'),'u','api_key','gpt',body)).toThrow('blocked')
 for(const patch of [{user_ids:[1]},{scope:'bedrock'},{action:'ignore'},{model_whitelist:['gpt*bad']},{unexpected:true}])expect(()=>normalizeOpenAIFastPolicy({rules:[{service_tier:'all',scope:'all',action:'pass',...patch}]})).toThrow()
 expect(normalizeGatewaySettings({openai_fast_policy_settings:policy('filter')}).openai_fast_policy_settings).toEqual(policy('filter'))
})
