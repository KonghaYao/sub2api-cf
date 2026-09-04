import { GatewayError } from './errors'

const JSON_UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])
const HEX = '0123456789abcdef'

export const MAX_GATEWAY_REQUEST_BYTES = 2 * 1024 * 1024

export interface GatewayJsonBody {
  body: Record<string, unknown>
  bytes: Uint8Array
}

type SupportedContentEncoding = 'identity' | 'gzip' | 'deflate'

/**
 * Reads a gateway JSON document and stops consuming the stream at the first
 * byte beyond the accepted size. Compatibility normalization mirrors the original gateway:
 * a leading UTF-8 BOM is ignored and raw control bytes inside JSON strings are
 * escaped before strict JSON parsing.
 */
export async function readGatewayJsonBody(request: Request): Promise<GatewayJsonBody> {
  const bytes = await readEncodedBodyLimited(request, MAX_GATEWAY_REQUEST_BYTES)
  if (bytes.byteLength === 0) {
    throw new GatewayError(400, 'empty_body', 'Request body is required')
  }

  const normalized = normalizeLenientJson(bytes, MAX_GATEWAY_REQUEST_BYTES)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(normalized))
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_body', 'Request body must be a JSON object')
  }
  return { body: value as Record<string, unknown>, bytes: normalized }
}

async function readEncodedBodyLimited(request: Request, limit: number): Promise<Uint8Array> {
  let encoding: SupportedContentEncoding
  try {
    encoding = parseContentEncoding(request.headers.get('content-encoding'))
  } catch (error) {
    await cancelBody(request.body, error)
    throw error
  }

  const declaredLength = declaredContentLength(request.headers.get('content-length'))
  if (declaredLength !== null && declaredLength > limit) {
    await cancelBody(request.body, new Error('Request body exceeds the configured limit'))
    throw requestTooLarge()
  }

  if (request.body === null) return new Uint8Array()
  const raw = await readStreamLimited(
    request.body,
    limit,
    new GatewayError(400, 'request_body_read_error', 'Failed to read request body'),
  )
  if (encoding === 'identity') return raw

  const compressedStream = new Response(toExactArrayBuffer(raw)).body
  if (compressedStream === null) {
    throw new GatewayError(400, 'invalid_compressed_body', 'Failed to decode compressed request body')
  }
  const decompressed = compressedStream.pipeThrough(new DecompressionStream(encoding))
  return readStreamLimited(
    decompressed,
    limit,
    new GatewayError(400, 'invalid_compressed_body', 'Failed to decode compressed request body'),
  )
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  readError: GatewayError,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (total + result.value.byteLength > limit) {
        await cancelReader(reader, new Error('Request body exceeds the configured limit'))
        throw requestTooLarge()
      }
      chunks.push(result.value)
      total += result.value.byteLength
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error
    await cancelReader(reader, error)
    throw readError
  }

  if (chunks.length === 1 && chunks[0]!.byteLength === total) return chunks[0]!
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function parseContentEncoding(value: string | null): SupportedContentEncoding {
  const encoding = value?.trim().toLowerCase() ?? ''
  if (encoding === '' || encoding === 'identity') return 'identity'
  if (encoding === 'gzip' || encoding === 'x-gzip') return 'gzip'
  if (encoding === 'deflate') return 'deflate'
  throw new GatewayError(
    415,
    'unsupported_content_encoding',
    'Content-Encoding must be identity, gzip, or deflate',
  )
}

function declaredContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, reason: unknown): Promise<void> {
  if (body === null || body.locked) return
  try {
    await body.cancel(reason)
  } catch {
    // The rejection being returned to the client is authoritative. Cancellation
    // is resource cleanup and must not replace it with an implementation error.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason)
  } catch {
    // See cancelBody: cleanup errors are deliberately secondary.
  }
}

function normalizeLenientJson(bytes: Uint8Array, limit: number): Uint8Array {
  const start = hasUtf8Bom(bytes) ? JSON_UTF8_BOM.byteLength : 0
  let normalizedLength = bytes.byteLength - start
  let inString = false
  let escaped = false
  let controlCount = 0

  for (let index = start; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!
    if (inString && isJsonControlByte(byte)) {
      normalizedLength += 5
      controlCount += 1
      escaped = false
    } else if (escaped) {
      escaped = false
    } else if (inString && byte === 0x5c) {
      escaped = true
    } else if (byte === 0x22) {
      inString = !inString
    }
    if (normalizedLength > limit) throw requestTooLarge()
  }

  if (controlCount === 0) return bytes.subarray(start)

  const normalized = new Uint8Array(normalizedLength)
  inString = false
  escaped = false
  let output = 0
  for (let index = start; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!
    if (inString && isJsonControlByte(byte)) {
      normalized[output] = 0x5c
      normalized[output + 1] = 0x75
      normalized[output + 2] = 0x30
      normalized[output + 3] = 0x30
      normalized[output + 4] = HEX.charCodeAt(byte >> 4)
      normalized[output + 5] = HEX.charCodeAt(byte & 0x0f)
      output += 6
      escaped = false
      continue
    }
    normalized[output] = byte
    output += 1
    if (escaped) {
      escaped = false
    } else if (inString && byte === 0x5c) {
      escaped = true
    } else if (byte === 0x22) {
      inString = !inString
    }
  }
  return normalized
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= JSON_UTF8_BOM.byteLength &&
    bytes[0] === JSON_UTF8_BOM[0] &&
    bytes[1] === JSON_UTF8_BOM[1] &&
    bytes[2] === JSON_UTF8_BOM[2]
}

function isJsonControlByte(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f
}

function requestTooLarge(): GatewayError {
  return new GatewayError(413, 'request_too_large', 'Request body exceeds the 2 MiB limit')
}
