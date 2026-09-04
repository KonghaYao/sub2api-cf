import { describe, expect, it } from 'vitest'

import {
  currencyMinorUnit,
  microsToMinorUnits,
  minorUnitsToMicros,
  paymentAmountWithFee,
} from '../../src/payment/currency'

describe('payment currency integer conversions', () => {
  it('matches legacy zero, two, and three decimal Stripe currency units', () => {
    expect(currencyMinorUnit('JPY')).toBe(0)
    expect(currencyMinorUnit('USD')).toBe(2)
    expect(currencyMinorUnit('KWD')).toBe(3)
    expect(currencyMinorUnit('ISK')).toBe(2)

    expect(microsToMinorUnits(12_000_000, 'JPY')).toBe(12)
    expect(microsToMinorUnits(12_340_000, 'USD')).toBe(1_234)
    expect(microsToMinorUnits(12_345_000, 'KWD')).toBe(12_345)
    expect(microsToMinorUnits(12_000_000, 'ISK')).toBe(1_200)
  })

  it('rejects precision a provider cannot represent instead of silently rounding money', () => {
    expect(() => microsToMinorUnits(12_345_678, 'USD')).toThrow(/precision/i)
    expect(() => microsToMinorUnits(12_500_000, 'JPY')).toThrow(/precision/i)
    expect(() => microsToMinorUnits(12_345_600, 'KWD')).toThrow(/precision/i)
  })

  it('round-trips safe integer amounts without floating point arithmetic', () => {
    for (const [micros, currency] of [
      [99_990_000, 'USD'],
      [9_000_000, 'JPY'],
      [1_234_000, 'BHD'],
    ] as const) {
      expect(minorUnitsToMicros(microsToMinorUnits(micros, currency), currency)).toBe(micros)
    }
  })

  it('rounds positive fees upward to the currency payment unit', () => {
    expect(paymentAmountWithFee(10_000_000, 25_000, 'USD')).toEqual({
      fee_micros: 250_000,
      pay_amount_micros: 10_250_000,
      pay_amount_minor: 1_025,
    })
    expect(paymentAmountWithFee(10_000_000, 1, 'USD')).toEqual({
      fee_micros: 10_000,
      pay_amount_micros: 10_010_000,
      pay_amount_minor: 1_001,
    })
  })
})
