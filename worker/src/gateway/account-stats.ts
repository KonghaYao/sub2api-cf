import type { TokenUsage } from './types'
import { calculateCost } from './usage'

const PPM = 1_000_000n

export interface AccountCostSnapshot {
  standard_cost_micros: number
  account_stats_cost_micros: number | null
  account_rate_multiplier_ppm: number
  account_cost_micros: number
}

export interface AccountCostInput {
  accountId: string
  groupId: string
  platform: string
  upstreamModel: string
  usage: TokenUsage
  standardCostMicros: number
  channelPricingBasisMicros?: number
  accountCostBasePrice?: {
    input_micros_per_million: number
    output_micros_per_million: number
    cache_read_micros_per_million: number
    per_request_micros: number
  }
  serviceTier?: string
  requestCount: number
}

interface ContextRow {
  account_rate_multiplier_ppm: number
  channel_id: string | null
  apply_pricing_to_account_stats: number | null
}

interface PricingRow {
  pricing_id: string
  billing_mode: 'token' | 'per_request' | 'image'
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  image_output_micros_per_million: number | null
  per_request_micros: number | null
  interval_id: string | null
  min_tokens: number | null
  max_tokens: number | null
  interval_input_micros_per_million: number | null
  interval_output_micros_per_million: number | null
  interval_cache_write_micros_per_million: number | null
  interval_cache_write_1h_micros_per_million: number | null
  interval_cache_read_micros_per_million: number | null
  interval_per_request_micros: number | null
}

/**
 * Resolves the provider-account acquisition cost independently from the
 * customer charge. Any unavailable v0.31 schema/configuration degrades to the
 * immutable standard-price snapshot so rolling deploys never block billing.
 */
export async function resolveAccountCostSnapshot(
  env: { DB: D1Database },
  input: AccountCostInput,
): Promise<AccountCostSnapshot> {
  const inputFallback = failSoftStandardSnapshot(input.standardCostMicros)
  let standardCostMicros: number
  try {
    validateInput(input)
    standardCostMicros = defaultAccountStandardCost(input)
  } catch {
    return inputFallback
  }
  const fallback = failSoftStandardSnapshot(standardCostMicros)
  let context: ContextRow | null
  try {
    context = await env.DB.prepare(
      `SELECT account.billing_rate_multiplier_ppm AS account_rate_multiplier_ppm,
              channel.id AS channel_id,
              channel.apply_pricing_to_account_stats AS apply_pricing_to_account_stats
         FROM accounts AS account
         LEFT JOIN channel_groups AS membership ON membership.group_id = ?
         LEFT JOIN channels AS channel
           ON channel.id = membership.channel_id AND channel.status = 'active'
        WHERE account.id = ?
        LIMIT 1`,
    ).bind(input.groupId, input.accountId).first<ContextRow>()
  } catch {
    return fallback
  }
  if (context === null || !safeNonNegative(context.account_rate_multiplier_ppm)) return fallback
  const channelOverride = context.apply_pricing_to_account_stats === 1 &&
      input.channelPricingBasisMicros !== undefined &&
      safeNonNegative(input.channelPricingBasisMicros)
    ? input.channelPricingBasisMicros
    : null
  let contextFallback: AccountCostSnapshot
  try {
    contextFallback = baseSnapshot(
      standardCostMicros,
      context.account_rate_multiplier_ppm,
      channelOverride,
    )
  } catch {
    // Account-cost reporting is operational metadata. A legal but unusably
    // large multiplier must not block settlement of already-completed work.
    return fallback
  }
  try {
    let override = channelOverride
    if (context.channel_id !== null && input.upstreamModel.trim() !== '') {
      const pricing = await matchingPricing(
        env.DB,
        context.channel_id,
        input.accountId,
        input.groupId,
        input.platform,
        input.upstreamModel,
      )
      override = calculateCustomCost(pricing, input.usage, input.requestCount) ?? channelOverride
    }
    return baseSnapshot(standardCostMicros, context.account_rate_multiplier_ppm, override)
  } catch {
    return contextFallback
  }
}

function defaultAccountStandardCost(input: AccountCostInput): number {
  const price = input.accountCostBasePrice
  if (price === undefined || input.upstreamModel.trim() === '') return input.standardCostMicros
  const calculated = calculateCost({
    upstream_name: input.upstreamModel,
    ...price,
    rate_multiplier_ppm: 1_000_000,
  }, input.usage, input.serviceTier).amount_micros
  // Match the legacy model-file pricing contract: a missing, invalid, or
  // zero-valued catalog result does not override the caller's standard basis.
  return calculated > 0 ? calculated : input.standardCostMicros
}

function failSoftStandardSnapshot(standardCostMicros: number): AccountCostSnapshot {
  const safeStandard = safeNonNegative(standardCostMicros) ? standardCostMicros : 0
  return {
    standard_cost_micros: safeStandard,
    account_stats_cost_micros: null,
    account_rate_multiplier_ppm: 1_000_000,
    account_cost_micros: safeStandard,
  }
}

async function matchingPricing(
  db: D1Database,
  channelId: string,
  accountId: string,
  groupId: string,
  platform: string,
  upstreamModel: string,
): Promise<PricingRow[]> {
  const result = await db.prepare(
    `SELECT pricing.id AS pricing_id, pricing.billing_mode,
            pricing.input_micros_per_million,
            pricing.output_micros_per_million,
            pricing.cache_write_micros_per_million,
            pricing.cache_write_1h_micros_per_million,
            pricing.cache_read_micros_per_million,
            pricing.image_output_micros_per_million,
            pricing.per_request_micros,
            interval.id AS interval_id, interval.min_tokens, interval.max_tokens,
            interval.input_micros_per_million AS interval_input_micros_per_million,
            interval.output_micros_per_million AS interval_output_micros_per_million,
            interval.cache_write_micros_per_million AS interval_cache_write_micros_per_million,
            interval.cache_write_1h_micros_per_million AS interval_cache_write_1h_micros_per_million,
            interval.cache_read_micros_per_million AS interval_cache_read_micros_per_million,
            interval.per_request_micros AS interval_per_request_micros
       FROM channel_account_stats_pricing_rules AS rule
       JOIN channel_account_stats_model_pricing AS pricing ON pricing.rule_id = rule.id
       JOIN channel_account_stats_pricing_models AS model ON model.pricing_id = pricing.id
       LEFT JOIN channel_account_stats_pricing_intervals AS interval ON interval.pricing_id = pricing.id
      WHERE rule.channel_id = ?
        AND (
          EXISTS (
            SELECT 1 FROM channel_account_stats_rule_accounts AS account_scope
             WHERE account_scope.rule_id = rule.id AND account_scope.account_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM channel_account_stats_rule_groups AS group_scope
             WHERE group_scope.rule_id = rule.id AND group_scope.group_id = ?
          )
        )
        AND (? = '' OR pricing.platform = '' OR lower(pricing.platform) = lower(?))
        AND (
          (model.is_wildcard = 0 AND lower(model.model_pattern) = lower(?))
          OR (
            model.is_wildcard = 1
            AND substr(lower(?), 1, length(model.model_pattern) - 1) =
                lower(substr(model.model_pattern, 1, length(model.model_pattern) - 1))
          )
        )
      ORDER BY rule.sort_order ASC, rule.id ASC, model.is_wildcard ASC,
               pricing.sort_order ASC, pricing.id ASC, model.sort_order ASC,
               model.model_pattern COLLATE NOCASE ASC,
               interval.sort_order ASC, interval.id ASC`,
  ).bind(
    channelId,
    accountId,
    groupId,
    platform,
    platform,
    upstreamModel,
    upstreamModel,
  ).all<PricingRow>()
  if (result.results.length === 0) return []
  const selectedId = result.results[0].pricing_id
  return result.results.filter((row) => row.pricing_id === selectedId)
}

function calculateCustomCost(
  rows: PricingRow[],
  usage: TokenUsage,
  requestCount: number,
): number | null {
  const first = rows[0]
  if (first === undefined) return null
  const totalTokens = usage.input_tokens + usage.output_tokens
  // Legacy account-stat pricing only applies token intervals. Per-request and
  // image modes always use their flat price; the control plane rejects tiers
  // for those modes so stored and runtime semantics cannot diverge.
  const interval = first.billing_mode === 'token'
    ? rows.find((row) =>
        row.interval_id !== null &&
        row.min_tokens !== null &&
        totalTokens > row.min_tokens &&
        (row.max_tokens === null || totalTokens <= row.max_tokens),
      )
    : undefined
  const source = interval === undefined
    ? first
    : {
        ...first,
        input_micros_per_million: interval.interval_input_micros_per_million,
        output_micros_per_million: interval.interval_output_micros_per_million,
        cache_write_micros_per_million: interval.interval_cache_write_micros_per_million,
        cache_write_1h_micros_per_million: interval.interval_cache_write_1h_micros_per_million,
        cache_read_micros_per_million: interval.interval_cache_read_micros_per_million,
        per_request_micros: interval.interval_per_request_micros,
      }

  if (first.billing_mode === 'per_request' || first.billing_mode === 'image') {
    if (source.per_request_micros === null || source.per_request_micros <= 0) return null
    return checkedNumber(BigInt(source.per_request_micros) * BigInt(requestCount))
  }

  const cached = Math.min(usage.cache_read_tokens, usage.input_tokens)
  const cacheWrite = Math.min(usage.cache_write_tokens ?? 0, usage.input_tokens - cached)
  const regularInput = usage.input_tokens - cached - cacheWrite
  const cost =
    BigInt(priced(regularInput, source.input_micros_per_million)) +
    BigInt(priced(usage.output_tokens, source.output_micros_per_million)) +
    BigInt(priced(cacheWrite, source.cache_write_micros_per_million)) +
    BigInt(priced(cached, source.cache_read_micros_per_million))
  const value = checkedNumber(cost)
  return value > 0 ? value : null
}

function priced(units: number, microsPerMillion: number | null): number {
  if (microsPerMillion === null) return 0
  return checkedNumber(
    (BigInt(units) * BigInt(microsPerMillion) + PPM - 1n) / PPM,
  )
}

function baseSnapshot(
  standardCostMicros: number,
  accountRateMultiplierPpm: number,
  override: number | null,
): AccountCostSnapshot {
  const basis = override ?? standardCostMicros
  return {
    standard_cost_micros: standardCostMicros,
    account_stats_cost_micros: override,
    account_rate_multiplier_ppm: accountRateMultiplierPpm,
    account_cost_micros: checkedNumber(
      (BigInt(basis) * BigInt(accountRateMultiplierPpm) + PPM - 1n) / PPM,
    ),
  }
}

function validateInput(input: AccountCostInput): void {
  if (
    !safeNonNegative(input.standardCostMicros) ||
    !safeNonNegative(input.requestCount) ||
    !safeNonNegative(input.usage.input_tokens) ||
    !safeNonNegative(input.usage.output_tokens) ||
    !safeNonNegative(input.usage.cache_read_tokens) ||
    (input.usage.cache_write_tokens !== undefined && !safeNonNegative(input.usage.cache_write_tokens))
  ) throw new Error('Invalid account-cost input')
}

function safeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function checkedNumber(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Account cost overflow')
  return result
}
