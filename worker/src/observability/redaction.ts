import { sha256Hex } from '../gateway/crypto'

export const MAX_OBSERVABILITY_PAYLOAD_BYTES = 98_304
const REDACTED = '[REDACTED]'
const MAX_DEPTH = 12
const MAX_ENTRIES = 500
// Preserve enough context for the aggregate payload budget to make the final,
// explicit truncation decision instead of silently clipping a single field.
const MAX_STRING = MAX_OBSERVABILITY_PAYLOAD_BYTES * 2
const SAFE_HEADERS = new Set([
  'accept', 'content-type', 'user-agent', 'x-request-id', 'x-client-request-id',
  'cf-ray', 'cf-ipcountry', 'openai-organization', 'openai-project',
])
const SECRET_FIELD = /(?:^|[_-])(?:authorization|api[_-]?key|password|passwd|secret|token|cookie|credential|session|private[_-]?key)(?:$|[_-])/i
const SECRET_TEXT = /(?:bearer\s+)[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{6,}\b/gi
const encoder = new TextEncoder()

export interface ObservabilityPayload {
  request?: unknown
  response?: unknown
  error?: unknown
  context?: unknown
}

export interface EncodedObservabilityPayload {
  text: string
  bytes: number
  sha256: string
  contentType: 'application/json'
}

export function sanitizeObservabilityPayload(input: ObservabilityPayload): Record<string, unknown> {
  const safe: Record<string, unknown> = { schema_version: 1, redacted: true }
  if (input.request !== undefined) safe.request = sanitizeSection(input.request, true)
  if (input.response !== undefined) safe.response = sanitizeSection(input.response, false)
  if (input.error !== undefined) safe.error = sanitizeSection(input.error, false)
  if (input.context !== undefined) safe.context = sanitizeSection(input.context, false)
  return safe
}

export async function encodeObservabilityPayload(
  input: ObservabilityPayload | Record<string, unknown>,
): Promise<EncodedObservabilityPayload> {
  const sanitized = 'schema_version' in input
    ? input as Record<string, unknown>
    : sanitizeObservabilityPayload(input)
  let text = JSON.stringify(sanitized)
  let bytes = encoder.encode(text).byteLength
  if (bytes > MAX_OBSERVABILITY_PAYLOAD_BYTES) {
    text = JSON.stringify({
      schema_version: 1,
      redacted: true,
      truncated: true,
      original_sanitized_bytes: bytes,
      request: diagnosticSummary(sanitized.request),
      response: diagnosticSummary(sanitized.response),
      error: diagnosticSummary(sanitized.error),
      context: diagnosticSummary(sanitized.context),
    })
    bytes = encoder.encode(text).byteLength
  }
  return {
    text,
    bytes,
    sha256: await sha256Hex(text),
    contentType: 'application/json',
  }
}

function sanitizeSection(value: unknown, request: boolean): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return sanitizeValue(value, '', 0, new WeakSet(), { count: 0 })
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  const allowed = request
    ? ['method', 'path', 'headers', 'body']
    : ['status', 'status_code', 'headers', 'body', 'message', 'code', 'type', 'phase', 'owner', 'source']
  for (const key of allowed) {
    if (!(key in source)) continue
    if (key === 'headers') result.headers = sanitizeHeaders(source.headers)
    else if (key === 'path' && typeof source.path === 'string') result.path = sanitizePath(source.path)
    else result[key] = sanitizeValue(source[key], key, 0, new WeakSet(), { count: 0 })
  }
  return result
}

function sanitizeHeaders(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (value instanceof Headers) {
    for (const [key, entry] of value.entries()) {
      if (SAFE_HEADERS.has(key.toLowerCase())) result[key.toLowerCase()] = redactDiagnosticText(entry).slice(0, 2_048)
    }
    return result
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase()
    if (SAFE_HEADERS.has(key) && typeof rawValue === 'string') {
      result[key] = redactDiagnosticText(rawValue).slice(0, 2_048)
    }
  }
  return result
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
  budget: { count: number },
): unknown {
  if (isSecretField(key)) return REDACTED
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactDiagnosticText(value).slice(0, MAX_STRING)
  if (typeof value !== 'object') return `[${typeof value}]`
  if (depth >= MAX_DEPTH || budget.count >= MAX_ENTRIES) return '[TRUNCATED]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => {
      budget.count += 1
      return sanitizeValue(entry, '', depth + 1, seen, budget)
    })
  }
  const result: Record<string, unknown> = {}
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    budget.count += 1
    result[childKey] = sanitizeValue(child, childKey, depth + 1, seen, budget)
  }
  return result
}

export function redactDiagnosticText(value: string): string {
  return value.replace(SECRET_TEXT, REDACTED)
}

function sanitizePath(value: string): string {
  try {
    const url = new URL(value, 'https://observability.invalid')
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretField(key)) url.searchParams.set(key, REDACTED)
    }
    return `${url.pathname}${url.search}`.slice(0, 512)
  } catch {
    return redactDiagnosticText(value).slice(0, 512)
  }
}

function isSecretField(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SECRET_FIELD.test(normalized)
}

function diagnosticSummary(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of ['method', 'path', 'status', 'status_code', 'message', 'code', 'type', 'phase']) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  if ('body' in source) result.body = '[TRUNCATED]'
  return result
}
