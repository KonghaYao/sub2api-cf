import { sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'
import type {
  MediaManifest,
  MediaReferenceImage,
  MediaSubmitItem,
  MediaTaskItemRow,
  MediaTaskRow,
} from './types'

const MAX_ITEMS = 200
const MAX_OUTPUTS = 200
const MAX_PROMPT_CHARS = 8_000
const MAX_REFERENCE_IMAGES = 1_000
const MAX_INLINE_REFERENCE_BYTES = 24 * 1024 * 1024

export interface MediaPricing {
  upstreamModel: string
  priceId: string
  baseUnitPriceMicros: number
  effectiveRateMultiplierPpm: number
  batchDiscountMultiplierPpm: number
  holdMultiplierPpm: number
  billableUnitPriceMicros: number
  holdUnitPriceMicros: number
  estimatedCostMicros: number
  holdAmountMicros: number
}

export async function parseMediaSubmit(
  value: unknown,
  upstreamModel: string,
  now = Date.now(),
): Promise<{ manifest: MediaManifest; expectedOutputCount: number }> {
  const body = object(value, 'Request body')
  const allowed = new Set([
    'model', 'task_name', 'parent_batch_id', 'provider', 'image_size',
    'response_mime_type', 'aspect_ratio', 'items', 'metadata', 'api_key_id',
  ])
  rejectUnknown(body, allowed, 'request')
  const model = requiredString(body.model, 'model', 200)
  const provider = body.provider === undefined || body.provider === '' ? 'gemini_api' : body.provider
  if (provider !== 'gemini_api') {
    throw new GatewayError(400, 'BATCH_IMAGE_UNSUPPORTED_PROVIDER', 'Only gemini_api is supported')
  }
  const imageSize = body.image_size === undefined ? '1K' : body.image_size
  if (!['1K', '2K', '4K'].includes(String(imageSize))) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_IMAGE_SIZE', 'image_size must be 1K, 2K, or 4K')
  }
  const responseMimeType = body.response_mime_type === undefined
    ? 'image/png'
    : body.response_mime_type
  if (!isImageMime(responseMimeType)) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_MIME_TYPE', 'response_mime_type is not supported')
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_ITEMS', `items must contain 1-${MAX_ITEMS} entries`)
  }
  const customIds = new Set<string>()
  const expandedCustomIds = new Set<string>()
  let referenceCount = 0
  let inlineBytes = 0
  let expectedOutputCount = 0
  const items: MediaSubmitItem[] = []
  const maxReferencesPerItem = /(?:^|[-_.])pro(?:[-_.]|$)/i.test(upstreamModel) ? 14 : 3
  for (const [index, raw] of body.items.entries()) {
    const item = object(raw, `items[${index}]`)
    rejectUnknown(item, new Set(['custom_id', 'prompt', 'output_count', 'reference_images']), `items[${index}]`)
    const customId = item.custom_id === undefined || item.custom_id === null || item.custom_id === ''
      ? `item_${String(index + 1).padStart(6, '0')}`
      : requiredString(item.custom_id, `items[${index}].custom_id`, 255)
    if (customIds.has(customId)) {
      throw new GatewayError(400, 'BATCH_IMAGE_DUPLICATE_CUSTOM_ID', `Duplicate custom_id: ${customId}`)
    }
    customIds.add(customId)
    const prompt = requiredString(item.prompt, `items[${index}].prompt`, MAX_PROMPT_CHARS)
    const outputCount = item.output_count === undefined ? 1 : safeInteger(item.output_count, `items[${index}].output_count`)
    if (outputCount < 1 || outputCount > 4) {
      throw new GatewayError(400, 'BATCH_IMAGE_INVALID_OUTPUT_COUNT', 'output_count must be between 1 and 4')
    }
    expectedOutputCount += outputCount
    const rawReferences = item.reference_images === undefined ? [] : item.reference_images
    if (!Array.isArray(rawReferences) || rawReferences.length > maxReferencesPerItem) {
      throw new GatewayError(
        400,
        'BATCH_IMAGE_INVALID_REFERENCE_IMAGES',
        `reference_images must contain at most ${maxReferencesPerItem} entries for this model`,
      )
    }
    const referenceImages: MediaReferenceImage[] = rawReferences.map((rawReference, referenceIndex) => {
      const reference = object(rawReference, `items[${index}].reference_images[${referenceIndex}]`)
      rejectUnknown(reference, new Set(['id', 'type', 'mime_type', 'data', 'file_uri']), 'reference image')
      if (!isImageMime(reference.mime_type)) {
        throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REFERENCE_MIME', 'Reference image mime_type is not supported')
      }
      const data = optionalString(reference.data, 'reference image data', 32 * 1024 * 1024)
      const fileUri = optionalString(reference.file_uri, 'reference image file_uri', 1_024)
      if (fileUri !== undefined) {
        throw new GatewayError(
          400,
          'BATCH_IMAGE_REFERENCE_URI_UNSUPPORTED',
          'Gemini API Worker tasks support inline reference data only',
        )
      }
      if (data === undefined) {
        throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REFERENCE', 'Reference image data is required')
      }
      if (data !== undefined) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
          throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REFERENCE_DATA', 'Reference image data must be base64')
        }
        inlineBytes += Math.floor(data.length * 3 / 4)
      }
      return {
        ...(optionalString(reference.id, 'reference image id', 128) === undefined
          ? {} : { id: String(reference.id) }),
        ...(optionalString(reference.type, 'reference image type', 64) === undefined
          ? {} : { type: String(reference.type) }),
        mime_type: reference.mime_type,
        ...(data === undefined ? {} : { data }),
      }
    })
    referenceCount += referenceImages.length * outputCount
    for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
      const expandedId = outputCount === 1
        ? customId
        : `${customId}_${String(outputIndex + 1).padStart(2, '0')}`
      if (expandedId.length > 255 || expandedCustomIds.has(expandedId)) {
        throw new GatewayError(
          400,
          'BATCH_IMAGE_DUPLICATE_CUSTOM_ID',
          `Expanded custom_id is invalid or duplicated: ${expandedId}`,
        )
      }
      expandedCustomIds.add(expandedId)
      items.push({
        custom_id: expandedId,
        prompt,
        output_count: 1,
        reference_images: referenceImages,
      })
    }
  }
  if (expectedOutputCount > MAX_OUTPUTS) {
    throw new GatewayError(400, 'BATCH_IMAGE_TOO_MANY_OUTPUTS', `A batch can generate at most ${MAX_OUTPUTS} images`)
  }
  if (referenceCount > MAX_REFERENCE_IMAGES || inlineBytes > MAX_INLINE_REFERENCE_BYTES) {
    throw new GatewayError(413, 'BATCH_IMAGE_REFERENCES_TOO_LARGE', 'Reference images exceed the batch limit')
  }
  const metadata = stringRecord(body.metadata, 'metadata', 32, 64, 512)
  return {
    expectedOutputCount,
    manifest: {
      model,
      upstream_model: upstreamModel,
      task_name: optionalString(body.task_name, 'task_name', 255) ?? new Date(now).toISOString(),
      parent_batch_id: optionalString(body.parent_batch_id, 'parent_batch_id', 64) ?? null,
      provider,
      image_size: imageSize as MediaManifest['image_size'],
      response_mime_type: responseMimeType,
      aspect_ratio: optionalString(body.aspect_ratio, 'aspect_ratio', 32) ?? null,
      metadata,
      items,
    },
  }
}

export function calculateMediaPricing(
  baseUnitPriceMicros: number,
  effectiveRateMultiplierPpm: number,
  batchDiscountMultiplierPpm: number,
  holdMultiplierPpm: number,
  expectedOutputCount: number,
  priceId: string,
  upstreamModel: string,
): MediaPricing {
  const rated = multiplyPpm(baseUnitPriceMicros, effectiveRateMultiplierPpm)
  const billableUnitPriceMicros = multiplyPpm(rated, batchDiscountMultiplierPpm)
  const holdUnitPriceMicros = multiplyPpm(rated, holdMultiplierPpm)
  const estimatedCostMicros = safeProduct(billableUnitPriceMicros, expectedOutputCount)
  const holdAmountMicros = safeProduct(holdUnitPriceMicros, expectedOutputCount)
  if (holdAmountMicros < estimatedCostMicros) {
    throw new GatewayError(500, 'BATCH_IMAGE_INVALID_PRICING', 'Batch image hold is below its estimate', 'server_error')
  }
  return {
    upstreamModel,
    priceId,
    baseUnitPriceMicros,
    effectiveRateMultiplierPpm,
    batchDiscountMultiplierPpm,
    holdMultiplierPpm,
    billableUnitPriceMicros,
    holdUnitPriceMicros,
    estimatedCostMicros,
    holdAmountMicros,
  }
}

export function publicMediaTask(row: MediaTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'image.batch',
    task_name: row.task_name,
    parent_batch_id: row.parent_task_id,
    status: row.status === 'created' ? 'queued' : row.status,
    model: row.model,
    provider: row.provider,
    item_count: row.item_count,
    success_count: row.success_count,
    fail_count: row.fail_count,
    estimated_cost: microsToDollars(row.estimated_cost_micros),
    hold_amount: microsToDollars(row.hold_amount_micros),
    actual_cost: row.actual_cost_micros === null ? null : microsToDollars(row.actual_cost_micros),
    created_at: Math.floor(row.created_at_ms / 1_000),
    submitted_at: seconds(row.submitted_at_ms),
    settled_at: seconds(row.settled_at_ms),
    downloaded_at: seconds(row.downloaded_at_ms),
    output_deleted_at: seconds(row.output_deleted_at_ms),
    error: row.last_error_code === null ? null : {
      code: row.last_error_code,
      message: row.last_error_message ?? 'Batch image processing failed',
      source: 'system',
    },
  }
}

export function publicMediaItem(row: MediaTaskItemRow): Record<string, unknown> {
  return {
    batch_id: row.task_id,
    custom_id: row.custom_id,
    status: row.status,
    prompt_preview: row.prompt_preview,
    mime_type: row.mime_type,
    file_extension: row.file_extension,
    image_count: row.image_count,
    error: row.error_code === null ? null : {
      code: row.error_code,
      message: row.error_message ?? 'Image generation failed',
      source: 'provider',
    },
  }
}

export function mediaTaskId(): string {
  return `imgbatch_${crypto.randomUUID().replaceAll('-', '')}`
}

export function mediaObjectPrefix(environment: string, taskId: string): string {
  const safeEnvironment = environment.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default'
  return `media/${safeEnvironment}/${taskId}`
}

export async function mediaRequestHash(value: unknown): Promise<string> {
  return sha256Hex(stableJson(value))
}

export function fileExtension(mimeType: string): 'png' | 'jpg' | 'webp' {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  throw new GatewayError(502, 'BATCH_IMAGE_INVALID_PROVIDER_MIME', 'Provider returned an unsupported image type', 'server_error')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function multiplyPpm(value: number, ppm: number): number {
  const result = (BigInt(value) * BigInt(ppm) + 500_000n) / 1_000_000n
  const number = Number(result)
  if (!Number.isSafeInteger(number)) throw pricingOverflow()
  return number
}

function safeProduct(left: number, right: number): number {
  const result = left * right
  if (!Number.isSafeInteger(result)) throw pricingOverflow()
  return result
}

function pricingOverflow(): GatewayError {
  return new GatewayError(500, 'BATCH_IMAGE_PRICING_OVERFLOW', 'Batch image price is too large', 'server_error')
}

function microsToDollars(value: number): number {
  return value / 1_000_000
}

function seconds(value: number | null): number | null {
  return value === null ? null : Math.floor(value / 1_000)
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REQUEST', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REQUEST', `${field} must be a non-empty string of at most ${maxLength} characters`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REQUEST', `${field} must be a string of at most ${maxLength} characters`)
  }
  return value
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REQUEST', `${field} must be an integer`)
  }
  return value as number
}

function isImageMime(value: unknown): value is MediaManifest['response_mime_type'] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown !== undefined) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_REQUEST', `${field} contains unsupported field: ${unknown}`)
  }
}

function stringRecord(
  value: unknown,
  field: string,
  maxEntries: number,
  maxKeyLength: number,
  maxValueLength: number,
): Record<string, string> {
  if (value === undefined) return {}
  const record = object(value, field)
  const entries = Object.entries(record)
  if (entries.length > maxEntries || entries.some(([key, item]) =>
    key.length === 0 || key.length > maxKeyLength || typeof item !== 'string' || item.length > maxValueLength,
  )) {
    throw new GatewayError(400, 'BATCH_IMAGE_INVALID_METADATA', 'metadata is too large or contains non-string values')
  }
  return Object.fromEntries(entries) as Record<string, string>
}
