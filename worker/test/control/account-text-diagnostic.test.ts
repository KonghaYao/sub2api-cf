import { afterEach, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { diagnosticUsesResponses, accountTextDiagnostic } from '../../src/control/account-text-diagnostic'
import * as proxy from '../../src/gateway/proxy-fetch'

const account = { platform: 'openai' as const, protocol: 'openai' as const, auth_scheme: 'bearer' as const, base_url: 'https://relay.test/v1', provider_config: {} }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const run = () => accountTextDiagnostic({} as Env, account, { api_key: 'private-key' }, 'selected-model', null, new AbortController().signal)
const events = (text: string) => text.trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)))

it('does not substitute a legacy API key for a missing OpenAI OAuth access token', async () => {
  const direct = vi.fn()
  vi.stubGlobal('fetch', direct)
  const response = accountTextDiagnostic({} as Env, account, { api_key: 'wrong-legacy-key' }, 'gpt-5.4',
    null, new AbortController().signal, { oauth: true })
  expect(events(await response.text()).at(-1)).toMatchObject({ type: 'test_complete', success: false })
  expect(direct).not.toHaveBeenCalled()
})

it('preserves the existing Codex account endpoint and account-id projection', async () => {
  const direct = vi.fn().mockResolvedValue(new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'))
  vi.stubGlobal('fetch', direct)
  const response = accountTextDiagnostic({} as Env, { platform: 'codex', protocol: 'codex', auth_scheme: 'bearer',
    base_url: 'https://codex-relay.test', provider_config: { account_id: 'codex-account' } }, { api_key: 'codex-access' },
    'gpt-5.4-high', null, new AbortController().signal)
  expect(events(await response.text()).at(-1)).toMatchObject({ type: 'test_complete', success: true })
  expect(direct.mock.calls[0][0]).toBe('https://codex-relay.test/backend-api/codex/responses')
  expect(new Headers(direct.mock.calls[0][1].headers).get('chatgpt-account-id')).toBe('codex-account')
  expect(JSON.parse(direct.mock.calls[0][1].body).model).toBe('gpt-5.4')
})

it.each([
  [undefined, true], [null, true], [{}, true], [{ openai_responses_supported: 'false' }, true],
  [{ openai_responses_supported: false }, false], [{ openai_responses_supported: true }, true],
  [{ openai_responses_mode: 'force_responses', openai_responses_supported: false }, true],
  [{ openai_responses_mode: 'force_chat_completions', openai_responses_supported: true }, false],
  [{ openai_responses_mode: 'unknown', openai_responses_supported: false }, false],
])('matches the original capability precedence for %j', (extra, expected) => {
  expect(diagnosticUsesResponses(extra)).toBe(expected)
})

it.each(['done', 'finish', 'truncated', 'error'])('handles original Chat Completions diagnostic termination: %s', async ending => {
  const wire = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
    (ending === 'done' ? 'data: [DONE]\n\n' : ending === 'finish' ? 'data: {"choices":[{"finish_reason":"stop"}]}\n\n' :
      ending === 'error' ? 'data: {"error":{"message":"secret diagnostic failure"}}\n\n' : '')
  const fetcher = vi.fn().mockResolvedValue(new Response(wire))
  vi.stubGlobal('fetch', fetcher)
  const response = accountTextDiagnostic({} as Env, account, { api_key: 'private-key' }, 'selected-model',
    null, new AbortController().signal, { responses: false, prompt: '  custom greeting  ' })
  const text = await response.text()
  expect(events(text)).toContainEqual({ type: 'content', text: 'Hello' })
  expect(events(text).at(-1)).toMatchObject({ type: 'test_complete', success: ending === 'done' || ending === 'finish' })
  expect(text).not.toContain('secret diagnostic failure')
  expect(fetcher.mock.calls[0][0]).toBe('https://relay.test/v1/chat/completions')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ model: 'selected-model', stream: true,
    messages: [{ role: 'user', content: 'custom greeting' }] })
})

it('streams original modal events from fragmented CRLF Responses SSE and stops at completion', async () => {
  const wire = ['data: {"type":"response.output_text.delta","delta":"Hello"}', '',
    'data: {"type":"response.completed","response":{"status":"completed"}}', '', ''].join('\r\n')
  const cancel = vi.fn()
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) {
    for (const byte of new TextEncoder().encode(wire)) c.enqueue(new Uint8Array([byte]))
    // Upstream stays open after the terminal event.
  }, cancel }), { headers: { 'content-type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetcher)
  const response = run()
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(events(await response.text())).toEqual([{ type: 'test_start', model: 'selected-model' },
    { type: 'content', text: 'Hello' }, { type: 'test_complete', success: true }])
  expect(cancel).toHaveBeenCalledOnce()
  const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]
  expect(url).toBe('https://relay.test/v1/responses')
  expect(JSON.parse(String(init.body))).toMatchObject({ model: 'selected-model', stream: true })
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-key')
})

it.each(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
  'data: {"type":"response.failed","error":{"message":"private provider details"}}\n\n',
  'data: [DONE]\n\n'])('does not report success for an incomplete or failed diagnostic', async wire => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(wire)))
  const text = await run().text()
  expect(events(text).at(-1)).toMatchObject({ type: 'test_complete', success: false })
  expect(text).not.toContain('private provider details')
})

it('uses the bound proxy and never retries its failure with a direct request', async () => {
  const direct = vi.fn()
  vi.stubGlobal('fetch', direct)
  const proxied = vi.spyOn(proxy, 'fetchAccountProxy').mockRejectedValue(new Error('private proxy details'))
  const response = accountTextDiagnostic({} as Env, account, { api_key: 'private-key' }, 'selected-model',
    'proxy-opaque-id', new AbortController().signal)
  const text = await response.text()
  expect(proxied).toHaveBeenCalledOnce()
  expect(proxied.mock.calls[0][1]).toBe('proxy-opaque-id')
  expect(direct).not.toHaveBeenCalled()
  expect(events(text).at(-1)).toMatchObject({ type: 'test_complete', success: false })
  expect(text).not.toContain('private proxy details')
})


it.each(['\n', ''])('accepts a final Chat finish event without a blank separator: %j', ending => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}'+ending)))
 const response=accountTextDiagnostic({} as Env,account,{api_key:'private-key'},'composer-2.5',null,new AbortController().signal,{responses:false})
 return response.text().then(text=>{
  expect(events(text)).toContainEqual({type:'content',text:'完成'})
  expect(events(text).at(-1)).toMatchObject({type:'test_complete',success:true})
 })
})

it('closes the Chat diagnostic after completion even if upstream cancellation stays pending', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'))},cancel(){return new Promise<void>(()=>{})}}))))
 const response=accountTextDiagnostic({} as Env,account,{api_key:'private-key'},'composer-2.5',null,new AbortController().signal,{responses:false})
 expect(events(await response.text()).at(-1)).toMatchObject({type:'test_complete',success:true})
}, 1000)
