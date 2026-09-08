/** Original upstream_billing_probe.go validation and rate arithmetic. */
type Data = Record<string, unknown>
const invalid = (): never => { throw new Error('Invalid upstream billing declaration') }
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const equal = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

function minute(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) return null
  const [hour, min] = value.split(':').map(Number)
  return hour < 24 && min < 60 ? hour * 60 + min : null
}

export function upstreamBillingPeakAt(data: Data, now: Date): number | null {
  if (data.peak_rate_enabled === false) return 1
  if (data.peak_rate_enabled !== true || !Number.isFinite(now.getTime())) return null
  const start = minute(data.peak_start), end = minute(data.peak_end)
  if (start === null || end === null || start >= end || typeof data.timezone !== 'string' || !data.timezone || !nonnegative(data.peak_rate_multiplier)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: data.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const at = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value)
    return at >= start && at < end ? data.peak_rate_multiplier : 1
  } catch { return null }
}

function observedTime(value: unknown): { date: Date; canonical: string } {
  if (typeof value !== 'string') return invalid()
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return invalid()
  const [, year, month, day, hour, min, sec, fraction, zone] = match
  const y = Number(year), m = Number(month), d = Number(day)
  const days = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(min) > 59 || Number(sec) > 59 ||
    (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return invalid()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return invalid()
  const digits = (fraction ?? '').replace(/0+$/, '')
  const canonical = date.toISOString().slice(0, 19) + (digits ? `.${digits}` : '') + 'Z'
  if (canonical === '0001-01-01T00:00:00Z') return invalid()
  return { date, canonical }
}

export function parseUpstreamBillingDeclaration(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const source = value as Data
  if (source.object !== 'sub2api.key_billing' || source.schema_version !== 1 || source.billing_scope !== 'token' || typeof source.peak_rate_enabled !== 'boolean') return invalid()
  for (const key of ['group_rate_multiplier', 'resolved_rate_multiplier', 'effective_rate_multiplier']) if (!nonnegative(source[key])) return invalid()
  if (source.user_rate_multiplier != null && !nonnegative(source.user_rate_multiplier)) return invalid()
  if (source.applied_peak_multiplier != null && !nonnegative(source.applied_peak_multiplier)) return invalid()
  for (const key of ['peak_start', 'peak_end', 'timezone']) if (source[key] != null && typeof source[key] !== 'string') return invalid()
  if (source.peak_rate_multiplier != null && (typeof source.peak_rate_multiplier !== 'number' || !Number.isFinite(source.peak_rate_multiplier))) return invalid()
  const resolved = source.resolved_rate_multiplier as number
  if (!equal(resolved, (source.user_rate_multiplier ?? source.group_rate_multiplier) as number)) return invalid()
  const observed = observedTime(source.observed_at)
  const data: Data = { object: source.object, schema_version: 1, billing_scope: 'token',
    group_rate_multiplier: source.group_rate_multiplier, resolved_rate_multiplier: resolved,
    peak_rate_enabled: source.peak_rate_enabled, effective_rate_multiplier: source.effective_rate_multiplier, observed_at: observed.canonical }
  if (source.user_rate_multiplier != null) data.user_rate_multiplier = source.user_rate_multiplier
  if (source.peak_rate_enabled) {
    if (!nonnegative(source.peak_rate_multiplier) || !nonnegative(source.applied_peak_multiplier)) return invalid()
    for (const key of ['peak_start', 'peak_end', 'timezone', 'peak_rate_multiplier', 'applied_peak_multiplier']) data[key] = source[key]
  }
  const peak = upstreamBillingPeakAt(data, observed.date)
  if (peak === null || (source.applied_peak_multiplier != null && !equal(source.applied_peak_multiplier as number, peak)) || !equal(source.effective_rate_multiplier as number, resolved * peak)) return invalid()
  return data
}

export function upstreamBillingRateAt(data: Data, now: Date): number | null {
  if (data.billing_scope !== 'token' || !nonnegative(data.resolved_rate_multiplier)) return null
  const peak = upstreamBillingPeakAt(data, now)
  if (peak === null) return null
  const result = data.resolved_rate_multiplier * peak
  return Number.isFinite(result) ? result : null
}

/** Automatic write-back uses the base rate, never freezes a momentary peak. */
export function upstreamBillingSyncRate(data: Data): number | null {
  if (!nonnegative(data.resolved_rate_multiplier)) return null
  const rounded = Math.round(data.resolved_rate_multiplier * 10_000) / 10_000
  return rounded > 0 && rounded <= 100 ? rounded : null
}
