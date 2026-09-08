import { describe, expect, it } from 'vitest'
import { antigravityDefaults, antigravityUserAgent, parseAntigravitySettings, wrapAntigravityRequest, normalizeAntigravityResponse } from '../../src/gateway/providers/antigravity'
const encoder = new TextEncoder()
function sse(events: unknown[], split = false) {
  const text = events.map(value => 'data: ' + JSON.stringify({ response: value }) + '\r\n\r\n').join('')
  const bytes = encoder.encode(text)
  return new Response(new ReadableStream<Uint8Array>({start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    else controller.enqueue(bytes)
    controller.close()
  }}), { headers: { 'content-type': 'text/event-stream', 'content-length': String(bytes.length) } })
}
const first = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '你', thought: true }] } }] }
const last = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '好' }, { functionCall: {name:'test',args:{}} }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8, totalTokenCount: 12 } }
describe('Antigravity v1internal adapter', () => {
  it('wraps a project-scoped Gemini request and applies configured identity/UA', () => {
    const body = { contents: [{role:'user',parts:[{text:'Hi'}]}], systemInstruction: { parts:[{text:'Original system'}] } }
    const settings = {...antigravityDefaults,identity_patch_prompt:'Configured identity',antigravity_user_agent_version:'2.3.4'}
    const wrapped = wrapAntigravityRequest('project-123','gemini-test',body,settings) as any
    expect(wrapped).toMatchObject({project:'project-123',model:'gemini-test',userAgent:'antigravity',requestType:'agent'})
    expect(wrapped.request.systemInstruction.parts).toEqual([{text:'Configured identity'},{text:'Original system'}])
    expect(body.systemInstruction.parts).toHaveLength(1)
    expect(antigravityUserAgent(settings)).toBe('antigravity/2.3.4 windows/amd64')
    expect((wrapAntigravityRequest('project-123','gemini-test',body,{...settings,enable_identity_patch:false}) as any).request).toEqual(body)
    const existing = {...body,systemInstruction:{parts:[{text:'You are Antigravity.'}]}}
    expect((wrapAntigravityRequest('project-123','gemini-test',existing,settings) as any).request).toEqual(existing)
  })
  it('collects streaming reasoning/tool parts and final cumulative usage for non-stream callers', async () => {
    const response = await normalizeAntigravityResponse(sse([first,last],true),false)
    expect(response.headers.get('content-length')).toBeNull()
    const value = await response.json() as any
    expect(value.candidates[0].content.parts).toEqual([...first.candidates[0].content.parts,...last.candidates[0].content.parts])
    expect(value.candidates[0].finishReason).toBe('MAX_TOKENS')
    expect(value.usageMetadata).toEqual(last.usageMetadata)
  })
  it('unwraps live SSE including split UTF-8 and CRLF without exposing envelopes', async () => {
    const response = await normalizeAntigravityResponse(sse([first,last],true),true)
    const text = await response.text()
    expect(text).toContain('你');expect(text).toContain('好');expect(text).not.toContain('"response":')
    expect(text).toContain('"promptTokenCount":4')
  })
  it('rejects truncated streams and invalid envelopes rather than billing partial success', async () => {
    await expect(normalizeAntigravityResponse(sse([first]),false)).rejects.toThrow('incomplete')
    const response = await normalizeAntigravityResponse(sse([{error:{message:'secret upstream error'}}]),true)
    const text = await response.text(); expect(text).toContain('Antigravity upstream returned an error'); expect(text).not.toContain('secret upstream error')
  })
  it('accepts explicit upstream HTTP errors untouched and normalizes JSON replies', async () => {
    const error = Response.json({error:'denied'},{status:403})
    expect(await normalizeAntigravityResponse(error,false)).toBe(error)
    expect(await (await normalizeAntigravityResponse(Response.json({response:last}),false)).json()).toEqual(last)
  })
  it('rejects invalid settings and missing project identity', () => {
    for (const settings of [{antigravity_user_agent_version:'1.2.3\r\nX:'},{enable_identity_patch:'true'},{unknown:true}]) expect(()=>parseAntigravitySettings(settings)).toThrow()
    expect(()=>wrapAntigravityRequest('', 'gemini-test', {contents:[]})).toThrow('project_id')
  })
  it('propagates cancellation to the upstream stream', async () => {
    let cancelled = false
    const raw = new Response(new ReadableStream<Uint8Array>({pull(){},cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}})
    const response = await normalizeAntigravityResponse(raw,true)
    await response.body!.cancel()
    expect(cancelled).toBe(true)
  })
})
