import type { AccountCredential, TokenUsage } from './types'
export type CacheTtlTarget = '5m' | '1h'
type Account = Pick<AccountCredential, 'platform' | 'credential_kind' | 'runtime_snapshot'>
const eligible = (account: Account) => account.platform === 'anthropic' && ['oauth', 'setup_token'].includes(account.credential_kind)
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0

export function resolveCacheTtlTarget(account: Account, injectOneHour = false): CacheTtlTarget | undefined {
  if (!eligible(account)) return undefined
  let extra: Record<string, unknown> | undefined
  try { extra = JSON.parse(account.runtime_snapshot?.ui_config_json ?? '{}')?.extra } catch { /* No account override. */ }
  if (extra?.cache_ttl_override_enabled === true) return extra.cache_ttl_override_target === '1h' ? '1h' : '5m'
  return injectOneHour ? '5m' : undefined
}

export function injectCacheTtl(account: Account, body: Record<string, unknown>, enabled = false): Record<string, unknown> {
  if (!enabled || !eligible(account)) return body
  const output = structuredClone(body)
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    const cache = object.cache_control
    if (cache && typeof cache === 'object' && !Array.isArray(cache) && (cache as Record<string, unknown>).type === 'ephemeral') (cache as Record<string, unknown>).ttl = '1h'
    for (const [key, child] of Object.entries(object)) if (key !== 'cache_control') visit(child)
  }
  visit(output.system); visit(output.messages); visit(output.tools)
  return output
}

export function overrideCacheTtlUsage(usage: TokenUsage, target?: CacheTtlTarget): TokenUsage {
  if (!target) return usage
  const five = count(usage.cache_write_5m_tokens), hour = count(usage.cache_write_1h_tokens)
  const total = five + hour || count(usage.cache_write_tokens)
  if (!Number.isSafeInteger(total) || total === 0) return usage
  return { ...usage, cache_write_5m_tokens: target === '5m' ? total : 0,
    cache_write_1h_tokens: target === '1h' ? total : 0, cache_ttl_overridden: true }
}

/** Original JSON response patch: aggregate fallback applies to non-streaming
 * usage; SSE only rewrites a present nested cache_creation object. */
export function rewriteCacheTtlJson(usage: Record<string, unknown> | null, target?: CacheTtlTarget, aggregateFallback = false): void {
  if (!usage || !target) return
  const raw = usage.cache_creation
  const nested = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  let five = count(nested?.ephemeral_5m_input_tokens), hour = count(nested?.ephemeral_1h_input_tokens)
  if (aggregateFallback && five + hour === 0) five = count(usage.cache_creation_input_tokens)
  const total = five + hour
  if (!Number.isSafeInteger(total) || total === 0 || (target === '5m' ? five : hour) === total) return
  usage.cache_creation = { ...nested, ephemeral_5m_input_tokens: target === '5m' ? total : 0,
    ephemeral_1h_input_tokens: target === '1h' ? total : 0 }
}
