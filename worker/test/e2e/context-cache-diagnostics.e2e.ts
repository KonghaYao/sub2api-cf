import { expect, it, vi } from 'vitest'
import { emitContextCacheFingerprint } from '../../src/gateway/context-cache-diagnostics'
it('compares large context fingerprints in native Worker crypto without mutating input',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>undefined)
  try{
    const body={messages:[{role:'system',content:'Synthetic context '.repeat(10000)},{role:'user',content:'Continue'}],tools:[]}
    const original=JSON.stringify(body)
    await emitContextCacheFingerprint({API_KEY_PEPPER:'local-fixture-pepper-32-characters',CONTEXT_CACHE_DIAGNOSTICS_MODELS:'composer-2.5',CONTEXT_CACHE_DIAGNOSTICS_UNTIL:'2999-01-01'},
      {requestId:'native-fixture',accountId:'fixture-account',apiKeyId:'fixture-key',model:'composer-2.5',operation:'chat_completions',clientBody:body,upstreamBody:structuredClone(body),clientHeaders:new Headers(),upstreamHeaders:new Headers()})
    expect(log).toHaveBeenCalledTimes(1)
    const result=JSON.parse(log.mock.calls[0][0]);expect(result.client.context_hash).toBe(result.upstream.context_hash)
    expect(result.client.message_hashes).toEqual(result.upstream.message_hashes)
    expect(JSON.stringify(body)).toBe(original);expect(log.mock.calls[0][0]).not.toContain('Synthetic context')
  }finally{log.mockRestore()}
})
