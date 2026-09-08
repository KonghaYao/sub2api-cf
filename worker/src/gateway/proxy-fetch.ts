import { resolveRequestProxy } from '../proxy/request-selection'
import type { Env } from '../env'
import { decryptCredential } from './crypto'
import { GatewayError } from './errors'
import { proxyHttpRequest } from './proxy-http'
import { negotiateProxyTunnel, type TunnelStreams } from './proxy-tunnel'

export interface ProxySocket extends TunnelStreams {
  opened: Promise<unknown>
  closed: Promise<unknown>
  close(): Promise<void>
  startTls(options: { expectedServerHostname: string }): ProxySocket
}
export type ProxyDialer = (host: string, port: number) => Promise<ProxySocket>
const nativeDial: ProxyDialer = async (hostname, port) => {
  const { connect } = await import('cloudflare:sockets')
  return connect({ hostname, port }, { secureTransport: 'starttls', allowHalfOpen: false })
}


export async function fetchAccountProxy(env: Env, id: string | number, url: URL, init: RequestInit, clientSignal: AbortSignal, dial = nativeDial): Promise<Response> {
  if (url.protocol !== 'https:' || url.username || url.password) throw new GatewayError(400, 'invalid_proxy_target', 'Proxy forwarding requires an HTTPS upstream')
  const signal = init.signal ? AbortSignal.any([init.signal, clientSignal]) : clientSignal
  if (signal.aborted) throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request')
  const row = await resolveRequestProxy(env, id)
  if (signal.aborted) throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request')
  if (row === null) return fetch(url, { ...init, signal })
  if (!env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503, 'credential_secret_not_configured', 'Credential encryption secret is not configured')
  // HTTPS proxy transport needs nested TLS, which native startTls cannot provide
  // by upgrading an already-TLS socket. Never silently substitute direct access.
  if (row.protocol === 'https') throw new GatewayError(503, 'proxy_nested_tls_unavailable', 'HTTPS proxy transport is not yet available')
  const secret = await decryptCredential(row.nonce_b64, row.ciphertext_b64, env.CREDENTIALS_MASTER_KEY, `proxy:v1:${row.creation_key}`)
  // Existing production vaults include both the original raw password and the
  // later versioned JSON envelope. The username remains in public config_json.
  let password = secret.api_key
  try {
    const payload = JSON.parse(secret.api_key)
    if (payload?.schema_version === 1 && typeof payload.password === 'string') password = payload.password
  } catch { /* Legacy raw password. */ }
  const auth = { username: row.username ?? '', password }
  // Let the runtime serialize multipart boundaries and binary bodies, then stream
  // those bytes through the tunnel instead of buffering an entire image upload.
  const serialized = init.body != null && typeof init.body !== 'string'
    ? new Request(url, { ...init, duplex: 'half' } as RequestInit) : undefined
  let socket: ProxySocket | undefined
  let finished = false
  const close = async () => {
    if (finished) return
    finished = true
    if (serialized?.body && !serialized.body.locked) void serialized.body.cancel().catch(() => undefined)
    await socket?.close().catch(() => undefined)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => {
    rejectAbort(new GatewayError(499, 'client_cancelled', 'Client cancelled the request'))
    void close()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([aborted, (async () => {
      socket = await dial(row.host, row.port)
      void socket.closed.catch(() => undefined)
      if (finished || signal.aborted) { await socket.close(); throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request') }
      await socket.opened
      if (signal.aborted) throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request')
      await negotiateProxyTunnel(socket, { protocol: row.protocol, ...auth }, url.hostname, Number(url.port || 443))
      if (signal.aborted) throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request')
      socket = socket.startTls({ expectedServerHostname: url.hostname.replace(/^\[|\]$/g, '') })
      void socket.closed.catch(() => undefined)
      await socket.opened
      if (signal.aborted) throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request')
      return proxyHttpRequest(socket, url, { method: init.method ?? 'GET', headers: serialized?.headers ?? init.headers ?? {},
        body: typeof init.body === 'string' ? init.body : serialized?.body ?? undefined, signal }, close)
    })()])
  } catch (error) {
    await close()
    if (error instanceof GatewayError) throw error
    throw new GatewayError(502, 'proxy_connection_failed', 'Unable to connect through the configured account proxy', 'server_error')
  } finally { signal.removeEventListener('abort', onAbort) }
}
