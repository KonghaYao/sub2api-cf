import { describe, expect, it } from 'vitest'
import { negotiateProxyTunnel, type ProxyTunnelConfig } from '../../src/gateway/proxy-tunnel'

function fixture(reply: Uint8Array, fragment = 3) {
  const writes: Uint8Array[] = []
  const readable = new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < reply.length; i += fragment) controller.enqueue(reply.slice(i, i + fragment))
    controller.close()
  } })
  const writable = new WritableStream<Uint8Array>({ write(bytes) { writes.push(bytes.slice()) } })
  return { readable, writable, writes }
}
const config: ProxyTunnelConfig = { protocol: 'http', username: 'proxy-user', password: 'proxy-secret' }

describe('proxy tunnel wire handshake', () => {
  it('sends CONNECT authority and proxy auth while accepting fragmented response headers', async () => {
    const io = fixture(new TextEncoder().encode('HTTP/1.1 200 Connection established\r\nX-Proxy: yes\r\n\r\n'))
    await negotiateProxyTunnel(io, config, 'api.example.test', 443)
    expect(new TextDecoder().decode(io.writes[0])).toBe(`CONNECT api.example.test:443 HTTP/1.1\r\nHost: api.example.test:443\r\nProxy-Authorization: Basic ${btoa('proxy-user:proxy-secret')}\r\n\r\n`)
    expect(io.readable.locked).toBe(false); expect(io.writable.locked).toBe(false)
  })
  it('handles SOCKS authentication and domain CONNECT, consuming the complete bound-address reply', async () => {
    const io = fixture(new Uint8Array([5, 2, 1, 0, 5, 0, 0, 4, ...Array(16).fill(0), 1, 187]))
    await negotiateProxyTunnel(io, { ...config, protocol: 'socks5h' }, 'api.example.test', 443)
    expect([...io.writes[0]]).toEqual([5, 2, 0, 2])
    expect([...io.writes[1]]).toEqual([1, 10, ...new TextEncoder().encode('proxy-user'), 12, ...new TextEncoder().encode('proxy-secret')])
    expect([...io.writes[2]]).toEqual([5, 1, 0, 3, 16, ...new TextEncoder().encode('api.example.test'), 1, 187])
    expect(io.readable.locked).toBe(false)
  })
  it('supports SOCKS no-auth with a domain-form bound address', async () => {
    const io = fixture(new Uint8Array([5, 0, 5, 0, 0, 3, 1, 120, 0, 80]))
    await negotiateProxyTunnel(io, { protocol: 'socks5', username: '', password: '' }, 'api.test', 443)
    expect([...io.writes[0]]).toEqual([5, 1, 0])
    expect(io.writes).toHaveLength(2)
  })
  it('rejects proxy authentication failures without exposing the proxy response', async () => {
    const io = fixture(new TextEncoder().encode('HTTP/1.1 407 proxy-secret\r\n\r\n'))
    await expect(negotiateProxyTunnel(io, config, 'api.test', 443)).rejects.toMatchObject({ code: 'proxy_authentication_failed', message: 'Upstream proxy tunnel failed' })
    expect(io.readable.locked).toBe(false); expect(io.writable.locked).toBe(false)
  })
  it('rejects truncated replies, oversized headers, and unexpected plaintext after CONNECT', async () => {
    for (const [reply, code] of [
      ['HTTP/1.1 200', 'proxy_truncated_reply'],
      ['HTTP/1.1 200 OK\r\nX: ' + 'x'.repeat(33000), 'proxy_headers_too_large'],
      ['HTTP/1.1 200 OK\r\n\r\nINJECTED', 'proxy_unexpected_data'],
    ]) {
      const io = fixture(new TextEncoder().encode(reply), 65536)
      await expect(negotiateProxyTunnel(io, config, 'api.test', 443)).rejects.toMatchObject({ code })
      expect(io.readable.locked).toBe(false)
    }
  })
  it('rejects target injection before writing any proxy bytes', async () => {
    const io = fixture(new Uint8Array())
    await expect(negotiateProxyTunnel(io, config, 'api.test\r\nAuthorization: secret', 443)).rejects.toMatchObject({ code: 'invalid_proxy_target' })
    expect(io.writes).toEqual([])
  })
})
