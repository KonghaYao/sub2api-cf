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
