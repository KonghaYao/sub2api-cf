import { describe, expect, it } from 'vitest'
import { requestMonitorJson } from '../../src/control/channel-monitor-request'

describe('native Worker monitor response lifecycle', () => {
  it('accepts a response body arriving after eight seconds', async () => {
    const started = Date.now()
    const result = await requestMonitorJson(async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise(resolve => setTimeout(resolve, 9_000))
        controller.enqueue(new TextEncoder().encode('{"answer":42}'))
        controller.close()
      },
    })), 'https://upstream.e2e.invalid/monitor', {})
    expect(Date.now() - started).toBeGreaterThanOrEqual(8_000)
    expect(result).toMatchObject({ ok: true, body: { answer: 42 } })
  })
  it('finishes after client cancellation even when upstream cancel never resolves', async () => {
    const abort = new AbortController()
    let cancelCount = 0
    const result = requestMonitorJson(async () => new Response(new ReadableStream({
      start() { setTimeout(() => abort.abort(), 20) },
      cancel() { cancelCount++; return new Promise<void>(() => {}) },
    })), 'https://upstream.e2e.invalid/monitor', {}, abort.signal)
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelCount).toBe(1)
  })
})
