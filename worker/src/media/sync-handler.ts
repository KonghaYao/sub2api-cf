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
  renewApiKeyMonetaryReservation,
  renewApiKeyAdmission,
  renewBillingReservation,
  renewPlatformQuotaReservation,
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
  type SyncImageCooldown,
  type SyncImageFailoverDecision,
} from './sync-failover'
import {
  buildSyncImageBufferedResponse,
  createSyncImageSseTransformer,
  type SyncImageSseSnapshot,
} from './sync-sse'
import { prepareSyncImageLiveStream, type SyncImageLivePrelude } from './sync-stream-session'

interface SyncImageEnv extends Env {
  SYNC_IMAGE_BILLING?: SyncImageBilling
  SYNC_IMAGE_UPSTREAM_FETCH?: typeof fetch
  SYNC_IMAGE_MODERATOR?: SyncImageModerator
  SYNC_IMAGE_RENEW_AFTER_MS?: number
  SYNC_IMAGE_RESPONSES_MODEL?: string
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
const SYNC_IMAGE_MAX_COMPLETED_OUTPUTS = 10
const SYNC_IMAGE_SSE_BODY_LIMIT = 12 * 1024 * 1024
const SYNC_IMAGE_SSE_TRACKED_IMAGE_LIMIT = 8 * 1024 * 1024
const SYNC_IMAGE_SSE_AGGREGATE_LIMIT = 32 * 1024 * 1024
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
  let lifecycleTransferred = false
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
    const compatibleCandidates = route.candidates.filter((candidate) =>
      (candidate.platform === 'openai' && candidate.image_adapter === 'direct_images' &&
        candidate.credential_kind === 'api_key') ||
      (candidate.platform === 'codex' && candidate.image_adapter === 'responses_image_tool' &&
        (candidate.credential_kind === 'oauth' || candidate.credential_kind === 'setup_token')),
    )
    if (compatibleCandidates.length === 0) {
      throw new GatewayError(503, 'IMAGE_PROVIDER_NOT_SUPPORTED', 'No compatible Images account is configured', 'server_error')
    }
    const candidates = compatibleCandidates

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
      candidates,
    )
    const startedLifecycle = new Promise<void>((resolve) => {
      completeStartedLifecycle = resolve
    })
    registerExecutionTask(context, startedLifecycle)
    let completed: {
      accountId: string
      normalized: NormalizedSyncImageResult
      publicBody: unknown
      streamBody?: ReadableStream<Uint8Array>
      status: number
      headers: Headers
      stream?: boolean
      upstreamEndpoint?: string
    } | null = null
    let lastError: GatewayError | null = null
    const attempts = Math.min(4, candidates.length)
    const attemptedAccountIds = new Set<string>()
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (context.req.raw.signal.aborted) {
        throw new GatewayError(499, 'client_cancelled', 'Client cancelled before image generation started')
      }
      activeLeaseId = `${requestId}:${attempt}`
      let accountId: string | null = null
      let renewal: ReturnType<typeof startLeaseRenewal> | null = null
      let upstreamStarted = false
      try {
        accountId = await reservePoolAccount(
          activePool,
          activeLeaseId,
          undefined,
          [...attemptedAccountIds],
        )
        attemptedAccountIds.add(accountId)
        renewal = startLeaseRenewal(
          context.env,
          principal,
          requestId,
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
        if (manifest.options.stream === true) {
          const liveInput = {
            manifest,
            account,
            credential,
            publicModel: manifest.model,
            upstreamModel: route.model.upstream_name,
            clientHeaders: context.req.raw.headers,
            fetcher: context.env.SYNC_IMAGE_UPSTREAM_FETCH ?? fetch,
            leaseSignal: renewal.signal,
            remainingAccounts: Math.max(0, attempts - attempt - 1),
            waitUntil: (task: Promise<unknown>) => registerExecutionTask(context, task),
          }
          const liveAttempt = account.image_adapter === 'responses_image_tool'
            ? await prepareCodexImageLiveAttempt({
                ...liveInput,
                responsesModel: context.env.SYNC_IMAGE_RESPONSES_MODEL ?? SYNC_IMAGE_RESPONSES_MODEL,
              })
            : await prepareDirectImageLiveAttempt({
                ...liveInput,
                operation,
                enforceProviderModeration: context.env.SYNC_IMAGE_MODERATOR === undefined,
                requestId,
              })
          if (liveAttempt.kind === 'buffered') {
            const renewalError = await renewal.stop()
            renewal = null
            if (renewalError !== null) throw renewalError
            completed = { accountId, ...liveAttempt.result }
            break
          }
          const live = liveAttempt
          const liveUpstreamEndpoint = account.image_adapter === 'responses_image_tool'
            ? '/backend-api/codex/responses'
            : directImageEndpoint(operation)
          const ownedRenewal = renewal
          const ownedAdmission = admission
          const ownedPool = activePool
          const ownedLeaseId = activeLeaseId
          const ownedAccountId = accountId
          const ownedPrincipal = principal
          const ownedCompleteLifecycle = completeStartedLifecycle
          const liveTask = live.completion.then(async ({ snapshot, clientDisconnected, transportError }) => {
            const classification = classifySyncImageProviderOutcome(snapshotOutcome(200, snapshot))
            if (classification.kind === 'failure') {
              const decision = decideSyncImageFailover(classification.failure, {
                upstreamStarted: true,
                outputCommitted: true,
                clientDisconnected,
                sameAccountRetries: 0,
                accountSwitches: 0,
                remainingAccounts: 0,
                retryWindowElapsedMs: 0,
              })
              if (decision.cooldown.scope !== 'none') {
                const cooldownMs = decision.cooldown.durationMs
                await bestEffort(() => recordPoolFailure(
                  ownedPool,
                  ownedAccountId,
                  `${requestId}:image:stream`,
                  cooldownMs,
                ))
              }
            } else if (transportError !== null && !clientDisconnected) {
              await bestEffort(() => recordPoolFailure(
                ownedPool,
                ownedAccountId,
                `${requestId}:image:stream-transport`,
                FAILURE_COOLDOWN_MS,
              ))
            }
            const billableImageCount = Math.max(snapshot.completedImages.length, snapshot.paidOutputCount)
            if (billableImageCount === 0) {
              await bestEffort(() => billing.cancel({
                env: context.env,
                principal: ownedPrincipal,
                requestId,
              }))
              return
            }
            const billingOutputs: Array<{ bytes?: Uint8Array; size?: string }> = snapshot.completedImages.map((image) => ({
              bytes: image.bytes,
              ...(image.size === '' ? {} : { size: image.size }),
            }))
            while (billingOutputs.length < billableImageCount) {
              billingOutputs.push(snapshot.metadata.size === '' ? {} : { size: snapshot.metadata.size })
            }
            const outputBilling = resolveOutputBilling(manifest, billingOutputs)
            const usage: Omit<SyncImageUsageInput, 'principal' | 'occurredAt'> = {
              requestId,
              accountId: ownedAccountId,
              priceId: route.model.price_id,
              requestedModel: manifest.model,
              upstreamModel: route.model.upstream_name,
              amountMicros: calculateSyncImageActualCost(pricing, outputBilling.tiers),
              operation,
              ...outputBilling.dimensions,
              startedAt,
              stream: true,
              outcome: clientDisconnected ? 'cancelled' : snapshot.state === 'completed' ? 'completed' : 'failed',
              upstreamEndpoint: liveUpstreamEndpoint,
            }
            await retrySettlement(() => billing.settle({
              env: context.env,
              principal: ownedPrincipal,
              usage,
            }))
          }).finally(async () => {
            await ownedRenewal.stop()
            await Promise.all([
              bestEffort(() => releasePoolLease(ownedPool, ownedLeaseId)),
              bestEffort(() => releaseApiKeyAdmission(ownedAdmission)),
            ])
            ownedCompleteLifecycle()
          })
          registerExecutionTask(context, liveTask)
          lifecycleTransferred = true
          billingReserved = false
          renewal = null
          admission = null
          activeLeaseId = null
          return new Response(live.body, {
            status: 'status' in live && typeof live.status === 'number' ? live.status : 200,
            headers: 'headers' in live && live.headers instanceof Headers ? live.headers : new Headers({
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-store',
              'x-accel-buffering': 'no',
              'x-request-id': requestId,
            }),
          })
        }
        const result = account.image_adapter === 'responses_image_tool'
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
              responsesModel: context.env.SYNC_IMAGE_RESPONSES_MODEL ?? SYNC_IMAGE_RESPONSES_MODEL,
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
        if (error instanceof SyncImageCommittedError) throw mapped
        // Renewal failure may race a provider that has already accepted paid
        // work. Never switch accounts on this path and risk duplicate images.
        if (renewalError !== null && upstreamStarted) throw mapped
        const decisionCooldown: SyncImageCooldown = error instanceof SyncImageDecisionError
          ? error.cooldown
          : { scope: 'current_account', durationMs: FAILURE_COOLDOWN_MS, reason: 'upstream_failure' }
        if (accountId !== null && isRetryable(mapped) && decisionCooldown.scope !== 'none') {
          const failedAccountId = accountId
          await bestEffort(() => recordPoolFailure(
            activePool as DurableObjectStub,
            failedAccountId,
            `${requestId}:image:${attempt}`,
            decisionCooldown.durationMs,
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
    const outputBilling = resolveOutputBilling(manifest, completed.normalized.outputs)
    const actualMicros = calculateSyncImageActualCost(pricing, outputBilling.tiers)
    const usage: Omit<SyncImageUsageInput, 'principal' | 'occurredAt'> = {
      requestId,
      accountId: completed.accountId,
      priceId: route.model.price_id,
      requestedModel: manifest.model,
      upstreamModel: route.model.upstream_name,
      amountMicros: actualMicros,
      operation,
      ...outputBilling.dimensions,
      startedAt,
      ...(completed.stream === true ? {
        stream: true,
        outcome: 'completed' as const,
        upstreamEndpoint: completed.upstreamEndpoint,
      } : {}),
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
      completed.streamBody === undefined ? JSON.stringify(completed.publicBody) : completed.streamBody,
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
    if (!lifecycleTransferred) completeStartedLifecycle()
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
  streamBody?: ReadableStream<Uint8Array>
  status: number
  headers: Headers
  stream?: boolean
  upstreamEndpoint?: string
}

async function executeDirectImages(input: ImageExecutionInput & {
  operation: SyncImageOperation
  enforceProviderModeration: boolean
  requestId: string
}): Promise<ImageExecutionResult> {
  const response = await executeDirectImageRequest(input)
  const parsed = await readSyncImageResponse(response)
  return directImageResult(parsed, response, input.manifest.n, input.requestId)
}

function directImageResult(
  parsed: unknown,
  response: Pick<Response, 'status' | 'headers'>,
  maxOutputs: number,
  requestId: string,
  rawBody?: Uint8Array,
): ImageExecutionResult {
  const normalized = normalizeNativeImageResponse(parsed, maxOutputs)
  const normalizedUsage = normalized.publicBody.usage
  const publicUsage = normalizedUsage !== null && typeof normalizedUsage === 'object' && !Array.isArray(normalizedUsage)
    ? { ...(normalizedUsage as Record<string, unknown>), images: normalized.outputs.length }
    : normalizedUsage
  const publicBody = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? {
        ...(parsed as Record<string, unknown>),
        ...normalized.publicBody,
        ...(publicUsage === undefined ? {} : { usage: publicUsage }),
      }
    : normalized.publicBody
  return {
    normalized,
    publicBody,
    ...(rawBody === undefined ? {} : {
      streamBody: chunksToStream([rawBody]),
      stream: true,
    }),
    status: response.status,
    headers: imageResponseHeaders(response.headers, requestId),
  }
}

async function executeDirectImageRequest(input: ImageExecutionInput & {
  operation: SyncImageOperation
  enforceProviderModeration: boolean
}): Promise<Response> {
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
  return response
}

async function executeCodexImages(input: ImageExecutionInput & {
  publicModel: string
  remainingAccounts: number
  requestId: string
  responsesModel: string
}): Promise<ImageExecutionResult> {
  let sameAccountRetries = 0
  let retryWindowElapsedMs = 0
  while (true) {
    const execution = await executeSyncImageResponses({
      manifest: input.manifest,
      public_model: input.publicModel,
      upstream_model: input.upstreamModel,
      responses_model: input.responsesModel,
      account: input.account,
      credential: input.credential,
      credential_kind: responsesCredentialKind(input.account.credential_kind),
      client_headers: input.clientHeaders,
      fetcher: input.fetcher,
      signal: input.leaseSignal,
    })
    const response = execution.response
    if (!response.ok) {
      if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        const transformed = await readSyncImageSseResponse(
          response,
          input.manifest,
          input.publicModel,
          false,
          input.leaseSignal,
        )
        const classified = classifySyncImageProviderOutcome(snapshotOutcome(
          response.status,
          transformed.snapshot,
          response.headers.get('retry-after') ?? undefined,
        ))
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
      }
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
          error: {
            type: mapped.type,
            code: mapped.code,
            message: mapped.message,
            ...(mapped.param === undefined ? {} : { param: mapped.param }),
          },
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
      ...(input.manifest.options.stream === true ? { streamBody: chunksToStream(transformed.frames) } : {}),
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

async function prepareDirectImageLiveAttempt(input: ImageExecutionInput & {
  operation: SyncImageOperation
  enforceProviderModeration: boolean
  publicModel: string
  remainingAccounts: number
  requestId: string
  waitUntil?: (task: Promise<unknown>) => void
}): Promise<{
  kind: 'buffered'
  result: ImageExecutionResult
} | (Extract<SyncImageLivePrelude, { kind: 'committed' }> & {
  status: number
  headers: Headers
})> {
  let sameAccountRetries = 0
  let retryWindowElapsedMs = 0
  while (true) {
    const response = await executeDirectImageRequest(input)
    // HTTP errors are still pre-commit and may participate in the normal
    // provider retry/switch policy. A successful Direct SSE response, however,
    // becomes irrevocable as soon as its first public byte is observed.
    if (!response.ok) {
      const decision = await imageErrorDecision(response, input, {
        sameAccountRetries,
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
    const prelude = await prepareSyncImageLiveStream({
      response,
      operation: input.operation === 'edits' ? 'edit' : 'generation',
      responseFormat: input.manifest.options.response_format === 'url' ? 'url' : 'b64_json',
      publicModel: input.publicModel,
      leaseSignal: input.leaseSignal,
      maxEventBytes: SYNC_IMAGE_SSE_BODY_LIMIT,
      maxTrackedImageBytes: SYNC_IMAGE_SSE_TRACKED_IMAGE_LIMIT,
      maxCompletedImages: Math.min(SYNC_IMAGE_MAX_COMPLETED_OUTPUTS, input.manifest.n),
      maxResponseBytes: SYNC_IMAGE_SSE_BODY_LIMIT,
      maxAggregateBytes: SYNC_IMAGE_SSE_AGGREGATE_LIMIT,
      waitUntil: input.waitUntil,
      outputMode: 'passthrough',
      detectJsonFallback: true,
    })
    if (prelude.kind === 'committed') {
      return {
        ...prelude,
        status: response.status,
        headers: imageStreamResponseHeaders(response.headers, input.requestId),
      }
    }
    if (prelude.kind === 'json_fallback') {
      let parsed: unknown
      try {
        parsed = await readSyncImageResponse(new Response(byteBuffer(prelude.bytes), {
          status: prelude.status,
          headers: prelude.headers,
        }))
      } catch (error) {
        const mapped = asGatewayError(error)
        // A successful Direct response means the provider accepted the paid
        // request. Malformed JSON is not permission to generate it again.
        throw new SyncImageCommittedError(mapped)
      }
      return {
        kind: 'buffered',
        result: {
          ...directImageResult(parsed, prelude, input.manifest.n, input.requestId, prelude.bytes),
          upstreamEndpoint: directImageEndpoint(input.operation),
        },
      }
    }

    const classified = classifySyncImageProviderOutcome(snapshotOutcome(
      response.status,
      prelude.snapshot,
      response.headers.get('retry-after') ?? undefined,
    ))
    if (classified.kind === 'success') {
      throw new GatewayError(502, 'IMAGE_DIRECT_PRELUDE_INVALID', 'Direct Images prelude ended unexpectedly', 'server_error')
    }
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

async function prepareCodexImageLiveAttempt(input: ImageExecutionInput & {
  publicModel: string
  remainingAccounts: number
  responsesModel: string
  waitUntil?: (task: Promise<unknown>) => void
}): Promise<Extract<SyncImageLivePrelude, { kind: 'committed' }>> {
  let sameAccountRetries = 0
  let retryWindowElapsedMs = 0
  while (true) {
    const execution = await executeSyncImageResponses({
      manifest: input.manifest,
      public_model: input.publicModel,
      upstream_model: input.upstreamModel,
      responses_model: input.responsesModel,
      account: input.account,
      credential: input.credential,
      credential_kind: responsesCredentialKind(input.account.credential_kind),
      client_headers: input.clientHeaders,
      fetcher: input.fetcher,
      signal: input.leaseSignal,
    })
    const response = execution.response
    if (!response.ok) {
      const decision = await imageErrorDecision(response, input, {
        sameAccountRetries,
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

    const prelude = await prepareSyncImageLiveStream({
      response,
      operation: input.manifest.operation === 'edits' ? 'edit' : 'generation',
      responseFormat: input.manifest.options.response_format === 'url' ? 'url' : 'b64_json',
      publicModel: input.publicModel,
      leaseSignal: input.leaseSignal,
      maxEventBytes: SYNC_IMAGE_SSE_BODY_LIMIT,
      maxTrackedImageBytes: SYNC_IMAGE_SSE_TRACKED_IMAGE_LIMIT,
      maxCompletedImages: Math.min(SYNC_IMAGE_MAX_COMPLETED_OUTPUTS, input.manifest.n),
      maxResponseBytes: SYNC_IMAGE_SSE_BODY_LIMIT,
      maxAggregateBytes: SYNC_IMAGE_SSE_AGGREGATE_LIMIT,
      waitUntil: input.waitUntil,
    })
    if (prelude.kind === 'committed') return prelude

    const classified = classifySyncImageProviderOutcome(snapshotOutcome(response.status, prelude.snapshot))
    if (classified.kind === 'success') {
      throw new GatewayError(502, 'IMAGE_RESPONSES_PRELUDE_INVALID', 'Image Responses prelude ended unexpectedly', 'server_error')
    }
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

async function imageErrorDecision(
  response: Response,
  input: ImageExecutionInput & { publicModel: string; remainingAccounts: number },
  retry: { sameAccountRetries: number; retryWindowElapsedMs: number },
): Promise<SyncImageFailoverDecision> {
  let mapped: GatewayError
  if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    const transformed = await readSyncImageSseResponse(
      response,
      input.manifest,
      input.publicModel,
      false,
      input.leaseSignal,
    )
    const classified = classifySyncImageProviderOutcome(snapshotOutcome(
      response.status,
      transformed.snapshot,
      response.headers.get('retry-after') ?? undefined,
    ))
    if (classified.kind === 'success') {
      return decideSyncImageFailover({
        kind: 'upstream_error', status: 502, code: 'IMAGE_RESPONSES_ERROR_MISSING',
      }, {
        upstreamStarted: true, outputCommitted: false, clientDisconnected: false,
        sameAccountRetries: retry.sameAccountRetries, accountSwitches: 0,
        remainingAccounts: input.remainingAccounts, retryWindowElapsedMs: retry.retryWindowElapsedMs,
      })
    }
    return decideSyncImageFailover(classified.failure, {
      upstreamStarted: true,
      outputCommitted: false,
      clientDisconnected: false,
      sameAccountRetries: retry.sameAccountRetries,
      accountSwitches: 0,
      remainingAccounts: input.remainingAccounts,
      retryWindowElapsedMs: retry.retryWindowElapsedMs,
    })
  }
  try {
    await readSyncImageResponse(response)
    mapped = new GatewayError(502, 'IMAGE_RESPONSES_ERROR_MISSING', 'Image Responses provider returned an invalid error', 'server_error')
  } catch (error) {
    mapped = asGatewayError(error)
  }
  const classified = classifySyncImageProviderOutcome({
    kind: 'response',
    httpStatus: mapped.status,
    imageCount: 0,
    retryAfter: mapped.retryAfter,
    error: {
      type: mapped.type,
      code: mapped.code,
      message: mapped.message,
      ...(mapped.param === undefined ? {} : { param: mapped.param }),
    },
  })
  if (classified.kind === 'success') {
    return decideSyncImageFailover({
      kind: 'upstream_error', status: 502, code: 'IMAGE_RESPONSES_ERROR_MISSING',
    }, {
      upstreamStarted: true, outputCommitted: false, clientDisconnected: false,
      sameAccountRetries: retry.sameAccountRetries, accountSwitches: 0,
      remainingAccounts: input.remainingAccounts, retryWindowElapsedMs: retry.retryWindowElapsedMs,
    })
  }
  return decideSyncImageFailover(classified.failure, {
    upstreamStarted: true,
    outputCommitted: false,
    clientDisconnected: false,
    sameAccountRetries: retry.sameAccountRetries,
    accountSwitches: 0,
    remainingAccounts: input.remainingAccounts,
    retryWindowElapsedMs: retry.retryWindowElapsedMs,
  })
}

function responsesCredentialKind(
  kind: AccountCredential['credential_kind'],
): 'oauth' | 'setup-token' | 'api_key' {
  return kind === 'setup_token' ? 'setup-token' : kind
}

async function readSyncImageSseResponse(
  response: Response,
  manifest: SyncImageManifest,
  publicModel: string,
  retainFrames: boolean,
  leaseSignal: AbortSignal,
): Promise<{ frames: Uint8Array[]; snapshot: SyncImageSseSnapshot }> {
  const transformer = createSyncImageSseTransformer({
    operation: manifest.operation === 'edits' ? 'edit' : 'generation',
    responseFormat: manifest.options.response_format === 'url' ? 'url' : 'b64_json',
    publicModel,
    maxEventBytes: SYNC_IMAGE_SSE_BODY_LIMIT,
    maxTrackedImageBytes: SYNC_IMAGE_SSE_TRACKED_IMAGE_LIMIT,
    maxCompletedImages: Math.min(SYNC_IMAGE_MAX_COMPLETED_OUTPUTS, manifest.n),
  })
  if (!retainFrames) transformer.disconnectOutput()
  const reader = response.body?.getReader()
  const frames: Uint8Array[] = []
  let responseBytes = 0
  const deadline = Date.now() + SYNC_IMAGE_SSE_BODY_TIMEOUT_MS
  if (reader !== undefined) {
    let frameBytes = 0
    while (transformer.currentState() === 'open') {
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
      const nextFrames = transformer.push(next.value)
      frameBytes += nextFrames.reduce((total, frame) => total + frame.byteLength, 0)
      if (responseBytes + frameBytes + transformer.retainedImageBytes() > SYNC_IMAGE_SSE_AGGREGATE_LIMIT) {
        await reader.cancel('image Responses aggregate memory budget exceeded')
        throw new GatewayError(
          502,
          'IMAGE_RESPONSES_BODY_TOO_LARGE',
          'Image Responses provider exceeded the aggregate memory budget',
          'server_error',
        )
      }
      frames.push(...nextFrames)
    }
    if (transformer.currentState() !== 'open') {
      await bestEffort(() => reader.cancel('image Responses terminal event received'))
    }
  }
  const finalFrames = transformer.finish()
  const finalFrameBytes = finalFrames.reduce((total, frame) => total + frame.byteLength, 0)
  const retainedFrameBytes = frames.reduce((total, frame) => total + frame.byteLength, 0)
  if (responseBytes + retainedFrameBytes + finalFrameBytes + transformer.retainedImageBytes() > SYNC_IMAGE_SSE_AGGREGATE_LIMIT) {
    throw new GatewayError(
      502,
      'IMAGE_RESPONSES_BODY_TOO_LARGE',
      'Image Responses provider exceeded the aggregate memory budget',
      'server_error',
    )
  }
  frames.push(...finalFrames)
  return { frames, snapshot: transformer.snapshot() }
}

function snapshotOutcome(
  httpStatus: number,
  snapshot: SyncImageSseSnapshot,
  headerRetryAfter?: string,
): Parameters<typeof classifySyncImageProviderOutcome>[0] {
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
    ...(snapshot.retryAfter === '' && headerRetryAfter === undefined
      ? {}
      : { retryAfter: snapshot.retryAfter || headerRetryAfter }),
    ...(!includeStructuredError ? {} : {
      error: {
        type: snapshot.error!.type,
        code: snapshot.error!.code,
        message: snapshot.error!.message,
        ...(snapshot.error!.param === '' ? {} : { param: snapshot.error!.param }),
      },
    }),
  }
}

class SyncImageDecisionError extends GatewayError {
  constructor(
    decision: SyncImageFailoverDecision,
    readonly cooldown: SyncImageCooldown,
  ) {
    super(
      decision.error.status,
      decision.error.code,
      decision.error.message,
      decision.error.type,
      decision.error.retryAfter,
      decision.error.param,
    )
    this.name = 'SyncImageDecisionError'
  }
}

class SyncImageCommittedError extends GatewayError {
  constructor(error: GatewayError) {
    super(error.status, error.code, error.message, error.type, error.retryAfter, error.param)
    this.name = 'SyncImageCommittedError'
  }
}

function gatewayErrorFromDecision(decision: SyncImageFailoverDecision): GatewayError {
  return new SyncImageDecisionError(decision, decision.cooldown)
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

function chunksToStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index]!)
      index += 1
    },
    cancel() {
      chunks.length = 0
    },
  })
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

function directImageEndpoint(operation: SyncImageOperation): string {
  return operation === 'edits' ? '/v1/images/edits' : '/v1/images/generations'
}

function resolveOutputBilling(
  manifest: SyncImageManifest,
  outputs: Array<{ bytes?: Uint8Array; size?: string }>,
): {
  tiers: ImageBillingTier[]
  dimensions: Pick<SyncImageUsageInput,
    'imageCount' | 'imageSize' | 'imageInputSize' | 'imageOutputSize' |
    'imageSizeSource' | 'imageSizeBreakdown'>
} {
  const requestedSize = manifest.options.size ?? ''
  let detectedOutputSize = ''
  let firstObservedOutputSize = ''
  let hasOutputEvidence = false
  const tiers = outputs.map((output) => {
    const declaredSize = output.size?.trim() ?? ''
    if (firstObservedOutputSize === '' && declaredSize !== '') firstObservedOutputSize = declaredSize
    if (output.bytes !== undefined) {
      const resolved = resolveImageBilling(requestedSize, [output.bytes])
      if (resolved.source === 'output') {
        hasOutputEvidence = true
        if (detectedOutputSize === '') detectedOutputSize = resolved.outputSize
        return resolved.billingTier
      }
      const declaredTier = classifyImageBillingTier(declaredSize)
      if (declaredTier !== null) {
        hasOutputEvidence = true
        return declaredTier
      }
      return resolved.billingTier
    }
    if (declaredSize !== '') {
      const tier = classifyImageBillingTier(declaredSize)
      if (tier !== null) {
        hasOutputEvidence = true
        return tier
      }
    }
    return fallbackTier(requestedSize)
  })
  const breakdown: Partial<Record<ImageBillingTier, number>> = {}
  for (const tier of tiers) breakdown[tier] = (breakdown[tier] ?? 0) + 1
  const source = hasOutputEvidence
    ? 'output'
    : classifyImageBillingTier(requestedSize) === null ? 'default' : 'input'
  return {
    tiers,
    dimensions: {
      imageCount: outputs.length,
      imageSize: highestTier(tiers),
      imageInputSize: boundedUsageSize(requestedSize),
      imageOutputSize: boundedUsageSize(firstObservedOutputSize || detectedOutputSize),
      imageSizeSource: source,
      imageSizeBreakdown: breakdown,
    },
  }
}

function highestTier(tiers: ImageBillingTier[]): ImageBillingTier {
  if (tiers.includes('4K')) return '4K'
  if (tiers.includes('2K')) return '2K'
  return '1K'
}

function fallbackTier(requestedSize: string): ImageBillingTier {
  return classifyImageBillingTier(requestedSize) ?? '2K'
}

function boundedUsageSize(value: string): string | null {
  const normalized = value.trim()
  return normalized === '' ? null : normalized.slice(0, 32)
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

function imageStreamResponseHeaders(upstream: Headers, requestId: string): Headers {
  const upstreamContentType = upstream.get('content-type')
  const headers = new Headers({
    'content-type': upstreamContentType?.toLowerCase().includes('text/event-stream') === true
      ? upstreamContentType.slice(0, 200)
      : 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    'x-accel-buffering': 'no',
    'x-request-id': requestId,
  })
  for (const name of [
    'retry-after', 'openai-processing-ms', 'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests',
  ]) {
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
  try {
    // Preserve rejection for Cloudflare invocation/error observability. The
    // task itself owns idempotent recovery and must not fail silently.
    context.executionCtx.waitUntil(task)
  } catch {
    // Unit/miniflare request helpers may not provide an ExecutionContext. The
    // promise is still deliberately observed to avoid an unhandled rejection.
    void task.catch((error) => console.error('image background task failed', {
      name: error instanceof Error ? error.name : 'unknown',
    }))
  }
}

async function retrySettlement(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown = new Error('Image settlement failed')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      // The request id is the idempotency key; bounded retries cannot generate
      // another image and durable recovery owns the obligation once persisted.
    }
    if (attempt < 2) await delay(50 * 2 ** attempt)
  }
  console.error('image settlement retries exhausted', {
    name: lastError instanceof Error ? lastError.name : 'unknown',
  })
  throw lastError
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function startLeaseRenewal(
  env: SyncImageEnv,
  principal: NonNullable<Awaited<ReturnType<typeof authenticateGatewayRequest>>>,
  requestId: string,
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
      await Promise.all([
        renewApiKeyAdmission(admission, sequence),
        renewPoolLease(pool, leaseId, sequence),
        renewBillingReservation(env, principal, requestId, sequence),
        renewApiKeyMonetaryReservation(env, principal, requestId, sequence),
        renewPlatformQuotaReservation(env, principal, requestId, sequence),
      ])
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
