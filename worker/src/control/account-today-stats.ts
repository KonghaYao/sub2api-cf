import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { calendarDayBoundaries } from '../gateway/info'
import { controlError, controlSuccess, readJsonObject, requireResourceId } from './http'

type Bindings = { Bindings: Env }
interface StatsRow {
  account_id: string
  requests: number
  tokens: number
  account_cost_micros: number
  standard_cost_micros: number
  user_cost_micros: number
}

/** Today's retained settlement projection is shared by single and batch reads.
 * Do not add the 15-minute rollup: the same events already exist in this source.
 */
async function todayStats(env: Env, ids: string[]) {
  if (ids.length === 0) return {}
  const now = Date.now()
  const { today } = calendarDayBoundaries(now, env.GROUP_USAGE_TIMEZONE ?? 'Asia/Shanghai')
  const rows = await env.DB.prepare(`
    SELECT target.value AS account_id, COUNT(u.event_id) AS requests,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens,
      COALESCE(SUM(COALESCE(u.account_cost_micros, u.account_stats_cost_micros,
        u.standard_cost_micros, u.amount_micros)), 0) AS account_cost_micros,
      COALESCE(SUM(COALESCE(u.standard_cost_micros, u.amount_micros)), 0) AS standard_cost_micros,
      COALESCE(SUM(u.amount_micros), 0) AS user_cost_micros
    FROM json_each(?) target
    LEFT JOIN usage_projection u ON u.account_id = target.value
      AND u.occurred_at_ms >= ? AND u.occurred_at_ms <= ?
    GROUP BY target.value
  `).bind(JSON.stringify(ids), today, now).all<StatsRow>()
  return Object.fromEntries(rows.results.map(row => {
    for (const field of ['requests', 'tokens', 'account_cost_micros', 'standard_cost_micros', 'user_cost_micros'] as const) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 0) {
        throw new GatewayError(500, 'invalid_account_stats_projection', 'Account statistics exceed exact integer precision', 'server_error')
      }
    }
    return [row.account_id, {
      requests: row.requests, tokens: row.tokens, cost: row.account_cost_micros / 1_000_000,
      standard_cost: row.standard_cost_micros / 1_000_000, user_cost: row.user_cost_micros / 1_000_000,
    }]
  }))
}

export async function getAdminAccountTodayStats(context: Context<Bindings>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'account')
    const stats = await todayStats(context.env, [id])
    return controlSuccess(stats[id])
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function getAdminAccountsTodayStats(context: Context<Bindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw, 128 * 1024)
    if (Object.keys(body).some(key => key !== 'account_ids') || !Array.isArray(body.account_ids) || body.account_ids.length > 1000) {
      throw new GatewayError(400, 'invalid_account_ids', 'account_ids must contain at most 1000 account IDs')
    }
    const ids = [...new Set(body.account_ids.map(id => requireResourceId(
      typeof id === 'string' ? id
        : typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined, 'account',
    )))].sort()
    return controlSuccess({ stats: await todayStats(context.env, ids) })
  } catch (error) { return controlError(asGatewayError(error)) }
}
