import { requestProxyId } from '../proxy/request-selection'
import type { Env } from '../env'
import type { PrivacyAccount } from './account-privacy'
import { GatewayError } from '../gateway/errors'
import { decryptCredential } from '../gateway/crypto'
import { credentialAad } from '../gateway/repository'
import { openAIOAuthHttp } from './openai-oauth-http'
import { anthropicPassiveUsage, type AccountUsageSnapshot, type AccountUsageProgress } from './account-usage-projection'

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {} }

/** Active Anthropic windows intentionally preserve negative countdowns, matching buildUsageInfo. */
export function anthropicActiveUsage(value: unknown, ui: ObjectValue, now = Date.now()): AccountUsageSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError(502,'invalid_usage_response','Invalid Anthropic usage response')
  const raw = value as ObjectValue
  const result: AccountUsageSnapshot = { updated_at: new Date(now).toISOString(), five_hour: null }
  for (const [source,target] of [['five_hour','five_hour'],['seven_day','seven_day'],['seven_day_sonnet','seven_day_sonnet'],['seven_day_overage_included','seven_day_fable']] as const) {
    if (raw[source] != null && (typeof raw[source] !== 'object' || Array.isArray(raw[source]))) throw new GatewayError(502,'invalid_usage_response','Invalid Anthropic usage window')
    const window = object(raw[source])
    if (window.utilization != null && (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization))) throw new GatewayError(502,'invalid_usage_response','Invalid Anthropic utilization')
    if (window.resets_at != null && typeof window.resets_at !== 'string') throw new GatewayError(502,'invalid_usage_response','Invalid Anthropic reset timestamp')
    if (source !== 'five_hour' && !window.resets_at) continue
    const reset = typeof window.resets_at === 'string' && /^\d{4}-\d\d-\d\dT/.test(window.resets_at) ? Date.parse(window.resets_at) : NaN
    result[target] = { utilization: typeof window.utilization === 'number' ? window.utilization : 0,
      resets_at: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      remaining_seconds: Number.isFinite(reset) ? Math.trunc((reset-now)/1000) : 0 }
  }
  result.seven_day_fable ??= anthropicPassiveUsage(ui,now).seven_day_fable
  return result
}

async function fetchAndPersist(env: Env, account: PrivacyAccount): Promise<ObjectValue> {
  if (!env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503,'gateway_not_configured','Credential secret is not configured')
  const credentials = await decryptCredential(account.nonce_b64,account.ciphertext_b64,env.CREDENTIALS_MASTER_KEY,
    credentialAad(env.ENVIRONMENT,account.id,account.secret_id,account.key_version)) as unknown as ObjectValue
  if (typeof credentials.access_token !== 'string' || !credentials.access_token.trim()) throw new GatewayError(400,'usage_access_token_missing','Usage query requires an OAuth access token')
  const ui = JSON.parse(account.ui_config_json) as ObjectValue
  let response: { status: number; text: string }
  try { response = await openAIOAuthHttp(env,'https://api.anthropic.com/api/oauth/usage', { method:'GET',headers:{
    accept:'application/json, text/plain, */*','content-type':'application/json',authorization:`Bearer ${credentials.access_token}`,
    'anthropic-beta':'oauth-2025-04-20','user-agent':'claude-code/2.1.7',
  } },requestProxyId(ui.proxy_id),30000) }
  catch { throw new GatewayError(502,'usage_upstream_error','Could not read Anthropic usage') }
  if (response.status !== 200) throw new GatewayError(502,'usage_upstream_error',`Anthropic usage returned HTTP ${response.status}`)
  let raw: ObjectValue
  try { raw = JSON.parse(response.text) } catch { throw new GatewayError(502,'invalid_usage_response','Invalid Anthropic usage JSON') }
  const now = Date.now(), info = anthropicActiveUsage(raw,ui,now)
  const extra = { ...object(ui.extra),session_window_utilization: info.five_hour!.utilization / 100,passive_usage_sampled_at: new Date(now).toISOString() }
  for (const [window,prefix] of [[info.seven_day,'passive_usage_7d'],[info.seven_day_fable,'passive_usage_7d_oi']] as const) {
    if (!window) continue
    Object.assign(extra,{ [`${prefix}_utilization`]: window.utilization / 100,
      ...(window.resets_at ? { [`${prefix}_reset`]: Math.trunc(Date.parse(window.resets_at)/1000) } : {}) })
  }
  const updated = { ...ui,extra,...(info.five_hour?.resets_at ? {session_window_end:info.five_hour.resets_at} : {}) }
  const saved = await env.DB.prepare(`UPDATE accounts SET ui_config_json=?,config_version=config_version+1,updated_at_ms=?
    WHERE id=? AND credential_ref=? AND config_version=? AND control_version=? AND ui_config_json=? RETURNING id`)
    .bind(JSON.stringify(updated),now,account.id,account.credential_ref,account.config_version,account.control_version,account.ui_config_json).first()
  if (!saved) throw new GatewayError(412,'account_version_conflict','Account changed while reading usage')
  return raw
}

/** Shared D1 response/negative cache and lease; cache keys invalidate on token or administrator changes. */
export async function getAnthropicActiveUsage(env: Env, account: PrivacyAccount): Promise<AccountUsageSnapshot> {
  const key = `${account.key_version}:${account.control_version}`, deadline = Date.now()+35000
  const ui = JSON.parse(account.ui_config_json)
  while (Date.now() < deadline) {
    const now=Date.now()
    const cached = await env.DB.prepare('SELECT response_json,error_json,cache_key,cache_until_ms FROM account_usage_probe_state WHERE account_id=?')
      .bind(account.id).first<{response_json:string|null;error_json:string|null;cache_key:string|null;cache_until_ms:number}>()
    if (cached?.cache_key===key && cached.cache_until_ms>now) {
      if (cached.error_json) { const error=JSON.parse(cached.error_json); throw new GatewayError(error.status,error.code,error.message) }
      if (cached.response_json) return anthropicActiveUsage(JSON.parse(cached.response_json),ui,now)
    }
    const lease=crypto.randomUUID()
    const claimed=await env.DB.prepare(`INSERT INTO account_usage_probe_state(account_id,last_attempt_at_ms,lease_token,lease_until_ms) VALUES(?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET last_attempt_at_ms=excluded.last_attempt_at_ms,lease_token=excluded.lease_token,lease_until_ms=excluded.lease_until_ms
      WHERE account_usage_probe_state.lease_until_ms<=? AND (account_usage_probe_state.cache_key IS NOT ? OR account_usage_probe_state.cache_until_ms<=?) RETURNING account_id`)
      .bind(account.id,now,lease,now+35000,now,key,now).first()
    if (!claimed) { await new Promise(resolve=>setTimeout(resolve,100)); continue }
    try {
      const raw=await fetchAndPersist(env,account)
      await env.DB.prepare(`UPDATE account_usage_probe_state SET response_json=?,error_json=NULL,cache_key=?,cache_until_ms=?,lease_token=NULL,lease_until_ms=0 WHERE account_id=? AND lease_token=?`)
        .bind(JSON.stringify(raw),key,Date.now()+180000,account.id,lease).run()
      return anthropicActiveUsage(raw,ui)
    } catch (error) {
      const safe=error instanceof GatewayError ? error : new GatewayError(502,'usage_upstream_error','Could not read Anthropic usage')
      await env.DB.prepare(`UPDATE account_usage_probe_state SET response_json=NULL,error_json=?,cache_key=?,cache_until_ms=?,lease_token=NULL,lease_until_ms=0 WHERE account_id=? AND lease_token=?`)
        .bind(JSON.stringify({status:safe.status,code:safe.code,message:safe.message}),key,Date.now()+(safe.status===412 ? 0 : 60000),account.id,lease).run()
      throw safe
    }
  }
  throw new GatewayError(504,'usage_refresh_timeout','Timed out waiting for the account usage refresh')
}
