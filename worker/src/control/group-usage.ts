import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { calendarDayBoundaries } from '../gateway/info'
import { controlError, controlSuccess } from './http'

interface SummaryRow {
  group_id: string
  today_micros: number
  yesterday_micros: number
  total_micros: number
}

export async function getAdminGroupUsageSummary(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { today, yesterday } = calendarDayBoundaries(
      Date.now(), context.env.GROUP_USAGE_TIMEZONE ?? 'Asia/Shanghai',
    )
    // amount_micros is the settled customer charge (legacy actual_cost), not
    // the provider account cost or pre-discount standard cost. All stored
    // history contributes to cumulative usage, including inactive groups.
    const rows = await context.env.DB.prepare(`
      SELECT g.id AS group_id,
        COALESCE(SUM(CASE WHEN u.occurred_at_ms >= ? THEN u.amount_micros ELSE 0 END), 0) AS today_micros,
        COALESCE(SUM(CASE WHEN u.occurred_at_ms >= ? AND u.occurred_at_ms < ?
          THEN u.amount_micros ELSE 0 END), 0) AS yesterday_micros,
        COALESCE(SUM(u.amount_micros), 0) AS total_micros
      FROM "groups" g LEFT JOIN usage_projection u ON u.group_id = g.id
      GROUP BY g.id ORDER BY g.id
    `).bind(today, yesterday, today).all<SummaryRow>()
    return controlSuccess(rows.results.map(row => ({
      group_id: row.group_id,
      today_cost: usd(row.today_micros),
      yesterday_cost: usd(row.yesterday_micros),
      total_cost: usd(row.total_micros),
    })))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function usd(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new GatewayError(500, 'invalid_usage_total', 'Usage total exceeds exact integer precision', 'server_error')
  }
  return micros / 1_000_000
}
