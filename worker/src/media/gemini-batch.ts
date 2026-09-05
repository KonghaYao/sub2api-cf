import { GatewayError } from '../gateway/errors'

const SUBMIT_BODY_LIMIT_BYTES = 20 * 1024 * 1024
// JSON parsing temporarily retains encoded and decoded representations, so the
// bridge deliberately stays well below the Worker memory ceiling.
const DEFAULT_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024
const DEFAULT_IMAGE_LIMIT_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_AFTER_MS = 30_000
const MIN_POLL_AFTER_MS = 1_000
const MAX_POLL_AFTER_MS = 15 * 60_000
const ERROR_MESSAGE_LIMIT = 240
const LIST_PAGE_SIZE = 100
const MAX_LIST_PAGES = 10

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface GeminiBatchManifestItem {
  custom_id: string
  prompt: string
  output_count: number
  reference_images: Array<{
    mime_type: ImageMimeType
    data?: string
    file_uri?: string
  }>
}

export interface GeminiBatchSubmitInput {
  baseUrl: string
  apiKey: string
  upstreamModel: string
  displayName: string
  items: readonly GeminiBatchManifestItem[]
  imageSize: '1K' | '2K' | '4K'
  aspectRatio: string | null
  responseMimeType: ImageMimeType
}

export interface GeminiBatchJobInput {
  baseUrl: string
  apiKey: string
  providerJobId: string
  /** Expected output contract stored with the task; never sent to Gemini. */
  responseMimeType?: ImageMimeType
}

export interface GeminiBatchSubmitResult {
  providerJobId: string
  rawState: string
  pollAfterMs: number
}

export interface GeminiBatchOutput {
  mimeType: ImageMimeType
  bytes: ArrayBuffer
}

export interface GeminiBatchItemResult {
  customId: string
  outputs?: GeminiBatchOutput[]
  error?: { code: string; message: string }
}

export type GeminiBatchState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'

export interface GeminiBatchPollResult {
  state: GeminiBatchState
  rawState: string
  done: boolean
  pollAfterMs: number
  items?: GeminiBatchItemResult[]
  error?: { code: string; message: string }
}

export interface GeminiBatchCancelResult {
  requested: true
}

export interface GeminiBatchFindInput {
  baseUrl: string
  apiKey: string
  displayName: string
}

export type GeminiBatchFindResult =
  | { status: 'absent' }
  | { status: 'ambiguous' }
  | ({ status: 'found' } & GeminiBatchSubmitResult)

export interface GeminiBatchClient {
  submit(input: GeminiBatchSubmitInput): Promise<GeminiBatchSubmitResult>
  poll(input: GeminiBatchJobInput): Promise<GeminiBatchPollResult>
  cancel(input: GeminiBatchJobInput): Promise<GeminiBatchCancelResult>
  findByDisplayName(input: GeminiBatchFindInput): Promise<GeminiBatchFindResult>
}

export interface GeminiBatchClientOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  maxImageBytes?: number
}

export function createGeminiBatchClient(
  fetcher: Fetcher = fetch,
  options: GeminiBatchClientOptions = {},
): GeminiBatchClient {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_RESPONSE_LIMIT_BYTES)
  const maxImageBytes = positiveInteger(options.maxImageBytes, DEFAULT_IMAGE_LIMIT_BYTES)

  return {
    async submit(input) {
      const body = JSON.stringify({
        batch: {
          displayName: input.displayName,
          inputConfig: {
            requests: {
              requests: input.items.map((item) => ({
                metadata: { key: item.custom_id },
                request: geminiImageRequest(input, item),
              })),
            },
          },
        },
      })
      if (new TextEncoder().encode(body).byteLength > SUBMIT_BODY_LIMIT_BYTES) {
        throw new GatewayError(
          413,
          'GEMINI_BATCH_SUBMIT_TOO_LARGE',
          'Gemini inline batch request exceeds the 20 MB limit',
        )
      }
      const response = await request(fetcher, {
        url: providerUrl(input.baseUrl, `/v1beta/models/${encodeURIComponent(input.upstreamModel)}:batchGenerateContent`),
        apiKey: input.apiKey,
        method: 'POST',
        body,
        timeoutMs,
      })
      const payload = await responseJson(response, maxResponseBytes, timeoutMs)
      const job = record(payload)
      const providerJobId = safeProviderJobId(job?.name)
      if (providerJobId === null) throw invalidProviderResponse('Gemini batch response is missing a valid job name')
      const rawState = boundedString(job?.state) ?? 'JOB_STATE_PENDING'
      return { providerJobId, rawState, pollAfterMs: pollAfter(response.headers) }
    },
    async poll(input) {
      const providerJobId = requireProviderJobId(input.providerJobId)
      const response = await request(fetcher, {
        url: providerUrl(input.baseUrl, `/v1beta/${providerJobId}`),
        apiKey: input.apiKey,
        method: 'GET',
        timeoutMs,
      })
      const payload = await responseJson(response, maxResponseBytes, timeoutMs)
      const job = record(payload)
      const rawState = boundedString(job?.state)
      if (job === null || rawState === null) {
        throw invalidProviderResponse('Gemini batch response is missing a job state')
      }
      const state = normalizedState(rawState)
      const result: GeminiBatchPollResult = {
        state,
        rawState,
        done: state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired',
        pollAfterMs: pollAfter(response.headers),
      }
      if (state === 'succeeded') {
        result.items = parseInlinedResponses(job, maxImageBytes, input.apiKey, input.responseMimeType)
      } else if (state === 'failed' || state === 'cancelled' || state === 'expired') {
        result.error = jobError(job, state, input.apiKey)
      }
      return result
    },
    async cancel(input) {
      const providerJobId = requireProviderJobId(input.providerJobId)
      const response = await request(fetcher, {
        url: providerUrl(input.baseUrl, `/v1beta/${providerJobId}:cancel`),
        apiKey: input.apiKey,
        method: 'POST',
        body: '{}',
        timeoutMs,
      })
      await discardBounded(response, maxResponseBytes, timeoutMs)
      return { requested: true }
    },
    async findByDisplayName(input) {
      if (input.displayName.trim() === '' || input.displayName.length > 255) {
        throw new GatewayError(400, 'GEMINI_BATCH_INVALID_DISPLAY_NAME', 'Gemini batch display name is invalid')
      }
      const matches: GeminiBatchSubmitResult[] = []
      const seenPageTokens = new Set<string>()
      let pageToken: string | null = null
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query = `?pageSize=${LIST_PAGE_SIZE}${pageToken === null ? '' : `&pageToken=${encodeURIComponent(pageToken)}`}`
        const response = await request(fetcher, {
          url: providerUrl(input.baseUrl, `/v1beta/batches${query}`),
          apiKey: input.apiKey,
          method: 'GET',
          timeoutMs,
        })
        const payload = record(await responseJson(response, maxResponseBytes, timeoutMs))
        if (payload === null || (payload.batches !== undefined && !Array.isArray(payload.batches))) {
          throw invalidProviderResponse('Gemini batch list response is invalid')
        }
        const jobs = Array.isArray(payload.batches) ? payload.batches : []
        for (const rawJob of jobs) {
          const job = record(rawJob)
          if (job === null || displayNameOf(job) !== input.displayName) continue
          const providerJobId = safeProviderJobId(job.name)
          if (providerJobId === null) {
            throw invalidProviderResponse('Gemini batch list contains an invalid matching job name')
          }
          matches.push({
            providerJobId,
            rawState: boundedString(job.state) ?? 'JOB_STATE_PENDING',
            pollAfterMs: pollAfter(response.headers),
          })
          if (matches.length > 1) return { status: 'ambiguous' }
        }
        const nextPageToken = boundedPageToken(payload.nextPageToken ?? payload.next_page_token)
        if (nextPageToken === null) {
          return matches.length === 0 ? { status: 'absent' } : { status: 'found', ...matches[0]! }
        }
        if (seenPageTokens.has(nextPageToken)) {
          throw invalidProviderResponse('Gemini batch list repeated a page token')
        }
        seenPageTokens.add(nextPageToken)
        pageToken = nextPageToken
      }
      throw new GatewayError(
        503,
        'GEMINI_BATCH_LIST_INCOMPLETE',
        'Gemini batch recovery list could not be scanned safely',
        'server_error',
      )
    },
  }
}

function geminiImageRequest(
  input: GeminiBatchSubmitInput,
  item: GeminiBatchManifestItem,
): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: item.prompt }]
  for (const reference of item.reference_images) {
    if (typeof reference.data === 'string') {
      parts.push({ inlineData: { mimeType: reference.mime_type, data: reference.data } })
    } else if (typeof reference.file_uri === 'string') {
      parts.push({ fileData: { mimeType: reference.mime_type, fileUri: reference.file_uri } })
    }
  }
  const imageConfig: Record<string, string> = { imageSize: input.imageSize }
  if (input.aspectRatio !== null) imageConfig.aspectRatio = input.aspectRatio
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig },
  }
}

async function request(
  fetcher: Fetcher,
  input: { url: string; apiKey: string; method: string; body?: string; timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const response = await fetcher(input.url, {
      method: input.method,
      headers: {
        'x-goog-api-key': input.apiKey,
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: input.body }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) throw await upstreamError(response)
    return response
  } catch (error) {
    if (error instanceof GatewayError) throw error
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new GatewayError(504, 'GEMINI_BATCH_TIMEOUT', 'Gemini batch request timed out', 'server_error')
    }
    throw new GatewayError(503, 'GEMINI_BATCH_UNAVAILABLE', 'Gemini batch service is unavailable', 'server_error')
  } finally {
    clearTimeout(timeout)
  }
}

async function responseJson(response: Response, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel()
    throw responseTooLarge()
  }
  const bytes = await readBoundedBody(response, maxBytes, timeoutMs)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw invalidProviderResponse('Gemini batch response is not valid JSON')
  }
}

async function upstreamError(response: Response): Promise<GatewayError> {
  await response.body?.cancel().catch(() => undefined)
  return new GatewayError(
    response.status === 429 ? 503 : 502,
    `GEMINI_BATCH_UPSTREAM_${response.status}`,
    `Gemini batch request failed with status ${response.status}`.slice(0, ERROR_MESSAGE_LIMIT),
    'server_error',
    String(Math.ceil(pollAfter(response.headers) / 1_000)),
  )
}

async function discardBounded(response: Response, maxBytes: number, timeoutMs: number): Promise<void> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel()
    throw responseTooLarge()
  }
  await readBoundedBody(response, maxBytes, timeoutMs)
}

async function readBoundedBody(response: Response, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw responseBodyTimeout()
      let timeout: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(responseBodyTimeout()), remaining)
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout)
      })
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) throw responseTooLarge()
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel('Gemini batch response rejected').catch(() => undefined)
    throw error
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function providerUrl(baseUrl: string, path: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new GatewayError(500, 'GEMINI_BATCH_INVALID_BASE_URL', 'Gemini batch base URL is invalid', 'server_error')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new GatewayError(500, 'GEMINI_BATCH_INVALID_BASE_URL', 'Gemini batch base URL is invalid', 'server_error')
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${path}`
}

function safeProviderJobId(value: unknown): string | null {
  return typeof value === 'string' && /^batches\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ? value
    : null
}

function displayNameOf(job: Record<string, unknown>): string | null {
  return exactDisplayName(job.displayName ?? job.display_name)
    ?? exactDisplayName(record(job.metadata)?.displayName ?? record(job.metadata)?.display_name)
}

function exactDisplayName(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= 255 ? value : null
}

function boundedPageToken(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 1_024) {
    throw invalidProviderResponse('Gemini batch list contains an invalid page token')
  }
  return value
}

function requireProviderJobId(value: unknown): string {
  const safe = safeProviderJobId(value)
  if (safe === null) {
    throw new GatewayError(
      400,
      'GEMINI_BATCH_INVALID_JOB_ID',
      'Gemini batch job ID is invalid',
    )
  }
  return safe
}

function normalizedState(rawState: string): GeminiBatchState {
  switch (rawState.toUpperCase()) {
    case 'JOB_STATE_PENDING': return 'pending'
    case 'JOB_STATE_RUNNING': return 'running'
    case 'JOB_STATE_SUCCEEDED': return 'succeeded'
    case 'JOB_STATE_FAILED': return 'failed'
    case 'JOB_STATE_CANCELLED': return 'cancelled'
    case 'JOB_STATE_EXPIRED': return 'expired'
    default: throw invalidProviderResponse('Gemini batch response contains an unknown job state')
  }
}

function parseInlinedResponses(
  job: Record<string, unknown>,
  maxImageBytes: number,
  apiKey: string,
  expectedMimeType: ImageMimeType | undefined,
): GeminiBatchItemResult[] {
  const response = record(job.response)
  const rawItems = response?.inlinedResponses ?? response?.inlined_responses
  if (!Array.isArray(rawItems)) {
    throw invalidProviderResponse('Gemini batch succeeded without inline responses')
  }
  const seen = new Set<string>()
  return rawItems.map((rawItem) => {
    const item = record(rawItem)
    const metadata = record(item?.metadata)
    const customId = boundedString(metadata?.key)
    if (item === null || customId === null || customId.length > 255) {
      throw invalidProviderResponse('Gemini batch response contains an invalid item key')
    }
    if (seen.has(customId)) {
      throw new GatewayError(
        502,
        'GEMINI_BATCH_DUPLICATE_ITEM_KEY',
        'Gemini batch response contains a duplicate item key',
        'server_error',
      )
    }
    seen.add(customId)
    const error = record(item.error)
    if (error !== null) {
      return { customId, error: providerItemError(error, apiKey) }
    }
    const providerResponse = record(item.response)
    if (providerResponse === null) {
      return {
        customId,
        error: { code: 'GEMINI_BATCH_ITEM_RESPONSE_MISSING', message: 'Gemini batch item returned no response' },
      }
    }
    const outputs = parseImages(providerResponse, maxImageBytes, expectedMimeType)
    if (outputs.length === 0) {
      return {
        customId,
        error: { code: 'GEMINI_BATCH_IMAGE_MISSING', message: 'Gemini batch item returned no inline image' },
      }
    }
    return { customId, outputs }
  })
}

function parseImages(
  response: Record<string, unknown>,
  maxImageBytes: number,
  expectedMimeType: ImageMimeType | undefined,
): GeminiBatchOutput[] {
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  const outputs: GeminiBatchOutput[] = []
  for (const rawCandidate of candidates) {
    const candidate = record(rawCandidate)
    const content = record(candidate?.content)
    const parts = Array.isArray(content?.parts) ? content.parts : []
    for (const rawPart of parts) {
      const part = record(rawPart)
      const inline = record(part?.inlineData) ?? record(part?.inline_data)
      if (inline === null) continue
      const mimeType = imageMimeType(inline.mimeType ?? inline.mime_type)
      if (mimeType === null) {
        throw invalidProviderResponse('Gemini batch returned an unsupported inline image type')
      }
      if (expectedMimeType !== undefined && mimeType !== expectedMimeType) {
        throw invalidProviderResponse('Gemini batch returned an unexpected inline image type')
      }
      if (typeof inline.data !== 'string') {
        throw invalidProviderResponse('Gemini batch returned invalid inline image data')
      }
      outputs.push({ mimeType, bytes: decodeImageBase64(inline.data, maxImageBytes) })
    }
  }
  return outputs
}

function decodeImageBase64(value: string, maxImageBytes: number): ArrayBuffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw invalidProviderResponse('Gemini batch returned invalid inline image data')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedLength = value.length / 4 * 3 - padding
  if (decodedLength < 1 || decodedLength > maxImageBytes) {
    throw new GatewayError(
      502,
      'GEMINI_BATCH_IMAGE_TOO_LARGE',
      'Gemini batch returned an image exceeding the Worker limit',
      'server_error',
    )
  }
  try {
    const binary = atob(value)
    if (binary.length !== decodedLength) throw new Error('invalid base64 length')
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes.buffer
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw invalidProviderResponse('Gemini batch returned invalid inline image data')
  }
}

function imageMimeType(value: unknown): ImageMimeType | null {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase()
  return normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp'
    ? normalized
    : null
}

function providerItemError(error: Record<string, unknown>, apiKey: string): { code: string; message: string } {
  const rawCode = boundedString(error.status) ?? boundedString(error.code)
  return {
    code: sanitizeCode(rawCode, 'GEMINI_BATCH_ITEM_FAILED'),
    message: sanitizeMessage(error.message, apiKey, 'Gemini batch item failed'),
  }
}

function jobError(
  job: Record<string, unknown>,
  state: 'failed' | 'cancelled' | 'expired',
  apiKey: string,
): { code: string; message: string } {
  const error = record(job.error)
  const fallback = state === 'failed'
    ? { code: 'GEMINI_BATCH_FAILED', message: 'Gemini batch failed' }
    : state === 'cancelled'
      ? { code: 'GEMINI_BATCH_CANCELLED', message: 'Gemini batch was cancelled' }
      : { code: 'GEMINI_BATCH_EXPIRED', message: 'Gemini batch expired' }
  if (error === null) return fallback
  return {
    code: sanitizeCode(boundedString(error.status) ?? boundedString(error.code), fallback.code),
    message: sanitizeMessage(error.message, apiKey, fallback.message),
  }
}

function sanitizeCode(value: string | null, fallback: string): string {
  if (value === null) return fallback
  const sanitized = value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96)
  return sanitized === '' ? fallback : sanitized
}

function sanitizeMessage(value: unknown, apiKey: string, fallback: string): string {
  const message = boundedString(value)
  if (message === null) return fallback
  const redacted = apiKey === '' ? message : message.split(apiKey).join('[redacted]')
  return redacted.slice(0, ERROR_MESSAGE_LIMIT)
}

function pollAfter(headers: Headers): number {
  const value = headers.get('retry-after')
  if (value === null) return DEFAULT_POLL_AFTER_MS
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value)
    : (Date.parse(value) - Date.now()) / 1_000
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_POLL_AFTER_MS
  return Math.min(MAX_POLL_AFTER_MS, Math.max(MIN_POLL_AFTER_MS, Math.round(seconds * 1_000)))
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, ERROR_MESSAGE_LIMIT) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function responseTooLarge(): GatewayError {
  return new GatewayError(
    502,
    'GEMINI_BATCH_RESPONSE_TOO_LARGE',
    'Gemini batch response exceeds the Worker limit',
    'server_error',
  )
}

function responseBodyTimeout(): GatewayError {
  return new GatewayError(504, 'GEMINI_BATCH_TIMEOUT', 'Gemini batch response timed out', 'server_error')
}

function invalidProviderResponse(message: string): GatewayError {
  return new GatewayError(502, 'GEMINI_BATCH_INVALID_RESPONSE', message.slice(0, ERROR_MESSAGE_LIMIT), 'server_error')
}
