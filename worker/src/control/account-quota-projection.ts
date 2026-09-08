const DAY = 86400000
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** Mirrors original account quota DTO; reads never mutate persisted counters. */
export function accountQuotaProjection(extra: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const configuredTimezone = typeof extra.quota_reset_timezone === 'string' && extra.quota_reset_timezone ? extra.quota_reset_timezone : 'UTC'
  for (const dimension of ['', '_daily', '_weekly']) {
    const prefix = `quota${dimension}`, limit = number(extra[`${prefix}_limit`])
    if (limit > 0) {
      result[`${prefix}_limit`] = limit
      let used = number(extra[`${prefix}_used`])
      if (dimension) {
        const expired = accountQuotaPeriodExpired(extra, dimension === '_weekly' ? 'weekly' : 'daily', now)
        if (expired) used = 0
      }
      result[`${prefix}_used`] = used
    }
    if (!dimension) continue
    if (extra[`${prefix}_reset_mode`] === 'fixed') {
      result[`${prefix}_reset_mode`] = 'fixed'
      result[`${prefix}_reset_hour`] = number(extra[`${prefix}_reset_hour`])
      if (dimension === '_weekly') result.quota_weekly_reset_day = number(extra.quota_weekly_reset_day, 1)
      result.quota_reset_timezone = configuredTimezone
    }
    const reset = extra[`${prefix}_reset_at`]
    if (typeof reset === 'string' && reset) result[`${prefix}_reset_at`] = reset
  }
  return result
}

function parts(ms: number, timezone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
  return values as Record<string, number>
}
function offset(ms: number, timezone: string) {
  const p = parts(ms, timezone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}
/** Go time.Date chooses the zone at the wall-time estimate, then rechecks UTC. */
function wallTime(year: number, month: number, day: number, hour: number, timezone: string) {
  const target = Date.UTC(year, month - 1, day, hour)
  const first = offset(target, timezone)
  return target - offset(target - first, timezone)
}
function lastReset(now: number, timezone: string, hour: number, weekday?: number) {
  const p = parts(now, timezone)
  const today = wallTime(p.year, p.month, p.day, Math.trunc(hour), timezone)
  const normalized = parts(today, timezone)
  const date = Date.UTC(normalized.year, normalized.month - 1, normalized.day)
  let back = weekday === undefined ? 0 : (new Date(date).getUTCDay() - Math.trunc(weekday) + 7) % 7
  if (back === 0 && now < today) back = weekday === undefined ? 1 : 7
  if (back === 0) return today
  const previous = new Date(date - back * DAY)
  return wallTime(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate(), normalized.hour, timezone)
}

function quotaTimezone(extra: Record<string, unknown>, now: number) {
  const timezone = typeof extra.quota_reset_timezone === 'string' && extra.quota_reset_timezone ? extra.quota_reset_timezone : 'UTC'
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now); return timezone } catch { return 'UTC' }
}
export function accountQuotaPeriodExpired(extra: Record<string, unknown>, dimension: 'daily' | 'weekly', now: number): boolean {
  const prefix = `quota_${dimension}`, raw = extra[`${prefix}_start`]
  const start = typeof raw === 'string' ? Date.parse(raw) : NaN
  if (!Number.isFinite(start)) return true
  if (extra[`${prefix}_reset_mode`] !== 'fixed') return now - start >= (dimension === 'weekly' ? 7 : 1) * DAY
  return start < lastReset(now, quotaTimezone(extra, now), number(extra[`${prefix}_reset_hour`]), dimension === 'weekly' ? number(extra.quota_weekly_reset_day, 1) : undefined)
}
export function accountQuotaNextReset(extra: Record<string, unknown>, dimension: 'daily' | 'weekly', now: number): number {
  const timezone = quotaTimezone(extra, now), p = parts(now, timezone)
  const today = wallTime(p.year, p.month, p.day, Math.trunc(number(extra[`quota_${dimension}_reset_hour`])), timezone)
  const normalized = parts(today, timezone), date = Date.UTC(normalized.year, normalized.month - 1, normalized.day)
  let forward = dimension === 'weekly' ? (Math.trunc(number(extra.quota_weekly_reset_day, 1)) - new Date(date).getUTCDay() + 7) % 7 : 0
  if (forward === 0 && now >= today) forward = dimension === 'weekly' ? 7 : 1
  const next = new Date(date + forward * DAY)
  return wallTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), normalized.hour, timezone)
}
