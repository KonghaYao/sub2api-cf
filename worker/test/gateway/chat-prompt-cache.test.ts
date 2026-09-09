import { describe, expect, it } from 'vitest'
import { chatPromptCacheIdentity, deriveChatPromptCacheKey, openAIContentSessionSeed } from '../../src/gateway/chat-prompt-cache'

const body = { model: 'public', messages: [{ role: 'system', content: 'Help.' }, { role: 'user', content: 'Question A' }] }
const input = { body, model: 'gpt-5.4', headers: new Headers(), apiKeyId: 'tenant-a', oauth: false }
describe('original Chat bridge prompt cache identity', () => {
  it('keeps cache identity stable when later messages append and separates tenants', async () => {
    const first = await chatPromptCacheIdentity(input)
    expect(first).not.toBeNull()
    expect(first?.sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(await chatPromptCacheIdentity({ ...input, body: { ...body, messages: [...body.messages, { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Next' }] } })).toEqual(first)
    const other = await chatPromptCacheIdentity({ ...input, apiKeyId: 'tenant-b' })
    expect(other?.promptCacheKey).not.toBe(first?.promptCacheKey)
    expect(other?.sessionId).not.toBe(first?.sessionId)
  })
  it('preserves explicit keys and isolates only upstream session headers', async () => {
    const explicit = { ...input, body: { ...body, prompt_cache_key: ' client-key ' } }
    const first = await chatPromptCacheIdentity(explicit)
    const other = await chatPromptCacheIdentity({ ...explicit, apiKeyId: 'tenant-b' })
    expect(first?.promptCacheKey).toBe('client-key')
    expect(other?.promptCacheKey).toBe('client-key')
    expect(first?.sessionId).not.toBe(other?.sessionId)
    expect((await chatPromptCacheIdentity({ ...explicit, headers: new Headers({ 'session-id': 'header-session', 'x-request-id': 'rotating' }) }))?.promptCacheKey).toBe('header-session')
  })
  it('uses original model families, stable JSON tools and first-user anchors', async () => {
    expect(await deriveChatPromptCacheKey(body, 'gpt-5.3-codex-spark')).toBe(await deriveChatPromptCacheKey(body, ' openai/gpt-5.3-codex-spark '))
    expect(await deriveChatPromptCacheKey({ ...body, tool_choice: { type: 'function', name: 'f' } }, 'gpt-5.4')).toBe(await deriveChatPromptCacheKey({ ...body, tool_choice: { name: 'f', type: 'function' } }, 'gpt-5.4'))
    expect(await deriveChatPromptCacheKey(body, 'gpt-5.4')).not.toBe(await deriveChatPromptCacheKey({ ...body, messages: [{ role: 'user', content: 'Question B' }] }, 'gpt-5.4'))
    expect(await deriveChatPromptCacheKey(body, 'gpt-5.4')).not.toBe(await deriveChatPromptCacheKey({ ...body, reasoning_effort: 'high' }, 'gpt-5.4'))
  })
  it('does not auto inject for other models, raw Responses shapes or rotating request headers', async () => {
    for (const model of ['composer-2.5', 'gpt-4o', 'claude-sonnet']) expect(await chatPromptCacheIdentity({ ...input, model })).toBeNull()
    expect(await chatPromptCacheIdentity({ ...input, body: { input: 'Hi' } })).toBeNull()
    expect(await chatPromptCacheIdentity({ ...input, headers: new Headers({ 'x-request-id': 'random' }) })).toEqual(await chatPromptCacheIdentity(input))
  })
  it('retains the original OAuth cache seed while isolating the session per tenant', async () => {
    const first = await chatPromptCacheIdentity({ ...input, oauth: true })
    const other = await chatPromptCacheIdentity({ ...input, oauth: true, apiKeyId: 'tenant-b' })
    expect(first?.promptCacheKey).toMatch(/^compat_cc_[a-f0-9]{16}$/)
    expect(other?.promptCacheKey).toBe(first?.promptCacheKey)
    expect(other?.sessionId).not.toBe(first?.sessionId)
  })
})

it('uses only leading Chat system/developer messages and the first user for scheduling', () => {
  const base={model:'composer-2.5',messages:[{role:'developer',content:'Prefix'},{role:'user',content:'First'}]}
  const key=openAIContentSessionSeed(base)
  expect(openAIContentSessionSeed({...base,messages:[...base.messages,{role:'system',content:'Late rotating summary'},{role:'user',content:'Next'}]})).toBe(key)
  expect(openAIContentSessionSeed({...base,messages:[{role:'developer',content:'Other'},base.messages[1]]})).not.toBe(key)
  expect(openAIContentSessionSeed({model:'gpt',input:[{role:'user',content:'First'},{role:'assistant',content:'Answer'},{role:'user',content:'Next'}]})).toBe(openAIContentSessionSeed({model:'gpt',input:[{role:'user',content:'First'}]}))
  expect(openAIContentSessionSeed({})).toBeUndefined()
})

it('preserves explicit Responses-shaped Chat identity without auto derivation', async () => {
  const shape={...input,body:{model:'public',input:'Hello',prompt_cache_key:'explicit-shape'}}
  expect((await chatPromptCacheIdentity(shape))?.promptCacheKey).toBe('explicit-shape')
  expect((await chatPromptCacheIdentity({...shape,headers:new Headers({'session-id':'header-shape'})}))?.promptCacheKey).toBe('explicit-shape')
  expect(await chatPromptCacheIdentity({...shape,body:{model:'public',input:'Hello'}})).toBeNull()
})

it('retains the API-Key Responses-shaped body cache key when session headers rotate',async()=>{
 const request={body:{input:'Stable input',prompt_cache_key:'  explicit-body-cache  '},model:'gpt-5.4',apiKeyId:'tenant',oauth:false}
 const first=await chatPromptCacheIdentity({...request,headers:new Headers({'session-id':'first-header'})})
 const second=await chatPromptCacheIdentity({...request,headers:new Headers({'session-id':'second-header'})})
 expect(first?.promptCacheKey).toBe('  explicit-body-cache  ')
 expect(second?.promptCacheKey).toBe(first?.promptCacheKey)
 expect(second?.sessionId).not.toBe(first?.sessionId)
 expect((await chatPromptCacheIdentity({...request,body:{input:'Stable input',prompt_cache_key:'  '},headers:new Headers({'session-id':'fallback'})}))?.promptCacheKey).toBe('fallback')
})

it('keeps OAuth Responses-shaped cache and session identity anchored to the body key',async()=>{
 const request={body:{input:'Stable input',prompt_cache_key:'  oauth-body-cache  '},model:'gpt-5.4',apiKeyId:'tenant',oauth:true}
 const first=await chatPromptCacheIdentity({...request,headers:new Headers({'session-id':'first-header'})})
 const next=await chatPromptCacheIdentity({...request,headers:new Headers({'session-id':'second-header'})})
 expect(first?.promptCacheKey).toBe('  oauth-body-cache  ')
 expect(next).toEqual(first)
 expect((await chatPromptCacheIdentity({...request,apiKeyId:'other',headers:new Headers()}))?.sessionId).not.toBe(first?.sessionId)
 expect((await chatPromptCacheIdentity({...request,body:{input:'Stable input',prompt_cache_key:'  '},headers:new Headers({'session-id':'fallback'})}))?.promptCacheKey).toBe('fallback')
})
