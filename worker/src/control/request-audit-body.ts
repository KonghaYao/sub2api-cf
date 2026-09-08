const MAX_RAW_BODY_BYTES = 256 * 1_024
const MAX_STORED_BODY_BYTES = 16 * 1_024
const TRUNCATION_MARKER = '[TRUNCATED]'

export const REQUEST_BODY_PLACEHOLDERS = {
  notCaptured: '[not_captured]',
  sensitive: '[sensitive_body_not_captured]',
  empty: '[empty_body]',
  invalidJson: '[invalid_json]',
  nonJson: '[non_json_body_not_captured]',
  tooLarge: '[body_too_large]',
  failed: '[body_capture_failed]',
} as const

export type RequestBodyCaptureKind =
  | 'captured'
  | 'sensitive_route'
  | 'empty'
  | 'invalid_json'
  | 'non_json'
  | 'too_large'
  | 'failed'

export interface RequestBodyCapture {
  body: string
  kind: RequestBodyCaptureKind
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
  'clientsecret',
  'credential',
  'credentials',
])

const SENSITIVE_ROUTES = [
  /^\/api\/v1\/admin\/openai\/(?:generate-auth-url|exchange-code|refresh-token)$/,
  /^\/api\/v1\/admin\/accounts(?:\/|$)/,
  /^\/api\/v1\/admin\/oauth-providers(?:\/|$)/,
  /^\/api\/v1\/admin\/settings$/,
  /^\/api\/v1\/admin\/api-keys(?:\/|$)/,
  /^\/api\/v1\/admin\/users\/[^/]+\/api-keys(?:\/|$)/,
  /^\/api\/v1\/admin\/users$/,
  /^\/api\/v1\/admin\/payment\/providers(?:\/|$)/,
  /^\/api\/v1\/admin\/(?:promo-codes|invitation-codes|redeem-codes)(?:\/|$)/,
  /\/(?:import|credentials?|oauth-callback|totp|passkeys?|webhooks?)(?:\/|$)/i,
]

/**
 * Reads only a clone and returns a bounded, deterministic, recursively redacted
 * JSON representation. The caller is responsible for authenticated route
 * admission and for invoking this only on audited mutations.
 */
export async function captureAdminRequestBody(
  request: Request,
  pathname: string,
): Promise<RequestBodyCapture> {
  if (SENSITIVE_ROUTES.some((pattern) => pattern.test(pathname))) {
    return capture(REQUEST_BODY_PLACEHOLDERS.sensitive, 'sensitive_route')
  }
  if (request.body === null) {
    return capture(REQUEST_BODY_PLACEHOLDERS.empty, 'empty')
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
    return capture(REQUEST_BODY_PLACEHOLDERS.nonJson, 'non_json')
  }

  const declaredLength = request.headers.get('content-length')?.trim()
  if (declaredLength !== undefined && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength)
    if (!Number.isSafeInteger(bytes) || bytes > MAX_RAW_BODY_BYTES) {
      return capture(REQUEST_BODY_PLACEHOLDERS.tooLarge, 'too_large')
    }
  }

  try {
    const raw = await readBoundedClone(request)
    if (raw === null) return capture(REQUEST_BODY_PLACEHOLDERS.tooLarge, 'too_large')
    if (raw.byteLength === 0) return capture(REQUEST_BODY_PLACEHOLDERS.empty, 'empty')

    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    } catch {
      return capture(REQUEST_BODY_PLACEHOLDERS.invalidJson, 'invalid_json')
    }
    const stable = JSON.stringify(redactJson(parsed))
    return capture(truncateUtf8(stable, MAX_STORED_BODY_BYTES), 'captured')
  } catch {
    return capture(REQUEST_BODY_PLACEHOLDERS.failed, 'failed')
  }
}

function capture(body: string, kind: RequestBodyCaptureKind): RequestBodyCapture {
  return { body, kind }
}

async function readBoundedClone(request: Request): Promise<Uint8Array | null> {
  const body = request.clone().body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_RAW_BODY_BYTES) {
        // A cloned request is a tee. Waiting for cancellation can wait on the
        // handler's still-live branch and turn best-effort audit into latency.
        void reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(source).sort().map((key) => [
      key,
      SENSITIVE_KEYS.has(normalizeKey(key)) ? '[REDACTED]' : redactJson(source[key]),
    ]),
  )
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= maximumBytes) return value

  // Keep the stored representation valid JSON so the unchanged detail view
  // can pretty-print it. Binary search accounts for escaping and UTF-8 width.
  let low = 0
  let high = value.length
  let result = JSON.stringify({ _audit_truncation: TRUNCATION_MARKER, preview: '' })
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = JSON.stringify({
      _audit_truncation: TRUNCATION_MARKER,
      preview: safePrefix(value, middle),
    })
    if (encoder.encode(candidate).byteLength <= maximumBytes) {
      result = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return result
}

function safePrefix(value: string, length: number): string {
  const prefix = value.slice(0, length)
  const last = prefix.charCodeAt(prefix.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix
}
