import { afterEach, expect, it, vi } from 'vitest'
import { emitContextCacheFingerprint } from '../../src/gateway/context-cache-diagnostics'
const settings={API_KEY_PEPPER:'private-test-pepper-32-characters',CONTEXT_CACHE_DIAGNOSTICS_MODELS:'composer-2.5',CONTEXT_CACHE_DIAGNOSTICS_UNTIL:'2999-01-01T00:00:00Z'}
const input={requestId:'req-1',accountId:'account-1',apiKeyId:'key-1',model:'composer-2.5',operation:'chat_completions',clientBody:{model:'public',messages:[{role:'system',content:'Private instructions'},{role:'user',content:'Private question'}],tools:[{type:'function',function:{name:'private_tool'}}],prompt_cache_key:'private-cache-key'},upstreamBody:{} as unknown,clientHeaders:new Headers({authorization:'Bearer private-credential',session_id:'private-session'}),upstreamHeaders:new Headers()}
afterEach(()=>vi.restoreAllMocks())
it('compares actual context and stable prefixes without logging content or identities',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>undefined)
  const body=structuredClone(input.clientBody)
  await emitContextCacheFingerprint(settings,{...input,upstreamBody:{...body,model:'composer-2.5'}})
  const first=JSON.parse(log.mock.calls[0][0])
  expect(first.client.context_hash).toBe(first.upstream.context_hash)
  expect(first.client.prompt_cache_key_hash).toBe(first.upstream.prompt_cache_key_hash)
  expect(first.client.session_id_hash).not.toBeNull();expect(first.upstream.session_id_hash).toBeNull()
  const next={...body,messages:[...body.messages,{role:'assistant',content:'Prior answer'},{role:'user',content:'Next question'}]}
  await emitContextCacheFingerprint(settings,{...input,clientBody:next,upstreamBody:next})
  const second=JSON.parse(log.mock.calls[1][0])
  expect(second.client.message_hashes.slice(0,2)).toEqual(first.client.message_hashes)
  expect(second.client.context_hash).not.toBe(first.client.context_hash)
  expect(second.client.tools_hash).toBe(first.client.tools_hash)
  const serialized=JSON.stringify(log.mock.calls)
  for(const secret of ['Private instructions','Private question','private_tool','private-cache-key','private-session','private-credential',settings.API_KEY_PEPPER])expect(serialized).not.toContain(secret)
  expect(body).toEqual(input.clientBody)
})
it('detects prefix changes and isolates API keys',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>undefined)
  await emitContextCacheFingerprint(settings,{...input,upstreamBody:{...input.clientBody,messages:[{role:'user',content:'changed'}]}})
  const first=JSON.parse(log.mock.calls[0][0]);expect(first.client.context_hash).not.toBe(first.upstream.context_hash)
  await emitContextCacheFingerprint(settings,{...input,apiKeyId:'key-2',upstreamBody:input.clientBody})
  expect(JSON.parse(log.mock.calls[1][0]).client.context_hash).not.toBe(first.client.context_hash)
})
it('caps message fingerprints and disables collection without a valid model scope and deadline',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>undefined)
  for(const config of [{...settings,CONTEXT_CACHE_DIAGNOSTICS_UNTIL:''},{...settings,CONTEXT_CACHE_DIAGNOSTICS_UNTIL:'2000-01-01'},{...settings,CONTEXT_CACHE_DIAGNOSTICS_MODELS:'different'}])await emitContextCacheFingerprint(config,input)
  expect(log).not.toHaveBeenCalled()
  await emitContextCacheFingerprint(settings,{...input,clientBody:{messages:Array.from({length:200},()=>({role:'user',content:'private'}))}})
  const record=JSON.parse(log.mock.calls[0][0]);expect(record.client.message_hashes).toHaveLength(128);expect(record.client.message_hashes_truncated).toBe(true);expect(record.client.message_count).toBe(200)
})
