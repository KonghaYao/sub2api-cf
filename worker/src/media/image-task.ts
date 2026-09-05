import type { Context } from 'hono'
import type { Env, PlatformEvent } from '../env'
import { asGatewayError, GatewayError, gatewayErrorResponse } from '../gateway/errors'
import { authenticateGatewayRequest } from '../gateway/repository'
import type { GatewayPrincipal } from '../gateway/types'
import {
  executeSyncImagesForPrincipal,
  moderateSyncImageRequest,
  parseSyncImageRequest,
  type SyncImageEnv,
} from './sync-handler'
import type { SyncImageOperation } from './sync-domain'
import { resolveImageAsset } from './image-asset'

const TASK_TTL_MS = 24 * 60 * 60_000
const STALE_RUNNING_MS = 30 * 60_000

type Bindings = { Bindings: SyncImageEnv }

interface ImageTaskRow {
  id: string
  user_id: string
  api_key_id: string
  group_id: string
  operation: SyncImageOperation
  status: 'queued' | 'running' | 'completed' | 'failed' | 'deleting'
  input_object_key: string
  input_content_type: string
  principal_json: string
  result_object_key: string | null
  error_json: string | null
  http_status: number | null
  attempt_token: string | null
  version: number
  created_at_ms: number
  updated_at_ms: number
  started_at_ms: number | null
  completed_at_ms: number | null
  expires_at_ms: number
}

interface ImageTaskExecutePayload { task_id: string }
type ImageTaskExecuteEvent = PlatformEvent<ImageTaskExecutePayload>

const TASK_COLUMNS = `id,user_id,api_key_id,group_id,operation,status,input_object_key,
  input_content_type,principal_json,result_object_key,error_json,http_status,attempt_token,version,created_at_ms,updated_at_ms,
  started_at_ms,completed_at_ms,expires_at_ms`

export async function submitAsyncImageTask(
  context: Context<Bindings>,
  operation: SyncImageOperation,
): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const source = context.req.raw
    const validation = source.clone()
    const manifest = await parseSyncImageRequest(validation as unknown as Request, operation)
    if (manifest.options.stream === true) {
      throw new GatewayError(400, 'IMAGE_ASYNC_STREAM_UNSUPPORTED', 'streaming image requests cannot be submitted as asynchronous tasks')
    }
    await requireAsyncImageGroup(context.env, principal)
    await moderateSyncImageRequest(context.env, principal, manifest)
    const body = new Uint8Array(await source.arrayBuffer())
    const taskId = `imgtask_${crypto.randomUUID().replaceAll('-', '')}`
    const objectKey = imageTaskInputKey(context.env, taskId)
    const now = Date.now()
    const contentType = source.headers.get('content-type') ?? 'application/json'
    await context.env.OBJECTS.put(objectKey, bytesBuffer(body), {
      httpMetadata: { contentType },
      customMetadata: { taskId },
    })
    try {
      await context.env.DB.prepare(
        `INSERT INTO image_tasks (
           id,user_id,api_key_id,group_id,operation,status,input_object_key,input_content_type,principal_json,
           created_at_ms,updated_at_ms,expires_at_ms
         ) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?)`,
      ).bind(
        taskId, principal.user_id, principal.api_key_id, principal.group_id,
        operation, objectKey, contentType, JSON.stringify(principal), now, now, now + TASK_TTL_MS,
      ).run()
    } catch (error) {
      await bestEffort(() => context.env.OBJECTS.delete(objectKey))
      throw error
    }
    // The D1 row is authoritative. A lost send is recovered by the scheduler.
    await bestEffort(() => enqueueImageTask(context.env, taskId))
    const pollUrl = pollPath(source, taskId)
    return Response.json(await publicTask(context.env, {
      id: taskId,
      status: 'queued',
      created_at_ms: now,
      expires_at_ms: now + TASK_TTL_MS,
    }, pollUrl), {
      status: 202,
      headers: { 'cache-control': 'no-store', location: pollUrl, 'retry-after': '3' },
    })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function getAsyncImageTask(context: Context<Bindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const task = await ownedTask(context.env, principal, taskIdParam(context))
    const response = await publicTask(context.env, task, pollPath(context.req.raw, task.id))
    return Response.json(response, {
      headers: {
        'cache-control': 'no-store',
        ...(task.status === 'queued' || task.status === 'running' ? { 'retry-after': '3' } : {}),
      },
    })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function getAsyncImageTaskContent(context: Context<Bindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const taskId = taskIdParam(context)
    const task = await ownedTask(context.env, principal, taskId)
    if (task.status !== 'completed') throw notFound()
    const imageIndex = boundedIndex(context.req.param('index'))
    const output = await context.env.DB.prepare(
      'SELECT object_key,mime_type FROM image_task_outputs WHERE task_id = ? AND image_index = ?',
    ).bind(taskId, imageIndex).first<{ object_key: string; mime_type: string }>()
    if (output === null) throw notFound()
    const object = await context.env.OBJECTS.get(output.object_key)
    if (object === null) throw notFound()
    return new Response(object.body, {
      headers: {
        'content-type': output.mime_type,
        'cache-control': 'private, no-store',
        'content-disposition': `inline; filename="image-${imageIndex}.${extension(output.mime_type)}"`,
      },
    })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export function createImageTaskExecuteEvent(taskId: string, now = Date.now()): ImageTaskExecuteEvent {
  return {
    schema_version: 1,
    event_id: `image-task:${taskId}`,
    event_type: 'image.task.execute.v1',
    occurred_at_ms: now,
    aggregate_type: 'image_task',
    aggregate_id: taskId,
    payload: { task_id: taskId },
  }
}

export function isImageTaskExecuteEvent(value: unknown): value is ImageTaskExecuteEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<ImageTaskExecuteEvent>
  return event.schema_version === 1 && event.event_type === 'image.task.execute.v1' &&
    event.aggregate_type === 'image_task' && typeof event.aggregate_id === 'string' &&
    event.payload?.task_id === event.aggregate_id && event.event_id === `image-task:${event.aggregate_id}`
}

export async function consumeImageTaskExecute(value: unknown, env: Env): Promise<boolean> {
  if (!isImageTaskExecuteEvent(value)) return false
  const task = await findTask(env, value.payload.task_id)
  if (task === null || task.status === 'completed' || task.status === 'failed') return true
  const attemptToken = crypto.randomUUID().replaceAll('-', '')
  const now = Date.now()
  const claimed = await env.DB.prepare(
    `UPDATE image_tasks SET status='running',attempt_token=?,started_at_ms=?,updated_at_ms=?,version=version+1
      WHERE id=? AND status='queued'`,
  ).bind(attemptToken, now, now, task.id).run()
  if ((claimed.meta.changes ?? 0) !== 1) return true

  let inputObject: R2ObjectBody | null
  try {
    inputObject = await env.OBJECTS.get(task.input_object_key)
  } catch (error) {
    await requeueClaimedTask(env, task.id, attemptToken)
    throw error
  }
  if (inputObject === null) {
    await failClaimedTask(env, task.id, attemptToken, 500, 'IMAGE_TASK_INPUT_MISSING', 'Image task input is unavailable')
    return true
  }
  let principal: GatewayPrincipal
  try {
    principal = JSON.parse(task.principal_json) as GatewayPrincipal
    validateStoredPrincipal(principal, task)
  } catch {
    await failClaimedTask(env, task.id, attemptToken, 500, 'IMAGE_TASK_INPUT_INVALID', 'Image task input is invalid')
    return true
  }
  let body: ArrayBuffer
  try {
    body = await inputObject.arrayBuffer()
  } catch (error) {
    await requeueClaimedTask(env, task.id, attemptToken)
    throw error
  }

  const background: Promise<unknown>[] = []
  const request = new Request(`https://image-task.internal/v1/images/${task.operation}`, {
    method: 'POST',
    headers: { 'content-type': task.input_content_type },
    body,
  })
  const response = await executeSyncImagesForPrincipal({
    env,
    request,
    operation: task.operation,
    principal,
    waitUntil: (promise) => background.push(promise),
    moderationChecked: true,
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  await Promise.allSettled(background)
  if (!response.ok) {
    const envelope = safeJson(bytes)
    const error = record(envelope)?.error ?? { type: 'api_error', code: 'IMAGE_TASK_FAILED', message: 'Image generation failed' }
    await failClaimedTask(env, task.id, attemptToken, response.status, String(record(error)?.code ?? 'IMAGE_TASK_FAILED'), error)
    return true
  }
  try {
    const result = await offloadResult(env, task, bytes)
    const completedAt = Date.now()
    const resultObjectKey = imageTaskResultKey(env, task.id)
    await env.OBJECTS.put(resultObjectKey, JSON.stringify(result), {
      httpMetadata: { contentType: 'application/json' }, customMetadata: { taskId: task.id },
    })
    const completed = await env.DB.prepare(
      `UPDATE image_tasks SET status='completed',result_object_key=?,http_status=?,completed_at_ms=?,
         updated_at_ms=?,expires_at_ms=?,version=version+1
       WHERE id=? AND status='running' AND attempt_token=?`,
    ).bind(resultObjectKey, response.status, completedAt, completedAt, completedAt + TASK_TTL_MS, task.id, attemptToken).run()
    if ((completed.meta.changes ?? 0) !== 1) {
      const current = await findTask(env, task.id)
      if (current?.status !== 'completed') await cleanupGeneratedResult(env, task.id)
    } else {
      await bestEffort(() => env.OBJECTS.delete(task.input_object_key))
    }
  } catch {
    const failed = await failClaimedTask(
      env, task.id, attemptToken, 502, 'IMAGE_TASK_OFFLOAD_FAILED', 'Failed to store generated image',
    )
    if (failed) await cleanupGeneratedResult(env, task.id)
  }
  return true
}

export async function recoverImageTasks(
  env: Env,
  limit = 25,
): Promise<{ enqueued: number; failed: number; deleted: number }> {
  const now = Date.now()
  const stale = await env.DB.prepare(
    `SELECT id,attempt_token,input_object_key FROM image_tasks
      WHERE status='running' AND updated_at_ms < ? ORDER BY updated_at_ms LIMIT ?`,
  ).bind(now - STALE_RUNNING_MS, limit).all<{
    id: string
    attempt_token: string | null
    input_object_key: string
  }>()
  let failed = 0
  for (const task of stale.results) {
    const result = await env.DB.prepare(
      `UPDATE image_tasks SET status='failed',http_status=504,error_json=?,completed_at_ms=?,updated_at_ms=?,
         expires_at_ms=?,version=version+1 WHERE id=? AND status='running' AND attempt_token IS ?`,
    ).bind(
      JSON.stringify({ type: 'timeout_error', code: 'IMAGE_TASK_TIMEOUT', message: 'Image generation task timed out' }),
      now, now, now + TASK_TTL_MS, task.id, task.attempt_token,
    ).run()
    const changes = result.meta.changes ?? 0
    failed += changes
    if (changes === 1) await bestEffort(() => env.OBJECTS.delete(task.input_object_key))
  }
  const queued = await env.DB.prepare(
    `SELECT id FROM image_tasks WHERE status='queued' ORDER BY updated_at_ms LIMIT ?`,
  ).bind(limit).all<{ id: string }>()
  let enqueued = 0
  for (const task of queued.results) {
    try { await enqueueImageTask(env, task.id); enqueued += 1 } catch { /* next cron retries */ }
  }
  const expired = await env.DB.prepare(
    `SELECT id FROM image_tasks
      WHERE expires_at_ms <= ? AND status IN ('queued','completed','failed','deleting')
      ORDER BY expires_at_ms LIMIT ?`,
  ).bind(now, limit).all<{ id: string }>()
  let deleted = 0
  for (const task of expired.results) {
    if (await claimExpiredTask(env, task.id, now) === false) continue
    try {
      await deleteImageTaskObjects(env, task.id)
      const result = await env.DB.prepare(
        "DELETE FROM image_tasks WHERE id=? AND expires_at_ms <= ? AND status='deleting'",
      ).bind(task.id, now).run()
      deleted += result.meta.changes ?? 0
    } catch {
      // Keep the D1 row so the next scheduled pass can finish R2 cleanup.
    }
  }
  return { enqueued, failed, deleted }
}

async function deleteImageTaskObjects(env: Env, taskId: string): Promise<void> {
  const prefix = imageTaskPrefix(env, taskId)
  let cursor: string | undefined
  do {
    const page = await env.OBJECTS.list({ prefix, ...(cursor === undefined ? {} : { cursor }) })
    for (const object of page.objects) await env.OBJECTS.delete(object.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
}

async function cleanupGeneratedResult(env: Env, taskId: string): Promise<void> {
  await bestEffort(async () => {
    await env.DB.prepare('DELETE FROM image_task_outputs WHERE task_id=?').bind(taskId).run()
  })
  const prefix = `${imageTaskPrefix(env, taskId)}outputs/`
  await bestEffort(async () => {
    let cursor: string | undefined
    do {
      const page = await env.OBJECTS.list({ prefix, ...(cursor === undefined ? {} : { cursor }) })
      for (const object of page.objects) await env.OBJECTS.delete(object.key)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor !== undefined)
  })
  await bestEffort(() => env.OBJECTS.delete(imageTaskResultKey(env, taskId)))
}

async function enqueueImageTask(env: Env, taskId: string): Promise<void> {
  await env.EVENTS_QUEUE.send(createImageTaskExecuteEvent(taskId))
}

async function requeueClaimedTask(env: Env, taskId: string, token: string): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE image_tasks SET status='queued',attempt_token=NULL,started_at_ms=NULL,
       updated_at_ms=?,version=version+1 WHERE id=? AND status='running' AND attempt_token=?`,
  ).bind(now, taskId, token).run()
}

async function claimExpiredTask(env: Env, taskId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE image_tasks SET status='deleting',updated_at_ms=?,version=version+1
      WHERE id=? AND expires_at_ms <= ? AND status IN ('queued','completed','failed','deleting')`,
  ).bind(now, taskId, now).run()
  return (result.meta.changes ?? 0) === 1
}

async function requireAsyncImageGroup(env: Env, principal: GatewayPrincipal): Promise<void> {
  if (
    principal.platform !== 'openai' &&
    principal.platform !== 'codex' &&
    principal.platform !== 'composite'
  ) {
    throw new GatewayError(404, 'IMAGE_ASYNC_NOT_SUPPORTED', 'Asynchronous Images is not available for this group')
  }
  const group = await env.DB.prepare(
    'SELECT allow_image_generation FROM "groups" WHERE id=?',
  ).bind(principal.group_id).first<{ allow_image_generation: number }>()
  if (group?.allow_image_generation !== 1) {
    throw new GatewayError(
      403,
      'IMAGE_GENERATION_DISABLED',
      'Image generation is not enabled for this API key group',
      'permission_error',
    )
  }
}

async function offloadResult(env: Env, task: ImageTaskRow, bytes: Uint8Array): Promise<unknown> {
  const value = safeJson(bytes)
  const root = record(value)
  if (root === null || !Array.isArray(root.data)) throw new Error('invalid Images response')
  const data: unknown[] = []
  const statements: D1PreparedStatement[] = []
  const uploadedKeys: string[] = []
  let imageIndex = 0
  try {
    for (const candidate of root.data) {
      const item = record(candidate)
      if (item === null) throw new Error('invalid image output')
      const image = await resolveImageAsset(item, env)
      const mime = image.mime
      const objectKey = imageTaskOutputKey(env, task.id, imageIndex, mime)
      await env.OBJECTS.put(objectKey, image.bytes, {
        httpMetadata: { contentType: mime }, customMetadata: { taskId: task.id, imageIndex: String(imageIndex) },
      })
      uploadedKeys.push(objectKey)
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO image_task_outputs(task_id,image_index,object_key,mime_type,byte_length,created_at_ms)
         VALUES(?,?,?,?,?,?)`,
      ).bind(task.id, imageIndex, objectKey, mime, image.bytes.byteLength, Date.now()))
      const { b64_json: _removed, ...rest } = item
      data.push({ ...rest, url: `/v1/images/tasks/${task.id}/content/${imageIndex}` })
      imageIndex += 1
    }
    if (imageIndex === 0) throw new Error('image output missing')
    if (statements.length > 0) await env.DB.batch(statements)
    return { ...root, data }
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => bestEffort(() => env.OBJECTS.delete(key))))
    throw error
  }
}

async function failClaimedTask(
  env: Env, taskId: string, token: string, status: number, code: string, error: unknown,
): Promise<boolean> {
  const now = Date.now()
  const task = await env.DB.prepare(
    'SELECT input_object_key FROM image_tasks WHERE id=?',
  ).bind(taskId).first<{ input_object_key: string }>()
  const source = record(error)
  const payload = source === null
    ? { type: 'api_error', code, message: String(error) }
    : { ...source, code: typeof source.code === 'string' ? source.code : code }
  const result = await env.DB.prepare(
    `UPDATE image_tasks SET status='failed',error_json=?,http_status=?,completed_at_ms=?,updated_at_ms=?,
       expires_at_ms=?,version=version+1 WHERE id=? AND status='running' AND attempt_token=?`,
  ).bind(JSON.stringify(payload), status, now, now, now + TASK_TTL_MS, taskId, token).run()
  if ((result.meta.changes ?? 0) === 1 && task !== null) {
    await bestEffort(() => env.OBJECTS.delete(task.input_object_key))
  }
  return (result.meta.changes ?? 0) === 1
}

async function ownedTask(env: Env, principal: GatewayPrincipal, id: string): Promise<ImageTaskRow> {
  const task = await findTask(env, id)
  if (
    task === null || task.status === 'deleting' ||
    task.user_id !== principal.user_id || task.api_key_id !== principal.api_key_id
  ) throw notFound()
  return task
}

async function findTask(env: Env, id: string): Promise<ImageTaskRow | null> {
  return env.DB.prepare(`SELECT ${TASK_COLUMNS} FROM image_tasks WHERE id=?`).bind(id).first<ImageTaskRow>()
}

async function publicTask(env: Env, task: Partial<ImageTaskRow> & { id: string; status: string; created_at_ms: number; expires_at_ms: number }, pollUrl: string): Promise<unknown> {
  let result: unknown
  if (task.result_object_key !== null && task.result_object_key !== undefined) {
    const object = await env.OBJECTS.get(task.result_object_key)
    if (object === null) throw new GatewayError(503, 'IMAGE_TASK_RESULT_UNAVAILABLE', 'image task result is unavailable')
    result = await object.json<unknown>()
  }
  const error = task.error_json === null || task.error_json === undefined ? undefined : JSON.parse(task.error_json)
  const firstUrl = Array.isArray(record(result)?.data) ? String(record(record(result)?.data?.[0])?.url ?? '') : ''
  const publicStatus = task.status === 'queued' || task.status === 'running' ? 'processing' : task.status
  return {
    id: task.id, task_id: task.id, object: 'image.generation.task', status: publicStatus,
    created_at: Math.floor(task.created_at_ms / 1_000), expires_at: Math.floor(task.expires_at_ms / 1_000),
    poll_url: pollUrl,
    ...(task.http_status == null ? {} : { http_status: task.http_status }),
    ...(task.completed_at_ms == null ? {} : { completed_at: Math.floor(task.completed_at_ms / 1_000) }),
    ...(result === undefined ? {} : { result }), ...(firstUrl === '' ? {} : { image_url: firstUrl }),
    ...(error === undefined ? {} : { error }),
  }
}

function validateStoredPrincipal(principal: GatewayPrincipal, task: ImageTaskRow): void {
  if (principal?.user_id !== task.user_id || principal.api_key_id !== task.api_key_id ||
    principal.group_id !== task.group_id) throw new Error('invalid task principal')
}

function pollPath(request: Request, id: string): string {
  return new URL(request.url).pathname.startsWith('/v1/') ? `/v1/images/tasks/${id}` : `/images/tasks/${id}`
}

function taskIdParam(context: Context<Bindings>): string {
  const id = context.req.param('id') ?? ''
  if (!/^imgtask_[a-f0-9]{32}$/.test(id)) throw notFound()
  return id
}

function boundedIndex(value: string | undefined): number {
  if (value === undefined || !/^\d{1,2}$/.test(value)) throw notFound()
  const index = Number(value)
  if (index > 99) throw notFound()
  return index
}

function imageTaskPrefix(env: Env, id: string): string { return `${env.ENVIRONMENT}/image-tasks/${id}/` }
function imageTaskInputKey(env: Env, id: string): string { return `${imageTaskPrefix(env, id)}input.bin` }
function imageTaskResultKey(env: Env, id: string): string { return `${imageTaskPrefix(env, id)}result.json` }
function imageTaskOutputKey(env: Env, id: string, index: number, mime: string): string {
  return `${imageTaskPrefix(env, id)}outputs/${index}.${extension(mime)}`
}
function extension(mime: string): string { return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png' }
function safeJson(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder().decode(bytes)) }
function record(value: unknown): Record<string, any> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null }
function bytesBuffer(bytes: Uint8Array): ArrayBuffer { const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); return copy.buffer }
function notFound(): GatewayError { return new GatewayError(404, 'IMAGE_TASK_NOT_FOUND', 'image task not found', 'not_found_error') }
async function bestEffort(action: () => Promise<unknown>): Promise<void> { try { await action() } catch { /* scheduled recovery owns it */ } }
