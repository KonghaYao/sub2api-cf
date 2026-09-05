import { sha256Hex } from '../gateway/crypto'
import { fileExtension, mediaObjectPrefix } from './domain'
import { createGeminiBatchClient, type GeminiBatchItemResult } from './gemini-batch'
import { geminiMediaProviderJobAccounts } from './provider'
import {
  appendMediaEvent,
  cancelPendingMediaItems,
  claimMediaTask,
  claimNextMediaTaskItem,
  completeMediaTaskItemUnit,
  failMediaTaskItemAttempt,
  findMediaTask,
  listMediaTaskItems,
  mediaTaskAggregate,
  releaseMediaTaskItemAttempt,
  transitionMediaTask,
} from './repository'
import { finishOrAwaitMediaTask, settleCancelledMediaTask, settleMediaTask } from './queue'
import { mediaBilling } from './billing'
import type {
  MediaEnv,
  MediaManifest,
  MediaProviderJobAdvanceEvent,
  MediaProviderJobPhase,
  MediaProviderJobRow,
  MediaTaskItemRow,
  MediaTaskRow,
} from './types'

const MAX_INLINE_PROVIDER_JOB_ITEMS = 8
const MAX_INLINE_PROVIDER_JOB_REQUEST_BYTES = 18 * 1024 * 1024
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const JOB_DEADLINE_MS = 24 * 60 * 60 * 1_000
const JOB_LEASE_MS = 2 * 60 * 1_000
const ITEM_LEASE_MS = 2 * 60 * 1_000
const MAX_JOB_ERRORS = 8
const MAX_SUBMIT_RECOVERY_MISSES = 3

const JOB_COLUMNS = `task_id, provider_account_id, submission_key, provider_job_id,
  phase, provider_raw_state, next_action_at_ms, deadline_at_ms, attempt_count,
  consecutive_errors, poll_count, reservation_renewal_sequence, lease_token,
  lease_expires_at_ms, result_manifest_object_key, result_manifest_sha256,
  result_cursor_json, result_complete, cancel_requested_at_ms,
  provider_terminal_at_ms, version, created_at_ms, updated_at_ms,
  last_error_class, last_error_code`

export async function planMediaProviderJob(
  env: MediaEnv,
  input: {
    taskId: string
    groupId: string
    manifest: MediaManifest
    now: number
  },
): Promise<{
  accountId: string
  submissionKey: string
  deadlineAtMs: number
} | undefined> {
  if (env.BATCH_PROVIDER_JOBS_ENABLED !== 'true') return undefined
  if (input.manifest.items.length === 0 || input.manifest.items.length > MAX_INLINE_PROVIDER_JOB_ITEMS) return undefined
  if (input.manifest.items.some((item) => item.output_count !== 1)) return undefined
  const bytes = new TextEncoder().encode(JSON.stringify(input.manifest)).byteLength
  if (bytes > MAX_INLINE_PROVIDER_JOB_REQUEST_BYTES) return undefined
  const account = await accountResolver(env).select(env, {
    group_id: input.groupId,
    model: input.manifest.model,
    upstream_model: input.manifest.upstream_model,
  })
  return {
    accountId: account.id,
    submissionKey: input.taskId,
    deadlineAtMs: input.now + JOB_DEADLINE_MS,
  }
}

export function createMediaProviderJobAdvanceEvent(
  taskId: string,
  expectedVersion: number,
  occurredAtMs = Date.now(),
): MediaProviderJobAdvanceEvent {
  return {
    schema_version: 1,
    event_id: `media-provider-job:${taskId}:${expectedVersion}`,
    event_type: 'media.provider_job.advance.v1',
    occurred_at_ms: occurredAtMs,
    aggregate_type: 'media_provider_job',
    aggregate_id: taskId,
    payload: { task_id: taskId, expected_version: expectedVersion },
  }
}

export function isMediaProviderJobAdvanceEvent(value: unknown): value is MediaProviderJobAdvanceEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<MediaProviderJobAdvanceEvent>
  return event.schema_version === 1 &&
    event.event_type === 'media.provider_job.advance.v1' &&
    event.aggregate_type === 'media_provider_job' &&
    typeof event.aggregate_id === 'string' && event.aggregate_id !== '' &&
    event.payload?.task_id === event.aggregate_id &&
    Number.isSafeInteger(event.payload?.expected_version) &&
    (event.payload?.expected_version ?? -1) >= 0
}

export async function enqueueMediaProviderJob(
  env: MediaEnv,
  taskId: string,
  expectedVersion: number,
  delayMs = 0,
): Promise<void> {
  const event = createMediaProviderJobAdvanceEvent(taskId, expectedVersion)
  if (delayMs < 1_000) {
    await env.EVENTS_QUEUE.send(event)
    return
  }
  await env.EVENTS_QUEUE.send(event, {
    delaySeconds: Math.min(43_200, Math.max(1, Math.ceil(delayMs / 1_000))),
  })
}

export async function enqueueMediaProviderJobForTask(env: MediaEnv, taskId: string): Promise<void> {
  await enqueueCurrentJob(env, taskId)
}

export async function consumeMediaProviderJobAdvance(value: unknown, env: MediaEnv): Promise<boolean> {
  if (!isMediaProviderJobAdvanceEvent(value)) return false
  const initial = await findProviderJob(env, value.payload.task_id)
  if (initial === null || initial.phase === 'done' || initial.phase === 'attention') return true
  if (initial.version !== value.payload.expected_version) return true

  const leaseToken = crypto.randomUUID().replaceAll('-', '')
  const now = Date.now()
  const claimed = await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET lease_token = ?, lease_expires_at_ms = ?, attempt_count = attempt_count + 1,
            updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND version = ? AND phase NOT IN ('done', 'attention')
        AND (lease_token IS NULL OR lease_expires_at_ms <= ?)`,
  ).bind(leaseToken, now + JOB_LEASE_MS, now, initial.task_id, initial.version, now).run()
  if ((claimed.meta.changes ?? 0) !== 1) return true

  let job = await requiredProviderJob(env, initial.task_id)
  let task = await findMediaTask(env, job.task_id)
  if (task === null || task.execution_mode !== 'provider_job_v1') {
    await markAttention(env, job.task_id, leaseToken, 'MEDIA_PROVIDER_JOB_ORPHANED')
    return true
  }
  if (task.status === 'queued') {
    await claimMediaTask(env, task.id, now)
    task = await findMediaTask(env, task.id)
  }
  if (task === null) {
    await markDone(env, job.task_id, leaseToken)
    return true
  }
  if (task.status === 'cancelled') {
    try {
      await settleCancelledMediaTask(env, task)
      const settled = await findMediaTask(env, task.id)
      if (settled === null || !['settled', 'released'].includes(settled.billing_status)) {
        throw new Error('Cancelled media billing is not terminal')
      }
      await markDone(env, job.task_id, leaseToken)
    } catch (error) {
      await retryAfterError(env, job.task_id, leaseToken, error)
    }
    return true
  }
  if (terminalTask(task)) {
    if (job.last_error_code === 'GEMINI_BATCH_DEADLINE_EXCEEDED' && task.status === 'completed') {
      await transitionMediaTask(env, task.id, ['completed'], 'completed', {
        errorCode: 'GEMINI_BATCH_DEADLINE_EXCEEDED',
        errorMessage: 'Gemini batch exceeded its processing deadline and was cancelled',
      }, Date.now())
    }
    await markDone(env, job.task_id, leaseToken)
    return true
  }

  try {
    if (task.status === 'settling') {
      await settleMediaTask(env, task)
      await markDone(env, job.task_id, leaseToken)
      return true
    }
    if (job.cancel_requested_at_ms !== null && job.provider_job_id !== null &&
        job.phase !== 'cleanup_pending' && job.phase !== 'materialize_pending' &&
        job.provider_raw_state !== 'CANCEL_REQUESTED') {
      if (job.phase === 'cancel_pending') await cancelProviderJob(env, job, leaseToken)
      else await releaseToPhase(env, job.task_id, leaseToken, 'cancel_pending', 0)
      return true
    }
    if (task.billing_status === 'reserved') {
      const sequence = job.reservation_renewal_sequence + 1
      await mediaBilling(env).renew({ env, task, sequence })
      await env.DB.prepare(
        `UPDATE media_provider_jobs
            SET reservation_renewal_sequence = ?, updated_at_ms = ?
          WHERE task_id = ? AND lease_token = ?`,
      ).bind(sequence, Date.now(), job.task_id, leaseToken).run()
      job = await requiredProviderJob(env, job.task_id)
    }
    switch (job.phase) {
      case 'input_pending':
      case 'submit_pending':
        await submitProviderJob(env, task, job, leaseToken)
        return true
      case 'submit_unknown':
        await recoverAmbiguousSubmit(env, job, leaseToken)
        return true
      case 'poll_pending':
      case 'result_pending':
        await pollProviderJob(env, task, job, leaseToken)
        return true
      case 'materialize_pending':
        await materializeProviderResult(env, task, job, leaseToken)
        return true
      case 'cleanup_pending':
        if (job.last_error_class === 'cancelled' ||
            (job.provider_job_id === null && job.cancel_requested_at_ms !== null)) {
          await finalizeLocalProviderCancellation(env, task)
          await markDone(env, task.id, leaseToken)
        } else {
          await materializeProviderResult(env, task, job, leaseToken)
        }
        return true
      case 'cancel_pending':
        await cancelProviderJob(env, job, leaseToken)
        return true
      case 'attention':
      case 'done':
        await releaseLease(env, job.task_id, leaseToken)
        return true
    }
  } catch (error) {
    await retryAfterError(env, job.task_id, leaseToken, error)
    return true
  }
}

export async function requestMediaProviderJobCancellation(
  env: MediaEnv,
  task: MediaTaskRow,
): Promise<boolean> {
  if (task.execution_mode !== 'provider_job_v1') return false
  const job = await findProviderJob(env, task.id)
  if (job === null || job.phase === 'done') return false
  const now = Date.now()
  if (job.provider_job_id === null && (job.phase === 'input_pending' || job.phase === 'submit_pending')) {
    const stopped = await env.DB.prepare(
      `UPDATE media_provider_jobs
          SET phase = 'cleanup_pending', cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
              next_action_at_ms = ?, lease_token = NULL,
              lease_expires_at_ms = NULL, updated_at_ms = ?, version = version + 1
        WHERE task_id = ? AND provider_job_id IS NULL
          AND phase IN ('input_pending', 'submit_pending')`,
    ).bind(now, now, now, task.id).run()
    if ((stopped.meta.changes ?? 0) !== 1) {
      const raced = await requiredProviderJob(env, task.id)
      const nextPhase = raced.provider_job_id === null ? raced.phase : 'cancel_pending'
      await env.DB.prepare(
        `UPDATE media_provider_jobs
            SET phase = ?, cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
                next_action_at_ms = ?, updated_at_ms = ?, version = version + 1
          WHERE task_id = ? AND phase NOT IN ('done', 'attention')`,
      ).bind(nextPhase, now, now, now, task.id).run()
      const updated = await requiredProviderJob(env, task.id)
      await enqueueMediaProviderJob(env, task.id, updated.version)
      return true
    }
    try {
      await finalizeLocalProviderCancellation(env, task)
      await env.DB.prepare(
        `UPDATE media_provider_jobs
            SET phase = 'done', provider_terminal_at_ms = ?, next_action_at_ms = ?,
                updated_at_ms = ?, version = version + 1
          WHERE task_id = ? AND phase = 'cleanup_pending'`,
      ).bind(Date.now(), Date.now(), Date.now(), task.id).run()
    } catch {
      await enqueueCurrentJob(env, task.id)
    }
    return true
  }
  const nextPhase = job.provider_job_id === null || job.provider_raw_state === 'CANCEL_REQUESTED'
    ? job.phase
    : 'cancel_pending'
  await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = ?, cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
            next_action_at_ms = ?, updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND phase NOT IN ('done', 'attention')`,
  ).bind(nextPhase, now, now, now, task.id).run()
  const updated = await requiredProviderJob(env, task.id)
  await enqueueMediaProviderJob(env, task.id, updated.version)
  return true
}

export async function recoverPendingProviderMediaJobs(
  env: MediaEnv,
  limit = 25,
): Promise<{ scanned: number; enqueued: number; failed: number }> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 25
  const now = Date.now()
  const result = await env.DB.prepare(
    `SELECT ${JOB_COLUMNS} FROM media_provider_jobs
      WHERE phase NOT IN ('done', 'attention') AND next_action_at_ms <= ?
        AND (lease_token IS NULL OR lease_expires_at_ms <= ?)
      ORDER BY next_action_at_ms, task_id LIMIT ?`,
  ).bind(now, now, bounded).all<MediaProviderJobRow>()
  const summary = { scanned: result.results.length, enqueued: 0, failed: 0 }
  for (const job of result.results) {
    try {
      await enqueueMediaProviderJob(env, job.task_id, job.version)
      summary.enqueued += 1
    } catch {
      summary.failed += 1
    }
  }
  return summary
}

async function submitProviderJob(
  env: MediaEnv,
  task: MediaTaskRow,
  job: MediaProviderJobRow,
  leaseToken: string,
): Promise<void> {
  if (job.cancel_requested_at_ms !== null) {
    await requestMediaProviderJobCancellation(env, task)
    await releaseLease(env, job.task_id, leaseToken)
    return
  }
  const [account, manifest] = await Promise.all([
    accountResolver(env).exact(env, job.provider_account_id),
    readManifest(env, task),
  ])
  const marked = await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = 'submit_unknown', next_action_at_ms = ?, updated_at_ms = ?,
            lease_token = NULL, lease_expires_at_ms = NULL, version = version + 1
      WHERE task_id = ? AND lease_token = ? AND provider_job_id IS NULL`,
  ).bind(Date.now() + 60_000, Date.now(), job.task_id, leaseToken).run()
  if ((marked.meta.changes ?? 0) !== 1) return
  try {
    const result = await batchClient(env).submit({
      baseUrl: account.baseUrl,
      apiKey: account.apiKey,
      upstreamModel: task.upstream_model,
      displayName: job.submission_key,
      items: manifest.items,
      imageSize: task.image_size,
      aspectRatio: task.aspect_ratio,
      responseMimeType: task.response_mime_type,
    })
    await env.DB.prepare(
      `UPDATE media_provider_jobs
          SET provider_job_id = ?, provider_raw_state = ?, phase = 'poll_pending',
              next_action_at_ms = ?, consecutive_errors = 0, updated_at_ms = ?, version = version + 1
        WHERE task_id = ? AND phase = 'submit_unknown' AND provider_job_id IS NULL`,
    ).bind(
      result.providerJobId,
      result.rawState.slice(0, 256),
      Date.now() + result.pollAfterMs,
      Date.now(),
      job.task_id,
    ).run()
    await enqueueCurrentJob(env, job.task_id, result.pollAfterMs)
  } catch {
    await enqueueCurrentJob(env, job.task_id, 60_000)
  }
}

async function recoverAmbiguousSubmit(
  env: MediaEnv,
  job: MediaProviderJobRow,
  leaseToken: string,
): Promise<void> {
  const account = await accountResolver(env).exact(env, job.provider_account_id)
  const result = await batchClient(env).findByDisplayName({
    baseUrl: account.baseUrl,
    apiKey: account.apiKey,
    displayName: job.submission_key,
  })
  if (result.status === 'found') {
    const phase: MediaProviderJobPhase = job.cancel_requested_at_ms === null ? 'poll_pending' : 'cancel_pending'
    await releaseToPhase(env, job.task_id, leaseToken, phase, result.pollAfterMs, {
      providerJobId: result.providerJobId,
      rawState: result.rawState,
      resetErrors: true,
    })
    return
  }
  const misses = job.consecutive_errors + 1
  if (result.status === 'ambiguous' || misses >= MAX_SUBMIT_RECOVERY_MISSES) {
    await markAttention(
      env,
      job.task_id,
      leaseToken,
      result.status === 'ambiguous' ? 'GEMINI_BATCH_SUBMIT_AMBIGUOUS' : 'GEMINI_BATCH_SUBMIT_UNRESOLVED',
    )
    return
  }
  await releaseToPhase(env, job.task_id, leaseToken, 'submit_unknown', 60_000, { incrementErrors: true })
}

async function pollProviderJob(
  env: MediaEnv,
  task: MediaTaskRow,
  job: MediaProviderJobRow,
  leaseToken: string,
): Promise<void> {
  if (job.provider_job_id === null) {
    await markAttention(env, job.task_id, leaseToken, 'GEMINI_BATCH_JOB_ID_MISSING')
    return
  }
  if (Date.now() >= job.deadline_at_ms && job.cancel_requested_at_ms === null) {
    await requestCancellationFromLease(env, job.task_id, leaseToken)
    return
  }
  const account = await accountResolver(env).exact(env, job.provider_account_id)
  const result = await batchClient(env).poll({
    baseUrl: account.baseUrl,
    apiKey: account.apiKey,
    providerJobId: job.provider_job_id,
  })
  if (!result.done) {
    await releaseToPhase(env, job.task_id, leaseToken, 'poll_pending', result.pollAfterMs, {
      rawState: job.cancel_requested_at_ms === null ? result.rawState : 'CANCEL_REQUESTED',
      resetErrors: true,
      incrementPolls: true,
    })
    return
  }
  if (result.state === 'succeeded') {
    await persistProviderResults(env, task, job, leaseToken, result.items ?? [], result.rawState)
    return
  }
  if (result.state === 'cancelled') {
    await finishProviderCancellation(env, task, job, leaseToken, result.rawState)
    return
  }
  await failTerminalJob(
    env,
    task,
    job,
    leaseToken,
    result.error?.code ?? `GEMINI_BATCH_${result.state.toUpperCase()}`,
    result.error?.message ?? 'Gemini batch failed before producing results',
  )
}

async function cancelProviderJob(
  env: MediaEnv,
  job: MediaProviderJobRow,
  leaseToken: string,
): Promise<void> {
  if (job.provider_job_id === null) {
    await releaseToPhase(env, job.task_id, leaseToken, 'submit_unknown', 60_000)
    return
  }
  const account = await accountResolver(env).exact(env, job.provider_account_id)
  await batchClient(env).cancel({
    baseUrl: account.baseUrl,
    apiKey: account.apiKey,
    providerJobId: job.provider_job_id,
  })
  await releaseToPhase(env, job.task_id, leaseToken, 'poll_pending', 5_000, {
    rawState: 'CANCEL_REQUESTED',
    resetErrors: true,
  })
}

async function requestCancellationFromLease(
  env: MediaEnv,
  taskId: string,
  leaseToken: string,
): Promise<void> {
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = 'cancel_pending', cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
            last_error_class = 'deadline', last_error_code = 'GEMINI_BATCH_DEADLINE_EXCEEDED',
            next_action_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(now, now, now, taskId, leaseToken).run()
  if ((result.meta.changes ?? 0) === 1) await enqueueCurrentJob(env, taskId)
}

async function persistProviderResults(
  env: MediaEnv,
  task: MediaTaskRow,
  job: MediaProviderJobRow,
  leaseToken: string,
  results: GeminiBatchItemResult[],
  rawState: string,
): Promise<void> {
  const expected = await listMediaTaskItems(env, task.id)
  const expectedIds = new Set(expected.map((item) => item.custom_id))
  const byId = new Map<string, GeminiBatchItemResult>()
  let unknownCount = 0
  for (const result of results) {
    if (!expectedIds.has(result.customId)) {
      unknownCount += 1
      continue
    }
    if (byId.has(result.customId)) {
      await markAttention(env, job.task_id, leaseToken, 'GEMINI_BATCH_DUPLICATE_RESULT')
      return
    }
    byId.set(result.customId, result)
  }

  const statements: D1PreparedStatement[] = []
  const manifestItems: Array<Record<string, unknown>> = []
  const writtenObjectKeys: string[] = []
  try {
    for (const item of expected) {
    const result = byId.get(item.custom_id)
    const normalized = normalizeProviderItem(result)
    if ('error' in normalized) {
      statements.push(env.DB.prepare(
        `UPDATE media_task_items
            SET provider_record_object_key = NULL, provider_record_sha256 = NULL,
                provider_record_ordinal = ?, error_code = ?, error_message = ?
          WHERE task_id = ? AND custom_id = ? AND status = 'queued'
            AND EXISTS (
              SELECT 1 FROM media_provider_jobs
               WHERE task_id = ? AND lease_token = ?
            )`,
      ).bind(
        item.ordinal,
        normalized.error.code.slice(0, 128),
        normalized.error.message.slice(0, 1000),
        task.id,
        item.custom_id,
        task.id,
        leaseToken,
      ))
      manifestItems.push({ custom_id: item.custom_id, ordinal: item.ordinal, status: 'failed' })
      continue
    }
    const bytes = new Uint8Array(normalized.output.bytes)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_OUTPUT_BYTES) {
      statements.push(env.DB.prepare(
        `UPDATE media_task_items
            SET provider_record_object_key = NULL, provider_record_sha256 = NULL,
                provider_record_ordinal = ?, error_code = 'BATCH_IMAGE_PROVIDER_OUTPUT_TOO_LARGE',
                error_message = 'The generated image exceeded the Worker output limit'
          WHERE task_id = ? AND custom_id = ? AND status = 'queued'
            AND EXISTS (
              SELECT 1 FROM media_provider_jobs
               WHERE task_id = ? AND lease_token = ?
            )`,
      ).bind(item.ordinal, task.id, item.custom_id, task.id, leaseToken))
      manifestItems.push({ custom_id: item.custom_id, ordinal: item.ordinal, status: 'failed' })
      continue
    }
    const extension = fileExtension(normalized.output.mimeType)
    const digest = await binarySha256Hex(normalized.output.bytes)
    const objectKey = `${mediaObjectPrefix(env.ENVIRONMENT, task.id)}/outputs/${item.ordinal}-0-v${job.version}-${digest.slice(0, 16)}.${extension}`
    writtenObjectKeys.push(objectKey)
    await mediaBucket(env).put(objectKey, bytes, {
      httpMetadata: { contentType: normalized.output.mimeType },
      customMetadata: { taskId: task.id, customId: item.custom_id, providerRecord: 'true' },
    })
    statements.push(env.DB.prepare(
      `UPDATE media_task_items
          SET provider_record_object_key = ?, provider_record_sha256 = ?,
              provider_record_ordinal = ?, mime_type = ?, file_extension = ?,
              error_code = NULL, error_message = NULL
        WHERE task_id = ? AND custom_id = ? AND status = 'queued'
          AND EXISTS (
            SELECT 1 FROM media_provider_jobs
             WHERE task_id = ? AND lease_token = ?
          )`,
    ).bind(
      objectKey,
      digest,
      item.ordinal,
      normalized.output.mimeType,
      extension,
      task.id,
      item.custom_id,
      task.id,
      leaseToken,
    ))
    manifestItems.push({
      custom_id: item.custom_id,
      ordinal: item.ordinal,
      status: 'succeeded',
      object_key: objectKey,
      sha256: digest,
      mime_type: normalized.output.mimeType,
      byte_length: bytes.byteLength,
    })
    }
  const resultManifest = JSON.stringify({ version: 1, task_id: task.id, unknown_count: unknownCount, items: manifestItems })
  const resultManifestSha = await sha256Hex(resultManifest)
  const resultManifestKey = `${mediaObjectPrefix(env.ENVIRONMENT, task.id)}/provider/result-v${job.version}-${resultManifestSha.slice(0, 16)}.json`
  writtenObjectKeys.push(resultManifestKey)
  await mediaBucket(env).put(resultManifestKey, resultManifest, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { taskId: task.id, kind: 'provider-result-manifest' },
  })
  statements.push(env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = 'materialize_pending', provider_raw_state = ?, next_action_at_ms = ?,
            result_manifest_object_key = ?, result_manifest_sha256 = ?,
            result_cursor_json = ?, result_complete = 1, provider_terminal_at_ms = ?,
            consecutive_errors = 0, last_error_class = NULL, last_error_code = NULL,
            lease_token = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(
    rawState.slice(0, 256),
    Date.now(),
    resultManifestKey,
    resultManifestSha,
    JSON.stringify({ expected: expected.length, accepted: byId.size, unknown: unknownCount }),
    Date.now(),
    Date.now(),
    task.id,
    leaseToken,
  ))
  statements.push(env.DB.prepare(
    `SELECT task_id FROM media_provider_jobs
      WHERE task_id = ? AND result_manifest_object_key = ?`,
  ).bind(task.id, resultManifestKey))
  const committed = await env.DB.batch(statements)
  if (committed[committed.length - 1]?.results.length !== 1) {
    throw new Error('Provider result lease was lost before commit')
  }
  } catch (error) {
    await cleanupAttemptObjects(env, writtenObjectKeys)
    throw error
  }
  await enqueueCurrentJob(env, task.id)
}

async function materializeProviderResult(
  env: MediaEnv,
  task: MediaTaskRow,
  job: MediaProviderJobRow,
  leaseToken: string,
): Promise<void> {
  const attemptToken = crypto.randomUUID().replaceAll('-', '')
  const now = Date.now()
  const item = await claimNextMediaTaskItem(env, task.id, attemptToken, now, now - ITEM_LEASE_MS)
  if (item === null) {
    await finishOrAwaitMediaTask(env, task.id)
    if (job.last_error_code === 'GEMINI_BATCH_DEADLINE_EXCEEDED') {
      await transitionMediaTask(env, task.id, ['completed'], 'completed', {
        errorCode: 'GEMINI_BATCH_DEADLINE_EXCEEDED',
        errorMessage: 'Gemini batch exceeded its processing deadline and was cancelled',
      }, Date.now())
    }
    await markDone(env, task.id, leaseToken)
    return
  }
  try {
    if (item.error_code !== null) {
      await failMediaTaskItemAttempt(
        env,
        task.id,
        item.custom_id,
        attemptToken,
        item.error_code,
        item.error_message ?? 'Gemini batch item failed',
        Date.now(),
      )
    } else {
      if (item.provider_record_ordinal === null) {
        throw new Error('Provider result record was not reconciled')
      }
      await materializeSuccessfulItem(env, task, job, item, attemptToken)
    }
  } catch (error) {
    await releaseMediaTaskItemAttempt(env, task.id, item.custom_id, attemptToken)
    throw error
  }
  const aggregate = await mediaTaskAggregate(env, task.id)
  if (aggregate.pendingCount > 0) {
    await releaseToPhase(env, job.task_id, leaseToken, 'materialize_pending', 0)
    return
  }
  await finishOrAwaitMediaTask(env, task.id)
  await markDone(env, task.id, leaseToken)
}

async function materializeSuccessfulItem(
  env: MediaEnv,
  task: MediaTaskRow,
  job: MediaProviderJobRow,
  item: MediaTaskItemRow,
  attemptToken: string,
): Promise<void> {
  if (item.provider_record_object_key === null || item.provider_record_sha256 === null ||
      item.mime_type === null || item.file_extension === null) {
    throw new Error('Provider output record is incomplete')
  }
  const object = await mediaBucket(env).get(item.provider_record_object_key)
  if (object === null) throw new Error('Provider output object is missing')
  const bytes = await object.arrayBuffer()
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OUTPUT_BYTES) throw new Error('Provider output object is invalid')
  if (await binarySha256Hex(bytes) !== item.provider_record_sha256) throw new Error('Provider output digest mismatch')
  const persisted = await completeMediaTaskItemUnit(env, {
    taskId: task.id,
    customId: item.custom_id,
    attemptToken,
    imageIndex: item.image_count,
    objectKey: item.provider_record_object_key,
    mimeType: item.mime_type as 'image/png' | 'image/jpeg' | 'image/webp',
    fileExtension: item.file_extension as 'png' | 'jpg' | 'webp',
    byteLength: bytes.byteLength,
    sha256: item.provider_record_sha256,
    providerAccountId: job.provider_account_id,
    now: Date.now(),
  })
  if (!persisted) throw new Error('Provider output could not be committed')
}

async function failTerminalJob(
  env: MediaEnv,
  task: MediaTaskRow,
  job: MediaProviderJobRow,
  leaseToken: string,
  code: string,
  message: string,
): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
    `UPDATE media_task_items
        SET status = 'failed', error_code = ?, error_message = ?, completed_at_ms = ?,
            attempt_token = NULL, attempt_started_at_ms = NULL
      WHERE task_id = ? AND status IN ('queued', 'running')
        AND EXISTS (
          SELECT 1 FROM media_provider_jobs
           WHERE task_id = ? AND lease_token = ?
        )`,
    ).bind(code.slice(0, 128), message.slice(0, 1000), now, task.id, task.id, leaseToken),
    env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = 'materialize_pending', provider_terminal_at_ms = ?, provider_raw_state = ?,
            last_error_class = 'terminal', last_error_code = ?, next_action_at_ms = ?,
            lease_token = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
    ).bind(now, code.slice(0, 256), code.slice(0, 128), now, now, job.task_id, leaseToken),
  ])
  await enqueueCurrentJob(env, task.id)
}

async function finishProviderCancellation(
  env: MediaEnv,
  task: MediaTaskRow,
  job: MediaProviderJobRow,
  leaseToken: string,
  rawState: string,
): Promise<void> {
  if (job.last_error_code === 'GEMINI_BATCH_DEADLINE_EXCEEDED') {
    await failTerminalJob(
      env,
      task,
      job,
      leaseToken,
      'GEMINI_BATCH_DEADLINE_EXCEEDED',
      'Gemini batch exceeded its processing deadline and was cancelled',
    )
    return
  }
  const now = Date.now()
  const staged = await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = 'cleanup_pending', provider_terminal_at_ms = ?, provider_raw_state = ?,
            last_error_class = 'cancelled', last_error_code = 'GEMINI_BATCH_CANCELLED',
            next_action_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(now, rawState.slice(0, 256), now, now, job.task_id, leaseToken).run()
  if ((staged.meta.changes ?? 0) === 1) await enqueueCurrentJob(env, task.id)
}

async function finalizeLocalProviderCancellation(env: MediaEnv, task: MediaTaskRow): Promise<void> {
  const now = Date.now()
  const changed = await transitionMediaTask(env, task.id, ['created', 'queued', 'running'], 'cancelled', {
    cancelledCount: Math.max(0, task.expected_output_count - task.success_count - task.fail_count),
    finishedAtMs: now,
  }, now)
  if (changed) {
    await cancelPendingMediaItems(env, task.id, now)
    await appendMediaEvent(env, task.id, 'cancelled', {}, now)
  }
  const cancelled = await findMediaTask(env, task.id)
  if (cancelled === null || cancelled.status !== 'cancelled') {
    throw new Error('Local provider cancellation could not transition the task')
  }
  await settleCancelledMediaTask(env, cancelled)
  const settled = await findMediaTask(env, task.id)
  if (settled === null || !['settled', 'released'].includes(settled.billing_status)) {
    throw new Error('Local provider cancellation billing is not terminal')
  }
}

function normalizeProviderItem(result: GeminiBatchItemResult | undefined):
  | { output: NonNullable<GeminiBatchItemResult['outputs']>[number] }
  | { error: { code: string; message: string } } {
  if (result === undefined) {
    return { error: { code: 'GEMINI_BATCH_RESULT_MISSING', message: 'Gemini batch returned no result for this item' } }
  }
  if (result.error !== undefined) return { error: result.error }
  if (result.outputs?.length !== 1) {
    return { error: { code: 'GEMINI_BATCH_IMAGE_MISSING', message: 'Gemini batch item returned no single usable image' } }
  }
  return { output: result.outputs[0] }
}

async function releaseToPhase(
  env: MediaEnv,
  taskId: string,
  leaseToken: string,
  phase: MediaProviderJobPhase,
  delayMs: number,
  options: {
    providerJobId?: string
    rawState?: string
    resetErrors?: boolean
    incrementErrors?: boolean
    incrementPolls?: boolean
  } = {},
): Promise<void> {
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = ?, provider_job_id = COALESCE(?, provider_job_id),
            provider_raw_state = COALESCE(?, provider_raw_state), next_action_at_ms = ?,
            consecutive_errors = CASE WHEN ? = 1 THEN 0 WHEN ? = 1 THEN consecutive_errors + 1 ELSE consecutive_errors END,
            poll_count = poll_count + ?, lease_token = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(
    phase,
    options.providerJobId ?? null,
    options.rawState?.slice(0, 256) ?? null,
    now + Math.max(0, delayMs),
    options.resetErrors ? 1 : 0,
    options.incrementErrors ? 1 : 0,
    options.incrementPolls ? 1 : 0,
    now,
    taskId,
    leaseToken,
  ).run()
  if ((result.meta.changes ?? 0) === 1 && phase !== 'done' && phase !== 'attention') {
    await enqueueCurrentJob(env, taskId, delayMs)
  }
}

async function retryAfterError(env: MediaEnv, taskId: string, leaseToken: string, error: unknown): Promise<void> {
  const job = await findProviderJob(env, taskId)
  if (job === null || job.lease_token !== leaseToken) return
  const code = errorCode(error)
  if (code === 'GEMINI_BATCH_DUPLICATE_ITEM_KEY') {
    await markAttention(env, taskId, leaseToken, code)
    return
  }
  const knownProviderJob = job.provider_job_id !== null &&
    (job.phase === 'poll_pending' || job.phase === 'result_pending' || job.phase === 'cancel_pending')
  const mustFinishAccounting = job.phase === 'materialize_pending' || job.phase === 'cleanup_pending'
  if (!knownProviderJob && !mustFinishAccounting && job.consecutive_errors + 1 >= MAX_JOB_ERRORS) {
    await markAttention(env, taskId, leaseToken, code)
    return
  }
  const delay = Math.min(15 * 60_000, 2 ** Math.min(job.consecutive_errors, 8) * 5_000)
  const retryClass = mustFinishAccounting && job.last_error_class !== null
    ? job.last_error_class
    : error instanceof Error ? error.name.slice(0, 128) : 'unknown'
  const retryCode = mustFinishAccounting && job.last_error_code !== null
    ? job.last_error_code
    : code
  await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET consecutive_errors = consecutive_errors + 1, next_action_at_ms = ?,
            last_error_class = ?, last_error_code = ?, lease_token = NULL,
            lease_expires_at_ms = NULL, updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(
    Date.now() + delay,
    retryClass,
    retryCode,
    Date.now(),
    taskId,
    leaseToken,
  ).run()
  await enqueueCurrentJob(env, taskId, delay)
}

async function markAttention(env: MediaEnv, taskId: string, leaseToken: string, code: string): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = 'attention', last_error_class = 'integrity', last_error_code = ?,
            next_action_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(code.slice(0, 128), now, now, taskId, leaseToken).run()
}

async function markDone(env: MediaEnv, taskId: string, leaseToken: string): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE media_provider_jobs
        SET phase = 'done', next_action_at_ms = ?, lease_token = NULL,
            lease_expires_at_ms = NULL, updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(now, now, taskId, leaseToken).run()
}

async function releaseLease(env: MediaEnv, taskId: string, leaseToken: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE media_provider_jobs SET lease_token = NULL, lease_expires_at_ms = NULL,
            updated_at_ms = ?, version = version + 1
      WHERE task_id = ? AND lease_token = ?`,
  ).bind(Date.now(), taskId, leaseToken).run()
}

async function enqueueCurrentJob(env: MediaEnv, taskId: string, delayMs = 0): Promise<void> {
  const current = await requiredProviderJob(env, taskId)
  if (current.phase === 'done' || current.phase === 'attention') return
  await enqueueMediaProviderJob(env, taskId, current.version, delayMs)
}

async function cleanupAttemptObjects(
  env: MediaEnv,
  objectKeys: string[],
): Promise<void> {
  try {
    await Promise.allSettled(objectKeys.map((key) => mediaBucket(env).delete(key)))
  } catch {
    // Every result key includes the unique claimed job version. A later Cron
    // retry neither references nor overwrites this attempt's keys.
  }
}

async function findProviderJob(env: MediaEnv, taskId: string): Promise<MediaProviderJobRow | null> {
  return env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM media_provider_jobs WHERE task_id = ?`)
    .bind(taskId).first<MediaProviderJobRow>()
}

async function requiredProviderJob(env: MediaEnv, taskId: string): Promise<MediaProviderJobRow> {
  const job = await findProviderJob(env, taskId)
  if (job === null) throw new Error('Media provider job was not found')
  return job
}

async function readManifest(env: MediaEnv, task: MediaTaskRow): Promise<MediaManifest> {
  const object = await mediaBucket(env).get(task.input_object_key)
  if (object === null) throw new Error('Media input manifest is unavailable')
  if (object.size > 32 * 1024 * 1024) throw new Error('Media input manifest exceeded its storage limit')
  const parsed: unknown = JSON.parse(await object.text())
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as MediaManifest).items)) {
    throw new Error('Media input manifest is invalid')
  }
  return parsed as MediaManifest
}

function accountResolver(env: MediaEnv) {
  return env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER ?? geminiMediaProviderJobAccounts
}

function batchClient(env: MediaEnv) {
  return env.MEDIA_PROVIDER_JOB_CLIENT ?? createGeminiBatchClient()
}

function mediaBucket(env: MediaEnv): R2Bucket {
  return env.MEDIA_OBJECTS ?? env.OBJECTS
}

function terminalTask(task: MediaTaskRow): boolean {
  return ['completed', 'failed', 'cancelled', 'output_deleted'].includes(task.status)
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 128)
  }
  return error instanceof Error ? error.name.slice(0, 128) : 'MEDIA_PROVIDER_JOB_ERROR'
}

async function binarySha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
