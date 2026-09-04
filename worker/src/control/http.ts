import { sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  return parseJsonObject(await readBoundedText(request))
}

export async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request)
  return text.trim() === '' ? {} : parseJsonObject(text)
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_body', 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

async function readBoundedText(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_JSON_BODY_BYTES) {
    throw requestTooLarge()
  }
  if (request.body === null) return ''

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel()
        throw requestTooLarge()
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function requestTooLarge(): GatewayError {
  return new GatewayError(413, 'request_too_large', 'Request body exceeds the 2 MiB limit')
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (key.length < 8 || key.length > 200) {
    throw new GatewayError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain between 8 and 200 characters',
    )
  }
  return key
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a non-empty string`)
  }
  return value.trim()
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): string | undefined {
  return body[field] === undefined ? undefined : requireString(body, field, maximum)
}

export function requireSafeInteger(
  body: Record<string, unknown>,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = body[field]
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GatewayError(
      400,
      `invalid_${field}`,
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    )
  }
  return value as number
}

export function optionalSafeInteger(
  body: Record<string, unknown>,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  return body[field] === undefined
    ? undefined
    : requireSafeInteger(body, field, minimum, maximum)
}

export function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a boolean`)
  }
  return value
}

export function optionalNullableString(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): string | null | undefined {
  if (body[field] === undefined) return undefined
  if (body[field] === null || body[field] === '') return null
  return requireString(body, field, maximum)
}

export function requireExpectedControlVersion(
  request: Request,
  body: Record<string, unknown>,
): number {
  const bodyValue = optionalSafeInteger(body, 'expected_control_version')
  const header = request.headers.get('if-match')?.trim()
  let headerValue: number | undefined
  if (header !== undefined && header !== '') {
    const match = /^(?:W\/)?"?(\d+)"?$/.exec(header)
    if (match === null || !Number.isSafeInteger(Number(match[1]))) {
      throw new GatewayError(400, 'invalid_if_match', 'If-Match must contain a control version')
    }
    headerValue = Number(match[1])
  }
  if (bodyValue !== undefined && headerValue !== undefined && bodyValue !== headerValue) {
    throw new GatewayError(400, 'control_version_mismatch', 'If-Match and expected_control_version disagree')
  }
  const value = bodyValue ?? headerValue
  if (value === undefined) {
    throw new GatewayError(428, 'control_version_required', 'If-Match or expected_control_version is required')
  }
  return value
}

export function requireResourceId(value: string | undefined, resource: string): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new GatewayError(400, `invalid_${resource}_id`, `${resource} id is invalid`)
  }
  return value
}

export function queryInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new GatewayError(400, `invalid_${name}`, `${name} must be an integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GatewayError(400, `invalid_${name}`, `${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

export function controlSuccess(data: unknown, status = 200): Response {
  return Response.json(
    { code: 0, data },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

export function controlError(error: GatewayError): Response {
  return Response.json(
    {
      code: error.code,
      message: error.message,
      data: null,
      error: { code: error.code, message: error.message, type: error.type },
    },
    { status: error.status, headers: { 'cache-control': 'no-store' } },
  )
}

export async function deterministicUuid(namespace: string, idempotencyKey: string): Promise<string> {
  const digest = await sha256Hex(`${namespace}\u0000${idempotencyKey}`)
  const value = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17, 32)}`
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
