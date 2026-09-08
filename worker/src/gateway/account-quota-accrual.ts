import type { Env } from '../env'
import { accountQuotaNextReset, accountQuotaPeriodExpired } from '../control/account-quota-projection'

/** Quota cost uses raw standard cost, not the account-statistics price override. */
export function accountQuotaCost(standardMicros: number, multiplierPpm: number): number {
  if (![standardMicros, multiplierPpm].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid account quota cost basis')
  const result = (BigInt(standardMicros) * BigInt(multiplierPpm) + 500000n) / 1000000n
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Account quota cost overflow')
  return Number(result)
}

/** Prepare a guarded update to be committed with usage projection and inbox receipt. */
export async function accountQuotaAccrual(env: Env, accountId: string, costMicros: number, now: number, occurredAt = now): Promise<D1PreparedStatement[]> {
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new Error('Invalid account quota cost')
  if (costMicros === 0) return []
  const row = await env.DB.prepare('SELECT credential_kind, ui_config_json, config_version, control_version FROM accounts WHERE id = ?')
    .bind(accountId).first<{ credential_kind: string; ui_config_json: string; config_version: number; control_version: number }>()
  if (!row || typeof row.ui_config_json !== 'string') return []
  const ui = JSON.parse(row.ui_config_json)
  if (typeof ui._worker_account_quota_reset_at_ms === 'number' && occurredAt <= ui._worker_account_quota_reset_at_ms) return []
  if (row.credential_kind !== 'api_key' && ui.type !== 'bedrock') return []
  if (ui.parent_account_id != null) return []
  const extra = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? { ...ui.extra } : {}
  const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0
  if (!['quota_limit', 'quota_daily_limit', 'quota_weekly_limit'].some(key => positive(extra[key]))) return []
  const add = (value: unknown) => {
    const previous = typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e6) : 0
    const total = previous + costMicros
    if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(total)) throw new Error('Account quota usage overflow')
    return total / 1e6
  }
  extra.quota_used = add(extra.quota_used)
  for (const dimension of ['daily', 'weekly'] as const) {
    const prefix = `quota_${dimension}`
    if (!positive(extra[`${prefix}_limit`])) continue
    const expired = accountQuotaPeriodExpired(extra, dimension, now)
    extra[`${prefix}_used`] = add(expired ? 0 : extra[`${prefix}_used`])
    if (expired) {
      extra[`${prefix}_start`] = new Date(now).toISOString()
      if (extra[`${prefix}_reset_mode`] === 'fixed') extra[`${prefix}_reset_at`] = new Date(accountQuotaNextReset(extra, dimension, now)).toISOString()
    }
  }
  ui.extra = extra
  return [env.DB.prepare(`UPDATE accounts SET ui_config_json = ?, config_version = config_version + 1,
    control_version = CASE WHEN config_version = ? AND control_version = ? AND ui_config_json = ? THEN control_version + 1 ELSE -1 END,
    updated_at_ms = ? WHERE id = ?`).bind(JSON.stringify(ui), row.config_version, row.control_version, row.ui_config_json, now, accountId)]
}
