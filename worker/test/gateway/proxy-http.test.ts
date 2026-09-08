import { describe, expect, it, vi } from 'vitest'
import { proxyHttpRequest } from '../../src/gateway/proxy-http'

function fixture(reply: string | Uint8Array, fragment = 7) {
  const bytes = typeof reply === 'string' ? new TextEncoder().encode(reply) : reply
  const writes: Uint8Array[] = []
  const close = vi.fn(async () => undefined)
  const readable = new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment))
    controller.close()
  } })
  const writable = new WritableStream<Uint8Array>({ write(value) { writes.push(value.slice()) } })
  const request = (signal?: AbortSignal) => proxyHttpRequest({ readable, writable }, new URL('https://api.example.test/v1/chat?x=1'),
    { method: 'POST', headers: { authorization: 'Bearer upstream-key', 'proxy-authorization': 'proxy-secret', 'content-length': '999', 'content-type': 'application/json' }, body: '{"text":"猫"}', signal }, close)
  return { request, writes, close, readable, writable }
}

describe('HTTP through upstream TLS proxy tunnel', () => {
  it('streams binary uploads with exact chunk framing and no text conversion', async () => {
    const io = fixture('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
    const bytes = new Uint8Array([0, 255, 128, 13, 10])
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.enqueue(new Uint8Array()); c.close() } })
    const response = await proxyHttpRequest(io, new URL('https://api.test/images/edits'),
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body }, io.close)
    expect(await response.json()).toEqual({})
    expect(new TextDecoder().decode(io.writes[0])).toContain('transfer-encoding: chunked\r\n')
    expect(io.writes.slice(1)).toEqual([
      new TextEncoder().encode('5\r\n'), bytes, new TextEncoder().encode('\r\n'), new TextEncoder().encode('0\r\n\r\n'),
    ])
  })

  it('cancels a pending upload source and closes the tunnel on abort', async () => {
    const io = fixture('')
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const abort = new AbortController()
    const pending = proxyHttpRequest(io, new URL('https://api.test/images/edits'),
      { method: 'POST', headers: {}, body, signal: abort.signal }, io.close)
    await vi.waitFor(() => expect(body.locked).toBe(true))
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(io.close).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('returns headers before delayed SSE data and cancels a pending socket read', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const readable = new ReadableStream<Uint8Array>({ start(controller) {
      source = controller
      controller.enqueue(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n'))
    } })
    const writable = new WritableStream<Uint8Array>()
    const close = vi.fn(async () => undefined)
    const abort = new AbortController()
    const response = await proxyHttpRequest({ readable, writable }, new URL('https://api.test/v1/chat'),
      { method: 'POST', headers: {}, body: '{}', signal: abort.signal }, close)
    expect(response.status).toBe(200)
    const consumer = response.body!.getReader()
    source.enqueue(new TextEncoder().encode('data: first\n\n'))
    expect(new TextDecoder().decode((await consumer.read()).value)).toBe('data: first\n\n')
    const pending = consumer.read()
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('writes exact UTF-8 length and upstream authorization without proxy credentials', async () => {
    const io = fixture('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
    const response = await io.request()
    expect(await response.json()).toEqual({})
    const head = new TextDecoder().decode(io.writes[0])
    expect(head).toContain('POST /v1/chat?x=1 HTTP/1.1\r\n')
    expect(head).toContain('authorization: Bearer upstream-key\r\n')
    expect(head).toContain('content-length: 14\r\n')
    expect(head).not.toContain('proxy-secret')
    expect(io.close).toHaveBeenCalledOnce()
  })
  it('streams chunked responses, consumes extensions/trailers and handles interim responses', async () => {
    const io = fixture('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream\r\n\r\n5;ok=yes\r\nhello\r\n6\r\n world\r\n0\r\nX-End: yes\r\n\r\n', 1)
    const response = await io.request()
    expect(response.headers.has('transfer-encoding')).toBe(false)
    expect(await response.text()).toBe('hello world')
    expect(io.close).toHaveBeenCalledOnce()
  })
  it('supports close-delimited responses and no-content statuses', async () => {
    const io = fixture('HTTP/1.0 200 OK\r\n\r\nhello')
    expect(await (await io.request()).text()).toBe('hello')
    for (const status of [204, 205, 304]) {
      const empty = fixture(`HTTP/1.1 ${status} Empty\r\n\r\n`)
      expect((await empty.request()).body).toBeNull()
      expect(empty.close).toHaveBeenCalledOnce()
    }
  })
  it('rejects conflicting framing and premature EOF instead of reporting complete JSON', async () => {
    const ambiguous = fixture('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n')
    await expect(ambiguous.request()).rejects.toMatchObject({ code: 'proxy_invalid_http_response' })
    for (const reply of ['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nx']) {
      const io = fixture(reply)
      await expect((await io.request()).text()).rejects.toMatchObject({ code: 'proxy_invalid_http_response' })
      expect(io.close).toHaveBeenCalledOnce()
    }
  })
  it('closes the connection on downstream cancellation or pre-aborted requests', async () => {
    const io = fixture('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc')
    await (await io.request()).body!.cancel()
    expect(io.close).toHaveBeenCalledOnce()
    const cancelled = fixture('')
    const controller = new AbortController(); controller.abort()
    await expect(cancelled.request(controller.signal)).rejects.toMatchObject({ code: 'client_cancelled' })
    expect(cancelled.writes).toEqual([])
    expect(cancelled.close).toHaveBeenCalledOnce()
  })
  it('decodes gzip even when an upstream disregards identity encoding', async () => {
    const packed = new Uint8Array(await new Response(new Blob(['{"ok":true}']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
    const headers = new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${packed.length}\r\n\r\n`)
    const reply = new Uint8Array(headers.length + packed.length); reply.set(headers); reply.set(packed, headers.length)
    const response = await fixture(reply).request()
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.has('content-encoding')).toBe(false)
    expect(response.headers.has('content-length')).toBe(false)
  })
})
