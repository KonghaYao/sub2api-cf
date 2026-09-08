import type { Env } from '../env'
import type { AccountCredential } from './types'
import { saveAccountRuntimeObservation } from './account-runtime-observation'

/** Original UpdateSessionWindow + samplePassiveUsageFromHeaders on successful responses. */
export function anthropicUsageObservation(ui: Record<string, unknown>, headers: Headers, now = Date.now()): Record<string, unknown> | null {
  const status = headers.get('anthropic-ratelimit-unified-5h-status')
  if (!status) return null
  const extra: Record<string, unknown> = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? { ...ui.extra } : {}
  const previous = typeof ui.session_window_end === 'string' ? Date.parse(ui.session_window_end) : NaN
  const initialize = !Number.isFinite(previous) || now > previous
  const unix = (raw: string | null) => {
    if (!raw || !/^[+-]?\d+$/.test(raw)) return null
    let value = Number(raw)
    if (!Number.isSafeInteger(value)) return null
    if (value > 1e11) value = Math.trunc(value / 1000)
    return value
  }
  const rawEnd = unix(headers.get('anthropic-ratelimit-unified-5h-reset'))
  let end: number | null = rawEnd !== null && rawEnd * 1000 >= now-18000000 && rawEnd * 1000 <= now+604800000
    && (initialize || rawEnd * 1000 !== previous) ? rawEnd*1000 : null
  if (end === null && initialize && ['allowed','allowed_warning'].includes(status)) end = Math.floor(now/3600000)*3600000+18000000
  if (end !== null && initialize) for (const key of ['session_window_utilization','passive_usage_7d_utilization','passive_usage_7d_reset',
    'passive_usage_7d_oi_utilization','passive_usage_7d_oi_reset','passive_usage_sampled_at']) extra[key]=null
  let sampled=false
  for (const [window,key] of [['5h','session_window'],['7d','passive_usage_7d'],['7d_oi','passive_usage_7d_oi']]) {
    const raw = headers.get(`anthropic-ratelimit-unified-${window}-utilization`)
    if (raw && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw))) {
      extra[`${key}_utilization`]=Number(raw); sampled=true
    }
    if (window !== '5h') {
      const reset=unix(headers.get(`anthropic-ratelimit-unified-${window}-reset`))
      if (reset !== null) { extra[`${key}_reset`]=reset; sampled=true }
    }
  }
  if (sampled) extra.passive_usage_sampled_at=new Date(now).toISOString()
  return {...ui,extra,session_window_status:status,...(end===null?{}:{session_window_start:new Date(end-18000000).toISOString(),session_window_end:new Date(end).toISOString()}),
    ...(status==='allowed' && typeof ui.rate_limit_reset_at==='string' && Date.parse(ui.rate_limit_reset_at)>now ? {rate_limited_at:null,rate_limit_reset_at:null} : {})}
}

export async function persistAnthropicUsageObservation(env: Env, account: AccountCredential, response: Response): Promise<boolean> {
  if (account.platform !== 'anthropic' || !['oauth','setup_token'].includes(account.credential_kind) || !response.ok || !account.runtime_snapshot) return false
  const now=Date.now()
  if (!response.headers.get('anthropic-ratelimit-unified-5h-status')) return false
  return saveAccountRuntimeObservation(env,account,ui=>anthropicUsageObservation(ui,response.headers,now) ?? ui,'preserve',false)
}
