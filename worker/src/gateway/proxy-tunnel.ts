import { GatewayError } from './errors'

export interface ProxyTunnelConfig {
  protocol: 'http' | 'https' | 'socks5' | 'socks5h'
  username: string
  password: string
}
export interface TunnelStreams {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}
const encoder = new TextEncoder()
const failure = (code: string) => new GatewayError(502, code, 'Upstream proxy tunnel failed', 'server_error')

/** Negotiate an already-connected proxy stream before starting upstream TLS.
 * The caller owns connect/TLS deadlines and socket cleanup. Never send provider
 * authorization to a proxy before the upstream TLS tunnel has been established.
 */
export async function negotiateProxyTunnel(streams: TunnelStreams, proxy: ProxyTunnelConfig, hostname: string, port: number): Promise<void> {
  if (!hostname || /[\s\x00-\x1f\x7f/@?#]/.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GatewayError(400, 'invalid_proxy_target', 'Invalid proxy tunnel target')
  }
  const reader = streams.readable.getReader()
  const writer = streams.writable.getWriter()
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array()
  const read = async (length: number) => {
    const result = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      if (!buffer.length) {
        const next = await reader.read()
        if (next.done) throw failure('proxy_truncated_reply')
        buffer = next.value
        if (!buffer.length) continue
      }
      const count = Math.min(length - offset, buffer.length)
      result.set(buffer.subarray(0, count), offset)
      buffer = buffer.subarray(count); offset += count
    }
    return result
  }
  try {
    if (proxy.protocol === 'http' || proxy.protocol === 'https') {
      const authority = `${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}:${port}`
      const auth = proxy.username && proxy.password ? `Proxy-Authorization: Basic ${base64(encoder.encode(`${proxy.username}:${proxy.password}`))}\r\n` : ''
      await writer.write(encoder.encode(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`))
      const bytes: number[] = []
      while (bytes.length < 32768) {
        bytes.push((await read(1))[0])
        if (bytes.length >= 4 && bytes.slice(-4).join(',') === '13,10,13,10') break
      }
      if (bytes.slice(-4).join(',') !== '13,10,13,10') throw failure('proxy_headers_too_large')
      const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |\r)/.exec(new TextDecoder().decode(new Uint8Array(bytes)))
      if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300) throw failure(status?.[1] === '407' ? 'proxy_authentication_failed' : 'proxy_connect_rejected')
    } else {
      const hasAuth = proxy.username !== '' && proxy.password !== ''
      await writer.write(new Uint8Array(hasAuth ? [5, 2, 0, 2] : [5, 1, 0]))
      const selected = await read(2)
      if (selected[0] !== 5 || (selected[1] !== 0 && !(hasAuth && selected[1] === 2))) throw failure('proxy_authentication_failed')
      if (selected[1] === 2) {
        const username = encoder.encode(proxy.username); const password = encoder.encode(proxy.password)
        if (username.length > 255 || password.length > 255) throw failure('proxy_credentials_too_long')
        await writer.write(new Uint8Array([1, username.length, ...username, password.length, ...password]))
        const auth = await read(2)
        if (auth[0] !== 1 || auth[1] !== 0) throw failure('proxy_authentication_failed')
      }
      const target = encoder.encode(hostname.replace(/^\[|\]$/g, ''))
      if (target.length > 255) throw failure('proxy_target_too_long')
      await writer.write(new Uint8Array([5, 1, 0, 3, target.length, ...target, port >> 8, port & 255]))
      const reply = await read(4)
      if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw failure('proxy_connect_rejected')
      const size = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await read(1))[0] : -1
      if (size < 0) throw failure('proxy_invalid_reply')
      await read(size + 2)
    }
    // An upstream TLS server cannot send application bytes before ClientHello.
    // Reject unexpected trailing plaintext rather than lose buffered bytes when
    // the caller upgrades the stream to TLS.
    if (buffer.length) throw failure('proxy_unexpected_data')
  } finally { reader.releaseLock(); writer.releaseLock() }
}

function base64(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}
