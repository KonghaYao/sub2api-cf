import { describe, expect, it } from 'vitest'

import {
  quoteCustomerCost,
  quoteCustomerImageCost,
  quoteCustomerImageReservation,
  quoteCustomerReservation,
  serializeCustomerPricingSnapshot,
  type CustomerBasePricing,
  type FrozenPricingPlan,
} from '../../src/gateway/customer-pricing'

const base: CustomerBasePricing = {
  upstream_name: 'gpt-5.6-sol',
  input_micros_per_million: 2_000_000,
  output_micros_per_million: 4_000_000,
  cache_read_micros_per_million: 500_000,
  per_request_micros: 3,
  rate_multiplier_ppm: 1_500_000,
  minimum_reservation_micros: 1,
}

const plan: FrozenPricingPlan = {
  version: 1,
  channel_id: 'channel-1',
  channel_control_version: 4,
  pricing_id: 'channel-price-1',
  matched_model_pattern: 'gpt-*',
  platform: 'openai',
  billing_model: 'token',
  input_micros_per_million: null,
  output_micros_per_million: 0,
  cache_read_micros_per_million: 1_000_000,
  per_request_micros: null,
  fast_multiplier_ppm: 1_250_000,
  flex_multiplier_ppm: null,
  intervals: [{
    id: 'large', min_tokens: 100, max_tokens: null, tier_label: 'large',
    input_micros_per_million: 3_000_000,
    output_micros_per_million: null,
    cache_read_micros_per_million: null,
    input_multiplier_ppm: 2_000_000,
    output_multiplier_ppm: null,
    cache_read_multiplier_ppm: 500_000,
    per_request_micros: null,
  }],
  time_pricing: {
    timezone: 'Asia/Shanghai', weekdays_only: true,
    periods: [{ start_time: '09:00', end_time: '12:00', multiplier_ppm: 2_000_000 }],
  },
}

describe('customer pricing', () => {
  it('quotes frozen image tiers with exact integer customer and basis amounts', () => {
    const imagePlan: FrozenPricingPlan = {
      ...plan,
      billing_model: 'image',
      per_request_micros: 120_000,
      intervals: [
        { ...plan.intervals[0], id: 'one-k', tier_label: '1K', per_request_micros: 100_000 },
        { ...plan.intervals[0], id: 'four-k', tier_label: '4k', per_request_micros: 400_000 },
      ],
      time_pricing: null,
    }

    expect(quoteCustomerImageReservation(imagePlan, 1_500_000, 2, 1)).toBe(1_200_000)
    const quote = quoteCustomerImageCost(imagePlan, 1_500_000, ['1K', '4K'], 1)

    expect(quote).toMatchObject({
      cost: {
        input_amount_micros: 0,
        output_amount_micros: 0,
        cache_amount_micros: 0,
        base_amount_micros: 750_000,
        amount_micros: 750_000,
      },
      basis_amount_micros: 500_000,
      snapshot: {
        version: 1,
        source: 'channel',
        pricing_id: 'channel-price-1',
        billing_model: 'image',
        pricing_at_ms: 1,
        customer_rate_multiplier_ppm: 1_500_000,
        tier_prices_micros: { '1K': 100_000, '2K': 120_000, '4K': 400_000 },
        output_tier_counts: { '1K': 1, '2K': 0, '4K': 1 },
      },
    })
  })

  it('inherits nulls, preserves explicit zero, and freezes selected pricing factors', () => {
    const quote = quoteCustomerCost(
      plan,
      base,
      { input_tokens: 120, output_tokens: 10, cache_read_tokens: 20, estimated: false },
      { service_tier: 'priority', pricing_at_ms: Date.UTC(2026, 8, 7, 2, 0) },
    )

    expect(quote.cost).toEqual({
      input_amount_micros: 1_125,
      output_amount_micros: 0,
      cache_amount_micros: 38,
      base_amount_micros: 12,
      amount_micros: 1_175,
    })
    expect(quote.basis_amount_micros).toBe(783)
    expect(quote.snapshot).toMatchObject({
      version: 1,
      source: 'channel',
      channel_id: 'channel-1',
      channel_control_version: 4,
      pricing_id: 'channel-price-1',
      matched_model_pattern: 'gpt-*',
      pricing_at_ms: Date.UTC(2026, 8, 7, 2, 0),
      service_tier: 'priority',
      service_tier_multiplier_ppm: 1_250_000,
      time_multiplier_ppm: 2_000_000,
      customer_rate_multiplier_ppm: 1_500_000,
      selected_interval: { id: 'large', tier_label: 'large' },
      effective_pricing: {
        input_micros_per_million: 3_000_000,
        output_micros_per_million: 0,
        cache_read_micros_per_million: 1_000_000,
        per_request_micros: 3,
      },
    })
  })

  it('quotes per-request reservations and fails closed for unsupported modes and overflow', () => {
    const perRequest = { ...plan, billing_model: 'per_request', per_request_micros: 9 } as const
    expect(quoteCustomerReservation(perRequest, base, {
      input_tokens: 200,
      max_output_tokens: 400,
      pricing_at_ms: Date.UTC(2026, 8, 7, 5, 0),
    })).toMatchObject({
      cost: { base_amount_micros: 14, amount_micros: 14 },
      basis_amount_micros: 9,
      reservation_micros: 14,
    })

    expect(() => quoteCustomerCost(
      { ...plan, billing_model: 'image' }, base,
      { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { pricing_at_ms: 1 },
    )).toThrowError(expect.objectContaining({ code: 'invalid_pricing_state' }))
    expect(() => quoteCustomerCost(
      plan, { ...base, rate_multiplier_ppm: Number.MAX_SAFE_INTEGER },
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { pricing_at_ms: 1 },
    )).toThrowError(expect.objectContaining({ code: 'pricing_overflow' }))
  })

  it('uses left-open/right-closed token intervals and base service-tier defaults', () => {
    const withoutTime = { ...plan, fast_multiplier_ppm: null, time_pricing: null }
    const atLowerBound = quoteCustomerCost(
      withoutTime,
      { ...base, upstream_name: 'gpt-5.5', rate_multiplier_ppm: 1_000_000 },
      { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { service_tier: 'priority', pricing_at_ms: 1 },
    )
    expect(atLowerBound.snapshot.selected_interval).toBeNull()
    expect(atLowerBound.cost).toMatchObject({ input_amount_micros: 500, amount_micros: 508 })

    const inInterval = quoteCustomerCost(
      withoutTime,
      { ...base, rate_multiplier_ppm: 1_000_000 },
      { input_tokens: 101, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { service_tier: 'flex', pricing_at_ms: 1 },
    )
    expect(inInterval.snapshot.selected_interval?.id).toBe('large')
    expect(inInterval.snapshot.service_tier_multiplier_ppm).toBe(500_000)
    expect(inInterval.cost).toMatchObject({ input_amount_micros: 152, amount_micros: 154 })
  })

  it('selects per-request label tiers case-insensitively and preserves a zero price', () => {
    const labelPlan: FrozenPricingPlan = {
      ...plan,
      billing_model: 'per_request',
      per_request_micros: 9,
      time_pricing: null,
      intervals: [{ ...plan.intervals[0], tier_label: 'Batch', per_request_micros: 0 }],
    }
    const quote = quoteCustomerCost(
      labelPlan, base,
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { tier_label: ' batch ', pricing_at_ms: 1 },
    )
    expect(quote.cost.amount_micros).toBe(0)
    expect(quote.snapshot.selected_interval?.tier_label).toBe('Batch')
  })

  it('fails closed when a per-request interval needs a tier the endpoint did not provide', () => {
    expect(() => quoteCustomerCost(
      { ...plan, billing_model: 'per_request', per_request_micros: null, time_pricing: null },
      base,
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { pricing_at_ms: 1 },
    )).toThrowError(expect.objectContaining({
      status: 409,
      code: 'channel_pricing_tier_required',
    }))
  })

  it('applies second-precision time periods while retaining minute-only compatibility', () => {
    const secondsPlan: FrozenPricingPlan = {
      ...plan,
      time_pricing: {
        timezone: 'UTC', weekdays_only: false,
        periods: [{ start_time: '10:00:30', end_time: '10:00:45', multiplier_ppm: 2_000_000 }],
      },
    }
    const before = quoteCustomerCost(
      secondsPlan, { ...base, rate_multiplier_ppm: 1_000_000 },
      { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { pricing_at_ms: Date.UTC(2026, 8, 7, 10, 0, 29) },
    )
    const inside = quoteCustomerCost(
      secondsPlan, { ...base, rate_multiplier_ppm: 1_000_000 },
      { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      { pricing_at_ms: Date.UTC(2026, 8, 7, 10, 0, 30) },
    )
    expect(before.snapshot.time_multiplier_ppm).toBe(1_000_000)
    expect(inside.snapshot.time_multiplier_ppm).toBe(2_000_000)
  })

  it('does not apply weekdays-only time pricing on weekends and bounds serialized snapshots', () => {
    const quote = quoteCustomerCost(
      plan, { ...base, rate_multiplier_ppm: 1_000_000 },
      { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      // 2026-09-06 is Sunday in Asia/Shanghai.
      { pricing_at_ms: Date.UTC(2026, 8, 6, 2, 0) },
    )
    expect(quote.snapshot.time_multiplier_ppm).toBe(1_000_000)
    expect(JSON.parse(serializeCustomerPricingSnapshot(quote.snapshot))).toEqual(quote.snapshot)
    expect(() => serializeCustomerPricingSnapshot({
      ...quote.snapshot,
      matched_model_pattern: '界'.repeat(30_000),
    })).toThrowError(expect.objectContaining({ code: 'invalid_pricing_state' }))
  })
})
