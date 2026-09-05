export type ImageBillingTier = '1K' | '2K' | '4K'

export interface ImageDimensions {
  width: number
  height: number
}

export interface ImageBillingResolution {
  billingTier: ImageBillingTier
  inputSize: string
  outputSize: string
  source: 'output' | 'input' | 'default'
  breakdown?: Partial<Record<ImageBillingTier, number>>
}

/** Maps retained OpenAI and arbitrary WxH size strings to the pricing tier. */
export function classifyImageBillingTier(value: string): ImageBillingTier | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'auto') return null
  if (normalized === '1k') return '1K'
  if (normalized === '2k' || normalized === '2048x2048' || normalized === '2048x1152') return '2K'
  if (normalized === '4k' || normalized === '3840x2160' || normalized === '2160x3840') return '4K'
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(normalized)
  if (match === null) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) return null
  const edge = Math.max(width, height)
  return edge <= 1024 ? '1K' : edge <= 2048 ? '2K' : '4K'
}

/** Reads dimensions from image headers only; no decompression or large allocation. */
export function detectImageDimensions(input: Uint8Array | ArrayBuffer): ImageDimensions | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  return detectPng(bytes) ?? detectJpeg(bytes) ?? detectWebp(bytes)
}

export function resolveImageBilling(
  inputSize: string,
  outputs: Array<Uint8Array | ArrayBuffer>,
): ImageBillingResolution {
  const breakdown: Partial<Record<ImageBillingTier, number>> = {}
  let highest: ImageBillingTier | null = null
  let outputSize = ''
  for (const output of outputs) {
    const dimensions = detectImageDimensions(output)
    if (dimensions === null) continue
    const size = `${dimensions.width}x${dimensions.height}`
    if (outputSize === '') outputSize = size
    const tier = classifyImageBillingTier(size)
    if (tier === null) continue
    breakdown[tier] = (breakdown[tier] ?? 0) + 1
    if (highest === null || tierRank(tier) > tierRank(highest)) highest = tier
  }
  if (highest !== null) {
    return {
      billingTier: highest,
      inputSize: inputSize.trim(),
      outputSize,
      source: 'output',
      breakdown,
    }
  }
  const inputTier = classifyImageBillingTier(inputSize)
  if (inputTier !== null) {
    return {
      billingTier: inputTier,
      inputSize: inputSize.trim(),
      outputSize,
      source: 'input',
    }
  }
  return {
    billingTier: '2K',
    inputSize: inputSize.trim(),
    outputSize,
    source: 'default',
  }
}

function detectPng(bytes: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return validDimensions(view.getUint32(16), view.getUint32(20))
}

function detectJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) return null
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 1 >= bytes.byteLength) return null
    const length = bytes[offset] * 256 + bytes[offset + 1]
    if (length < 2 || offset + length > bytes.byteLength) return null
    if (isStartOfFrame(marker) && length >= 7) {
      return validDimensions(
        bytes[offset + 5] * 256 + bytes[offset + 6],
        bytes[offset + 3] * 256 + bytes[offset + 4],
      )
    }
    offset += length
  }
  return null
}

function isStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
}

function detectWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 25 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
  const kind = ascii(bytes, 12, 4)
  if (kind === 'VP8X' && bytes.byteLength >= 30) {
    return validDimensions(readUint24Le(bytes, 24) + 1, readUint24Le(bytes, 27) + 1)
  }
  if (kind === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | bytes[22] << 8 | bytes[23] << 16 | bytes[24] << 24
    return validDimensions((bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1)
  }
  if (
    kind === 'VP8 ' && bytes.byteLength >= 30 &&
    bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
  ) {
    return validDimensions(
      (bytes[26] | bytes[27] << 8) & 0x3fff,
      (bytes[28] | bytes[29] << 8) & 0x3fff,
    )
  }
  return null
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0)
  return value
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16
}

function validDimensions(width: number, height: number): ImageDimensions | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    width <= 65_535 && height <= 65_535
    ? { width, height }
    : null
}

function tierRank(tier: ImageBillingTier): number {
  return tier === '1K' ? 1 : tier === '2K' ? 2 : 3
}
