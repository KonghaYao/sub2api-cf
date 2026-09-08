import type { Env } from '../env'
import type { AccountCredential } from './types'
import { codexUsageHeaderUpdates } from './codex-usage-headers'
import { saveAccountRuntimeObservation } from './account-runtime-observation'

/** Successful Codex parent traffic updates the same quota snapshot used by admin usage queries. */
export async function persistCodexUsageObservation(env: Env, account: AccountCredential, response: Response, now=Date.now()): Promise<boolean> {
  if (!response.ok || !account.runtime_snapshot || !['openai','codex'].includes(account.platform)
    || !['oauth','setup_token'].includes(account.credential_kind)) return false
  const ui=JSON.parse(account.runtime_snapshot.ui_config_json) as Record<string,unknown>
  if (ui.parent_account_id != null) return false
  const updates=codexUsageHeaderUpdates(response.headers,now)
  if (!updates) return false
  // Unlike active-probe throttling, normal-traffic snapshot writes use 30 seconds.
  const claimed=await env.DB.prepare(`INSERT INTO account_usage_probe_state(account_id,last_attempt_at_ms,last_header_at_ms) VALUES(?,0,?)
    ON CONFLICT(account_id) DO UPDATE SET last_header_at_ms=excluded.last_header_at_ms
    WHERE account_usage_probe_state.last_header_at_ms<=? RETURNING account_id`).bind(account.account_id,now,now-30000).first()
  if (!claimed) return false
  return saveAccountRuntimeObservation(env,account,current=>({ ...current,extra:{
    ...(current.extra && typeof current.extra==='object' && !Array.isArray(current.extra)?current.extra:{}),...updates,
  } }),'preserve',false)
}
