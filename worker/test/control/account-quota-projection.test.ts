import { expect, it } from 'vitest'
import { accountQuotaProjection } from '../../src/control/account-quota-projection'
const now = Date.parse('2026-09-08T04:00:00Z')
it.each(['daily', 'weekly'])('expires rolling %s counters exactly at the boundary without mutating storage', dimension => {
  const duration = (dimension === 'daily' ? 1 : 7) * 86400000
  for (const [elapsed, expected] of [[duration - 1, 5], [duration, 0], [duration + 1, 0]]) {
    const extra = { quota_limit: 100, quota_used: 50, [`quota_${dimension}_limit`]: 10,
      [`quota_${dimension}_used`]: 5, [`quota_${dimension}_start`]: new Date(now - elapsed).toISOString() }
    expect(accountQuotaProjection(extra, now)).toMatchObject({ quota_used: 50, [`quota_${dimension}_used`]: expected })
    expect(extra[`quota_${dimension}_used`]).toBe(5)
  }
})
it.each([undefined, '', 'invalid'])('treats missing or invalid period start as expired: %s', start => {
  expect(accountQuotaProjection({ quota_daily_limit: 10, quota_daily_used: 5, quota_daily_start: start }, now)).toMatchObject({ quota_daily_used: 0 })
})
it.each([
  ['Asia/Shanghai', '2026-09-08T04:00:00Z', '2026-09-08T00:00:00Z', 8, undefined],
  ['Asia/Shanghai', '2026-09-07T23:00:00Z', '2026-09-07T00:00:00Z', 8, undefined],
  ['America/New_York', '2026-03-08T16:00:00Z', '2026-03-08T12:00:00Z', 8, undefined],
  ['America/New_York', '2026-11-01T17:00:00Z', '2026-11-01T13:00:00Z', 8, undefined],
  // Verified directly with Go time.Date, including nonexistent/duplicated hours.
  ['America/New_York', '2026-03-08T16:00:00Z', '2026-03-08T06:00:00Z', 2, undefined],
  ['America/New_York', '2026-11-01T17:00:00Z', '2026-11-01T05:00:00Z', 1, undefined],
  ['Europe/Berlin', '2026-03-29T12:00:00Z', '2026-03-29T01:00:00Z', 2, undefined],
  ['Europe/Berlin', '2026-10-25T12:00:00Z', '2026-10-25T01:00:00Z', 2, undefined],
  ['UTC', '2026-09-07T07:00:00Z', '2026-08-31T08:00:00Z', 8, 1],
  ['UTC', '2026-09-07T08:00:00Z', '2026-09-07T08:00:00Z', 8, 1],
  ['Asia/Shanghai', '2026-09-06T01:00:00Z', '2026-09-06T00:00:00Z', 8, 0],
  ['Invalid/Timezone', '2026-09-08T12:00:00Z', '2026-09-08T08:00:00Z', 8, undefined],
] as const)('uses fixed calendar reset in %s at %s', (timezone, clock, reset, hour, weekday) => {
  const prefix = weekday === undefined ? 'quota_daily' : 'quota_weekly'
  for (const [delta, expected] of [[-1, 0], [0, 5], [1, 5]]) {
    const extra = { [`${prefix}_limit`]: 10, [`${prefix}_used`]: 5, [`${prefix}_reset_mode`]: 'fixed',
      [`${prefix}_reset_hour`]: hour, quota_weekly_reset_day: weekday, quota_reset_timezone: timezone,
      [`${prefix}_start`]: new Date(Date.parse(reset) + delta).toISOString() }
    expect(accountQuotaProjection(extra, Date.parse(clock))).toMatchObject({ [`${prefix}_used`]: expected,
      [`${prefix}_reset_mode`]: 'fixed', [`${prefix}_reset_hour`]: hour, quota_reset_timezone: timezone })
  }
})
it('omits unconfigured limits and exposes saved reset timestamps', () => {
  expect(accountQuotaProjection({ quota_limit: 0, quota_used: 100, quota_daily_reset_at: '2026-09-09T00:00:00Z' }, now))
    .toEqual({ quota_daily_reset_at: '2026-09-09T00:00:00Z' })
})
