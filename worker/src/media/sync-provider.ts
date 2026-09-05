import { GatewayError } from '../gateway/errors'

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const DEFAULT_RESPONSE_LIMIT = 48 * 1024 * 1024
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000

export interface NormalizedSyncImageOutput {
  bytes?: Uint8Array
  url?: string
  size?: string
}

export interface NormalizedSyncImageResult {
  publicBody: Record<string, unknown>
  outputs: NormalizedSyncImageOutput[]
}

export async function readSyncImageResponse(
  response: Response,
  maximumBytes = DEFAULT_RESPONSE_LIMIT,
  timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel()
    throw responseTooLarge()
  }
  const bytes = await readBoundedResponseBody(response, maximumBytes, timeoutMs)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new GatewayError(502, 'IMAGE_INVALID_UPSTREAM_RESPONSE', 'Image provider returned invalid JSON', 'server_error')
  }
  if (!response.ok) throw upstreamError(response, value)
  return value
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      await reader.cancel('image response timeout')
      throw new GatewayError(504, 'IMAGE_UPSTREAM_BODY_TIMEOUT', 'Image provider response body timed out', 'server_error')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new GatewayError(
        504,
        'IMAGE_UPSTREAM_BODY_TIMEOUT',
        'Image provider response body timed out',
        'server_error',
      )), remaining)
    })
    let next: ReadableStreamReadResult<Uint8Array>
    try {
      next = await Promise.race([reader.read(), timeout])
    } catch (error) {
      await reader.cancel('image response timeout')
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (next.done) break
    total += next.value.byteLength
    if (total > maximumBytes) {
      await reader.cancel('image response too large')
      throw responseTooLarge()
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

export function normalizeNativeImageResponse(value: unknown, maxOutputs = 100): NormalizedSyncImageResult {
  const root = record(value)
  if (root === null || !Array.isArray(root.data)) return missingOutput()
  const data: Record<string, unknown>[] = []
  const outputs: NormalizedSyncImageOutput[] = []
  const seen = new Set<string>()
  for (const candidate of root.data) {
    if (outputs.length >= maxOutputs) break
    const item = record(candidate)
    if (item === null) continue
    const normalized = normalizePublicImage(item)
    if (normalized === null) continue
    const identity = typeof normalized.publicItem.b64_json === 'string'
      ? `b64:${normalized.publicItem.b64_json}`
      : `url:${normalized.publicItem.url as string}`
    if (seen.has(identity)) continue
    seen.add(identity)
    data.push(normalized.publicItem)
    outputs.push(normalized.output)
  }
  if (data.length === 0) return missingOutput()
  const publicBody: Record<string, unknown> = {
    created: nonNegativeInteger(root.created) ?? Math.floor(Date.now() / 1000),
    data,
  }
  const usage = normalizeUsage(root.usage)
  if (usage !== null) publicBody.usage = usage
  if (typeof root.model === 'string' && root.model !== '') publicBody.model = bounded(root.model, 200)
  return { publicBody, outputs }
}

export function normalizeResponsesImageResponse(
  value: unknown,
  publicModel: string,
  responseFormat: 'b64_json' | 'url',
): NormalizedSyncImageResult {
  const root = record(value)
  if (root === null || !Array.isArray(root.output)) return missingOutput()
  const data: Record<string, unknown>[] = []
  const outputs: NormalizedSyncImageOutput[] = []
  const seen = new Set<string>()
  for (const candidate of root.output) {
    const item = record(candidate)
    if (item?.type !== 'image_generation_call' || item.status !== 'completed' || typeof item.result !== 'string') continue
    const decoded = decodeBase64(item.result)
    if (decoded === null) {
      throw new GatewayError(502, 'IMAGE_INVALID_PROVIDER_OUTPUT', 'Image provider returned malformed image data', 'server_error')
    }
    const identity = typeof item.id === 'string' && item.id !== '' ? item.id : item.result
    if (seen.has(identity)) continue
    seen.add(identity)
    const mimeType = outputMimeType(item.output_format)
    const publicItem: Record<string, unknown> = responseFormat === 'url'
      ? { url: `data:${mimeType};base64,${item.result}` }
      : { b64_json: item.result }
    copyOptionalString(item, publicItem, 'revised_prompt', 16_000)
    copyOptionalString(item, publicItem, 'size', 64)
    data.push(publicItem)
    outputs.push({
      bytes: decoded,
      ...(typeof item.size === 'string' && item.size !== '' ? { size: bounded(item.size, 64) } : {}),
    })
  }
  if (data.length === 0) return missingOutput()
  const publicBody: Record<string, unknown> = {
    created: nonNegativeInteger(root.created_at) ?? Math.floor(Date.now() / 1000),
    data,
    model: publicModel,
  }
  const usage = normalizeUsage(root.usage)
  if (usage !== null) publicBody.usage = usage
  return { publicBody, outputs }
}

function normalizePublicImage(item: Record<string, unknown>): {
  publicItem: Record<string, unknown>
  output: NormalizedSyncImageOutput
} | null {
  const publicItem: Record<string, unknown> = {}
  let output: NormalizedSyncImageOutput
  if (typeof item.b64_json === 'string' && item.b64_json !== '') {
    const bytes = decodeBase64(item.b64_json)
    if (bytes === null) {
      throw new GatewayError(502, 'IMAGE_INVALID_PROVIDER_OUTPUT', 'Image provider returned malformed image data', 'server_error')
    }
    publicItem.b64_json = item.b64_json
    output = { bytes }
  } else if (typeof item.url === 'string' && item.url !== '') {
    const parsed = safeImageUrl(item.url)
    publicItem.url = item.url
    output = parsed.bytes === undefined ? { url: item.url } : { bytes: parsed.bytes }
  } else {
    return null
  }
  copyOptionalString(item, publicItem, 'revised_prompt', 16_000)
  copyOptionalString(item, publicItem, 'size', 64)
  if (typeof publicItem.size === 'string') output.size = publicItem.size
  return { publicItem, output }
}

function safeImageUrl(value: string): { bytes?: Uint8Array } {
  if (value.startsWith('data:image/')) {
    const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value)
    if (match === null) invalidUrl()
    const bytes = decodeBase64(match[1])
    if (bytes === null) invalidUrl()
    return { bytes }
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { return invalidUrl() }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return invalidUrl()
  return {}
}

function invalidUrl(): never {
  throw new GatewayError(502, 'IMAGE_INVALID_PROVIDER_OUTPUT', 'Image provider returned an unsafe image URL', 'server_error')
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null
  try {
    const decoded = atob(value.padEnd(Math.ceil(value.length / 4) * 4, '='))
    if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES) return null
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function normalizeUsage(value: unknown): Record<string, number> | null {
  const usage = record(value)
  if (usage === null) return null
  const output: Record<string, number> = {}
  for (const field of [
    'input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details',
  ]) {
    const number = nonNegativeInteger(usage[field])
    if (number !== null) output[field] = number
  }
  return Object.keys(output).length === 0 ? null : output
}

function upstreamError(response: Response, value: unknown): GatewayError {
  const envelope = record(record(value)?.error)
  const retryable = response.status >= 500 || response.status === 429
  const code = safeErrorString(envelope?.code) ?? `IMAGE_UPSTREAM_${response.status}`
  const type = safeErrorString(envelope?.type) ?? (retryable ? 'server_error' : 'invalid_request_error')
  const message = safeErrorString(envelope?.message) ?? `Image provider request failed with status ${response.status}`
  const param = safeErrorString(envelope?.param) ?? undefined
  return new GatewayError(
    response.status,
    code,
    message,
    type,
    response.headers.get('retry-after') ?? undefined,
    param,
  )
}

function safeErrorString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/https?:\/\/\S+/gi, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return cleaned === '' ? null : cleaned.slice(0, 240)
}

function responseTooLarge(): GatewayError {
  return new GatewayError(502, 'IMAGE_UPSTREAM_RESPONSE_TOO_LARGE', 'Image provider response exceeded the size limit', 'server_error')
}

function missingOutput(): never {
  throw new GatewayError(502, 'IMAGE_PROVIDER_OUTPUT_MISSING', 'Image provider returned no usable image', 'server_error')
}

function outputMimeType(value: unknown): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (value === 'jpeg' || value === 'jpg') return 'image/jpeg'
  if (value === 'webp') return 'image/webp'
  return 'image/png'
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  field: string,
  maximum: number,
): void {
  if (typeof source[field] === 'string' && source[field] !== '') target[field] = bounded(source[field] as string, maximum)
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
