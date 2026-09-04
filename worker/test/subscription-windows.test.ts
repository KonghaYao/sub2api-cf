import { describe, expect, it } from 'vitest'
import { normalizeSubscriptionWindows } from '../src/subscription-windows'

const day = 86_400_000

describe('subscription D1 window read normalization', () => {
  it('opens naturally elapsed daily, weekly, and monthly windows before a new settlement arrives', () => {
    const startsAt = Date.UTC(2026, 0, 1, 12)
    const projection = {
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 120 * day,
      daily_used_micros: 10,
      weekly_used_micros: 20,
      monthly_used_micros: 30,
      daily_window_start_ms: Date.UTC(2026, 0, 1),
      weekly_window_start_ms: startsAt,
      monthly_window_start_ms: startsAt,
    }
    const now = startsAt + 31 * day

    expect(normalizeSubscriptionWindows(projection, now)).toMatchObject({
      daily_used_micros: 0,
      weekly_used_micros: 0,
      monthly_used_micros: 0,
      daily_window_start_ms: Math.floor(now / day) * day,
      weekly_window_start_ms: startsAt + 28 * day,
      monthly_window_start_ms: startsAt + 30 * day,
    })
  })

  it('preserves usage in current and single-day subscription windows', () => {
    const startsAt = Date.UTC(2026, 8, 4, 12)
    const projection = {
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + day,
      daily_used_micros: 10,
      weekly_used_micros: 20,
      monthly_used_micros: 30,
      daily_window_start_ms: startsAt,
      weekly_window_start_ms: startsAt,
      monthly_window_start_ms: startsAt,
    }

    expect(normalizeSubscriptionWindows(projection, startsAt + 1_000)).toEqual(projection)
  })

  it('preserves an active one-day window after the entitlement is extended', () => {
    const startsAt = Date.UTC(2026, 8, 1, 23, 50)
    const projection = {
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 2 * day,
      daily_used_micros: 80,
      weekly_used_micros: 80,
      monthly_used_micros: 80,
      daily_anchor_ms: startsAt,
      daily_window_start_ms: startsAt,
      weekly_window_start_ms: startsAt,
      monthly_window_start_ms: startsAt,
    }

    expect(normalizeSubscriptionWindows(projection, startsAt + 15 * 60_000)).toMatchObject({
      daily_used_micros: 80,
      daily_window_start_ms: startsAt,
    })
    expect(normalizeSubscriptionWindows(projection, startsAt + day)).toMatchObject({
      daily_used_micros: 0,
      daily_window_start_ms: startsAt + day,
    })
    expect(normalizeSubscriptionWindows({
      ...projection,
      daily_used_micros: 80,
      daily_window_start_ms: startsAt + day,
    }, Date.UTC(2026, 8, 3))).toMatchObject({
      daily_used_micros: 80,
      daily_window_start_ms: startsAt + day,
    })
  })
})
