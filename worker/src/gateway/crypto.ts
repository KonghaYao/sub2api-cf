import { GatewayError } from './errors'
import type { UpstreamCredential } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function apiKeyDigest(rawKey: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(rawKey)))
}

export async function encryptCredential(
  credential: UpstreamCredential,
  masterKey: string,
  aad: string,
): Promise<{ nonce_b64: string; ciphertext_b64: string }> {
  const key = await deriveEncryptionKey(masterKey)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = encoder.encode(JSON.stringify(credential))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(aad) },
    key,
    plaintext,
  )
  return { nonce_b64: toBase64(nonce), ciphertext_b64: toBase64(new Uint8Array(ciphertext)) }
}

export async function decryptCredential(
  nonceB64: string,
  ciphertextB64: string,
  masterKey: string,
  aad: string,
): Promise<UpstreamCredential> {
  try {
    const key = await deriveEncryptionKey(masterKey)
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(nonceB64),
        additionalData: encoder.encode(aad),
      },
      key,
      fromBase64(ciphertextB64),
    )
    const parsed: unknown = JSON.parse(decoder.decode(plaintext))
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { api_key?: unknown }).api_key !== 'string' ||
      (parsed as { api_key: string }).api_key.length === 0
    ) {
      throw new Error('credential payload is invalid')
    }
    return parsed as UpstreamCredential
  } catch (error) {
    console.error('failed to decrypt upstream credential', {
      name: error instanceof Error ? error.name : 'unknown',
    })
    throw new GatewayError(
      503,
      'credential_unavailable',
      'Upstream account credential is unavailable',
      'server_error',
    )
  }
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes))
  return toBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < size; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

async function deriveEncryptionKey(masterKey: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(masterKey),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('sub2api-credential-salt-v1'),
      info: encoder.encode('account-upstream-auth/aes-256-gcm'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}
