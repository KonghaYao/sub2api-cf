import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_PERIOD_MS = 30_000
const TOTP_SECRET_BYTES = 20
const MASTER_KEY_MIN_BYTES = 32

export const TOTP_SETUP_TTL_MS = 5 * 60 * 1_000
export const TOTP_LOGIN_TTL_MS = 5 * 60 * 1_000
export const TOTP_STEP_UP_TTL_MS = 15 * 60 * 1_000
export const TOTP_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000
export const TOTP_MAX_ATTEMPTS = 5

export interface EncryptedTotpSecret {
  secret_version: number
  nonce_b64: string
  ciphertext_b64: string
}

export interface TotpCredentialRow extends EncryptedTotpSecret {
  user_id: string
  version: number
  enabled_at_ms: number
}

export interface TotpLoginChallengeRow {
  id: string
  user_id: string
  token_hash: string
  status: 'pending' | 'consumed'
  verification_attempts: number
  version: number
  created_at_ms: number
  expires_at_ms: number
}

export function totpFeatureAvailable(env: Pick<Env, 'CREDENTIALS_MASTER_KEY'>): boolean {
  return typeof env.CREDENTIALS_MASTER_KEY === 'string' &&
    encoder.encode(env.CREDENTIALS_MASTER_KEY).byteLength >= MASTER_KEY_MIN_BYTES
}

export function generateTotpSecret(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)))
}

export async function generateTotpCode(
  secret: string,
  timeMs = Date.now(),
  digits: 6 | 8 = 6,
): Promise<string> {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) {
    throw new TypeError('TOTP time must be a non-negative safe integer')
  }
  const counter = BigInt(Math.floor(timeMs / TOTP_PERIOD_MS))
  const message = new Uint8Array(8)
  let remaining = counter
  for (let index = message.length - 1; index >= 0; index -= 1) {
    message[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(secret).buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = digest[digest.length - 1] & 0x0f
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) >>> 0
  return String(binary % (10 ** digits)).padStart(digits, '0')
}

export async function verifyTotpCode(
  code: unknown,
  secret: string,
  timeMs = Date.now(),
  window = 1,
): Promise<boolean> {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false
  if (!Number.isSafeInteger(window) || window < 0 || window > 2) return false
  let matched = false
  for (let offset = -window; offset <= window; offset += 1) {
    const candidateTime = timeMs + offset * TOTP_PERIOD_MS
    if (candidateTime < 0) continue
    const candidate = await generateTotpCode(secret, candidateTime)
    matched = constantTimeEqual(candidate, code) || matched
  }
  return matched
}

export async function encryptTotpSecret(
  env: Env,
  userId: string,
  secret: string,
  secretVersion = 1,
): Promise<EncryptedTotpSecret> {
  const key = await deriveTotpKey(requireMasterKey(env))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(totpAad(env, userId, secretVersion)) },
    key,
    encoder.encode(secret),
  )
  return {
    secret_version: secretVersion,
    nonce_b64: toBase64(nonce),
    ciphertext_b64: toBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptTotpSecret(
  env: Env,
  userId: string,
  encrypted: EncryptedTotpSecret,
): Promise<string> {
  try {
    const key = await deriveTotpKey(requireMasterKey(env))
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(encrypted.nonce_b64),
        additionalData: encoder.encode(totpAad(env, userId, encrypted.secret_version)),
      },
      key,
      fromBase64(encrypted.ciphertext_b64),
    )
    const secret = decoder.decode(plaintext)
    decodeBase32(secret)
    return secret
  } catch (error) {
    if (error instanceof GatewayError) throw error
    console.error('failed to decrypt TOTP credential', {
      user_id: userId,
      name: error instanceof Error ? error.name : 'unknown',
    })
    throw new GatewayError(
      503,
      'TOTP_CREDENTIAL_UNAVAILABLE',
      'TOTP credential is unavailable',
      'server_error',
    )
  }
}

export async function findTotpCredential(env: Env, userId: string): Promise<TotpCredentialRow | null> {
  return env.DB.prepare(
    `SELECT user_id, secret_version, nonce_b64, ciphertext_b64, version, enabled_at_ms
       FROM user_totp_credentials WHERE user_id = ? LIMIT 1`,
  ).bind(userId).first<TotpCredentialRow>()
}

export async function verifyStoredTotpCode(
  env: Env,
  credential: TotpCredentialRow,
  code: unknown,
  now = Date.now(),
): Promise<boolean> {
  return verifyTotpCode(code, await decryptTotpSecret(env, credential.user_id, credential), now)
}

export async function createTotpLoginChallenge(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<string> {
  requireMasterKey(env)
  const token = createOpaqueTotpToken('stl')
  const tokenHash = await totpTokenDigest(token)
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO user_totp_login_challenges (
       id, user_id, token_hash, status, verification_attempts, version,
       created_at_ms, expires_at_ms, consumed_at_ms, consume_nonce, updated_at_ms
     ) VALUES (?, ?, ?, 'pending', 0, 1, ?, ?, NULL, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       id = excluded.id,
       token_hash = excluded.token_hash,
       status = 'pending',
       verification_attempts = 0,
       version = user_totp_login_challenges.version + 1,
       created_at_ms = excluded.created_at_ms,
       expires_at_ms = excluded.expires_at_ms,
       consumed_at_ms = NULL,
       consume_nonce = NULL,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(id, userId, tokenHash, now, now + TOTP_LOGIN_TTL_MS, now).run()
  return token
}

/** Atomically claims one owner-wide verification slot that survives challenge rotation. */
export async function claimTotpVerificationAttempt(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<void> {
  try {
    const result = await env.DB.prepare(
      `INSERT INTO user_totp_verification_budgets (
         user_id, window_started_at_ms, attempt_count, updated_at_ms
       ) VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         window_started_at_ms = CASE
           WHEN window_started_at_ms <= ? THEN excluded.window_started_at_ms
           ELSE window_started_at_ms END,
         attempt_count = CASE
           WHEN window_started_at_ms <= ? THEN 1 ELSE attempt_count + 1 END,
         updated_at_ms = excluded.updated_at_ms
       RETURNING attempt_count`,
    ).bind(
      userId,
      now,
      now,
      now - TOTP_ATTEMPT_WINDOW_MS,
      now - TOTP_ATTEMPT_WINDOW_MS,
    ).all<{ attempt_count: number }>()
    if (result.results.length !== 1) throw tooManyTotpAttempts()
  } catch (error) {
    if (/user_totp_verification_budgets.*CHECK|attempt_count/i.test(errorMessage(error))) {
      throw tooManyTotpAttempts()
    }
    throw error
  }
}

export async function findTotpLoginChallenge(
  env: Env,
  token: unknown,
): Promise<TotpLoginChallengeRow | null> {
  if (!isOpaqueTotpToken(token, 'stl')) return null
  return env.DB.prepare(
    `SELECT id, user_id, token_hash, status, verification_attempts, version,
            created_at_ms, expires_at_ms
       FROM user_totp_login_challenges
      WHERE token_hash = ? LIMIT 1`,
  ).bind(await totpTokenDigest(token)).first<TotpLoginChallengeRow>()
}

export function createTotpSetupToken(): string {
  return createOpaqueTotpToken('sts')
}

export function isTotpSetupToken(value: unknown): value is string {
  return isOpaqueTotpToken(value, 'sts')
}

export function isTotpLoginToken(value: unknown): value is string {
  return isOpaqueTotpToken(value, 'stl')
}

export async function totpTokenDigest(token: string): Promise<string> {
  return sha256Hex(token)
}

function createOpaqueTotpToken(prefix: 'sts' | 'stl'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `${prefix}_v1_${toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

function isOpaqueTotpToken(value: unknown, prefix: 'sts' | 'stl'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_v1_[A-Za-z0-9_-]{43}$`).test(value)
}

function requireMasterKey(env: Pick<Env, 'CREDENTIALS_MASTER_KEY'>): string {
  if (!totpFeatureAvailable(env)) {
    throw new GatewayError(
      503,
      'TOTP_NOT_CONFIGURED',
      'TOTP encryption is not configured',
      'server_error',
    )
  }
  return env.CREDENTIALS_MASTER_KEY!
}

async function deriveTotpKey(masterKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(masterKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('sub2api-totp-secret-salt-v1'),
      info: encoder.encode('user-totp-secret/aes-256-gcm'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function totpAad(env: Pick<Env, 'ENVIRONMENT'>, userId: string, secretVersion: number): string {
  return `sub2api/user-totp/v1\0${env.ENVIRONMENT}\0${userId}\0${secretVersion}`
}

function encodeBase32(value: Uint8Array): string {
  let bits = 0
  let accumulator = 0
  let encoded = ''
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31]
  return encoded
}

function decodeBase32(value: string): Uint8Array {
  const normalized = value.trim().toUpperCase().replace(/=+$/g, '')
  if (normalized.length < 16 || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new TypeError('TOTP secret is not valid Base32')
  }
  let bits = 0
  let accumulator = 0
  const decoded: number[] = []
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character)
    bits += 5
    if (bits >= 8) {
      decoded.push((accumulator >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(decoded)
}

function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < size; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function toBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const result = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index)
  return result.buffer
}

function tooManyTotpAttempts(): GatewayError {
  return new GatewayError(429, 'TOTP_TOO_MANY_ATTEMPTS', 'Too many verification attempts')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
