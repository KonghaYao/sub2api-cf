const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const MAX_CLIENT_DATA_BYTES = 8 * 1024
const MAX_ATTESTATION_BYTES = 64 * 1024
const MAX_AUTHENTICATOR_DATA_BYTES = 8 * 1024
const MAX_CREDENTIAL_ID_BYTES = 1_024
const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_BACKUP_ELIGIBLE = 0x08
const FLAG_BACKUP_STATE = 0x10
const FLAG_ATTESTED_CREDENTIAL = 0x40
const FLAG_EXTENSION_DATA = 0x80

export interface RegistrationExpectation {
  challenge: string
  rpId: string
  origins: string[]
}

export interface RegistrationVerification {
  credentialId: string
  publicKeyJwk: JsonWebKey
  algorithm: -7
  signCount: number
  backupEligible: boolean
  backupState: boolean
  transports: string[]
}

export interface AuthenticationExpectation extends RegistrationExpectation {
  credentialId: string
  userHandle: string
  publicKeyJwk: JsonWebKey
  algorithm: -7
}

export interface AuthenticationVerification {
  credentialId: string
  signCount: number
  backupEligible: boolean
  backupState: boolean
}

export class WebAuthnVerificationError extends Error {
  constructor() {
    super('Passkey verification failed')
    this.name = 'WebAuthnVerificationError'
  }
}

export async function verifyRegistrationCredential(
  credential: unknown,
  expectation: RegistrationExpectation,
): Promise<RegistrationVerification> {
  try {
    const value = objectValue(credential)
    const rawId = canonicalBase64Url(value.rawId, 1, MAX_CREDENTIAL_ID_BYTES)
    if (value.type !== 'public-key' || value.id !== rawId.canonical) fail()
    const response = objectValue(value.response)
    const clientData = canonicalBase64Url(response.clientDataJSON, 1, MAX_CLIENT_DATA_BYTES).bytes
    await verifyClientData(clientData, 'webauthn.create', expectation)

    const attestationBytes = canonicalBase64Url(
      response.attestationObject,
      1,
      MAX_ATTESTATION_BYTES,
    ).bytes
    const decoded = decodeCbor(attestationBytes)
    const attestation = mapValue(decoded)
    if (attestation.get('fmt') !== 'none') fail()
    if (mapValue(attestation.get('attStmt')).size !== 0) fail()
    const clientExtensions = objectValue(value.clientExtensionResults)
    const credentialProperties = objectValue(clientExtensions.credProps)
    if (credentialProperties.rk !== true) fail()
    const authenticatorData = byteValue(attestation.get('authData'))
    const parsed = await parseAuthenticatorData(authenticatorData, expectation.rpId, true)
    if (parsed.credentialId === undefined || parsed.coseKey === undefined) fail()
    if (!equalBytes(parsed.credentialId, rawId.bytes)) fail()
    const cose = mapValue(parsed.coseKey)
    if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) fail()
    const x = byteValue(cose.get(-2))
    const y = byteValue(cose.get(-3))
    if (x.byteLength !== 32 || y.byteLength !== 32) fail()
    const publicKeyJwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(x),
      y: toBase64Url(y),
      ext: true,
      key_ops: ['verify'],
    }
    // Importing here rejects points that are not on P-256 before persistence.
    await crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return {
      credentialId: rawId.canonical,
      publicKeyJwk,
      algorithm: -7,
      signCount: parsed.signCount,
      backupEligible: parsed.backupEligible,
      backupState: parsed.backupState,
      transports: transports(response.transports),
    }
  } catch (error) {
    if (error instanceof WebAuthnVerificationError) throw error
    throw new WebAuthnVerificationError()
  }
}

export async function verifyAuthenticationCredential(
  credential: unknown,
  expectation: AuthenticationExpectation,
): Promise<AuthenticationVerification> {
  try {
    const value = objectValue(credential)
    const rawId = canonicalBase64Url(value.rawId, 1, MAX_CREDENTIAL_ID_BYTES)
    if (
      value.type !== 'public-key' || value.id !== rawId.canonical ||
      rawId.canonical !== expectation.credentialId || expectation.algorithm !== -7
    ) fail()
    const response = objectValue(value.response)
    const userHandle = canonicalBase64Url(response.userHandle, 32, 32).canonical
    if (userHandle !== expectation.userHandle) fail()
    const clientData = canonicalBase64Url(response.clientDataJSON, 1, MAX_CLIENT_DATA_BYTES).bytes
    await verifyClientData(clientData, 'webauthn.get', expectation)
    const authenticatorData = canonicalBase64Url(
      response.authenticatorData,
      37,
      MAX_AUTHENTICATOR_DATA_BYTES,
    ).bytes
    const parsed = await parseAuthenticatorData(authenticatorData, expectation.rpId, false)
    const signature = canonicalBase64Url(response.signature, 8, 512).bytes
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBuffer(clientData)))
    const signed = concat(authenticatorData, clientHash)
    const key = await crypto.subtle.importKey(
      'jwk',
      expectation.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      ownedBuffer(derEcdsaToRaw(signature, 32)),
      ownedBuffer(signed),
    )
    if (!valid) fail()
    return {
      credentialId: rawId.canonical,
      signCount: parsed.signCount,
      backupEligible: parsed.backupEligible,
      backupState: parsed.backupState,
    }
  } catch (error) {
    if (error instanceof WebAuthnVerificationError) throw error
    throw new WebAuthnVerificationError()
  }
}

interface ParsedAuthenticatorData {
  signCount: number
  backupEligible: boolean
  backupState: boolean
  credentialId?: Uint8Array
  coseKey?: unknown
}

async function verifyClientData(
  bytes: Uint8Array,
  expectedType: 'webauthn.create' | 'webauthn.get',
  expectation: RegistrationExpectation,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  } catch {
    fail()
  }
  const client = objectValue(parsed)
  if (
    client.type !== expectedType || client.challenge !== expectation.challenge ||
    (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
    client.topOrigin !== undefined || typeof client.origin !== 'string'
  ) fail()
  let origin: string
  try {
    const url = new URL(client.origin)
    if (url.origin !== client.origin) fail()
    origin = url.origin
  } catch {
    fail()
  }
  if (!expectation.origins.includes(origin!)) fail()
}

async function parseAuthenticatorData(
  bytes: Uint8Array,
  rpId: string,
  requireAttestedCredential: boolean,
): Promise<ParsedAuthenticatorData> {
  if (bytes.byteLength < 37) fail()
  const expectedRpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId)))
  if (!equalBytes(bytes.slice(0, 32), expectedRpHash)) fail()
  const flags = bytes[32]
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) fail()
  const backupEligible = (flags & FLAG_BACKUP_ELIGIBLE) !== 0
  const backupState = (flags & FLAG_BACKUP_STATE) !== 0
  if (backupState && !backupEligible) fail()
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0)
  const hasAttestedCredential = (flags & FLAG_ATTESTED_CREDENTIAL) !== 0
  if (requireAttestedCredential !== hasAttestedCredential) fail()
  let offset = 37
  let credentialId: Uint8Array | undefined
  let coseKey: unknown
  if (hasAttestedCredential) {
    if (bytes.byteLength < offset + 18) fail()
    offset += 16
    const credentialLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0)
    offset += 2
    if (credentialLength < 1 || credentialLength > MAX_CREDENTIAL_ID_BYTES) fail()
    if (bytes.byteLength < offset + credentialLength) fail()
    credentialId = bytes.slice(offset, offset + credentialLength)
    offset += credentialLength
    const decoded = decodeCborAt(bytes, offset)
    coseKey = decoded.value
    offset = decoded.offset
  }
  if ((flags & FLAG_EXTENSION_DATA) !== 0) {
    offset = decodeCborAt(bytes, offset).offset
  }
  if (offset !== bytes.byteLength) fail()
  return { signCount, backupEligible, backupState, credentialId, coseKey }
}

function transports(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) fail()
  const allowed = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card'])
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) fail()
    if (!result.includes(item)) result.push(item)
  }
  return result
}

function canonicalBase64Url(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): { canonical: string; bytes: Uint8Array } {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail()
  let binary: string
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    binary = atob(`${base64}${'='.repeat((4 - value.length % 4) % 4)}`)
  } catch {
    fail()
  }
  if (binary!.length < minimumBytes || binary!.length > maximumBytes) fail()
  const bytes = Uint8Array.from(binary!, (character) => character.charCodeAt(0))
  const canonical = toBase64Url(bytes)
  if (canonical !== value) fail()
  return { canonical, bytes }
}

function toBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}

function byteValue(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) fail()
  return value
}

function mapValue(value: unknown): Map<unknown, unknown> {
  if (!(value instanceof Map)) fail()
  return value
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength)
  let difference = left.byteLength ^ right.byteLength
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function derEcdsaToRaw(der: Uint8Array, componentBytes: number): Uint8Array {
  let offset = 0
  if (der[offset++] !== 0x30) fail()
  const sequenceLength = derLength(der, offset)
  offset = sequenceLength.offset
  if (sequenceLength.length !== der.byteLength - offset) fail()
  const r = derInteger(der, offset, componentBytes)
  offset = r.offset
  const s = derInteger(der, offset, componentBytes)
  if (s.offset !== der.byteLength) fail()
  return concat(r.value, s.value)
}

function derInteger(
  der: Uint8Array,
  offset: number,
  componentBytes: number,
): { value: Uint8Array; offset: number } {
  if (der[offset++] !== 0x02) fail()
  const encodedLength = derLength(der, offset)
  offset = encodedLength.offset
  const end = offset + encodedLength.length
  if (encodedLength.length < 1 || end > der.byteLength) fail()
  let value = der.slice(offset, end)
  if ((value[0] & 0x80) !== 0) fail()
  if (value[0] === 0 && value.byteLength > 1) {
    if ((value[1] & 0x80) === 0) fail()
    value = value.slice(1)
  }
  if (value.byteLength > componentBytes) fail()
  const result = new Uint8Array(componentBytes)
  result.set(value, componentBytes - value.byteLength)
  return { value: result, offset: end }
}

function derLength(bytes: Uint8Array, offset: number): { length: number; offset: number } {
  const first = bytes[offset++]
  if (first === undefined) fail()
  if ((first & 0x80) === 0) return { length: first, offset }
  const count = first & 0x7f
  if (count < 1 || count > 2 || offset + count > bytes.byteLength) fail()
  let length = 0
  for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[offset++]
  if (length < 128) fail()
  return { length, offset }
}

interface CborResult {
  value: unknown
  offset: number
}

function decodeCbor(bytes: Uint8Array): unknown {
  const result = decodeCborAt(bytes, 0)
  if (result.offset !== bytes.byteLength) fail()
  return result.value
}

function decodeCborAt(bytes: Uint8Array, start: number, depth = 0): CborResult {
  if (depth > 16 || start >= bytes.byteLength) fail()
  let offset = start
  const initial = bytes[offset++]
  const major = initial >>> 5
  const length = cborLength(bytes, offset, initial & 0x1f)
  offset = length.offset
  if (major === 0) return { value: length.value, offset }
  if (major === 1) return { value: -1 - length.value, offset }
  if (major === 2 || major === 3) {
    const end = offset + length.value
    if (end > bytes.byteLength) fail()
    const value = bytes.slice(offset, end)
    return { value: major === 2 ? value : decoder.decode(value), offset: end }
  }
  if (major === 4) {
    const result: unknown[] = []
    for (let index = 0; index < length.value; index += 1) {
      const item = decodeCborAt(bytes, offset, depth + 1)
      result.push(item.value)
      offset = item.offset
    }
    return { value: result, offset }
  }
  if (major === 5) {
    const result = new Map<unknown, unknown>()
    for (let index = 0; index < length.value; index += 1) {
      const key = decodeCborAt(bytes, offset, depth + 1)
      const item = decodeCborAt(bytes, key.offset, depth + 1)
      if (result.has(key.value)) fail()
      result.set(key.value, item.value)
      offset = item.offset
    }
    return { value: result, offset }
  }
  if (major === 6) return decodeCborAt(bytes, offset, depth + 1)
  if (major === 7 && (initial & 0x1f) === 20) return { value: false, offset }
  if (major === 7 && (initial & 0x1f) === 21) return { value: true, offset }
  if (major === 7 && (initial & 0x1f) === 22) return { value: null, offset }
  fail()
}

function cborLength(
  bytes: Uint8Array,
  offset: number,
  additional: number,
): { value: number; offset: number } {
  if (additional < 24) return { value: additional, offset }
  const count = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0
  if (count === 0 || offset + count > bytes.byteLength) fail()
  let value = 0
  for (let index = 0; index < count; index += 1) value = value * 256 + bytes[offset++]
  if (!Number.isSafeInteger(value)) fail()
  return { value, offset }
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(value.byteLength)
  result.set(value)
  return result.buffer
}

function fail(): never {
  throw new WebAuthnVerificationError()
}
