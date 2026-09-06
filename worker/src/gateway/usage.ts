import { GatewayError } from './errors'
import {
  isResponsesFailedTerminal,
  responsesFailureDetails,
  type ResponsesFailureDetails,
} from './protocols/chat-from-responses'
import type { CostBreakdown, GatewayEndpoint, ModelRoute, TokenUsage } from './types'
import {
  quoteCustomerReservation,
  type FrozenPricingPlan,
} from './customer-pricing'

const MAX_SSE_EVENT_CHARS = 256 * 1024
const encoder = new TextEncoder()

export function reservationForRequest(
  model: ModelRoute,
  body: Record<string, unknown>,
  bodyBytes: number,
  endpoint: GatewayEndpoint = 'responses',
  customerPricing?: FrozenPricingPlan,
  pricingAtMs = Date.now(),
): number {
  const requestedMaximum = endpoint === 'embeddings'
    ? null
    : firstInteger(body.max_output_tokens, body.max_completion_tokens, body.max_tokens)
  const outputTokens = endpoint === 'embeddings'
    ? 0
    : requestedMaximum ?? model.default_max_output_tokens
  if (endpoint !== 'embeddings' && (outputTokens <= 0 || outputTokens > model.max_output_tokens)) {
    throw new GatewayError(
      400,
      'invalid_max_output_tokens',
      `Maximum output tokens must be between 1 and ${model.max_output_tokens}`,
    )
  }
  const conservativeInputTokens = bodyBytes + 1_024
  if (customerPricing !== undefined) {
    return quoteCustomerReservation(customerPricing, model, {
      input_tokens: conservativeInputTokens,
      max_output_tokens: outputTokens,
      pricing_at_ms: pricingAtMs,
      service_tier: typeof body.service_tier === 'string' ? body.service_tier : undefined,
    }).reservation_micros
  }
  const projected = calculateCost(model, {
    input_tokens: conservativeInputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: 0,
    estimated: true,
  }, typeof body.service_tier === 'string' ? body.service_tier : undefined).amount_micros
  return Math.max(model.minimum_reservation_micros, projected, 1)
}

export function extractUsage(value: unknown): TokenUsage | null {
  if (value === null || typeof value !== 'object') return null
  const object = value as Record<string, unknown>
  const direct = parseUsageObject(object.usage, Array.isArray(object.data))
  if (direct !== null) return direct
  const response = object.response
  if (response !== null && typeof response === 'object') {
    return parseUsageObject((response as Record<string, unknown>).usage)
  }
  return null
}

/**
 * Reads only protocol-level model declarations from an upstream payload. Callers
 * must pass the raw upstream body before model-name rewriting; arbitrary nested
 * content is intentionally never inspected.
 */
export function extractTrustedResponseModel(value: unknown): string | null {
  const root = objectRecord(value)
  if (root === null) return null
  const direct = trustedModelName(root.model)
  if (direct !== null) return direct
  return trustedModelName(objectRecord(root.response)?.model)
}

export function estimatedUsage(inputBytes: number, outputBytes: number): TokenUsage {
  return {
    input_tokens: Math.max(1, inputBytes),
    output_tokens: Math.max(0, outputBytes),
    cache_read_tokens: 0,
    estimated: true,
  }
}

export function calculateCost(
  model: Pick<ModelRoute,
    'upstream_name' | 'input_micros_per_million' | 'output_micros_per_million' |
    'cache_read_micros_per_million' | 'per_request_micros' | 'rate_multiplier_ppm'>,
  usage: TokenUsage,
  serviceTier?: string,
): CostBreakdown {
  const cached = Math.min(usage.cache_read_tokens, usage.input_tokens)
  const regularInput = usage.input_tokens - cached
  const tierMultiplierPpm = serviceTierMultiplierPpm(model.upstream_name, serviceTier)
  const inputAmount = multipliedMicros(
    pricedMicros(regularInput, model.input_micros_per_million),
    model.rate_multiplier_ppm,
    tierMultiplierPpm,
  )
  const outputAmount = multipliedMicros(
    pricedMicros(usage.output_tokens, model.output_micros_per_million),
    model.rate_multiplier_ppm,
    tierMultiplierPpm,
  )
  const cacheAmount = multipliedMicros(
    pricedMicros(cached, model.cache_read_micros_per_million),
    model.rate_multiplier_ppm,
    tierMultiplierPpm,
  )
  const baseAmount = multipliedMicros(
    model.per_request_micros,
    model.rate_multiplier_ppm,
    tierMultiplierPpm,
  )
  const amount = checkedNumber(
    BigInt(inputAmount) + BigInt(outputAmount) + BigInt(cacheAmount) + BigInt(baseAmount),
  )
  return {
    input_amount_micros: inputAmount,
    output_amount_micros: outputAmount,
    cache_amount_micros: cacheAmount,
    base_amount_micros: baseAmount,
    amount_micros: amount,
  }
}

export function serviceTierMultiplierPpm(modelName: string, serviceTier?: string): number {
  if (serviceTier?.trim().toLowerCase() !== 'priority') return 1_000_000
  const canonical = modelName.trim().toLowerCase()
  if (/^gpt-5\.5(?:$|-)/.test(canonical) && !/^gpt-5\.5-pro(?:$|-)/.test(canonical)) {
    return 2_500_000
  }
  return 2_000_000
}

function multipliedMicros(amount: number, ...multipliersPpm: number[]): number {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    multipliersPpm.some((multiplier) => !Number.isSafeInteger(multiplier) || multiplier < 0)
  ) {
    throw new GatewayError(500, 'invalid_pricing_state', 'Pricing state is invalid', 'server_error')
  }
  let numerator = BigInt(amount)
  let denominator = 1n
  for (const multiplier of multipliersPpm) {
    numerator *= BigInt(multiplier)
    denominator *= 1_000_000n
  }
  return checkedNumber((numerator + denominator - 1n) / denominator)
}

export function rewriteModelNames(
  value: unknown,
  upstreamName: string,
  publicName: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteModelNames(item, upstreamName, publicName))
  }
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] =
      key === 'model' && item === upstreamName
        ? publicName
        : rewriteModelNames(item, upstreamName, publicName)
  }
  return result
}

export class SseEventTransformer {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private latestUsage: TokenUsage | null = null
  private emittedBytes = 0
  private sawChatDone = false
  private responsesTerminal: 'completed' | 'failed' | null = null
  private responsesFailure: ResponsesFailureDetails | null = null
  private responseModelValue: string | null = null
  private responseModelConflict = false

  constructor(
    private readonly upstreamModel: string,
    private readonly publicModel: string,
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const chunks = this.drain(false)
    if (this.buffer.length > MAX_SSE_EVENT_CHARS) {
      throw new GatewayError(502, 'invalid_upstream_stream', 'Upstream SSE event exceeded the size limit', 'server_error')
    }
    return chunks
  }

  finish(): Uint8Array[] {
    this.buffer += this.decoder.decode()
    const chunks = this.drain(false)
    if (this.buffer.length > MAX_SSE_EVENT_CHARS) {
      throw new GatewayError(502, 'invalid_upstream_stream', 'Upstream SSE event exceeded the size limit', 'server_error')
    }
    return [...chunks, ...this.drain(true)]
  }

  usage(): TokenUsage | null {
    return this.latestUsage
  }

  responseModel(): string | null {
    return this.responseModelConflict ? null : this.responseModelValue
  }

  outputBytes(): number {
    return this.emittedBytes
  }

  terminal(endpoint: 'chat_completions' | 'responses'): 'completed' | 'failed' | 'missing' {
    if (endpoint === 'chat_completions') return this.sawChatDone ? 'completed' : 'missing'
    return this.responsesTerminal ?? 'missing'
  }

  failure(): ResponsesFailureDetails | null {
    return this.responsesFailure
  }

  private drain(flush: boolean): Uint8Array[] {
    const chunks: Uint8Array[] = []
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match === null) break
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      chunks.push(this.transformFrame(frame, match[0]))
    }
    if (flush && this.buffer.length > 0) {
      chunks.push(this.transformFrame(this.buffer, ''))
      this.buffer = ''
    }
    return chunks
  }

  private transformFrame(frame: string, delimiter: string): Uint8Array {
    const sourceLines = frame.split(/\r?\n/)
    const eventName = sourceLines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim()
    const dataLines = sourceLines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    const data = dataLines.join('\n')
    let rewrittenData: string | null = null
    if (data === '[DONE]') {
      this.sawChatDone = true
    } else if (data !== '') {
      try {
        const parsed: unknown = JSON.parse(data)
        this.observeResponseModel(extractTrustedResponseModel(parsed))
        const usage = extractUsage(parsed)
        if (usage !== null) this.latestUsage = usage
        const object = objectRecord(parsed)
        if (object !== null) {
          const type = typeof object.type === 'string' ? object.type : eventName
          const terminalEvent = typeof object.type === 'string' || type === undefined
            ? object
            : { ...object, type }
          if (isResponsesFailedTerminal(terminalEvent)) {
            this.responsesTerminal = 'failed'
            this.responsesFailure = responsesFailureDetails(terminalEvent)
          } else if (type === 'response.completed' || type === 'response.incomplete') {
            this.responsesTerminal = 'completed'
          } else if (type === 'response.done') {
            const response = objectRecord(object.response)
            const status = response?.status ?? object.status
            this.responsesTerminal = status === 'completed' || status === 'incomplete'
              ? 'completed'
              : 'failed'
          } else if (
            type === 'response.failed' || type === 'response.canceled' ||
            type === 'response.cancelled' || type === 'error'
          ) {
            this.responsesTerminal = 'failed'
          }
        }
        rewrittenData = JSON.stringify(
          rewriteModelNames(parsed, this.upstreamModel, this.publicModel),
        )
      } catch {
        // Preserve malformed data verbatim. The protocol-specific transformer
        // decides whether it can be forwarded or must fail the request.
      }
    }
    let emittedData = false
    const lines = sourceLines.flatMap((line) => {
      if (!line.startsWith('data:') || rewrittenData === null) return [line]
      if (emittedData) return []
      emittedData = true
      return [`data: ${rewrittenData}`]
    })
    const encoded = encoder.encode(lines.join('\n') + delimiter)
    this.emittedBytes += encoded.byteLength
    return encoded
  }

  private observeResponseModel(model: string | null): void {
    if (model === null || this.responseModelConflict) return
    if (this.responseModelValue === null) {
      this.responseModelValue = model
    } else if (this.responseModelValue.toLowerCase() !== model.toLowerCase()) {
      this.responseModelConflict = true
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function trustedModelName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const model = value.trim()
  return model !== '' && model.length <= 256 && !/[\u0000-\u001f\u007f]/.test(model)
    ? model
    : null
}

export function streamErrorFrame(
  endpoint: 'chat_completions' | 'responses',
  message: string,
  model = '',
  code = 'upstream_stream_error',
  type = 'server_error',
): Uint8Array {
  if (endpoint === 'responses') {
    return encoder.encode(
      `event: response.failed\ndata: ${JSON.stringify({
        type: 'response.failed',
        response: {
          id: `resp_error_${crypto.randomUUID().replace(/-/g, '')}`,
          object: 'response',
          created_at: Math.floor(Date.now() / 1_000),
          model,
          status: 'failed',
          output: [],
          error: { type, code, message },
        },
      })}\n\n`,
    )
  }
  return encoder.encode(
    `event: error\ndata: ${JSON.stringify({
      error: { type, code, message },
    })}\n\n`,
  )
}

function parseUsageObject(value: unknown, inputOnly = false): TokenUsage | null {
  if (value === null || typeof value !== 'object') return null
  const usage = value as Record<string, unknown>
  const input = firstInteger(usage.input_tokens, usage.prompt_tokens)
  const output = firstInteger(usage.output_tokens, usage.completion_tokens) ?? (inputOnly ? 0 : null)
  if (input === null || output === null || input < 0 || output < 0) return null
  const inputDetails = (usage.input_tokens_details ?? usage.prompt_tokens_details) as
    | Record<string, unknown>
    | undefined
  const cached = firstInteger(inputDetails?.cached_tokens) ?? 0
  if (cached < 0) return null
  const cacheWrite = firstInteger(
    inputDetails?.cache_write_tokens,
    inputDetails?.cache_creation_tokens,
    usage.cache_creation_input_tokens,
  ) ?? 0
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: Math.min(cached, input),
    ...(cacheWrite > 0 ? { cache_write_tokens: Math.min(cacheWrite, input) } : {}),
    estimated: false,
  }
}

function firstInteger(...values: unknown[]): number | null {
  for (const value of values) {
    if (Number.isSafeInteger(value)) return value as number
  }
  return null
}

function pricedMicros(tokens: number, rate: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(rate) || rate < 0) {
    throw new GatewayError(500, 'invalid_pricing_state', 'Pricing state is invalid', 'server_error')
  }
  const numerator = BigInt(tokens) * BigInt(rate)
  return checkedNumber((numerator + 999_999n) / 1_000_000n)
}

function checkedNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GatewayError(500, 'pricing_overflow', 'Calculated price exceeds the supported range', 'server_error')
  }
  return Number(value)
}
