import type { Context } from 'hono'
import type { Env, UsageSettledPayload } from '../env'
import { bootstrapGateway } from './bootstrap'
import { codexModelsResponse } from './codex-models'
import { apiKeyDigest, decryptCredential } from './crypto'
import { asGatewayError, GatewayError, gatewayErrorResponse } from './errors'
import { createUsageEvent } from './queue'
import {
  formatAnthropicSseEvent,
  mapOpenAIErrorToAnthropic,
  parseAnthropicCountTokensRequest,
  parseAnthropicMessagesRequest,
  ProtocolValidationError,
  ResponsesToAnthropicEventCodec,
  responsesToAnthropicMessage,
  toOpenAIResponsesRequest,
  toOpenAIResponsesInputTokensRequest,
} from './protocols/anthropic'
import {
  convertGeminiGenerateContentToResponsesRequest,
  convertOpenAIResponsesResponseToGemini,
  GeminiCodecError,
  OpenAIResponsesToGeminiSseConverter,
  serializeGeminiSseFrame,
} from './protocols/gemini'
import {
  ChatCompletionsToResponsesEventCodec,
  ResponsesBridgeError,
  chatCompletionsResponseToResponses,
  formatResponsesSseEvent,
  parseResponsesRequest,
  responsesToChatCompletionsRequest,
} from './protocols/responses'
import {
  persistSettlementRecovery,
  settleRecoveryRequest,
  signalSettlementRecovery,
} from './recovery'
import {
  authenticateGatewayRequest,
  credentialAad,
  getAccountCredential,
  listModels,
  resolveGatewayRoute,
} from './repository'
import { buildProviderRequest, type ProviderOperation } from './providers'
import type { ProviderPlatform } from './providers'
import { readGatewayJsonBody } from './request-body'
import {
  acquireApiKeyAdmission,
  cancelApiKeyMonetaryReservation,
  cancelBillingReservation,
  disablePoolAccount,
  prepareBillingReservation,
  prepareApiKeyMonetaryReservation,
  recordPoolFailure,
  releaseApiKeyAdmission,
  releasePoolLease,
  RENEW_AFTER_MS,
  renewPoolLease,
  renewApiKeyAdmission,
  renewBillingReservation,
  renewApiKeyMonetaryReservation,
  reservePoolAccount,
  syncPoolAccounts,
  type ApiKeyAdmissionLease,
} from './state-client'
import type {
  GatewayEndpoint,
  GenerativeGatewayEndpoint,
  ModelRoute,
  TokenUsage,
} from './types'
import {
  calculateCost,
  estimatedUsage,
  extractUsage,
  reservationForRequest,
  rewriteModelNames,
  SseEventTransformer,
  streamErrorFrame,
} from './usage'

type GatewayBindings = { Bindings: Env }

const MAX_SYNC_RESPONSE_BYTES = 16 * 1024 * 1024
const HEADER_TIMEOUT_MS = 30_000
const BODY_IDLE_TIMEOUT_MS = 120_000
const TOTAL_SYNC_TIMEOUT_MS = 120_000
const TOTAL_STREAM_TIMEOUT_MS = 15 * 60_000
const BILLING_RENEW_AFTER_MS = 8 * 60_000
const DISCONNECT_DRAIN_IDLE_TIMEOUT_MS = 10_000
const DISCONNECT_DRAIN_TOTAL_TIMEOUT_MS = 30_000
const FAILURE_COOLDOWN_MS = 30_000
const encoder = new TextEncoder()

export async function handleModels(context: Context<GatewayBindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const models = await listModels(context.env, principal.group_id)
    if (context.req.query('client_version') !== undefined) {
      return codexModelsResponse(context.req.raw, models)
    }
    const created = Math.floor(Date.now() / 1_000)
    return context.json({
      object: 'list',
      data: models.map((model) => ({
        id: model.public_name,
        object: 'model',
        created,
        owned_by: 'openai',
      })),
    })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function handleCodexModels(context: Context<GatewayBindings>): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const models = await listModels(context.env, principal.group_id)
    return codexModelsResponse(context.req.raw, models)
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function handleBootstrap(context: Context<GatewayBindings>): Promise<Response> {
  try {
    return await bootstrapGateway(context.req.raw, context.env)
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

export async function handleGateway(
  context: Context<GatewayBindings>,
  endpoint: GatewayEndpoint,
): Promise<Response> {
  return dispatchGateway(
    context,
    endpoint,
    (body) => prepareOpenAiRequest(body, endpoint),
    gatewayErrorResponse,
  )
}

export async function handleEmbeddings(
  context: Context<GatewayBindings>,
): Promise<Response> {
  return dispatchGateway(
    context,
    'embeddings',
    (body) => {
      validateClientControls(body)
      const requestedModel = requiredModel(body)
      if (body.stream !== undefined) {
        throw new GatewayError(400, 'invalid_stream', 'Embeddings do not support streaming')
      }
      validateEmbeddingInput(body.input)
      const allowed = new Set(['model', 'input', 'encoding_format', 'dimensions', 'user'])
      const rejected = Object.keys(body).find((key) => !allowed.has(key))
      if (rejected !== undefined) {
        throw new GatewayError(400, 'invalid_request_error', `Field '${rejected}' is not supported for embeddings`)
      }
      return {
        requestedModel,
        stream: false,
        resolveUpstream: (model: ModelRoute, _upstreamEndpoint: GatewayEndpoint, platform: ProviderPlatform) => {
          assertProviderOperation(platform, 'embeddings')
          return {
            body: { ...body, model: model.upstream_name },
            operation: 'embeddings' as const,
            responseProtocol: 'openai' as const,
          }
        },
      }
    },
    gatewayErrorResponse,
  )
}

export async function handleGeminiModels(
  context: Context<GatewayBindings>,
): Promise<Response> {
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const models = await listModels(context.env, principal.group_id)
    return context.json({ models: models.map(geminiModelProjection) })
  } catch (error) {
    return geminiErrorResponse(asGatewayError(error))
  }
}

export async function handleGeminiModel(
  context: Context<GatewayBindings>,
): Promise<Response> {
  try {
    const routeModel = context.req.param('model')
    if (routeModel === undefined) throw new GatewayError(400, 'invalid_model', 'Gemini model path is invalid')
    const requestedModel = decodeGeminiPathModel(routeModel)
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const models = await listModels(context.env, principal.group_id)
    const model = models.find((candidate) => candidate.public_name === requestedModel)
    if (model === undefined) {
      throw new GatewayError(404, 'model_not_found', `Model '${requestedModel}' is not available`)
    }
    return context.json(geminiModelProjection(model))
  } catch (error) {
    return geminiErrorResponse(asGatewayError(error))
  }
}

export async function handleGeminiModelOperation(
  context: Context<GatewayBindings>,
): Promise<Response> {
  const operation = context.req.param('operation')
  if (operation === undefined) {
    return geminiErrorResponse(new GatewayError(404, 'not_found', 'Gemini operation is not supported'))
  }
  const match = /^([^:]+):(generateContent|streamGenerateContent|countTokens|embedContent)$/.exec(operation)
  if (match === null) {
    return geminiErrorResponse(new GatewayError(404, 'not_found', 'Gemini operation is not supported'))
  }
  let publicModel: string
  try {
    publicModel = decodeGeminiPathModel(match[1]!)
  } catch (error) {
    return geminiErrorResponse(asGatewayError(error))
  }
  const operationName = match[2]!
  if (operationName === 'countTokens') {
    return handleGeminiCountTokens(context, publicModel)
  }
  if (operationName === 'embedContent') {
    return dispatchGateway(
      context,
      'embeddings',
      (body) => {
        validateClientControls(body)
        prepareGeminiEmbeddingRequest(body, publicModel)
        return {
          requestedModel: publicModel,
          stream: false,
          resolveUpstream: (model: ModelRoute, _upstreamEndpoint: GatewayEndpoint, platform: ProviderPlatform) => {
            if (platform === 'gemini') {
              return {
                body: { ...body },
                operation: 'embeddings' as const,
                responseProtocol: 'native_gemini' as const,
              }
            }
            assertProviderOperation(platform, 'embeddings')
            return {
              body: prepareGeminiEmbeddingRequest(body, model.upstream_name),
              operation: 'embeddings' as const,
              transformResponse: geminiEmbeddingResponse,
              responseProtocol: 'gemini' as const,
            }
          },
        }
      },
      geminiErrorResponse,
    )
  }
  const stream = operationName === 'streamGenerateContent'
  return dispatchGateway(
    context,
    'responses',
    (body) => {
      validateClientControls(body)
      // Validate the client document before any balance or capacity mutation.
      convertGeminiGenerateContentToResponsesRequest(body, { publicModel, stream })
      return {
        requestedModel: publicModel,
        stream,
        resolveUpstream: (model: ModelRoute, _upstreamEndpoint: GatewayEndpoint, platform: ProviderPlatform) => {
          if (platform === 'gemini') {
            return {
              body: { ...body },
              operation: stream ? 'stream_generate_content' as const : 'generate_content' as const,
              responseProtocol: 'native_gemini' as const,
            }
          }
          assertProviderOperation(platform, 'responses')
          return {
            body: convertGeminiGenerateContentToResponsesRequest(body, {
              publicModel,
              mappedModel: model.upstream_name,
              stream,
            }).body,
            operation: 'responses' as const,
            transformResponse: (value: unknown) =>
              convertOpenAIResponsesResponseToGemini(value, { publicModel }),
            responseProtocol: 'gemini' as const,
          }
        },
      }
    },
    geminiErrorResponse,
  )
}

async function handleGeminiCountTokens(
  context: Context<GatewayBindings>,
  publicModel: string,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  let acquired: AcquiredUpstream | null = null
  let pool: DurableObjectStub | null = null
  let admission: ApiKeyAdmissionLease | null = null
  let principal: Awaited<ReturnType<typeof authenticateGatewayRequest>> | null = null
  let reservationsPrepared = false
  try {
    principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const parsed = await readGatewayJsonBody(context.req.raw)
    validateClientControls(parsed.body)
    convertGeminiGenerateContentToResponsesRequest(parsed.body, {
      publicModel,
      stream: false,
    })
    const route = await resolveGatewayRoute(
      context.env,
      principal.group_id,
      publicModel,
      'responses',
      principal.user_id,
    )
    const provider = providerForCandidates(route.candidates)
    let operation: ProviderOperation
    let upstreamBody: Record<string, unknown>
    if (provider === 'gemini') {
      operation = 'count_tokens'
      upstreamBody = { ...parsed.body }
    } else {
      if (provider !== 'openai') unsupportedProviderOperation(provider, 'count_tokens')
      operation = 'responses_input_tokens'
      const converted = convertGeminiGenerateContentToResponsesRequest(parsed.body, {
        publicModel,
        mappedModel: route.model.upstream_name,
        stream: false,
      }).body
      upstreamBody = { model: converted.model, input: converted.input }
      for (const key of ['instructions', 'tools', 'tool_choice']) {
        if (converted[key] !== undefined) upstreamBody[key] = converted[key]
      }
    }
    admission = await acquireApiKeyAdmission(context.env, principal, requestId)
    await prepareGatewayReservations(context.env, principal, requestId, 0)
    reservationsPrepared = true
    pool = await syncPoolAccounts(
      context.env,
      principal.group_id,
      route.model.model_id,
      'responses',
      route.candidates,
    )
    acquired = await acquireUpstream(
      context.env,
      pool,
      principal.group_id,
      route.model.model_id,
      requestId,
      'responses',
      upstreamBody,
      route.candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      operation,
      route.model.upstream_name,
    )
    if (!acquired.response.ok) {
      if (isUnsupportedTokenCountStatus(acquired.response.status)) {
        await bestEffort(async () => acquired?.response.body?.cancel())
        return geminiTokenCountResponse(estimateInputTokens(upstreamBody), requestId)
      }
      if (isRetryableStatus(acquired.response.status)) {
        await bestEffort(() => recordPoolFailure(
          pool!,
          acquired!.accountId,
          `${requestId}:failure:gemini-token-count`,
          FAILURE_COOLDOWN_MS,
        ))
      }
      await bestEffort(async () => acquired?.response.body?.cancel())
      throw mapUpstreamStatus(acquired.response)
    }
    const bytes = await readResponseLimited(
      acquired.response,
      MAX_SYNC_RESPONSE_BYTES,
      context.req.raw.signal,
      { pool, leaseId: acquired.leaseId, admission, startedAt },
    )
    return geminiTokenCountResponse(readInputTokenCount(bytes, provider), requestId)
  } catch (error) {
    const normalized = error instanceof GeminiCodecError
      ? new GatewayError(400, 'invalid_argument', error.message)
      : asGatewayError(error)
    return geminiErrorResponse(normalized, requestId)
  } finally {
    if (pool !== null && acquired !== null) {
      await bestEffort(() => releasePoolLease(pool!, acquired!.leaseId))
    }
    if (principal !== null && reservationsPrepared) {
      await bestEffort(() => cancelGatewayReservations(context.env, principal!, requestId))
    }
    await bestEffort(() => releaseApiKeyAdmission(admission))
  }
}

export async function handleAnthropicMessages(
  context: Context<GatewayBindings>,
): Promise<Response> {
  return dispatchGateway(
    context,
    'responses',
    (body) => {
      validateClientControls(body)
      const request = parseAnthropicMessagesRequest(body)
      return {
        requestedModel: request.model,
        stream: request.stream,
        resolveUpstream: (model: ModelRoute, _upstreamEndpoint: GatewayEndpoint, platform: ProviderPlatform) => {
          if (platform === 'anthropic') {
            return {
              body: { ...request, model: model.upstream_name },
              operation: 'messages' as const,
              responseProtocol: 'native_anthropic' as const,
            }
          }
          assertProviderOperation(platform, 'responses')
          return {
            body: { ...toOpenAIResponsesRequest(request, model.upstream_name) },
            operation: 'responses' as const,
            transformResponse: (value: unknown) =>
              responsesToAnthropicMessage(value, request.model),
            responseProtocol: 'anthropic' as const,
          }
        },
      }
    },
    anthropicErrorResponse,
  )
}

export async function handleResponsesCompact(
  context: Context<GatewayBindings>,
): Promise<Response> {
  return dispatchGateway(
    context,
    'responses',
    (body) => {
      const prepared = prepareOpenAiRequest(body, 'responses', false)
      return {
        ...prepared,
        resolveUpstream: (model, upstreamEndpoint, platform) => {
          assertProviderOperation(platform, 'responses_compact')
          return {
            ...prepared.resolveUpstream(model, upstreamEndpoint, platform),
            operation: 'responses_compact' as const,
          }
        },
      }
    },
    gatewayErrorResponse,
  )
}

export async function handleAnthropicCountTokens(
  context: Context<GatewayBindings>,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  let acquired: AcquiredUpstream | null = null
  let pool: DurableObjectStub | null = null
  let admission: ApiKeyAdmissionLease | null = null
  let principal: Awaited<ReturnType<typeof authenticateGatewayRequest>> | null = null
  let reservationsPrepared = false
  try {
    principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const parsed = await readGatewayJsonBody(context.req.raw)
    validateClientControls(parsed.body)
    const request = parseAnthropicCountTokensRequest(parsed.body)
    const route = await resolveGatewayRoute(
      context.env,
      principal.group_id,
      request.model,
      'responses',
      principal.user_id,
    )
    const provider = providerForCandidates(route.candidates)
    let operation: ProviderOperation
    let upstreamBody: unknown
    if (provider === 'anthropic') {
      operation = 'count_tokens'
      upstreamBody = { ...request, model: route.model.upstream_name }
    } else {
      if (provider !== 'openai') unsupportedProviderOperation(provider, 'count_tokens')
      operation = 'responses_input_tokens'
      upstreamBody = toOpenAIResponsesInputTokensRequest(request, route.model.upstream_name)
    }
    admission = await acquireApiKeyAdmission(context.env, principal, requestId)
    await prepareGatewayReservations(context.env, principal, requestId, 0)
    reservationsPrepared = true
    pool = await syncPoolAccounts(
      context.env,
      principal.group_id,
      route.model.model_id,
      'responses',
      route.candidates,
    )
    acquired = await acquireUpstream(
      context.env,
      pool,
      principal.group_id,
      route.model.model_id,
      requestId,
      'responses',
      upstreamBody,
      route.candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      operation,
      route.model.upstream_name,
    )

    if (!acquired.response.ok) {
      if (isUnsupportedTokenCountStatus(acquired.response.status)) {
        await bestEffort(async () => acquired?.response.body?.cancel())
        return anthropicTokenCountResponse(estimateInputTokens(upstreamBody), requestId)
      }
      if (isRetryableStatus(acquired.response.status)) {
        await bestEffort(() =>
          recordPoolFailure(
            pool!,
            acquired!.accountId,
            `${requestId}:failure:token-count`,
            FAILURE_COOLDOWN_MS,
          ),
        )
      }
      await bestEffort(async () => acquired?.response.body?.cancel())
      throw mapUpstreamStatus(acquired.response)
    }

    const bytes = await readResponseLimited(
      acquired.response,
      MAX_SYNC_RESPONSE_BYTES,
      context.req.raw.signal,
      { pool, leaseId: acquired.leaseId, admission, startedAt },
    )
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new GatewayError(502, 'invalid_upstream_response', 'Upstream returned invalid token usage', 'server_error')
    }
    const inputTokens = payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>).input_tokens
      : undefined
    if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
      throw new GatewayError(502, 'invalid_upstream_response', 'Upstream returned invalid token usage', 'server_error')
    }
    return anthropicTokenCountResponse(inputTokens as number, requestId)
  } catch (error) {
    const normalized = error instanceof ProtocolValidationError
      ? new GatewayError(400, 'invalid_request_error', error.message)
      : asGatewayError(error)
    return anthropicErrorResponse(normalized, requestId)
  } finally {
    if (pool !== null && acquired !== null) {
      await bestEffort(() => releasePoolLease(pool!, acquired!.leaseId))
    }
    if (principal !== null && reservationsPrepared) {
      await bestEffort(() => cancelGatewayReservations(context.env, principal!, requestId))
    }
    await bestEffort(() => releaseApiKeyAdmission(admission))
  }
}

export async function handleResponsesInputTokens(
  context: Context<GatewayBindings>,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  let acquired: AcquiredUpstream | null = null
  let pool: DurableObjectStub | null = null
  let admission: ApiKeyAdmissionLease | null = null
  let principal: Awaited<ReturnType<typeof authenticateGatewayRequest>> | null = null
  let reservationsPrepared = false
  try {
    principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const parsed = await readGatewayJsonBody(context.req.raw)
    validateClientControls(parsed.body)
    const requestedModel = requiredModel(parsed.body)
    const allowed = new Set(['model', 'instructions', 'input', 'tools', 'tool_choice'])
    const rejected = Object.keys(parsed.body).find((key) => !allowed.has(key))
    if (rejected !== undefined) {
      throw new GatewayError(400, 'invalid_request_error', `Field '${rejected}' is not supported for input token counting`)
    }
    const route = await resolveGatewayRoute(
      context.env,
      principal.group_id,
      requestedModel,
      'responses',
      principal.user_id,
    )
    const provider = providerForCandidates(route.candidates)
    if (provider !== 'openai') unsupportedProviderOperation(provider, 'responses_input_tokens')
    const upstreamBody: Record<string, unknown> = {
      ...parsed.body,
      model: route.model.upstream_name,
    }
    admission = await acquireApiKeyAdmission(context.env, principal, requestId)
    await prepareGatewayReservations(context.env, principal, requestId, 0)
    reservationsPrepared = true
    pool = await syncPoolAccounts(
      context.env,
      principal.group_id,
      route.model.model_id,
      'responses',
      route.candidates,
    )
    acquired = await acquireUpstream(
      context.env,
      pool,
      principal.group_id,
      route.model.model_id,
      requestId,
      'responses',
      upstreamBody,
      route.candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      'responses_input_tokens',
      route.model.upstream_name,
    )

    if (!acquired.response.ok) {
      if (isUnsupportedTokenCountStatus(acquired.response.status)) {
        await bestEffort(async () => acquired?.response.body?.cancel())
        return responsesInputTokensResponse(estimateInputTokens(upstreamBody), requestId)
      }
      if (isRetryableStatus(acquired.response.status)) {
        await bestEffort(() =>
          recordPoolFailure(
            pool!,
            acquired!.accountId,
            `${requestId}:failure:input-tokens`,
            FAILURE_COOLDOWN_MS,
          ),
        )
      }
      await bestEffort(async () => acquired?.response.body?.cancel())
      throw mapUpstreamStatus(acquired.response)
    }

    const bytes = await readResponseLimited(
      acquired.response,
      MAX_SYNC_RESPONSE_BYTES,
      context.req.raw.signal,
      { pool, leaseId: acquired.leaseId, admission, startedAt },
    )
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new GatewayError(502, 'invalid_upstream_response', 'Upstream returned invalid token usage', 'server_error')
    }
    const inputTokens = payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>).input_tokens
      : undefined
    if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
      throw new GatewayError(502, 'invalid_upstream_response', 'Upstream returned invalid token usage', 'server_error')
    }
    return responsesInputTokensResponse(inputTokens as number, requestId)
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error), requestId)
  } finally {
    if (pool !== null && acquired !== null) {
      await bestEffort(() => releasePoolLease(pool!, acquired!.leaseId))
    }
    if (principal !== null && reservationsPrepared) {
      await bestEffort(() => cancelGatewayReservations(context.env, principal!, requestId))
    }
    await bestEffort(() => releaseApiKeyAdmission(admission))
  }
}

function anthropicTokenCountResponse(inputTokens: number, requestId: string): Response {
  return new Response(JSON.stringify({ input_tokens: inputTokens }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'request-id': requestId,
    },
  })
}

function responsesInputTokensResponse(inputTokens: number, requestId: string): Response {
  return new Response(JSON.stringify({
    object: 'response.input_tokens',
    input_tokens: inputTokens,
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  })
}

function geminiTokenCountResponse(inputTokens: number, requestId: string): Response {
  return new Response(JSON.stringify({ totalTokens: inputTokens }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  })
}

function readInputTokenCount(bytes: Uint8Array, platform: ProviderPlatform = 'openai'): number {
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new GatewayError(502, 'invalid_upstream_response', 'Upstream returned invalid token usage', 'server_error')
  }
  const inputTokens = payload !== null && typeof payload === 'object'
    ? platform === 'gemini'
      ? (payload as Record<string, unknown>).totalTokens
      : (payload as Record<string, unknown>).input_tokens
    : undefined
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
    throw new GatewayError(502, 'invalid_upstream_response', 'Upstream returned invalid token usage', 'server_error')
  }
  return inputTokens as number
}

function estimateInputTokens(body: unknown): number {
  // A conservative fallback for relays that do not expose
  // /responses/input_tokens. Exact counting remains the preferred path.
  const bytes = encoder.encode(JSON.stringify(body)).byteLength
  return Math.max(1, Math.ceil(bytes / 4))
}

function isUnsupportedTokenCountStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

function assertProviderOperation(platform: ProviderPlatform, operation: ProviderOperation): void {
  const supported: Record<ProviderPlatform, ReadonlySet<ProviderOperation>> = {
    openai: new Set([
      'models',
      'chat_completions',
      'responses',
      'responses_compact',
      'responses_input_tokens',
      'embeddings',
    ]),
    anthropic: new Set(['models', 'messages', 'count_tokens']),
    gemini: new Set(['models', 'generate_content', 'stream_generate_content', 'count_tokens', 'embeddings']),
    codex: new Set(['models', 'responses']),
  }
  if (!supported[platform].has(operation)) unsupportedProviderOperation(platform, operation)
}

function unsupportedProviderOperation(
  platform: ProviderPlatform,
  operation: ProviderOperation,
): never {
  throw new GatewayError(
    409,
    'provider_operation_not_supported',
    `The ${operation} operation is not supported by the selected ${platform} provider route`,
  )
}

function extractProviderUsage(value: unknown, platform: ProviderPlatform): TokenUsage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  if (platform === 'anthropic') {
    const usage = objectValue(root.usage)
    if (usage === null) return null
    const input = nonNegativeInteger(usage.input_tokens)
    const output = nonNegativeInteger(usage.output_tokens)
    if (input === null || output === null) return null
    return normalizedAnthropicUsage(
      input,
      output,
      nonNegativeInteger(usage.cache_creation_input_tokens) ?? 0,
      nonNegativeInteger(usage.cache_read_input_tokens) ?? 0,
    )
  }
  if (platform === 'gemini') {
    const usage = objectValue(root.usageMetadata)
    if (usage === null) return null
    const input = nonNegativeInteger(usage.promptTokenCount)
    const candidates = nonNegativeInteger(usage.candidatesTokenCount)
    const thoughts = nonNegativeInteger(usage.thoughtsTokenCount) ?? 0
    if (input === null || candidates === null) return null
    return {
      input_tokens: input,
      output_tokens: candidates + thoughts,
      cache_read_tokens: Math.min(nonNegativeInteger(usage.cachedContentTokenCount) ?? 0, input),
      estimated: false,
    }
  }
  return extractUsage(value)
}

function normalizedAnthropicUsage(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): TokenUsage | null {
  const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens
  if (!Number.isSafeInteger(totalInputTokens)) return null
  return {
    // Anthropic reports ordinary, cache-write, and cache-read input as separate
    // buckets. The shared price engine expects total input with cache reads tagged
    // separately, so folding all buckets here prices each token exactly once.
    input_tokens: totalInputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    estimated: false,
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function providerForCandidates(candidates: Array<{ platform: ProviderPlatform }>): ProviderPlatform {
  const platform = candidates[0]?.platform
  if (platform === undefined || candidates.some((candidate) => candidate.platform !== platform)) {
    throw new GatewayError(500, 'invalid_provider_account', 'Upstream provider candidates are inconsistent', 'server_error')
  }
  return platform
}

interface PreparedGatewayRequest {
  requestedModel: string
  stream: boolean
  resolveUpstream: (
    model: ModelRoute,
    upstreamEndpoint: GatewayEndpoint,
    platform: ProviderPlatform,
  ) => ProviderDispatch
  protocolFallback?: 'responses_to_chat'
}

type ResponseProtocol =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'responses_from_chat'
  | 'native_anthropic'
  | 'native_gemini'

interface ProviderDispatch {
  body: Record<string, unknown>
  operation: ProviderOperation
  responseProtocol: ResponseProtocol
  transformResponse?: (value: unknown) => unknown
}

type PrepareGatewayRequest = (body: Record<string, unknown>) => PreparedGatewayRequest
type GatewayErrorResponder = (error: GatewayError, requestId?: string) => Response

function prepareOpenAiRequest(
  body: Record<string, unknown>,
  endpoint: GatewayEndpoint,
  allowProtocolFallback = endpoint === 'responses',
): PreparedGatewayRequest {
  validateClientControls(body)
  const requestedModel = requiredModel(body)
  const stream = parseStream(body)
  return {
    requestedModel,
    stream,
    resolveUpstream: (model, upstreamEndpoint, platform) => {
      const operation = upstreamEndpoint
      if (platform !== 'openai' && !(platform === 'codex' && operation === 'responses')) {
        return unsupportedProviderOperation(platform, operation)
      }
      if (
        endpoint === 'responses' &&
        allowProtocolFallback &&
        upstreamEndpoint === 'chat_completions'
      ) {
        const fallbackBody = body.max_output_tokens === undefined
          ? { ...body, max_output_tokens: model.default_max_output_tokens }
          : body
        return {
          body: responsesToChatCompletionsRequest(
            parseResponsesRequest(fallbackBody),
            model.upstream_name,
          ) as unknown as Record<string, unknown>,
          operation: 'chat_completions',
          responseProtocol: 'responses_from_chat',
        }
      }
      const upstreamBody: Record<string, unknown> = { ...body, model: model.upstream_name }
      if (
        upstreamBody.max_output_tokens === undefined &&
        upstreamBody.max_completion_tokens === undefined &&
        upstreamBody.max_tokens === undefined
      ) {
        upstreamBody[endpoint === 'responses' ? 'max_output_tokens' : 'max_tokens'] =
          model.default_max_output_tokens
      }
      if (stream && endpoint === 'chat_completions') {
        const existing = upstreamBody.stream_options
        upstreamBody.stream_options = {
          ...(existing !== null && typeof existing === 'object' && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : {}),
          include_usage: true,
        }
      }
      return { body: upstreamBody, operation, responseProtocol: 'openai' }
    },
    ...(endpoint === 'responses' && allowProtocolFallback
      ? { protocolFallback: 'responses_to_chat' as const }
      : {}),
  }
}

async function dispatchGateway(
  context: Context<GatewayBindings>,
  endpoint: GatewayEndpoint,
  prepare: PrepareGatewayRequest,
  errorResponse: GatewayErrorResponder,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  let admission: ApiKeyAdmissionLease | null = null
  let admissionHandedOff = false
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const parsed = await readGatewayJsonBody(context.req.raw)
    const prepared = prepare(parsed.body)
    const { requestedModel, stream } = prepared
    const route = await resolveGatewayRoute(
      context.env,
      principal.group_id,
      requestedModel,
      endpoint,
      principal.user_id,
      prepared.protocolFallback === 'responses_to_chat' ? 'chat_completions' : undefined,
    )
    const model = route.model
    const upstreamEndpoint = route.upstream_endpoint
    const provider = providerForCandidates(route.candidates)
    const affinityKey = await gatewaySessionAffinityKey(
      context.req.raw.headers,
      parsed.body,
      context.env,
      principal,
      model.model_id,
      upstreamEndpoint,
    )
    const providerDispatch = prepared.resolveUpstream(model, upstreamEndpoint, provider)
    const upstreamBody = providerDispatch.body
    const pricedReservationMicros = reservationForRequest(
      model,
      upstreamBody,
      parsed.bytes.byteLength,
      endpoint,
    )
    // A zero effective multiplier is an explicitly free subscription tier. Its
    // worst-case billed cost is zero, so it must not require a positive quota hold.
    const reservationMicros = principal.billing.type === 'subscription' &&
      model.rate_multiplier_ppm === 0
      ? 0
      : pricedReservationMicros
    const candidates = route.candidates

    admission = await acquireApiKeyAdmission(context.env, principal, requestId)
    await prepareGatewayReservations(context.env, principal, requestId, reservationMicros)
    let pool: DurableObjectStub
    try {
      pool = await syncPoolAccounts(
        context.env,
        principal.group_id,
        model.model_id,
        upstreamEndpoint,
        candidates,
      )
    } catch (error) {
      await bestEffort(() => cancelGatewayReservations(context.env, principal, requestId))
      throw error
    }

    const acquired = await acquireUpstream(
      context.env,
      pool,
      principal.group_id,
      model.model_id,
      requestId,
      upstreamEndpoint,
      upstreamBody,
      candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      providerDispatch.operation,
      model.upstream_name,
      affinityKey,
    ).catch(async (error) => {
      await bestEffort(() => cancelGatewayReservations(context.env, principal, requestId))
      throw error
    })

    if (!acquired.response.ok) {
      if (acquired.retryableFailure) {
        await bestEffort(() =>
          recordPoolFailure(
            pool,
            acquired.accountId,
            `${requestId}:failure:final`,
            FAILURE_COOLDOWN_MS,
          ),
        )
      }
      await bestEffort(async () => acquired.response.body?.cancel())
      await bestEffort(() => releasePoolLease(pool, acquired.leaseId))
      await bestEffort(() => cancelGatewayReservations(context.env, principal, requestId))
      throw mapUpstreamStatus(acquired.response)
    }

    const contentType = acquired.response.headers.get('content-type') ?? ''
    if (
      endpoint !== 'embeddings' &&
      stream &&
      contentType.toLowerCase().includes('text/event-stream')
    ) {
      if (acquired.response.body === null) {
        await bestEffort(() => releasePoolLease(pool, acquired.leaseId))
        await bestEffort(() => cancelGatewayReservations(context.env, principal, requestId))
        throw new GatewayError(502, 'empty_upstream_stream', 'Upstream returned an empty stream', 'server_error')
      }
      admissionHandedOff = true
      return createStreamingResponse({
        env: context.env,
        endpoint,
        response: acquired.response,
        pool,
        leaseId: acquired.leaseId,
        accountId: acquired.accountId,
        requestId,
        principal,
        model,
        requestedModel,
        inputBytes: parsed.bytes.byteLength,
        stream,
        startedAt,
        admission,
        providerPlatform: provider,
        responseProtocol: providerDispatch.responseProtocol,
        waitUntil: optionalWaitUntil(context),
      })
    }

    admissionHandedOff = true
    return await createSynchronousResponse({
      env: context.env,
      response: acquired.response,
      endpoint,
      pool,
      leaseId: acquired.leaseId,
      accountId: acquired.accountId,
      requestId,
      principal,
      model,
      requestedModel,
      inputBytes: parsed.bytes.byteLength,
      clientSignal: context.req.raw.signal,
      stream,
      startedAt,
      admission,
      providerPlatform: provider,
      transformResponse: providerDispatch.responseProtocol === 'responses_from_chat'
        ? (value) => chatCompletionsResponseToResponses(value, requestedModel)
        : providerDispatch.transformResponse,
    })
  } catch (error) {
    const normalized = error instanceof ProtocolValidationError
      ? new GatewayError(400, 'invalid_request_error', error.message)
      : error instanceof ResponsesBridgeError
        ? new GatewayError(400, 'invalid_request_error', error.message)
      : error instanceof GeminiCodecError
        ? new GatewayError(400, 'invalid_argument', error.message)
        : asGatewayError(error)
    return errorResponse(normalized, requestId)
  } finally {
    if (!admissionHandedOff) {
      await bestEffort(() => releaseApiKeyAdmission(admission))
    }
  }
}

function anthropicErrorResponse(error: GatewayError, requestId?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  if (requestId) headers.set('request-id', requestId)
  if (error.retryAfter) headers.set('retry-after', error.retryAfter)
  headers.set('x-error-code', error.code)
  const mapped = mapOpenAIErrorToAnthropic(error.status)
  return new Response(JSON.stringify({
    ...mapped,
    error: { ...mapped.error, code: error.code },
  }), {
    status: error.status,
    headers,
  })
}

function geminiErrorResponse(error: GatewayError, requestId?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  if (requestId) headers.set('x-request-id', requestId)
  if (error.retryAfter) headers.set('retry-after', error.retryAfter)
  headers.set('x-error-code', error.code)
  const status = error.status === 400
    ? 'INVALID_ARGUMENT'
    : error.status === 401
      ? 'UNAUTHENTICATED'
      : error.status === 403
        ? 'PERMISSION_DENIED'
        : error.status === 404
          ? 'NOT_FOUND'
          : error.status === 429
            ? 'RESOURCE_EXHAUSTED'
            : error.status === 503 || error.status === 504
              ? 'UNAVAILABLE'
              : 'INTERNAL'
  return new Response(JSON.stringify({
    error: { code: error.status, message: error.message, status, gateway_code: error.code },
  }), { status: error.status, headers })
}

interface AcquiredUpstream {
  response: Response
  accountId: string
  leaseId: string
  retryableFailure: boolean
}

type UpstreamOperation = ProviderOperation

async function acquireUpstream(
  env: Env,
  pool: DurableObjectStub,
  groupId: string,
  modelId: string,
  requestId: string,
  endpoint: GatewayEndpoint,
  body: unknown,
  candidateCount: number,
  inboundHeaders: Headers,
  clientSignal: AbortSignal,
  operation: UpstreamOperation = endpoint,
  upstreamModel?: string,
  affinityKey?: string,
): Promise<AcquiredUpstream> {
  let lastError: GatewayError | null = null
  const attempts = endpoint === 'embeddings'
    ? Math.min(4, candidateCount)
    : Math.min(4, candidateCount + 1)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const leaseId = `${requestId}:${attempt}`
    let accountId: string | null = null
    try {
      accountId = await reservePoolAccount(pool, leaseId, affinityKey)
      const account = await getAccountCredential(env, groupId, modelId, endpoint, accountId)
      if (!env.CREDENTIALS_MASTER_KEY) {
        throw new GatewayError(503, 'gateway_not_configured', 'Credential secret is not configured', 'server_error')
      }
      const credential = await decryptCredential(
        account.nonce_b64,
        account.ciphertext_b64,
        env.CREDENTIALS_MASTER_KEY,
        credentialAad(env.ENVIRONMENT, account.account_id, account.secret_id, account.key_version),
      )
      const plan = buildProviderRequest({
        account,
        credential,
        operation,
        model: upstreamModel,
        body,
        client_headers: inboundHeaders,
      })
      const response = await fetchWithHeaderTimeout(new URL(plan.url), {
        method: plan.method,
        headers: plan.headers,
        body: plan.body === undefined ? undefined : JSON.stringify(plan.body),
        redirect: 'manual',
      }, clientSignal, plan.timeout_ms)
      if (response.status >= 300 && response.status < 400) {
        await bestEffort(async () => response.body?.cancel())
        throw new GatewayError(502, 'upstream_redirect_rejected', 'Upstream redirect was rejected', 'server_error')
      }
      const retryableFailure = !response.ok && (
        endpoint === 'embeddings'
          ? await isRetryableEmbeddingsResponse(response)
          : isRetryableStatus(response.status)
      )
      if (retryableFailure && attempt + 1 < attempts) {
        lastError = mapUpstreamStatus(response)
        await bestEffort(async () => response.body?.cancel())
        await bestEffort(() => recordPoolFailure(pool, accountId!, `${requestId}:failure:${attempt}`, FAILURE_COOLDOWN_MS))
        await bestEffort(() => releasePoolLease(pool, leaseId))
        continue
      }
      return { response, accountId, leaseId, retryableFailure }
    } catch (error) {
      const currentError = asGatewayError(error)
      if (currentError.code === 'no_capacity' && lastError !== null) break
      if (!isRetryableAttemptError(currentError, endpoint)) {
        await bestEffort(() => releasePoolLease(pool, leaseId))
        throw currentError
      }
      lastError = currentError
      if (accountId !== null) {
        if (currentError.code === 'credential_unavailable') {
          await bestEffort(() => disablePoolAccount(pool, accountId!))
        }
        await bestEffort(() => recordPoolFailure(pool, accountId!, `${requestId}:failure:${attempt}`, FAILURE_COOLDOWN_MS))
      }
      await bestEffort(() => releasePoolLease(pool, leaseId))
    }
  }
  throw lastError ?? new GatewayError(503, 'no_upstream_capacity', 'No upstream account has capacity', 'server_error')
}

interface FinalizeInput {
  env: Env
  endpoint: GatewayEndpoint
  pool: DurableObjectStub
  leaseId: string
  accountId: string
  requestId: string
  principal: Awaited<ReturnType<typeof authenticateGatewayRequest>>
  model: ModelRoute
  requestedModel: string
  inputBytes: number
  stream: boolean
  startedAt: number
  admission: ApiKeyAdmissionLease | null
  providerPlatform: ProviderPlatform
}

async function createSynchronousResponse(
  input: FinalizeInput & {
    response: Response
    clientSignal: AbortSignal
    transformResponse?: (value: unknown) => unknown
  },
): Promise<Response> {
  try {
    let bytes: Uint8Array
    try {
      bytes = await readResponseLimited(
        input.response,
        MAX_SYNC_RESPONSE_BYTES,
        input.clientSignal,
        {
          pool: input.pool,
          leaseId: input.leaseId,
          admission: input.admission,
          startedAt: input.startedAt,
        },
      )
    } catch (error) {
      await bestEffort(() =>
        settleAndProject(
          input,
          estimatedUsage(input.inputBytes, 0),
          error instanceof GatewayError && error.code === 'client_cancelled'
            ? 'cancelled'
            : 'failed',
        ),
      )
      throw error
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      // Compatible upstreams occasionally return non-JSON bodies; charge by bounded byte estimate.
    }
    const usage = extractProviderUsage(parsed, input.providerPlatform) ??
      estimatedUsage(input.inputBytes, input.endpoint === 'embeddings' ? 0 : bytes.byteLength)
    let downstreamValue: unknown = parsed
    if (input.transformResponse !== undefined) {
      try {
        if (parsed === null) throw new Error('upstream response is not JSON')
        downstreamValue = input.transformResponse(parsed)
      } catch {
        await bestEffort(() => settleAndProject(input, usage, 'failed'))
        throw new GatewayError(
          502,
          'invalid_upstream_response',
          'Upstream returned an invalid response',
          'server_error',
        )
      }
    }
    await settleAndProject(input, usage, 'completed')
    const output = downstreamValue === null
      ? bytes
      : encoder.encode(JSON.stringify(
        input.transformResponse === undefined
          ? rewriteModelNames(downstreamValue, input.model.upstream_name, input.requestedModel)
          : downstreamValue,
      ))
    const headers = responseHeaders(input.response.headers, false)
    headers.set('content-length', String(output.byteLength))
    return new Response(output.buffer as ArrayBuffer, { status: input.response.status, headers })
  } finally {
    await Promise.all([
      bestEffort(() => releasePoolLease(input.pool, input.leaseId)),
      bestEffort(() => releaseApiKeyAdmission(input.admission)),
    ])
  }
}

interface GatewayStreamTransformer {
  push(chunk: Uint8Array): Uint8Array[]
  finish(): Uint8Array[]
  usage(): TokenUsage | null
  outputBytes(): number
  terminal(): 'completed' | 'failed' | 'missing'
  errorFrame(message: string): Uint8Array
}

type WaitUntil = (task: Promise<unknown>) => void

function optionalWaitUntil(context: Context<GatewayBindings>): WaitUntil | undefined {
  try {
    const executionCtx = context.executionCtx
    return (task) => executionCtx.waitUntil(task)
  } catch {
    // Hono's in-process request helper has no ExecutionContext. Cloudflare fetches do.
    return undefined
  }
}

class OpenAiStreamTransformer implements GatewayStreamTransformer {
  private readonly delegate: SseEventTransformer

  constructor(
    upstreamModel: string,
    private readonly publicModel: string,
    private readonly endpoint: GenerativeGatewayEndpoint,
  ) {
    this.delegate = new SseEventTransformer(upstreamModel, this.publicModel)
  }

  push(chunk: Uint8Array): Uint8Array[] {
    return this.delegate.push(chunk)
  }

  finish(): Uint8Array[] {
    return this.delegate.finish()
  }

  usage(): TokenUsage | null {
    return this.delegate.usage()
  }

  outputBytes(): number {
    return this.delegate.outputBytes()
  }

  terminal(): 'completed' | 'failed' | 'missing' {
    return this.delegate.terminal(this.endpoint)
  }

  errorFrame(message: string): Uint8Array {
    return streamErrorFrame(this.endpoint, message, this.publicModel)
  }
}

class ChatResponsesStreamTransformer implements GatewayStreamTransformer {
  private readonly decoder = new TextDecoder()
  private readonly accounting: SseEventTransformer
  private readonly codec: ChatCompletionsToResponsesEventCodec
  private buffer = ''
  private emittedBytes = 0
  private terminalValue: 'completed' | 'failed' | null = null

  constructor(upstreamModel: string, private readonly publicModel: string) {
    this.accounting = new SseEventTransformer(upstreamModel, publicModel)
    this.codec = new ChatCompletionsToResponsesEventCodec(publicModel)
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.accounting.push(chunk)
    this.buffer += this.decoder.decode(chunk, { stream: true })
    if (this.buffer.length > MAX_SYNC_RESPONSE_BYTES) {
      throw new GatewayError(
        502,
        'invalid_upstream_stream',
        'Upstream SSE event exceeded the size limit',
        'server_error',
      )
    }
    return this.drain(false)
  }

  finish(): Uint8Array[] {
    this.accounting.finish()
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  usage(): TokenUsage | null {
    return this.accounting.usage()
  }

  outputBytes(): number {
    return this.emittedBytes
  }

  terminal(): 'completed' | 'failed' | 'missing' {
    return this.terminalValue ?? 'missing'
  }

  errorFrame(message: string): Uint8Array {
    return streamErrorFrame('responses', message, this.publicModel)
  }

  private drain(flush: boolean): Uint8Array[] {
    const chunks: Uint8Array[] = []
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match === null) break
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      chunks.push(...this.transformFrame(frame))
    }
    if (flush && this.buffer.length > 0) {
      chunks.push(...this.transformFrame(this.buffer))
      this.buffer = ''
    }
    return chunks
  }

  private transformFrame(frame: string): Uint8Array[] {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data === '') return []
    const events = data === '[DONE]'
      ? this.codec.finish()
      : this.codec.push(JSON.parse(data) as unknown)
    return events.map((event) => {
      if (event.type === 'response.completed') this.terminalValue = 'completed'
      if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        this.terminalValue = 'failed'
      }
      const encoded = encoder.encode(formatResponsesSseEvent(event))
      this.emittedBytes += encoded.byteLength
      return encoded
    })
  }
}

class GeminiResponsesStreamTransformer implements GatewayStreamTransformer {
  private readonly decoder = new TextDecoder()
  private readonly accounting: SseEventTransformer
  private readonly codec: OpenAIResponsesToGeminiSseConverter
  private buffer = ''
  private emittedBytes = 0

  constructor(upstreamModel: string, private readonly publicModel: string) {
    this.accounting = new SseEventTransformer(upstreamModel, publicModel)
    this.codec = new OpenAIResponsesToGeminiSseConverter({ publicModel })
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.accounting.push(chunk)
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  finish(): Uint8Array[] {
    this.accounting.finish()
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  usage(): TokenUsage | null {
    return this.accounting.usage()
  }

  outputBytes(): number {
    return this.emittedBytes
  }

  terminal(): 'completed' | 'failed' | 'missing' {
    return this.accounting.terminal('responses')
  }

  errorFrame(message: string): Uint8Array {
    return encoder.encode(serializeGeminiSseFrame({
      data: { error: { code: 502, message, status: 'INTERNAL' } },
    }))
  }

  private drain(flush: boolean): Uint8Array[] {
    const chunks: Uint8Array[] = []
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match === null) break
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      chunks.push(...this.transformFrame(frame))
    }
    if (flush && this.buffer.length > 0) {
      chunks.push(...this.transformFrame(this.buffer))
      this.buffer = ''
    }
    return chunks
  }

  private transformFrame(frame: string): Uint8Array[] {
    let eventName: string | undefined
    const data: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    const serialized = data.join('\n')
    if (serialized === '' || serialized === '[DONE]') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch {
      parsed = { type: 'error', error: { message: 'Failed to parse upstream event' } }
    }
    return this.codec.push(parsed, eventName).map((geminiFrame) => {
      const encoded = encoder.encode(serializeGeminiSseFrame(geminiFrame))
      this.emittedBytes += encoded.byteLength
      return encoded
    })
  }
}

class AnthropicResponsesStreamTransformer implements GatewayStreamTransformer {
  private readonly decoder = new TextDecoder()
  private readonly accounting: SseEventTransformer
  private readonly codec: ResponsesToAnthropicEventCodec
  private buffer = ''
  private emittedBytes = 0

  constructor(upstreamModel: string, publicModel: string) {
    this.accounting = new SseEventTransformer(upstreamModel, publicModel)
    this.codec = new ResponsesToAnthropicEventCodec(publicModel)
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.accounting.push(chunk)
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  finish(): Uint8Array[] {
    this.accounting.finish()
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  usage(): TokenUsage | null {
    return this.accounting.usage()
  }

  outputBytes(): number {
    return this.emittedBytes
  }

  terminal(): 'completed' | 'failed' | 'missing' {
    return this.accounting.terminal('responses')
  }

  errorFrame(_message: string): Uint8Array {
    return encoder.encode(formatAnthropicSseEvent({
      ...mapOpenAIErrorToAnthropic(502),
      type: 'error',
    }))
  }

  private drain(flush: boolean): Uint8Array[] {
    const chunks: Uint8Array[] = []
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match === null) break
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      chunks.push(...this.transformFrame(frame))
    }
    if (flush && this.buffer.length > 0) {
      chunks.push(...this.transformFrame(this.buffer))
      this.buffer = ''
    }
    return chunks
  }

  private transformFrame(frame: string): Uint8Array[] {
    let eventName: string | undefined
    const dataLines: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    const data = dataLines.join('\n')
    if (data === '' || data === '[DONE]') return []

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new GatewayError(
        502,
        'invalid_upstream_stream',
        'Upstream returned an invalid event stream',
        'server_error',
      )
    }
    if (
      eventName !== undefined &&
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).type !== 'string'
    ) {
      parsed = { ...(parsed as Record<string, unknown>), type: eventName }
    }
    return this.codec.push(parsed).map((event) => {
      const encoded = encoder.encode(formatAnthropicSseEvent(event))
      this.emittedBytes += encoded.byteLength
      return encoded
    })
  }
}

class NativeProviderStreamTransformer implements GatewayStreamTransformer {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private emittedBytes = 0
  private inputTokens: number | null = null
  private outputTokens: number | null = null
  private cacheCreationTokens = 0
  private cacheReadTokens = 0
  private terminalValue: 'completed' | 'failed' | null = null

  constructor(
    private readonly platform: 'anthropic' | 'gemini',
    private readonly upstreamModel: string,
    private readonly publicModel: string,
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    if (this.buffer.length > MAX_SYNC_RESPONSE_BYTES) {
      throw new GatewayError(502, 'invalid_upstream_stream', 'Upstream SSE event exceeded the size limit', 'server_error')
    }
    return this.drain(false)
  }

  finish(): Uint8Array[] {
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  usage(): TokenUsage | null {
    if (this.inputTokens === null || this.outputTokens === null) return null
    if (this.platform === 'anthropic') {
      return normalizedAnthropicUsage(
        this.inputTokens,
        this.outputTokens,
        this.cacheCreationTokens,
        this.cacheReadTokens,
      )
    }
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cache_read_tokens: Math.min(this.cacheReadTokens, this.inputTokens),
      estimated: false,
    }
  }

  outputBytes(): number {
    return this.emittedBytes
  }

  terminal(): 'completed' | 'failed' | 'missing' {
    return this.terminalValue ?? 'missing'
  }

  errorFrame(message: string): Uint8Array {
    if (this.platform === 'anthropic') {
      return encoder.encode(formatAnthropicSseEvent({
        type: 'error',
        error: { type: 'api_error', message },
      }))
    }
    return encoder.encode(serializeGeminiSseFrame({
      data: { error: { code: 502, message, status: 'INTERNAL' } },
    }))
  }

  private drain(flush: boolean): Uint8Array[] {
    const chunks: Uint8Array[] = []
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match === null) break
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      chunks.push(this.transformFrame(frame, match[0]))
    }
    if (flush && this.buffer.length > 0) {
      chunks.push(this.transformFrame(this.buffer, ''))
      this.buffer = ''
    }
    return chunks
  }

  private transformFrame(frame: string, delimiter: string): Uint8Array {
    const sourceLines = frame.split(/\r?\n/)
    const eventName = sourceLines.find((line) => line.startsWith('event:'))?.slice(6).trim()
    const data = sourceLines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data === '' || data === '[DONE]') return this.encode(frame + delimiter)

    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      throw new GatewayError(502, 'invalid_upstream_stream', 'Upstream returned an invalid event stream', 'server_error')
    }
    const root = objectValue(payload)
    if (root !== null) this.observe(root, eventName)
    const rewritten = rewriteModelNames(payload, this.upstreamModel, this.publicModel)
    const lines = sourceLines.filter((line) => !line.startsWith('data:'))
    lines.push(`data: ${JSON.stringify(rewritten)}`)
    return this.encode(lines.join('\n') + delimiter)
  }

  private observe(root: Record<string, unknown>, eventName?: string): void {
    if (this.platform === 'anthropic') {
      const type = typeof root.type === 'string' ? root.type : eventName
      this.observeAnthropicUsage(objectValue(root.usage))
      this.observeAnthropicUsage(objectValue(objectValue(root.message)?.usage))
      if (type === 'message_stop') this.terminalValue = 'completed'
      if (type === 'error') this.terminalValue = 'failed'
      return
    }

    const usage = extractProviderUsage(root, 'gemini')
    if (usage !== null) {
      this.inputTokens = usage.input_tokens
      this.outputTokens = usage.output_tokens
      this.cacheReadTokens = usage.cache_read_tokens
    }
    if (root.error !== undefined) this.terminalValue = 'failed'
    const candidates = Array.isArray(root.candidates) ? root.candidates : []
    if (candidates.some((candidate) => {
      const value = objectValue(candidate)?.finishReason
      return typeof value === 'string' && value !== '' && value !== 'FINISH_REASON_UNSPECIFIED'
    })) this.terminalValue = 'completed'
  }

  private observeAnthropicUsage(usage: Record<string, unknown> | null): void {
    if (usage === null) return
    this.inputTokens = nonNegativeInteger(usage.input_tokens) ?? this.inputTokens
    this.outputTokens = nonNegativeInteger(usage.output_tokens) ?? this.outputTokens
    this.cacheCreationTokens = nonNegativeInteger(usage.cache_creation_input_tokens) ?? this.cacheCreationTokens
    this.cacheReadTokens = nonNegativeInteger(usage.cache_read_input_tokens) ?? this.cacheReadTokens
  }

  private encode(value: string): Uint8Array {
    const encoded = encoder.encode(value)
    this.emittedBytes += encoded.byteLength
    return encoded
  }
}

function createStreamingResponse(input: FinalizeInput & {
  response: Response
  endpoint: GenerativeGatewayEndpoint
  responseProtocol: ResponseProtocol
  waitUntil?: WaitUntil
}): Response {
  const reader = input.response.body!.getReader()
  const tracker: GatewayStreamTransformer = input.responseProtocol === 'native_anthropic'
    ? new NativeProviderStreamTransformer('anthropic', input.model.upstream_name, input.requestedModel)
    : input.responseProtocol === 'native_gemini'
      ? new NativeProviderStreamTransformer('gemini', input.model.upstream_name, input.requestedModel)
      : input.responseProtocol === 'anthropic'
        ? new AnthropicResponsesStreamTransformer(input.model.upstream_name, input.requestedModel)
        : input.responseProtocol === 'gemini'
          ? new GeminiResponsesStreamTransformer(input.model.upstream_name, input.requestedModel)
          : input.responseProtocol === 'responses_from_chat'
            ? new ChatResponsesStreamTransformer(input.model.upstream_name, input.requestedModel)
            : new OpenAiStreamTransformer(input.model.upstream_name, input.requestedModel, input.endpoint)
  let finalized: Promise<void> | null = null
  let userRenewal = 0
  let poolRenewal = 0
  let admissionRenewal = 0
  let lastLeaseRenewedAt = Date.now()
  let lastBillingRenewedAt = Date.now()
  let lastChunkAt = Date.now()
  let emitted = false
  let downstreamCancelled = false
  let disconnectStartedAt: number | null = null
  const disconnectSignal = new AbortController()
  let finished = false
  let operationChain: Promise<void> = Promise.resolve()

  const finalize = (outcome: 'completed' | 'failed' | 'cancelled'): Promise<void> => {
    if (finalized !== null) return finalized
    finalized = (async () => {
      try {
        const usage = tracker.usage()
        if (usage !== null || emitted) {
          await settleAndProject(
            input,
            usage ?? estimatedUsage(input.inputBytes, tracker.outputBytes()),
            outcome,
          )
        } else {
          await cancelGatewayReservations(input.env, input.principal, input.requestId)
        }
      } finally {
        await Promise.all([
          bestEffort(() => releasePoolLease(input.pool, input.leaseId)),
          bestEffort(() => releaseApiKeyAdmission(input.admission)),
        ])
      }
    })()
    return finalized
  }

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const next = operationChain.then(operation, operation)
    operationChain = next.catch(() => undefined)
    return next
  }

  const renewIfDue = async (): Promise<void> => {
    const now = Date.now()
    if (now - lastLeaseRenewedAt >= RENEW_AFTER_MS) {
      admissionRenewal += 1
      poolRenewal += 1
      await renewApiKeyAdmission(input.admission, admissionRenewal)
      await renewPoolLease(input.pool, input.leaseId, poolRenewal)
      lastLeaseRenewedAt = Date.now()
    }
    if (now - lastBillingRenewedAt >= BILLING_RENEW_AFTER_MS) {
      userRenewal += 1
      await Promise.all([
        renewBillingReservation(input.env, input.principal, input.requestId, userRenewal),
        renewApiKeyMonetaryReservation(input.env, input.principal, input.requestId, userRenewal),
      ])
      lastBillingRenewedAt = Date.now()
    }
  }

  const readNext = async (
    idleTimeoutMs: number,
    deadlineMs: number,
  ): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const pendingRead = reader.read().then((result) => ({ kind: 'read' as const, result }))
    while (true) {
      const now = Date.now()
      const activeIdleTimeoutMs = downstreamCancelled
        ? DISCONNECT_DRAIN_IDLE_TIMEOUT_MS
        : idleTimeoutMs
      const activeDeadlineMs = disconnectStartedAt === null
        ? deadlineMs
        : Math.min(deadlineMs, disconnectStartedAt + DISCONNECT_DRAIN_TOTAL_TIMEOUT_MS)
      if (now >= activeDeadlineMs) {
        throw new GatewayError(504, 'upstream_timeout', 'Upstream stream exceeded the maximum duration', 'server_error')
      }
      await renewIfDue()
      const raced = await readOrTickOrAbort(
        pendingRead,
        Math.max(1, Math.min(RENEW_AFTER_MS, activeIdleTimeoutMs, activeDeadlineMs - now)),
        downstreamCancelled ? undefined : disconnectSignal.signal,
      )
      if (raced.kind === 'read') return raced.result
      if (raced.kind === 'abort') continue
      if (Date.now() - lastChunkAt >= activeIdleTimeoutMs) {
        throw new GatewayError(504, 'upstream_idle_timeout', 'Upstream stream timed out', 'server_error')
      }
    }
  }

  const enqueue = (
    controller: ReadableStreamDefaultController<Uint8Array> | null,
    chunks: Uint8Array[],
  ): void => {
    if (controller === null || downstreamCancelled) return
    for (const chunk of chunks) {
      emitted ||= chunk.byteLength > 0
      controller.enqueue(chunk)
    }
  }

  const finishAtTerminal = async (
    controller: ReadableStreamDefaultController<Uint8Array> | null,
    terminal: 'completed' | 'failed',
  ): Promise<void> => {
    finished = true
    // Fetch-body cancellation is initiated immediately but never delays billing or downstream EOF.
    void bestEffort(() => reader.cancel('upstream terminal event received'))
    await bestEffort(() => finalize(
      downstreamCancelled
        ? 'cancelled'
        : terminal === 'completed'
          ? 'completed'
          : 'failed',
    ))
    if (controller !== null && !downstreamCancelled) controller.close()
  }

  const processRead = async (
    result: ReadableStreamReadResult<Uint8Array>,
    controller: ReadableStreamDefaultController<Uint8Array> | null,
  ): Promise<void> => {
    if (result.done) {
      enqueue(controller, tracker.finish())
      const terminal = tracker.terminal()
      if (terminal === 'missing' && controller !== null && !downstreamCancelled) {
        controller.enqueue(tracker.errorFrame('Upstream stream ended before a terminal event'))
      }
      finished = true
      await bestEffort(() => finalize(
        downstreamCancelled
          ? 'cancelled'
          : terminal === 'completed'
            ? 'completed'
            : 'failed',
      ))
      if (controller !== null && !downstreamCancelled) controller.close()
      return
    }

    lastChunkAt = Date.now()
    enqueue(controller, tracker.push(result.value))
    const terminal = tracker.terminal()
    if (terminal !== 'missing') await finishAtTerminal(controller, terminal)
  }

  const drainAfterCancellation = async (): Promise<void> => {
    if (finished) {
      await bestEffort(() => finalize('cancelled'))
      return
    }
    lastChunkAt = Date.now()
    const deadline = Math.min(
      input.startedAt + TOTAL_STREAM_TIMEOUT_MS,
      (disconnectStartedAt ?? Date.now()) + DISCONNECT_DRAIN_TOTAL_TIMEOUT_MS,
    )
    try {
      while (!finished) {
        const result = await readNext(DISCONNECT_DRAIN_IDLE_TIMEOUT_MS, deadline)
        await processRead(result, null)
      }
    } catch (error) {
      finished = true
      void bestEffort(() => reader.cancel(error))
      await bestEffort(() => finalize('cancelled'))
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      return serialize(async () => {
        if (finished || downstreamCancelled) return
        try {
          await processRead(
            await readNext(BODY_IDLE_TIMEOUT_MS, input.startedAt + TOTAL_STREAM_TIMEOUT_MS),
            controller,
          )
        } catch (error) {
          finished = true
          void bestEffort(() => reader.cancel(error))
          if (!downstreamCancelled && emitted) {
            controller.enqueue(tracker.errorFrame('Upstream stream terminated unexpectedly'))
          }
          if (!downstreamCancelled) {
            await bestEffort(() => recordPoolFailure(
              input.pool,
              input.accountId,
              `${input.requestId}:stream-failure`,
              FAILURE_COOLDOWN_MS,
            ))
          }
          await bestEffort(() => finalize(downstreamCancelled ? 'cancelled' : 'failed'))
          if (!downstreamCancelled) {
            if (emitted) controller.close()
            else controller.error(error)
          }
        }
      })
    },
    cancel() {
      if (!downstreamCancelled) {
        downstreamCancelled = true
        disconnectStartedAt = Date.now()
        lastChunkAt = disconnectStartedAt
        disconnectSignal.abort()
      }
      const task = serialize(drainAfterCancellation)
      if (input.waitUntil !== undefined) {
        try {
          input.waitUntil(task)
          return
        } catch {
          // Fall back to making stream cancellation await the bounded drain.
        }
      }
      return task
    },
  })

  return new Response(body, {
    status: input.response.status,
    headers: responseHeaders(input.response.headers, true),
  })
}

async function settleAndProject(
  input: FinalizeInput,
  usage: TokenUsage,
  outcome: UsageSettledPayload['outcome'],
): Promise<void> {
  const cost = calculateCost(input.model, usage)
  const payload: UsageSettledPayload = {
    request_id: input.requestId,
    user_id: input.principal.user_id,
    api_key_id: input.principal.api_key_id,
    group_id: input.principal.group_id,
    billing_type: input.principal.billing.type,
    subscription_id: input.principal.billing.type === 'subscription'
      ? input.principal.billing.subscription_id
      : null,
    account_id: input.accountId,
    price_id: input.model.price_id,
    requested_model: input.requestedModel,
    upstream_model: input.model.upstream_name,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    ...cost,
    outcome,
    stream: input.stream,
    duration_ms: Math.max(0, Date.now() - input.startedAt),
    estimated: usage.estimated,
  }
  const event = createUsageEvent(payload, Date.now())
  try {
    await persistSettlementRecovery(
      input.env,
      input.principal,
      input.requestId,
      cost.amount_micros,
      event,
    )
  } catch (error) {
    console.error('failed to persist settlement recovery', {
      request_id: input.requestId,
      name: error instanceof Error ? error.name : 'unknown',
    })
    // No durable command exists, so do not leave either hold consuming quota
    // until TTL. Cancellation is idempotent and must happen before surfacing
    // the durability failure to synchronous callers.
    await bestEffort(() => cancelGatewayReservations(input.env, input.principal, input.requestId))
    throw new GatewayError(
      503,
      'settlement_recovery_unavailable',
      'Usage settlement could not be durably recorded',
      'server_error',
    )
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (await settleRecoveryRequest(input.env, input.requestId, true)) return
      lastError = new Error('Settlement recovery did not complete every stage')
    } catch (error) {
      lastError = error
    }
    if (attempt < 2) await delay(50 * 2 ** attempt)
  }
  await bestEffort(() => signalSettlementRecovery(input.env, input.requestId))
  console.error('settlement deferred to recovery', {
    request_id: input.requestId,
    name: lastError instanceof Error ? lastError.name : 'unknown',
  })
}

async function cancelGatewayReservations(
  env: Env,
  principal: Awaited<ReturnType<typeof authenticateGatewayRequest>>,
  requestId: string,
): Promise<void> {
  const results = await Promise.allSettled([
    cancelBillingReservation(env, principal, requestId),
    cancelApiKeyMonetaryReservation(env, principal, requestId),
  ])
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed !== undefined) throw failed.reason
}

async function prepareGatewayReservations(
  env: Env,
  principal: Awaited<ReturnType<typeof authenticateGatewayRequest>>,
  requestId: string,
  amountMicros: number,
): Promise<void> {
  try {
    await prepareBillingReservation(env, principal, requestId, amountMicros)
    await prepareApiKeyMonetaryReservation(env, principal, requestId, amountMicros)
  } catch (error) {
    await bestEffort(() => cancelGatewayReservations(env, principal, requestId))
    throw error
  }
}

function validateClientControls(body: Record<string, unknown>): void {
  const forbidden = new Set([
    'proxy',
    'proxy_url',
    'socks5',
    'utls',
    'ja3',
    'base_url',
    'upstream_url',
    'transport',
  ])
  const rejected = Object.keys(body).find((key) => forbidden.has(key.toLowerCase()))
  if (rejected) {
    throw new GatewayError(400, 'unsupported_transport_control', `Client field '${rejected}' is not supported`)
  }
}

function requiredModel(body: Record<string, unknown>): string {
  if (typeof body.model !== 'string' || body.model.trim() === '' || body.model.length > 256) {
    throw new GatewayError(400, 'invalid_model', 'model must be a non-empty string')
  }
  return body.model
}

function validateEmbeddingInput(value: unknown): void {
  const validTokenArray = (candidate: unknown): candidate is number[] =>
    Array.isArray(candidate) && candidate.length > 0 && candidate.every((token) =>
      Number.isSafeInteger(token) && (token as number) >= 0,
    )
  const valid = (typeof value === 'string' && value.length > 0) ||
    (Array.isArray(value) && value.length > 0 && (
      value.every((item) => typeof item === 'string') ||
      validTokenArray(value) ||
      value.every(validTokenArray)
    ))
  if (!valid) {
    throw new GatewayError(400, 'invalid_input', 'input must contain text or token arrays')
  }
}

function prepareGeminiEmbeddingRequest(
  value: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const allowed = new Set(['content', 'taskType', 'title', 'outputDimensionality'])
  const rejected = Object.keys(value).find((key) => !allowed.has(key))
  if (rejected !== undefined) {
    throw new GeminiCodecError(`Gemini embedding request contains unsupported field: ${rejected}`)
  }
  if (value.content === null || typeof value.content !== 'object' || Array.isArray(value.content)) {
    throw new GeminiCodecError('content must be an object')
  }
  const content = value.content as Record<string, unknown>
  const rejectedContent = Object.keys(content).find((key) => key !== 'role' && key !== 'parts')
  if (rejectedContent !== undefined) {
    throw new GeminiCodecError(`content contains unsupported field: ${rejectedContent}`)
  }
  if (content.role !== undefined && content.role !== 'user') {
    throw new GeminiCodecError('content.role must be user')
  }
  if (!Array.isArray(content.parts) || content.parts.length === 0) {
    throw new GeminiCodecError('content.parts must be a non-empty array')
  }
  const text = content.parts.map((rawPart, index) => {
    if (rawPart === null || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      throw new GeminiCodecError(`content.parts[${index}] must be an object`)
    }
    const part = rawPart as Record<string, unknown>
    if (Object.keys(part).some((key) => key !== 'text') || typeof part.text !== 'string' || part.text === '') {
      throw new GeminiCodecError(`content.parts[${index}] must contain only non-empty text`)
    }
    return part.text
  }).join('\n')
  const body: Record<string, unknown> = { model, input: text, encoding_format: 'float' }
  if (value.outputDimensionality !== undefined) {
    if (
      !Number.isSafeInteger(value.outputDimensionality) ||
      (value.outputDimensionality as number) <= 0 ||
      (value.outputDimensionality as number) > 65_536
    ) {
      throw new GeminiCodecError('outputDimensionality must be a positive integer')
    }
    body.dimensions = value.outputDimensionality
  }
  if (value.taskType !== undefined && typeof value.taskType !== 'string') {
    throw new GeminiCodecError('taskType must be a string')
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new GeminiCodecError('title must be a string')
  }
  return body
}

function geminiEmbeddingResponse(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GeminiCodecError('Embedding upstream response must be an object')
  }
  const data = (value as Record<string, unknown>).data
  if (!Array.isArray(data) || data.length !== 1) {
    throw new GeminiCodecError('Embedding upstream response must contain one vector')
  }
  const first = data[0]
  if (first === null || typeof first !== 'object' || Array.isArray(first)) {
    throw new GeminiCodecError('Embedding vector is invalid')
  }
  const embedding = (first as Record<string, unknown>).embedding
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((item) =>
    typeof item === 'number' && Number.isFinite(item),
  )) {
    throw new GeminiCodecError('Embedding vector is invalid')
  }
  return { embedding: { values: embedding } }
}

function decodeGeminiPathModel(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new GatewayError(400, 'invalid_model', 'Gemini model path is invalid')
  }
  if (decoded.trim() === '' || decoded.length > 256 || decoded.includes('/') || decoded.includes(':')) {
    throw new GatewayError(400, 'invalid_model', 'Gemini model path is invalid')
  }
  return decoded
}

function geminiModelProjection(model: ModelRoute): Record<string, unknown> {
  const methods: string[] = []
  if (model.endpoint === 'responses' || model.endpoint === 'both') {
    methods.push('generateContent', 'streamGenerateContent', 'countTokens')
  }
  if (model.embeddings === 1) methods.push('embedContent', 'batchEmbedContents')
  return {
    name: `models/${model.public_name}`,
    version: '001',
    displayName: model.public_name,
    description: 'Model routed by Sub2API Cloudflare gateway',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: model.max_output_tokens,
    supportedGenerationMethods: methods,
  }
}

function parseStream(body: Record<string, unknown>): boolean {
  if (body.stream === undefined) return false
  if (typeof body.stream !== 'boolean') {
    throw new GatewayError(400, 'invalid_stream', 'stream must be a boolean')
  }
  return body.stream
}

async function fetchWithHeaderTimeout(
  url: URL,
  init: RequestInit,
  clientSignal: AbortSignal,
  timeoutMs = HEADER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const onClientAbort = () => controller.abort()
  if (clientSignal.aborted) controller.abort()
  else clientSignal.addEventListener('abort', onClientAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      if (clientSignal.aborted) {
        throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request', 'invalid_request_error')
      }
      throw new GatewayError(504, 'upstream_timeout', 'Upstream did not respond in time', 'server_error')
    }
    throw new GatewayError(502, 'upstream_connection_error', 'Unable to connect to upstream', 'server_error')
  } finally {
    clearTimeout(timer)
    clientSignal.removeEventListener('abort', onClientAbort)
  }
}

function mapUpstreamStatus(response: Response): GatewayError {
  const retryAfter = safeRetryAfter(response.headers.get('retry-after'))
  if (response.status === 401 || response.status === 403) {
    return new GatewayError(502, 'upstream_auth_error', 'Upstream authentication failed', 'server_error')
  }
  if (response.status === 429) {
    return new GatewayError(429, 'rate_limit_exceeded', 'Upstream rate limit exceeded', 'rate_limit_error', retryAfter)
  }
  if (response.status === 529) {
    return new GatewayError(503, 'upstream_overloaded', 'Upstream is overloaded', 'server_error', retryAfter)
  }
  if (response.status >= 500) {
    return new GatewayError(502, 'upstream_error', 'Upstream service failed', 'server_error', retryAfter)
  }
  return new GatewayError(response.status, 'upstream_request_error', 'Upstream rejected the request')
}

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

const EMBEDDINGS_ERROR_CLASSIFICATION_BYTES = 64 * 1024
const EMBEDDINGS_ERROR_CLASSIFICATION_TIMEOUT_MS = 250
const SESSION_AFFINITY_HEADERS = [
  'session-id',
  'session_id',
  'conversation_id',
  'x-session-affinity',
  'x-session-id',
  'x-opencode-session',
  'x-conversation-id',
  'x-claude-code-session-id',
] as const

async function isRetryableEmbeddingsResponse(response: Response): Promise<boolean> {
  const descriptor = await embeddingsErrorDescriptor(response)
  if (isEmbeddingsAccessStateCode(descriptor.code)) return true
  if (isEmbeddingsCapacityCode(descriptor.code) || isEmbeddingsCapacityMessage(descriptor.message)) {
    return true
  }
  // These statuses describe the selected credential/account rather than the
  // embedding document. Another configured account may still serve it.
  if (response.status === 401 || response.status === 402) return true
  if (isDeterministicEmbeddingsFailure(descriptor)) return false
  return response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status === 529 ||
    response.status >= 500
}

function isRetryableAttemptError(error: GatewayError, endpoint: GatewayEndpoint): boolean {
  if (error.code === 'no_capacity') return true
  if (endpoint !== 'embeddings') return true
  return error.code === 'credential_unavailable' ||
    error.code === 'upstream_connection_error' ||
    error.code === 'upstream_timeout' ||
    error.code === 'upstream_redirect_rejected'
}

async function embeddingsErrorDescriptor(
  response: Response,
): Promise<{ code: string; type: string; message: string }> {
  let text = ''
  try {
    const body = response.clone().body
    if (body !== null) {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let bytesRead = 0
      let finished = false
      try {
        while (bytesRead < EMBEDDINGS_ERROR_CLASSIFICATION_BYTES) {
          const result = await readEmbeddingsErrorChunk(reader)
          if (result === null) break
          const { done, value } = result
          if (done) {
            finished = true
            text += decoder.decode()
            break
          }
          const remaining = EMBEDDINGS_ERROR_CLASSIFICATION_BYTES - bytesRead
          const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining)
          bytesRead += chunk.byteLength
          text += decoder.decode(chunk, { stream: bytesRead < EMBEDDINGS_ERROR_CLASSIFICATION_BYTES })
          if (chunk.byteLength !== value.byteLength) break
        }
      } finally {
        // Cancelling one branch of a cloned/tee'd body can wait for the other
        // branch. Do not let an oversized diagnostic block the actual response.
        if (!finished) void reader.cancel().catch(() => undefined)
      }
    }
  } catch {
    // Status-only classification remains safe if a provider error body cannot be read.
  }
  try {
    const parsed = JSON.parse(text) as unknown
    const root = objectValue(parsed)
    const error = objectValue(root?.error)
    const responseError = objectValue(objectValue(root?.response)?.error)
    const detail = objectValue(root?.detail)
    return {
      code: firstNormalizedString(error?.code, responseError?.code, detail?.code, root?.code),
      type: firstNormalizedString(error?.type, responseError?.type, detail?.type, root?.type),
      message: firstNormalizedString(error?.message, responseError?.message, detail?.message, root?.message),
    }
  } catch {
    return { code: '', type: '', message: text.trim().toLowerCase() }
  }
}

async function readEmbeddingsErrorChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(resolve, EMBEDDINGS_ERROR_CLASSIFICATION_TIMEOUT_MS, null)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function firstNormalizedString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().toLowerCase()
  }
  return ''
}

function isEmbeddingsAccessStateCode(code: string): boolean {
  if (code === 'deactivated_workspace') return true
  return /^(workspace|account|organization|org)_(deactivated|disabled|suspended)$/.test(code) ||
    /^(deactivated|disabled|suspended)_(workspace|account|organization|org)$/.test(code)
}

function isEmbeddingsCapacityCode(code: string): boolean {
  return code === 'server_is_overloaded' ||
    code === 'slow_down' ||
    code === 'rate_limit_exceeded' ||
    code === 'insufficient_quota' ||
    code === 'billing_hard_limit_reached'
}

function isEmbeddingsCapacityMessage(message: string): boolean {
  return message.includes('server is overloaded') ||
    message.includes('servers are overloaded') ||
    message.includes('servers are currently overloaded') ||
    message.includes('selected model is at capacity') ||
    message.includes('an error occurred while processing your request')
}

function isDeterministicEmbeddingsFailure(
  descriptor: { code: string; type: string; message: string },
): boolean {
  if (
    descriptor.type === 'invalid_request_error' ||
    descriptor.type === 'permission_error' ||
    descriptor.type === 'content_policy_error'
  ) return true
  return descriptor.code === 'cyber_policy' ||
    descriptor.code === 'content_policy_violation' ||
    descriptor.code === 'context_length_exceeded' ||
    descriptor.code === 'context_too_large' ||
    descriptor.code === 'model_not_found' ||
    descriptor.code === 'permission_denied' ||
    descriptor.code === 'insufficient_permissions' ||
    descriptor.code.startsWith('invalid_') ||
    descriptor.code.startsWith('unsupported_')
}

async function gatewaySessionAffinityKey(
  headers: Headers,
  body: Record<string, unknown>,
  env: Env,
  principal: Awaited<ReturnType<typeof authenticateGatewayRequest>>,
  modelId: string,
  endpoint: GatewayEndpoint,
): Promise<string | undefined> {
  const signal = sessionAffinitySignal(headers, body)
  if (signal === undefined || !env.API_KEY_PEPPER) return undefined
  return apiKeyDigest(
    [
      'gateway-session-affinity:v1',
      principal.user_id,
      principal.api_key_id,
      principal.group_id,
      modelId,
      endpoint,
      signal,
    ].join('\0'),
    env.API_KEY_PEPPER,
  )
}

function sessionAffinitySignal(
  headers: Headers,
  body: Record<string, unknown>,
): string | undefined {
  for (const header of SESSION_AFFINITY_HEADERS) {
    const value = safeSessionAffinitySignal(headers.get(header))
    if (value !== undefined) return value
  }
  return safeSessionAffinitySignal(
    typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : null,
  )
}

function safeSessionAffinitySignal(value: string | null): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (
    trimmed === '' ||
    [...trimmed].length > 255 ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) return undefined
  return trimmed
}

function safeRetryAfter(value: string | null): string | undefined {
  if (value === null || !/^\d{1,5}$/.test(value)) return undefined
  return String(Math.min(Number(value), 86_400))
}

function responseHeaders(upstream: Headers, streaming: boolean): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const contentType = upstream.get('content-type')
  headers.set('content-type', contentType ?? (streaming ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'))
  const upstreamRequestId = upstream.get('x-request-id')
  if (upstreamRequestId !== null && upstreamRequestId.length <= 256) {
    headers.set('x-upstream-request-id', upstreamRequestId)
  }
  return headers
}

async function readResponseLimited(
  response: Response,
  maximum: number,
  clientSignal: AbortSignal,
  lease: {
    pool: DurableObjectStub
    leaseId: string
    admission: ApiKeyAdmissionLease | null
    startedAt: number
  },
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let renewalSequence = 0
  let lastRenewedAt = lease.startedAt
  let lastChunkAt = Date.now()
  const deadlineAt = lease.startedAt + TOTAL_SYNC_TIMEOUT_MS
    if (clientSignal.aborted) {
      await bestEffort(() => reader.cancel('client cancelled'))
      throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request', 'invalid_request_error')
    }
    while (true) {
      const pending = reader.read().then((result) => ({ kind: 'read' as const, result }))
      let result: ReadableStreamReadResult<Uint8Array>
      while (true) {
        const now = Date.now()
        if (now >= deadlineAt) {
          await bestEffort(() => reader.cancel('upstream response total timeout'))
          throw new GatewayError(504, 'upstream_timeout', 'Upstream response exceeded the maximum duration', 'server_error')
        }
        if (now - lastRenewedAt >= RENEW_AFTER_MS) {
          renewalSequence += 1
          try {
            await renewApiKeyAdmission(lease.admission, renewalSequence)
            await renewPoolLease(lease.pool, lease.leaseId, renewalSequence)
          } catch (error) {
            await bestEffort(() => reader.cancel('lease renewal failed'))
            throw error
          }
          lastRenewedAt = Date.now()
        }
        const raced = await readOrTickOrAbort(
          pending,
          Math.max(1, Math.min(
            RENEW_AFTER_MS,
            BODY_IDLE_TIMEOUT_MS - (now - lastChunkAt),
            deadlineAt - now,
          )),
          clientSignal,
        )
        if (raced.kind === 'abort') {
          await bestEffort(() => reader.cancel('client cancelled'))
          throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request', 'invalid_request_error')
        }
        if (raced.kind === 'read') {
          result = raced.result
          break
        }
        if (Date.now() - lastChunkAt >= BODY_IDLE_TIMEOUT_MS) {
          await bestEffort(() => reader.cancel('upstream response idle timeout'))
          throw new GatewayError(504, 'upstream_idle_timeout', 'Upstream response timed out', 'server_error')
        }
      }
      if (result.done) break
      lastChunkAt = Date.now()
      total += result.value.byteLength
      if (total > maximum) {
        await bestEffort(() => reader.cancel('response too large'))
        throw new GatewayError(502, 'upstream_response_too_large', 'Upstream response exceeded the size limit', 'server_error')
      }
      chunks.push(result.value)
    }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function readOrTickOrAbort<T>(
  read: Promise<{ kind: 'read'; result: ReadableStreamReadResult<T> }>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<
  | { kind: 'read'; result: ReadableStreamReadResult<T> }
  | { kind: 'tick' }
  | { kind: 'abort' }
> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (
      result:
        | { kind: 'read'; result: ReadableStreamReadResult<T> }
        | { kind: 'tick' }
        | { kind: 'abort' },
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = () => finish({ kind: 'abort' })
    const timer = setTimeout(() => finish({ kind: 'tick' }), milliseconds)
    if (signal?.aborted) {
      finish({ kind: 'abort' })
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    read.then(finish, fail)
  })
}

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    console.error('gateway cleanup failed', { name: error instanceof Error ? error.name : 'unknown' })
  }
}
