import { normalizeCacheCreationBreakdown } from './cache-creation'
import { GatewayError } from './errors'
import type { CostBreakdown, TokenUsage } from './types'

const PPM = 1_000_000n
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const SNAPSHOT_MAX_BYTES = 65_536

export type CustomerBillingModel = 'token' | 'per_request' | 'image' | 'video'

export interface FrozenPricingInterval {
  id: string
  min_tokens: number
  max_tokens: number | null
  tier_label: string
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  cache_write_micros_per_million?: number | null
  cache_write_1h_micros_per_million?: number | null
  input_multiplier_ppm: number | null
  output_multiplier_ppm: number | null
  cache_read_multiplier_ppm: number | null
  cache_write_multiplier_ppm?: number | null
  per_request_micros: number | null
}

export interface FrozenTimePricingPeriod {
  start_time: string
  end_time: string
  multiplier_ppm: number
}

export interface FrozenTimePricing {
  timezone: string
  weekdays_only: boolean
  periods: FrozenTimePricingPeriod[]
}

/**
 * The complete channel price graph selected while resolving a route.
 * `pricing_id` identifies the channel row and must never replace ModelRoute.price_id,
 * which remains the catalog-price foreign key.
 */
export interface FrozenPricingPlan {
  version: 1
  channel_id: string
  channel_control_version: number
  pricing_id: string
  matched_model_pattern: string
  platform: string
  billing_model: CustomerBillingModel
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  cache_write_micros_per_million?: number | null
  cache_write_1h_micros_per_million?: number | null
  per_request_micros: number | null
  fast_multiplier_ppm: number | null
  flex_multiplier_ppm: number | null
  intervals: FrozenPricingInterval[]
  time_pricing: FrozenTimePricing | null
  response_model_billing?: boolean
}

export interface CustomerBasePricing {
  upstream_name: string
  input_micros_per_million: number
  output_micros_per_million: number
  cache_read_micros_per_million: number
  per_request_micros: number
  rate_multiplier_ppm: number
  minimum_reservation_micros: number
}

export interface CustomerPricingSelector {
  pricing_at_ms: number
  service_tier?: string
  /** Case-insensitive named tier selection for per-request prices. */
  tier_label?: string
}

export interface EffectiveCustomerPricing {
  input_micros_per_million: number
  output_micros_per_million: number
  cache_read_micros_per_million: number
  per_request_micros: number
}

interface EffectiveComponentPrice {
  rate: number
  interval_multiplier_ppm: number
}

export interface CustomerTokenPricingSnapshot {
  version: 1
  source: 'channel'
  channel_id: string
  channel_control_version: number
  pricing_id: string
  matched_model_pattern: string
  platform: string
  billing_model: 'token' | 'per_request'
  pricing_at_ms: number
  service_tier: string
  service_tier_multiplier_ppm: number
  time_multiplier_ppm: number
  customer_rate_multiplier_ppm: number
  selected_interval: FrozenPricingInterval | null
  effective_pricing: EffectiveCustomerPricing
  cache_write_pricing?: CustomerCacheWritePricing
}

export type CustomerImageTier = '1K' | '2K' | '4K'

export interface CustomerImagePricingSnapshot {
  version: 1
  source: 'channel'
  channel_id: string
  channel_control_version: number
  pricing_id: string
  matched_model_pattern: string
  platform: string
  billing_model: 'image'
  pricing_at_ms: number
  customer_rate_multiplier_ppm: number
  tier_prices_micros: Record<CustomerImageTier, number>
  output_tier_counts: Record<CustomerImageTier, number>
}

export type CustomerPricingSnapshot = CustomerTokenPricingSnapshot | CustomerImagePricingSnapshot

export interface CustomerPricingQuote {
  cost: CostBreakdown
  /** Selected price after interval/service/time factors, before the customer rate multiplier. */
  basis_amount_micros: number
  snapshot: CustomerPricingSnapshot
}

export interface CustomerTokenPricingQuote extends Omit<CustomerPricingQuote, 'snapshot'> {
  snapshot: CustomerTokenPricingSnapshot
}

export interface CustomerReservationInput extends CustomerPricingSelector {
  input_tokens: number
  max_output_tokens: number
}

export interface CustomerReservationQuote extends CustomerTokenPricingQuote {
  reservation_micros: number
}

export function quoteCustomerImageReservation(
  plan: FrozenPricingPlan,
  customerRateMultiplierPpm: number,
  outputCount: number,
  pricingAtMs: number,
): number {
  assertImagePlan(plan, customerRateMultiplierPpm, pricingAtMs)
  if (!Number.isSafeInteger(outputCount) || outputCount < 1 || outputCount > 10) invalidPricing()
  const prices = imageTierPrices(plan)
  const maximumUnitPrice = Math.max(prices['1K'], prices['2K'], prices['4K'])
  return fixedCharge(
    checkedNumber(BigInt(maximumUnitPrice) * BigInt(outputCount)),
    customerRateMultiplierPpm,
  )
}

export function quoteCustomerImageCost(
  plan: FrozenPricingPlan,
  customerRateMultiplierPpm: number,
  outputTiers: CustomerImageTier[],
  pricingAtMs: number,
): CustomerPricingQuote {
  assertImagePlan(plan, customerRateMultiplierPpm, pricingAtMs)
  if (outputTiers.length > 10) invalidPricing()
  const prices = imageTierPrices(plan)
  const counts: Record<CustomerImageTier, number> = { '1K': 0, '2K': 0, '4K': 0 }
  let rawAmount = 0n
  for (const tier of outputTiers) {
    if (tier !== '1K' && tier !== '2K' && tier !== '4K') invalidPricing()
    counts[tier] += 1
    rawAmount += BigInt(prices[tier])
  }
  const basisAmount = checkedNumber(rawAmount)
  const amount = fixedCharge(basisAmount, customerRateMultiplierPpm)
  return {
    cost: {
      input_amount_micros: 0,
      output_amount_micros: 0,
      cache_amount_micros: 0,
      base_amount_micros: amount,
      amount_micros: amount,
    },
    basis_amount_micros: basisAmount,
    snapshot: {
      version: 1,
      source: 'channel',
      channel_id: plan.channel_id,
      channel_control_version: plan.channel_control_version,
      pricing_id: plan.pricing_id,
      matched_model_pattern: plan.matched_model_pattern,
      platform: plan.platform,
      billing_model: 'image',
      pricing_at_ms: pricingAtMs,
      customer_rate_multiplier_ppm: customerRateMultiplierPpm,
      tier_prices_micros: prices,
      output_tier_counts: counts,
    },
  }
}

export function quoteCustomerCost(
  plan: FrozenPricingPlan,
  base: CustomerBasePricing,
  usage: TokenUsage,
  selector: CustomerPricingSelector,
): CustomerTokenPricingQuote {
  assertPlan(plan)
  assertBase(base)
  assertUsage(usage)
  assertSafeNonnegative(selector.pricing_at_ms)

  if (plan.billing_model !== 'token' && plan.billing_model !== 'per_request') {
    invalidPricing()
  }

  const interval = selectInterval(plan, usage.input_tokens, selector.tier_label)
  if (
    plan.billing_model === 'per_request' &&
    interval === null &&
    plan.per_request_micros === null &&
    plan.intervals.length > 0
  ) {
    throw new GatewayError(
      409,
      'channel_pricing_tier_required',
      'This channel price requires an explicit request tier that this endpoint does not provide',
      'invalid_request_error',
    )
  }
  const pricing = effectivePricing(plan, interval, base)
  const componentPricing = effectiveComponentPricing(plan, interval, base)
  const serviceTier = normalizeServiceTier(selector.service_tier)
  const serviceMultiplier = customerServiceTierMultiplier(plan, base, serviceTier)
  const timeMultiplier = timeMultiplierPpm(plan.time_pricing, selector.pricing_at_ms)
  const customerMultiplier = base.rate_multiplier_ppm

  const writePricing = customerCacheWritePricing(plan, interval, base)
  const cacheWriteTokens = writePricing === null ? 0 : Math.min(usage.cache_write_tokens ?? 0, usage.input_tokens - usage.cache_read_tokens)
  const basisMultipliers = [serviceMultiplier, timeMultiplier]
  const chargeMultipliers = [...basisMultipliers, customerMultiplier]
  const inputBasis = plan.billing_model === 'token'
    ? tokenCharge(
        usage.input_tokens - usage.cache_read_tokens - cacheWriteTokens,
        componentPricing.input.rate,
        componentPricing.input.interval_multiplier_ppm,
        ...basisMultipliers,
      )
    : 0
  const outputBasis = plan.billing_model === 'token'
    ? tokenCharge(
        usage.output_tokens,
        componentPricing.output.rate,
        componentPricing.output.interval_multiplier_ppm,
        ...basisMultipliers,
      )
    : 0
  const cacheBasis = plan.billing_model === 'token'
    ? tokenCharge(
        usage.cache_read_tokens,
        componentPricing.cache_read.rate,
        componentPricing.cache_read.interval_multiplier_ppm,
        ...basisMultipliers,
      )
    : 0
  const baseBasis = fixedCharge(pricing.per_request_micros, ...basisMultipliers)

  // Calculate from the unrounded rational value instead of multiplying the
  // rounded basis amount. Every projected component is rounded up exactly once.
  const inputAmount = plan.billing_model === 'token'
    ? tokenCharge(
        usage.input_tokens - usage.cache_read_tokens - cacheWriteTokens,
        componentPricing.input.rate,
        componentPricing.input.interval_multiplier_ppm,
        ...chargeMultipliers,
      )
    : 0
  const outputAmount = plan.billing_model === 'token'
    ? tokenCharge(
        usage.output_tokens,
        componentPricing.output.rate,
        componentPricing.output.interval_multiplier_ppm,
        ...chargeMultipliers,
      )
    : 0
  const cacheAmount = plan.billing_model === 'token'
    ? tokenCharge(
        usage.cache_read_tokens,
        componentPricing.cache_read.rate,
        componentPricing.cache_read.interval_multiplier_ppm,
        ...chargeMultipliers,
      )
    : 0
  const cacheWriteBasis = writePricing === null ? 0 : cacheWriteCharge(cacheWriteTokens, usage, writePricing, basisMultipliers)
  const cacheWriteAmount = writePricing === null ? 0 : cacheWriteCharge(cacheWriteTokens, usage, writePricing, chargeMultipliers)
  const baseAmount = fixedCharge(pricing.per_request_micros, ...chargeMultipliers)
  const amount = checkedNumber(
    BigInt(inputAmount) + BigInt(outputAmount) + BigInt(cacheAmount) + BigInt(cacheWriteAmount) + BigInt(baseAmount),
  )
  const basisAmount = checkedNumber(
    BigInt(inputBasis) + BigInt(outputBasis) + BigInt(cacheBasis) + BigInt(cacheWriteBasis) + BigInt(baseBasis),
  )

  return {
    cost: {
      ...(writePricing === null ? {} : { cache_write_amount_micros: cacheWriteAmount }),
      input_amount_micros: inputAmount,
      output_amount_micros: outputAmount,
      cache_amount_micros: cacheAmount,
      base_amount_micros: baseAmount,
      amount_micros: amount,
    },
    basis_amount_micros: basisAmount,
    snapshot: {
      version: 1,
      source: 'channel',
      channel_id: plan.channel_id,
      channel_control_version: plan.channel_control_version,
      pricing_id: plan.pricing_id,
      matched_model_pattern: plan.matched_model_pattern,
      platform: plan.platform,
      billing_model: plan.billing_model,
      pricing_at_ms: selector.pricing_at_ms,
      service_tier: serviceTier,
      service_tier_multiplier_ppm: serviceMultiplier,
      time_multiplier_ppm: timeMultiplier,
      customer_rate_multiplier_ppm: customerMultiplier,
      selected_interval: interval === null ? null : { ...interval },
      effective_pricing: pricing,
      ...(writePricing === null ? {} : { cache_write_pricing: writePricing }),
    },
  }
}

export function quoteCustomerReservation(
  plan: FrozenPricingPlan,
  base: CustomerBasePricing,
  input: CustomerReservationInput,
): CustomerReservationQuote {
  assertSafeNonnegative(input.input_tokens)
  assertSafeNonnegative(input.max_output_tokens)
  const quote = quoteCustomerCost(plan, base, {
    input_tokens: input.input_tokens,
    output_tokens: input.max_output_tokens,
    cache_read_tokens: 0,
    estimated: true,
  }, input)
  return {
    ...quote,
    reservation_micros: Math.max(
      base.minimum_reservation_micros,
      quote.cost.amount_micros,
      1,
    ),
  }
}

/** Produces a D1-safe value for usage_projection.customer_pricing_snapshot_json. */
export function serializeCustomerPricingSnapshot(snapshot: CustomerPricingSnapshot): string {
  const value = JSON.stringify(snapshot)
  if (new TextEncoder().encode(value).byteLength > SNAPSHOT_MAX_BYTES) invalidPricing()
  return value
}

interface CustomerCacheWritePricing {
  standard: EffectiveComponentPrice
  hour: EffectiveComponentPrice | null
}

function customerCacheWritePricing(plan: FrozenPricingPlan, interval: FrozenPricingInterval | null, base: CustomerBasePricing): CustomerCacheWritePricing | null {
  const rates = [interval?.cache_write_micros_per_million, interval?.cache_write_1h_micros_per_million,
    interval?.cache_write_multiplier_ppm, plan.cache_write_micros_per_million, plan.cache_write_1h_micros_per_million]
  if (!rates.some(value => value !== undefined && value !== null) || plan.billing_model !== 'token') return null
  return {
    standard: componentPrice(interval?.cache_write_micros_per_million, interval?.cache_write_multiplier_ppm,
      plan.cache_write_micros_per_million ?? null, base.input_micros_per_million),
    hour: interval?.cache_write_1h_micros_per_million == null && plan.cache_write_1h_micros_per_million == null ? null
      : componentPrice(interval?.cache_write_1h_micros_per_million, interval?.cache_write_multiplier_ppm,
        plan.cache_write_1h_micros_per_million ?? null, base.input_micros_per_million),
  }
}

function cacheWriteCharge(tokens: number, usage: TokenUsage, pricing: CustomerCacheWritePricing, multipliers: number[]): number {
  const [five, hour] = normalizeCacheCreationBreakdown(tokens, usage.cache_write_5m_tokens, usage.cache_write_1h_tokens)
  if (pricing.hour !== null && (five > 0 || hour > 0)) {
    let numerator = BigInt(five) * BigInt(pricing.standard.rate) * BigInt(pricing.standard.interval_multiplier_ppm) +
      BigInt(hour) * BigInt(pricing.hour.rate) * BigInt(pricing.hour.interval_multiplier_ppm)
    let denominator = PPM * PPM
    for (const multiplier of multipliers) { numerator *= BigInt(multiplier); denominator *= PPM }
    return checkedNumber(divideRoundUp(numerator, denominator))
  }
  return tokenCharge(tokens, pricing.standard.rate, pricing.standard.interval_multiplier_ppm, ...multipliers)
}

function effectivePricing(
  plan: FrozenPricingPlan,
  interval: FrozenPricingInterval | null,
  base: CustomerBasePricing,
): EffectiveCustomerPricing {
  return {
    input_micros_per_million: inherit(
      interval?.input_micros_per_million,
      plan.input_micros_per_million,
      base.input_micros_per_million,
    ),
    output_micros_per_million: inherit(
      interval?.output_micros_per_million,
      plan.output_micros_per_million,
      base.output_micros_per_million,
    ),
    cache_read_micros_per_million: inherit(
      interval?.cache_read_micros_per_million,
      plan.cache_read_micros_per_million,
      base.cache_read_micros_per_million,
    ),
    per_request_micros: inherit(
      interval?.per_request_micros,
      plan.per_request_micros,
      base.per_request_micros,
    ),
  }
}

function assertImagePlan(
  plan: FrozenPricingPlan,
  customerRateMultiplierPpm: number,
  pricingAtMs: number,
): void {
  assertPlan(plan)
  if (plan.billing_model !== 'image') invalidPricing()
  assertSafeNonnegative(customerRateMultiplierPpm)
  assertSafeNonnegative(pricingAtMs)
}

function imageTierPrices(plan: FrozenPricingPlan): Record<CustomerImageTier, number> {
  return {
    '1K': imageTierPrice(plan, '1K'),
    '2K': imageTierPrice(plan, '2K'),
    '4K': imageTierPrice(plan, '4K'),
  }
}

function imageTierPrice(plan: FrozenPricingPlan, tier: CustomerImageTier): number {
  const matches = plan.intervals.filter(
    (interval) => interval.tier_label.trim().toLowerCase() === tier.toLowerCase(),
  )
  if (matches.length > 1) invalidPricing()
  const value = matches[0]?.per_request_micros ?? plan.per_request_micros
  if (value === null) invalidPricing()
  return value
}

function effectiveComponentPricing(
  plan: FrozenPricingPlan,
  interval: FrozenPricingInterval | null,
  base: CustomerBasePricing,
): { input: EffectiveComponentPrice; output: EffectiveComponentPrice; cache_read: EffectiveComponentPrice } {
  return {
    input: componentPrice(
      interval?.input_micros_per_million,
      interval?.input_multiplier_ppm,
      plan.input_micros_per_million,
      base.input_micros_per_million,
    ),
    output: componentPrice(
      interval?.output_micros_per_million,
      interval?.output_multiplier_ppm,
      plan.output_micros_per_million,
      base.output_micros_per_million,
    ),
    cache_read: componentPrice(
      interval?.cache_read_micros_per_million,
      interval?.cache_read_multiplier_ppm,
      plan.cache_read_micros_per_million,
      base.cache_read_micros_per_million,
    ),
  }
}

function componentPrice(
  intervalRate: number | null | undefined,
  intervalMultiplier: number | null | undefined,
  planRate: number | null,
  baseRate: number,
): EffectiveComponentPrice {
  if (intervalRate !== undefined && intervalRate !== null) {
    return { rate: intervalRate, interval_multiplier_ppm: 1_000_000 }
  }
  return {
    rate: planRate ?? baseRate,
    interval_multiplier_ppm: intervalMultiplier ?? 1_000_000,
  }
}

function inherit(
  intervalValue: number | null | undefined,
  planValue: number | null,
  baseValue: number,
): number {
  return intervalValue ?? planValue ?? baseValue
}

function selectInterval(
  plan: FrozenPricingPlan,
  contextTokens: number,
  tierLabel?: string,
): FrozenPricingInterval | null {
  const matches = plan.billing_model === 'token'
    ? plan.intervals.filter((interval) => (
        contextTokens > interval.min_tokens &&
        (interval.max_tokens === null || contextTokens <= interval.max_tokens)
      ))
    : tierLabel === undefined
      ? []
      : plan.intervals.filter(
          (interval) => interval.tier_label.toLowerCase() === tierLabel.trim().toLowerCase(),
        )
  if (matches.length > 1) invalidPricing()
  return matches[0] ?? null
}

function customerServiceTierMultiplier(
  plan: FrozenPricingPlan,
  base: CustomerBasePricing,
  tier: string,
): number {
  if (tier === 'priority' || tier === 'fast') {
    return plan.fast_multiplier_ppm ?? baseServiceTierMultiplierPpm(base.upstream_name, tier)
  }
  if (tier === 'flex') return plan.flex_multiplier_ppm ?? 500_000
  return 1_000_000
}

function normalizeServiceTier(value?: string): string {
  return value?.trim().toLowerCase() ?? ''
}

function baseServiceTierMultiplierPpm(modelName: string, serviceTier: string): number {
  if (serviceTier !== 'priority' && serviceTier !== 'fast') return 1_000_000
  const canonical = modelName.trim().toLowerCase()
  if (/^gpt-5\.5(?:$|-)/.test(canonical) && !/^gpt-5\.5-pro(?:$|-)/.test(canonical)) {
    return 2_500_000
  }
  return 2_000_000
}

function timeMultiplierPpm(config: FrozenTimePricing | null, atMs: number): number {
  if (config === null || config.periods.length === 0) return 1_000_000
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(atMs))
  } catch {
    invalidPricing()
  }
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  const weekday = byType.get('weekday')
  if (config.weekdays_only && (weekday === 'Sat' || weekday === 'Sun')) return 1_000_000
  const secondOfDay = Number(byType.get('hour')) * 3_600 +
    Number(byType.get('minute')) * 60 + Number(byType.get('second'))
  if (!Number.isInteger(secondOfDay)) invalidPricing()
  const matches = config.periods.filter((period) => {
    const start = clockSecond(period.start_time)
    const end = clockSecond(period.end_time, true)
    return start < end
      ? secondOfDay >= start && secondOfDay < end
      : secondOfDay >= start || secondOfDay < end
  })
  if (matches.length > 1) invalidPricing()
  return matches[0]?.multiplier_ppm ?? 1_000_000
}

function clockSecond(value: string, end = false): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) invalidPricing()
  if (end && (value === '00:00' || value === '00:00:00')) return 24 * 60 * 60
  const [hour, minute, second = 0] = value.split(':').map(Number)
  return hour * 3_600 + minute * 60 + second
}

function assertPlan(plan: FrozenPricingPlan): void {
  if (
    plan.version !== 1 ||
    !nonempty(plan.channel_id) || !nonempty(plan.pricing_id) ||
    !nonempty(plan.matched_model_pattern) || !nonempty(plan.platform) ||
    !['token', 'per_request', 'image', 'video'].includes(plan.billing_model)
  ) invalidPricing()
  assertSafeNonnegative(plan.channel_control_version)
  for (const value of [
    plan.input_micros_per_million, plan.output_micros_per_million,
    plan.cache_read_micros_per_million, plan.per_request_micros,
    plan.fast_multiplier_ppm, plan.flex_multiplier_ppm,
    plan.cache_write_micros_per_million ?? null, plan.cache_write_1h_micros_per_million ?? null,
  ]) assertNullableNonnegative(value)
  for (const interval of plan.intervals) {
    if (!nonempty(interval.id) || typeof interval.tier_label !== 'string') invalidPricing()
    assertSafeNonnegative(interval.min_tokens)
    assertNullableNonnegative(interval.max_tokens)
    if (interval.max_tokens !== null && interval.max_tokens <= interval.min_tokens) invalidPricing()
    for (const value of [
      interval.input_micros_per_million, interval.output_micros_per_million,
      interval.cache_read_micros_per_million, interval.input_multiplier_ppm,
      interval.output_multiplier_ppm, interval.cache_read_multiplier_ppm,
      interval.per_request_micros,
      interval.cache_write_micros_per_million ?? null, interval.cache_write_1h_micros_per_million ?? null, interval.cache_write_multiplier_ppm ?? null,
    ]) assertNullableNonnegative(value)
  }
  if (plan.time_pricing !== null) {
    if (!nonempty(plan.time_pricing.timezone)) invalidPricing()
    for (const period of plan.time_pricing.periods) {
      const start = clockSecond(period.start_time)
      const end = clockSecond(period.end_time, true)
      if (start === end || period.start_time === period.end_time) invalidPricing()
      assertSafeNonnegative(period.multiplier_ppm)
    }
  }
}

function assertBase(base: CustomerBasePricing): void {
  if (typeof base.upstream_name !== 'string') invalidPricing()
  for (const value of [
    base.input_micros_per_million, base.output_micros_per_million,
    base.cache_read_micros_per_million, base.per_request_micros,
    base.rate_multiplier_ppm, base.minimum_reservation_micros,
  ]) assertSafeNonnegative(value)
}

function assertUsage(usage: TokenUsage): void {
  for (const value of [usage.input_tokens, usage.output_tokens, usage.cache_read_tokens]) {
    assertSafeNonnegative(value)
  }
  if (usage.cache_read_tokens > usage.input_tokens) invalidPricing()
  for (const value of [usage.cache_write_tokens, usage.cache_write_5m_tokens, usage.cache_write_1h_tokens]) if (value !== undefined) assertSafeNonnegative(value)
}

function assertNullableNonnegative(value: number | null): void {
  if (value !== null) assertSafeNonnegative(value)
}

function assertSafeNonnegative(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalidPricing()
}

function nonempty(value: string): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function tokenCharge(tokens: number, rate: number, ...multipliers: number[]): number {
  assertSafeNonnegative(tokens)
  assertSafeNonnegative(rate)
  let numerator = BigInt(tokens) * BigInt(rate)
  let denominator = PPM
  for (const multiplier of multipliers) {
    assertSafeNonnegative(multiplier)
    numerator *= BigInt(multiplier)
    denominator *= PPM
  }
  return checkedNumber(divideRoundUp(numerator, denominator))
}

function fixedCharge(amount: number, ...multipliers: number[]): number {
  assertSafeNonnegative(amount)
  let numerator = BigInt(amount)
  let denominator = 1n
  for (const multiplier of multipliers) {
    assertSafeNonnegative(multiplier)
    numerator *= BigInt(multiplier)
    denominator *= PPM
  }
  return checkedNumber(divideRoundUp(numerator, denominator))
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

function checkedNumber(value: bigint): number {
  if (value > MAX_SAFE) {
    throw new GatewayError(
      500,
      'pricing_overflow',
      'Calculated price exceeds the supported range',
      'server_error',
    )
  }
  return Number(value)
}

function invalidPricing(): never {
  throw new GatewayError(
    500,
    'invalid_pricing_state',
    'Pricing state is invalid',
    'server_error',
  )
}
