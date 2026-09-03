import type { Context } from 'hono'
import type { Env, UsageSettledPayload } from '../env'
import { bootstrapGateway } from './bootstrap'
import { decryptCredential } from './crypto'
import { asGatewayError, GatewayError, gatewayErrorResponse } from './errors'
import { createUsageEvent } from './queue'
import {
  persistSettlementRecovery,
  signalSettlementRecovery,
} from './recovery'
import {
  authenticateGatewayRequest,
  credentialAad,
  findModel,
  getAccountCredential,
  listAccountCandidates,
  listModels,
  validateBaseUrl,
} from './repository'
import {
  cancelUserReservation,
  disablePoolAccount,
  prepareUserReservation,
  recordPoolFailure,
  releasePoolLease,
  RENEW_AFTER_MS,
  renewPoolLease,
  renewUserReservation,
  reservePoolAccount,
  settleUserReservation,
  syncPoolAccounts,
} from './state-client'
import type { GatewayEndpoint, ModelRoute, TokenUsage } from './types'
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

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
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
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  try {
    const principal = await authenticateGatewayRequest(context.req.raw, context.env)
    const parsed = await readGatewayBody(context.req.raw)
    validateClientControls(parsed.body)
    const requestedModel = requiredModel(parsed.body)
    const stream = parseStream(parsed.body)
    const model = await findModel(context.env, principal.group_id, requestedModel, endpoint)
    const reservationMicros = reservationForRequest(model, parsed.body, parsed.bytes.byteLength)
    const candidates = await listAccountCandidates(
      context.env,
      principal.group_id,
      model.model_id,
      endpoint,
    )

    await prepareUserReservation(context.env, principal, requestId, reservationMicros)
    let pool: DurableObjectStub
    try {
      pool = await syncPoolAccounts(
        context.env,
        principal.group_id,
        model.model_id,
        endpoint,
        candidates,
      )
    } catch (error) {
      await bestEffort(() => cancelUserReservation(context.env, principal.user_id, requestId))
      throw error
    }

    const upstreamBody: Record<string, unknown> = { ...parsed.body, model: model.upstream_name }
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
    const serialized = JSON.stringify(upstreamBody)
    const acquired = await acquireUpstream(
      context.env,
      pool,
      principal.group_id,
      model.model_id,
      requestId,
      endpoint,
      serialized,
      stream,
      candidates.length,
      context.req.raw.headers,
      context.req.raw.signal,
    ).catch(async (error) => {
      await bestEffort(() => cancelUserReservation(context.env, principal.user_id, requestId))
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
      await bestEffort(() => cancelUserReservation(context.env, principal.user_id, requestId))
      throw mapUpstreamStatus(acquired.response)
    }

    const contentType = acquired.response.headers.get('content-type') ?? ''
    if (stream && contentType.toLowerCase().includes('text/event-stream')) {
      if (acquired.response.body === null) {
        await bestEffort(() => releasePoolLease(pool, acquired.leaseId))
        await bestEffort(() => cancelUserReservation(context.env, principal.user_id, requestId))
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
    })
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error), requestId)
  }
}

interface AcquiredUpstream {
  response: Response
  accountId: string
  leaseId: string
}

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
      const url = upstreamUrl(account.base_url, endpoint)
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
  input: FinalizeInput & { response: Response; clientSignal: AbortSignal },
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
    await settleAndProject(input, usage, 'completed')
    const output = parsed === null
      ? bytes
      : encoder.encode(JSON.stringify(rewriteModelNames(parsed, input.model.upstream_name, input.requestedModel)))
    const headers = responseHeaders(input.response.headers, false)
    headers.set('content-length', String(output.byteLength))
    return new Response(output.buffer as ArrayBuffer, { status: input.response.status, headers })
  } finally {
    await bestEffort(() => releasePoolLease(input.pool, input.leaseId))
  }
}

function createStreamingResponse(input: FinalizeInput & { response: Response; endpoint: GatewayEndpoint }): Response {
  const reader = input.response.body!.getReader()
  const tracker = new SseEventTransformer(input.model.upstream_name, input.requestedModel)
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
          await cancelUserReservation(input.env, input.principal.user_id, input.requestId)
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
              renewUserReservation(input.env, input.principal.user_id, input.requestId, userRenewal),
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
              renewUserReservation(input.env, input.principal.user_id, input.requestId, userRenewal),
              renewPoolLease(input.pool, input.leaseId, poolRenewal),
            ])
            lastRenewedAt = Date.now()
          }
          if (raced.result.done) {
            for (const chunk of tracker.finish()) {
              emitted ||= chunk.byteLength > 0
              controller.enqueue(chunk)
            }
            const terminal = tracker.terminal(input.endpoint)
            if (terminal === 'missing') {
              controller.enqueue(streamErrorFrame(input.endpoint, 'Upstream stream ended before a terminal event', input.requestedModel))
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
        if (emitted) controller.enqueue(streamErrorFrame(input.endpoint, 'Upstream stream terminated unexpectedly', input.requestedModel))
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
      input.principal.user_id,
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
      await settleUserReservation(
        input.env,
        input.principal.user_id,
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

async function readGatewayBody(request: Request): Promise<{ body: Record<string, unknown>; bytes: Uint8Array }> {
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new GatewayError(413, 'request_too_large', 'Request body exceeds the 2 MiB limit')
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0) throw new GatewayError(400, 'empty_body', 'Request body is required')
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new GatewayError(413, 'request_too_large', 'Request body exceeds the 2 MiB limit')
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
  return { body: value as Record<string, unknown>, bytes }
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

function parseStream(body: Record<string, unknown>): boolean {
  if (body.stream === undefined) return false
  if (typeof body.stream !== 'boolean') {
    throw new GatewayError(400, 'invalid_stream', 'stream must be a boolean')
  }
  return body.stream
}

function upstreamUrl(baseUrl: string, endpoint: GatewayEndpoint): URL {
  const url = validateBaseUrl(baseUrl)
  url.pathname = `${url.pathname}/${endpoint === 'chat_completions' ? 'chat/completions' : 'responses'}`.replace(/\/+/g, '/')
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
