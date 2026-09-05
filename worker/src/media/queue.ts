import { GatewayError } from '../gateway/errors'
import { resolveSessionMediaPrincipal } from './auth'
import { mediaBilling, mediaBillingRequestId } from './billing'
import { fileExtension, mediaObjectPrefix } from './domain'
import { geminiMediaProvider } from './provider'
import {
  appendMediaEvent,
  claimMediaTask,
  claimNextMediaTaskItem,
  completeMediaTaskItemUnit,
  failMediaTaskItemAttempt,
  findMediaTask,
  listRecoverableMediaTasks,
  markMediaTaskEnqueued,
  markMediaTaskReserved,
  mediaTaskAggregate,
  releaseMediaTaskItemAttempt,
  transitionMediaTask,
} from './repository'
import type { MediaEnv, MediaManifest, MediaTaskExecuteEvent, MediaTaskRow } from './types'

const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024
const ITEM_LEASE_MS = 2 * 60 * 1_000
const MAX_ITEM_ATTEMPTS = 5

export function createMediaTaskExecuteEvent(
  taskId: string,
  occurredAtMs = Date.now(),
): MediaTaskExecuteEvent {
  return {
    schema_version: 1,
    event_id: `media-execute:${taskId}`,
    event_type: 'media.task.execute.v1',
    occurred_at_ms: occurredAtMs,
    aggregate_type: 'media_task',
    aggregate_id: taskId,
    payload: { task_id: taskId },
  }
}

export function isMediaTaskExecuteEvent(value: unknown): value is MediaTaskExecuteEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<MediaTaskExecuteEvent>
  return event.schema_version === 1 &&
    event.event_type === 'media.task.execute.v1' &&
    event.aggregate_type === 'media_task' &&
    typeof event.aggregate_id === 'string' && event.aggregate_id !== '' &&
    event.payload?.task_id === event.aggregate_id
}

export async function enqueueMediaTask(env: MediaEnv, taskId: string, now = Date.now()): Promise<void> {
  await env.EVENTS_QUEUE.send(createMediaTaskExecuteEvent(taskId, now))
}

/**
 * Executes at most one upstream image call. Larger batches continue through a
 * fresh Queue message, keeping Worker memory and wall time bounded.
 */
export async function consumeMediaTaskExecute(value: unknown, env: MediaEnv): Promise<boolean> {
  if (!isMediaTaskExecuteEvent(value)) return false
  const taskId = value.payload.task_id
  let task = await findMediaTask(env, taskId)
  if (task === null || task.execution_mode !== 'inline_v1' || terminal(task)) return true
  if (task.status === 'queued') {
    await claimMediaTask(env, task.id, Date.now())
    task = await findMediaTask(env, task.id)
  }
  if (task?.status === 'settling') {
    await settleMediaTask(env, task)
    return true
  }
  if (task?.status !== 'running') return true

  const now = Date.now()
  const attemptToken = crypto.randomUUID().replaceAll('-', '')
  const item = await claimNextMediaTaskItem(env, task.id, attemptToken, now, now - ITEM_LEASE_MS)
  if (item === null) {
    await finishOrAwaitMediaTask(env, task.id)
    return true
  }
  let manifest: MediaManifest
  try {
    manifest = await readManifest(env, task)
    const source = manifest.items.find((candidate) => candidate.custom_id === item.custom_id)
    if (source === undefined) throw new Error('Media input manifest no longer matches D1')
    const result = await (env.MEDIA_PROVIDER ?? geminiMediaProvider).generate({
      env,
      task,
      manifest: { ...manifest, items: [{ ...source, output_count: 1 }] },
    })
    const itemResult = result.items.find((candidate) => candidate.customId === item.custom_id)
    if (itemResult?.error !== undefined) {
      await failMediaTaskItemAttempt(
        env, task.id, item.custom_id, attemptToken,
        itemResult.error.code, itemResult.error.message, Date.now(),
      )
    } else {
      const output = itemResult?.outputs?.[0]
      if (output === undefined || itemResult?.outputs?.length !== 1) {
        await failMediaTaskItemAttempt(
          env, task.id, item.custom_id, attemptToken,
          'BATCH_IMAGE_PROVIDER_OUTPUT_MISSING', 'The image provider returned no usable output', Date.now(),
        )
      } else {
        if (result.accountId === undefined || result.accountId === '') {
          throw new Error('Media provider did not identify its billed account')
        }
        const bytes = new Uint8Array(output.bytes)
        if (bytes.byteLength === 0 || bytes.byteLength > OUTPUT_LIMIT_BYTES) {
          await failMediaTaskItemAttempt(
            env, task.id, item.custom_id, attemptToken,
            'BATCH_IMAGE_PROVIDER_OUTPUT_TOO_LARGE', 'The generated image exceeded the Worker output limit', Date.now(),
          )
        } else {
          const extension = fileExtension(output.mimeType)
          const imageIndex = item.image_count
          const objectKey = `${mediaObjectPrefix(env.ENVIRONMENT, task.id)}/outputs/${item.ordinal}-${imageIndex}.${extension}`
          await mediaBucket(env).put(objectKey, bytes, {
            httpMetadata: { contentType: output.mimeType },
            customMetadata: { taskId: task.id, customId: item.custom_id, imageIndex: String(imageIndex) },
          })
          const persisted = await completeMediaTaskItemUnit(env, {
            taskId: task.id,
            customId: item.custom_id,
            attemptToken,
            imageIndex,
            objectKey,
            mimeType: output.mimeType,
            fileExtension: extension,
            byteLength: bytes.byteLength,
            sha256: await binarySha256Hex(output.bytes),
            providerAccountId: result.accountId,
            now: Date.now(),
          })
          if (!persisted) await bestEffort(() => mediaBucket(env).delete(objectKey))
        }
      }
    }
  } catch (error) {
    if (item.attempt_count >= MAX_ITEM_ATTEMPTS) {
      await failMediaTaskItemAttempt(
        env,
        task.id,
        item.custom_id,
        attemptToken,
        'BATCH_IMAGE_PROCESSING_FAILED',
        'Image generation failed after the maximum retry count',
        Date.now(),
      )
      await continueOrFinishMediaTask(env, task.id)
      return true
    }
    await releaseMediaTaskItemAttempt(env, task.id, item.custom_id, attemptToken)
    throw error
  }
  await continueOrFinishMediaTask(env, task.id)
  return true
}

/** Handles a Cloudflare Queue batch while preserving per-message retry semantics. */
export async function consumeMediaTaskMessages(batch: MessageBatch<unknown>, env: MediaEnv): Promise<void> {
  for (const message of batch.messages) {
    if (!isMediaTaskExecuteEvent(message.body)) continue
    try {
      await consumeMediaTaskExecute(message.body, env)
      message.ack()
    } catch {
      message.retry()
    }
  }
}

export interface MediaRecoveryResult {
  scanned: number
  reserved: number
  enqueued: number
  settled: number
  released: number
  failed: number
}

/** Captures already-produced images on cancellation and releases any unused hold. */
export async function settleCancelledMediaTask(env: MediaEnv, original: MediaTaskRow): Promise<void> {
  if (original.status !== 'cancelled' || ['settled', 'released'].includes(original.billing_status)) return
  const aggregate = await mediaTaskAggregate(env, original.id)
  const actualCost = aggregate.successCount * original.billable_unit_price_micros
  const now = Date.now()
  if (aggregate.successCount === 0) {
    if (original.billing_status === 'reserved') await mediaBilling(env).cancel({ env, task: original })
    await transitionMediaTask(env, original.id, ['cancelled'], 'cancelled', {
      billingStatus: 'released',
      actualCostMicros: 0,
      successCount: 0,
      failCount: aggregate.failCount,
      cancelledCount: aggregate.cancelledCount,
      settledAtMs: now,
    }, now)
    return
  }
  let task = original
  if (task.billing_status === 'reserved') {
    await transitionMediaTask(env, task.id, ['cancelled'], 'cancelled', {
      billingStatus: 'settling',
      actualCostMicros: actualCost,
      successCount: aggregate.successCount,
      failCount: aggregate.failCount,
      cancelledCount: aggregate.cancelledCount,
    }, now)
    task = await requiredTask(env, task.id)
  }
  if (task.billing_status !== 'settling' || task.actual_cost_micros === null) return
  await mediaBilling(env).settle({ env, task, amountMicros: task.actual_cost_micros, occurredAtMs: Date.now() })
  await transitionMediaTask(env, task.id, ['cancelled'], 'cancelled', {
    billingStatus: 'settled',
    settledAtMs: Date.now(),
  }, Date.now())
}

/** Bounded cron recovery for D1 commits that lost their Queue or settlement side effect. */
export async function recoverPendingMediaTasks(env: MediaEnv, limit = 25): Promise<MediaRecoveryResult> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 25
  const tasks = await listRecoverableMediaTasks(env, bounded, Date.now() - ITEM_LEASE_MS)
  const result: MediaRecoveryResult = {
    scanned: tasks.length, reserved: 0, enqueued: 0, settled: 0, released: 0, failed: 0,
  }
  for (const original of tasks) {
    try {
      let task = original
      if (task.status === 'created') {
        const principal = await resolveSessionMediaPrincipal(env, task.user_id, task.api_key_id)
        await mediaBilling(env).reserve({
          env,
          principal,
          requestId: mediaBillingRequestId(task.id),
          amountMicros: task.hold_amount_micros,
        })
        await markMediaTaskReserved(env, task.id, Date.now())
        result.reserved += 1
        task = await requiredTask(env, task.id)
      }
      if (task.status === 'queued' || task.status === 'running') {
        await enqueueMediaTask(env, task.id)
        await markMediaTaskEnqueued(env, task.id, Date.now())
        result.enqueued += 1
      } else if (task.status === 'settling') {
        await settleMediaTask(env, task)
        result.settled += 1
      } else if (task.status === 'cancelled') {
        await settleCancelledMediaTask(env, task)
        result.released += 1
      }
    } catch {
      result.failed += 1
    }
  }
  return result
}

async function continueOrFinishMediaTask(env: MediaEnv, taskId: string): Promise<void> {
  const aggregate = await mediaTaskAggregate(env, taskId)
  if (aggregate.pendingCount > 0) {
    await enqueueMediaTask(env, taskId)
    return
  }
  await finishOrAwaitMediaTask(env, taskId)
}

export async function finishOrAwaitMediaTask(env: MediaEnv, taskId: string): Promise<void> {
  const task = await requiredTask(env, taskId)
  if (task.status !== 'running') return
  const aggregate = await mediaTaskAggregate(env, taskId)
  if (aggregate.pendingCount > 0) return
  const now = Date.now()
  const actualCost = aggregate.successCount * task.billable_unit_price_micros
  if (aggregate.successCount === 0) {
    await mediaBilling(env).cancel({ env, task })
    await transitionMediaTask(env, task.id, ['running'], 'completed', {
      billingStatus: 'released',
      actualCostMicros: 0,
      successCount: 0,
      failCount: aggregate.failCount,
      cancelledCount: aggregate.cancelledCount,
      errorCode: 'BATCH_IMAGE_ALL_ITEMS_FAILED',
      errorMessage: 'All image generation items failed',
      finishedAtMs: now,
      settledAtMs: now,
    }, now)
    await appendMediaEvent(env, task.id, 'completed', {
      success_count: 0,
      fail_count: aggregate.failCount,
      actual_cost_micros: 0,
    }, now)
    return
  }
  const changed = await transitionMediaTask(env, task.id, ['running'], 'settling', {
    billingStatus: 'settling',
    actualCostMicros: actualCost,
    successCount: aggregate.successCount,
    failCount: aggregate.failCount,
    cancelledCount: aggregate.cancelledCount,
  }, now)
  if (!changed) return
  await settleMediaTask(env, await requiredTask(env, task.id))
}

export async function settleMediaTask(env: MediaEnv, task: MediaTaskRow): Promise<void> {
  if (task.status !== 'settling' || task.actual_cost_micros === null) return
  const now = Date.now()
  await mediaBilling(env).settle({ env, task, amountMicros: task.actual_cost_micros, occurredAtMs: now })
  if (await transitionMediaTask(env, task.id, ['settling'], 'completed', {
    billingStatus: 'settled', settledAtMs: now, finishedAtMs: now,
  }, now)) {
    await appendMediaEvent(env, task.id, 'completed', {
      success_count: task.success_count,
      fail_count: task.fail_count,
      actual_cost_micros: task.actual_cost_micros,
    }, now)
  }
}

async function readManifest(env: MediaEnv, task: MediaTaskRow): Promise<MediaManifest> {
  const object = await mediaBucket(env).get(task.input_object_key)
  if (object === null) throw new GatewayError(500, 'BATCH_IMAGE_INPUT_MISSING', 'Batch input is unavailable', 'server_error')
  const declaredSize = typeof object.size === 'number' ? object.size : 0
  if (declaredSize > 32 * 1024 * 1024) throw new Error('Media manifest exceeded its storage limit')
  const text = await object.text()
  if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) throw new Error('Media manifest exceeded its storage limit')
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as MediaManifest).items)) {
    throw new Error('Media manifest is invalid')
  }
  return parsed as MediaManifest
}

async function requiredTask(env: MediaEnv, taskId: string): Promise<MediaTaskRow> {
  const task = await findMediaTask(env, taskId)
  if (task === null) throw new Error('Media task was not found')
  return task
}

function mediaBucket(env: MediaEnv): R2Bucket {
  return env.MEDIA_OBJECTS ?? env.OBJECTS
}

function terminal(task: MediaTaskRow): boolean {
  return ['completed', 'failed', 'cancelled', 'output_deleted'].includes(task.status)
}

async function bestEffort(action: () => Promise<unknown>): Promise<void> {
  try { await action() } catch { /* R2 lifecycle provides eventual orphan cleanup. */ }
}

async function binarySha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
