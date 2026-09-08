import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError, gatewayErrorResponse } from './errors'
import { authenticateGatewayRequest } from './repository'
import { normalizeSubscriptionWindows } from '../subscription-windows'

type GatewayBindings = { Bindings: Env }

interface BillingRow {
  group_rate_multiplier_ppm: number
  user_rate_multiplier_ppm: number | null
}

interface UsageSummaryRow {
  today_requests: number
  today_input_tokens: number
  today_output_tokens: number
  today_cache_read_tokens: number
  today_cache_write_tokens?: number
  today_amount_micros: number
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_write_tokens?: number
  total_amount_micros: number
  average_duration_ms: number | null
}

interface UsageModelRow {
  model: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens?: number
  amount_micros: number
}

interface UsageDayRow {
  local_date: string
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens?: number
  amount_micros: number
}

interface DayBucket {
  date: string
  start_ms: number
  end_ms: number
}

const DAY_MS = 86_400_000

export async function handleKeyBillingInfo(context: Context<GatewayBindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const row = await context.env.DB.prepare(
      `SELECT g.rate_multiplier_ppm AS group_rate_multiplier_ppm,
              user_rate.rate_multiplier_ppm AS user_rate_multiplier_ppm
         FROM "groups" g
         LEFT JOIN user_group_rate_overrides user_rate
           ON user_rate.group_id = g.id AND user_rate.user_id = ?
        WHERE g.id = ? AND g.enabled = 1 AND g.platform = 'openai'`,
    ).bind(principal.user_id, principal.group_id).first<BillingRow>()
    if (
      row === null ||
      !isNonNegativeInteger(row.group_rate_multiplier_ppm) ||
      (row.user_rate_multiplier_ppm !== null &&
        !isNonNegativeInteger(row.user_rate_multiplier_ppm))
    ) {
      throw new GatewayError(503, 'billing_information_unavailable', 'Billing information is unavailable', 'server_error')
    }
    const groupMultiplier = row.group_rate_multiplier_ppm / 1_000_000
    const effectivePpm = row.user_rate_multiplier_ppm ?? row.group_rate_multiplier_ppm
    const effectiveMultiplier = effectivePpm / 1_000_000
    return context.json({
      object: 'sub2api.key_billing',
      schema_version: 1,
      billing_scope: 'token',
      group_rate_multiplier: groupMultiplier,
      ...(row.user_rate_multiplier_ppm === null
        ? {}
        : { user_rate_multiplier: effectiveMultiplier }),
      resolved_rate_multiplier: effectiveMultiplier,
      peak_rate_enabled: false,
      effective_rate_multiplier: effectiveMultiplier,
      group_rate_multiplier_ppm: row.group_rate_multiplier_ppm,
      ...(row.user_rate_multiplier_ppm === null
        ? {}
        : { user_rate_multiplier_ppm: row.user_rate_multiplier_ppm }),
      effective_rate_multiplier_ppm: effectivePpm,
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
    const range = usageRange(context, days, now)
    // D1 accepts at most 100 bound parameters per statement. Each local-day
    // CASE arm consumes three, plus the key and outer range, so keep chunks at
    // 30 days (93 parameters) while preserving timezone/DST-correct buckets.
    const dailyStatements: D1PreparedStatement[] = []
    for (let index = 0; index < range.dailyBuckets.length; index += 30) {
      const buckets = range.dailyBuckets.slice(index, index + 30)
      const dailyCases = buckets
        .map(() => 'WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN ?')
        .join(' ')
      const dailyCaseValues = buckets
        .flatMap((bucket) => [bucket.start_ms, bucket.end_ms, bucket.date])
      dailyStatements.push(context.env.DB.prepare(
        `SELECT CASE ${dailyCases} END AS local_date,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(amount_micros), 0) AS amount_micros
           FROM usage_projection
          WHERE api_key_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
          GROUP BY local_date
          ORDER BY local_date ASC`,
      ).bind(
        ...dailyCaseValues,
        principal.api_key_id,
        buckets[0]!.start_ms,
        buckets.at(-1)!.end_ms,
      ))
    }
    const [summaryResult, modelsResult, ...dailyResults] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT
           COUNT(CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN 1 END) AS today_requests,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN input_tokens ELSE 0 END), 0) AS today_input_tokens,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN output_tokens ELSE 0 END), 0) AS today_output_tokens,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN cache_read_tokens ELSE 0 END), 0) AS today_cache_read_tokens,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN cache_write_tokens ELSE 0 END), 0) AS today_cache_write_tokens,
           COALESCE(SUM(CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN amount_micros ELSE 0 END), 0) AS today_amount_micros,
           COUNT(*) AS total_requests,
           COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
           COALESCE(SUM(amount_micros), 0) AS total_amount_micros,
           CAST(ROUND(AVG(duration_ms)) AS INTEGER) AS average_duration_ms
         FROM usage_projection
        WHERE api_key_id = ?`,
      ).bind(
        range.today.start_ms, range.today.end_ms,
        range.today.start_ms, range.today.end_ms,
        range.today.start_ms, range.today.end_ms,
        range.today.start_ms, range.today.end_ms,
        range.today.start_ms, range.today.end_ms,
        range.today.start_ms, range.today.end_ms,
        principal.api_key_id,
      ),
      context.env.DB.prepare(
        `SELECT requested_model AS model, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(amount_micros), 0) AS amount_micros
           FROM usage_projection
          WHERE api_key_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
          GROUP BY requested_model
          ORDER BY amount_micros DESC, requested_model ASC
          LIMIT 100`,
      ).bind(principal.api_key_id, range.main_start_ms, range.main_end_ms),
      ...dailyStatements,
    ])
    const summary = requireUsageSummary(summaryResult.results[0])
    const modelStats = modelsResult.results.map(requireModelUsage)
    const dailyUsage = dailyResults
      .flatMap((result) => result.results.map(requireDailyUsage))
      .sort((left, right) => left.date.localeCompare(right.date))
    const todayTokens = checkedSum(summary.today_input_tokens, summary.today_output_tokens)
    const totalTokens = checkedSum(summary.total_input_tokens, summary.total_output_tokens)
    const usage = {
      today: usageBlock(
        summary.today_requests,
        summary.today_input_tokens,
        summary.today_output_tokens,
        summary.today_cache_read_tokens,
        todayTokens,
        summary.today_amount_micros,
        summary.today_cache_write_tokens ?? 0,
      ),
      total: usageBlock(
        summary.total_requests,
        summary.total_input_tokens,
        summary.total_output_tokens,
        summary.total_cache_read_tokens,
        totalTokens,
        summary.total_amount_micros,
        summary.total_cache_write_tokens ?? 0,
      ),
      average_duration_ms: summary.average_duration_ms ?? 0,
    }

    if (principal.billing.type === 'subscription') {
      const group = await context.env.DB.prepare(
        'SELECT name FROM "groups" WHERE id = ? AND enabled = 1',
      ).bind(principal.group_id).first<{ name: string }>()
      if (group === null || typeof group.name !== 'string' || group.name.length === 0) {
        throw new GatewayError(
          503,
          'billing_information_unavailable',
          'Billing information is unavailable',
          'server_error',
        )
      }
      const subscription = normalizeSubscriptionWindows(principal.billing, now)
      return context.json({
        mode: 'unrestricted',
        isValid: true,
        planName: group.name,
        remaining: subscriptionRemaining(subscription),
        unit: 'USD',
        billing_type: 'subscription',
        subscription: {
          id: subscription.subscription_id,
          daily_usage_usd: microsToUsd(subscription.daily_used_micros),
          weekly_usage_usd: microsToUsd(subscription.weekly_used_micros),
          monthly_usage_usd: microsToUsd(subscription.monthly_used_micros),
          daily_limit_usd: nullableMicrosToUsd(subscription.daily_quota_micros),
          weekly_limit_usd: nullableMicrosToUsd(subscription.weekly_quota_micros),
          monthly_limit_usd: nullableMicrosToUsd(subscription.monthly_quota_micros),
          daily_window_start: nullableTimestamp(subscription.daily_window_start_ms),
          weekly_window_start: nullableTimestamp(subscription.weekly_window_start_ms),
          monthly_window_start: nullableTimestamp(subscription.monthly_window_start_ms),
          starts_at: new Date(subscription.starts_at_ms).toISOString(),
          expires_at: new Date(subscription.expires_at_ms).toISOString(),
        },
        usage,
        daily_usage: dailyUsage,
        model_stats: modelStats,
        observed_at: new Date(now).toISOString(),
        timezone: range.timezone,
      })
    }

    return context.json({
      mode: 'unrestricted',
      isValid: true,
      planName: '钱包余额',
      remaining: microsToUsd(principal.balance_micros),
      unit: 'USD',
      billing_type: 'balance',
      balance: microsToUsd(principal.balance_micros),
      balance_micros: principal.balance_micros,
      usage,
      daily_usage: dailyUsage,
      model_stats: modelStats,
      observed_at: new Date(now).toISOString(),
      timezone: range.timezone,
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

function usageRange(
  context: Context<GatewayBindings>,
  days: number,
  now: number,
): {
  timezone: string
  today: DayBucket
  main_start_ms: number
  main_end_ms: number
  dailyBuckets: DayBucket[]
} {
  const timezone = parseTimezone(context.req.query('timezone'))
  const todayDate = localDate(now, timezone)
  const startDate = context.req.query('start_date')
  const endDate = context.req.query('end_date')
  if ((startDate === undefined) !== (endDate === undefined)) {
    throw new GatewayError(400, 'invalid_date_range', 'start_date and end_date must be provided together')
  }
  const mainStartDate = startDate === undefined ? addCalendarDays(todayDate, -(days - 1)) : parseDate(startDate)
  const mainEndDate = endDate === undefined ? todayDate : parseDate(endDate)
  const mainStartDay = calendarDayNumber(mainStartDate)
  const mainEndDay = calendarDayNumber(mainEndDate)
  if (mainEndDay < mainStartDay || mainEndDay - mainStartDay > 365) {
    throw new GatewayError(400, 'invalid_date_range', 'Date range must contain between 1 and 366 days')
  }
  const today = dayBucket(todayDate, timezone)
  const dailyBuckets: DayBucket[] = []
  for (let index = days - 1; index >= 0; index -= 1) {
    dailyBuckets.push(dayBucket(addCalendarDays(todayDate, -index), timezone))
  }
  return {
    timezone,
    today,
    main_start_ms: zonedDayStart(mainStartDate, timezone),
    main_end_ms: zonedDayStart(addCalendarDays(mainEndDate, 1), timezone),
    dailyBuckets,
  }
}

export function parseTimezone(raw: string | undefined): string {
  const timezone = raw?.trim() || 'UTC'
  if (timezone.length > 64) {
    throw new GatewayError(400, 'invalid_timezone', 'timezone is invalid')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
  } catch {
    throw new GatewayError(400, 'invalid_timezone', 'timezone is invalid')
  }
  return timezone
}

export function parseDate(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (match === null) throw new GatewayError(400, 'invalid_date_range', 'Dates must use YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const value = new Date(Date.UTC(year, month - 1, day))
  if (
    value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day
  ) throw new GatewayError(400, 'invalid_date_range', 'Date is invalid')
  return raw
}

function calendarDayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS)
}

/** Calendar boundaries shared by server-timezone administration summaries. */
export function calendarDayBoundaries(now: number, timezone: string) {
  const validatedTimezone = parseTimezone(timezone)
  const date = localDate(now, validatedTimezone)
  return {
    today: zonedDayStart(date, validatedTimezone),
    yesterday: zonedDayStart(addCalendarDays(date, -1), validatedTimezone),
  }
}

export function addCalendarDays(date: string, days: number): string {
  return new Date((calendarDayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10)
}

function dayBucket(date: string, timezone: string): DayBucket {
  return {
    date,
    start_ms: zonedDayStart(date, timezone),
    end_ms: zonedDayStart(addCalendarDays(date, 1), timezone),
  }
}

export function localDate(timestamp: number, timezone: string): string {
  const parts = dateTimeParts(timestamp, timezone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function zonedDayStart(date: string, timezone: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const target = Date.UTC(year, month - 1, day)
  let candidate = target
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = dateTimeParts(candidate, timezone)
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const adjustment = target - represented
    candidate += adjustment
    if (adjustment === 0) break
  }
  const resolved = dateTimeParts(candidate, timezone)
  if (
    resolved.year !== year || resolved.month !== month || resolved.day !== day ||
    resolved.hour !== 0 || resolved.minute !== 0 || resolved.second !== 0
  ) throw new GatewayError(400, 'invalid_date_range', 'Date has no valid start in timezone')
  return candidate
}

function dateTimeParts(timestamp: number, timezone: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  }
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
    !isNonNegativeInteger(row.output_tokens) || !isNonNegativeInteger(row.cache_read_tokens) ||
    !isNonNegativeInteger(row.amount_micros)
  ) throw invalidUsageProjection()
  return modelUsage(row)
}

function requireDailyUsage(value: unknown): ReturnType<typeof dailyUsage> {
  if (value === null || typeof value !== 'object') throw invalidUsageProjection()
  const row = value as unknown as UsageDayRow
  if (
    typeof row.local_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.local_date) ||
    !isNonNegativeInteger(row.requests) ||
    !isNonNegativeInteger(row.input_tokens) || !isNonNegativeInteger(row.output_tokens) ||
    !isNonNegativeInteger(row.cache_read_tokens) || !isNonNegativeInteger(row.amount_micros)
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
  cacheWriteTokens = 0,
) {
  return {
    requests,
    input_tokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    output_tokens: outputTokens,
    cache_creation_tokens: cacheWriteTokens,
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
    input_tokens: Math.max(0, row.input_tokens - row.cache_read_tokens - (row.cache_write_tokens ?? 0)),
    output_tokens: row.output_tokens,
    cache_creation_tokens: row.cache_write_tokens ?? 0,
    cache_read_tokens: row.cache_read_tokens,
    total_tokens: checkedSum(row.input_tokens, row.output_tokens),
    cost: microsToUsd(row.amount_micros),
    actual_cost: microsToUsd(row.amount_micros),
    amount_micros: row.amount_micros,
  }
}

function dailyUsage(row: UsageDayRow) {
  return {
    date: row.local_date,
    requests: row.requests,
    input_tokens: Math.max(0, row.input_tokens - row.cache_read_tokens - (row.cache_write_tokens ?? 0)),
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens ?? 0,
    total_tokens: checkedSum(row.input_tokens, row.output_tokens),
    cost: microsToUsd(row.amount_micros),
    actual_cost: microsToUsd(row.amount_micros),
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

function nullableMicrosToUsd(value: number | null): number | null {
  return value === null ? null : microsToUsd(value)
}

function nullableTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function subscriptionRemaining(
  subscription: Extract<Awaited<ReturnType<typeof authenticateGatewayRequest>>['billing'], { type: 'subscription' }>,
): number {
  const windows = [
    [subscription.daily_quota_micros, subscription.daily_used_micros],
    [subscription.weekly_quota_micros, subscription.weekly_used_micros],
    [subscription.monthly_quota_micros, subscription.monthly_used_micros],
  ] as const
  const remaining: number[] = []
  for (const [limit, used] of windows) {
    if (limit === null) continue
    if (!isNonNegativeInteger(limit) || !isNonNegativeInteger(used)) {
      throw invalidUsageProjection()
    }
    const available = Math.max(0, limit - used)
    if (!Number.isSafeInteger(available)) throw invalidUsageProjection()
    remaining.push(available)
  }
  return remaining.length === 0 ? -1 : microsToUsd(Math.min(...remaining))
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function invalidUsageProjection(): GatewayError {
  return new GatewayError(503, 'invalid_usage_projection', 'Usage information is unavailable', 'server_error')
}
