import type { Env } from '../env'

const DAY_MS = 86_400_000
const BACKFILL_WINDOW_MS = 100 * DAY_MS
const BACKFILL_EVENT_LIMIT = 20
const BACKFILL_DAILY_WRITE_CAP = 12_000
const RETENTION_LIMIT = 10
const RETENTION_BACKFILL_DAILY_WRITE_CAP = 3_000
const RETENTION_COMPLETE_DAILY_WRITE_CAP = 12_000

interface MaintenanceRow {
  migration_started_at_ms: number
  legacy_write_grace_until_ms: number
  discovery_cursor: string
  active_account_id: string | null
  backfill_complete: number
  backfill_budget_day: number
  backfill_writes_used: number
  retention_budget_day: number
  retention_writes_used: number
}

interface ProgressRow {
  account_id: string
  cutoff_ms: number
  cursor_occurred_at_ms: number
  cursor_event_id: string
  status: 'active' | 'complete'
}

interface PendingRollupRow { event_id: string; occurred_at_ms: number }

export interface AccountStatsRollupRecoveryResult { selected: number }

/**
 * Advances one persistent per-account cursor. Historical facts are never
 * rewritten: the cursor is the exactly-once boundary and its CAS guards the
 * rollup UPSERT in the same D1 batch. During recovery, 12k backfill plus 3k
 * retention logical rows cost under roughly 50k structure writes/day: each
 * rollup row touches its table, primary key, and retention index, with cursor
 * and budget writes charged conservatively. Once recovery is globally complete,
 * retention may catch up at 12k logical rows/day (about 36k rollup structures,
 * plus bounded maintenance writes). A 24-hour grace catches version-zero events
 * emitted by an old Queue consumer during a rolling deployment.
 */
export async function recoverAccountStatsRollups(
  env: Pick<Env, 'DB'>,
  options: { nowMs?: number; limit?: number } = {},
): Promise<AccountStatsRollupRecoveryResult> {
  const nowMs = options.nowMs ?? Date.now()
  const budgetDay = Math.floor(nowMs / DAY_MS)
  let maintenance = await requireMaintenance(env)
  if (maintenance.backfill_budget_day !== budgetDay || maintenance.retention_budget_day !== budgetDay) {
    await env.DB.prepare(
      `UPDATE account_stats_rollup_maintenance SET
         backfill_budget_day = ?,
         backfill_writes_used = CASE WHEN backfill_budget_day = ? THEN backfill_writes_used ELSE 0 END,
         retention_budget_day = ?,
         retention_writes_used = CASE WHEN retention_budget_day = ? THEN retention_writes_used ELSE 0 END,
         updated_at_ms = ? WHERE id = 'global'`,
    ).bind(budgetDay, budgetDay, budgetDay, budgetDay, nowMs).run()
    maintenance = await requireMaintenance(env)
  }

  let progress = maintenance.active_account_id === null
    ? null
    : await findProgress(env, maintenance.active_account_id)
  if (
    progress === null && maintenance.backfill_complete === 0 &&
    nowMs >= maintenance.legacy_write_grace_until_ms &&
    maintenance.backfill_writes_used + 2 <= BACKFILL_DAILY_WRITE_CAP
  ) {
    const account = await env.DB.prepare(
      `SELECT id FROM accounts
        WHERE created_at_ms <= ? AND id > ? ORDER BY id LIMIT 1`,
    ).bind(maintenance.legacy_write_grace_until_ms, maintenance.discovery_cursor).first<{ id: string }>()
    if (account !== null) {
      const cutoffMs = Math.max(0, maintenance.legacy_write_grace_until_ms - BACKFILL_WINDOW_MS)
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO account_stats_rollup_progress (
             account_id, cutoff_ms, cursor_occurred_at_ms, cursor_event_id, status, updated_at_ms
           ) VALUES (?, ?, ?, ?, 'active', ?)`,
        ).bind(account.id, cutoffMs, maintenance.legacy_write_grace_until_ms, '\uffff', nowMs),
        env.DB.prepare(
          `UPDATE account_stats_rollup_maintenance
              SET active_account_id = ?, backfill_writes_used = backfill_writes_used + 2,
                  updated_at_ms = ?
            WHERE id = 'global' AND active_account_id IS NULL
              AND backfill_writes_used + 2 <= ?`,
        ).bind(account.id, nowMs, BACKFILL_DAILY_WRITE_CAP),
      ])
      maintenance = await requireMaintenance(env)
      progress = maintenance.active_account_id === account.id ? await findProgress(env, account.id) : null
    } else {
      await env.DB.prepare(
        `UPDATE account_stats_rollup_maintenance
            SET backfill_complete = 1, updated_at_ms = ?
          WHERE id = 'global' AND active_account_id IS NULL
            AND discovery_cursor = ? AND backfill_complete = 0`,
      ).bind(nowMs, maintenance.discovery_cursor).run()
      maintenance = await requireMaintenance(env)
    }
  }

  let selected = 0
  const requestedLimit = Math.min(
    BACKFILL_EVENT_LIMIT,
    Math.max(0, Math.trunc(options.limit ?? BACKFILL_EVENT_LIMIT)),
    Math.max(0, BACKFILL_DAILY_WRITE_CAP - maintenance.backfill_writes_used - 1),
  )
  if (
    progress !== null && progress.status === 'active' &&
    nowMs >= maintenance.legacy_write_grace_until_ms && requestedLimit > 0
  ) {
    const pending = (await env.DB.prepare(
      `SELECT event_id, occurred_at_ms
         FROM usage_projection INDEXED BY idx_usage_projection_account_time
        WHERE account_id = ? AND account_stats_rollup_version = 0
          AND occurred_at_ms >= ?
          AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND event_id < ?))
        ORDER BY occurred_at_ms DESC, event_id DESC LIMIT ?`,
    ).bind(
      progress.account_id, progress.cutoff_ms,
      progress.cursor_occurred_at_ms, progress.cursor_occurred_at_ms,
      progress.cursor_event_id, requestedLimit,
    ).all<PendingRollupRow>()).results
    selected = pending.length
    if (pending.length === 0) await completeAccount(env, progress, maintenance, nowMs)
    else await advanceAccount(env, progress, pending, maintenance, nowMs)
  }

  await retainRollups(env, maintenance, budgetDay, nowMs)
  return { selected }
}

async function advanceAccount(
  env: Pick<Env, 'DB'>,
  progress: ProgressRow,
  pending: PendingRollupRow[],
  maintenance: MaintenanceRow,
  nowMs: number,
): Promise<void> {
  const last = pending.at(-1)!
  const eventIds = JSON.stringify(pending.map((row) => row.event_id))
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO account_usage_15m_rollup (
         account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint,
         requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
         standard_cost_micros, account_cost_micros, user_cost_micros,
         duration_total_ms, duration_count
       )
       SELECT usage.account_id, usage.occurred_at_ms - (usage.occurred_at_ms % 900000),
              usage.model, COALESCE(usage.inbound_endpoint, ''), COALESCE(usage.upstream_endpoint, ''),
              COUNT(*), SUM(usage.input_tokens), SUM(usage.output_tokens), SUM(usage.cache_read_tokens), SUM(usage.cache_write_tokens), SUM(usage.cache_write_5m_tokens), SUM(usage.cache_write_1h_tokens),
              SUM(COALESCE(usage.standard_cost_micros, usage.amount_micros)),
              SUM(COALESCE(usage.account_cost_micros, usage.account_stats_cost_micros,
                usage.standard_cost_micros, usage.amount_micros)),
              SUM(usage.amount_micros), SUM(COALESCE(usage.duration_ms, 0)), COUNT(*)
         FROM usage_projection usage
         JOIN account_stats_rollup_progress progress ON progress.account_id = usage.account_id
        WHERE usage.event_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND usage.account_stats_rollup_version = 0 AND progress.status = 'active'
          AND progress.cursor_occurred_at_ms = ? AND progress.cursor_event_id = ?
        GROUP BY usage.account_id, usage.occurred_at_ms - (usage.occurred_at_ms % 900000),
                 usage.model, COALESCE(usage.inbound_endpoint, ''), COALESCE(usage.upstream_endpoint, '')
       ON CONFLICT (account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint)
       DO UPDATE SET
         requests = account_usage_15m_rollup.requests + excluded.requests,
         input_tokens = account_usage_15m_rollup.input_tokens + excluded.input_tokens,
         output_tokens = account_usage_15m_rollup.output_tokens + excluded.output_tokens,
         cache_read_tokens = account_usage_15m_rollup.cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = account_usage_15m_rollup.cache_write_tokens + excluded.cache_write_tokens,
         cache_write_5m_tokens = account_usage_15m_rollup.cache_write_5m_tokens + excluded.cache_write_5m_tokens,
         cache_write_1h_tokens = account_usage_15m_rollup.cache_write_1h_tokens + excluded.cache_write_1h_tokens,
         standard_cost_micros = account_usage_15m_rollup.standard_cost_micros + excluded.standard_cost_micros,
         account_cost_micros = account_usage_15m_rollup.account_cost_micros + excluded.account_cost_micros,
         user_cost_micros = account_usage_15m_rollup.user_cost_micros + excluded.user_cost_micros,
         duration_total_ms = account_usage_15m_rollup.duration_total_ms + excluded.duration_total_ms,
         duration_count = account_usage_15m_rollup.duration_count + excluded.duration_count`,
    ).bind(eventIds, progress.cursor_occurred_at_ms, progress.cursor_event_id),
    env.DB.prepare(
      `UPDATE account_stats_rollup_progress
          SET cursor_occurred_at_ms = ?, cursor_event_id = ?, updated_at_ms = ?
        WHERE account_id = ? AND status = 'active'
          AND cursor_occurred_at_ms = ? AND cursor_event_id = ?`,
    ).bind(
      last.occurred_at_ms, last.event_id, nowMs, progress.account_id,
      progress.cursor_occurred_at_ms, progress.cursor_event_id,
    ),
    env.DB.prepare(
      `UPDATE account_stats_rollup_maintenance
          SET backfill_writes_used = MIN(?, backfill_writes_used + ?), updated_at_ms = ?
        WHERE id = 'global' AND backfill_budget_day = ?`,
    ).bind(BACKFILL_DAILY_WRITE_CAP, pending.length + 1, nowMs, maintenance.backfill_budget_day),
  ])
}

async function completeAccount(
  env: Pick<Env, 'DB'>,
  progress: ProgressRow,
  maintenance: MaintenanceRow,
  nowMs: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_stats_rollup_progress SET status = 'complete', updated_at_ms = ?
        WHERE account_id = ? AND status = 'active'
          AND cursor_occurred_at_ms = ? AND cursor_event_id = ?`,
    ).bind(nowMs, progress.account_id, progress.cursor_occurred_at_ms, progress.cursor_event_id),
    env.DB.prepare(
      `UPDATE account_stats_rollup_maintenance
          SET active_account_id = NULL, discovery_cursor = ?,
              backfill_writes_used = MIN(?, backfill_writes_used + 2), updated_at_ms = ?
        WHERE id = 'global' AND active_account_id = ? AND backfill_budget_day = ?`,
    ).bind(
      progress.account_id, BACKFILL_DAILY_WRITE_CAP, nowMs,
      progress.account_id, maintenance.backfill_budget_day,
    ),
  ])
}

async function retainRollups(
  env: Pick<Env, 'DB'>,
  maintenance: MaintenanceRow,
  budgetDay: number,
  nowMs: number,
): Promise<void> {
  const dailyCap = maintenance.backfill_complete === 1
    ? RETENTION_COMPLETE_DAILY_WRITE_CAP
    : RETENTION_BACKFILL_DAILY_WRITE_CAP
  const limit = Math.min(RETENTION_LIMIT, Math.max(0, dailyCap - maintenance.retention_writes_used))
  if (limit === 0) return
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM account_usage_15m_rollup WHERE rowid IN (
         SELECT rowid FROM account_usage_15m_rollup
          WHERE bucket_start_ms < ? ORDER BY bucket_start_ms, account_id LIMIT ?
       )`,
    ).bind(Math.max(0, nowMs - BACKFILL_WINDOW_MS), limit),
    env.DB.prepare(
      `UPDATE account_stats_rollup_maintenance
          SET retention_writes_used = MIN(?, retention_writes_used + ?), updated_at_ms = ?
        WHERE id = 'global' AND retention_budget_day = ?`,
    ).bind(dailyCap, limit, nowMs, budgetDay),
  ])
}

async function requireMaintenance(env: Pick<Env, 'DB'>): Promise<MaintenanceRow> {
  const row = await env.DB.prepare(
    `SELECT migration_started_at_ms, legacy_write_grace_until_ms,
            discovery_cursor, active_account_id, backfill_complete,
            backfill_budget_day, backfill_writes_used, retention_budget_day, retention_writes_used
       FROM account_stats_rollup_maintenance WHERE id = 'global'`,
  ).first<MaintenanceRow>()
  if (row === null) throw new Error('Account statistics rollup maintenance state is missing')
  return row
}

async function findProgress(env: Pick<Env, 'DB'>, accountId: string): Promise<ProgressRow | null> {
  return env.DB.prepare(
    `SELECT account_id, cutoff_ms, cursor_occurred_at_ms, cursor_event_id, status
       FROM account_stats_rollup_progress WHERE account_id = ?`,
  ).bind(accountId).first<ProgressRow>()
}
