import type { Env } from '../env'
import { apiKeyDigest } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'

export type AuthRateLimitAction = 'login' | 'register'

export interface AuthRateLimitSubject {
  action: AuthRateLimitAction
  ipDigest: string
  accountDigest: string
}

interface RateLimitResponse {
  schema_version?: unknown
  allowed?: unknown
  retry_after_seconds?: unknown
  recorded?: unknown
  cleared?: unknown
}

const SCHEMA_VERSION = 1
const PEPPER_MIN_BYTES = 32

/**
 * Fail closed against the current limits before Turnstile or secret lookup.
 * This check does not consume either dimension; commitAuthRateLimitAttempt does.
 */
export async function checkAuthRateLimit(
  env: Env,
  request: Request,
  normalizedEmail: string,
  action: AuthRateLimitAction,
): Promise<AuthRateLimitSubject> {
  const subject = await createSubject(env, request, normalizedEmail, action)
  const response = await invoke(env, '/check', subject)
  await requireAllowed(response)
  return subject
}

/** Atomically consume the IP and account attempt immediately before credential work. */
export async function commitAuthRateLimitAttempt(
  env: Env,
  subject: AuthRateLimitSubject,
): Promise<void> {
  const response = await invoke(env, '/attempt', subject)
  await requireAllowed(response)
}

async function requireAllowed(response: Response): Promise<void> {
  const result = await parseResponse(response)
  requireResponseSchema(result)
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response, result)
    throw new GatewayError(
      429,
      'auth_rate_limited',
      'Too many authentication attempts. Please retry later.',
      'rate_limit_error',
      String(retryAfter),
    )
  }
  if (!response.ok) throw unavailable()
  if (result.allowed !== true) throw unavailable()
}

export async function recordAuthRateLimitFailure(
  env: Env,
  subject: AuthRateLimitSubject,
): Promise<void> {
  const response = await invoke(env, '/failure', subject)
  if (!response.ok) throw unavailable()
  const result = await parseResponse(response)
  requireResponseSchema(result)
  if (result.recorded !== true) throw unavailable()
}

export async function clearAuthAccountRateLimit(
  env: Env,
  subject: AuthRateLimitSubject,
): Promise<void> {
  const response = await invoke(env, '/success', subject)
  if (!response.ok) throw unavailable()
  const result = await parseResponse(response)
  requireResponseSchema(result)
  if (!Array.isArray(result.cleared) || !result.cleared.includes('account')) throw unavailable()
}

async function createSubject(
  env: Env,
  request: Request,
  normalizedEmail: string,
  action: AuthRateLimitAction,
): Promise<AuthRateLimitSubject> {
  const pepper = requirePepper(env)
  const clientAddress = normalizedClientAddress(request)
  const [ipDigest, accountDigest] = await Promise.all([
    apiKeyDigest(`sub2api/auth-rate-limit/${action}/ip/v1\0${clientAddress}`, pepper),
    apiKeyDigest(`sub2api/auth-rate-limit/${action}/account/v1\0${normalizedEmail}`, pepper),
  ])
  return { action, ipDigest, accountDigest }
}

async function invoke(
  env: Env,
  path: '/check' | '/attempt' | '/failure' | '/success',
  subject: AuthRateLimitSubject,
): Promise<Response> {
  const namespace = env.AUTH_RATE_LIMIT
  if (namespace === undefined) throw unavailable()
  try {
    const id = namespace.idFromName(`${env.ENVIRONMENT}:auth-rate-limit:v1`)
    const stub = namespace.get(id)
    return await stub.fetch(new Request(`https://auth-rate-limit.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        action: subject.action,
        ip_digest: subject.ipDigest,
        account_digest: subject.accountDigest,
      }),
    }))
  } catch (error) {
    if (error instanceof GatewayError) throw error
    console.error('authentication rate limiter request failed', {
      name: error instanceof Error ? error.name : 'unknown',
    })
    throw unavailable()
  }
}

async function parseResponse(response: Response): Promise<RateLimitResponse> {
  try {
    const value: unknown = await response.json()
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as RateLimitResponse
    }
  } catch {
    // A malformed object response is an availability failure, never a bypass.
  }
  throw unavailable()
}

function requireResponseSchema(result: RateLimitResponse): void {
  if (result.schema_version !== SCHEMA_VERSION) throw unavailable()
}

function retryAfterSeconds(response: Response, result: RateLimitResponse): number {
  const bodyValue = result.retry_after_seconds
  const headerValue = response.headers.get('retry-after')
  const value = typeof bodyValue === 'number' ? bodyValue : Number(headerValue)
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}

function normalizedClientAddress(request: Request): string {
  const value = request.headers.get('cf-connecting-ip')?.trim().toLowerCase()
  return value !== undefined && value.length > 0 && value.length <= 128
    ? value
    : 'cloudflare-address-unavailable'
}

function requirePepper(env: Env): string {
  if (!env.API_KEY_PEPPER || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < PEPPER_MIN_BYTES) {
    throw new GatewayError(503, 'auth_not_configured', 'Authentication is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function unavailable(): GatewayError {
  return new GatewayError(
    503,
    'auth_rate_limit_unavailable',
    'Authentication rate limiting is unavailable',
    'server_error',
  )
}
