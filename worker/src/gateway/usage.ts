import { GatewayError } from './errors'
import type { CostBreakdown, ModelRoute, TokenUsage } from './types'

const MAX_SSE_EVENT_CHARS = 256 * 1024
const encoder = new TextEncoder()

export function reservationForRequest(
  model: ModelRoute,
  body: Record<string, unknown>,
  bodyBytes: number,
): number {
  const requestedMaximum = firstInteger(
    body.max_output_tokens,
    body.max_completion_tokens,
    body.max_tokens,
  )
  const outputTokens = requestedMaximum ?? model.default_max_output_tokens
  if (outputTokens <= 0 || outputTokens > model.max_output_tokens) {
    throw new GatewayError(
      400,
      'invalid_max_output_tokens',
      `Maximum output tokens must be between 1 and ${model.max_output_tokens}`,
    )
  }
  const conservativeInputTokens = bodyBytes + 1_024
  const projected = calculateCost(model, {
    input_tokens: conservativeInputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: 0,
    estimated: true,
  }).amount_micros
  return Math.max(model.minimum_reservation_micros, projected, 1)
}

export function extractUsage(value: unknown): TokenUsage | null {
  if (value === null || typeof value !== 'object') return null
  const object = value as Record<string, unknown>
  const direct = parseUsageObject(object.usage)
  if (direct !== null) return direct
  const response = object.response
  if (response !== null && typeof response === 'object') {
    return parseUsageObject((response as Record<string, unknown>).usage)
  }
  return null
}

export function estimatedUsage(inputBytes: number, outputBytes: number): TokenUsage {
  return {
    input_tokens: Math.max(1, inputBytes),
    output_tokens: Math.max(0, outputBytes),
    cache_read_tokens: 0,
    estimated: true,
  }
}

export function calculateCost(model: ModelRoute, usage: TokenUsage): CostBreakdown {
  const cached = Math.min(usage.cache_read_tokens, usage.input_tokens)
  const regularInput = usage.input_tokens - cached
  const inputAmount = pricedMicros(regularInput, model.input_micros_per_million)
  const outputAmount = pricedMicros(usage.output_tokens, model.output_micros_per_million)
  const cacheAmount = pricedMicros(cached, model.cache_read_micros_per_million)
  const amount = checkedNumber(
    BigInt(inputAmount) + BigInt(outputAmount) + BigInt(cacheAmount) + BigInt(model.per_request_micros),
  )
  return {
    input_amount_micros: inputAmount,
    output_amount_micros: outputAmount,
    cache_amount_micros: cacheAmount,
    base_amount_micros: model.per_request_micros,
    amount_micros: amount,
  }
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

  constructor(
    private readonly upstreamModel: string,
    private readonly publicModel: string,
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    if (this.buffer.length > MAX_SSE_EVENT_CHARS) {
      throw new GatewayError(502, 'invalid_upstream_stream', 'Upstream SSE event exceeded the size limit', 'server_error')
    }
    return this.drain(false)
  }

  finish(): Uint8Array[] {
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  usage(): TokenUsage | null {
    return this.latestUsage
  }

  outputBytes(): number {
    return this.emittedBytes
  }

  terminal(endpoint: 'chat_completions' | 'responses'): 'completed' | 'failed' | 'missing' {
    if (endpoint === 'chat_completions') return this.sawChatDone ? 'completed' : 'missing'
    return this.responsesTerminal ?? 'missing'
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
    const lines = frame.split(/\r?\n/).map((line) => {
      if (!line.startsWith('data:')) return line
      const data = line.slice(5).trimStart()
      if (data === '') return line
      if (data === '[DONE]') {
        this.sawChatDone = true
        return line
      }
      try {
        const parsed: unknown = JSON.parse(data)
        const usage = extractUsage(parsed)
        if (usage !== null) this.latestUsage = usage
        if (parsed !== null && typeof parsed === 'object') {
          const type = (parsed as Record<string, unknown>).type
          if (type === 'response.completed') this.responsesTerminal = 'completed'
          if (type === 'response.failed' || type === 'response.incomplete') {
            this.responsesTerminal = 'failed'
          }
        }
        return `data: ${JSON.stringify(rewriteModelNames(parsed, this.upstreamModel, this.publicModel))}`
      } catch {
        return line
      }
    })
    const encoded = encoder.encode(lines.join('\n') + delimiter)
    this.emittedBytes += encoded.byteLength
    return encoded
  }
}

export function streamErrorFrame(
  endpoint: 'chat_completions' | 'responses',
  message: string,
  model = '',
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
          error: { type: 'server_error', code: 'upstream_stream_error', message },
        },
      })}\n\n`,
    )
  }
  return encoder.encode(
    `event: error\ndata: ${JSON.stringify({
      error: { type: 'server_error', code: 'upstream_stream_error', message },
    })}\n\n`,
  )
}

function parseUsageObject(value: unknown): TokenUsage | null {
  if (value === null || typeof value !== 'object') return null
  const usage = value as Record<string, unknown>
  const input = firstInteger(usage.input_tokens, usage.prompt_tokens)
  const output = firstInteger(usage.output_tokens, usage.completion_tokens)
  if (input === null || output === null || input < 0 || output < 0) return null
  const inputDetails = (usage.input_tokens_details ?? usage.prompt_tokens_details) as
    | Record<string, unknown>
    | undefined
  const cached = firstInteger(inputDetails?.cached_tokens) ?? 0
  if (cached < 0) return null
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: Math.min(cached, input),
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
