import { getAnthropicActiveUsage } from './anthropic-account-usage'
import type { Context } from 'hono'
import type { Env } from '../env'
import type { PrivacyAccount } from './account-privacy'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, readJsonObject } from './http'
import { anthropicPassiveUsage, codexUsageWindow, codexUsageStatsStart, type AccountUsageSnapshot, type AccountUsageProgress } from './account-usage-projection'
import { probeOpenAIAccountUsage } from './account-usage-probe'

async function loadAccount(env: Env, id: string): Promise<PrivacyAccount> {
  const row = await env.DB.prepare(`SELECT a.id,a.platform,a.credential_kind,a.credential_ref,a.config_version,a.control_version,a.ui_config_json,
    s.id AS secret_id,s.key_version,s.nonce_b64,s.ciphertext_b64 FROM accounts a JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id WHERE a.id=?`)
    .bind(id).first<PrivacyAccount>()
  if (!row) throw new GatewayError(404, 'account_not_found', 'Account not found')
  return row
}

/** Durable ten-minute attempt throttle; a forced refresh cannot overlap an active lease. */
export async function refreshAccountUsage(env: Env, account: PrivacyAccount, force: boolean, now = Date.now()): Promise<boolean> {
  const lease = crypto.randomUUID()
  const claimed = await env.DB.prepare(`INSERT INTO account_usage_probe_state(account_id,last_attempt_at_ms,lease_token,lease_until_ms)
    VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET last_attempt_at_ms=excluded.last_attempt_at_ms,
    lease_token=excluded.lease_token,lease_until_ms=excluded.lease_until_ms
    WHERE account_usage_probe_state.lease_until_ms<=? AND (?=1 OR account_usage_probe_state.last_attempt_at_ms<=?) RETURNING account_id`)
    .bind(account.id,now,lease,now+20000,now,force ? 1 : 0,now-600000).first()
  if (!claimed) return false
  try { await probeOpenAIAccountUsage(env, account); return true }
  finally {
    await env.DB.prepare('UPDATE account_usage_probe_state SET lease_token=NULL,lease_until_ms=0 WHERE account_id=? AND lease_token=?')
      .bind(account.id,lease).run()
  }
}

async function attachStats(env: Env, accountId: string, value: AccountUsageProgress | null, duration: number, now: number) {
  const start = codexUsageStatsStart(value, duration, now)
  const stats = await env.DB.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens),0) AS tokens,
    COALESCE(SUM(COALESCE(account_cost_micros,account_stats_cost_micros,standard_cost_micros,amount_micros)),0)/1000000.0 AS cost,
    COALESCE(SUM(COALESCE(standard_cost_micros,amount_micros)),0)/1000000.0 AS standard_cost,
    COALESCE(SUM(amount_micros),0)/1000000.0 AS user_cost FROM usage_projection WHERE account_id=? AND occurred_at_ms>=?`)
    .bind(accountId,start).first()
  return { ...(value ?? { utilization: 0, resets_at: null, remaining_seconds: 0 }), window_stats: stats }
}

export async function accountUsage(env: Env, id: string, source = 'active', force = false): Promise<AccountUsageSnapshot> {
  let account = await loadAccount(env,id)
  let ui = JSON.parse(account.ui_config_json) as Record<string, any>
  const passive = account.platform === 'anthropic' && ['oauth','setup_token'].includes(account.credential_kind)
  const now = Date.now()
  if (source === 'passive') {
    if (!passive) throw new GatewayError(400, 'passive_usage_not_supported', 'Passive usage requires an Anthropic OAuth or setup-token account')
    const result = anthropicPassiveUsage(ui,now)
    result.five_hour = await attachStats(env,id,result.five_hour,18000000,now)
    return result
  }
  if (passive) {
    const result = account.credential_kind === 'oauth' ? await getAnthropicActiveUsage(env,account) : anthropicPassiveUsage(ui,now)
    if (account.credential_kind === 'setup_token') { delete result.source; delete result.seven_day; delete result.seven_day_fable }
    result.five_hour = await attachStats(env,id,result.five_hour,18000000,Date.now())
    return result
  }
  if (account.platform !== 'openai' || account.credential_kind !== 'oauth') {
    throw new GatewayError(400, 'account_usage_not_supported', 'Active usage for this account provider is not implemented')
  }
  if (ui.parent_account_id != null) throw new GatewayError(400, 'shadow_usage_not_supported', 'Shadow usage requires its separate quota source')
  let extra = ui.extra ?? {}
  const five = codexUsageWindow(extra,'5h',now), seven = codexUsageWindow(extra,'7d',now)
  const ws = [extra.openai_oauth_responses_websockets_v2_enabled, extra.responses_websockets_v2_enabled, extra.openai_ws_enabled].find(value => typeof value === 'boolean') === true
  const observed = Date.parse(extra.codex_usage_updated_at ?? '')
  const stale = ws && (!Number.isFinite(observed) || now - observed >= 600000)
  // Missing windows, active cooldown and force always request a throttled refresh.
  if (force || stale || !five || !seven || Date.parse(ui.rate_limit_reset_at ?? '') > now) {
    try { await refreshAccountUsage(env,account,force,now) } catch { /* Original active probe failure retains the last observed snapshot. */ }
    account = await loadAccount(env,id); ui = JSON.parse(account.ui_config_json); extra = ui.extra ?? {}
  }
  return { updated_at: new Date(now).toISOString(),
    five_hour: await attachStats(env,id,codexUsageWindow(extra,'5h',now),18000000,now),
    seven_day: await attachStats(env,id,codexUsageWindow(extra,'7d',now),604800000,now) }
}

export async function getAdminAccountUsage(context: Context<{ Bindings: Env }>): Promise<Response> {
  try { return controlSuccess(await accountUsage(context.env,context.req.param('id')!,context.req.query('source') ?? 'active',context.req.query('force') === 'true')) }
  catch (error) { return controlError(asGatewayError(error)) }
}
export async function getBatchAdminAccountUsage(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw) as { account_ids?: unknown; force?: unknown }
    if (!body || typeof body !== 'object') throw new GatewayError(400,'invalid_usage_request','Expected a JSON object')
    if (!Array.isArray(body.account_ids) || body.force !== undefined && typeof body.force !== 'boolean') throw new GatewayError(400,'invalid_usage_request','account_ids must be an array and force must be a boolean')
    const ids = [...new Set(body.account_ids.filter(id => typeof id === 'string' && id.trim() || typeof id === 'number' && Number.isSafeInteger(id) && id > 0).map(String))]
    const usage: Record<string, AccountUsageSnapshot> = {}, errors: Record<string,string> = {}
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(6,ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]!
        try {
          const account = await loadAccount(context.env,id)
          const passive = account.platform === 'anthropic' && ['oauth','setup_token'].includes(account.credential_kind)
          usage[id] = await accountUsage(context.env,id,passive ? 'passive' : 'active',body.force === true)
        } catch (error) { errors[id] = asGatewayError(error).message }
      }
    }))
    return controlSuccess({ usage,errors })
  } catch (error) { return controlError(error instanceof SyntaxError ? new GatewayError(400,'invalid_json','Invalid JSON request') : asGatewayError(error)) }
}
