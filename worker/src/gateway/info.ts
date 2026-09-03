import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError, gatewayErrorResponse } from './errors'
import { authenticateGatewayRequest } from './repository'

type GatewayBindings = { Bindings: Env }

interface BillingRow {
  rate_multiplier_ppm: number
}

interface UsageSummaryRow {
  today_requests: number
  today_input_tokens: number
  today_output_tokens: number
  today_cache_read_tokens: number
  today_amount_micros: number
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_amount_micros: number
  average_duration_ms: number | null
}

interface UsageModelRow {
  model: string
  requests: number
  input_tokens: number
  output_tokens: number
  amount_micros: number
}

interface UsageDayRow {
  day_start_ms: number
  requests: number
  input_tokens: number
  output_tokens: number
  amount_micros: number
}

const DAY_MS = 86_400_000

export async function handleKeyBillingInfo(context: Context<GatewayBindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const row = await context.env.DB.prepare(
      `SELECT rate_multiplier_ppm
         FROM "groups"
        WHERE id = ? AND enabled = 1 AND platform = 'openai'`,
    ).bind(principal.group_id).first<BillingRow>()
    if (row === null || !isNonNegativeInteger(row.rate_multiplier_ppm)) {
      throw new GatewayError(503, 'billing_information_unavailable', 'Billing information is unavailable', 'server_error')
    }
    const multiplier = row.rate_multiplier_ppm / 1_000_000
    return context.json({
      object: 'sub2api.key_billing',
      schema_version: 1,
      billing_scope: 'token',
      group_rate_multiplier: multiplier,
      resolved_rate_multiplier: multiplier,
      peak_rate_enabled: false,
      effective_rate_multiplier: multiplier,
      group_rate_multiplier_ppm: row.rate_multiplier_ppm,
      observed_at: new Date().toISOString(),
    })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function handleGatewayUsage(context: Context<GatewayBindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const days = parseDays(context.req.query('days'))
    const now = Date.now()
    const todayStart = Math.floor(now / DAY_MS) * DAY_MS
    const rangeStart = todayStart - (days - 1) * DAY_MS
    const rangeEnd = todayStart + DAY_MS
    const [summaryResult, modelsResult, dailyResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT
           COUNT(CASE WHEN occurred_at_ms >= ? THEN 1 END) AS today_requests,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN input_tokens ELSE 0 END), 0) AS today_input_tokens,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN output_tokens ELSE 0 END), 0) AS today_output_tokens,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN cache_read_tokens ELSE 0 END), 0) AS today_cache_read_tokens,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN amount_micros ELSE 0 END), 0) AS today_amount_micros,
           COUNT(*) AS total_requests,
           COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
           COALESCE(SUM(amount_micros), 0) AS total_amount_micros,
           CAST(ROUND(AVG(duration_ms)) AS INTEGER) AS average_duration_ms
         FROM usage_projection
        WHERE api_key_id = ?`,
      ).bind(todayStart, todayStart, todayStart, todayStart, todayStart, principal.api_key_id),
      context.env.DB.prepare(
        `SELECT requested_model AS model, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(amount_micros), 0) AS amount_micros
           FROM usage_projection
          WHERE api_key_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
          GROUP BY requested_model
          ORDER BY amount_micros DESC, requested_model ASC
          LIMIT 100`,
      ).bind(principal.api_key_id, rangeStart, rangeEnd),
      context.env.DB.prepare(
        `SELECT CAST(occurred_at_ms / 86400000 AS INTEGER) * 86400000 AS day_start_ms,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(amount_micros), 0) AS amount_micros
           FROM usage_projection
          WHERE api_key_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
          GROUP BY day_start_ms
          ORDER BY day_start_ms ASC`,
      ).bind(principal.api_key_id, rangeStart, rangeEnd),
    ])
    const summary = requireUsageSummary(summaryResult.results[0])
    const modelStats = modelsResult.results.map(requireModelUsage)
    const dailyUsage = dailyResult.results.map(requireDailyUsage)
    const todayTokens = checkedSum(summary.today_input_tokens, summary.today_output_tokens)
    const totalTokens = checkedSum(summary.total_input_tokens, summary.total_output_tokens)

    return context.json({
      mode: 'unrestricted',
      isValid: true,
      planName: '钱包余额',
      remaining: microsToUsd(principal.balance_micros),
      unit: 'USD',
      balance: microsToUsd(principal.balance_micros),
      balance_micros: principal.balance_micros,
      usage: {
        today: usageBlock(
          summary.today_requests,
          summary.today_input_tokens,
          summary.today_output_tokens,
          summary.today_cache_read_tokens,
          todayTokens,
          summary.today_amount_micros,
        ),
        total: usageBlock(
          summary.total_requests,
          summary.total_input_tokens,
          summary.total_output_tokens,
          summary.total_cache_read_tokens,
          totalTokens,
          summary.total_amount_micros,
        ),
        average_duration_ms: summary.average_duration_ms ?? 0,
      },
      daily_usage: dailyUsage,
      model_stats: modelStats,
      observed_at: new Date(now).toISOString(),
      timezone: 'UTC',
    })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

function parseDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 30
  if (!/^\d{1,2}$/.test(raw)) {
    throw new GatewayError(400, 'invalid_days', 'Invalid days, allowed range is 1-90')
  }
  const days = Number(raw)
  if (days < 1 || days > 90) {
    throw new GatewayError(400, 'invalid_days', 'Invalid days, allowed range is 1-90')
  }
  return days
}

function requireUsageSummary(value: unknown): UsageSummaryRow {
  if (value === null || typeof value !== 'object') throw invalidUsageProjection()
  const row = value as Record<string, unknown>
  for (const field of [
    'today_requests',
    'today_input_tokens',
    'today_output_tokens',
    'today_cache_read_tokens',
    'today_amount_micros',
    'total_requests',
    'total_input_tokens',
    'total_output_tokens',
    'total_cache_read_tokens',
    'total_amount_micros',
  ]) {
    if (!isNonNegativeInteger(row[field])) throw invalidUsageProjection()
  }
  if (row.average_duration_ms !== null && !isNonNegativeInteger(row.average_duration_ms)) {
    throw invalidUsageProjection()
  }
  return row as unknown as UsageSummaryRow
}

function requireModelUsage(value: unknown): ReturnType<typeof modelUsage> {
  if (value === null || typeof value !== 'object') throw invalidUsageProjection()
  const row = value as unknown as UsageModelRow
  if (
    typeof row.model !== 'string' || row.model.length === 0 || row.model.length > 256 ||
    !isNonNegativeInteger(row.requests) || !isNonNegativeInteger(row.input_tokens) ||
    !isNonNegativeInteger(row.output_tokens) || !isNonNegativeInteger(row.amount_micros)
  ) throw invalidUsageProjection()
  return modelUsage(row)
}

function requireDailyUsage(value: unknown): ReturnType<typeof dailyUsage> {
  if (value === null || typeof value !== 'object') throw invalidUsageProjection()
  const row = value as unknown as UsageDayRow
  if (
    !isNonNegativeInteger(row.day_start_ms) || !isNonNegativeInteger(row.requests) ||
    !isNonNegativeInteger(row.input_tokens) || !isNonNegativeInteger(row.output_tokens) ||
    !isNonNegativeInteger(row.amount_micros)
  ) throw invalidUsageProjection()
  return dailyUsage(row)
}

function usageBlock(
  requests: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  totalTokens: number,
  amountMicros: number,
) {
  return {
    requests,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: 0,
    cache_read_tokens: cacheReadTokens,
    total_tokens: totalTokens,
    cost: microsToUsd(amountMicros),
    actual_cost: microsToUsd(amountMicros),
    amount_micros: amountMicros,
  }
}

function modelUsage(row: UsageModelRow) {
  return {
    model: row.model,
    requests: row.requests,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: checkedSum(row.input_tokens, row.output_tokens),
    cost: microsToUsd(row.amount_micros),
    amount_micros: row.amount_micros,
  }
}

function dailyUsage(row: UsageDayRow) {
  return {
    date: new Date(row.day_start_ms).toISOString().slice(0, 10),
    requests: row.requests,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: checkedSum(row.input_tokens, row.output_tokens),
    cost: microsToUsd(row.amount_micros),
    amount_micros: row.amount_micros,
  }
}

function checkedSum(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) throw invalidUsageProjection()
  return total
}

function microsToUsd(value: number): number {
  if (!isNonNegativeInteger(value)) throw invalidUsageProjection()
  return value / 1_000_000
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function invalidUsageProjection(): GatewayError {
  return new GatewayError(503, 'invalid_usage_projection', 'Usage information is unavailable', 'server_error')
}
