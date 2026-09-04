const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS

export interface SubscriptionWindowProjection {
  starts_at_ms: number
  expires_at_ms: number
  /** Zero means UTC-day windows; another value is a stable activation anchor. */
  daily_anchor_ms?: number
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
}

/**
 * D1 is an asynchronous query projection; a natural quota window may roll before
 * its first settlement advances the stored anchor. Normalize reads without
 * mutating D1 so user/admin views agree with the authoritative Durable Object.
 */
export function normalizeSubscriptionWindows<T extends SubscriptionWindowProjection>(
  projection: T,
  now: number,
): T {
  if (now < projection.starts_at_ms || now >= projection.expires_at_ms) return projection
  const daily = currentWindow(
    projection.daily_window_start_ms,
    projection.daily_used_micros,
    projection.starts_at_ms,
    projection.expires_at_ms,
    now,
    DAY_MS,
    true,
    projection.daily_anchor_ms,
  )
  const weekly = currentWindow(
    projection.weekly_window_start_ms,
    projection.weekly_used_micros,
    projection.starts_at_ms,
    projection.expires_at_ms,
    now,
    WEEK_MS,
    false,
  )
  const monthly = currentWindow(
    projection.monthly_window_start_ms,
    projection.monthly_used_micros,
    projection.starts_at_ms,
    projection.expires_at_ms,
    now,
    MONTH_MS,
    false,
  )
  return {
    ...projection,
    daily_used_micros: daily.used_micros,
    weekly_used_micros: weekly.used_micros,
    monthly_used_micros: monthly.used_micros,
    daily_window_start_ms: daily.start_ms,
    weekly_window_start_ms: weekly.start_ms,
    monthly_window_start_ms: monthly.start_ms,
  }
}

function currentWindow(
  persistedStart: number | null,
  persistedUsed: number,
  startsAt: number,
  expiresAt: number,
  now: number,
  period: number,
  utcDaily: boolean,
  dailyAnchor?: number,
): { start_ms: number; used_micros: number } {
  if (utcDaily) {
    const singleDailyWindow = expiresAt - startsAt <= DAY_MS
    const legacyActivationAligned = persistedStart !== null &&
      persistedStart % DAY_MS !== 0 && persistedUsed > 0
    const anchor = dailyAnchor ?? (singleDailyWindow || legacyActivationAligned ? startsAt : 0)
    const start = anchor + Math.floor((now - anchor) / DAY_MS) * DAY_MS
    return { start_ms: start, used_micros: persistedStart === start ? persistedUsed : 0 }
  }
  const anchor = persistedStart ?? startsAt
  const elapsed = Math.max(0, now - anchor)
  const start = anchor + Math.floor(elapsed / period) * period
  return { start_ms: start, used_micros: persistedStart === start ? persistedUsed : 0 }
}
