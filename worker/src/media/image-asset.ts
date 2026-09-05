const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000

export interface AsyncImageAssetEnv {
  ENVIRONMENT: string
  ASYNC_IMAGE_DOWNLOAD_FETCH?: typeof fetch
  ASYNC_IMAGE_DOWNLOAD_TIMEOUT_MS?: number
  /** Optional JSON array or comma-separated exact/suffix host allow-list. */
  ASYNC_IMAGE_DOWNLOAD_HOSTS?: string
}

export interface ImageAsset {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
}

export async function resolveImageAsset(
  item: Record<string, unknown>,
  env: AsyncImageAssetEnv,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
): Promise<ImageAsset> {
  const encoded = typeof item.b64_json === 'string' ? item.b64_json.trim() : ''
  if (encoded !== '') {
    return validatedImage(decodeBase64(encoded, Math.min(maxBytes, MAX_INLINE_IMAGE_BYTES)))
  }
  const imageUrl = typeof item.url === 'string' ? item.url.trim() : ''
  if (imageUrl === '') throw new Error('image output missing')
  if (/^data:/i.test(imageUrl)) {
    return validatedImage(decodeImageDataUrl(imageUrl, Math.min(maxBytes, MAX_INLINE_IMAGE_BYTES)))
  }
  return downloadImage(imageUrl, env, maxBytes)
}

export function decodeImageDataUrl(value: string, maxBytes = DEFAULT_MAX_IMAGE_BYTES): Uint8Array {
  const comma = value.indexOf(',')
  if (comma < 0) throw new Error('invalid image data URL')
  const header = value.slice(5, comma)
  const segments = splitMediaHeader(header)
  const mime = segments.shift()?.trim().toLowerCase()
  if (mime === undefined || !/^image\/(?:png|jpeg|jpg|webp)$/.test(mime)) {
    throw new Error('unsupported image data URL')
  }
  const base64Markers = segments.filter((segment) => segment.trim().toLowerCase() === 'base64')
  if (base64Markers.length !== 1 || segments.at(-1)?.trim().toLowerCase() !== 'base64') {
    throw new Error('invalid image data URL encoding')
  }
  const parameterNames = new Set<string>()
  for (const parameter of segments.slice(0, -1)) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(?:"(?:[^"\\]|\\.)*"|[^;\s]+)$/.exec(parameter.trim())
    const name = match?.[1].toLowerCase()
    if (name === undefined || parameterNames.has(name)) {
      throw new Error('invalid image data URL media type')
    }
    parameterNames.add(name)
  }
  return decodeBase64(value.slice(comma + 1), maxBytes)
}

function splitMediaHeader(value: string): string[] {
  const output: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) { escaped = false; continue }
    if (quoted && character === '\\') { escaped = true; continue }
    if (character === '"') { quoted = !quoted; continue }
    if (character === ';' && !quoted) { output.push(value.slice(start, index)); start = index + 1 }
  }
  if (quoted || escaped) throw new Error('invalid image data URL media type')
  output.push(value.slice(start))
  return output
}

async function downloadImage(value: string, env: AsyncImageAssetEnv, maxBytes: number): Promise<ImageAsset> {
  const url = safeRemoteUrl(value, env.ASYNC_IMAGE_DOWNLOAD_HOSTS)
  const timeoutMs = boundedTimeout(env.ASYNC_IMAGE_DOWNLOAD_TIMEOUT_MS)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await (env.ASYNC_IMAGE_DOWNLOAD_FETCH ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'image/png,image/jpeg,image/webp' },
    })
    if (!response.ok || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('image download failed')
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
      const parsed = Number(declaredLength)
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('image download too large')
      }
    }
    return validatedImage(await readBodyLimited(response, maxBytes, controller.signal))
  } finally {
    clearTimeout(timeout)
  }
}

async function readBodyLimited(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) throw new Error('image download body missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error('image download timed out')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('image download too large')
      chunks.push(value)
    }
  } finally {
    if (total > maxBytes || signal.aborted) await reader.cancel().catch(() => undefined)
  }
  if (total === 0) throw new Error('image download empty')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function safeRemoteUrl(value: string, configuredHosts: string | undefined): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('invalid image URL') }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.hash !== ''
  ) throw new Error('unsafe image URL')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isPrivateHostname(hostname)) throw new Error('unsafe image URL')
  const hosts = parseHosts(configuredHosts)
  if (hosts.length > 0 && !hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    throw new Error('untrusted image URL host')
  }
  return url
}

function parseHosts(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return []
  let candidates: unknown
  try { candidates = JSON.parse(value) } catch { candidates = value.split(',') }
  if (!Array.isArray(candidates)) throw new Error('invalid image host allow-list')
  return candidates.map((candidate) => {
    if (typeof candidate !== 'string') throw new Error('invalid image host allow-list')
    const host = candidate.trim().toLowerCase().replace(/\.$/, '')
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host)) {
      throw new Error('invalid image host allow-list')
    }
    return host
  })
}

function isPrivateHostname(hostname: string): boolean {
  if (
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    hostname.endsWith('.internal') || hostname.endsWith('.home') || hostname.endsWith('.lan') ||
    hostname.endsWith('.onion') || hostname.includes(':')
  ) return true
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = octets
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) || first >= 224
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('invalid image base64')
  }
  let decoded: string
  try { decoded = atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')) } catch { throw new Error('invalid image base64') }
  if (decoded.length === 0 || decoded.length > maxBytes) throw new Error('image output too large')
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

function validatedImage(bytes: Uint8Array): ImageAsset {
  if (
    bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return { bytes, mime: 'image/png' }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, mime: 'image/jpeg' }
  }
  if (
    bytes.byteLength >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return { bytes, mime: 'image/webp' }
  throw new Error('unsupported image bytes')
}

function boundedTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value >= 100 && value <= 120_000
    ? Math.floor(value)
    : DEFAULT_DOWNLOAD_TIMEOUT_MS
}
