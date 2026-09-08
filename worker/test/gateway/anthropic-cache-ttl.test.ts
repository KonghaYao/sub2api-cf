import { expect, it } from 'vitest'
import { injectCacheTtl, resolveCacheTtlTarget, overrideCacheTtlUsage, rewriteCacheTtlJson } from '../../src/gateway/anthropic-cache-ttl'
import type { AccountCredential } from '../../src/gateway/types'
const account = (kind: AccountCredential['credential_kind'], extra = {}) => ({platform:'anthropic' as const,credential_kind:kind,runtime_snapshot:{config_version:1,control_version:1,ui_config_json:JSON.stringify({extra})}})
it('restricts injection and usage overrides to OAuth/setup-token and prioritizes account settings',()=>{
  const body={system:[{type:'text',text:'prefix',cache_control:{type:'ephemeral',ttl:'5m'}}]}
  expect(injectCacheTtl(account('api_key'),body,true)).toBe(body)
  expect(resolveCacheTtlTarget(account('api_key',{cache_ttl_override_enabled:true,cache_ttl_override_target:'1h'}),true)).toBeUndefined()
  for(const kind of ['oauth','setup_token'] as const){
    expect(injectCacheTtl(account(kind),body,true).system).toEqual([{type:'text',text:'prefix',cache_control:{type:'ephemeral',ttl:'1h'}}])
    expect(resolveCacheTtlTarget(account(kind),true)).toBe('5m')
    expect(resolveCacheTtlTarget(account(kind,{cache_ttl_override_enabled:true,cache_ttl_override_target:'1h'}),true)).toBe('1h')
    expect(resolveCacheTtlTarget(account(kind,{cache_ttl_override_enabled:true,cache_ttl_override_target:'bad'}))).toBe('5m')
  }
  expect(body.system[0].cache_control.ttl).toBe('5m')
})
it('retains token totals and marks applied billing policy even if already in target TTL',()=>{
  const source={input_tokens:16,output_tokens:2,cache_read_tokens:3,cache_write_tokens:5,cache_write_5m_tokens:2,cache_write_1h_tokens:3,estimated:false}
  const result=overrideCacheTtlUsage(source,'1h')
  expect(result).toEqual({...source,cache_write_5m_tokens:0,cache_write_1h_tokens:5,cache_ttl_overridden:true})
  expect(overrideCacheTtlUsage(result,'1h')).toEqual(result)
  expect(overrideCacheTtlUsage({...source,cache_write_5m_tokens:0,cache_write_1h_tokens:0},'5m')).toMatchObject({cache_write_5m_tokens:5,cache_ttl_overridden:true})
})
it('matches original JSON aggregate fallback and SSE nested-only rewrite',()=>{
  const json:Record<string,unknown>={cache_creation_input_tokens:5}
  rewriteCacheTtlJson(json,'1h');expect(json.cache_creation).toBeUndefined()
  rewriteCacheTtlJson(json,'1h',true);expect(json.cache_creation).toEqual({ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:5})
  rewriteCacheTtlJson(json,'5m');expect(json.cache_creation).toEqual({ephemeral_5m_input_tokens:5,ephemeral_1h_input_tokens:0})
})
