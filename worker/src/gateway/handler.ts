import type { Context } from 'hono'
import type { Env, UsageSettledPayload } from '../env'
import { bootstrapGateway } from './bootstrap'
import { codexModelsResponse } from './codex-models'
import { decryptCredential } from './crypto'
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
  signalSettlementRecovery,
} from './recovery'
import {
  authenticateGatewayRequest,
  credentialAad,
  getAccountCredential,
  listModels,
  resolveGatewayRoute,
  validateBaseUrl,
} from './repository'
import { readGatewayJsonBody } from './request-body'
import {
  cancelBillingReservation,
  disablePoolAccount,
  prepareBillingReservation,
  recordPoolFailure,
  releasePoolLease,
  RENEW_AFTER_MS,
  renewPoolLease,
  renewBillingReservation,
  reservePoolAccount,
  settleBillingReservation,
  syncPoolAccounts,
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
const TOTAL_STREAM_TIMEOUT_MS = 15 * 60_000
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
        upstreamBody: (model: ModelRoute) => ({ ...body, model: model.upstream_name }),
        responseProtocol: 'openai' as const,
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
          upstreamBody: (model: ModelRoute) =>
            prepareGeminiEmbeddingRequest(body, model.upstream_name),
          transformResponse: geminiEmbeddingResponse,
          responseProtocol: 'gemini' as const,
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
        upstreamBody: (model: ModelRoute) =>
          convertGeminiGenerateContentToResponsesRequest(body, {
            publicModel,
            mappedModel: model.upstream_name,
            stream,
          }).body,
        transformResponse: (value: unknown) =>
          convertOpenAIResponsesResponseToGemini(value, { publicModel }),
        responseProtocol: 'gemini' as const,
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
  let acquired: AcquiredUpstream | null = null
  let pool: DurableObjectStub | null = null
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
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
    const converted = convertGeminiGenerateContentToResponsesRequest(parsed.body, {
      publicModel,
      mappedModel: route.model.upstream_name,
      stream: false,
    }).body
    const upstreamBody: Record<string, unknown> = {
      model: converted.model,
      input: converted.input,
    }
    for (const key of ['instructions', 'tools', 'tool_choice']) {
      if (converted[key] !== undefined) upstreamBody[key] = converted[key]
    }
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
      JSON.stringify(upstreamBody),
      false,
      route.candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      'responses_input_tokens',
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
    )
    return geminiTokenCountResponse(readInputTokenCount(bytes), requestId)
  } catch (error) {
    const normalized = error instanceof GeminiCodecError
      ? new GatewayError(400, 'invalid_argument', error.message)
      : asGatewayError(error)
    return geminiErrorResponse(normalized, requestId)
  } finally {
    if (pool !== null && acquired !== null) {
      await bestEffort(() => releasePoolLease(pool!, acquired!.leaseId))
    }
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
        upstreamBody: (model: ModelRoute) => ({
          ...toOpenAIResponsesRequest(request, model.upstream_name),
        }),
        transformResponse: (value: unknown) =>
          responsesToAnthropicMessage(value, request.model),
        responseProtocol: 'anthropic' as const,
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
    (body) => ({
      ...prepareOpenAiRequest(body, 'responses', false),
      upstreamOperation: 'responses_compact' as const,
    }),
    gatewayErrorResponse,
  )
}

export async function handleAnthropicCountTokens(
  context: Context<GatewayBindings>,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  let acquired: AcquiredUpstream | null = null
  let pool: DurableObjectStub | null = null
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
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
    const upstreamBody = toOpenAIResponsesInputTokensRequest(
      request,
      route.model.upstream_name,
    )
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
      JSON.stringify(upstreamBody),
      false,
      route.candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      'responses_input_tokens',
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
  }
}

export async function handleResponsesInputTokens(
  context: Context<GatewayBindings>,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  let acquired: AcquiredUpstream | null = null
  let pool: DurableObjectStub | null = null
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
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
    const upstreamBody: Record<string, unknown> = {
      ...parsed.body,
      model: route.model.upstream_name,
    }
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
      JSON.stringify(upstreamBody),
      false,
      route.candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      'responses_input_tokens',
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

function readInputTokenCount(bytes: Uint8Array): number {
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

interface PreparedGatewayRequest {
  requestedModel: string
  stream: boolean
  upstreamBody: (model: ModelRoute, upstreamEndpoint: GatewayEndpoint) => Record<string, unknown>
  transformResponse?: (value: unknown) => unknown
  responseProtocol: 'openai' | 'anthropic' | 'gemini'
  upstreamOperation?: UpstreamOperation
  protocolFallback?: 'responses_to_chat'
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
    upstreamBody: (model, upstreamEndpoint) => {
      if (
        endpoint === 'responses' &&
        allowProtocolFallback &&
        upstreamEndpoint === 'chat_completions'
      ) {
        const fallbackBody = body.max_output_tokens === undefined
          ? { ...body, max_output_tokens: model.default_max_output_tokens }
          : body
        return responsesToChatCompletionsRequest(
          parseResponsesRequest(fallbackBody),
          model.upstream_name,
        ) as unknown as Record<string, unknown>
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
      return upstreamBody
    },
    responseProtocol: 'openai',
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
    const usesResponsesBridge = prepared.protocolFallback === 'responses_to_chat' &&
      endpoint === 'responses' && upstreamEndpoint === 'chat_completions'
    const upstreamBody = prepared.upstreamBody(model, upstreamEndpoint)
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

    await prepareBillingReservation(context.env, principal, requestId, reservationMicros)
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
      await bestEffort(() => cancelBillingReservation(context.env, principal, requestId))
      throw error
    }

    const serialized = JSON.stringify(upstreamBody)
    const acquired = await acquireUpstream(
      context.env,
      pool,
      principal.group_id,
      model.model_id,
      requestId,
      upstreamEndpoint,
      serialized,
      stream,
      candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
      prepared.upstreamOperation ?? upstreamEndpoint,
    ).catch(async (error) => {
      await bestEffort(() => cancelBillingReservation(context.env, principal, requestId))
      throw error
    })

    if (!acquired.response.ok) {
      if (isRetryableStatus(acquired.response.status)) {
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
      await bestEffort(() => cancelBillingReservation(context.env, principal, requestId))
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
        await bestEffort(() => cancelBillingReservation(context.env, principal, requestId))
        throw new GatewayError(502, 'empty_upstream_stream', 'Upstream returned an empty stream', 'server_error')
      }
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
        responseProtocol: usesResponsesBridge
          ? 'responses_from_chat'
          : prepared.responseProtocol,
      })
    }

    return await createSynchronousResponse({
      env: context.env,
      response: acquired.response,
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
      transformResponse: usesResponsesBridge
        ? (value) => chatCompletionsResponseToResponses(value, requestedModel)
        : prepared.transformResponse,
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
  }
}

function anthropicErrorResponse(error: GatewayError, requestId?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  if (requestId) headers.set('request-id', requestId)
  if (error.retryAfter) headers.set('retry-after', error.retryAfter)
  return new Response(JSON.stringify(mapOpenAIErrorToAnthropic(error.status)), {
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
    error: { code: error.status, message: error.message, status },
  }), { status: error.status, headers })
}

interface AcquiredUpstream {
  response: Response
  accountId: string
  leaseId: string
}

type UpstreamOperation = GatewayEndpoint | 'responses_compact' | 'responses_input_tokens'

async function acquireUpstream(
  env: Env,
  pool: DurableObjectStub,
  groupId: string,
  modelId: string,
  requestId: string,
  endpoint: GatewayEndpoint,
  body: string,
  stream: boolean,
  candidateCount: number,
  inboundHeaders: Headers,
  clientSignal: AbortSignal,
  operation: UpstreamOperation = endpoint,
): Promise<AcquiredUpstream> {
  let lastError: GatewayError | null = null
  const attempts = Math.min(4, candidateCount + 1)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const leaseId = `${requestId}:${attempt}`
    let accountId: string | null = null
    try {
      accountId = await reservePoolAccount(pool, leaseId)
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
      const url = upstreamUrl(account.base_url, operation)
      const response = await fetchWithHeaderTimeout(url, {
        method: 'POST',
        headers: upstreamHeaders(credential.api_key, stream, inboundHeaders, env.APP_VERSION),
        body,
        redirect: 'manual',
      }, clientSignal)
      if (response.status >= 300 && response.status < 400) {
        await bestEffort(async () => response.body?.cancel())
        throw new GatewayError(502, 'upstream_redirect_rejected', 'Upstream redirect was rejected', 'server_error')
      }
      if (!response.ok && isRetryableStatus(response.status) && attempt + 1 < attempts) {
        lastError = mapUpstreamStatus(response)
        await bestEffort(async () => response.body?.cancel())
        await bestEffort(() => recordPoolFailure(pool, accountId!, `${requestId}:failure:${attempt}`, FAILURE_COOLDOWN_MS))
        await bestEffort(() => releasePoolLease(pool, leaseId))
        continue
      }
      return { response, accountId, leaseId }
    } catch (error) {
      const currentError = asGatewayError(error)
      if (currentError.code === 'no_capacity' && lastError !== null) break
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
    const usage = extractUsage(parsed) ?? estimatedUsage(input.inputBytes, bytes.byteLength)
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
    await bestEffort(() => releasePoolLease(input.pool, input.leaseId))
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
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
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
    return this.codec.push(parsed).map((event) => {
      const encoded = encoder.encode(formatAnthropicSseEvent(event))
      this.emittedBytes += encoded.byteLength
      return encoded
    })
  }
}

function createStreamingResponse(input: FinalizeInput & {
  response: Response
  endpoint: GenerativeGatewayEndpoint
  responseProtocol: 'openai' | 'anthropic' | 'gemini' | 'responses_from_chat'
}): Response {
  const reader = input.response.body!.getReader()
  const tracker: GatewayStreamTransformer = input.responseProtocol === 'anthropic'
    ? new AnthropicResponsesStreamTransformer(input.model.upstream_name, input.requestedModel)
    : input.responseProtocol === 'gemini'
      ? new GeminiResponsesStreamTransformer(input.model.upstream_name, input.requestedModel)
      : input.responseProtocol === 'responses_from_chat'
        ? new ChatResponsesStreamTransformer(input.model.upstream_name, input.requestedModel)
      : new OpenAiStreamTransformer(input.model.upstream_name, input.requestedModel, input.endpoint)
  let finalized: Promise<void> | null = null
  let userRenewal = 0
  let poolRenewal = 0
  let lastRenewedAt = Date.now()
  let lastChunkAt = Date.now()
  let emitted = false

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
          await cancelBillingReservation(input.env, input.principal, input.requestId)
        }
      } finally {
        await bestEffort(() => releasePoolLease(input.pool, input.leaseId))
      }
    })()
    return finalized
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const now = Date.now()
          if (now - input.startedAt >= TOTAL_STREAM_TIMEOUT_MS) {
            throw new GatewayError(504, 'upstream_timeout', 'Upstream stream exceeded the maximum duration', 'server_error')
          }
          if (now - lastRenewedAt >= RENEW_AFTER_MS) {
            userRenewal += 1
            poolRenewal += 1
            await Promise.all([
              renewBillingReservation(input.env, input.principal, input.requestId, userRenewal),
              renewPoolLease(input.pool, input.leaseId, poolRenewal),
            ])
            lastRenewedAt = Date.now()
          }

          const pendingRead = reader.read().then((result) => ({ kind: 'read' as const, result }))
          let raced: { kind: 'read'; result: ReadableStreamReadResult<Uint8Array> } | { kind: 'tick' }
          while (true) {
            raced = await readOrTick(
              pendingRead,
              Math.min(RENEW_AFTER_MS, BODY_IDLE_TIMEOUT_MS),
            )
            if (raced.kind === 'read') break
            if (Date.now() - lastChunkAt >= BODY_IDLE_TIMEOUT_MS) {
              throw new GatewayError(504, 'upstream_idle_timeout', 'Upstream stream timed out', 'server_error')
            }
            userRenewal += 1
            poolRenewal += 1
            await Promise.all([
              renewBillingReservation(input.env, input.principal, input.requestId, userRenewal),
              renewPoolLease(input.pool, input.leaseId, poolRenewal),
            ])
            lastRenewedAt = Date.now()
          }
          if (raced.result.done) {
            for (const chunk of tracker.finish()) {
              emitted ||= chunk.byteLength > 0
              controller.enqueue(chunk)
            }
            const terminal = tracker.terminal()
            if (terminal === 'missing') {
              controller.enqueue(tracker.errorFrame('Upstream stream ended before a terminal event'))
            }
            await bestEffort(() =>
              finalize(terminal === 'completed' ? 'completed' : 'failed'),
            )
            controller.close()
            return
          }
          lastChunkAt = Date.now()
          for (const chunk of tracker.push(raced.result.value)) {
            emitted ||= chunk.byteLength > 0
            controller.enqueue(chunk)
          }
          return
        }
      } catch (error) {
        await bestEffort(() => reader.cancel(error))
        if (emitted) controller.enqueue(tracker.errorFrame('Upstream stream terminated unexpectedly'))
        await bestEffort(() => recordPoolFailure(input.pool, input.accountId, `${input.requestId}:stream-failure`, FAILURE_COOLDOWN_MS))
        await bestEffort(() => finalize('failed'))
        if (emitted) controller.close()
        else controller.error(error)
      }
    },
    async cancel(reason) {
      await bestEffort(() => reader.cancel(reason))
      await bestEffort(() => finalize('cancelled'))
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
  let recoveryPersisted = false
  try {
    await persistSettlementRecovery(
      input.env,
      input.principal,
      input.requestId,
      cost.amount_micros,
      event,
    )
    recoveryPersisted = true
  } catch (error) {
    console.error('failed to persist settlement recovery', {
      request_id: input.requestId,
      name: error instanceof Error ? error.name : 'unknown',
    })
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await settleBillingReservation(
        input.env,
        input.principal,
        input.requestId,
        cost.amount_micros,
        event,
      )
      if (recoveryPersisted) {
        await input.env.DB.prepare('DELETE FROM settlement_recovery WHERE request_id = ?')
          .bind(input.requestId)
          .run()
      }
      return
    } catch (error) {
      lastError = error
      if (attempt < 2) await delay(50 * 2 ** attempt)
    }
  }
  if (recoveryPersisted) {
    await bestEffort(() => signalSettlementRecovery(input.env, input.requestId))
    console.error('settlement deferred to recovery', {
      request_id: input.requestId,
      name: lastError instanceof Error ? lastError.name : 'unknown',
    })
    return
  }
  throw lastError
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

function upstreamUrl(baseUrl: string, operation: UpstreamOperation): URL {
  const url = validateBaseUrl(baseUrl)
  const path = operation === 'chat_completions'
    ? 'chat/completions'
    : operation === 'embeddings'
      ? 'embeddings'
    : operation === 'responses_compact'
      ? 'responses/compact'
    : operation === 'responses_input_tokens'
      ? 'responses/input_tokens'
      : 'responses'
  url.pathname = `${url.pathname}/${path}`.replace(/\/+/g, '/')
  return url
}

function upstreamHeaders(
  apiKey: string,
  stream: boolean,
  inbound: Headers,
  appVersion: string,
): Headers {
  const headers = new Headers({
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': `Sub2API-Cloudflare/${appVersion}`,
  })
  for (const name of ['openai-beta']) {
    const value = inbound.get(name)
    if (value !== null && value.length <= 1_024) headers.set(name, value)
  }
  return headers
}

async function fetchWithHeaderTimeout(
  url: URL,
  init: RequestInit,
  clientSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const onClientAbort = () => controller.abort()
  if (clientSignal.aborted) controller.abort()
  else clientSignal.addEventListener('abort', onClientAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS)
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
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let onClientAbort = () => {}
  const clientAborted = new Promise<{ kind: 'abort' }>((resolve) => {
    onClientAbort = () => resolve({ kind: 'abort' })
    clientSignal.addEventListener('abort', onClientAbort, { once: true })
  })
  try {
    if (clientSignal.aborted) {
      await bestEffort(() => reader.cancel('client cancelled'))
      throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request', 'invalid_request_error')
    }
    while (true) {
      const pending = reader.read().then((result) => ({ kind: 'read' as const, result }))
      const raced = await Promise.race([
        readOrTick(pending, BODY_IDLE_TIMEOUT_MS),
        clientAborted,
      ])
      if (raced.kind === 'abort') {
        await bestEffort(() => reader.cancel('client cancelled'))
        throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request', 'invalid_request_error')
      }
      if (raced.kind === 'tick') {
        await bestEffort(() => reader.cancel('upstream response idle timeout'))
        throw new GatewayError(504, 'upstream_idle_timeout', 'Upstream response timed out', 'server_error')
      }
      const result = raced.result
      if (result.done) break
      total += result.value.byteLength
      if (total > maximum) {
        await bestEffort(() => reader.cancel('response too large'))
        throw new GatewayError(502, 'upstream_response_too_large', 'Upstream response exceeded the size limit', 'server_error')
      }
      chunks.push(result.value)
    }
  } finally {
    clientSignal.removeEventListener('abort', onClientAbort)
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

function readOrTick<T>(
  read: Promise<{ kind: 'read'; result: ReadableStreamReadResult<T> }>,
  milliseconds: number,
): Promise<{ kind: 'read'; result: ReadableStreamReadResult<T> } | { kind: 'tick' }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: 'tick' }), milliseconds)
    read.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    console.error('gateway cleanup failed', { name: error instanceof Error ? error.name : 'unknown' })
  }
}
