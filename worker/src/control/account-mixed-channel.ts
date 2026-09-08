import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, readJsonObject, requireResourceId, requireString } from './http'

// Original admin_account.go checks platform, not credential type or enabled state.
const channel = (value: string): string => {
  const normalized = value.trim().toLowerCase()
  return normalized === 'antigravity' ? 'Antigravity' : ['anthropic', 'claude'].includes(normalized) ? 'Anthropic' : ''
}
export async function checkAdminAccountMixedChannel(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw, 32 * 1024)
    const platform = channel(requireString(body, 'platform', 64))
    if (!Array.isArray(body.group_ids) || body.group_ids.length > 1000) {
      throw new GatewayError(400, 'invalid_group_ids', 'group_ids must be an array of at most 1000 IDs')
    }
    const groups = [...new Set(body.group_ids.map(id => requireResourceId(typeof id === 'number' ? String(id) : id, 'group')))]
    const accountId = body.account_id === undefined || body.account_id === null || body.account_id === 0
      ? '' : requireResourceId(String(body.account_id), 'account')
    if (!platform || !groups.length) return controlSuccess({ has_risk: false })
    const other = platform === 'Anthropic' ? 'Antigravity' : 'Anthropic'
    const row = await context.env.DB.prepare(`SELECT g.id group_id, g.name group_name
      FROM json_each(?) selected JOIN account_groups ag ON ag.group_id = selected.value
      JOIN accounts a ON a.id = ag.account_id JOIN "groups" g ON g.id = ag.group_id
      WHERE a.id <> ? AND lower(trim(a.platform)) IN (?, ?)
      ORDER BY CAST(selected.key AS INTEGER), a.id LIMIT 1`)
      .bind(JSON.stringify(groups), accountId, other.toLowerCase(), other === 'Anthropic' ? 'claude' : 'antigravity')
      .first<{ group_id: string; group_name: string }>()
    if (!row) return controlSuccess({ has_risk: false })
    return controlSuccess({ has_risk: true, error: 'mixed_channel_warning',
      message: `mixed_channel_warning: Group '${row.group_name}' contains both ${platform} and ${other} accounts. Using mixed channels in the same context may cause thinking block signature validation issues, which will fallback to non-thinking mode for historical messages.`,
      details: { ...row, current_platform: platform, other_platform: other } })
  } catch (error) { return controlError(asGatewayError(error)) }
}
