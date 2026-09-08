import { readUpstreamBillingConfig, saveUpstreamBillingConfig } from './upstream-billing-config'
import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, readJsonObject } from './http'
import { probeUpstreamBilling } from './upstream-billing-probe'

export async function readUpstreamBillingSettings(env: Env): Promise<{ enabled: boolean; interval_minutes: number }> {
  return readUpstreamBillingConfig(env)
}

export async function getAdminUpstreamBillingSettings(context: Context<{ Bindings: Env }>): Promise<Response> {
  try { return controlSuccess(await readUpstreamBillingSettings(context.env)) }
  catch (error) { return controlError(asGatewayError(error)) }
}

export async function updateAdminUpstreamBillingSettings(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    return controlSuccess(await saveUpstreamBillingConfig(context.env, await readJsonObject(context.req.raw, 4096)))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function runDueUpstreamBillingProbes(env: Env, now = Date.now()): Promise<number> {
  const config = await readUpstreamBillingConfig(env)
  if (!config.enabled) return 0
  const token = crypto.randomUUID()
  const claimed = await env.DB.prepare(`UPDATE upstream_billing_probe_settings SET lease_token=?,lease_expires_at_ms=?
    WHERE id='global' AND lease_expires_at_ms<=? RETURNING interval_minutes`)
    .bind(token, now + 120000, now).first<{ interval_minutes: number }>()
  if (!claimed) return 0
  let completed = 0
  let failures = 0
  try {
    const due = await env.DB.prepare(`SELECT id FROM accounts WHERE enabled=1 AND credential_kind='api_key'
      AND platform IN ('openai','anthropic','gemini','antigravity','grok','kimi','zhipu','deepseek')
      AND json_extract(ui_config_json,'$.extra.upstream_billing_probe_enabled')=1
      AND COALESCE(unixepoch(json_extract(ui_config_json,'$.extra.upstream_billing_probe.next_probe_at')),0)*1000<=?
      ORDER BY COALESCE(unixepoch(json_extract(ui_config_json,'$.extra.upstream_billing_probe.next_probe_at')),0),id LIMIT 20`)
      .bind(now).all<{ id: string }>()
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, due.results.length) }, async () => {
      for (;;) {
        const row = due.results[next++]
        if (!row) return
        try { await probeUpstreamBilling(env, row.id, config.interval_minutes, true); completed++ }
        catch (error) {
          // Concurrent edits/deletions are expected; storage failures must reach
          // scheduled recovery logging after all active work has drained.
          if (!(error instanceof GatewayError && ['account_not_found', 'UPSTREAM_BILLING_PROBE_NOT_DUE', 'UPSTREAM_BILLING_PROBE_IDENTITY_CHANGED'].includes(error.code))) failures++
        }
      }
    }))
    if (failures) throw new Error(`Upstream billing scan failed for ${failures} accounts`)
  } finally {
    await env.DB.prepare("UPDATE upstream_billing_probe_settings SET lease_token=NULL,lease_expires_at_ms=0 WHERE id='global' AND lease_token=?").bind(token).run()
  }
  return completed
}
