import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'

export interface UpstreamBillingConfig { enabled: boolean; interval_minutes: number }
const NAME = 'upstream-billing-probe'
export function parseUpstreamBillingConfig(value: unknown): UpstreamBillingConfig {
  const v = value as UpstreamBillingConfig
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['enabled', 'interval_minutes'].includes(k)) ||
      typeof v.enabled !== 'boolean' || !Number.isSafeInteger(v.interval_minutes) || v.interval_minutes < 5 || v.interval_minutes > 1440) {
    throw new GatewayError(400, 'invalid_billing_probe_settings', 'Billing probe interval must be between 5 and 1440 minutes')
  }
  return { enabled: v.enabled, interval_minutes: v.interval_minutes }
}
export async function readUpstreamBillingConfig(env: Env): Promise<UpstreamBillingConfig> {
  const row = await env.DB.prepare('SELECT value_json FROM runtime_settings WHERE name=?').bind(NAME).first<{ value_json: string }>()
  return row ? parseUpstreamBillingConfig(JSON.parse(row.value_json)) : { enabled: true, interval_minutes: 30 }
}
export async function saveUpstreamBillingConfig(env: Env, input: unknown, actorId: string | null = null): Promise<UpstreamBillingConfig> {
  const config = parseUpstreamBillingConfig(input)
  const old = await env.DB.prepare('SELECT control_version FROM runtime_settings WHERE name=?').bind(NAME).first<{ control_version: number }>()
  const result = await env.DB.prepare(`INSERT INTO runtime_settings(name,value_json,control_version,updated_by,updated_at_ms)
    VALUES(?,?,1,?,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,
    control_version=runtime_settings.control_version+1,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms
    WHERE runtime_settings.control_version=? RETURNING control_version`)
    .bind(NAME, JSON.stringify(config), actorId, Date.now(), old?.control_version ?? 0).first()
  if (!result) throw new GatewayError(409, 'settings_conflict', 'Billing probe settings changed; reload and retry')
  return config
}
