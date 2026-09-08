import { GatewayError } from './errors'
import type { TunnelStreams } from './proxy-tunnel'

const encoder = new TextEncoder()
const badResponse = () => new GatewayError(502, 'proxy_invalid_http_response', 'Invalid upstream HTTP response through proxy', 'server_error')

/** HTTP/1.1 over an established upstream TLS tunnel. Serialized strings use a
 * byte length; binary/multipart streams use chunk framing. Responses use bounded
 * parsing buffers. The owner supplies socket closure and its request signal.
 */
export async function proxyHttpRequest(streams: TunnelStreams, url: URL, input: {
  method: string; headers: HeadersInit; body?: string | ReadableStream<Uint8Array>; signal?: AbortSignal
}, close: () => Promise<void>): Promise<Response> {
  if (url.protocol !== 'https:' || url.username || url.password || !/^[A-Z]+$/.test(input.method)) {
    await close().catch(() => undefined)
    throw new GatewayError(400, 'invalid_proxy_request', 'Invalid proxied request')
  }
  const reader = streams.readable.getReader()
  const writer = streams.writable.getWriter()
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let ended = false
  let upload: ReadableStreamDefaultReader<Uint8Array> | undefined
  const finish = async () => {
    if (ended) return
    ended = true
    input.signal?.removeEventListener('abort', onAbort)
    if (upload) void upload.cancel().catch(() => undefined)
    // Cleanup must not await an upstream close/cancel promise: an unresponsive
    // proxy must not retain the downstream cancellation or gateway reservation.
    void close().catch(() => undefined)
    void reader.cancel().catch(() => undefined)
    try { reader.releaseLock() } catch { /* A pending read finishes on close. */ }
    try { writer.releaseLock() } catch { /* A pending write finishes on close. */ }
  }
  const onAbort = () => { void finish() }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const check = () => {
    if (input.signal?.aborted) throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request')
  }
  const fill = async () => {
    check()
    while (!buffer.length) {
      const next = await reader.read()
      check()
      if (next.done) return false
      buffer = next.value
    }
    return true
  }
  const byte = async () => {
    if (!await fill()) throw badResponse()
    const value = buffer[0]; buffer = buffer.subarray(1); return value
  }
  const line = async () => {
    const bytes: number[] = []
    while (bytes.length < 8192) {
      const next = await byte()
      if (next === 13) { if (await byte() !== 10) throw badResponse(); return new TextDecoder().decode(new Uint8Array(bytes)) }
      if (next === 10) throw badResponse()
      bytes.push(next)
    }
    throw badResponse()
  }
  try {
    check()
    const headers = new Headers(input.headers)
    for (const field of ['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'content-length', 'accept-encoding', 'expect', 'upgrade']) headers.delete(field)
    const body = typeof input.body === 'string' ? encoder.encode(input.body) : undefined
    const streamedBody = input.body instanceof ReadableStream ? input.body : undefined
    headers.set('host', url.host); headers.set('connection', 'close'); headers.set('accept-encoding', 'identity')
    if (body) headers.set('content-length', String(body.byteLength))
    if (streamedBody) headers.set('transfer-encoding', 'chunked')
    let head = `${input.method} ${url.pathname || '/'}${url.search} HTTP/1.1\r\n`
    headers.forEach((value, name) => { head += `${name}: ${value}\r\n` })
    await writer.write(encoder.encode(`${head}\r\n`))
    check()
    if (body?.length) await writer.write(body)
    if (streamedBody) {
      upload = streamedBody.getReader()
      try {
        for (;;) {
          check()
          const { value, done } = await upload.read()
          check()
          if (done) break
          if (!value.byteLength) continue
          await writer.write(encoder.encode(`${value.byteLength.toString(16)}\r\n`))
          await writer.write(value)
          await writer.write(encoder.encode('\r\n'))
        }
        await writer.write(encoder.encode('0\r\n\r\n'))
      } catch (error) {
        void upload.cancel(error).catch(() => undefined)
        throw error
      } finally { upload.releaseLock(); upload = undefined }
    }
    writer.releaseLock()
    let status = 0; let statusText = ''; let responseHeaders = new Headers()
    for (let interim = 0; interim < 9; interim++) {
      const first = /^HTTP\/1\.[01] ([0-9]{3})(?: (.*))?$/.exec(await line())
      if (!first) throw badResponse()
      status = Number(first[1]); statusText = first[2] ?? ''; responseHeaders = new Headers()
      let size = 0
      for (;;) {
        const field = await line(); size += field.length + 2
        if (size > 32768) throw badResponse()
        if (!field) break
        const separator = field.indexOf(':')
        if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(field.slice(0, separator))) throw badResponse()
        responseHeaders.append(field.slice(0, separator), field.slice(separator + 1).trim())
      }
      if (status >= 200) break
      if (status === 101 || status < 100 || interim === 8) throw badResponse()
    }
    if (status > 599) throw badResponse()
    const transfer = responseHeaders.get('transfer-encoding')
    const length = responseHeaders.get('content-length')
    if ((transfer && transfer.toLowerCase() !== 'chunked') || (transfer && length)) throw badResponse()
    let remaining = length === null ? null : Number(length)
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(remaining))) throw badResponse()
    responseHeaders.delete('transfer-encoding'); responseHeaders.delete('connection')
    if (input.method === 'HEAD' || status === 204 || status === 205 || status === 304) {
      await finish(); return new Response(null, { status, statusText, headers: responseHeaders })
    }
    let chunkRemaining = 0
    let chunkEnd = false
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          check()
          if (transfer && chunkRemaining === 0) {
            if (chunkEnd && (await byte() !== 13 || await byte() !== 10)) throw badResponse()
            const chunkLine = await line()
            const size = chunkLine.split(';', 1)[0]
            if (!/^[0-9a-f]+$/i.test(size)) throw badResponse()
            chunkRemaining = Number.parseInt(size, 16)
            if (!Number.isSafeInteger(chunkRemaining)) throw badResponse()
            if (chunkRemaining === 0) {
              let trailers = 0
              while ((await line()) !== '') { if (++trailers > 100) throw badResponse() }
              controller.close(); await finish(); return
            }
            chunkEnd = true
          }
          if (!transfer && remaining === 0) { controller.close(); await finish(); return }
          if (!await fill()) {
            if (transfer || (remaining !== null && remaining > 0)) throw badResponse()
            controller.close(); await finish(); return
          }
          const count = Math.min(buffer.length, transfer ? chunkRemaining : remaining ?? buffer.length)
          const output = buffer.subarray(0, count); buffer = buffer.subarray(count)
          if (transfer) chunkRemaining -= count
          else if (remaining !== null) remaining -= count
          controller.enqueue(output)
        } catch (error) { controller.error(error); await finish() }
      },
      cancel: finish,
    })
    const encoding = responseHeaders.get('content-encoding')?.toLowerCase()
    let result: ReadableStream<Uint8Array> = stream
    if (encoding && encoding !== 'identity') {
      if (encoding !== 'gzip' && encoding !== 'deflate') throw badResponse()
      result = stream.pipeThrough(new DecompressionStream(encoding) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length')
    }
    return new Response(result, { status, statusText, headers: responseHeaders })
  } catch (error) { await finish(); throw error }
}
