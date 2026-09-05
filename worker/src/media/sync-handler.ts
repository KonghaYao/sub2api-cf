import type { Context } from 'hono'
import type { Env } from '../env'
import { decryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError, gatewayErrorResponse } from '../gateway/errors'
import { buildProviderRequest } from '../gateway/providers'
import type { AccountCredential, UpstreamCredential } from '../gateway/types'
import {
  authenticateGatewayRequest,
  credentialAad,
  getAccountCredential,
  resolveGatewayRoute,
} from '../gateway/repository'
import {
  acquireApiKeyAdmission,
  RENEW_AFTER_MS,
  recordPoolFailure,
  releaseApiKeyAdmission,
  releasePoolLease,
  renewApiKeyAdmission,
  renewPoolLease,
  reservePoolAccount,
  syncPoolAccounts,
} from '../gateway/state-client'
import { classifyImageBillingTier, resolveImageBilling, type ImageBillingTier } from './image-accounting'
import { syncImageBilling, type SyncImageBilling, type SyncImageUsageInput } from './sync-billing'
import {
  parseSyncImageEditJson,
  parseSyncImageEditMultipart,
  parseSyncImageGeneration,
  SYNC_IMAGE_MAX_JSON_BYTES,
  SYNC_IMAGE_MAX_MULTIPART_BYTES,
  type SyncImageManifest,
  type SyncImageOperation,
} from './sync-domain'
import {
  calculateSyncImageActualCost,
  calculateSyncImageReservation,
  resolveSyncImagePricePolicy,
} from './sync-pricing'
import {
  normalizeNativeImageResponse,
  readSyncImageResponse,
  type NormalizedSyncImageResult,
} from './sync-provider'
import { executeSyncImageResponses } from './sync-responses-executor'
import {
  classifySyncImageProviderOutcome,
  decideSyncImageFailover,
  type SyncImageFailoverDecision,
} from './sync-failover'
import {
  buildSyncImageBufferedResponse,
  createSyncImageSseTransformer,
  type SyncImageSseSnapshot,
} from './sync-sse'

interface SyncImageEnv extends Env {
  SYNC_IMAGE_BILLING?: SyncImageBilling
  SYNC_IMAGE_UPSTREAM_FETCH?: typeof fetch
  SYNC_IMAGE_MODERATOR?: SyncImageModerator
  SYNC_IMAGE_RENEW_AFTER_MS?: number
}

export interface SyncImageModerator {
  check(input: {
    userId: string
    apiKeyId: string
    model: string
    manifest: SyncImageManifest
  }): Promise<{ allowed: boolean; message?: string }>
}

type SyncImageBindings = { Bindings: SyncImageEnv }
const FAILURE_COOLDOWN_MS = 30_000
const SYNC_IMAGE_RESPONSES_MODEL = 'gpt-5.4-mini'
const SYNC_IMAGE_SSE_BODY_LIMIT = 64 * 1024 * 1024
const SYNC_IMAGE_SSE_BODY_TIMEOUT_MS = 120_000

/**
 * Worker-native synchronous Images vertical slice.
 *
 * v0.23 also executes Codex OAuth-like accounts through the Responses image
 * tool. Its public SSE contract is currently returned after a bounded upstream
 * drain so failover and exact accounting finish before response commitment.
 */
export async function handleSyncImages(
  context: Context<SyncImageBindings>,
  operation: SyncImageOperation,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  let admission: Awaited<ReturnType<typeof acquireApiKeyAdmission>> = null
  let principal: Awaited<ReturnType<typeof authenticateGatewayRequest>> | null = null
  let billingReserved = false
  let activePool: DurableObjectStub | null = null
  let activeLeaseId: string | null = null
  let completeStartedLifecycle: () => void = () => undefined
  try {
    principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const manifest = await parseRequest(context.req.raw, operation)
    if (context.env.SYNC_IMAGE_MODERATOR !== undefined) {
      const decision = await context.env.SYNC_IMAGE_MODERATOR.check({
        userId: principal.user_id,
        apiKeyId: principal.api_key_id,
        model: manifest.model,
        manifest,
      })
      if (!decision.allowed) {
        throw new GatewayError(
          400,
          'content_policy_violation',
          decision.message?.slice(0, 240) || 'Image request was blocked by content moderation',
          'invalid_request_error',
        )
      }
    }

    const [pricing, route] = await Promise.all([
      resolveSyncImagePricePolicy(context.env, principal),
      resolveGatewayRoute(context.env, principal.group_id, manifest.model, 'images', principal.user_id),
    ])
    if (route.candidates.some((candidate) => candidate.platform !== 'openai' && candidate.platform !== 'codex')) {
      throw new GatewayError(503, 'IMAGE_PROVIDER_NOT_SUPPORTED', 'No compatible Images account is configured', 'server_error')
    }
    if (manifest.options.stream === true && route.candidates.some((candidate) => candidate.platform === 'openai')) {
      throw new GatewayError(
        501,
        'IMAGE_DIRECT_STREAMING_NOT_IMPLEMENTED',
        'Direct Images provider streaming is not migrated yet',
      )
    }

    admission = await acquireApiKeyAdmission(context.env, principal, requestId)
    // Reserve the maximum billable tier. Actual-output settlement can then be
    // lower without ever exceeding a Durable Object hold.
    const reservedMicros = calculateSyncImageReservation(pricing, '4K', manifest.n)
    const billing = syncImageBilling(context.env)
    await billing.reserve({ env: context.env, principal, requestId, amountMicros: reservedMicros })
    billingReserved = true

    activePool = await syncPoolAccounts(
      context.env,
      principal.group_id,
      route.model.model_id,
      'images',
      route.candidates,
    )
    const startedLifecycle = new Promise<void>((resolve) => {
      completeStartedLifecycle = resolve
    })
    registerExecutionTask(context, startedLifecycle)
    let completed: {
      accountId: string
      normalized: NormalizedSyncImageResult
      publicBody: unknown
      streamBody?: Uint8Array
      status: number
      headers: Headers
    } | null = null
    let lastError: GatewayError | null = null
    const attempts = Math.min(4, route.candidates.length)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (context.req.raw.signal.aborted) {
        throw new GatewayError(499, 'client_cancelled', 'Client cancelled before image generation started')
      }
      activeLeaseId = `${requestId}:${attempt}`
      let accountId: string | null = null
      let renewal: ReturnType<typeof startLeaseRenewal> | null = null
      let upstreamStarted = false
      try {
        accountId = await reservePoolAccount(activePool, activeLeaseId)
        renewal = startLeaseRenewal(
          admission,
          activePool,
          activeLeaseId,
          context.env.SYNC_IMAGE_RENEW_AFTER_MS ?? RENEW_AFTER_MS,
        )
        const account = await getAccountCredential(
          context.env,
          principal.group_id,
          route.model.model_id,
          'images',
          accountId,
        )
        if (!context.env.CREDENTIALS_MASTER_KEY) {
          throw new GatewayError(503, 'gateway_not_configured', 'Credential secret is not configured', 'server_error')
        }
        const credential = await decryptCredential(
          account.nonce_b64,
          account.ciphertext_b64,
          context.env.CREDENTIALS_MASTER_KEY,
          credentialAad(context.env.ENVIRONMENT, account.account_id, account.secret_id, account.key_version),
        )
        if (context.req.raw.signal.aborted) {
          throw new GatewayError(499, 'client_cancelled', 'Client cancelled before image generation started')
        }
        upstreamStarted = true
        const result = account.platform === 'codex'
          ? await executeCodexImages({
              manifest,
              account,
              credential,
              publicModel: manifest.model,
              upstreamModel: route.model.upstream_name,
              clientHeaders: context.req.raw.headers,
              fetcher: context.env.SYNC_IMAGE_UPSTREAM_FETCH ?? fetch,
              leaseSignal: renewal.signal,
              remainingAccounts: Math.max(0, attempts - attempt - 1),
              requestId,
            })
          : await executeDirectImages({
              manifest,
              operation,
              account,
              credential,
              upstreamModel: route.model.upstream_name,
              enforceProviderModeration: context.env.SYNC_IMAGE_MODERATOR === undefined,
              clientHeaders: context.req.raw.headers,
              fetcher: context.env.SYNC_IMAGE_UPSTREAM_FETCH ?? fetch,
              leaseSignal: renewal.signal,
              requestId,
            })
        const renewalError = await renewal.stop()
        renewal = null
        if (renewalError !== null) throw renewalError
        completed = {
          accountId,
          ...result,
        }
        break
      } catch (error) {
        const renewalError = renewal === null ? null : await renewal.stop()
        renewal = null
        const mapped = asGatewayError(renewalError ?? error)
        lastError = mapped
        // Renewal failure may race a provider that has already accepted paid
        // work. Never switch accounts on this path and risk duplicate images.
        if (renewalError !== null && upstreamStarted) throw mapped
        if (accountId !== null && isRetryable(mapped)) {
          const failedAccountId = accountId
          await bestEffort(() => recordPoolFailure(
            activePool as DurableObjectStub,
            failedAccountId,
            `${requestId}:image:${attempt}`,
            FAILURE_COOLDOWN_MS,
          ))
        }
        if (!isRetryable(mapped) || attempt + 1 >= attempts) throw mapped
      } finally {
        if (renewal !== null) await renewal.stop()
        if (activeLeaseId !== null) {
          await bestEffort(() => releasePoolLease(activePool as DurableObjectStub, activeLeaseId as string))
          activeLeaseId = null
        }
      }
    }
    if (completed === null) {
      throw lastError ?? new GatewayError(503, 'no_upstream_accounts', 'No upstream account is configured', 'server_error')
    }
    const actualTiers = outputBillingTiers(manifest, completed.normalized.outputs)
    const actualMicros = calculateSyncImageActualCost(pricing, actualTiers)
    const usage: Omit<SyncImageUsageInput, 'principal' | 'occurredAt'> = {
      requestId,
      accountId: completed.accountId,
      priceId: route.model.price_id,
      requestedModel: manifest.model,
      upstreamModel: route.model.upstream_name,
      amountMicros: actualMicros,
      operation,
      startedAt,
    }
    // The provider has already completed billable work. From this point the
    // reservation must never be cancelled and the image response must never
    // become a retryable error merely because persistence is temporarily down.
    billingReserved = false
    try {
      await billing.settle({ env: context.env, principal, usage })
    } catch {
      registerExecutionTask(context, retrySettlement(() => billing.settle({
        env: context.env,
        principal: principal as NonNullable<typeof principal>,
        usage,
      })))
    }
    return new Response(
      completed.streamBody === undefined ? JSON.stringify(completed.publicBody) : byteBuffer(completed.streamBody),
      {
        status: completed.status,
        headers: completed.headers,
      },
    )
  } catch (error) {
    if (billingReserved && principal !== null) {
      const authenticatedPrincipal = principal
      await bestEffort(() => syncImageBilling(context.env).cancel({
        env: context.env,
        principal: authenticatedPrincipal,
        requestId,
      }))
    }
    return gatewayErrorResponse(asGatewayError(error))
  } finally {
    if (activePool !== null && activeLeaseId !== null) {
      await bestEffort(() => releasePoolLease(activePool as DurableObjectStub, activeLeaseId as string))
    }
    await bestEffort(() => releaseApiKeyAdmission(admission))
    completeStartedLifecycle()
  }
}

async function parseRequest(request: Request, operation: SyncImageOperation): Promise<SyncImageManifest> {
  const rawContentType = request.headers.get('content-type') ?? ''
  const contentType = rawContentType.split(';', 1)[0].trim().toLowerCase()
  if (contentType === 'multipart/form-data') {
    if (operation !== 'edits') {
      throw new GatewayError(415, 'IMAGE_UNSUPPORTED_CONTENT_TYPE', 'Multipart is supported only for image edits')
    }
    const bytes = await readBoundedRequest(request, SYNC_IMAGE_MAX_MULTIPART_BYTES)
    let form: FormData
    try {
      form = await new Request('https://multipart.internal', {
        method: 'POST', headers: { 'content-type': rawContentType }, body: byteBuffer(bytes),
      }).formData()
    } catch {
      throw new GatewayError(400, 'IMAGE_INVALID_MULTIPART', 'Multipart image edit body is invalid')
    }
    const fields: Record<string, unknown> = {}
    const images: Array<{ filename: string; mime_type: string; bytes: Uint8Array }> = []
    let mask: { filename: string; mime_type: string; bytes: Uint8Array } | null = null
    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        const part = { filename: value.name, mime_type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) }
        if (key === 'image' || /^image\[\d*\]$/.test(key)) images.push(part)
        else if (key === 'mask' && mask === null) mask = part
        else throw new GatewayError(400, 'IMAGE_INVALID_MULTIPART', `Unsupported multipart file field: ${key}`)
      } else {
        if (Object.hasOwn(fields, key)) {
          throw new GatewayError(400, 'IMAGE_INVALID_MULTIPART', `Duplicate multipart field: ${key}`)
        }
        fields[key] = value
      }
    }
    return parseSyncImageEditMultipart({ fields, images, mask })
  }
  if (contentType !== 'application/json') {
    throw new GatewayError(415, 'IMAGE_UNSUPPORTED_CONTENT_TYPE', 'Content-Type must be application/json or multipart/form-data')
  }
  const bytes = await readBoundedRequest(request, SYNC_IMAGE_MAX_JSON_BYTES)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new GatewayError(400, 'IMAGE_INVALID_JSON', 'Request body must contain valid JSON')
  }
  return operation === 'generations' ? parseSyncImageGeneration(value) : parseSyncImageEditJson(value)
}

interface ImageExecutionInput {
  manifest: SyncImageManifest
  account: AccountCredential
  credential: UpstreamCredential
  upstreamModel: string
  clientHeaders: Headers
  fetcher: typeof fetch
  leaseSignal: AbortSignal
}

interface ImageExecutionResult {
  normalized: NormalizedSyncImageResult
  publicBody: unknown
  streamBody?: Uint8Array
  status: number
  headers: Headers
}

async function executeDirectImages(input: ImageExecutionInput & {
  operation: SyncImageOperation
  enforceProviderModeration: boolean
  requestId: string
}): Promise<ImageExecutionResult> {
  const upstreamBody = providerBody(input.manifest, input.upstreamModel, input.enforceProviderModeration)
  const plan = buildProviderRequest({
    account: input.account,
    credential: input.credential,
    operation: input.operation === 'generations' ? 'images_generations' : 'images_edits',
    model: input.upstreamModel,
    body: upstreamBody,
    client_headers: input.clientHeaders,
  })
  copySafeImageHeaders(plan.headers, input.clientHeaders)
  if (upstreamBody instanceof FormData) plan.headers.delete('content-type')
  const response = await fetchImageProvider(
    input.fetcher,
    plan.url,
    {
      method: plan.method,
      headers: plan.headers,
      body: plan.body === undefined
        ? undefined
        : plan.body instanceof FormData
          ? plan.body
          : JSON.stringify(plan.body),
      redirect: 'manual',
    },
    Math.max(plan.timeout_ms, 120_000),
    input.leaseSignal,
  )
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new GatewayError(502, 'upstream_redirect_rejected', 'Upstream redirect was rejected', 'server_error')
  }
  const parsed = await readSyncImageResponse(response)
  return {
    normalized: normalizeNativeImageResponse(parsed),
    publicBody: parsed,
    status: response.status,
    headers: imageResponseHeaders(response.headers, input.requestId),
  }
}

async function executeCodexImages(input: ImageExecutionInput & {
  publicModel: string
  remainingAccounts: number
  requestId: string
}): Promise<ImageExecutionResult> {
  let sameAccountRetries = 0
  let retryWindowElapsedMs = 0
  while (true) {
    const execution = await executeSyncImageResponses({
      manifest: input.manifest,
      public_model: input.publicModel,
      upstream_model: input.upstreamModel,
      responses_model: SYNC_IMAGE_RESPONSES_MODEL,
      account: input.account,
      credential: input.credential,
      client_headers: input.clientHeaders,
      fetcher: input.fetcher,
      signal: input.leaseSignal,
    })
    const response = execution.response
    if (!response.ok) {
      try {
        await readSyncImageResponse(response)
        throw new GatewayError(502, 'IMAGE_RESPONSES_ERROR_MISSING', 'Image Responses provider returned an invalid error', 'server_error')
      } catch (error) {
        const mapped = asGatewayError(error)
        const classified = classifySyncImageProviderOutcome({
          kind: 'response',
          httpStatus: mapped.status,
          imageCount: 0,
          retryAfter: mapped.retryAfter,
          error: { type: mapped.type, code: mapped.code },
        })
        if (classified.kind === 'success') throw mapped
        const decision = decideSyncImageFailover(classified.failure, {
          upstreamStarted: true,
          outputCommitted: false,
          clientDisconnected: false,
          sameAccountRetries,
          accountSwitches: 0,
          remainingAccounts: input.remainingAccounts,
          retryWindowElapsedMs,
        })
        if (decision.action === 'retry_same_account') {
          const delay = decision.retryDelayMs ?? 0
          await waitForRetry(delay, input.leaseSignal)
          retryWindowElapsedMs += delay
          sameAccountRetries += 1
          continue
        }
        throw gatewayErrorFromDecision(decision)
      }
    }

    const transformed = await readSyncImageSseResponse(
      response,
      input.manifest,
      input.publicModel,
      input.manifest.options.stream === true,
      input.leaseSignal,
    )
    const snapshot = transformed.snapshot
    const classified = classifySyncImageProviderOutcome(snapshotOutcome(response.status, snapshot))
    if (classified.kind === 'failure') {
      const decision = decideSyncImageFailover(classified.failure, {
        upstreamStarted: true,
        outputCommitted: false,
        clientDisconnected: false,
        sameAccountRetries,
        accountSwitches: 0,
        remainingAccounts: input.remainingAccounts,
        retryWindowElapsedMs,
      })
      if (decision.action === 'retry_same_account') {
        const delay = decision.retryDelayMs ?? 0
        await waitForRetry(delay, input.leaseSignal)
        retryWindowElapsedMs += delay
        sameAccountRetries += 1
        continue
      }
      throw gatewayErrorFromDecision(decision)
    }

    const publicBody = buildSyncImageBufferedResponse(snapshot)
    const normalized: NormalizedSyncImageResult = {
      publicBody,
      outputs: snapshot.completedImages.map((image) => ({
        bytes: image.bytes,
        ...(image.size === '' ? {} : { size: image.size }),
      })),
    }
    return {
      normalized,
      publicBody,
      ...(input.manifest.options.stream === true ? { streamBody: transformed.body } : {}),
      status: 200,
      headers: input.manifest.options.stream === true
        ? new Headers({
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-store',
            'x-accel-buffering': 'no',
            'x-request-id': input.requestId,
          })
        : imageResponseHeaders(response.headers, input.requestId),
    }
  }
}

async function readSyncImageSseResponse(
  response: Response,
  manifest: SyncImageManifest,
  publicModel: string,
  retainFrames: boolean,
  leaseSignal: AbortSignal,
): Promise<{ body: Uint8Array; snapshot: SyncImageSseSnapshot }> {
  const transformer = createSyncImageSseTransformer({
    operation: manifest.operation === 'edits' ? 'edit' : 'generation',
    responseFormat: manifest.options.response_format === 'url' ? 'url' : 'b64_json',
    publicModel,
  })
  if (!retainFrames) transformer.disconnectOutput()
  const reader = response.body?.getReader()
  const frames: Uint8Array[] = []
  let responseBytes = 0
  const deadline = Date.now() + SYNC_IMAGE_SSE_BODY_TIMEOUT_MS
  if (reader !== undefined) {
    while (transformer.snapshot().state === 'open') {
      if (leaseSignal.aborted) {
        await reader.cancel('image lease renewal failed')
        throw new GatewayError(503, 'IMAGE_LEASE_RENEWAL_FAILED', 'Image concurrency lease could not be renewed', 'server_error')
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        await reader.cancel('image Responses body timeout')
        throw new GatewayError(504, 'IMAGE_RESPONSES_BODY_TIMEOUT', 'Image Responses provider body timed out', 'server_error')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let abortForLease: (() => void) | undefined
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new GatewayError(
              504,
              'IMAGE_RESPONSES_BODY_TIMEOUT',
              'Image Responses provider body timed out',
              'server_error',
            )), remaining)
          }),
          new Promise<never>((_resolve, reject) => {
            abortForLease = () => reject(new GatewayError(
              503,
              'IMAGE_LEASE_RENEWAL_FAILED',
              'Image concurrency lease could not be renewed',
              'server_error',
            ))
            leaseSignal.addEventListener('abort', abortForLease, { once: true })
          }),
        ])
      } catch (error) {
        await reader.cancel('image Responses body failed')
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (abortForLease !== undefined) leaseSignal.removeEventListener('abort', abortForLease)
      }
      if (next.done) break
      responseBytes += next.value.byteLength
      if (responseBytes > SYNC_IMAGE_SSE_BODY_LIMIT) {
        await reader.cancel('image Responses body too large')
        throw new GatewayError(502, 'IMAGE_RESPONSES_BODY_TOO_LARGE', 'Image Responses provider body exceeded the size limit', 'server_error')
      }
      frames.push(...transformer.push(next.value))
    }
    if (transformer.snapshot().state !== 'open') await reader.cancel('image Responses terminal event received')
  }
  frames.push(...transformer.finish())
  return { body: joinBytes(frames), snapshot: transformer.snapshot() }
}

function snapshotOutcome(httpStatus: number, snapshot: SyncImageSseSnapshot): Parameters<typeof classifySyncImageProviderOutcome>[0] {
  const responseStatus = snapshot.responseStatus === 'completed' || snapshot.responseStatus === 'incomplete' || snapshot.responseStatus === 'failed'
    ? snapshot.responseStatus
    : undefined
  const includeStructuredError = snapshot.error !== null &&
    snapshot.error.classification !== 'completed_no_image' &&
    snapshot.error.classification !== 'text_fallback'
  return {
    kind: 'response',
    httpStatus,
    imageCount: snapshot.imageCount,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(snapshot.incompleteReason === '' ? {} : { incompleteReason: snapshot.incompleteReason }),
    ...(snapshot.textOutput === '' ? {} : { textOutput: snapshot.textOutput }),
    ...(snapshot.retryAfter === '' ? {} : { retryAfter: snapshot.retryAfter }),
    ...(!includeStructuredError ? {} : {
      error: {
        type: snapshot.error!.type,
        code: snapshot.error!.code,
        message: snapshot.error!.message,
      },
    }),
  }
}

function gatewayErrorFromDecision(decision: SyncImageFailoverDecision): GatewayError {
  return new GatewayError(
    decision.error.status,
    decision.error.code,
    decision.error.message,
    decision.error.type,
    decision.error.retryAfter,
  )
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return
  if (signal.aborted) {
    throw new GatewayError(503, 'IMAGE_LEASE_RENEWAL_FAILED', 'Image concurrency lease could not be renewed', 'server_error')
  }
  await new Promise<void>((resolve, reject) => {
    const abortForLease = () => {
      clearTimeout(timer)
      reject(new GatewayError(503, 'IMAGE_LEASE_RENEWAL_FAILED', 'Image concurrency lease could not be renewed', 'server_error'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abortForLease)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', abortForLease, { once: true })
  })
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function readBoundedRequest(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    throw new GatewayError(413, 'IMAGE_REQUEST_TOO_LARGE', 'Image request exceeds the configured size limit')
  }
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maximumBytes) {
      await reader.cancel('image request too large')
      throw new GatewayError(413, 'IMAGE_REQUEST_TOO_LARGE', 'Image request exceeds the configured size limit')
    }
    chunks.push(next.value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function providerBody(
  manifest: SyncImageManifest,
  upstreamModel: string,
  enforceProviderModeration: boolean,
): Record<string, unknown> | FormData {
  const options = {
    ...manifest.options,
    ...(enforceProviderModeration ? { moderation: 'auto' } : {}),
  }
  if (manifest.input_images.some((image) => image.kind === 'bytes')) {
    const form = new FormData()
    form.set('model', upstreamModel)
    form.set('prompt', manifest.prompt)
    form.set('n', String(manifest.n))
    for (const [key, value] of Object.entries(options)) form.set(key, String(value))
    for (const image of manifest.input_images) {
      if (image.kind === 'bytes') form.append('image[]', new Blob([byteBuffer(image.bytes)], { type: image.mime_type }), image.filename)
    }
    if (manifest.mask?.kind === 'bytes') {
      form.set('mask', new Blob([byteBuffer(manifest.mask.bytes)], { type: manifest.mask.mime_type }), manifest.mask.filename)
    }
    return form
  }
  const body: Record<string, unknown> = {
    model: upstreamModel,
    prompt: manifest.prompt,
    n: manifest.n,
    ...options,
  }
  if (manifest.operation === 'edits') {
    body.images = manifest.input_images.map((image) => {
      if (image.kind !== 'url') throw new GatewayError(400, 'IMAGE_MULTIPART_NOT_IMPLEMENTED', 'Multipart image edits are not migrated yet')
      return { image_url: image.image_url }
    })
    if (manifest.mask !== null) {
      if (manifest.mask.kind !== 'url') throw new GatewayError(400, 'IMAGE_MULTIPART_NOT_IMPLEMENTED', 'Multipart image edits are not migrated yet')
      body.mask = { image_url: manifest.mask.image_url }
    }
  }
  return body
}

function outputBillingTiers(
  manifest: SyncImageManifest,
  outputs: Array<{ bytes?: Uint8Array; size?: string }>,
): ImageBillingTier[] {
  const requestedSize = manifest.options.size ?? ''
  return outputs.map((output) => {
    if (output.bytes !== undefined) return resolveImageBilling(requestedSize, [output.bytes]).billingTier
    if (output.size !== undefined) return classifyImageBillingTier(output.size) ?? fallbackTier(requestedSize)
    return fallbackTier(requestedSize)
  })
}

function fallbackTier(requestedSize: string): ImageBillingTier {
  return classifyImageBillingTier(requestedSize) ?? '2K'
}

function isRetryable(error: GatewayError): boolean {
  return error.status === 429 || error.status >= 500
}

async function fetchImageProvider(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  leaseSignal: AbortSignal,
): Promise<Response> {
  if (leaseSignal.aborted) {
    throw new GatewayError(503, 'IMAGE_LEASE_RENEWAL_FAILED', 'Image concurrency lease could not be renewed', 'server_error')
  }
  const controller = new AbortController()
  const abortForLease = () => controller.abort(leaseSignal.reason ?? 'lease renewal failed')
  leaseSignal.addEventListener('abort', abortForLease, { once: true })
  const timeout = setTimeout(() => controller.abort('upstream header timeout'), timeoutMs)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      if (leaseSignal.aborted) {
        throw new GatewayError(503, 'IMAGE_LEASE_RENEWAL_FAILED', 'Image concurrency lease could not be renewed', 'server_error')
      }
      throw new GatewayError(504, 'IMAGE_UPSTREAM_TIMEOUT', 'Image provider did not return response headers in time', 'server_error')
    }
    throw new GatewayError(502, 'IMAGE_UPSTREAM_CONNECTION_ERROR', 'Image provider connection failed', 'server_error')
  } finally {
    clearTimeout(timeout)
  }
}

function imageResponseHeaders(upstream: Headers, requestId: string): Headers {
  const upstreamContentType = upstream.get('content-type')
  const contentType = upstreamContentType !== null && /^(?:application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(upstreamContentType)
    ? upstreamContentType.slice(0, 200)
    : 'application/json'
  const headers = new Headers({ 'content-type': contentType, 'x-request-id': requestId })
  for (const name of ['cache-control', 'retry-after', 'openai-processing-ms', 'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
    const value = upstream.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

function copySafeImageHeaders(target: Headers, source: Headers): void {
  for (const name of [
    'accept-language',
    'conversation_id',
    'openai-beta',
    'originator',
    'session_id',
    'user-agent',
    'x-codex-beta-features',
    'x-codex-installation-id',
    'x-codex-turn-state',
    'x-codex-turn-metadata',
    'x-codex-window-id',
  ]) {
    const value = source.get(name)
    if (value !== null && value.length <= 8_192 && !/[\u0000-\u001f\u007f]/.test(value)) {
      target.set(name, value)
    }
  }
}

function byteBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
  try { await operation() } catch { /* cleanup/recovery is idempotent */ }
}

function registerExecutionTask(context: Context<SyncImageBindings>, task: Promise<unknown>): void {
  const guarded = task.then(() => undefined, () => undefined)
  try {
    context.executionCtx.waitUntil(guarded)
  } catch {
    // Unit/miniflare request helpers may not provide an ExecutionContext. The
    // guarded promise is still deliberately observed to avoid an unhandled rejection.
    void guarded
  }
}

async function retrySettlement(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operation()
      return
    } catch {
      // The request id is the idempotency key; bounded retries cannot generate
      // another image and durable recovery owns the obligation once persisted.
    }
  }
}

function startLeaseRenewal(
  admission: Awaited<ReturnType<typeof acquireApiKeyAdmission>>,
  pool: DurableObjectStub,
  leaseId: string,
  intervalMs: number,
): { signal: AbortSignal; stop: () => Promise<unknown | null> } {
  const controller = new AbortController()
  let sequence = 0
  let chain: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    chain = chain.then(async () => {
      sequence += 1
      await renewApiKeyAdmission(admission, sequence)
      await renewPoolLease(pool, leaseId, sequence)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) controller.abort(error)
    })
  }, Math.max(1, intervalMs))
  return {
    signal: controller.signal,
    stop: async () => {
      clearInterval(timer)
      await chain
      return controller.signal.aborted ? controller.signal.reason : null
    },
  }
}
