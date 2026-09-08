import type { Env } from '../env'
import type { Context } from 'hono'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, requireResourceId } from './http'

export async function revertAdminProxyFallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const id = requireResourceId(c.req.param('id'), 'account')
    const row = await c.env.DB.prepare(`UPDATE accounts SET ui_config_json=json_set(
      CASE WHEN credential_kind='api_key' THEN json_remove(ui_config_json, '$.extra.upstream_billing_probe') ELSE ui_config_json END,
      '$.proxy_id', json_extract(ui_config_json, '$.proxy_fallback_origin_id'), '$.proxy_fallback_origin_id', NULL),
      config_version=config_version+1, control_version=control_version+1, updated_at_ms=?
      WHERE id=? AND json_extract(ui_config_json, '$.proxy_fallback_origin_id') IS NOT NULL RETURNING id`)
      .bind(Date.now(), id).first<{ id: string }>()
    if (!row) throw new GatewayError(400, 'ACCOUNT_NOT_IN_FALLBACK', 'Account is not in proxy fallback state')
    return controlSuccess({ message: 'reverted' })
  } catch (error) {
    if ((String(error).includes('invalid_account_proxy') || String(error).includes('proxy_not_found'))) return controlError(new GatewayError(409, 'proxy_not_found', 'Original proxy is no longer available'))
    return controlError(asGatewayError(error))
  }
}

export interface ProxyFallbackRow {
  id: string | number
  status: string
  expires_at: number | null
  fallback_mode: string
  backup_proxy_id: string | number | null
  control_version: number
}
export function resolveProxyFallback(start: ProxyFallbackRow, rows: Map<string | number, ProxyFallbackRow>, nowMs: number): { change: boolean; target: string | number | null } {
  const visited = new Set<string | number>()
  let current = start
  while (!visited.has(current.id)) {
    visited.add(current.id)
    if (current.fallback_mode === 'direct') return { change: true, target: null }
    if (current.fallback_mode !== 'proxy' || !current.backup_proxy_id) break
    const next = rows.get(current.backup_proxy_id)
    if (!next || visited.has(next.id)) break
    // Original ResolveProxyFallbackTarget accepts an unexpired inactive backup;
    // it only excludes expiration here, not the administrator's active flag.
    if (next.status !== 'expired' && (next.expires_at === null || next.expires_at * 1000 > nowMs)) return { change: true, target: next.id }
    current = next
  }
  return { change: false, target: null }
}

export async function sweepExpiredProxies(env: Env, nowMs = Date.now()): Promise<number> {
  const result = await env.DB.prepare(`SELECT id, status, expires_at, fallback_mode, backup_proxy_id, control_version FROM proxies`).all<ProxyFallbackRow>()
  const rows = new Map(result.results.map(row => [row.id, row]))
  let changed = 0
  // Each proxy takes three bounded statements; subsequent cron invocations drain
  // the remainder. Configuration changes invalidate a stale fallback snapshot.
  for (const proxy of result.results.filter(row => row.status === 'active' && row.expires_at !== null && row.expires_at * 1000 <= nowMs).slice(0, 10)) {
    const fallback = resolveProxyFallback(proxy, rows, nowMs)
    const dependencies: Array<{ id: string | number; version: number }> = []
    const seen = new Set<string | number>()
    let cursor: ProxyFallbackRow | undefined = proxy
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id); dependencies.push({ id: cursor.id, version: cursor.control_version })
      cursor = cursor.backup_proxy_id ? rows.get(cursor.backup_proxy_id) : undefined
    }
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE proxies SET config_json=json_set(config_json,'$.status','expired'), control_version=control_version+1, updated_at_ms=?
        WHERE id=? AND status='active' AND expires_at IS NOT NULL AND expires_at*1000<=?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) snapshot LEFT JOIN proxies current ON current.id=json_extract(snapshot.value, '$.id')
          WHERE current.id IS NULL OR current.control_version<>json_extract(snapshot.value, '$.version')) RETURNING id`)
        .bind(nowMs, proxy.id, nowMs, JSON.stringify(dependencies)),
      env.DB.prepare(`UPDATE accounts SET ui_config_json=CASE WHEN ?=1 THEN json_set(
          CASE WHEN credential_kind='api_key' THEN json_remove(ui_config_json, '$.extra.upstream_billing_probe') ELSE ui_config_json END,
          '$.proxy_id', ?, '$.proxy_fallback_origin_id', ?) ELSE json_remove(ui_config_json, '$.extra.upstream_billing_probe') END,
          config_version=config_version+1, control_version=control_version+1, updated_at_ms=?
        WHERE changes()=1 AND CAST(json_extract(ui_config_json, '$.proxy_id') AS TEXT)=?
          AND ((?=1 AND json_extract(ui_config_json, '$.proxy_fallback_origin_id') IS NULL)
            OR (?=0 AND credential_kind='api_key' AND json_type(ui_config_json, '$.extra.upstream_billing_probe') IS NOT NULL))`)
        .bind(fallback.change ? 1 : 0, fallback.target, proxy.id, nowMs, String(proxy.id), fallback.change ? 1 : 0, fallback.change ? 1 : 0),
      env.DB.prepare('SELECT changes() AS changed_accounts'),
    ])
    if (fallback.change) changed += Number((results[2].results[0] as { changed_accounts: number }).changed_accounts)
    // Keep this scan's snapshot coherent with our own committed status change.
    if (results[0].results.length === 1) { proxy.status = 'expired'; proxy.control_version++ }
  }
  return changed
}
