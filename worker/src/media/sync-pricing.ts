import { GatewayError } from '../gateway/errors'
import type { ImageBillingTier } from './image-accounting'

export interface SyncImagePricePolicy {
  rateMultiplierPpm: number
  price1kMicros: number | null
  price2kMicros: number | null
  price4kMicros: number | null
}

interface SyncImagePolicyRow {
  image_rate_independent: number
  image_rate_multiplier_ppm: number
  shared_rate_multiplier_ppm: number
  image_price_1k_micros: number | null
  image_price_2k_micros: number | null
  image_price_4k_micros: number | null
}

export async function resolveSyncImagePricePolicy(
  env: { DB: D1Database },
  principal: { user_id: string; group_id: string },
): Promise<SyncImagePricePolicy> {
  const row = await env.DB.prepare(
    `SELECT group_row.image_rate_independent, group_row.image_rate_multiplier_ppm,
            COALESCE(user_rate.rate_multiplier_ppm, group_row.rate_multiplier_ppm)
              AS shared_rate_multiplier_ppm,
            group_row.image_price_1k_micros, group_row.image_price_2k_micros,
            group_row.image_price_4k_micros
       FROM "groups" AS group_row
       LEFT JOIN user_group_rate_overrides AS user_rate
         ON user_rate.group_id = group_row.id AND user_rate.user_id = ?
      WHERE group_row.id = ? AND group_row.enabled = 1
        AND group_row.allow_image_generation = 1
      LIMIT 1`,
  ).bind(principal.user_id, principal.group_id).first<SyncImagePolicyRow>()
  if (row === null) {
    throw new GatewayError(403, 'IMAGE_GENERATION_DISABLED', 'Image generation is not enabled for this API key group')
  }
  return {
    rateMultiplierPpm: row.image_rate_independent === 1
      ? row.image_rate_multiplier_ppm
      : row.shared_rate_multiplier_ppm,
    price1kMicros: row.image_price_1k_micros,
    price2kMicros: row.image_price_2k_micros,
    price4kMicros: row.image_price_4k_micros,
  }
}

export function calculateSyncImageReservation(
  policy: SyncImagePricePolicy,
  requestedTier: ImageBillingTier,
  outputCount: number,
): number {
  if (!Number.isSafeInteger(outputCount) || outputCount < 1 || outputCount > 10) {
    throw new GatewayError(400, 'IMAGE_INVALID_OUTPUT_COUNT', 'n must be an integer between 1 and 10')
  }
  return safeProduct(ratedUnitPrice(policy, requestedTier), outputCount)
}

export function calculateSyncImageActualCost(
  policy: SyncImagePricePolicy,
  outputTiers: ImageBillingTier[],
): number {
  let total = 0
  for (const tier of outputTiers) total = safeSum(total, ratedUnitPrice(policy, tier))
  return total
}

function ratedUnitPrice(policy: SyncImagePricePolicy, tier: ImageBillingTier): number {
  if (!Number.isSafeInteger(policy.rateMultiplierPpm) || policy.rateMultiplierPpm < 0) {
    throw pricingUnavailable()
  }
  const base = tier === '1K'
    ? policy.price1kMicros
    : tier === '2K'
      ? policy.price2kMicros
      : policy.price4kMicros
  if (!Number.isSafeInteger(base) || (base as number) < 0) throw pricingUnavailable()
  const result = (BigInt(base as number) * BigInt(policy.rateMultiplierPpm) + 500_000n) / 1_000_000n
  const value = Number(result)
  if (!Number.isSafeInteger(value)) throw pricingOverflow()
  return value
}

function safeProduct(left: number, right: number): number {
  const value = left * right
  if (!Number.isSafeInteger(value)) throw pricingOverflow()
  return value
}

function safeSum(left: number, right: number): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) throw pricingOverflow()
  return value
}

function pricingUnavailable(): GatewayError {
  return new GatewayError(409, 'IMAGE_PRICING_UNAVAILABLE', 'Image generation pricing is not configured')
}

function pricingOverflow(): GatewayError {
  return new GatewayError(500, 'IMAGE_PRICING_OVERFLOW', 'Image generation price is too large', 'server_error')
}
