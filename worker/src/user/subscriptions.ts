import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { controlError, controlSuccess, requireResourceId } from '../control/http'
import type { Env } from '../env'
import { normalizeSubscriptionWindows } from '../subscription-windows'
import { asGatewayError, GatewayError } from '../gateway/errors'

type UserBindings = { Bindings: Env }

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS
const MAX_DATE_MS = 8_640_000_000_000_000

interface SubscriptionRow {
  id: string
  user_id: string
  group_id: string
  plan_id: string | null
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  starts_at_ms: number
  expires_at_ms: number
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_anchor_ms: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  source_type: 'admin' | 'registration' | 'redeem' | 'payment'
  control_version: number
  created_at_ms: number
  updated_at_ms: number
  group_name: string
  group_platform: string
  group_description: string | null
  group_type: 'subscription'
  effective_rate_multiplier_ppm: number
}

export async function listUserSubscriptions(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const rows = await context.env.DB.prepare(
      `${subscriptionSelect()}
       WHERE s.user_id = ?
       ORDER BY CASE WHEN s.status = 'active' AND s.expires_at_ms > ? THEN 0 ELSE 1 END,
                s.created_at_ms DESC, s.id DESC`,
    ).bind(user.id, Date.now()).all<SubscriptionRow>()
    return controlSuccess(rows.results.map((row) => publicSubscription(row, Date.now())))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listActiveUserSubscriptions(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const current = Date.now()
    const rows = await context.env.DB.prepare(
      `${subscriptionSelect()}
       WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at_ms > ?
       ORDER BY s.expires_at_ms ASC, s.id ASC`,
    ).bind(user.id, current).all<SubscriptionRow>()
    return controlSuccess(rows.results.map((row) => publicSubscription(row, current)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listUserSubscriptionProgress(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const current = Date.now()
    const rows = await context.env.DB.prepare(
      `${subscriptionSelect()}
       WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at_ms > ?
       ORDER BY s.expires_at_ms ASC, s.id ASC`,
    ).bind(user.id, current).all<SubscriptionRow>()
    return controlSuccess(rows.results.map((row) => ({
      subscription: publicSubscription(row, current),
      progress: subscriptionProgress(row, current),
    })))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getUserSubscriptionProgress(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const subscriptionId = requireResourceId(context.req.param('id'), 'subscription')
    const row = await context.env.DB.prepare(
      `${subscriptionSelect()} WHERE s.id = ? AND s.user_id = ? LIMIT 1`,
    ).bind(subscriptionId, user.id).first<SubscriptionRow>()
    if (row === null) {
      throw new GatewayError(404, 'subscription_not_found', 'Subscription was not found')
    }
    return controlSuccess(subscriptionProgress(row, Date.now()))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getUserSubscriptionSummary(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const current = Date.now()
    const rows = await context.env.DB.prepare(
      `${subscriptionSelect()}
       WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at_ms > ?
       ORDER BY s.expires_at_ms ASC, s.id ASC`,
    ).bind(user.id, current).all<SubscriptionRow>()
    return controlSuccess({
      active_count: rows.results.length,
      total_used_usd: microsToUsd(rows.results.reduce(
        (total, row) => checkedMicrosSum(total, row.monthly_used_micros),
        0,
      )),
      subscriptions: rows.results.map((row) => ({
        id: row.id,
        group_id: row.group_id,
        group_name: row.group_name,
        status: effectiveStatus(row, current),
        daily_used_usd: microsToUsd(row.daily_used_micros),
        daily_limit_usd: nullableMicrosToUsd(row.daily_quota_micros),
        weekly_used_usd: microsToUsd(row.weekly_used_micros),
        weekly_limit_usd: nullableMicrosToUsd(row.weekly_quota_micros),
        monthly_used_usd: microsToUsd(row.monthly_used_micros),
        monthly_limit_usd: nullableMicrosToUsd(row.monthly_quota_micros),
        expires_at: iso(row.expires_at_ms),
        days_remaining: daysRemaining(row.expires_at_ms, current),
      })),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function subscriptionSelect(): string {
  return `SELECT s.id, s.user_id, s.group_id, s.plan_id, s.status,
                 s.starts_at_ms, s.expires_at_ms,
                 s.daily_quota_micros, s.weekly_quota_micros, s.monthly_quota_micros,
                 s.daily_used_micros, s.weekly_used_micros, s.monthly_used_micros,
                 s.daily_anchor_ms, s.daily_window_start_ms,
                 s.weekly_window_start_ms, s.monthly_window_start_ms,
                 s.source_type, s.control_version, s.created_at_ms, s.updated_at_ms,
                 g.name AS group_name, g.platform AS group_platform,
                 g.description AS group_description, g.group_type,
                 COALESCE(rate.rate_multiplier_ppm, g.rate_multiplier_ppm)
                   AS effective_rate_multiplier_ppm
            FROM user_subscriptions s
            JOIN "groups" g ON g.id = s.group_id
            LEFT JOIN user_group_rate_overrides rate
              ON rate.user_id = s.user_id AND rate.group_id = s.group_id`
}

function publicSubscription(row: SubscriptionRow, current: number): Record<string, unknown> {
  const normalized = normalizeSubscriptionWindows(row, current)
  return {
    id: row.id,
    user_id: row.user_id,
    group_id: row.group_id,
    plan_id: row.plan_id,
    status: effectiveStatus(row, current),
    starts_at: iso(row.starts_at_ms),
    expires_at: iso(row.expires_at_ms),
    daily_usage_usd: microsToUsd(normalized.daily_used_micros),
    weekly_usage_usd: microsToUsd(normalized.weekly_used_micros),
    monthly_usage_usd: microsToUsd(normalized.monthly_used_micros),
    daily_window_start: nullableIso(normalized.daily_window_start_ms),
    weekly_window_start: nullableIso(normalized.weekly_window_start_ms),
    monthly_window_start: nullableIso(normalized.monthly_window_start_ms),
    created_at: iso(row.created_at_ms),
    updated_at: iso(row.updated_at_ms),
    control_version: row.control_version,
    group: {
      id: row.group_id,
      name: row.group_name,
      platform: row.group_platform,
      description: row.group_description,
      subscription_type: row.group_type,
      rate_multiplier: ppmToMultiplier(row.effective_rate_multiplier_ppm),
      daily_limit_usd: nullableMicrosToUsd(row.daily_quota_micros),
      weekly_limit_usd: nullableMicrosToUsd(row.weekly_quota_micros),
      monthly_limit_usd: nullableMicrosToUsd(row.monthly_quota_micros),
    },
  }
}

function subscriptionProgress(row: SubscriptionRow, current: number): Record<string, unknown> {
  const normalized = normalizeSubscriptionWindows(row, current)
  return {
    subscription_id: row.id,
    daily: windowProgress(
      normalized.daily_used_micros,
      row.daily_quota_micros,
      normalized.daily_window_start_ms,
      DAY_MS,
      row.expires_at_ms,
      current,
    ),
    weekly: windowProgress(
      normalized.weekly_used_micros,
      row.weekly_quota_micros,
      normalized.weekly_window_start_ms,
      WEEK_MS,
      row.expires_at_ms,
      current,
    ),
    monthly: windowProgress(
      normalized.monthly_used_micros,
      row.monthly_quota_micros,
      normalized.monthly_window_start_ms,
      MONTH_MS,
      row.expires_at_ms,
      current,
    ),
    expires_at: iso(row.expires_at_ms),
    days_remaining: daysRemaining(row.expires_at_ms, current),
  }
}

function windowProgress(
  usedMicros: number,
  limitMicros: number | null,
  windowStartMs: number | null,
  periodMs: number,
  expiresAtMs: number,
  current: number,
): Record<string, unknown> {
  validateTimestamp(expiresAtMs)
  if (windowStartMs !== null) validateTimestamp(windowStartMs)
  const percentage = limitMicros === null || limitMicros === 0
    ? 0
    : Math.min(100, (usedMicros / limitMicros) * 100)
  const resetAt = windowStartMs === null ? null : Math.min(windowStartMs + periodMs, expiresAtMs)
  return {
    used: microsToUsd(usedMicros),
    limit: nullableMicrosToUsd(limitMicros),
    percentage,
    reset_in_seconds: resetAt === null ? null : Math.max(0, Math.ceil((resetAt - current) / 1_000)),
  }
}

function effectiveStatus(
  row: Pick<SubscriptionRow, 'status' | 'expires_at_ms'>,
  current: number,
): SubscriptionRow['status'] {
  return row.status === 'active' && row.expires_at_ms <= current ? 'expired' : row.status
}

function daysRemaining(expiresAtMs: number, current: number): number {
  validateTimestamp(expiresAtMs)
  validateTimestamp(current)
  return Math.max(0, Math.ceil((expiresAtMs - current) / DAY_MS))
}

function checkedMicrosSum(left: number, right: number): number {
  if (!Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new GatewayError(500, 'invalid_subscription_usage', 'Subscription usage is invalid', 'server_error')
  }
  return left + right
}

function microsToUsd(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'invalid_subscription_amount', 'Subscription amount is invalid', 'server_error')
  }
  return value / 1_000_000
}

function nullableMicrosToUsd(value: number | null): number | null {
  return value === null ? null : microsToUsd(value)
}

function ppmToMultiplier(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'invalid_group_rate_multiplier', 'Group rate multiplier is invalid', 'server_error')
  }
  return value / 1_000_000
}

function iso(value: number): string {
  validateTimestamp(value)
  return new Date(value).toISOString()
}

function nullableIso(value: number | null): string | null {
  return value === null ? null : iso(value)
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new GatewayError(
      500,
      'invalid_subscription_timestamp',
      'Subscription timestamp is invalid',
      'server_error',
    )
  }
}
