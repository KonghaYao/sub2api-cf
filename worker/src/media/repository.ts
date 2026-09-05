import { deterministicUuid } from '../control/http'
import { sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'
import type { GatewayPrincipal } from '../gateway/types'
import { calculateMediaPricing, type MediaPricing } from './domain'
import type {
  MediaEnv,
  MediaManifest,
  MediaTaskItemRow,
  MediaTaskOutputRow,
  MediaTaskOwner,
  MediaTaskRow,
  MediaTaskStatus,
} from './types'

const TASK_COLUMNS = `id, user_id, api_key_id, group_id, parent_task_id, task_name,
  provider, model, upstream_model, image_size, response_mime_type, aspect_ratio, status,
  item_count, expected_output_count, success_count, fail_count, cancelled_count,
  base_unit_price_micros, price_id, effective_rate_multiplier_ppm,
  batch_discount_multiplier_ppm, hold_multiplier_ppm, billable_unit_price_micros,
  hold_unit_price_micros, estimated_cost_micros, hold_amount_micros,
  actual_cost_micros, billing_type, subscription_id, platform_quota_platform,
  billing_status, idempotency_key_hash, request_hash, input_object_key,
  enqueued_at_ms, provider_account_id, last_error_code, last_error_message,
  version, created_at_ms, updated_at_ms, submitted_at_ms, started_at_ms,
  finished_at_ms, settled_at_ms, downloaded_at_ms, output_deleted_at_ms,
  user_deleted_at_ms`

interface PricingRow {
  upstream_model: string
  price_id: string
  rate_multiplier_ppm: number
  image_rate_independent: number
  image_rate_multiplier_ppm: number
  batch_image_discount_multiplier_ppm: number
  batch_image_hold_multiplier_ppm: number
  image_price_1k_micros: number | null
  image_price_2k_micros: number | null
  image_price_4k_micros: number | null
}

export interface NewMediaTask {
  id: string
  principal: GatewayPrincipal
  manifest: MediaManifest
  pricing: MediaPricing
  expectedOutputCount: number
  idempotencyKeyHash: string
  requestHash: string
  inputObjectKey: string
  now: number
}

export async function resolveMediaPricing(
  env: MediaEnv,
  principal: GatewayPrincipal,
  requestedModel: string,
  imageSize: '1K' | '2K' | '4K',
  expectedOutputCount: number,
): Promise<MediaPricing> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(gm.upstream_name_override, model.upstream_name) AS upstream_model,
            price.id AS price_id,
            COALESCE(user_rate.rate_multiplier_ppm, group_row.rate_multiplier_ppm) AS rate_multiplier_ppm,
            group_row.image_rate_independent, group_row.image_rate_multiplier_ppm,
            group_row.batch_image_discount_multiplier_ppm,
            group_row.batch_image_hold_multiplier_ppm,
            group_row.image_price_1k_micros, group_row.image_price_2k_micros,
            group_row.image_price_4k_micros
       FROM "groups" AS group_row
       JOIN group_models AS gm ON gm.group_id = group_row.id AND gm.enabled = 1
       JOIN models AS model ON model.id = gm.model_id AND model.enabled = 1
       JOIN model_prices AS price
         ON price.group_id = gm.group_id AND price.model_id = gm.model_id AND price.active = 1
       LEFT JOIN user_group_rate_overrides AS user_rate
         ON user_rate.group_id = group_row.id AND user_rate.user_id = ?
      WHERE group_row.id = ? AND group_row.enabled = 1 AND group_row.platform = 'gemini'
        AND group_row.allow_image_generation = 1
        AND group_row.allow_batch_image_generation = 1
        AND model.platform = 'gemini' AND model.public_name = ?
      LIMIT 1`,
  ).bind(principal.user_id, principal.group_id, requestedModel).first<PricingRow>()
  if (row === null) {
    throw new GatewayError(403, 'BATCH_IMAGE_MODEL_UNAVAILABLE', 'Batch image model is not available for this API key')
  }
  const base = imageSize === '1K'
    ? row.image_price_1k_micros
    : imageSize === '2K'
      ? row.image_price_2k_micros
      : row.image_price_4k_micros
  if (!Number.isSafeInteger(base) || (base as number) < 0) {
    throw new GatewayError(409, 'BATCH_IMAGE_PRICING_MISSING', `Batch image ${imageSize} pricing is not configured`)
  }
  const effectiveRate = row.image_rate_independent === 1
    ? row.image_rate_multiplier_ppm
    : row.rate_multiplier_ppm
  return calculateMediaPricing(
    base as number,
    effectiveRate,
    row.batch_image_discount_multiplier_ppm,
    row.batch_image_hold_multiplier_ppm,
    expectedOutputCount,
    row.price_id,
    row.upstream_model,
  )
}

export async function listAvailableMediaModels(
  env: MediaEnv,
  groupId: string,
): Promise<Array<{ id: string; object: 'model'; provider: 'gemini_api' }>> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT model.public_name AS id
       FROM "groups" AS group_row
       JOIN group_models AS group_model
         ON group_model.group_id = group_row.id AND group_model.enabled = 1
       JOIN models AS model ON model.id = group_model.model_id AND model.enabled = 1
       JOIN model_prices AS price
         ON price.group_id = group_row.id AND price.model_id = model.id AND price.active = 1
      WHERE group_row.id = ? AND group_row.enabled = 1 AND group_row.platform = 'gemini'
        AND group_row.allow_image_generation = 1
        AND group_row.allow_batch_image_generation = 1
        AND model.platform = 'gemini'
        AND (
          group_row.image_price_1k_micros IS NOT NULL
          OR group_row.image_price_2k_micros IS NOT NULL
          OR group_row.image_price_4k_micros IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM account_groups
          JOIN accounts ON accounts.id = account_groups.account_id
          JOIN account_secrets
            ON account_secrets.account_id = accounts.id
           AND account_secrets.id = accounts.credential_ref
          JOIN account_models
            ON account_models.account_id = accounts.id AND account_models.model_id = model.id
          WHERE account_groups.group_id = group_row.id
            AND accounts.enabled = 1 AND accounts.platform = 'gemini'
            AND accounts.protocol = 'gemini' AND accounts.auth_scheme = 'x-goog-api-key'
            AND accounts.base_url IS NOT NULL AND trim(accounts.base_url) <> ''
            AND accounts.max_concurrency > 0 AND accounts.health_status <> 'unhealthy'
        )
      ORDER BY model.public_name`,
  ).bind(groupId).all<{ id: string }>()
  return result.results.map((row) => ({ id: row.id, object: 'model' as const, provider: 'gemini_api' as const }))
}

export async function createMediaTask(env: MediaEnv, input: NewMediaTask): Promise<void> {
  const billing = input.principal.billing
  const eventHash = await sha256Hex(`created\0${input.requestHash}`)
  const eventId = await deterministicUuid('media-task-event.v1', `${input.id}\0${eventHash}`)
  const itemHashes = await Promise.all(input.manifest.items.map((item) =>
    sha256Hex(JSON.stringify(item))))
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO media_tasks (
         id, user_id, api_key_id, group_id, parent_task_id, task_name,
         provider, model, upstream_model, image_size, response_mime_type, aspect_ratio,
         status, item_count, expected_output_count,
         base_unit_price_micros, price_id, effective_rate_multiplier_ppm,
         batch_discount_multiplier_ppm, hold_multiplier_ppm,
         billable_unit_price_micros, hold_unit_price_micros,
         estimated_cost_micros, hold_amount_micros,
         billing_type, subscription_id, platform_quota_platform,
         idempotency_key_hash, request_hash, input_object_key,
         created_at_ms, updated_at_ms
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    ).bind(
      input.id,
      input.principal.user_id,
      input.principal.api_key_id,
      input.principal.group_id,
      input.manifest.parent_batch_id,
      input.manifest.task_name,
      input.manifest.provider,
      input.manifest.model,
      input.manifest.upstream_model,
      input.manifest.image_size,
      input.manifest.response_mime_type,
      input.manifest.aspect_ratio,
      input.expectedOutputCount,
      input.expectedOutputCount,
      input.pricing.baseUnitPriceMicros,
      input.pricing.priceId,
      input.pricing.effectiveRateMultiplierPpm,
      input.pricing.batchDiscountMultiplierPpm,
      input.pricing.holdMultiplierPpm,
      input.pricing.billableUnitPriceMicros,
      input.pricing.holdUnitPriceMicros,
      input.pricing.estimatedCostMicros,
      input.pricing.holdAmountMicros,
      billing.type,
      billing.type === 'subscription' ? billing.subscription_id : null,
      input.principal.billing.type === 'balance'
        ? input.principal.platform_quota?.platform ?? null
        : null,
      input.idempotencyKeyHash,
      input.requestHash,
      input.inputObjectKey,
      input.now,
      input.now,
    ),
    ...input.manifest.items.map((item, ordinal) => env.DB.prepare(
      `INSERT INTO media_task_items (
         task_id, custom_id, ordinal, status, output_count, prompt_preview,
         request_hash, created_at_ms
       ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).bind(
      input.id,
      item.custom_id,
      ordinal,
      item.output_count,
      item.prompt.slice(0, 500),
      itemHashes[ordinal],
      input.now,
    )),
    env.DB.prepare(
      `INSERT INTO media_task_events (
         id, task_id, event_type, payload_json, event_hash, occurred_at_ms
       ) VALUES (?, ?, 'created', ?, ?, ?)`,
    ).bind(eventId, input.id, JSON.stringify({ expected_output_count: input.expectedOutputCount }), eventHash, input.now),
  ])
}

export async function findMediaTaskByIdempotency(
  env: MediaEnv,
  apiKeyId: string,
  idempotencyKeyHash: string,
): Promise<MediaTaskRow | null> {
  return env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM media_tasks
      WHERE api_key_id = ? AND idempotency_key_hash = ?`,
  ).bind(apiKeyId, idempotencyKeyHash).first<MediaTaskRow>()
}

export async function findOwnedMediaTask(
  env: MediaEnv,
  owner: MediaTaskOwner,
  taskId: string,
  includeDeleted = false,
): Promise<MediaTaskRow | null> {
  const apiKeyClause = owner.apiKeyId === undefined ? '' : ' AND api_key_id = ?'
  const deletedClause = includeDeleted ? '' : ' AND user_deleted_at_ms IS NULL'
  const bindings = owner.apiKeyId === undefined
    ? [taskId, owner.userId]
    : [taskId, owner.userId, owner.apiKeyId]
  return env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM media_tasks
      WHERE id = ? AND user_id = ?${apiKeyClause}${deletedClause}`,
  ).bind(...bindings).first<MediaTaskRow>()
}

export async function findMediaTask(env: MediaEnv, taskId: string): Promise<MediaTaskRow | null> {
  return env.DB.prepare(`SELECT ${TASK_COLUMNS} FROM media_tasks WHERE id = ?`)
    .bind(taskId).first<MediaTaskRow>()
}

export interface MediaTaskListQuery {
  limit: number
  status?: string
  taskName?: string
  downloaded?: boolean
  fromMs?: number
  toMs?: number
  cursor?: { createdAtMs: number; id: string }
  offset?: number
}

export async function listOwnedMediaTasks(
  env: MediaEnv,
  owner: Required<MediaTaskOwner>,
  query: MediaTaskListQuery,
): Promise<{ rows: MediaTaskRow[]; hasMore: boolean }> {
  const clauses = ['user_id = ?', 'api_key_id = ?', 'user_deleted_at_ms IS NULL']
  const values: unknown[] = [owner.userId, owner.apiKeyId]
  if (query.status !== undefined) {
    clauses.push('status = ?')
    values.push(query.status)
  }
  if (query.taskName !== undefined) {
    clauses.push(`task_name LIKE ? ESCAPE '\\'`)
    values.push(`%${query.taskName.replace(/[\\%_]/g, '\\$&')}%`)
  }
  if (query.downloaded !== undefined) clauses.push(`downloaded_at_ms IS ${query.downloaded ? 'NOT ' : ''}NULL`)
  if (query.fromMs !== undefined) {
    clauses.push('created_at_ms >= ?')
    values.push(query.fromMs)
  }
  if (query.toMs !== undefined) {
    clauses.push('created_at_ms <= ?')
    values.push(query.toMs)
  }
  if (query.cursor !== undefined) {
    clauses.push('(created_at_ms < ? OR (created_at_ms = ? AND id < ?))')
    values.push(query.cursor.createdAtMs, query.cursor.createdAtMs, query.cursor.id)
  }
  const offsetClause = query.offset === undefined ? '' : ' OFFSET ?'
  const result = await env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM media_tasks
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at_ms DESC, id DESC LIMIT ?${offsetClause}`,
  ).bind(...values, query.limit + 1, ...(query.offset === undefined ? [] : [query.offset])).all<MediaTaskRow>()
  return { rows: result.results.slice(0, query.limit), hasMore: result.results.length > query.limit }
}

export async function markMediaTaskReserved(env: MediaEnv, taskId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE media_tasks
        SET billing_status = 'reserved', status = 'queued', submitted_at_ms = ?,
            updated_at_ms = ?, version = version + 1
      WHERE id = ? AND billing_status = 'unreserved' AND status = 'created'`,
  ).bind(now, now, taskId).run()
}

export async function markMediaTaskEnqueued(env: MediaEnv, taskId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE media_tasks SET enqueued_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ? AND status IN ('queued', 'running')`,
  ).bind(now, now, taskId).run()
}

export async function markMediaTaskBillingReleased(env: MediaEnv, taskId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE media_tasks
        SET billing_status = 'released', updated_at_ms = MAX(updated_at_ms, ?), version = version + 1
      WHERE id = ? AND status = 'cancelled' AND billing_status IN ('unreserved', 'reserved')`,
  ).bind(now, taskId).run()
}

export async function cancelPendingMediaItems(env: MediaEnv, taskId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE media_task_items
        SET status = 'cancelled', completed_at_ms = ?
      WHERE task_id = ? AND status IN ('queued', 'running')`,
  ).bind(now, taskId).run()
}

export async function claimMediaTask(env: MediaEnv, taskId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE media_tasks
        SET status = 'running', started_at_ms = COALESCE(started_at_ms, ?),
            updated_at_ms = ?, version = version + 1
      WHERE id = ? AND status = 'queued' AND billing_status = 'reserved'`,
  ).bind(now, now, taskId).run()
  return (result.meta.changes ?? 0) === 1
}

export async function listMediaTaskItems(
  env: MediaEnv,
  taskId: string,
  status?: string,
): Promise<MediaTaskItemRow[]> {
  const condition = status === undefined || status === '' ? '' : ' AND status = ?'
  const values = status === undefined || status === '' ? [taskId] : [taskId, status]
  const result = await env.DB.prepare(
    `SELECT task_id, custom_id, ordinal, status, output_count, image_count,
            prompt_preview, request_hash, mime_type, file_extension,
            error_code, error_message, attempt_token, attempt_started_at_ms,
            attempt_count, created_at_ms, completed_at_ms
       FROM media_task_items WHERE task_id = ?${condition}
      ORDER BY ordinal, custom_id`,
  ).bind(...values).all<MediaTaskItemRow>()
  return result.results
}

export async function claimNextMediaTaskItem(
  env: MediaEnv,
  taskId: string,
  attemptToken: string,
  now: number,
  staleBefore: number,
): Promise<MediaTaskItemRow | null> {
  const result = await env.DB.prepare(
    `UPDATE media_task_items
        SET status = 'running', attempt_token = ?, attempt_started_at_ms = ?,
            attempt_count = attempt_count + 1
      WHERE (task_id, custom_id) IN (
        SELECT item.task_id, item.custom_id
          FROM media_task_items AS item
          JOIN media_tasks AS task ON task.id = item.task_id
         WHERE item.task_id = ? AND task.status = 'running'
           AND item.image_count < item.output_count
           AND (
             item.status = 'queued'
             OR (item.status = 'running' AND COALESCE(item.attempt_started_at_ms, 0) <= ?)
           )
         ORDER BY item.ordinal, item.custom_id LIMIT 1
      )`,
  ).bind(attemptToken, now, taskId, staleBefore).run()
  if ((result.meta.changes ?? 0) !== 1) return null
  return env.DB.prepare(
    `SELECT task_id, custom_id, ordinal, status, output_count, image_count,
            prompt_preview, request_hash, mime_type, file_extension,
            error_code, error_message, attempt_token, attempt_started_at_ms,
            attempt_count, created_at_ms, completed_at_ms
       FROM media_task_items WHERE task_id = ? AND attempt_token = ? LIMIT 1`,
  ).bind(taskId, attemptToken).first<MediaTaskItemRow>()
}

export async function releaseMediaTaskItemAttempt(
  env: MediaEnv,
  taskId: string,
  customId: string,
  attemptToken: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE media_task_items
        SET status = 'queued', attempt_token = NULL, attempt_started_at_ms = NULL
      WHERE task_id = ? AND custom_id = ? AND status = 'running' AND attempt_token = ?`,
  ).bind(taskId, customId, attemptToken).run()
}

export async function completeMediaTaskItemUnit(
  env: MediaEnv,
  input: {
    taskId: string
    customId: string
    attemptToken: string
    imageIndex: number
    objectKey: string
    mimeType: MediaTaskOutputRow['mime_type']
    fileExtension: MediaTaskOutputRow['file_extension']
    byteLength: number
    sha256: string
    providerAccountId: string
    now: number
  },
): Promise<boolean> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO media_task_outputs (
         task_id, custom_id, image_index, object_key, mime_type,
         file_extension, byte_length, sha256, created_at_ms
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM media_task_items AS item
          JOIN media_tasks AS task ON task.id = item.task_id
          WHERE item.task_id = ? AND item.custom_id = ? AND item.attempt_token = ?
            AND item.status = 'running' AND task.status = 'running'
        )
       ON CONFLICT(task_id, custom_id, image_index) DO NOTHING`,
    ).bind(
      input.taskId, input.customId, input.imageIndex, input.objectKey,
      input.mimeType, input.fileExtension, input.byteLength, input.sha256, input.now,
      input.taskId, input.customId, input.attemptToken,
    ),
    env.DB.prepare(
      `UPDATE media_task_items
          SET image_count = image_count + 1,
              status = CASE WHEN image_count + 1 >= output_count THEN 'succeeded' ELSE 'queued' END,
              mime_type = ?, file_extension = ?, error_code = NULL, error_message = NULL,
              attempt_token = NULL, attempt_started_at_ms = NULL,
              completed_at_ms = CASE WHEN image_count + 1 >= output_count THEN ? ELSE NULL END
        WHERE task_id = ? AND custom_id = ? AND status = 'running' AND attempt_token = ?
          AND EXISTS (SELECT 1 FROM media_tasks WHERE id = ? AND status = 'running')`,
    ).bind(
      input.mimeType, input.fileExtension, input.now, input.taskId,
      input.customId, input.attemptToken, input.taskId,
    ),
    env.DB.prepare(
      `UPDATE media_tasks
          SET provider_account_id = COALESCE(provider_account_id, ?),
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND status = 'running'`,
    ).bind(input.providerAccountId, input.now, input.taskId),
  ])
  const persisted = await env.DB.prepare(
    `SELECT 1 AS present FROM media_task_outputs AS output
      JOIN media_task_items AS item
        ON item.task_id = output.task_id AND item.custom_id = output.custom_id
     WHERE output.task_id = ? AND output.custom_id = ? AND output.image_index = ?
       AND item.image_count > ? LIMIT 1`,
  ).bind(input.taskId, input.customId, input.imageIndex, input.imageIndex).first<{ present: number }>()
  return persisted !== null
}

export async function failMediaTaskItemAttempt(
  env: MediaEnv,
  taskId: string,
  customId: string,
  attemptToken: string,
  code: string,
  message: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE media_task_items
        SET status = 'failed', error_code = ?, error_message = ?,
            attempt_token = NULL, attempt_started_at_ms = NULL, completed_at_ms = ?
      WHERE task_id = ? AND custom_id = ? AND status = 'running' AND attempt_token = ?
        AND EXISTS (SELECT 1 FROM media_tasks WHERE id = ? AND status = 'running')`,
  ).bind(code.slice(0, 128), message.slice(0, 1000), now, taskId, customId, attemptToken, taskId).run()
  return (result.meta.changes ?? 0) === 1
}

export interface MediaTaskAggregate {
  successCount: number
  failCount: number
  cancelledCount: number
  pendingCount: number
}

export async function mediaTaskAggregate(env: MediaEnv, taskId: string): Promise<MediaTaskAggregate> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(image_count), 0) AS success_count,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN output_count - image_count ELSE 0 END), 0) AS fail_count,
            COALESCE(SUM(CASE WHEN status = 'cancelled' THEN output_count - image_count ELSE 0 END), 0) AS cancelled_count,
            COALESCE(SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END), 0) AS pending_count
       FROM media_task_items WHERE task_id = ?`,
  ).bind(taskId).first<{ success_count: number; fail_count: number; cancelled_count: number; pending_count: number }>()
  return {
    successCount: row?.success_count ?? 0,
    failCount: row?.fail_count ?? 0,
    cancelledCount: row?.cancelled_count ?? 0,
    pendingCount: row?.pending_count ?? 0,
  }
}

export async function markMediaTaskDownloaded(env: MediaEnv, taskId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE media_tasks SET downloaded_at_ms = COALESCE(downloaded_at_ms, ?), updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ? AND status = 'completed'`,
  ).bind(now, now, taskId).run()
}

export async function removeMediaTaskOutputs(env: MediaEnv, taskId: string, now: number): Promise<boolean> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM media_task_outputs WHERE task_id = ?').bind(taskId),
    env.DB.prepare(
      `UPDATE media_tasks
          SET status = 'output_deleted', output_deleted_at_ms = ?, updated_at_ms = ?, version = version + 1
        WHERE id = ? AND status = 'completed'`,
    ).bind(now, now, taskId),
    env.DB.prepare(
      `INSERT INTO media_task_events (id, task_id, event_type, payload_json, event_hash, occurred_at_ms)
       VALUES (?, ?, 'outputs_deleted', '{}', ?, ?)
       ON CONFLICT(task_id, event_hash) DO NOTHING`,
    ).bind(
      await deterministicUuid('media-task-event.v1', `${taskId}\0outputs_deleted`),
      taskId,
      await sha256Hex('outputs_deleted\0{}'),
      now,
    ),
  ])
  const task = await findMediaTask(env, taskId)
  return task?.status === 'output_deleted'
}

export async function softDeleteMediaTask(env: MediaEnv, taskId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE media_tasks
        SET user_deleted_at_ms = COALESCE(user_deleted_at_ms, ?), updated_at_ms = ?, version = version + 1
      WHERE id = ? AND user_deleted_at_ms IS NULL
        AND status IN ('completed', 'failed', 'cancelled', 'output_deleted')`,
  ).bind(now, now, taskId).run()
  return (result.meta.changes ?? 0) === 1
}

export async function listRecoverableMediaTasks(
  env: MediaEnv,
  limit: number,
  staleRunningBefore: number,
): Promise<MediaTaskRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM media_tasks
      WHERE user_deleted_at_ms IS NULL AND (
        (status = 'created' AND billing_status = 'unreserved')
        OR (status = 'queued' AND (enqueued_at_ms IS NULL OR updated_at_ms <= ?))
        OR (status = 'running' AND updated_at_ms <= ?)
        OR status = 'settling'
        OR (status = 'cancelled' AND billing_status IN ('unreserved', 'reserved', 'settling'))
      )
      ORDER BY updated_at_ms, id LIMIT ?`,
  ).bind(staleRunningBefore, staleRunningBefore, limit).all<MediaTaskRow>()
  return result.results
}

export async function findMediaTaskOutput(
  env: MediaEnv,
  taskId: string,
  customId: string,
  imageIndex: number,
): Promise<MediaTaskOutputRow | null> {
  return env.DB.prepare(
    `SELECT task_id, custom_id, image_index, object_key, mime_type,
            file_extension, byte_length, sha256, created_at_ms
       FROM media_task_outputs
      WHERE task_id = ? AND custom_id = ? AND image_index = ?`,
  ).bind(taskId, customId, imageIndex).first<MediaTaskOutputRow>()
}

export async function listMediaTaskOutputs(env: MediaEnv, taskId: string): Promise<MediaTaskOutputRow[]> {
  const result = await env.DB.prepare(
    `SELECT task_id, custom_id, image_index, object_key, mime_type,
            file_extension, byte_length, sha256, created_at_ms
       FROM media_task_outputs WHERE task_id = ?
      ORDER BY custom_id, image_index`,
  ).bind(taskId).all<MediaTaskOutputRow>()
  return result.results
}

export async function appendMediaEvent(
  env: MediaEnv,
  taskId: string,
  eventType: string,
  payload: Record<string, unknown>,
  now: number,
): Promise<void> {
  const eventHash = await sha256Hex(`${eventType}\0${JSON.stringify(payload)}`)
  const eventId = await deterministicUuid('media-task-event.v1', `${taskId}\0${eventHash}`)
  await env.DB.prepare(
    `INSERT INTO media_task_events (
       id, task_id, event_type, payload_json, event_hash, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, event_hash) DO NOTHING`,
  ).bind(eventId, taskId, eventType, JSON.stringify(payload), eventHash, now).run()
}

export async function transitionMediaTask(
  env: MediaEnv,
  taskId: string,
  from: MediaTaskStatus[],
  to: MediaTaskStatus,
  updates: {
    billingStatus?: MediaTaskRow['billing_status']
    actualCostMicros?: number | null
    successCount?: number
    failCount?: number
    cancelledCount?: number
    providerAccountId?: string | null
    errorCode?: string | null
    errorMessage?: string | null
    finishedAtMs?: number | null
    settledAtMs?: number | null
    outputDeletedAtMs?: number | null
    userDeletedAtMs?: number | null
  },
  now: number,
): Promise<boolean> {
  const placeholders = from.map(() => '?').join(', ')
  const result = await env.DB.prepare(
    `UPDATE media_tasks SET
       status = ?, billing_status = COALESCE(?, billing_status),
       actual_cost_micros = COALESCE(?, actual_cost_micros),
       success_count = COALESCE(?, success_count), fail_count = COALESCE(?, fail_count),
       cancelled_count = COALESCE(?, cancelled_count),
       provider_account_id = COALESCE(?, provider_account_id),
       last_error_code = ?, last_error_message = ?,
       finished_at_ms = COALESCE(?, finished_at_ms),
       settled_at_ms = COALESCE(?, settled_at_ms),
       output_deleted_at_ms = COALESCE(?, output_deleted_at_ms),
       user_deleted_at_ms = COALESCE(?, user_deleted_at_ms),
       updated_at_ms = ?, version = version + 1
     WHERE id = ? AND status IN (${placeholders})`,
  ).bind(
    to,
    updates.billingStatus ?? null,
    updates.actualCostMicros ?? null,
    updates.successCount ?? null,
    updates.failCount ?? null,
    updates.cancelledCount ?? null,
    updates.providerAccountId ?? null,
    updates.errorCode ?? null,
    updates.errorMessage ?? null,
    updates.finishedAtMs ?? null,
    updates.settledAtMs ?? null,
    updates.outputDeletedAtMs ?? null,
    updates.userDeletedAtMs ?? null,
    now,
    taskId,
    ...from,
  ).run()
  return (result.meta.changes ?? 0) === 1
}
