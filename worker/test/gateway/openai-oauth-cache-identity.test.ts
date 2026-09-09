import {expect,it} from 'vitest'
import {applyNativeOpenAIOAuthCacheIdentity,openAIOAuthCredentialNamespace} from '../../src/gateway/openai-oauth-cache-identity'
import type {ProviderRequestPlan} from '../../src/gateway/providers'
const account={platform:'openai' as const,credential_kind:'oauth' as const,provider_config:{}}
const body={input:[{role:'user',content:'Stable prompt'}],prompt_cache_key:'client-session',client_metadata:{session_id:'client-session',thread_id:'thread',turn_id:'turn','x-codex-turn-metadata':JSON.stringify({session_id:'client-session',turn_id:'turn'})}}
async function prepare(credential:Record<string,unknown>,apiKeyId='tenant',override={}){
 const plan:ProviderRequestPlan={url:'https://chatgpt.com/backend-api/codex/responses',method:'POST',headers:new Headers({session_id:'untrusted',conversation_id:'untrusted'}),body,timeout_ms:30000}
 await applyNativeOpenAIOAuthCacheIdentity(plan,{...account,...override},credential,apiKeyId)
 return plan
}
it('materializes stable native OAuth sessions and preserves the prompt across token refresh',async()=>{
 const a=await prepare({chatgpt_account_id:'upstream',chatgpt_user_id:'user',access_token:'old'})
 const b=await prepare({chatgpt_account_id:'upstream',chatgpt_user_id:'user',access_token:'new'})
 expect(a.body).toEqual(b.body);expect([...a.headers]).toEqual([...b.headers])
 expect(a.headers.get('session_id')).toMatch(/^[a-f0-9]{16}$/)
 expect(a.headers.get('conversation_id')).toBe(a.headers.get('session_id'))
 const projected=a.body as any
 expect(projected.input).toEqual(body.input)
 expect(projected.prompt_cache_key).toBe(projected.client_metadata.session_id)
 expect(JSON.parse(projected.client_metadata['x-codex-turn-metadata']).session_id).toBe(projected.client_metadata.session_id)
 expect(body.prompt_cache_key).toBe('client-session')
 for(const c of [await prepare({chatgpt_account_id:'other'}),await prepare({chatgpt_account_id:'upstream',chatgpt_user_id:'user'},'other-tenant')]){
  expect(c.headers.get('session_id')).not.toBe(a.headers.get('session_id'))
  expect((c.body as any).prompt_cache_key).not.toBe(projected.prompt_cache_key)
 }
})
it('uses persistent credential identity sources and never a local row ID',async()=>{
 const seed='12345678-1234-4234-8234-123456789abc'
 expect(await openAIOAuthCredentialNamespace({...account,runtime_snapshot:{config_version:1,control_version:1,ui_config_json:JSON.stringify({extra:{codex_fingerprint_seed:seed}})}},{})).toBe('seed:'+seed)
 expect(await openAIOAuthCredentialNamespace(account,{access_token:'rotating-oauth-token'})).toBe('')
 expect(await openAIOAuthCredentialNamespace({...account,credential_kind:'setup_token'},{access_token:'setup-secret'})).toMatch(/^setup-token:[a-f0-9]{32}$/)
 const a=await prepare({},'tenant',{account_id:'local-a'}),b=await prepare({},'tenant',{account_id:'local-b'})
 expect([...a.headers]).toEqual([...b.headers]);expect(a.body).toEqual(body)
})
it('leaves API-Key requests alone and does not manufacture a missing OAuth cache key',async()=>{
 const plan=await prepare({},'tenant',{credential_kind:'api_key'})
 expect(plan.body).toBe(body);expect(plan.headers.get('session_id')).toBe('untrusted')
 const empty:ProviderRequestPlan={url:'https://chatgpt.com',method:'POST',body:{input:'hi'},headers:new Headers({session_id:'untrusted',conversation_id:'untrusted'}),timeout_ms:30000}
 await applyNativeOpenAIOAuthCacheIdentity(empty,account,{chatgpt_account_id:'upstream'},'tenant')
 expect(empty.headers.has('session_id')).toBe(false);expect(empty.headers.has('conversation_id')).toBe(false)
 expect(empty.body).toEqual({input:'hi'})
})
