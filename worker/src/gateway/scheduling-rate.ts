import type { AccountCandidate } from './types'

/** Scheduling signals never overwrite customer prices or the account cost multiplier. */
export function accountSchedulingRates(accounts: AccountCandidate[], oauthReference: number, now = Date.now()): Record<string, number> {
  const result: Record<string, number> = {}
  for (const account of accounts) {
    if (account.platform !== 'openai' && account.platform !== 'codex') continue
    let rate: number | null
    if (account.credential_kind === 'oauth') rate = oauthReference
    else if (account.credential_kind === 'api_key') rate = freshUpstreamRate(account.upstream_billing_probe_json, now)
    else continue
    // Pool DTO uses fixed precision integers, independently from billing PPM.
    if (rate !== null && Number.isFinite(rate) && rate >= 0 && Number.isSafeInteger(Math.round(rate * 1e6))) result[account.account_id] = Math.round(rate * 1e6)
  }
  return result
}

export function freshUpstreamRate(encoded: string | null | undefined, now: number): number | null {
  if (!encoded) return null
  try {
    const snapshot = JSON.parse(encoded)
    if (!['ok', 'failed'].includes(snapshot.status)) return null
    const received = Date.parse(snapshot.received_at)
    let fresh = Date.parse(snapshot.fresh_until)
    if (!Number.isFinite(fresh) && snapshot.status === 'ok') {
      const interval = Date.parse(snapshot.next_probe_at) - received
      if (interval > 0) fresh = received + 2 * interval
    }
    if (!Number.isFinite(received) || !Number.isFinite(fresh) || fresh <= received || now < received || now > fresh) return null
    const data = snapshot.data
    if (data?.billing_scope !== 'token' || typeof data.resolved_rate_multiplier !== 'number' || !Number.isFinite(data.resolved_rate_multiplier) || data.resolved_rate_multiplier < 0 || typeof data.peak_rate_enabled !== 'boolean') return null
    let factor = 1
    if (data.peak_rate_enabled) {
      const minute = (value: unknown): number => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : -1
      const start = minute(data.peak_start), end = minute(data.peak_end)
      if (start < 0 || end <= start || typeof data.timezone !== 'string' || typeof data.peak_rate_multiplier !== 'number' || !Number.isFinite(data.peak_rate_multiplier) || data.peak_rate_multiplier < 0) return null
      const parts = new Intl.DateTimeFormat('en-GB', {timeZone:data.timezone, hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now)
      const local = Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value)
      if (local >= start && local < end) factor = data.peak_rate_multiplier
    }
    const rate = data.resolved_rate_multiplier * factor
    return Number.isFinite(rate) ? rate : null
  } catch { return null }
}
