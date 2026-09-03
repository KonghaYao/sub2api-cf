const encoder = new TextEncoder()

export type OpaqueTokenKind = 'access' | 'refresh'

export const ACCESS_TOKEN_BYTES = 32
export const REFRESH_TOKEN_BYTES = 48
export const TOKEN_PEPPER_MIN_BYTES = 32

const TOKEN_VERSION = 1
const ACCESS_PREFIX = `sat_v${TOKEN_VERSION}_`
const REFRESH_PREFIX = `srt_v${TOKEN_VERSION}_`
const ACCESS_PATTERN = /^sat_v1_[A-Za-z0-9_-]{43}$/
const REFRESH_PATTERN = /^srt_v1_[A-Za-z0-9_-]{64}$/

export class TokenValidationError extends Error {
  readonly code = 'invalid_token'

  constructor(message: string) {
    super(message)
    this.name = 'TokenValidationError'
  }
}

/** Generate a single-display, CSPRNG-backed opaque session token. */
export function createOpaqueToken(kind: OpaqueTokenKind): string {
  assertTokenKind(kind)
  const bytes = kind === 'access' ? ACCESS_TOKEN_BYTES : REFRESH_TOKEN_BYTES
  const prefix = kind === 'access' ? ACCESS_PREFIX : REFRESH_PREFIX
  return `${prefix}${randomBase64Url(bytes)}`
}

/**
 * Produce the value persisted in D1. The domain prefix prevents a digest from
 * one token class being accepted as another even when a future format reuses
 * the same random payload.
 */
export async function tokenDigest(
  token: string,
  pepper: string,
  kind: OpaqueTokenKind,
): Promise<string> {
  assertTokenKind(kind)
  if (!isOpaqueToken(token, kind)) throw new TokenValidationError('Token has an invalid format')
  if (typeof pepper !== 'string' || encoder.encode(pepper).byteLength < TOKEN_PEPPER_MIN_BYTES) {
    throw new TokenValidationError(
      `Token pepper must contain at least ${TOKEN_PEPPER_MIN_BYTES} UTF-8 bytes`,
    )
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const message = `sub2api/user-session/${kind}/v${TOKEN_VERSION}\0${token}`
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return toHex(new Uint8Array(digest))
}

/** Extract and validate an access token from an Authorization header. */
export function parseBearerToken(header: string | null | undefined): string {
  if (typeof header !== 'string' || /[\r\n]/.test(header)) {
    throw new TokenValidationError('A valid Bearer access token is required')
  }
  const match = /^[ \t]*Bearer[ \t]+(sat_v1_[A-Za-z0-9_-]{43})[ \t]*$/i.exec(header)
  if (match === null || !isOpaqueToken(match[1], 'access')) {
    throw new TokenValidationError('A valid Bearer access token is required')
  }
  return match[1]
}

export function isOpaqueToken(value: unknown, kind: OpaqueTokenKind): value is string {
  if (typeof value !== 'string') return false
  return (kind === 'access' ? ACCESS_PATTERN : REFRESH_PATTERN).test(value)
}

function assertTokenKind(kind: string): asserts kind is OpaqueTokenKind {
  if (kind !== 'access' && kind !== 'refresh') {
    throw new TokenValidationError('Token kind must be access or refresh')
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
