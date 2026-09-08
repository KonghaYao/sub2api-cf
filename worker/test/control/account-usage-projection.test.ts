import { describe, expect, it } from 'vitest'
import { anthropicPassiveUsage, codexUsageWindow, codexUsageStatsStart } from '../../src/control/account-usage-projection'
const now = Date.parse('2026-09-08T00:00:00Z')
describe('original account usage window projection', () => {
  it('distinguishes unknown Codex utilization from a measured zero', () => {
    expect(codexUsageWindow({}, '5h', now)).toBeNull()
    expect(codexUsageWindow({ codex_5h_used_percent: 0 }, '5h', now)).toEqual({ utilization: 0, resets_at: null, remaining_seconds: 0 })
  })
  it('anchors relative resets to the observation timestamp rather than extending on each read', () => {
    const extra = { codex_7d_used_percent: '42.5', codex_7d_reset_after_seconds: '120', codex_usage_updated_at: new Date(now).toISOString() }
    expect(codexUsageWindow(extra, '7d', now + 60000)).toMatchObject({ utilization: 42.5, remaining_seconds: 60 })
    expect(codexUsageWindow(extra, '7d', now + 120000)).toMatchObject({ utilization: 0, remaining_seconds: 0, resets_at: new Date(now + 120000).toISOString() })
  })
  it('prefers absolute resets and preserves over-limit percentages', () => {
    expect(codexUsageWindow({ codex_5h_used_percent: 125, codex_5h_reset_at: new Date(now + 90000).toISOString(), codex_5h_reset_after_seconds: 999 }, '5h', now))
      .toMatchObject({ utilization: 125, remaining_seconds: 90 })
  })
  it.each(['rejected', 'allowed_warning', 'allowed'])('uses the original passive status estimate for %s', status => {
    expect(anthropicPassiveUsage({ session_window_end: new Date(now + 10000).toISOString(), session_window_status: status }, now).five_hour?.utilization)
      .toBe(status === 'rejected' ? 100 : status === 'allowed_warning' ? 80 : 0)
  })
  it('converts fraction units and preserves the provider-specific expiration behavior', () => {
    const snapshot = anthropicPassiveUsage({ session_window_end: new Date(now - 1000).toISOString(), extra: {
      session_window_utilization: 0.9, passive_usage_sampled_at: new Date(now - 2000).toISOString(),
      passive_usage_7d_utilization: '0.4', passive_usage_7d_reset: (now - 1000) / 1000,
      passive_usage_7d_oi_utilization: 0.25, passive_usage_7d_oi_reset: (now + 1000) / 1000,
    } }, now)
    expect(snapshot).toMatchObject({ source: 'passive', five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 40, remaining_seconds: 0 }, seven_day_fable: { utilization: 25, remaining_seconds: 1 } })
  })
  it('does not coerce a stored utilization string into a measured Anthropic five-hour value', () => {
    expect(anthropicPassiveUsage({ session_window_end: new Date(now + 10000).toISOString(), session_window_status: 'rejected', extra: { session_window_utilization: '0.2' } }, now).five_hour?.utilization).toBe(100)
  })
  it('aligns local stats to a known active window and otherwise uses a rolling window', () => {
    const window = codexUsageWindow({ codex_5h_used_percent: 1, codex_5h_reset_at: new Date(now + 3600000).toISOString() }, '5h', now)
    expect(codexUsageStatsStart(window, 18000000, now)).toBe(now - 14400000)
    expect(codexUsageStatsStart(null, 18000000, now)).toBe(now - 18000000)
  })
})
