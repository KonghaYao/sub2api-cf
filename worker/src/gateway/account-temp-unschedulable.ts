import { saveAccountRuntimeObservation } from './account-runtime-observation'
import type { Env } from '../env'
import type { AccountCredential, UpstreamCredential } from './types'
import { boundedErrorBody } from './openai-rate-limit-persistence'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const integer = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value)
  : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim()) : 0

/** Original OpenAI error-rule policy. Provider-specific window policies must run before generic rules. */
export async function persistAccountTempUnschedulable(env: Env, account: AccountCredential, credential: UpstreamCredential,
  response: Response, upstreamModel: string | undefined): Promise<boolean> {
  const snapshot = account.runtime_snapshot
  if (!snapshot || !['openai', 'codex'].includes(account.platform) || response.ok || response.status < 400) return false
  const settings = credential as unknown as Record<string, unknown>
  if (settings.temp_unschedulable_enabled !== true) return false
  const apiKey = account.credential_kind === 'api_key'
  // The original CheckErrorPolicy gives explicit custom error-code policies precedence.
  if (apiKey && settings.custom_error_codes_enabled === true) return false
  const pool = apiKey && settings.pool_mode === true
  if (response.status === 529 && !pool || response.status === 401 && pool) return false
  const ui = object(JSON.parse(snapshot.ui_config_json))
  let repeated401 = false
  if (response.status === 401) {
    try { repeated401 = object(JSON.parse(String(ui.temp_unschedulable_reason ?? ''))).status_code === 401 } catch { /* legacy plain-text reason */ }
  }
  const rules = Array.isArray(settings.temp_unschedulable_rules) ? settings.temp_unschedulable_rules.map(object).map(rule => ({
    code: integer(rule.error_code), minutes: integer(rule.duration_minutes),
    keywords: Array.isArray(rule.keywords) ? rule.keywords.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean) : [],
  })).filter(rule => rule.code > 0 && rule.minutes > 0 && rule.keywords.length) : []
  if (!repeated401 && !rules.some(rule => rule.code === response.status)) return false
  const body = await boundedErrorBody(response)
  const lower = body.toLowerCase()
  const index = rules.findIndex(rule => rule.code === response.status && rule.keywords.some(keyword => lower.includes(keyword.toLowerCase())))
  if (!repeated401 && index < 0) return false
  const now = Date.now()
  if (!repeated401) {
    const rule = rules[index]!
    const until = now + rule.minutes * 60000
    if (!Number.isSafeInteger(until) || !Number.isFinite(new Date(until).getTime())) return false
    const reason = JSON.stringify({ until_unix: Math.floor(until / 1000), triggered_at_unix: Math.floor(now / 1000), status_code: response.status,
      matched_keyword: rule.keywords.find(keyword => lower.includes(keyword.toLowerCase()))!, rule_index: index,
      error_message: new TextDecoder().decode(new TextEncoder().encode(body).slice(0, 2048)).trim() })
    const model = upstreamModel?.trim()
    if (model && response.status !== 401) {
      const extra = object(ui.extra)
      ui.extra = { ...extra, model_rate_limits: { ...object(extra.model_rate_limits),
        [model]: { rate_limited_at: new Date(now).toISOString(), rate_limit_reset_at: new Date(until).toISOString(), reason } } }
    } else {
      ui.temp_unschedulable_until = new Date(until).toISOString()
      ui.temp_unschedulable_reason = reason
    }
  }
  const saved = await saveAccountRuntimeObservation(env, account, current => {
    if (repeated401) return current
    const model = upstreamModel?.trim()
    if (model && response.status !== 401) {
      const extra = object(current.extra)
      return { ...current, extra: { ...extra, model_rate_limits: { ...object(extra.model_rate_limits),
        [model]: object(object(ui.extra).model_rate_limits)[model] } } }
    }
    return { ...current, temp_unschedulable_until: ui.temp_unschedulable_until, temp_unschedulable_reason: ui.temp_unschedulable_reason }
  }, repeated401 ? 'auth-failed' : 'preserve')
  // A matched rule still requires failover if a concurrent edit prevented persistence.
  return saved || index >= 0
}
