import { expect, it } from 'vitest'
import { buildAccountProviderRequest } from '../../src/gateway/account-provider-request'
import { claudeTextDiagnosticRequest } from '../../src/control/claude-text-diagnostic'
const account={platform:'anthropic' as const,protocol:'anthropic' as const,auth_scheme:'x-api-key' as const,base_url:'https://api.anthropic.com',provider_config:{}}
const credential={api_key:'obsolete-key',access_token:'saved-token'}
it.each(['oauth','setup_token'] as const)('authenticates %s messages with the saved token and preserves caller content',kind=>{
  const body={model:'claude-sonnet-4-6',messages:[{role:'user',content:'hello'}],system:'Keep the original system',max_tokens:10,stream:true}
  const plan=buildAccountProviderRequest({account:{...account,credential_kind:kind},credential,operation:'messages',model:body.model,body,
    client_headers:{'anthropic-beta':'claude-code-20250219,custom-beta','authorization':'Bearer user-secret','x-api-key':'client-secret'}})
  expect(plan.headers.get('authorization')).toBe('Bearer saved-token')
  expect(plan.headers.has('x-api-key')).toBe(false)
  expect(plan.headers.get('anthropic-beta')).toBe('claude-code-20250219,oauth-2025-04-20,custom-beta')
  expect(plan.body).toMatchObject(body)
  expect(plan.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
})
it.each(['oauth','setup_token'] as const)('uses the token executor for %s modal diagnostics',kind=>{
  const plan=claudeTextDiagnosticRequest(account,credential,'claude-sonnet-4-6',false,kind)
  expect(plan.headers.get('authorization')).toBe('Bearer saved-token')
  expect(plan.headers.has('x-api-key')).toBe(false)
  expect(plan.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
  expect(plan.body).toMatchObject({system:[{text:"You are Claude Code, Anthropic's official CLI for Claude."}],stream:true})
})
it('uses token-counting defaults and retains the original Haiku beta distinction',()=>{
  for(const operation of ['messages','count_tokens'] as const){
    const plan=buildAccountProviderRequest({account:{...account,credential_kind:'oauth'},credential,operation,model:'claude-haiku-4-5',body:{messages:[{role:'user',content:'hi'}]}})
    expect(plan.headers.get('anthropic-beta')).toBe(operation==='messages'?'oauth-2025-04-20,interleaved-thinking-2025-05-14':'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,token-counting-2024-11-01')
  }
})
it('rejects missing access_token rather than using an unrelated API-key secret',()=>{
  expect(()=>buildAccountProviderRequest({account:{...account,credential_kind:'oauth'},credential:{api_key:'unrelated'},operation:'messages',model:'claude-sonnet-4-6',body:{}}))
    .toThrow('requires access_token')
})
it('keeps API-key authentication unchanged',()=>{
  const plan=buildAccountProviderRequest({account:{...account,credential_kind:'api_key'},credential,operation:'messages',model:'claude-sonnet-4-6',body:{}})
  expect(plan.headers.get('x-api-key')).toBe('obsolete-key')
  expect(plan.headers.has('authorization')).toBe(false)
})
