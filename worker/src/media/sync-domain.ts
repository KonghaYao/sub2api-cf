import { GatewayError } from '../gateway/errors'

export const SYNC_IMAGE_MAX_JSON_BYTES = 2 * 1024 * 1024
export const SYNC_IMAGE_MAX_PROMPT_CHARS = 32_000
export const SYNC_IMAGE_MAX_MODEL_CHARS = 200
export const SYNC_IMAGE_MAX_INPUT_IMAGES = 16
export const SYNC_IMAGE_MAX_PART_BYTES = 20 * 1024 * 1024
export const SYNC_IMAGE_MAX_MULTIPART_BYTES = 32 * 1024 * 1024

export type SyncImageOperation = 'generations' | 'edits'

export interface SyncImageOptions {
  size?: string
  quality?: string
  style?: string
  background?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  response_format?: string
  input_fidelity?: string
  stream?: boolean
  partial_images?: number
  user?: string
}

export interface SyncImageUrlInput {
  kind: 'url'
  image_url: string
}

export interface SyncImageByteInput {
  kind: 'bytes'
  filename: string
  mime_type: SyncImageMimeType
  bytes: Uint8Array
}

export type SyncImageInput = SyncImageUrlInput | SyncImageByteInput
export type SyncImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface SyncImageManifest {
  operation: SyncImageOperation
  model: string
  prompt: string
  n: number
  options: SyncImageOptions
  input_images: SyncImageInput[]
  mask: SyncImageInput | null
}

export interface SyncImageMultipartPart {
  filename: string
  mime_type: string
  bytes: Uint8Array | ArrayBuffer
}

export interface SyncImageMultipartEditInput {
  fields: Record<string, unknown>
  images: readonly SyncImageMultipartPart[]
  mask?: SyncImageMultipartPart | null
}

export function parseSyncImageGeneration(value: unknown): SyncImageManifest {
  const body = requestObject(value)
  rejectUnknownFields(body, GENERATION_FIELDS)
  return {
    operation: 'generations',
    model: model(body.model),
    prompt: prompt(body.prompt),
    n: outputCount(body.n),
    options: parseOptions(body),
    input_images: [],
    mask: null,
  }
}

export function parseSyncImageEditJson(value: unknown): SyncImageManifest {
  const body = requestObject(value)
  rejectUnknownFields(body, EDIT_JSON_FIELDS)
  if (!Array.isArray(body.images) || body.images.length === 0 || body.images.length > SYNC_IMAGE_MAX_INPUT_IMAGES) {
    fail(400, 'IMAGE_INVALID_IMAGES', `images must contain 1-${SYNC_IMAGE_MAX_INPUT_IMAGES} image_url entries`)
  }
  const inputImages = body.images.map((value, index) => jsonImageInput(value, `images[${index}]`))
  const mask = body.mask === undefined || body.mask === null ? null : jsonImageInput(body.mask, 'mask')
  return {
    operation: 'edits',
    model: model(body.model),
    prompt: prompt(body.prompt),
    n: outputCount(body.n),
    options: parseOptions(body),
    input_images: inputImages,
    mask,
  }
}

export function parseSyncImageEditMultipart(value: unknown): SyncImageManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'IMAGE_INVALID_REQUEST', 'Multipart edit input must be an object')
  }
  const input = value as Record<string, unknown>
  rejectUnknownFields(input, new Set(['fields', 'images', 'mask']))
  const fields = multipartFields(input.fields)
  rejectUnknownFields(fields, MULTIPART_FIELDS)
  const normalized = normalizeMultipartFieldValues(fields)

  if (!Array.isArray(input.images) || input.images.length === 0 || input.images.length > SYNC_IMAGE_MAX_INPUT_IMAGES) {
    fail(400, 'IMAGE_INVALID_IMAGES', `images must contain 1-${SYNC_IMAGE_MAX_INPUT_IMAGES} byte parts`)
  }
  const inputImages = input.images.map((part, index) => multipartPart(part, `images[${index}]`))
  const mask = input.mask === undefined || input.mask === null ? null : multipartPart(input.mask, 'mask')
  const totalBytes = inputImages.reduce((sum, part) => sum + part.bytes.byteLength, mask?.bytes.byteLength ?? 0) +
    new TextEncoder().encode(JSON.stringify(fields)).byteLength
  if (totalBytes > SYNC_IMAGE_MAX_MULTIPART_BYTES) {
    fail(413, 'IMAGE_UPLOAD_TOO_LARGE', 'Multipart image request exceeds the 32 MiB limit')
  }

  return {
    operation: 'edits',
    model: model(normalized.model),
    prompt: prompt(normalized.prompt),
    n: outputCount(normalized.n),
    options: parseOptions(normalized),
    input_images: inputImages,
    mask,
  }
}

const OPTION_FIELDS = [
  'size', 'quality', 'style', 'background', 'output_format', 'output_compression',
  'moderation', 'response_format', 'input_fidelity', 'stream', 'partial_images', 'user',
] as const

const GENERATION_FIELDS = new Set<string>(['model', 'prompt', 'n', ...OPTION_FIELDS])
const EDIT_JSON_FIELDS = new Set<string>(['model', 'prompt', 'n', 'images', 'mask', ...OPTION_FIELDS])
const MULTIPART_FIELDS = new Set<string>(['model', 'prompt', 'n', ...OPTION_FIELDS])

function multipartFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'IMAGE_INVALID_REQUEST', 'fields must be an object')
  }
  assertJsonSize(value)
  return value as Record<string, unknown>
}

function normalizeMultipartFieldValues(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(fields)) {
    if (typeof raw !== 'string') fail(400, 'IMAGE_INVALID_OPTION', `Multipart field ${key} must be a string`)
    if (key === 'n' || key === 'output_compression' || key === 'partial_images') {
      if (!/^(0|[1-9]\d*)$/.test(raw)) fail(400, key === 'n' ? 'IMAGE_INVALID_N' : 'IMAGE_INVALID_OPTION', `${key} must be an integer`)
      result[key] = Number(raw)
    } else if (key === 'stream') {
      const normalized = raw.toLowerCase()
      if (normalized !== 'true' && normalized !== 'false') {
        fail(400, 'IMAGE_INVALID_OPTION', 'stream must be true or false')
      }
      result[key] = normalized === 'true'
    } else {
      result[key] = raw
    }
  }
  return result
}

function multipartPart(value: unknown, field: string): SyncImageByteInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'IMAGE_INVALID_IMAGES', `${field} must be an image byte part`)
  }
  const part = value as Record<string, unknown>
  rejectUnknownFields(part, new Set(['filename', 'mime_type', 'bytes']))
  const filename = boundedString(part.filename, `${field}.filename`, 255, 'IMAGE_INVALID_IMAGES')
  if (filename === '.' || filename === '..' || /[/\\]/.test(filename)) {
    fail(400, 'IMAGE_INVALID_IMAGES', `${field}.filename is unsafe`)
  }
  if (!isSyncImageMime(part.mime_type)) {
    fail(400, 'IMAGE_UNSUPPORTED_MIME', `${field}.mime_type must be image/png, image/jpeg, or image/webp`)
  }
  const source = part.bytes
  const bytes = source instanceof Uint8Array
    ? source.slice()
    : source instanceof ArrayBuffer
      ? new Uint8Array(source.slice(0))
      : null
  if (bytes === null || bytes.byteLength === 0) {
    fail(400, 'IMAGE_INVALID_IMAGES', `${field}.bytes must contain image data`)
  }
  if (bytes.byteLength > SYNC_IMAGE_MAX_PART_BYTES) {
    fail(413, 'IMAGE_UPLOAD_TOO_LARGE', `${field}.bytes exceeds the 20 MiB per-image limit`)
  }
  if (!matchesImageSignature(part.mime_type, bytes)) {
    fail(400, 'IMAGE_INVALID_IMAGE_SIGNATURE', `${field}.bytes does not match its declared image MIME type`)
  }
  return { kind: 'bytes', filename, mime_type: part.mime_type, bytes }
}

function isSyncImageMime(value: unknown): value is SyncImageMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'
}

function matchesImageSignature(mimeType: SyncImageMimeType, bytes: Uint8Array): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value)
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
}

function jsonImageInput(value: unknown, field: string): SyncImageUrlInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'IMAGE_INVALID_IMAGES', `${field} must be an object`)
  }
  const item = value as Record<string, unknown>
  rejectUnknownFields(item, new Set(['image_url']))
  const imageUrl = boundedString(item.image_url, `${field}.image_url`, 8_192, 'IMAGE_INVALID_IMAGE_URL')
  validateImageUrl(imageUrl, field)
  return { kind: 'url', image_url: imageUrl }
}

function validateImageUrl(value: string, field: string): void {
  if (value.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
    if (match === null || match[2].length % 4 !== 0) {
      fail(400, 'IMAGE_INVALID_IMAGE_URL', `${field}.image_url must be a supported base64 image data URI`)
    }
    const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0
    const byteLength = match[2].length / 4 * 3 - padding
    if (byteLength < 1 || byteLength > SYNC_IMAGE_MAX_PART_BYTES) {
      fail(413, 'IMAGE_UPLOAD_TOO_LARGE', `${field}.image_url exceeds the per-image limit`)
    }
    return
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(400, 'IMAGE_INVALID_IMAGE_URL', `${field}.image_url must be an absolute HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) {
    fail(400, 'IMAGE_INVALID_IMAGE_URL', `${field}.image_url must be an uncredentialed HTTPS URL`)
  }
  if (isPrivateHostname(url.hostname)) {
    fail(400, 'IMAGE_INVALID_IMAGE_URL', `${field}.image_url cannot target a private network`)
  }
}

function isPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') ||
    hostname === '::' || hostname === '::1' ||
    hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe8') || hostname.startsWith('fe9') ||
    hostname.startsWith('fea') || hostname.startsWith('feb')
  ) return true

  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = octets
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
}

function requestObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'IMAGE_INVALID_REQUEST', 'Request body must be a JSON object')
  }
  assertJsonSize(value)
  return value as Record<string, unknown>
}

function assertJsonSize(value: unknown): void {
  let encoded: Uint8Array
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) fail(400, 'IMAGE_INVALID_REQUEST', 'Request body is not JSON serializable')
    encoded = new TextEncoder().encode(serialized)
  } catch (error) {
    if (error instanceof GatewayError) throw error
    fail(400, 'IMAGE_INVALID_REQUEST', 'Request body is not JSON serializable')
  }
  if (encoded.byteLength > SYNC_IMAGE_MAX_JSON_BYTES) {
    fail(413, 'IMAGE_REQUEST_TOO_LARGE', 'Image request exceeds the 2 MiB JSON limit')
  }
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(body).find((key) => !allowed.has(key))
  if (unknown !== undefined) {
    fail(400, 'IMAGE_UNSUPPORTED_FIELD', `Request contains unsupported field: ${unknown}`)
  }
}

function model(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'gpt-image-2'
  return boundedString(value, 'model', SYNC_IMAGE_MAX_MODEL_CHARS, 'IMAGE_INVALID_MODEL')
}

function prompt(value: unknown): string {
  return boundedString(value, 'prompt', SYNC_IMAGE_MAX_PROMPT_CHARS, 'IMAGE_INVALID_PROMPT')
}

function outputCount(value: unknown): number {
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10) {
    fail(400, 'IMAGE_INVALID_N', 'n must be an integer between 1 and 10')
  }
  return value as number
}

function parseOptions(body: Record<string, unknown>): SyncImageOptions {
  const options: SyncImageOptions = {}
  // Provider-specific sizes are forwarded. Billing recognizes known WxH/tier
  // values and conservatively falls back to 2K for unknown strings.
  assignStringOption(options, body, 'size', 64, () => true)
  assignEnumOption(options, body, 'quality', ['auto', 'low', 'medium', 'high', 'standard', 'hd'])
  assignEnumOption(options, body, 'style', ['vivid', 'natural'])
  assignEnumOption(options, body, 'background', ['auto', 'transparent', 'opaque'])
  assignEnumOption(options, body, 'output_format', ['png', 'jpeg', 'webp'])
  assignIntegerOption(options, body, 'output_compression', 0, 100)
  assignEnumOption(options, body, 'moderation', ['auto', 'low'])
  assignEnumOption(options, body, 'response_format', ['url', 'b64_json'])
  assignEnumOption(options, body, 'input_fidelity', ['low', 'high'])
  assignBooleanOption(options, body, 'stream')
  assignIntegerOption(options, body, 'partial_images', 0, 3)
  assignStringOption(options, body, 'user', 512, () => true, false)
  return options
}

function assignEnumOption<K extends keyof SyncImageOptions>(
  target: SyncImageOptions,
  source: Record<string, unknown>,
  key: K,
  allowed: readonly string[],
): void {
  assignStringOption(target, source, key, 64, (value) => allowed.includes(value))
}

function assignStringOption<K extends keyof SyncImageOptions>(
  target: SyncImageOptions,
  source: Record<string, unknown>,
  key: K,
  maximum: number,
  valid: (value: string) => boolean,
  lowercase = true,
): void {
  if (source[key] === undefined) return
  const rawValue = boundedString(source[key], String(key), maximum, 'IMAGE_INVALID_OPTION')
  const value = lowercase ? rawValue.toLowerCase() : rawValue
  if (!valid(value) || hasUnsafeControlCharacter(value)) {
    fail(400, 'IMAGE_INVALID_OPTION', `${String(key)} is not supported`)
  }
  Object.assign(target, { [key]: value })
}

function assignIntegerOption<K extends keyof SyncImageOptions>(
  target: SyncImageOptions,
  source: Record<string, unknown>,
  key: K,
  minimum: number,
  maximum: number,
): void {
  const value = source[key]
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(400, 'IMAGE_INVALID_OPTION', `${String(key)} must be an integer between ${minimum} and ${maximum}`)
  }
  Object.assign(target, { [key]: value })
}

function assignBooleanOption<K extends keyof SyncImageOptions>(
  target: SyncImageOptions,
  source: Record<string, unknown>,
  key: K,
): void {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'boolean') fail(400, 'IMAGE_INVALID_OPTION', `${String(key)} must be a boolean`)
  Object.assign(target, { [key]: value })
}

function boundedString(value: unknown, field: string, maximum: number, code: string): string {
  if (typeof value !== 'string') fail(400, code, `${field} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0 || Array.from(normalized).length > maximum || hasUnsafeControlCharacter(normalized)) {
    fail(400, code, `${field} must contain 1-${maximum} safe characters`)
  }
  return normalized
}

function hasUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
}

function fail(status: number, code: string, message: string): never {
  throw new GatewayError(status, code, message)
}
