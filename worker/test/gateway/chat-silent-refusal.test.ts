import { afterEach, expect, it, vi } from 'vitest'
import { inspectChatSilentRefusal } from '../../src/gateway/protocols/chat-silent-refusal'
const encoder = new TextEncoder()
const wire = (...events: unknown[]) => events.map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join('')
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] }
const signal = () => new AbortController().signal
const response = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
afterEach(() => vi.useRealTimers())
it('only enables original silent refusal detection at 64 KiB', async () => {
  const small = response(wire(stop, '[DONE]'))
  expect(await inspectChatSilentRefusal(small, 65535, { signal: signal() })).toBe(small)
  await expect(inspectChatSilentRefusal(response(wire(stop, '[DONE]')), 65536, { signal: signal() })).rejects.toMatchObject({ code: 'openai_silent_refusal', status: 502 })
})
it.each([
  { choices: [{ delta: { content: 'hello' } }] },
  { choices: [{ delta: { tool_calls: [] } }] },
  { choices: [{ delta: { function_call: {} } }] },
  { choices: [{ delta: { reasoning_content: '' } }] },
  { choices: [{ delta: { reasoning: '' } }] },
  { choices: [{ delta: { reasoning_summary: '' } }] },
  { usage: {} }, { error: {} }, { type: 'response.reasoning.delta' },
])('preserves original non-silent evidence without changing bytes: %j', async evidence => {
  const text = wire(stop, evidence, '[DONE]')
  expect(await (await inspectChatSilentRefusal(response(text), 65536, { signal: signal() })).text()).toBe(text)
})
it.each(['length', 'tool_calls', 'content_filter'])('preserves non-stop finish reason %s', async finish_reason => {
  const text = wire({ choices: [{ finish_reason }] }, '[DONE]')
  expect(await (await inspectChatSilentRefusal(response(text), 65536, { signal: signal() })).text()).toBe(text)
})
it('detects fragmented UTF-8/CRLF stop at EOF without DONE', async () => {
  const bytes = encoder.encode(wire({ choices: [{ delta: { role: 'assistant', content: '' } }] }, stop).replaceAll('\n', '\r\n').trimEnd())
  const source = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close() } })
  await expect(inspectChatSilentRefusal(new Response(source), 65536, { signal: signal() })).rejects.toMatchObject({ code: 'openai_silent_refusal' })
})
it('releases content before upstream finishes and forwards client cancellation', async () => {
  const cancel = vi.fn()
  const text = wire({ choices: [{ delta: { content: '你好' } }] })
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(text)) }, cancel })
  const result = await inspectChatSilentRefusal(new Response(source), 65536, { signal: signal() })
  const reader = result.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(text)
  await reader.cancel('user stopped')
  expect(cancel).toHaveBeenCalledOnce()
})
it('renews leases while a large request is reasoning before any stream evidence', async () => {
  vi.useFakeTimers()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const source = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const keepAlive = vi.fn(async () => {})
  const inspected = inspectChatSilentRefusal(new Response(source), 65536, { signal: signal(), keepAlive })
  await vi.advanceTimersByTimeAsync(45000)
  expect(keepAlive).toHaveBeenCalledTimes(2)
  controller.enqueue(encoder.encode(wire({ choices: [{ delta: { content: 'OK' } }] })))
  const result = await inspected
  await result.body!.cancel()
})
it('cancels a prelude without waiting for a stalled upstream cancel promise', async () => {
  const abort = new AbortController(), cancel = vi.fn(() => new Promise<void>(() => {}))
  const inspected = inspectChatSilentRefusal(new Response(new ReadableStream({ cancel })), 65536, { signal: abort.signal })
  const check = expect(inspected).rejects.toMatchObject({ code: 'client_cancelled' })
  abort.abort()
  await check
  expect(cancel).toHaveBeenCalledOnce()
})
