import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestMonitorJson } from '../../src/control/channel-monitor-request'
const encode = (text: string) => new TextEncoder().encode(text)
afterEach(() => vi.useRealTimers())
describe('channel monitor request deadline', () => {
  it('allows a successful response after the old eight-second limit', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10_000)); return Response.json({ answer: 42 }) })
    const result = requestMonitorJson(fetcher, 'https://example.test', {})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ ok: true, body: { answer: 42 } })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out fetch even when transport ignores abort and disposes its late response', async () => {
    vi.useFakeTimers()
    let resolve!: (response: Response) => void
    let signal!: AbortSignal
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => { signal = init!.signal!; return new Promise<Response>(r => { resolve = r }) })
    const result = requestMonitorJson(fetcher, 'https://example.test', {}).catch(error => error)
    await vi.advanceTimersByTimeAsync(45_000)
    expect((await result).name).toBe('TimeoutError'); expect(signal.aborted).toBe(true)
    const cancel = vi.fn()
    resolve(new Response(new ReadableStream({ cancel })))
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  })
  it('shares the deadline with body reads without awaiting a hanging cancel', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const result = requestMonitorJson(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encode('{"answer":')) }, cancel,
    })), 'https://example.test', {}).catch(error => error)
    await vi.advanceTimersByTimeAsync(45_000)
    expect((await result).name).toBe('TimeoutError'); expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds oversized bodies and does not wait for their cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const result = await requestMonitorJson(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65537)) }, cancel,
    })), 'https://example.test', {})
    expect(result.body).toBeNull(); expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('returns HTTP failure without waiting on the error body', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const result = await requestMonitorJson(async () => new Response(new ReadableStream({ cancel }), { status: 503 }), 'https://example.test', {})
    expect(result).toEqual({ ok: false, status: 503, body: null }); expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('does not start transport for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort()
    const fetcher = vi.fn()
    await expect(requestMonitorJson(fetcher, 'https://example.test', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('cancels a pending body immediately when the client leaves', async () => {
    vi.useFakeTimers()
    const controller = new AbortController(), cancel = vi.fn()
    const result = requestMonitorJson(async () => new Response(new ReadableStream({ cancel })), 'https://example.test', {}, controller.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(0); controller.abort()
    expect((await result).name).toBe('AbortError'); expect(cancel).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  })
})
