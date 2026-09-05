import { groupAccessPredicate } from '../user/group-access'
import { GatewayError } from '../gateway/errors'
import type { GatewayPrincipal, PlatformQuotaPolicy } from '../gateway/types'
import type { MediaEnv } from './types'

interface MediaPrincipalRow {
  api_key_id: string
  api_key_auth_version: number
  api_key_enabled: number
  expires_at_ms: number | null
  revoked_at_ms: number | null
  user_id: string
  user_status: string
  balance_micros: number
  user_state_version: number
  concurrency_limit: number
  user_rpm_limit: number
  group_rpm_limit: number
  api_key_control_version: number
  quota_micros: number
  quota_used_micros: number
  rate_limit_5h_micros: number
  rate_limit_1d_micros: number
  rate_limit_7d_micros: number
  usage_5h_micros: number
  usage_1d_micros: number
  usage_7d_micros: number
  window_5h_start_ms: number | null
  window_1d_start_ms: number | null
  window_7d_start_ms: number | null
  api_key_quota_reset_epoch: number
  api_key_rate_limit_reset_epoch: number
  group_id: string
  group_enabled: number
  group_accessible: number
  platform: string
  group_type: 'standard' | 'subscription'
  subscription_id: string | null
  subscription_starts_at_ms: number | null
  subscription_expires_at_ms: number | null
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  daily_used_micros: number | null
  weekly_used_micros: number | null
  monthly_used_micros: number | null
  daily_anchor_ms: number | null
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  quota_reset_epoch: number | null
  quota_reset_generation: number | null
  subscription_control_version: number | null
  platform_quota_platform: PlatformQuotaPolicy['platform'] | null
  platform_quota_enabled: number | null
  platform_quota_control_version: number | null
  platform_daily_limit_micros: number | null
  platform_weekly_limit_micros: number | null
  platform_monthly_limit_micros: number | null
  platform_daily_used_micros: number | null
  platform_weekly_used_micros: number | null
  platform_monthly_used_micros: number | null
  platform_daily_window_start_ms: number | null
  platform_weekly_window_start_ms: number | null
  platform_monthly_window_start_ms: number | null
  platform_daily_reset_epoch: number | null
  platform_weekly_reset_epoch: number | null
  platform_monthly_reset_epoch: number | null
}

/** Resolves a one-time-secret API key by opaque id for a first-party user session. */
export async function resolveSessionMediaPrincipal(
  env: MediaEnv,
  userId: string,
  apiKeyId: string,
): Promise<GatewayPrincipal> {
  if (apiKeyId.length === 0 || apiKeyId.length > 128) throw unavailable()
  const now = Date.now()
  const row = await env.DB.prepare(
    `SELECT k.id AS api_key_id, k.auth_version AS api_key_auth_version,
            k.enabled AS api_key_enabled, k.expires_at_ms, k.revoked_at_ms,
            u.id AS user_id, u.status AS user_status, u.balance_micros,
            u.state_version AS user_state_version, u.concurrency AS concurrency_limit,
            u.rpm_limit AS user_rpm_limit,
            COALESCE(rpm_override.rpm_override, g.rpm_limit) AS group_rpm_limit,
            k.control_version AS api_key_control_version,
            k.quota_micros, k.quota_used_micros,
            k.rate_limit_5h_micros, k.rate_limit_1d_micros, k.rate_limit_7d_micros,
            k.usage_5h_micros, k.usage_1d_micros, k.usage_7d_micros,
            k.window_5h_start_ms, k.window_1d_start_ms, k.window_7d_start_ms,
            k.quota_reset_epoch AS api_key_quota_reset_epoch,
            k.rate_limit_reset_epoch AS api_key_rate_limit_reset_epoch,
            g.id AS group_id, g.enabled AS group_enabled, g.platform, g.group_type,
            subscription.id AS subscription_id,
            subscription.starts_at_ms AS subscription_starts_at_ms,
            subscription.expires_at_ms AS subscription_expires_at_ms,
            subscription.daily_quota_micros, subscription.weekly_quota_micros,
            subscription.monthly_quota_micros, subscription.daily_used_micros,
            subscription.weekly_used_micros, subscription.monthly_used_micros,
            subscription.daily_anchor_ms, subscription.daily_window_start_ms,
            subscription.weekly_window_start_ms, subscription.monthly_window_start_ms,
            subscription.quota_reset_epoch, subscription.quota_reset_generation,
            subscription.control_version AS subscription_control_version,
            platform_quota.platform AS platform_quota_platform,
            platform_quota.enabled AS platform_quota_enabled,
            platform_quota.control_version AS platform_quota_control_version,
            platform_quota.daily_limit_micros AS platform_daily_limit_micros,
            platform_quota.weekly_limit_micros AS platform_weekly_limit_micros,
            platform_quota.monthly_limit_micros AS platform_monthly_limit_micros,
            platform_quota.daily_used_micros AS platform_daily_used_micros,
            platform_quota.weekly_used_micros AS platform_weekly_used_micros,
            platform_quota.monthly_used_micros AS platform_monthly_used_micros,
            platform_quota.daily_window_start_ms AS platform_daily_window_start_ms,
            platform_quota.weekly_window_start_ms AS platform_weekly_window_start_ms,
            platform_quota.monthly_window_start_ms AS platform_monthly_window_start_ms,
            platform_quota.daily_reset_epoch AS platform_daily_reset_epoch,
            platform_quota.weekly_reset_epoch AS platform_weekly_reset_epoch,
            platform_quota.monthly_reset_epoch AS platform_monthly_reset_epoch,
            CASE WHEN ${groupAccessPredicate('g', 'u.id')} THEN 1 ELSE 0 END AS group_accessible
       FROM api_keys AS k
       JOIN users AS u ON u.id = k.user_id
       JOIN "groups" AS g ON g.id = k.group_id
       LEFT JOIN user_group_rpm_overrides AS rpm_override
         ON rpm_override.user_id = u.id AND rpm_override.group_id = g.id
       LEFT JOIN user_platform_quotas AS platform_quota
         ON platform_quota.user_id = u.id AND platform_quota.platform = 'gemini'
       LEFT JOIN user_subscriptions AS subscription
         ON subscription.user_id = u.id AND subscription.group_id = g.id
        AND subscription.status = 'active'
        AND subscription.starts_at_ms <= ? AND subscription.expires_at_ms > ?
      WHERE k.id = ? AND k.user_id = ? LIMIT 1`,
  ).bind(now, now, now, now, apiKeyId, userId).first<MediaPrincipalRow>()
  if (
    row === null || row.user_status !== 'active' || row.api_key_enabled !== 1 ||
    row.revoked_at_ms !== null || (row.expires_at_ms !== null && row.expires_at_ms <= now) ||
    row.group_enabled !== 1 || row.group_accessible !== 1 || row.platform !== 'gemini'
  ) throw unavailable()
  const subscription = row.group_type === 'subscription' && row.subscription_id !== null
    ? {
        type: 'subscription' as const,
        subscription_id: row.subscription_id,
        starts_at_ms: requiredInteger(row.subscription_starts_at_ms),
        expires_at_ms: requiredInteger(row.subscription_expires_at_ms),
        daily_quota_micros: row.daily_quota_micros,
        weekly_quota_micros: row.weekly_quota_micros,
        monthly_quota_micros: row.monthly_quota_micros,
        daily_used_micros: requiredInteger(row.daily_used_micros),
        weekly_used_micros: requiredInteger(row.weekly_used_micros),
        monthly_used_micros: requiredInteger(row.monthly_used_micros),
        daily_anchor_ms: requiredInteger(row.daily_anchor_ms),
        daily_window_start_ms: row.daily_window_start_ms,
        weekly_window_start_ms: row.weekly_window_start_ms,
        monthly_window_start_ms: row.monthly_window_start_ms,
        quota_reset_epoch: requiredInteger(row.quota_reset_epoch),
        quota_reset_generation: requiredInteger(row.quota_reset_generation),
        control_version: requiredInteger(row.subscription_control_version),
      }
    : { type: 'balance' as const }
  return {
    api_key_id: row.api_key_id,
    api_key_auth_version: requiredInteger(row.api_key_auth_version),
    user_id: row.user_id,
    group_id: row.group_id,
    platform: row.platform,
    balance_micros: requiredInteger(row.balance_micros),
    user_state_version: requiredInteger(row.user_state_version),
    limit_config_version: 1,
    concurrency_limit: requiredInteger(row.concurrency_limit),
    user_rpm_limit: requiredInteger(row.user_rpm_limit),
    group_rpm_limit: requiredInteger(row.group_rpm_limit),
    api_key_monetary: {
      control_version: requiredInteger(row.api_key_control_version),
      quota_micros: requiredInteger(row.quota_micros),
      quota_used_micros: requiredInteger(row.quota_used_micros),
      rate_limit_5h_micros: requiredInteger(row.rate_limit_5h_micros),
      rate_limit_1d_micros: requiredInteger(row.rate_limit_1d_micros),
      rate_limit_7d_micros: requiredInteger(row.rate_limit_7d_micros),
      usage_5h_micros: requiredInteger(row.usage_5h_micros),
      usage_1d_micros: requiredInteger(row.usage_1d_micros),
      usage_7d_micros: requiredInteger(row.usage_7d_micros),
      window_5h_start_ms: row.window_5h_start_ms,
      window_1d_start_ms: row.window_1d_start_ms,
      window_7d_start_ms: row.window_7d_start_ms,
      quota_reset_epoch: requiredInteger(row.api_key_quota_reset_epoch),
      rate_limit_reset_epoch: requiredInteger(row.api_key_rate_limit_reset_epoch),
    },
    platform_quota: mediaPlatformQuota(row),
    billing: subscription,
  }
}

function mediaPlatformQuota(row: MediaPrincipalRow): PlatformQuotaPolicy | null {
  if (row.platform_quota_enabled !== 1 || row.platform_quota_platform !== 'gemini') return null
  return {
    platform: 'gemini',
    control_version: requiredInteger(row.platform_quota_control_version),
    daily_limit_micros: row.platform_daily_limit_micros,
    weekly_limit_micros: row.platform_weekly_limit_micros,
    monthly_limit_micros: row.platform_monthly_limit_micros,
    daily_used_micros: requiredInteger(row.platform_daily_used_micros),
    weekly_used_micros: requiredInteger(row.platform_weekly_used_micros),
    monthly_used_micros: requiredInteger(row.platform_monthly_used_micros),
    daily_window_start_ms: row.platform_daily_window_start_ms,
    weekly_window_start_ms: row.platform_weekly_window_start_ms,
    monthly_window_start_ms: row.platform_monthly_window_start_ms,
    daily_reset_epoch: requiredInteger(row.platform_daily_reset_epoch),
    weekly_reset_epoch: requiredInteger(row.platform_weekly_reset_epoch),
    monthly_reset_epoch: requiredInteger(row.platform_monthly_reset_epoch),
  }
}

function requiredInteger(value: number | null): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(500, 'BATCH_IMAGE_INVALID_KEY_STATE', 'API key billing state is invalid', 'server_error')
  }
  return value as number
}

function unavailable(): GatewayError {
  return new GatewayError(404, 'BATCH_IMAGE_API_KEY_NOT_FOUND', 'An enabled Gemini API key was not found')
}
