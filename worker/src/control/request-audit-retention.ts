import type { Env } from '../env'

const DAY_MS = 86_400_000
export const ADMIN_REQUEST_AUDIT_RETENTION_BATCH = 500

export interface AdminRequestAuditRetentionResult {
  retention_days: number
  cutoff_ms: number | null
  deleted: number
  has_more: boolean
}

/**
 * Cron seam: deletes one bounded oldest-first page from the isolated HTTP
 * request log. A zero-day policy means permanent retention. The newest clear
 * trace remains as the durable explanation for the most recent explicit clear.
 */
export async function runAdminRequestAuditRetention(
  env: Pick<Env, 'DB'>,
  nowMs = Date.now(),
): Promise<AdminRequestAuditRetentionResult> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('invalid admin request audit retention time')
  }
  const setting = await env.DB.prepare(
    "SELECT audit_log_retention_days FROM system_settings WHERE id = 'global'",
  ).first<{ audit_log_retention_days: number }>()
  const retentionDays = setting?.audit_log_retention_days
  if (
    typeof retentionDays !== 'number'
    || !Number.isSafeInteger(retentionDays)
    || retentionDays < 0
    || retentionDays > 3650
  ) {
    throw new Error('invalid admin request audit retention setting')
  }
  if (retentionDays === 0) {
    return { retention_days: 0, cutoff_ms: null, deleted: 0, has_more: false }
  }

  const cutoffMs = Math.max(0, nowMs - retentionDays * DAY_MS)
  const result = await env.DB.prepare(
    `DELETE FROM admin_request_audit_logs
      WHERE id IN (
        SELECT candidate.id
          FROM admin_request_audit_logs AS candidate
         WHERE candidate.created_at_ms < ?
           AND candidate.id <> COALESCE((
             SELECT trace.id
               FROM admin_request_audit_logs AS trace
              WHERE trace.action = 'POST /api/v1/admin/audit-logs/clear'
                AND json_extract(trace.extra_json, '$.kind') = 'clear_trace'
              ORDER BY trace.created_at_ms DESC, trace.id DESC
              LIMIT 1
           ), -1)
         ORDER BY candidate.created_at_ms ASC, candidate.id ASC
         LIMIT ?
      )
     RETURNING id`,
  ).bind(cutoffMs, ADMIN_REQUEST_AUDIT_RETENTION_BATCH).all<{ id: number }>()
  return {
    retention_days: retentionDays,
    cutoff_ms: cutoffMs,
    deleted: result.results.length,
    has_more: result.results.length === ADMIN_REQUEST_AUDIT_RETENTION_BATCH,
  }
}
