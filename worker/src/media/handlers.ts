import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { controlError, controlSuccess, requireIdempotencyKey } from '../control/http'
import { authenticateGatewayRequest } from '../gateway/repository'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError, gatewayErrorResponse } from '../gateway/errors'
import type { GatewayPrincipal } from '../gateway/types'
import { mediaBilling, mediaBillingRequestId } from './billing'
import { resolveSessionMediaPrincipal } from './auth'
import {
  mediaObjectPrefix,
  mediaRequestHash,
  mediaTaskId,
  parseMediaSubmit,
  publicMediaItem,
  publicMediaTask,
} from './domain'
import { enqueueMediaTask, settleCancelledMediaTask } from './queue'
import {
  createMediaTask,
  appendMediaEvent,
  cancelPendingMediaItems,
  findMediaTask,
  findMediaTaskByIdempotency,
  findOwnedMediaTask,
  listMediaTaskItems,
  listAvailableMediaModels,
  findMediaTaskOutput,
  listMediaTaskOutputs,
  listOwnedMediaTasks,
  markMediaTaskDownloaded,
  markMediaTaskEnqueued,
  markMediaTaskReserved,
  resolveMediaPricing,
  removeMediaTaskOutputs,
  softDeleteMediaTask,
  transitionMediaTask,
} from './repository'
import type { MediaEnv, MediaTaskOwner, MediaTaskRow } from './types'
import { MAX_MEDIA_ZIP_BYTES, streamMediaZip } from './zip'

type Bindings = { Bindings: MediaEnv }
const MAX_MEDIA_REQUEST_BYTES = 32 * 1024 * 1024

export async function submitGatewayMediaTask(context: Context<Bindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const body = await readMediaJsonBody(context.req.raw)
    return mediaJson(await submitMediaTask(context, principal, body))
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

/** First-party alias for API keys whose plaintext secret is no longer available. */
export async function submitUserMediaTask(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readMediaJsonBody(context.req.raw)
    const apiKeyId = requiredApiKeyId(body.api_key_id)
    const principal = await resolveSessionMediaPrincipal(context.env, user.id, apiKeyId)
    return controlSuccess(await submitMediaTask(context, principal, body))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getGatewayMediaTask(context: Context<Bindings>): Promise<Response> {
  return gatewayOwnerResponse(context, async (owner) => {
    const task = await requireOwnedTask(context.env, owner, taskParam(context))
    return mediaJson(publicMediaTask(task))
  })
}

export async function getUserMediaTask(context: Context<Bindings>): Promise<Response> {
  return sessionOwnerResponse(context, async (owner) => {
    const task = await requireOwnedTask(context.env, owner, taskParam(context))
    await resolveSessionMediaPrincipal(context.env, owner.userId, task.api_key_id)
    return controlSuccess(publicMediaTask(task))
  })
}

export async function listGatewayMediaTasks(context: Context<Bindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    return mediaJson(await listTasks(context, { userId: principal.user_id, apiKeyId: principal.api_key_id }))
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function listUserMediaTasks(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const apiKeyId = requiredApiKeyId(context.req.query('api_key_id'))
    await resolveSessionMediaPrincipal(context.env, user.id, apiKeyId)
    return controlSuccess(await listTasks(context, { userId: user.id, apiKeyId }))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listGatewayMediaTaskItems(context: Context<Bindings>): Promise<Response> {
  return gatewayOwnerResponse(context, async (owner) => {
    const task = await requireOwnedTask(context.env, owner, taskParam(context))
    return mediaJson(await listTaskItems(context, task))
  })
}

export async function listUserMediaTaskItems(context: Context<Bindings>): Promise<Response> {
  return sessionOwnerResponse(context, async (owner) => {
    const task = await requireSessionTask(context.env, owner.userId, taskParam(context))
    return controlSuccess(await listTaskItems(context, task))
  })
}

export async function cancelGatewayMediaTask(context: Context<Bindings>): Promise<Response> {
  return gatewayOwnerResponse(context, async (owner) => mediaJson(await cancelTask(context, owner)))
}

export async function cancelUserMediaTask(context: Context<Bindings>): Promise<Response> {
  return sessionOwnerResponse(context, async (owner) => controlSuccess(await cancelTask(context, owner)))
}

export async function listGatewayMediaModels(context: Context<Bindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    return mediaJson({ object: 'list', data: await listAvailableMediaModels(context.env, principal.group_id) })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function listUserMediaModels(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const principal = await resolveSessionMediaPrincipal(
      context.env,
      user.id,
      requiredApiKeyId(context.req.query('api_key_id')),
    )
    return controlSuccess({ object: 'list', data: await listAvailableMediaModels(context.env, principal.group_id) })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getGatewayMediaTaskItemContent(context: Context<Bindings>): Promise<Response> {
  return gatewayOwnerResponse(context, (owner) => itemContentResponse(context, owner))
}

export async function getUserMediaTaskItemContent(context: Context<Bindings>): Promise<Response> {
  return sessionOwnerResponse(context, (owner) => itemContentResponse(context, owner, true))
}

export async function downloadGatewayMediaTask(context: Context<Bindings>): Promise<Response> {
  return gatewayOwnerResponse(context, (owner) => downloadTaskResponse(context, owner))
}

export async function downloadUserMediaTask(context: Context<Bindings>): Promise<Response> {
  return sessionOwnerResponse(context, (owner) => downloadTaskResponse(context, owner, true))
}

export async function deleteGatewayMediaTaskOutputs(context: Context<Bindings>): Promise<Response> {
  return gatewayOwnerResponse(context, async (owner) => mediaJson(await deleteTaskOutputs(context, owner)))
}

export async function deleteUserMediaTaskOutputs(context: Context<Bindings>): Promise<Response> {
  return sessionOwnerResponse(context, async (owner) => controlSuccess(await deleteTaskOutputs(context, owner)))
}

export async function deleteGatewayMediaTask(context: Context<Bindings>): Promise<Response> {
  return gatewayOwnerResponse(context, (owner) => deleteTaskResponse(context, owner))
}

export async function deleteUserMediaTask(context: Context<Bindings>): Promise<Response> {
  return sessionOwnerResponse(context, (owner) => deleteTaskResponse(context, owner, true))
}

async function submitMediaTask(
  context: Context<Bindings>,
  principal: GatewayPrincipal,
  body: Record<string, unknown>,
): Promise<unknown> {
  // The first pass counts outputs without prematurely applying the Flash
  // reference limit; the authoritative upstream mapping is known after pricing.
  const preliminary = await parseMediaSubmit(body, 'pro')
  if (preliminary.manifest.parent_batch_id !== null) {
    const parent = await findOwnedMediaTask(context.env, {
      userId: principal.user_id,
      apiKeyId: principal.api_key_id,
    }, preliminary.manifest.parent_batch_id)
    if (parent === null) {
      throw new GatewayError(400, 'BATCH_IMAGE_PARENT_NOT_FOUND', 'parent_batch_id was not found for this API key')
    }
  }
  const pricing = await resolveMediaPricing(
    context.env,
    principal,
    preliminary.manifest.model,
    preliminary.manifest.image_size,
    preliminary.expectedOutputCount,
  )
  const validated = await parseMediaSubmit(body, pricing.upstreamModel)
  const manifest = { ...validated.manifest, upstream_model: pricing.upstreamModel }
  const idempotencyKey = requireIdempotencyKey(context.req.raw)
  const [idempotencyKeyHash, requestHash] = await Promise.all([
    sha256Hex(idempotencyKey),
    mediaRequestHash(withoutApiKeyId(body)),
  ])
  let task = await findMediaTaskByIdempotency(context.env, principal.api_key_id, idempotencyKeyHash)
  if (task !== null) {
    if (task.request_hash !== requestHash) {
      throw new GatewayError(409, 'idempotency_conflict', 'Idempotency key was reused with another batch request')
    }
    task = await ensureTaskReady(context.env, principal, task)
    return publicMediaTask(task)
  }

  const taskId = mediaTaskId()
  const inputObjectKey = `${mediaObjectPrefix(context.env.ENVIRONMENT, taskId)}/input.json`
  await mediaBucket(context.env).put(inputObjectKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { taskId },
  })
  try {
    await createMediaTask(context.env, {
      id: taskId,
      principal,
      manifest,
      pricing,
      expectedOutputCount: preliminary.expectedOutputCount,
      idempotencyKeyHash,
      requestHash,
      inputObjectKey,
      now: Date.now(),
    })
  } catch (error) {
    const winner = await findMediaTaskByIdempotency(context.env, principal.api_key_id, idempotencyKeyHash)
    if (winner === null) {
      await bestEffort(() => mediaBucket(context.env).delete(inputObjectKey))
      throw error
    }
    await bestEffort(() => mediaBucket(context.env).delete(inputObjectKey))
    if (winner.request_hash !== requestHash) {
      throw new GatewayError(409, 'idempotency_conflict', 'Idempotency key was reused with another batch request')
    }
    task = winner
  }
  task = await ensureTaskReady(context.env, principal, task ?? await requiredTask(context.env, taskId))
  return publicMediaTask(task)
}

async function ensureTaskReady(
  env: MediaEnv,
  principal: GatewayPrincipal,
  task: MediaTaskRow,
): Promise<MediaTaskRow> {
  if (task.user_id !== principal.user_id || task.group_id !== principal.group_id) {
    throw new GatewayError(409, 'idempotency_conflict', 'Idempotent task ownership changed')
  }
  if (task.billing_status === 'unreserved' && task.status === 'created') {
    await mediaBilling(env).reserve({
      env,
      principal,
      requestId: mediaBillingRequestId(task.id),
      amountMicros: task.hold_amount_micros,
    })
    await markMediaTaskReserved(env, task.id, Date.now())
    task = await requiredTask(env, task.id)
  }
  if (task.status === 'queued' && task.enqueued_at_ms === null) {
    await enqueueMediaTask(env, task.id)
    await markMediaTaskEnqueued(env, task.id, Date.now())
    task = await requiredTask(env, task.id)
  }
  return task
}

async function gatewayOwnerResponse(
  context: Context<Bindings>,
  action: (owner: Required<MediaTaskOwner>) => Promise<Response>,
): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    return await action({ userId: principal.user_id, apiKeyId: principal.api_key_id })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

async function sessionOwnerResponse(
  context: Context<Bindings>,
  action: (owner: MediaTaskOwner) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    return await action({ userId: user.id })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function listTasks(
  context: Context<Bindings>,
  owner: Required<MediaTaskOwner>,
): Promise<unknown> {
  const limit = boundedInteger(context.req.query('limit'), 20, 1, 100, 'limit')
  const status = context.req.query('status')?.trim()
  if (status && !publicTaskStatuses.has(status)) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_STATUS', 'Batch status filter is invalid')
  }
  const downloaded = booleanFilter(context.req.query('downloaded'))
  const fromMs = optionalDate(context.req.query('from'), 'from')
  const toMs = optionalDate(context.req.query('to'), 'to')
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_TIME_RANGE', 'from must not be after to')
  }
  const result = await listOwnedMediaTasks(context.env, owner, {
    limit,
    ...(status ? { status } : {}),
    ...(context.req.query('task_name')?.trim()
      ? { taskName: context.req.query('task_name')!.trim().slice(0, 255) }
      : {}),
    ...(downloaded === undefined ? {} : { downloaded }),
    ...(fromMs === undefined ? {} : { fromMs }),
    ...(toMs === undefined ? {} : { toMs }),
    ...cursorQuery(context.req.query('cursor')),
  })
  const last = result.rows.at(-1)
  const numericOffset = numericCursor(context.req.query('cursor'))
  return {
    object: 'list',
    data: result.rows.map(publicMediaTask),
    has_more: result.hasMore,
    next_cursor: result.hasMore && last
      ? (numericOffset === undefined
          ? encodeCursor(last.created_at_ms, last.id)
          : String(numericOffset + result.rows.length))
      : null,
  }
}

async function listTaskItems(context: Context<Bindings>, task: MediaTaskRow): Promise<unknown> {
  const status = context.req.query('status')?.trim()
  if (status && !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_ITEM_STATUS', 'Item status filter is invalid')
  }
  const items = await listMediaTaskItems(context.env, task.id, status)
  return { object: 'list', data: items.map(publicMediaItem), has_more: false }
}

async function cancelTask(
  context: Context<Bindings>,
  owner: MediaTaskOwner,
): Promise<unknown> {
  if (owner.apiKeyId === undefined) {
    return cancelTaskForSession(context, owner.userId)
  }
  let task = await requireOwnedTask(context.env, owner, taskParam(context))
  if (!['created', 'queued', 'running', 'cancelled'].includes(task.status)) {
    throw new GatewayError(409, 'BATCH_IMAGE_INVALID_STATE', `Cannot cancel a ${task.status} batch`)
  }
  const now = Date.now()
  if (task.status !== 'cancelled') {
    const changed = await transitionMediaTask(
      context.env,
      task.id,
      ['created', 'queued', 'running'],
      'cancelled',
      { cancelledCount: Math.max(0, task.expected_output_count - task.success_count - task.fail_count), finishedAtMs: now },
      now,
    )
    if (!changed) {
      task = await requireOwnedTask(context.env, owner, task.id)
      if (task.status !== 'cancelled') {
        throw new GatewayError(409, 'BATCH_IMAGE_INVALID_STATE', `Cannot cancel a ${task.status} batch`)
      }
    } else {
      await cancelPendingMediaItems(context.env, task.id, now)
      await appendMediaEvent(context.env, task.id, 'cancelled', {}, now)
    }
  }
  task = await requireOwnedTask(context.env, owner, task.id)
  await settleCancelledMediaTask(context.env, task)
  return publicMediaTask(await requireOwnedTask(context.env, owner, task.id))
}

async function cancelTaskForSession(context: Context<Bindings>, userId: string): Promise<unknown> {
  const task = await requireSessionTask(context.env, userId, taskParam(context))
  return cancelTask(context, { userId, apiKeyId: task.api_key_id })
}

async function itemContentResponse(
  context: Context<Bindings>,
  owner: MediaTaskOwner,
  session = false,
): Promise<Response> {
  const task = session
    ? await requireSessionTask(context.env, owner.userId, taskParam(context))
    : await requireOwnedTask(context.env, owner, taskParam(context))
  requireOutputsAvailable(task)
  const customId = customIdParam(context)
  const imageIndex = boundedInteger(context.req.query('image_index'), 0, 0, 3, 'image_index')
  const output = await findMediaTaskOutput(context.env, task.id, customId, imageIndex)
  if (output === null) {
    const item = (await listMediaTaskItems(context.env, task.id)).find((candidate) => candidate.custom_id === customId)
    if (item?.status === 'failed') {
      throw new GatewayError(409, 'BATCH_IMAGE_ITEM_FAILED', 'The requested batch item did not produce an image')
    }
    throw new GatewayError(404, 'BATCH_IMAGE_OUTPUT_NOT_FOUND', 'Generated image was not found')
  }
  const object = await mediaBucket(context.env).get(output.object_key)
  if (object === null) {
    throw new GatewayError(503, 'BATCH_IMAGE_OUTPUT_UNAVAILABLE', 'Generated image is temporarily unavailable', 'server_error')
  }
  await markMediaTaskDownloaded(context.env, task.id, Date.now())
  return new Response(object.body, {
    headers: {
      'content-type': output.mime_type,
      'content-length': String(output.byte_length),
      'content-disposition': `attachment; filename="${downloadFilename(output.custom_id, output.image_index, output.file_extension)}"`,
      'cache-control': 'private, no-store',
    },
  })
}

async function downloadTaskResponse(
  context: Context<Bindings>,
  owner: MediaTaskOwner,
  session = false,
): Promise<Response> {
  const task = session
    ? await requireSessionTask(context.env, owner.userId, taskParam(context))
    : await requireOwnedTask(context.env, owner, taskParam(context))
  requireOutputsAvailable(task)
  const outputs = await listMediaTaskOutputs(context.env, task.id)
  if (outputs.length === 0) throw new GatewayError(404, 'BATCH_IMAGE_OUTPUT_NOT_FOUND', 'Batch has no generated images')
  const total = outputs.reduce((sum, output) => sum + output.byte_length, 0)
  if (!Number.isSafeInteger(total) || total > MAX_MEDIA_ZIP_BYTES) {
    throw new GatewayError(413, 'BATCH_IMAGE_DOWNLOAD_TOO_LARGE', 'Batch download exceeds the streaming ZIP limit')
  }
  await markMediaTaskDownloaded(context.env, task.id, Date.now())
  return new Response(streamMediaZip(mediaBucket(context.env), outputs), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${downloadFilename(task.task_name || task.id, 0, 'zip')}"`,
      'cache-control': 'private, no-store',
    },
  })
}

async function deleteTaskOutputs(context: Context<Bindings>, owner: MediaTaskOwner): Promise<unknown> {
  const task = owner.apiKeyId === undefined
    ? await requireSessionTask(context.env, owner.userId, taskParam(context))
    : await requireOwnedTask(context.env, owner, taskParam(context))
  if (task.status === 'output_deleted') return publicMediaTask(task)
  if (task.status !== 'completed') {
    throw new GatewayError(409, 'BATCH_IMAGE_INVALID_STATE', `Cannot delete outputs for a ${task.status} batch`)
  }
  const outputs = await listMediaTaskOutputs(context.env, task.id)
  for (const output of outputs) await mediaBucket(context.env).delete(output.object_key)
  if (!await removeMediaTaskOutputs(context.env, task.id, Date.now())) {
    throw new GatewayError(409, 'BATCH_IMAGE_INVALID_STATE', 'Batch state changed while deleting outputs')
  }
  return publicMediaTask(await requiredTask(context.env, task.id))
}

async function deleteTaskResponse(
  context: Context<Bindings>,
  owner: MediaTaskOwner,
  session = false,
): Promise<Response> {
  const task = session
    ? await requireSessionTask(context.env, owner.userId, taskParam(context))
    : await requireOwnedTask(context.env, owner, taskParam(context))
  if (!['completed', 'failed', 'cancelled', 'output_deleted'].includes(task.status)) {
    throw new GatewayError(409, 'BATCH_IMAGE_INVALID_STATE', `Cannot delete a ${task.status} batch`)
  }
  await softDeleteMediaTask(context.env, task.id, Date.now())
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

async function readMediaJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_MEDIA_REQUEST_BYTES) {
    throw new GatewayError(413, 'BATCH_IMAGE_REQUEST_TOO_LARGE', 'Batch image request is too large')
  }
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength === 0) throw new GatewayError(400, 'empty_body', 'Request body is required')
  if (bytes.byteLength > MAX_MEDIA_REQUEST_BYTES) {
    throw new GatewayError(413, 'BATCH_IMAGE_REQUEST_TOO_LARGE', 'Batch image request is too large')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_body', 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function requiredRequestedModel(body: Record<string, unknown>): string {
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REQUEST', 'model is required')
  }
  return body.model.trim()
}

async function requireOwnedTask(
  env: MediaEnv,
  owner: MediaTaskOwner,
  taskId: string,
): Promise<MediaTaskRow> {
  const task = await findOwnedMediaTask(env, owner, taskId)
  if (task === null) throw new GatewayError(404, 'BATCH_IMAGE_NOT_FOUND', 'Batch image task was not found')
  return task
}

async function requireSessionTask(env: MediaEnv, userId: string, taskId: string): Promise<MediaTaskRow> {
  const task = await requireOwnedTask(env, { userId }, taskId)
  await resolveSessionMediaPrincipal(env, userId, task.api_key_id)
  return task
}

function requireOutputsAvailable(task: MediaTaskRow): void {
  if (task.status === 'output_deleted') {
    throw new GatewayError(410, 'BATCH_IMAGE_OUTPUT_DELETED', 'Generated outputs were deleted')
  }
  if (task.status !== 'completed') {
    throw new GatewayError(409, 'BATCH_IMAGE_OUTPUT_NOT_READY', 'Generated outputs are not ready')
  }
}

function taskParam(context: Context<Bindings>): string {
  const id = context.req.param('id') ?? ''
  if (!/^imgbatch_[A-Za-z0-9_-]{16,55}$/.test(id)) {
    throw new GatewayError(404, 'BATCH_IMAGE_NOT_FOUND', 'Batch image task was not found')
  }
  return id
}

function customIdParam(context: Context<Bindings>): string {
  const value = context.req.param('customId') ?? ''
  if (value.length === 0 || value.length > 255) {
    throw new GatewayError(404, 'BATCH_IMAGE_OUTPUT_NOT_FOUND', 'Generated image was not found')
  }
  return value
}

function downloadFilename(customId: string, imageIndex: number, extension: string): string {
  const base = customId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'image'
  const suffix = imageIndex === 0 ? '' : `_${String(imageIndex + 1).padStart(2, '0')}`
  return `${base}${suffix}.${extension}`
}

function withoutApiKeyId(body: Record<string, unknown>): Record<string, unknown> {
  const { api_key_id: _apiKeyId, ...payload } = body
  return payload
}

function requiredApiKeyId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_API_KEY_ID', 'api_key_id is invalid')
  }
  return value
}

async function requiredTask(env: MediaEnv, taskId: string): Promise<MediaTaskRow> {
  const task = await findMediaTask(env, taskId)
  if (task === null) throw new GatewayError(500, 'BATCH_IMAGE_TASK_LOST', 'Media task state was not persisted', 'server_error')
  return task
}

function mediaBucket(env: MediaEnv): R2Bucket {
  return env.MEDIA_OBJECTS ?? env.OBJECTS
}

function mediaJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

const publicTaskStatuses = new Set<string>([
  'queued', 'running', 'settling', 'completed', 'failed', 'cancelled', 'output_deleted',
])

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new GatewayError(400, 'BATCH_IMAGE_INVALID_QUERY', `${field} is invalid`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_QUERY', `${field} is invalid`)
  }
  return parsed
}

function booleanFilter(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new GatewayError(400, 'BATCH_IMAGE_INVALID_QUERY', 'downloaded must be true or false')
}

function optionalDate(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new GatewayError(400, 'BATCH_IMAGE_INVALID_QUERY', `${field} is invalid`)
  return parsed
}

function encodeCursor(createdAtMs: number, id: string): string {
  return btoa(JSON.stringify({ t: createdAtMs, id }))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeCursor(value: string): { createdAtMs: number; id: string } {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
    const parsed = JSON.parse(atob(padded)) as { t?: unknown; id?: unknown }
    if (!Number.isSafeInteger(parsed.t) || typeof parsed.id !== 'string' || parsed.id.length > 64) throw new Error()
    return { createdAtMs: parsed.t as number, id: parsed.id }
  } catch {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_CURSOR', 'Batch cursor is invalid')
  }
}

function cursorQuery(value: string | undefined): {
  cursor?: { createdAtMs: number; id: string }
  offset?: number
} {
  if (value === undefined || value === '') return {}
  const offset = numericCursor(value)
  return offset === undefined ? { cursor: decodeCursor(value) } : { offset }
}

function numericCursor(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_CURSOR', 'Batch cursor is invalid')
  }
  return parsed
}

async function bestEffort(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // The winning D1 row owns a different server-generated key; cleanup can be retried by R2 lifecycle.
  }
}
