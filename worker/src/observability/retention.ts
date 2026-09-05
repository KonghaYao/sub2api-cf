import { observabilityBucket } from './recorder'
import type { ObservabilityEnv } from './types'

const MAX_BATCH = 100

export interface RetentionResult {
  scanned: number
  deleted: number
  r2_failures: number
  has_more: boolean
}

/** Cron seam: removes at most 100 oldest metadata rows and their referenced R2 objects. */
export async function runObservabilityRetention(
  env: ObservabilityEnv,
  input: { beforeMs: number; limit?: number },
): Promise<RetentionResult> {
  const limit = boundedLimit(input.limit)
  if (!Number.isSafeInteger(input.beforeMs) || input.beforeMs < 0 || input.beforeMs > Date.now()) {
    throw new Error('invalid observability retention cutoff')
  }
  const result = await env.DB.prepare(
    `SELECT id, occurred_at_ms, payload_object_key
       FROM request_observations
      WHERE occurred_at_ms < ?
      ORDER BY occurred_at_ms ASC, id ASC LIMIT ?`,
  ).bind(input.beforeMs, limit + 1).all<{
    id: string
    occurred_at_ms: number
    payload_object_key: string | null
  }>()
  const rows = result.results.slice(0, limit)
  let deleted = 0
  let failures = 0
  for (const row of rows) {
    if (row.payload_object_key !== null) {
      try {
        await observabilityBucket(env).delete(row.payload_object_key)
      } catch {
        failures += 1
      }
    }
    const removed = await env.DB.prepare(
      'DELETE FROM request_observations WHERE id = ? AND occurred_at_ms = ? AND occurred_at_ms < ?',
    ).bind(row.id, row.occurred_at_ms, input.beforeMs).run()
    deleted += removed.meta.changes
  }
  return {
    scanned: rows.length,
    deleted,
    r2_failures: failures,
    has_more: result.results.length > limit,
  }
}

/**
 * Queue/Cron repair seam for the put-succeeded/update-failed window. It never
 * guesses that a missing object exists; Queue retains the only payload copy.
 */
export async function repairObservabilityPayloadMetadata(
  env: ObservabilityEnv,
  input: { nowMs?: number; limit?: number } = {},
): Promise<{ scanned: number; repaired: number }> {
  const now = input.nowMs ?? Date.now()
  const limit = boundedLimit(input.limit)
  const rows = await env.DB.prepare(
    `SELECT id, payload_object_key, payload_sha256, payload_attempts
       FROM request_observations
      WHERE payload_state IN ('pending', 'retry')
        AND (payload_retry_after_ms IS NULL OR payload_retry_after_ms <= ?)
      ORDER BY occurred_at_ms ASC, id ASC LIMIT ?`,
  ).bind(now, limit).all<{
    id: string
    payload_object_key: string
    payload_sha256: string
    payload_attempts: number
  }>()
  let repaired = 0
  for (const row of rows.results) {
    try {
      const head = await observabilityBucket(env).head(row.payload_object_key)
      if (head === null) {
        await deferPayloadRepair(env, row, now, 'R2 object is missing')
        continue
      }
      if (head.customMetadata?.sha256 !== row.payload_sha256) {
        await deferPayloadRepair(env, row, now, 'R2 object digest mismatch')
        continue
      }
      const result = await env.DB.prepare(
        `UPDATE request_observations
            SET payload_state = 'stored', payload_retry_after_ms = NULL,
                payload_lease_id = NULL, payload_lease_expires_at_ms = NULL,
                payload_last_error = NULL, updated_at_ms = ?
          WHERE id = ? AND payload_state IN ('pending', 'retry') AND payload_sha256 = ?`,
      ).bind(now, row.id, row.payload_sha256).run()
      repaired += result.meta.changes
    } catch (error) {
      await deferPayloadRepair(
        env,
        row,
        now,
        error instanceof Error ? error.message : 'R2 metadata read failed',
      )
    }
  }
  return { scanned: rows.results.length, repaired }
}

async function deferPayloadRepair(
  env: ObservabilityEnv,
  row: { id: string; payload_sha256: string; payload_attempts: number },
  now: number,
  message: string,
): Promise<void> {
  const nextAttempt = Math.min(20, row.payload_attempts + 1)
  const retryDelay = nextAttempt >= 20
    ? 86_400_000
    : Math.min(300_000, 1_000 * 2 ** Math.min(nextAttempt, 8))
  await env.DB.prepare(
    `UPDATE request_observations
        SET payload_attempts = ?, payload_retry_after_ms = ?, payload_last_error = ?,
            payload_lease_id = NULL, payload_lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE id = ? AND payload_state IN ('pending', 'retry') AND payload_sha256 = ?`,
  ).bind(
    nextAttempt,
    now + retryDelay,
    message.slice(0, 500),
    now,
    row.id,
    row.payload_sha256,
  ).run()
}

/** Deletes only old, unreferenced objects from one bounded R2 listing page. */
export async function cleanupObservabilityR2Orphans(
  env: ObservabilityEnv,
  input: { beforeMs: number; cursor?: string; limit?: number },
): Promise<{ scanned: number; deleted: number; cursor: string | null; truncated: boolean }> {
  const limit = boundedLimit(input.limit)
  if (!Number.isSafeInteger(input.beforeMs) || input.beforeMs < 0 || input.beforeMs > Date.now()) {
    throw new Error('invalid observability orphan cutoff')
  }
  const listed = await observabilityBucket(env).list({
    prefix: 'observability/v1/',
    limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  })
  let deleted = 0
  for (const object of listed.objects) {
    if (object.uploaded.getTime() >= input.beforeMs) continue
    const referenced = await env.DB.prepare(
      'SELECT 1 AS found FROM request_observations WHERE payload_object_key = ? LIMIT 1',
    ).bind(object.key).first<{ found: number }>()
    if (referenced !== null) continue
    try {
      await observabilityBucket(env).delete(object.key)
      deleted += 1
    } catch {
      // Retry on the next bounded scan; R2 deletion is idempotent.
    }
  }
  return {
    scanned: listed.objects.length,
    deleted,
    cursor: listed.truncated ? listed.cursor : null,
    truncated: listed.truncated,
  }
}

function boundedLimit(value: number | undefined): number {
  const result = value ?? 50
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_BATCH) {
    throw new Error('observability batch limit must be between 1 and 100')
  }
  return result
}
