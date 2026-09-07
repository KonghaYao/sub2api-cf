import type { Env } from '../env'
import type { AccountCredential } from './types'
import { loadRuntimeSetting, type RuntimeSettings } from '../control/runtime-settings'
import { GatewayError } from './errors'
import { disablePoolAccount, recordPoolFailure } from './state-client'

export async function configuredFailureCooldown(env: Env, response: Response): Promise<number> {
  if (response.status === 529) {
    const settings = await loadRuntimeSetting(env, 'overload-cooldown')
    return settings.enabled ? settings.cooldown_minutes * 60_000 : 0
  }
  if (response.status === 429) {
    const retry = response.headers.get('retry-after')
    if (retry !== null) {
      const seconds = /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(7_200_000, Math.ceil(seconds * 1000))
    }
    const settings = await loadRuntimeSetting(env, 'rate-limit-429-cooldown')
    return settings.enabled ? settings.cooldown_seconds * 1000 : 0
  }
  return 30_000
}

export async function recordConfiguredUpstreamFailure(env: Env, pool: DurableObjectStub, accountId: string, requestId: string, response: Response): Promise<void> {
  const duration = await configuredFailureCooldown(env, response)
  if (duration > 0) await recordPoolFailure(pool, accountId, requestId, duration)
}

export function applyBetaPolicy(settings: RuntimeSettings['beta-policy'], raw: string | null, model: string, credentialKind: AccountCredential['credential_kind']): string | null {
  if (!raw) return null
  if (raw.length > 8192) throw new GatewayError(400, 'invalid_beta_header', 'Beta header exceeds the limit')
  const scope = credentialKind === 'api_key' ? 'apikey' : 'oauth'
  const tokens = [...new Set(raw.split(',').map(t => t.trim()).filter(Boolean))]
  return tokens.filter(token => {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(token)) throw new GatewayError(400, 'invalid_beta_header', 'Beta header contains an invalid token')
    const rule = settings.rules.find(rule => rule.beta_token === token && (rule.scope === 'all' || rule.scope === scope))
    if (!rule) return true
    const matches = !rule.model_whitelist?.length || rule.model_whitelist.some(pattern => wildcard(pattern,model))
    const action = matches ? rule.action : rule.fallback_action ?? 'pass'
    if (action === 'block') throw new GatewayError(400, 'beta_policy_blocked', (matches ? rule.error_message : rule.fallback_error_message) || `Beta feature ${token} is blocked`)
    return action !== 'filter'
  }).join(',') || null
}
function wildcard(pattern: string, value: string): boolean {
  let p=0,v=0,star=-1,retry=0
  while(v<value.length) {
    if(pattern[p]===value[v]) {p++;v++}
    else if(pattern[p]==='*') {star=p++;retry=v}
    else if(star>=0) {p=star+1;v=++retry}
    else return false
  }
  while(pattern[p]==='*') p++
  return p===pattern.length
}

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
export function rectifyAnthropicRequest(settings: RuntimeSettings['rectifier'], original: unknown, errorBody: unknown, kind: AccountCredential['credential_kind'], model: string): Record<string, unknown> | null {
  if (!settings.enabled || /deepseek|kimi|glm/i.test(model)) return null
  const input = record(original)
  if (!input) return null
  const error = record(record(errorBody)?.error)
  const message = (typeof error?.message === 'string' ? error.message : typeof errorBody === 'string' ? errorBody : '').toLowerCase()
  const signatureEnabled = kind === 'api_key' ? settings.apikey_signature_enabled : settings.thinking_signature_enabled
  const signatureMatch = message.includes('signature') || (kind === 'api_key' && settings.apikey_signature_patterns.some(p => message.includes(p.trim().toLowerCase())))
  if (signatureEnabled && signatureMatch && Array.isArray(input.messages)) {
    const output = structuredClone(input)
    let changed = false
    output.messages = (output.messages as unknown[]).map(message => {
      const entry = record(message)
      if (!entry || !Array.isArray(entry.content)) return message
      const content = entry.content.filter(block => {
        const type = record(block)?.type
        if (type === 'thinking' || type === 'redacted_thinking') { changed = true; return false }
        return true
      })
      return { ...entry, content }
    })
    if (changed) return output
  }
  const thinking = record(input.thinking)
  if (settings.thinking_budget_enabled && thinking?.type !== 'adaptive' && /budget[_ ]tokens/.test(message) && message.includes('thinking') && message.includes('1024')) {
    const max = input.max_tokens
    // Never expand the user-authorized output cap after financial reservation.
    if (Number.isSafeInteger(max) && Number(max) > 1024) {
      const budget = Math.min(32000, Number(max) - 1)
      if (thinking?.budget_tokens !== budget || thinking?.type !== 'enabled') return { ...input, thinking: { ...thinking, type: 'enabled', budget_tokens: budget } }
    }
  }
  return null
}

export async function applyStreamTimeoutPolicy(env: Env, pool: DurableObjectStub, accountId: string, requestId: string, error: unknown): Promise<boolean> {
  if (!(error instanceof GatewayError) || !['upstream_timeout','upstream_idle_timeout'].includes(error.code)) return false
  const settings = await loadRuntimeSetting(env, 'stream-timeout')
  if (!settings.enabled || settings.action === 'none') return true
  const now = Date.now(), cutoff = now - settings.threshold_window_minutes * 60_000
  const result = await env.DB.batch([
    env.DB.prepare('DELETE FROM stream_timeout_events WHERE account_id=? AND occurred_at_ms<?').bind(accountId,cutoff),
    env.DB.prepare('INSERT OR IGNORE INTO stream_timeout_events(request_id,account_id,occurred_at_ms) VALUES(?,?,?)').bind(requestId,accountId,now),
    env.DB.prepare('SELECT COUNT(*) AS total FROM stream_timeout_events WHERE account_id=? AND occurred_at_ms>=?').bind(accountId,cutoff),
  ])
  const count = (result[2].results[0] as { total: number }).total
  if (count < settings.threshold_count) return true
  if (settings.action === 'temp_unsched') await recordPoolFailure(pool,accountId,`${requestId}:configured-stream-timeout`,settings.temp_unsched_minutes * 60_000)
  else {
    await env.DB.prepare("UPDATE accounts SET health_status='unhealthy',last_health_error='Stream timeout threshold exceeded',last_checked_at_ms=?,updated_at_ms=? WHERE id=?").bind(now,now,accountId).run()
    await disablePoolAccount(pool,accountId)
  }
  return true
}
