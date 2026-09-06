import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError } from '../gateway/errors'
import { poolStateName } from '../gateway/state-client'
import { controlError, controlSuccess } from './http'

type Endpoint = 'chat_completions' | 'responses' | 'embeddings' | 'images'
interface PoolRow { group_id: string; model_id: string; endpoint: Endpoint }
interface AccountRow { group_id: string; max_concurrency: number }
interface Snapshot { accounts?: Array<{ account_id?: string; active_leases?: number }> }

export async function getAdminGroupCapacitySummary(context: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    // One D1 batch discovers every active group's configured account ceiling and
    // only the DOs already made real by gateway routing; it never scans rows per group.
    const [accountsResult, poolsResult] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT ag.group_id, a.max_concurrency
        FROM account_groups ag JOIN accounts a ON a.id = ag.account_id
        JOIN "groups" g ON g.id = ag.group_id
        WHERE g.enabled = 1 AND a.enabled = 1 AND a.health_status <> 'unhealthy'`),
      context.env.DB.prepare(`SELECT r.group_id, r.model_id, r.endpoint
        FROM pool_state_registry r JOIN "groups" g ON g.id = r.group_id WHERE g.enabled = 1`),
    ])
    const totals = new Map<string, number>()
    for (const row of accountsResult.results as unknown as AccountRow[]) {
      totals.set(row.group_id, (totals.get(row.group_id) ?? 0) + row.max_concurrency)
    }
    const pools = poolsResult.results as unknown as PoolRow[]
    const used = new Map<string, number>()
    const failed = new Set<string>()
    await boundedMap(pools, 16, async (pool) => {
      try {
        const stub = context.env.POOL_STATE.get(context.env.POOL_STATE.idFromName(
          poolStateName(pool.group_id, pool.model_id, pool.endpoint),
        ))
        const response = await stub.fetch('https://state.internal/snapshot')
        if (!response.ok) throw new Error('snapshot failed')
        const body = await response.json() as Snapshot
        if (!Array.isArray(body.accounts)) throw new Error('invalid snapshot')
        const count = body.accounts.reduce((sum, account) => {
          if (!Number.isSafeInteger(account.active_leases) || (account.active_leases ?? 0) < 0) throw new Error('invalid count')
          return sum + account.active_leases!
        }, 0)
        used.set(pool.group_id, (used.get(pool.group_id) ?? 0) + count)
      } catch { failed.add(pool.group_id) }
    })
    const groupIds = [...new Set([...totals.keys(), ...pools.map(pool => pool.group_id)])].sort()
    return controlSuccess(groupIds.map(group_id => ({
      group_id,
      concurrency_status: failed.has(group_id) ? 'unknown' : 'known',
      concurrency_used: failed.has(group_id) ? null : (used.get(group_id) ?? 0),
      concurrency_max: totals.get(group_id) ?? 0,
      // Worker has no recoverable global session/RPM state. Do not turn absent
      // Redis-era values into false zeroes; clients receive an explicit state.
      sessions_status: 'unknown', sessions_used: null, sessions_max: null,
      rpm_status: 'unknown', rpm_used: null, rpm_max: null,
    })))
  } catch (error) { return controlError(asGatewayError(error)) }
}

async function boundedMap<T>(items: T[], limit: number, visit: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await visit(items[next++]!)
  }))
}
