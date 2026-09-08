import { readUpstreamBillingSettings } from './upstream-billing-settings'
import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, readJsonObject, requireResourceId } from './http'
import { probeUpstreamBilling, probeAccounts } from './upstream-billing-probe'

// Original upstream_billing_probe.go: IsUpstreamBillingProbeIdentity.
const PLATFORMS = new Set(['openai', 'anthropic', 'gemini', 'antigravity', 'grok', 'kimi', 'zhipu', 'deepseek'])

export async function probeAdminAccountsUpstreamBilling(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw, 16384)
    if (!Array.isArray(body.account_ids) || body.account_ids.length < 1 || body.account_ids.length > 20) {
      throw new GatewayError(400, 'invalid_body', 'account_ids must contain between 1 and 20 items')
    }
    const ids = [...new Set(body.account_ids.map(value => {
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
        throw new GatewayError(400, 'invalid_body', 'account_ids must contain valid account IDs')
      }
      return requireResourceId(String(value), 'account')
    }))]
    const settings = await readUpstreamBillingSettings(context.env)
    const results = await probeAccounts(context.env, ids, settings)
    return controlSuccess({ results })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function probeAdminAccountUpstreamBilling(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'account')
    const settings = await readUpstreamBillingSettings(context.env)
    return controlSuccess({ account_id: id, snapshot: await probeUpstreamBilling(context.env, id, settings.interval_minutes) })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function setAdminAccountUpstreamBillingProbeEnabled(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'account')
    const body = await readJsonObject(context.req.raw, 4096)
    if (typeof body.enabled !== 'boolean') throw new GatewayError(400, 'invalid_body', 'enabled must be a boolean')
    const row = await context.env.DB.prepare('SELECT platform, credential_kind, control_version FROM accounts WHERE id=?')
      .bind(id).first<{ platform: string; credential_kind: string; control_version: number }>()
    if (!row) throw new GatewayError(404, 'account_not_found', 'Account was not found')
    if (row.credential_kind !== 'api_key' || !PLATFORMS.has(row.platform)) {
      throw new GatewayError(400, 'UPSTREAM_BILLING_PROBE_ACCOUNT_INVALID', 'Upstream billing probes require a supported API-key account')
    }
    const result = await context.env.DB.prepare(`UPDATE accounts SET ui_config_json=json_set(ui_config_json, '$.extra',
        CASE WHEN ?=1 THEN json_set(CASE WHEN json_type(ui_config_json,'$.extra')='object' THEN json_extract(ui_config_json,'$.extra') ELSE '{}' END,
          '$.upstream_billing_probe_enabled', json('true'))
        ELSE json_set(CASE WHEN json_type(ui_config_json,'$.extra')='object' THEN json_extract(ui_config_json,'$.extra') ELSE '{}' END,
          '$.upstream_billing_probe_enabled', json('false'), '$.upstream_billing_rate_sync_enabled', json('false')) END),
        config_version=config_version+1, control_version=control_version+1, updated_at_ms=?
      WHERE id=? AND control_version=? RETURNING id`)
      .bind(body.enabled ? 1 : 0, Date.now(), id, row.control_version).first<{ id: string }>()
    if (result?.id !== id) throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload and retry')
    return controlSuccess({ account_id: id, enabled: body.enabled })
  } catch (error) { return controlError(asGatewayError(error)) }
}
