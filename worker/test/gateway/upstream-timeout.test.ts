import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithHeaderTimeout, responseHeaderTimeout } from '../../src/gateway/upstream-timeout'
import { GatewayError } from '../../src/gateway/errors'

const url = new URL('https://upstream.invalid/v1/chat/completions')
const delayed = (ms: number) => async (_url: any, init: any) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(Response.json({ ok: true })), ms)
  init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
})
afterEach(() => vi.useRealTimers())
describe('inference response header deadline and reservation renewal', () => {
  it('allows slow OpenAI inference beyond 30 seconds and renews until headers arrive', async () => {
    vi.useFakeTimers()
    const renew = vi.fn(async () => {})
    const result = fetchWithHeaderTimeout(url, {}, new AbortController().signal, responseHeaderTimeout('openai'), delayed(95_000), renew)
    await vi.advanceTimersByTimeAsync(95_000)
    expect((await result).status).toBe(200)
    expect(renew).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(renew).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('still aborts an unlimited request when the caller disconnects', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const result = fetchWithHeaderTimeout(url, {}, caller.signal, 0, delayed(90_000))
    const assertion = expect(result).rejects.toMatchObject({ status: 499, code: 'client_cancelled' })
    caller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
  it('enforces an explicit timeout', async () => {
    vi.useFakeTimers()
    const result = fetchWithHeaderTimeout(url, {}, new AbortController().signal, 120_000, delayed(130_000))
    const assertion = expect(result).rejects.toMatchObject({ status: 504, code: 'upstream_timeout' })
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops dispatch if a reservation cannot be renewed', async () => {
    vi.useFakeTimers()
    const failure = new GatewayError(503, 'lease_expired', 'Reservation expired')
    const result = fetchWithHeaderTimeout(url, {}, new AbortController().signal, 0, delayed(90_000), async () => { throw failure })
    const assertion = expect(result).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
})
