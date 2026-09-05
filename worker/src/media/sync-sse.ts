import { detectImageDimensions } from './image-accounting'

const DEFAULT_MAX_EVENT_BYTES = 48 * 1024 * 1024
const DEFAULT_MAX_TRACKED_IMAGE_BYTES = 48 * 1024 * 1024
const DEFAULT_MAX_COMPLETED_IMAGES = 16

export type SyncImageOperation = 'generation' | 'edit'
export type SyncImageSseState = 'open' | 'completed' | 'error'

export interface SyncImageSseOptions {
  operation: SyncImageOperation
  responseFormat: 'b64_json' | 'url'
  publicModel: string
  now?: () => number
  maxEventBytes?: number
  maxTrackedImageBytes?: number
  maxCompletedImages?: number
}

export interface SyncImageStreamUsage {
  inputTokens: number
  outputTokens: number
  imageOutputTokens: number
  images: number
}

export interface SyncImageCompletedImage {
  id: string
  b64: string
  bytes: Uint8Array
  size: string
  outputFormat: string
  revisedPrompt: string
}

export type SyncImageStreamErrorClassification =
  | 'completed_no_image'
  | 'content_filter'
  | 'text_fallback'
  | 'structured_unavailable'
  | 'upstream'
  | 'protocol'

export interface SyncImageStreamError {
  type: string
  code: string
  message: string
  param: string
  status: number
  retryable: boolean
  classification: SyncImageStreamErrorClassification
}

export interface SyncImageSseSnapshot {
  state: SyncImageSseState
  imageCount: number
  completedImages: readonly SyncImageCompletedImage[]
  usage: SyncImageStreamUsage
  outputSuppressed: boolean
  responseStatus: string
  incompleteReason: string
  textOutput: string
  error: SyncImageStreamError | null
  retryAfter: string
  createdAt: number
  publicModel: string
  responseFormat: 'b64_json' | 'url'
}

export class SyncImageSseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'SyncImageSseError'
  }
}

interface ImageMeta {
  model: string
  outputFormat: string
  size: string
  background: string
  quality: string
}

interface PendingImage extends ImageMeta {
  id: string
  b64: string
  revisedPrompt: string
}

interface SseEvent {
  event: string
  data: string
}

/**
 * Incrementally converts native Images or Responses SSE into OpenAI Images SSE.
 * A caller may suppress downstream bytes after disconnect while continuing to
 * feed the same instance so its bounded accounting snapshot reaches terminal.
 */
export class SyncImageSseTransformer {
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private readonly prefix: 'image_generation' | 'image_edit'
  private readonly now: () => number
  private readonly maxEventBytes: number
  private readonly maxTrackedImageBytes: number
  private readonly maxCompletedImages: number
  private pendingText = ''
  private eventName = ''
  private dataLines: string[] = []
  private eventBytes = 0
  private currentMeta: ImageMeta
  private createdAt = 0
  private pendingImages: PendingImage[] = []
  private readonly seenPending = new Set<string>()
  private readonly seenCompleted = new Set<string>()
  private completedImages: SyncImageCompletedImage[] = []
  private trackedImageBytes = 0
  private usage: SyncImageStreamUsage = emptyUsage()
  private state: SyncImageSseState = 'open'
  private outputSuppressed = false
  private responseStatus = ''
  private incompleteReason = ''
  private textOutput = ''
  private error: SyncImageStreamError | null = null
  private retryAfter = ''

  constructor(private readonly options: SyncImageSseOptions) {
    this.prefix = options.operation === 'edit' ? 'image_edit' : 'image_generation'
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.maxEventBytes = positiveLimit(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES)
    this.maxTrackedImageBytes = positiveLimit(options.maxTrackedImageBytes, DEFAULT_MAX_TRACKED_IMAGE_BYTES)
    this.maxCompletedImages = positiveLimit(options.maxCompletedImages, DEFAULT_MAX_COMPLETED_IMAGES)
    this.currentMeta = {
      model: boundedString(options.publicModel, 200),
      outputFormat: '',
      size: '',
      background: '',
      quality: '',
    }
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new SyncImageSseError('IMAGE_SSE_INVALID_CHUNK', 'Image stream chunk must be bytes')
    }
    if (chunk.byteLength === 0) return []
    this.pendingText += this.decoder.decode(chunk, { stream: true })
    const frames = this.drainLines(false)
    if (utf8Length(this.pendingText, this.encoder) + this.eventBytes > this.maxEventBytes) {
      this.failLimit()
    }
    return frames
  }

  finish(): Uint8Array[] {
    this.pendingText += this.decoder.decode()
    const frames = this.drainLines(true)
    if (this.state !== 'open') return frames
    if (this.pendingImages.length > 0) {
      frames.push(...this.completeImages(this.pendingImages, true))
      return frames
    }
    if (this.completedImages.length > 0) {
      this.state = 'completed'
      this.responseStatus = 'completed'
      return frames
    }
    frames.push(...this.emitError('IMAGE_STREAM_INCOMPLETE', 'Upstream image stream ended before completion'))
    return frames
  }

  keepalive(): Uint8Array[] {
    if (this.state !== 'open' || this.outputSuppressed) return []
    return [this.encoder.encode(': keepalive\n\n')]
  }

  disconnectOutput(): void {
    this.outputSuppressed = true
  }

  snapshot(): SyncImageSseSnapshot {
    return {
      state: this.state,
      imageCount: this.completedImages.length,
      completedImages: this.completedImages.map((image) => ({ ...image, bytes: image.bytes.slice() })),
      usage: { ...this.usage },
      outputSuppressed: this.outputSuppressed,
      responseStatus: this.responseStatus,
      incompleteReason: this.incompleteReason,
      textOutput: this.textOutput,
      error: this.error === null ? null : { ...this.error },
      retryAfter: this.retryAfter,
      createdAt: this.resolvedCreatedAt(),
      publicModel: boundedString(this.options.publicModel, 200),
      responseFormat: this.options.responseFormat,
    }
  }

  private drainLines(flush: boolean): Uint8Array[] {
    const frames: Uint8Array[] = []
    while (true) {
      const newline = this.pendingText.indexOf('\n')
      if (newline < 0) break
      let line = this.pendingText.slice(0, newline)
      this.pendingText = this.pendingText.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      frames.push(...this.addLine(line))
    }
    if (flush && this.pendingText !== '') {
      let line = this.pendingText
      this.pendingText = ''
      if (line.endsWith('\r')) line = line.slice(0, -1)
      frames.push(...this.addLine(line))
    }
    if (flush) frames.push(...this.flushEvent())
    return frames
  }

  private addLine(line: string): Uint8Array[] {
    this.eventBytes += utf8Length(line, this.encoder) + 1
    if (this.eventBytes > this.maxEventBytes) this.failLimit()
    if (line.trim() === '') return this.flushEvent()
    if (line.startsWith(':')) return []
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.eventName = value
    if (field === 'data') this.dataLines.push(value)
    return []
  }

  private flushEvent(): Uint8Array[] {
    if (this.dataLines.length === 0) {
      this.resetEvent()
      return []
    }
    const event = { event: this.eventName, data: this.dataLines.join('\n') }
    this.resetEvent()
    return this.processEvent(event)
  }

  private resetEvent(): void {
    this.eventName = ''
    this.dataLines = []
    this.eventBytes = 0
  }

  private processEvent(event: SseEvent): Uint8Array[] {
    const data = event.data.trim()
    if (data === '' || this.state !== 'open') return []
    if (data === '[DONE]') {
      if (this.completedImages.length > 0) {
        this.state = 'completed'
        this.responseStatus = 'completed'
        return []
      }
      return this.emitError('IMAGE_STREAM_INCOMPLETE', 'Upstream image stream ended before completion')
    }
    let payload: Record<string, unknown>
    try {
      payload = asRecord(JSON.parse(data)) ?? invalidPayload()
    } catch (error) {
      if (error instanceof SyncImageSseError) throw this.protocolFailure(error.code, error.message)
      throw this.protocolFailure('IMAGE_SSE_INVALID_JSON', 'Image provider returned invalid SSE JSON')
    }
    const type = stringValue(payload.type) || event.event
    this.mergeUsage(payload, type)
    this.mergeLifecycleMeta(payload, type)
    this.collectText(payload, type)

    if (type === 'response.image_generation_call.partial_image') return this.responsesPartial(payload)
    if (type === 'response.output_item.done') {
      this.collectOutputItem(payload)
      return []
    }
    if (type === 'response.completed') return this.responsesCompleted(payload)
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
      return this.upstreamError(payload, type)
    }
    if (type === 'image_generation.partial_image' || type === 'image_edit.partial_image') {
      return this.nativePartial(payload)
    }
    if (type === 'image_generation.completed' || type === 'image_edit.completed') {
      return this.nativeCompleted(payload)
    }
    return []
  }

  private mergeLifecycleMeta(payload: Record<string, unknown>, type: string): void {
    if (
      type !== 'response.created' && type !== 'response.in_progress' && type !== 'response.completed' &&
      type !== 'response.failed' && type !== 'response.incomplete'
    ) return
    const response = asRecord(payload.response)
    if (response === null) return
    this.responseStatus = boundedString(stringValue(response.status).trim(), 64) || type.slice('response.'.length)
    if (type === 'response.incomplete') {
      this.incompleteReason = boundedString(
        stringValue(asRecord(response.incomplete_details)?.reason).trim(),
        120,
      )
    }
    const tools = Array.isArray(response.tools) ? response.tools : []
    const tool = tools.map(asRecord).find((candidate) => candidate?.type === 'image_generation') ?? null
    if (tool !== null) {
      this.currentMeta = {
        ...mergeMeta(this.currentMeta, metaFrom(tool)),
        model: boundedString(this.options.publicModel, 200),
      }
    }
    const createdAt = safeInteger(response.created_at)
    if (createdAt !== null) this.createdAt = createdAt
  }

  private collectText(payload: Record<string, unknown>, type: string): void {
    if (type === 'response.output_text.delta') {
      this.appendText(stringValue(payload.delta))
      return
    }
    if (type !== 'response.completed' && type !== 'response.output_item.done') return
    const container = type === 'response.completed' ? asRecord(payload.response) : payload
    const output = type === 'response.completed' ? container?.output : [container?.item]
    if (!Array.isArray(output)) return
    for (const candidate of output) {
      const item = asRecord(candidate)
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue
      for (const part of item.content) {
        const content = asRecord(part)
        if (content?.type === 'output_text') this.appendText(stringValue(content.text))
      }
    }
  }

  private appendText(value: string): void {
    const text = value.trim()
    if (text === '' || this.textOutput.length >= 600) return
    const separator = this.textOutput === '' ? '' : ' '
    this.textOutput = (this.textOutput + separator + text).slice(0, 600)
  }

  private responsesPartial(payload: Record<string, unknown>): Uint8Array[] {
    const b64 = stringValue(payload.partial_image_b64).trim()
    if (b64 === '') return []
    const meta = mergeMeta(this.currentMeta, metaFrom(payload))
    const body: Record<string, unknown> = {
      type: `${this.prefix}.partial_image`,
      created_at: this.resolvedCreatedAt(),
      partial_image_index: safeInteger(payload.partial_image_index) ?? 0,
      b64_json: b64,
    }
    if (this.options.responseFormat === 'url') body.url = dataUrl(b64, meta.outputFormat)
    addMeta(body, meta)
    return this.frame(`${this.prefix}.partial_image`, body)
  }

  private collectOutputItem(payload: Record<string, unknown>): void {
    const item = asRecord(payload.item)
    if (item?.type !== 'image_generation_call') return
    const image = imageFrom(item, this.currentMeta)
    if (image === null) return
    const identity = imageIdentity(image)
    if (this.seenPending.has(identity)) return
    this.seenPending.add(identity)
    this.pendingImages.push(image)
  }

  private responsesCompleted(payload: Record<string, unknown>): Uint8Array[] {
    const response = asRecord(payload.response)
    if (response === null) return this.emitError('IMAGE_INVALID_PROVIDER_OUTPUT', 'Image provider returned an invalid completion')
    const images: PendingImage[] = []
    const seen = new Set<string>()
    if (Array.isArray(response.output)) {
      for (const candidate of response.output) {
        const item = asRecord(candidate)
        if (item?.type !== 'image_generation_call') continue
        const image = imageFrom(item, this.currentMeta)
        if (image === null) continue
        const identity = imageIdentity(image)
        if (!seen.has(identity)) {
          seen.add(identity)
          images.push(image)
        }
      }
    }
    for (const image of this.pendingImages) {
      const identity = imageIdentity(image)
      if (!seen.has(identity)) {
        seen.add(identity)
        images.push(image)
      }
    }
    if (images.length > 0) return this.completeImages(images, true)
    if (isContentPolicyText(this.textOutput)) {
      return this.emitFailure({
        type: 'image_generation_user_error', code: 'content_policy_violation',
        message: this.textOutput || 'Image request was blocked by content policy', param: '',
        status: 400, retryable: false, classification: 'content_filter',
      })
    }
    if (this.textOutput !== '') {
      return this.emitFailure({
        type: 'upstream_error', code: 'image_generation_unavailable',
        message: 'Upstream did not execute image generation', param: '',
        status: 502, retryable: true, classification: 'text_fallback',
      })
    }
    return this.emitFailure({
      type: 'upstream_error', code: 'IMAGE_PROVIDER_OUTPUT_MISSING',
      message: 'Image provider returned no usable image', param: '',
      status: 502, retryable: true, classification: 'completed_no_image',
    })
  }

  private nativePartial(payload: Record<string, unknown>): Uint8Array[] {
    const b64 = stringValue(payload.b64_json).trim()
    if (b64 === '') return []
    const body = { ...payload, type: `${this.prefix}.partial_image` }
    return this.frame(`${this.prefix}.partial_image`, body)
  }

  private nativeCompleted(payload: Record<string, unknown>): Uint8Array[] {
    const image = imageFrom({
      ...payload,
      result: payload.b64_json,
      id: payload.id,
    }, this.currentMeta)
    if (image === null) return this.emitError('IMAGE_INVALID_PROVIDER_OUTPUT', 'Image provider returned an invalid completion')
    this.responseStatus = this.responseStatus || 'in_progress'
    return this.completeImages([image], false)
  }

  private completeImages(images: PendingImage[], terminal: boolean): Uint8Array[] {
    if (this.state !== 'open') return []
    const completedBatch: Array<{ source: PendingImage; completed: SyncImageCompletedImage }> = []
    try {
      for (const image of images) {
        const identity = imageIdentity(image)
        if (this.seenCompleted.has(identity)) continue
        const completed = this.trackImage(image)
        this.seenCompleted.add(identity)
        completedBatch.push({ source: image, completed })
      }
    } catch (error) {
      if (error instanceof SyncImageSseError) {
        return this.emitFailure({
          type: 'upstream_error', code: error.code, message: error.message, param: '',
          status: 502, retryable: true, classification: 'protocol',
        })
      }
      throw error
    }
    if (this.completedImages.length === 0) {
      return this.emitFailure({
        type: 'upstream_error', code: 'IMAGE_PROVIDER_OUTPUT_MISSING',
        message: 'Image provider returned no usable image', param: '',
        status: 502, retryable: true, classification: 'completed_no_image',
      })
    }
    this.usage.images = this.completedImages.length
    const usage = safeUsageObject(this.usage)
    const frames: Uint8Array[] = []
    for (const { source: image, completed } of completedBatch) {
      const body: Record<string, unknown> = {
        type: `${this.prefix}.completed`,
        created_at: this.resolvedCreatedAt(),
        b64_json: image.b64,
      }
      if (this.options.responseFormat === 'url') body.url = dataUrl(image.b64, image.outputFormat)
      addMeta(body, { ...image, size: completed.size })
      if (usage !== undefined) body.usage = usage
      frames.push(...this.frame(`${this.prefix}.completed`, body))
    }
    if (terminal) {
      this.state = 'completed'
      this.responseStatus = 'completed'
    }
    return frames
  }

  private trackImage(image: PendingImage): SyncImageCompletedImage {
    if (this.completedImages.length >= this.maxCompletedImages) {
      throw new SyncImageSseError('IMAGE_SSE_TOO_MANY_OUTPUTS', 'Image stream exceeded the output count limit')
    }
    const bytes = decodeBase64(image.b64, this.maxTrackedImageBytes - this.trackedImageBytes)
    if (bytes === null) {
      throw new SyncImageSseError('IMAGE_INVALID_PROVIDER_OUTPUT', 'Image provider returned malformed image data')
    }
    this.trackedImageBytes += bytes.byteLength
    const dimensions = detectImageDimensions(bytes)
    const completed: SyncImageCompletedImage = {
      id: image.id,
      b64: image.b64,
      bytes,
      size: dimensions === null ? image.size : `${dimensions.width}x${dimensions.height}`,
      outputFormat: image.outputFormat,
      revisedPrompt: image.revisedPrompt,
    }
    this.completedImages.push(completed)
    return completed
  }

  private mergeUsage(payload: Record<string, unknown>, type: string): void {
    const direct = safeTokenUsage(asRecord(payload.usage))
    if (direct !== null) this.usage = { ...this.usage, ...direct }
    const response = asRecord(payload.response)
    const generic = safeTokenUsage(asRecord(response?.usage))
    if (generic !== null) this.usage = { ...this.usage, ...generic }
    if (type !== 'response.completed') return
    const toolUsageValue = asRecord(asRecord(response?.tool_usage)?.image_gen)
    const toolUsage = safeToolUsage(toolUsageValue)
    if (toolUsage !== null) {
      this.usage = toolUsage
      return
    }
    const images = safeInteger(toolUsageValue?.images)
    if (images !== null) this.usage.images = images
  }

  private upstreamError(payload: Record<string, unknown>, type: string): Uint8Array[] {
    const source = type === 'error'
      ? asRecord(payload.error)
      : asRecord(asRecord(payload.response)?.error)
    const errorType = safeErrorString(source?.type) || (type === 'response.incomplete' ? 'incomplete_error' : 'upstream_error')
    const message = safeErrorString(source?.message) || (type === 'response.incomplete'
      ? this.incompleteReason === ''
        ? 'Upstream did not complete image generation'
        : `Upstream image generation incomplete: ${this.incompleteReason}`
      : 'Upstream request failed')
    const error: Record<string, unknown> = { type: errorType, message }
    const code = safeErrorString(source?.code) || (type === 'response.incomplete' ? 'response_incomplete' : '')
    const param = safeErrorString(source?.param)
    if (code !== '') error.code = code
    if (param !== '') error.param = param
    this.responseStatus = type === 'response.incomplete' ? 'incomplete' : 'failed'
    this.retryAfter = retryAfterValue(source?.retry_after ?? payload.retry_after)
    const contentFilter = (type === 'response.incomplete' && isContentFilterReason(this.incompleteReason)) ||
      isContentPolicyCode(errorType, code)
    const classification: SyncImageStreamErrorClassification = contentFilter
      ? 'content_filter'
      : code.toLowerCase() === 'image_generation_unavailable'
        ? 'structured_unavailable'
        : 'upstream'
    const status = contentFilter ? 400 : upstreamErrorStatus(errorType, code)
    return this.emitFailure({
      type: errorType,
      code: code || 'IMAGE_UPSTREAM_ERROR',
      message,
      param,
      status,
      retryable: status >= 500,
      classification,
    }, error)
  }

  private emitError(code: string, message: string, error?: Record<string, unknown>): Uint8Array[] {
    return this.emitFailure({
      type: safeErrorString(error?.type) || 'upstream_error',
      code,
      message,
      param: safeErrorString(error?.param),
      status: 502,
      retryable: true,
      classification: 'protocol',
    }, error)
  }

  private emitFailure(failure: SyncImageStreamError, publicError?: Record<string, unknown>): Uint8Array[] {
    if (this.state !== 'open') return []
    this.state = 'error'
    this.error = failure
    return this.frame('error', {
      type: 'error',
      error: publicError ?? {
        type: failure.type,
        code: failure.code,
        message: failure.message,
        ...(failure.param === '' ? {} : { param: failure.param }),
      },
    })
  }

  private frame(event: string, payload: Record<string, unknown>): Uint8Array[] {
    if (this.outputSuppressed) return []
    return [this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)]
  }

  private resolvedCreatedAt(): number {
    if (this.createdAt <= 0) this.createdAt = this.now()
    return this.createdAt
  }

  private failLimit(): never {
    this.pendingText = ''
    this.resetEvent()
    throw this.protocolFailure('IMAGE_SSE_EVENT_TOO_LARGE', 'Image provider SSE event exceeded the size limit')
  }

  private protocolFailure(code: string, message: string): SyncImageSseError {
    this.state = 'error'
    this.responseStatus = 'failed'
    this.error = {
      type: 'upstream_error', code, message, param: '', status: 502, retryable: true, classification: 'protocol',
    }
    return new SyncImageSseError(code, message)
  }
}

export function createSyncImageSseTransformer(options: SyncImageSseOptions): SyncImageSseTransformer {
  return new SyncImageSseTransformer(options)
}

/** Builds the buffered Images JSON body from the exact same terminal outputs used for streaming billing. */
export function buildSyncImageBufferedResponse(snapshot: SyncImageSseSnapshot): Record<string, unknown> {
  if (snapshot.state !== 'completed' || snapshot.completedImages.length === 0) {
    throw new SyncImageSseError('IMAGE_STREAM_NOT_COMPLETED', 'Cannot buffer an incomplete image stream')
  }
  const data = snapshot.completedImages.map((image) => {
    const entry: Record<string, unknown> = snapshot.responseFormat === 'url'
      ? { url: dataUrl(image.b64, image.outputFormat) }
      : { b64_json: image.b64 }
    if (image.revisedPrompt !== '') entry.revised_prompt = image.revisedPrompt
    if (image.size !== '') entry.size = image.size
    return entry
  })
  const body: Record<string, unknown> = {
    created: snapshot.createdAt,
    data,
    model: snapshot.publicModel,
  }
  const usage = safeUsageObject(snapshot.usage)
  if (usage !== undefined) body.usage = usage
  return body
}

function emptyUsage(): SyncImageStreamUsage {
  return { inputTokens: 0, outputTokens: 0, imageOutputTokens: 0, images: 0 }
}

function safeTokenUsage(value: Record<string, unknown> | null): Partial<SyncImageStreamUsage> | null {
  if (value === null) return null
  const output: Partial<SyncImageStreamUsage> = {}
  const inputTokens = safeInteger(value.input_tokens)
  const outputTokens = safeInteger(value.output_tokens)
  const details = asRecord(value.output_tokens_details)
  const imageOutputTokens = safeInteger(details?.image_tokens)
  const images = safeInteger(value.images)
  if (inputTokens !== null) output.inputTokens = inputTokens
  if (outputTokens !== null) output.outputTokens = outputTokens
  if (imageOutputTokens !== null) output.imageOutputTokens = imageOutputTokens
  if (images !== null) output.images = images
  return Object.keys(output).length === 0 ? null : output
}

function safeToolUsage(value: Record<string, unknown> | null): SyncImageStreamUsage | null {
  if (value === null) return null
  const inputTokens = safeInteger(value.input_tokens)
  const outputTokens = safeInteger(value.output_tokens)
  const imageOutputTokens = safeInteger(asRecord(value.output_tokens_details)?.image_tokens)
  if (inputTokens === null || outputTokens === null || imageOutputTokens === null) return null
  return {
    inputTokens,
    outputTokens,
    imageOutputTokens,
    images: safeInteger(value.images) ?? 0,
  }
}

function safeUsageObject(usage: SyncImageStreamUsage): Record<string, unknown> | undefined {
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.imageOutputTokens === 0 && usage.images === 0) {
    return undefined
  }
  const result: Record<string, unknown> = {}
  if (usage.inputTokens > 0) result.input_tokens = usage.inputTokens
  if (usage.outputTokens > 0) result.output_tokens = usage.outputTokens
  if (usage.imageOutputTokens > 0) result.output_tokens_details = { image_tokens: usage.imageOutputTokens }
  if (usage.images > 0) result.images = usage.images
  return result
}

function imageFrom(value: Record<string, unknown>, fallback: ImageMeta): PendingImage | null {
  const b64 = stringValue(value.result).trim()
  if (b64 === '') return null
  return {
    ...mergeMeta(fallback, metaFrom(value)),
    id: boundedString(stringValue(value.id).trim(), 200),
    b64,
    revisedPrompt: boundedString(stringValue(value.revised_prompt).trim(), 16_000),
  }
}

function imageIdentity(image: PendingImage): string {
  return `${image.outputFormat}|${image.b64}`
}

function metaFrom(value: Record<string, unknown>): ImageMeta {
  return {
    model: boundedString(stringValue(value.model).trim(), 200),
    outputFormat: boundedString(stringValue(value.output_format).trim(), 32),
    size: boundedString(stringValue(value.size).trim(), 64),
    background: boundedString(stringValue(value.background).trim(), 64),
    quality: boundedString(stringValue(value.quality).trim(), 64),
  }
}

function mergeMeta(base: ImageMeta, overlay: ImageMeta): ImageMeta {
  return {
    model: overlay.model || base.model,
    outputFormat: overlay.outputFormat || base.outputFormat,
    size: overlay.size || base.size,
    background: overlay.background || base.background,
    quality: overlay.quality || base.quality,
  }
}

function addMeta(target: Record<string, unknown>, meta: ImageMeta): void {
  if (meta.background !== '') target.background = meta.background
  if (meta.outputFormat !== '') target.output_format = meta.outputFormat
  if (meta.quality !== '') target.quality = meta.quality
  if (meta.size !== '') target.size = meta.size
  if (meta.model !== '') target.model = meta.model
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array | null {
  if (maximumBytes <= 0 || value.length === 0 || value.length > Math.ceil(maximumBytes / 3) * 4 + 4) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null
  try {
    const decoded = atob(value.padEnd(Math.ceil(value.length / 4) * 4, '='))
    if (decoded.length === 0 || decoded.length > maximumBytes) return null
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function dataUrl(b64: string, outputFormat: string): string {
  const format = outputFormat.toLowerCase()
  const mime = format === 'webp' ? 'image/webp' : format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png'
  return `data:${mime};base64,${b64}`
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function safeErrorString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/https?:\/\/\S+/gi, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)
}

function retryAfterValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value).slice(0, 64)
  if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
  return ''
}

function isContentFilterReason(value: string): boolean {
  const normalized = value.toLowerCase()
  return normalized.includes('content_filter') || normalized.includes('moderation') || normalized.includes('safety')
}

function isContentPolicyCode(type: string, code: string): boolean {
  const normalized = `${type} ${code}`.toLowerCase()
  return normalized.includes('content_policy') || normalized.includes('policy_violation') ||
    normalized.includes('moderation_blocked') || normalized.includes('safety_violation')
}

function isContentPolicyText(value: string): boolean {
  const normalized = value.toLowerCase()
  return [
    'content policy', 'content_policy', 'content filter', 'content_filter', 'safety system',
    'safety policy', 'safety violation', 'moderation', '安全系统', '安全策略', '安全政策',
    '内容政策', '内容审核', '违规内容', '不适合生成',
  ].some((marker) => normalized.includes(marker))
}

function upstreamErrorStatus(type: string, code: string): number {
  const normalizedType = type.toLowerCase()
  const normalizedCode = code.toLowerCase()
  if (normalizedType.includes('rate_limit') || normalizedCode.includes('rate_limit')) return 429
  if (normalizedType.includes('authentication') || normalizedCode.includes('invalid_api_key') || normalizedCode === 'unauthorized') return 401
  if (normalizedType.includes('permission') || normalizedCode === 'forbidden') return 403
  if (normalizedType.includes('not_found') || normalizedCode.includes('not_found')) return 404
  if (normalizedType.includes('invalid_request')) return 400
  return 502
}

function boundedString(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function invalidPayload(): never {
  throw new SyncImageSseError('IMAGE_SSE_INVALID_JSON', 'Image provider returned invalid SSE JSON')
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback
}

function utf8Length(value: string, encoder: TextEncoder): number {
  return encoder.encode(value).byteLength
}
