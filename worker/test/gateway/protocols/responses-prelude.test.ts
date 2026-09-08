import { afterEach, describe, expect, it, vi } from 'vitest'

import { inspectResponsesSsePrelude } from '../../../src/gateway/protocols/responses-prelude'

const encoder = new TextEncoder()
afterEach(() => vi.useRealTimers())

describe('Responses SSE prelude inspection', () => {
  it('allows slow reasoning beyond 15 seconds and renews leases before visible output', async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const keepAlive = vi.fn(async () => {})
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(encoder.encode('data: {"type":"response.created"}\n\n')) } })
    let finished = false
    const pending = inspectResponsesSsePrelude(new Response(body), { keepAlive }).then(result => { finished = true; return result })
    await vi.advanceTimersByTimeAsync(65000)
    expect(finished).toBe(false)
    expect(keepAlive).toHaveBeenCalledTimes(3)
    controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"OK"}\n\n'))
    const result = await pending
    expect(result.decision).toEqual({ kind: 'visible' })
    await result.response.body!.cancel()
  })

  it('resets the idle deadline on upstream data while retaining an overall limit', async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    let finished = false
    const pending = inspectResponsesSsePrelude(new Response(body), { idleTimeoutMs: 1000, maxWaitMs: 5000 }).then(result => { finished = true; return result })
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(900)
      controller.enqueue(encoder.encode(': heartbeat\n\n'))
      await vi.advanceTimersByTimeAsync(0)
      expect(finished).toBe(false)
    }
    await vi.advanceTimersByTimeAsync(1001)
    const result = await pending
    expect(result.decision).toMatchObject({ kind: 'failed', failure: { code: 'upstream_idle_timeout' } })
    await result.response.body!.cancel()
  })

  it('rebuilds the exact body from the inspected prefix and remaining reader without cloning', async () => {
    const source = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_direct"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"visible"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
      '',
    ].join('\n')
    const chunks = [source.slice(0, 80), source.slice(80, 190), source.slice(190)]
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next === undefined) {
          controller.close()
        } else {
          controller.enqueue(encoder.encode(next))
        }
      },
    })
    const original = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    Object.defineProperty(original, 'clone', {
      value: () => { throw new Error('prelude inspection must not tee the body') },
    })

    const inspected = await inspectResponsesSsePrelude(original)

    expect(inspected.decision).toEqual({ kind: 'visible' })
    await expect(inspected.response.text()).resolves.toBe(source)
  })

  it('reattaches the in-flight read when inspection times out', async () => {
    const source = 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
    let pulls = 0
    let release: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        return new Promise<void>((resolve) => {
          release = () => {
            controller.enqueue(encoder.encode(source))
            controller.close()
            resolve()
          }
        })
      },
    })

    const inspected = await inspectResponsesSsePrelude(new Response(body), { maxWaitMs: 5 })
    const downstream = inspected.response.text()

    expect(inspected.decision).toEqual({
      kind: 'failed',
      failure: {
        code: 'upstream_idle_timeout',
        message: 'Upstream did not produce visible output before the prelude timeout',
        cyberPolicy: false,
      },
    })
    expect(pulls).toBe(1)
    expect(release).toBeTypeOf('function')
    release?.()
    await expect(downstream).resolves.toBe(source)
    expect(pulls).toBe(1)
  })

  it('distinguishes a normal incomplete terminal from an incomplete provider failure', async () => {
    const partial = await inspectResponsesSsePrelude(new Response([
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
      '',
      '',
    ].join('\n')))
    expect(partial.decision).toEqual({ kind: 'completed' })

    const failed = await inspectResponsesSsePrelude(new Response([
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","error":{"code":"server_error","message":"provider failed"}}}',
      '',
      '',
    ].join('\n')))
    expect(failed.decision).toEqual({
      kind: 'failed',
      failure: { code: 'server_error', message: 'provider failed', cyberPolicy: false },
    })
  })
})

it.each(['response.completed', 'response.done'])('rejects empty %s before any output is exposed', async type => {
  const text = 'data: {"type":"response.created"}\n\ndata: ' + JSON.stringify({ type, response: { status: 'completed', output: [] } }) + '\n\n'
  const result = await inspectResponsesSsePrelude(new Response(text), { rejectEmptyCompleted: true })
  expect(result.decision).toEqual({ kind: 'empty_completed' })
  expect(await result.response.text()).toBe(text)
})

it.each([
  { type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } },
  { type: 'response.output_item.added', item: { type: 'message', content: [{ type: 'output_text', text: '' }] } },
  { type: 'response.output_item.added', item: { type: 'function_call', arguments: '' } },
  { type: 'response.output_item.added', item: { type: 'custom_tool_call', input: '' } },
  { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: '' } },
])('keeps empty structural placeholders from hiding an empty completion: %j', async event => {
  const text = [event, { type: 'response.completed', response: { status: 'completed' } }].map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
  const result = await inspectResponsesSsePrelude(new Response(text), { rejectEmptyCompleted: true })
  expect(result.decision).toEqual({ kind: 'empty_completed' })
})

it.each([
  { response: { usage: {} } }, { response: { usage: null } }, { usage: {} },
  { response: { output: [{ type: 'message', id: 'native-item' }] } },
])('preserves a completed document with original nonempty evidence %j', async extra => {
  const result = await inspectResponsesSsePrelude(new Response('data: ' + JSON.stringify({ type: 'response.completed', ...extra }) + '\n\n'), { rejectEmptyCompleted: true })
  expect(result.decision).toEqual({ kind: 'completed' })
})

it.each([
  { type: 'response.in_progress', response: { usage: { input_tokens: 7, output_tokens: 0 } } },
  { type: 'response.in_progress', usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: {}, prompt_tokens_details: { cached_tokens: 7 } } },
  { type: 'response.output_item.added', item: { type: 'reasoning', encrypted_content: 'native-encrypted' } },
  { type: 'response.output_item.added', item: { type: 'function_call', arguments: '{}' } },
  { type: 'response.output_item.added', item: { type: 'custom_tool_call', input: 'native input' } },
  { type: 'response.output_item.added', item: { type: 'compaction', encrypted_content: 'native-compaction' } },
  { type: 'response.output_item.added', item: { type: 'unknown_native_tool' } },
  { type: 'response.content_part.added', part: { type: 'refusal', refusal: 'Cannot answer' } },
])('retains accumulated usage or native structural output while buffering: %j', async event => {
  const text = [event, { type: 'response.completed', response: { status: 'completed' } }].map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
  const result = await inspectResponsesSsePrelude(new Response(text), { stopAtVisible: false, rejectEmptyCompleted: true })
  expect(result.decision).toEqual({ kind: 'completed' })
  expect(await result.response.text()).toBe(text)
})

it('keeps an explicit failed terminal authoritative over empty completion detection', async () => {
  const result = await inspectResponsesSsePrelude(new Response('data: {"type":"response.completed","response":{"status":"failed","output":[]}}\n\n'), { rejectEmptyCompleted: true })
  expect(result.decision).toMatchObject({ kind: 'failed' })
})

it.each([false, true])('preserves the original Chat request-size gating for empty completed (enabled=%s)', async enabled => {
  const result = await inspectResponsesSsePrelude(new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'), { rejectSilentChat: enabled })
  expect(result.decision).toEqual({ kind: enabled ? 'empty_completed' : 'completed' })
})

it.each(['function_call', 'reasoning'])('keeps original Chat bridge %s field evidence distinct from native Responses', async type => {
  const text = [{ type: 'response.output_item.added', item: { type, arguments: '', summary: [] } },
    { type: 'response.completed', response: { status: 'completed' } }].map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
  const chat = await inspectResponsesSsePrelude(new Response(text), { rejectSilentChat: true, stopAtVisible: false })
  expect(chat.decision).toEqual({ kind: 'completed' })
  const native = await inspectResponsesSsePrelude(new Response(text), { rejectEmptyCompleted: true, stopAtVisible: false })
  expect(native.decision).toEqual({ kind: 'empty_completed' })
})

it('distinguishes an empty message item in native Responses and a large Chat bridge request', async () => {
  const text = 'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[]}]}}\n\n'
  expect((await inspectResponsesSsePrelude(new Response(text), { rejectEmptyCompleted: true })).decision).toEqual({ kind: 'completed' })
  expect((await inspectResponsesSsePrelude(new Response(text), { rejectSilentChat: true })).decision).toEqual({ kind: 'empty_completed' })
})

it('preserves the original distinction for prior zero usage in Chat and native Responses', async () => {
  const text = 'data: {"type":"response.in_progress","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
  expect((await inspectResponsesSsePrelude(new Response(text), { rejectEmptyCompleted: true, stopAtVisible: false })).decision).toEqual({ kind: 'empty_completed' })
  expect((await inspectResponsesSsePrelude(new Response(text), { rejectSilentChat: true, stopAtVisible: false })).decision).toEqual({ kind: 'completed' })
})

it('does not treat null metadata errors as a prior failed event', async () => {
  const text = 'data: {"type":"response.created","response":{"error":null,"usage":null,"output":[]}}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
  expect((await inspectResponsesSsePrelude(new Response(text), { rejectEmptyCompleted: true })).decision).toEqual({ kind: 'empty_completed' })
})
