import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import type { ProxyTunnelConfig } from '../gateway/proxy-tunnel'

/** Preserve both deployed numeric IDs and imported string IDs; malformed bindings fail closed. */
export function requestProxyId(value: unknown): string | null {
  if (value == null || value === 0 || value === '0' || value === '') return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && value.trim() && value.length <= 128) return value.trim()
  throw new GatewayError(503, 'invalid_proxy_binding', 'Account proxy binding is invalid')
}

export interface RequestProxyRow { name: string; config_json: string; control_version: number; created_at_ms: number; updated_at_ms: number; status: string; expires_at: number | null; fallback_mode: string; backup_proxy_id: number | null; id: number; creation_key: string; username: string | null; host: string; port: number; protocol: ProxyTunnelConfig['protocol']; nonce_b64: string; ciphertext_b64: string }

export async function resolveRequestProxy(env: Env, id: string | number): Promise<RequestProxyRow | null> {
  const now = Math.floor(Date.now() / 1000)
  const result = await env.DB.prepare(`WITH RECURSIVE chain AS (
    SELECT p.*, 0 AS depth FROM proxies p WHERE id=?
    UNION ALL SELECT p.*, c.depth+1 FROM proxies p JOIN chain c ON p.id=c.backup_proxy_id
    WHERE c.depth<7 AND c.fallback_mode='proxy'
      AND (c.status<>'active' OR (c.expires_at>0 AND c.expires_at<=?))
  ) SELECT *,json_extract(config_json,'$.username') AS username FROM chain ORDER BY depth`)
    .bind(id, now).all<RequestProxyRow>()
  const visited = new Set<number>()
  for (const row of result.results) {
    if (visited.has(row.id)) throw new GatewayError(409, 'proxy_fallback_cycle', 'Proxy fallback configuration contains a cycle')
    visited.add(row.id)
    if (row.status === 'active' && (!row.expires_at || row.expires_at > now)) return row
    if (row.fallback_mode === 'direct') return null
    if (row.fallback_mode !== 'proxy' || !row.backup_proxy_id) {
      throw new GatewayError(503, 'proxy_unavailable', 'Assigned proxy is inactive or expired')
    }
  }
  if (result.results.length >= 8) throw new GatewayError(409, 'proxy_fallback_cycle', 'Proxy fallback chain exceeds its limit')
  throw new GatewayError(404, 'proxy_not_found', 'The configured account proxy or backup is unavailable')
}
