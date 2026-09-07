import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, readJsonObject, requireExpectedControlVersion } from './http'

export interface NotificationSettings {
  balance_low_notify_enabled: boolean
  balance_low_notify_threshold: number
  balance_low_notify_recharge_url: string
  subscription_expiry_notify_enabled: boolean
  account_quota_notify_enabled: boolean
  account_quota_notify_emails: Array<{ email: string; disabled: boolean; verified: boolean }>
}
export const NOTIFICATION_DEFAULTS: NotificationSettings = {
  balance_low_notify_enabled: false, balance_low_notify_threshold: 0, balance_low_notify_recharge_url: '',
  subscription_expiry_notify_enabled: false, account_quota_notify_enabled: false, account_quota_notify_emails: [],
}
export async function readNotificationSettings(env: Pick<Env, 'DB'>): Promise<NotificationSettings & { control_version: number }> {
  const row = await env.DB.prepare("SELECT config_json,control_version FROM system_notification_settings WHERE id='global'").first<{ config_json: string; control_version: number }>()
  return { ...NOTIFICATION_DEFAULTS, ...(row ? JSON.parse(row.config_json) : {}), control_version: row?.control_version ?? 0 }
}
export async function getNotificationSettings(c: Context<{ Bindings: Env }>): Promise<Response> {
  try { return controlSuccess(await readNotificationSettings(c.env)) } catch (error) { return controlError(asGatewayError(error)) }
}
export async function updateNotificationSettings(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await readJsonObject(c.req.raw, 16384)
    const expected = requireExpectedControlVersion(c.req.raw, body)
    const { control_version: _, ...current } = await readNotificationSettings(c.env)
    const next = { ...current }
    for (const field of ['balance_low_notify_enabled', 'subscription_expiry_notify_enabled', 'account_quota_notify_enabled'] as const) {
      if (body[field] === undefined) continue
      if (typeof body[field] !== 'boolean') throw new GatewayError(400, `invalid_${field}`, `${field} must be boolean`)
      next[field] = body[field]
    }
    if (body.balance_low_notify_threshold !== undefined) {
      const value = body.balance_low_notify_threshold
      if (typeof value !== 'number' || value < 0 || !Number.isSafeInteger(Math.round(value * 1000000)) || Math.abs(value * 1000000 - Math.round(value * 1000000)) > 0.00001) throw new GatewayError(400, 'invalid_balance_low_notify_threshold', 'Threshold must be a non-negative amount with at most six decimals')
      next.balance_low_notify_threshold = value
    }
    if (body.balance_low_notify_recharge_url !== undefined) {
      const value = body.balance_low_notify_recharge_url
      if (typeof value !== 'string' || value.length > 2048 || (value && !/^https?:\/\/[^\s]+$/.test(value))) throw new GatewayError(400, 'invalid_recharge_url', 'Recharge URL must use HTTP or HTTPS')
      next.balance_low_notify_recharge_url = value
    }
    if (body.account_quota_notify_emails !== undefined) {
      const entries = body.account_quota_notify_emails
      if (!Array.isArray(entries) || entries.length > 20) throw new GatewayError(400, 'invalid_notify_emails', 'At most 20 notification recipients are allowed')
      next.account_quota_notify_emails = entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(entry.email) || typeof entry.disabled !== 'boolean' || typeof entry.verified !== 'boolean') throw new GatewayError(400, 'invalid_notify_emails', 'Notification recipient is invalid')
        return { email: entry.email.trim().toLowerCase(), disabled: entry.disabled, verified: entry.verified }
      })
    }
    const result = await c.env.DB.prepare(`INSERT INTO system_notification_settings(id,config_json,control_version,updated_at_ms)
      SELECT 'global',?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM system_notification_settings WHERE id='global')
      ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,control_version=system_notification_settings.control_version+1,updated_at_ms=excluded.updated_at_ms
      WHERE system_notification_settings.control_version=?`).bind(JSON.stringify(next), Date.now(), expected, expected).run()
    if (!result.meta.changes) throw new GatewayError(412, 'control_version_conflict', 'Notification settings changed; reload before saving')
    return controlSuccess(await readNotificationSettings(c.env))
  } catch (error) { return controlError(asGatewayError(error)) }
}
