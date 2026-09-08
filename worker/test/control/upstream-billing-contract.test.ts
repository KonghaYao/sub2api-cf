import { describe, expect, it } from 'vitest'
import { parseUpstreamBillingDeclaration, upstreamBillingRateAt, upstreamBillingSyncRate } from '../../src/control/upstream-billing-contract'

const baseline = { object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token',
  group_rate_multiplier: 1.2, resolved_rate_multiplier: 1.2, peak_rate_enabled: false,
  effective_rate_multiplier: 1.2, observed_at: '2026-09-07T08:00:00Z' }

describe('original upstream billing declaration contract', () => {
  it('sanitizes fields, resolves user overrides and preserves nanosecond timestamps in UTC', () => {
    const result = parseUpstreamBillingDeclaration({ ...baseline, user_rate_multiplier: 0.8,
      resolved_rate_multiplier: 0.8, effective_rate_multiplier: 0.8,
      observed_at: '2026-09-07T16:00:00.123456789+08:00', api_key: 'must-not-persist', nested: { secret: 'discard' } })
    expect(result.observed_at).toBe('2026-09-07T08:00:00.123456789Z')
    expect(result.user_rate_multiplier).toBe(0.8)
    expect(result.api_key).toBeUndefined()
    expect(result.nested).toBeUndefined()
  })

  it.each([
    { schema_version: 2 }, { billing_scope: 'request' }, { object: 'other' },
    { group_rate_multiplier: null }, { resolved_rate_multiplier: '1.2' },
    { effective_rate_multiplier: 1.3 }, { user_rate_multiplier: 0.5 },
    { peak_rate_enabled: null }, { applied_peak_multiplier: '1' },
    { peak_start: 8 }, { peak_rate_multiplier: '2' },
    { group_rate_multiplier: -1 }, { group_rate_multiplier: Infinity },
    { observed_at: '2026-02-30T08:00:00Z' }, { observed_at: '2026-09-07' },
    { observed_at: '0001-01-01T00:00:00Z' },
  ])('rejects incomplete or inconsistent declarations: %j', patch => {
    expect(() => parseUpstreamBillingDeclaration({ ...baseline, ...patch })).toThrow()
  })

  it('recomputes peak pricing at the current local minute without freezing it into the base rate', () => {
    const data = parseUpstreamBillingDeclaration({ ...baseline, peak_rate_enabled: true,
      peak_start: '16:00', peak_end: '18:00', timezone: 'Asia/Shanghai', peak_rate_multiplier: 2,
      applied_peak_multiplier: 2, effective_rate_multiplier: 2.4 })
    expect(upstreamBillingRateAt(data, new Date('2026-09-07T07:59:59Z'))).toBe(1.2)
    expect(upstreamBillingRateAt(data, new Date('2026-09-07T08:00:00Z'))).toBe(2.4)
    expect(upstreamBillingRateAt(data, new Date('2026-09-07T10:00:00Z'))).toBe(1.2)
    expect(upstreamBillingSyncRate(data)).toBe(1.2)
    expect(parseUpstreamBillingDeclaration({ ...data, peak_start: '8:00', peak_end: '9:00', timezone: 'UTC' }).peak_start).toBe('8:00')
    for (const patch of [{ peak_start: '18:00', peak_end: '16:00' }, { timezone: 'invalid/zone' },
      { applied_peak_multiplier: 1 }, { peak_start: '25:00' }]) {
      expect(() => parseUpstreamBillingDeclaration({ ...data, ...patch })).toThrow()
    }
  })

  it.each([[0, null], [0.00001, null], [0.00005, 0.0001], [1.23456, 1.2346], [100, 100], [100.0001, null], [Infinity, null]])(
    'limits automatic rate write-back at original four-decimal precision: %s', (input, expected) => {
      expect(upstreamBillingSyncRate({ resolved_rate_multiplier: input, effective_rate_multiplier: 999 })).toBe(expected)
    },
  )
})
