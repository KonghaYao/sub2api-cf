import type { Env } from '../env'
import type { AccountCredential } from './types'

type ObservedAccount = Pick<AccountCredential, 'account_id' | 'secret_id' | 'runtime_snapshot'>
/** Merge across a concurrent automatic probe, never across an administrator edit or credential rotation. */
export async function saveAccountRuntimeObservation(env: Env, account: ObservedAccount,
  transform: (ui: Record<string, unknown>) => Record<string, unknown>, health: 'preserve' | 'reset' | 'auth-failed' = 'preserve', advanceControlVersion = true): Promise<boolean> {
  const original = account.runtime_snapshot
  if (!original) return false
  let snapshot = original
  for (let attempt = 0; attempt < 2; attempt++) {
    const mode = health === 'reset' ? 1 : health === 'auth-failed' ? 2 : 0
    const saved = await env.DB.prepare(`UPDATE accounts SET ui_config_json=?,
      health_status=CASE WHEN ?=1 THEN 'unknown' WHEN ?=2 THEN 'unhealthy' ELSE health_status END,
      last_health_error=CASE WHEN ?=1 THEN NULL WHEN ?=2 THEN 'Authentication failed (401)' ELSE last_health_error END,
      config_version=config_version+1,control_version=control_version+${advanceControlVersion ? 1 : 0},updated_at_ms=?
      WHERE id=? AND credential_ref=? AND config_version=? AND control_version=? AND ui_config_json=? RETURNING id`)
      .bind(JSON.stringify(transform(JSON.parse(snapshot.ui_config_json))),mode,mode,mode,mode,Date.now(),account.account_id,account.secret_id,
        snapshot.config_version,original.control_version,snapshot.ui_config_json).first()
    if (saved) return true
    if (attempt === 1) return false
    const current = await env.DB.prepare(`SELECT config_version,control_version,ui_config_json FROM accounts
      WHERE id=? AND credential_ref=? AND control_version=?`).bind(account.account_id,account.secret_id,original.control_version)
      .first<typeof original>()
    if (!current) return false
    snapshot = current
  }
  return false
}
