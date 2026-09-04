const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])
const STRIPE_LEGACY_ZERO_DECIMAL = new Set(['ISK', 'UGX'])
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

interface CurrencyUnit {
  apiMinorUnit: number
  maxFractionDigits: number
}

export function normalizePaymentCurrency(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error('payment currency must be a 3-letter ISO currency code')
  }
  return normalized
}

export function currencyMinorUnit(currency: string): number {
  return currencyUnit(currency).apiMinorUnit
}

export function microsToMinorUnits(amountMicros: number, currency: string): number {
  requireNonNegativeSafeInteger(amountMicros, 'payment amount')
  const unit = currencyUnit(currency)
  const precisionQuantum = powerOfTen(6 - unit.maxFractionDigits)
  if (amountMicros % precisionQuantum !== 0) {
    throw new Error(`payment amount precision is not supported for ${normalizePaymentCurrency(currency)}`)
  }
  const minorQuantum = powerOfTen(6 - unit.apiMinorUnit)
  if (amountMicros % minorQuantum !== 0) {
    throw new Error(`payment amount precision is not supported for ${normalizePaymentCurrency(currency)}`)
  }
  return amountMicros / minorQuantum
}

export function minorUnitsToMicros(amountMinor: number, currency: string): number {
  requireNonNegativeSafeInteger(amountMinor, 'provider amount')
  const unit = currencyUnit(currency)
  const value = BigInt(amountMinor) * BigInt(powerOfTen(6 - unit.apiMinorUnit))
  if (value > MAX_SAFE_BIGINT) throw new Error('provider amount exceeds the safe integer range')
  const micros = Number(value)
  const precisionQuantum = powerOfTen(6 - unit.maxFractionDigits)
  if (micros % precisionQuantum !== 0) {
    throw new Error(`provider amount precision is not supported for ${normalizePaymentCurrency(currency)}`)
  }
  return micros
}

export function paymentAmountWithFee(
  amountMicros: number,
  feePpm: number,
  currency: string,
): { fee_micros: number; pay_amount_micros: number; pay_amount_minor: number } {
  requireNonNegativeSafeInteger(amountMicros, 'payment amount')
  requireNonNegativeSafeInteger(feePpm, 'payment fee')
  if (amountMicros <= 0 || feePpm > 1_000_000) throw new Error('payment amount or fee is invalid')
  // Validate the principal before calculating a fee. A price that cannot be
  // represented by the provider must not be rounded silently.
  microsToMinorUnits(amountMicros, currency)
  const unit = currencyUnit(currency)
  const quantum = BigInt(powerOfTen(6 - unit.maxFractionDigits))
  const numerator = BigInt(amountMicros) * BigInt(feePpm)
  const denominator = 1_000_000n * quantum
  const feeUnits = feePpm === 0 ? 0n : (numerator + denominator - 1n) / denominator
  const fee = feeUnits * quantum
  const payAmount = BigInt(amountMicros) + fee
  if (payAmount > MAX_SAFE_BIGINT) throw new Error('payment amount exceeds the safe integer range')
  const payAmountMicros = Number(payAmount)
  return {
    fee_micros: Number(fee),
    pay_amount_micros: payAmountMicros,
    pay_amount_minor: microsToMinorUnits(payAmountMicros, currency),
  }
}

function currencyUnit(currency: string): CurrencyUnit {
  const normalized = normalizePaymentCurrency(currency)
  if (ZERO_DECIMAL.has(normalized)) return { apiMinorUnit: 0, maxFractionDigits: 0 }
  if (THREE_DECIMAL.has(normalized)) return { apiMinorUnit: 3, maxFractionDigits: 3 }
  if (STRIPE_LEGACY_ZERO_DECIMAL.has(normalized)) {
    return { apiMinorUnit: 2, maxFractionDigits: 0 }
  }
  return { apiMinorUnit: 2, maxFractionDigits: 2 }
}

function powerOfTen(exponent: number): number {
  return 10 ** exponent
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
}
