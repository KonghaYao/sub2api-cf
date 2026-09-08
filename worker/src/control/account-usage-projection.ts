export interface AccountUsageProgress {
  utilization: number
  resets_at: string | null
  remaining_seconds: number
}
export interface AccountUsageSnapshot {
  source?: 'passive' | 'active'
  updated_at?: string
  five_hour: AccountUsageProgress | null
  seven_day_sonnet?: AccountUsageProgress
  seven_day?: AccountUsageProgress
  seven_day_fable?: AccountUsageProgress
}
const number = (value: unknown): number => {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const timestamp = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
const progress = (utilization: number, reset: number | null, now: number): AccountUsageProgress => ({
  utilization, resets_at: reset === null ? null : new Date(reset).toISOString(),
  remaining_seconds: reset === null ? 0 : Math.max(0, Math.trunc((reset - now) / 1000)),
})

/** Original buildCodexUsageProgressFromExtra; percentages are already in percent units. */
export function codexUsageWindow(extra: Record<string, unknown>, window: '5h' | '7d', now = Date.now()): AccountUsageProgress | null {
  const prefix = `codex_${window}`
  if (!( `${prefix}_used_percent` in extra)) return null
  let reset = timestamp(extra[`${prefix}_reset_at`])
  const seconds = Math.trunc(number(extra[`${prefix}_reset_after_seconds`]))
  if (reset === null && seconds > 0) reset = (timestamp(extra.codex_usage_updated_at) ?? now) + seconds * 1000
  return progress(reset !== null && reset <= now ? 0 : number(extra[`${prefix}_used_percent`]), reset, now)
}

/** Passive seven-day observations retain the original value even after their reset timestamp. */
function passiveWindow(extra: Record<string, unknown>, prefix: string, now: number): AccountUsageProgress | undefined {
  const utilization = number(extra[`${prefix}_utilization`]), reset = number(extra[`${prefix}_reset`])
  if (utilization <= 0 && reset <= 0) return undefined
  return progress(utilization * 100, reset > 0 ? Math.trunc(reset) * 1000 : null, now)
}

export function anthropicPassiveUsage(ui: Record<string, unknown>, now = Date.now()): AccountUsageSnapshot {
  const extra = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? ui.extra as Record<string, unknown> : {}
  const reset = timestamp(ui.session_window_end)
  const stored = extra.session_window_utilization
  const utilization = typeof stored === 'number' && Number.isFinite(stored) ? stored * 100
    : ui.session_window_status === 'rejected' ? 100 : ui.session_window_status === 'allowed_warning' ? 80 : 0
  const sampled = timestamp(extra.passive_usage_sampled_at)
  return {
    source: 'passive', ...(sampled === null ? {} : { updated_at: new Date(sampled).toISOString() }),
    five_hour: reset !== null && reset > now ? progress(utilization, reset, now) : progress(0, null, now),
    ...optionalWindow('seven_day', passiveWindow(extra, 'passive_usage_7d', now)),
    ...optionalWindow('seven_day_fable', passiveWindow(extra, 'passive_usage_7d_oi', now)),
  }
}
function optionalWindow(key: string, value: AccountUsageProgress | undefined) {
  return value === undefined ? {} : { [key]: value }
}

export function codexUsageStatsStart(window: AccountUsageProgress | null, durationMs: number, now = Date.now()): number {
  const reset = timestamp(window?.resets_at)
  return reset !== null && reset > now ? reset - durationMs : now - durationMs
}
