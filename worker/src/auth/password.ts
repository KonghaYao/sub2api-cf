const encoder = new TextEncoder()

export const PASSWORD_MIN_CODE_POINTS = 8
export const PASSWORD_MAX_CODE_POINTS = 256
export const PASSWORD_MAX_UTF8_BYTES = 1_024

const PASSWORD_VERSION = 1
// Cloudflare Workers WebCrypto rejects PBKDF2 iteration counts above 100,000.
const PBKDF2_ITERATIONS = 100_000
const MIN_ACCEPTED_ITERATIONS = 100_000
const MAX_ACCEPTED_ITERATIONS = 1_000_000
const SALT_BYTES = 16
const DERIVED_KEY_BYTES = 32
const CREDENTIAL_PATTERN = /^pbkdf2-sha256\$v=(\d+)\$i=(\d+)\$l=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/

export class PasswordValidationError extends Error {
  readonly code = 'invalid_password'

  constructor(message: string) {
    super(message)
    this.name = 'PasswordValidationError'
  }
}

interface ParsedCredential {
  version: number
  iterations: number
  length: number
  salt: Uint8Array
  digest: Uint8Array
}

/** Hash a new user password using a random salt and versioned PBKDF2-SHA256. */
export async function hashPassword(password: string): Promise<string> {
  const passwordBytes = newPasswordBytes(password)
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const digest = await derivePassword(passwordBytes, salt, PBKDF2_ITERATIONS, DERIVED_KEY_BYTES)
  return [
    'pbkdf2-sha256',
    `v=${PASSWORD_VERSION}`,
    `i=${PBKDF2_ITERATIONS}`,
    `l=${DERIVED_KEY_BYTES}`,
    toBase64Url(salt),
    toBase64Url(digest),
  ].join('$')
}

/** Validate a new password without starting PBKDF2 work. */
export function validateNewPassword(password: string): void {
  newPasswordBytes(password)
}

/** Check whether a login password can be a credential without starting PBKDF2 work. */
export function isPasswordInputValid(password: string): boolean {
  return passwordBytesForVerification(password) !== null
}

/** Verify a password without ever decoding or returning stored plaintext. */
export async function verifyPassword(password: string, credential: string): Promise<boolean> {
  const parsed = parseCredential(credential)
  const passwordBytes = passwordBytesForVerification(password)
  if (parsed === null || passwordBytes === null) return false

  try {
    const candidate = await derivePassword(
      passwordBytes,
      parsed.salt,
      parsed.iterations,
      parsed.length,
    )
    return constantTimeEqual(candidate, parsed.digest)
  } catch {
    return false
  }
}

/** True when a stored value is invalid or should be upgraded after login. */
export function needsPasswordRehash(credential: string): boolean {
  const parsed = parseCredential(credential)
  return parsed === null ||
    parsed.version !== PASSWORD_VERSION ||
    parsed.iterations !== PBKDF2_ITERATIONS ||
    parsed.length !== DERIVED_KEY_BYTES
}

function newPasswordBytes(password: string): Uint8Array {
  if (typeof password !== 'string') throw new PasswordValidationError('Password must be a string')
  const codePoints = Array.from(password).length
  if (codePoints < PASSWORD_MIN_CODE_POINTS) {
    throw new PasswordValidationError(
      `Password must contain at least ${PASSWORD_MIN_CODE_POINTS} characters`,
    )
  }
  if (codePoints > PASSWORD_MAX_CODE_POINTS) {
    throw new PasswordValidationError(
      `Password must contain at most ${PASSWORD_MAX_CODE_POINTS} characters`,
    )
  }
  const bytes = encoder.encode(password)
  if (bytes.byteLength > PASSWORD_MAX_UTF8_BYTES) {
    throw new PasswordValidationError(
      `Password must contain at most ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes`,
    )
  }
  return bytes
}

function passwordBytesForVerification(password: string): Uint8Array | null {
  if (typeof password !== 'string') return null
  const codePoints = Array.from(password).length
  if (codePoints < PASSWORD_MIN_CODE_POINTS || codePoints > PASSWORD_MAX_CODE_POINTS) return null
  const bytes = encoder.encode(password)
  return bytes.byteLength <= PASSWORD_MAX_UTF8_BYTES ? bytes : null
}

function parseCredential(credential: string): ParsedCredential | null {
  if (typeof credential !== 'string' || credential.length > 256) return null
  const match = CREDENTIAL_PATTERN.exec(credential)
  if (match === null) return null
  const version = parseCanonicalInteger(match[1])
  const iterations = parseCanonicalInteger(match[2])
  const length = parseCanonicalInteger(match[3])
  if (
    version !== PASSWORD_VERSION ||
    iterations === null ||
    iterations < MIN_ACCEPTED_ITERATIONS ||
    iterations > MAX_ACCEPTED_ITERATIONS ||
    length !== DERIVED_KEY_BYTES
  ) {
    return null
  }
  const salt = fromBase64Url(match[4], SALT_BYTES)
  const digest = fromBase64Url(match[5], DERIVED_KEY_BYTES)
  if (salt === null || digest === null) return null
  return { version, iterations, length, salt, digest }
}

async function derivePassword(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    ownedArrayBuffer(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: ownedArrayBuffer(salt), iterations },
    material,
    length * 8,
  )
  return new Uint8Array(bits)
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  return buffer
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength)
  let difference = left.byteLength ^ right.byteLength
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function parseCanonicalInteger(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function toBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string, expectedBytes: number): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`
    const binary = atob(padded)
    if (binary.length !== expectedBytes) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return toBase64Url(bytes) === value ? bytes : null
  } catch {
    return null
  }
}
