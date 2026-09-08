import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'

/** Enroll existing sessions on their first authenticated request after enabling binding. */
export async function enforceSessionBinding(request: Request, env: Env, sessionId: string): Promise<void> {
  if (typeof env.CONFIG_KV?.get !== 'function') return
  let settings: { session_binding_enabled?: boolean } | null
  try {
    settings = await env.CONFIG_KV.get(`${env.ENVIRONMENT}:public-settings:v1`, 'json')
  } catch {
    // A projection outage must neither disable an enabled security policy nor break unrelated reads.
    const row = await env.DB.prepare("SELECT public_json FROM system_settings WHERE id = 'global'").first<{ public_json: string }>()
    settings = row === null ? null : JSON.parse(row.public_json)
  }
  if (settings?.session_binding_enabled !== true) return
  const address = request.headers.get('cf-connecting-ip')?.trim().toLowerCase() ?? ''
  const agent = request.headers.get('user-agent')?.slice(0, 512) ?? ''
  const fingerprint = await sha256Hex(`session-binding:v1\0${address}\0${agent}`)
  await env.DB.prepare(`UPDATE user_sessions SET ip_hash = ? WHERE id = ? AND ip_hash IS NULL AND revoked_at_ms IS NULL`)
    .bind(fingerprint, sessionId).run()
  const row = await env.DB.prepare('SELECT ip_hash FROM user_sessions WHERE id = ? AND revoked_at_ms IS NULL')
    .bind(sessionId).first<{ ip_hash: string | null }>()
  if (row?.ip_hash !== fingerprint) {
    throw new GatewayError(401, 'session_binding_mismatch', 'Session client changed; sign in again', 'authentication_error')
  }
}
