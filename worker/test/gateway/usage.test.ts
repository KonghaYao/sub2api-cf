import { describe, expect, it } from 'vitest'
import {
  calculateCost,
  extractUsage,
  reservationForRequest,
  SseEventTransformer,
} from '../../src/gateway/usage'
import type { ModelRoute } from '../../src/gateway/types'

const model: ModelRoute = {
  config_revision: 1,
  model_id: 'model-1',
  public_name: 'gpt-public',
  upstream_name: 'gpt-upstream',
  endpoint: 'both',
  price_id: 'price-1',
  price_version: 1,
  input_micros_per_million: 2_000_000,
  output_micros_per_million: 4_000_000,
  cache_read_micros_per_million: 500_000,
  per_request_micros: 3,
  minimum_reservation_micros: 1,
  group_rate_multiplier_ppm: 1_000_000,
  user_rate_multiplier_ppm: null,
  rate_multiplier_ppm: 1_000_000,
  max_output_tokens: 16_384,
  default_max_output_tokens: 4_096,
}

describe('gateway usage accounting', () => {
  it('applies the group rate multiplier using integer micro-units', () => {
    expect(
      calculateCost(
        { ...model, rate_multiplier_ppm: 1_500_000, per_request_micros: 2 },
        { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, estimated: false },
      ),
    ).toMatchObject({
      input_amount_micros: 3,
      output_amount_micros: 6,
      base_amount_micros: 3,
      amount_micros: 12,
    })
  })

  it('uses integer micro-unit prices and separates cached input', () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    })
    expect(usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 4,
      estimated: false,
    })
    expect(calculateCost(model, usage!)).toEqual({
      input_amount_micros: 12,
      output_amount_micros: 20,
      cache_amount_micros: 2,
      base_amount_micros: 3,
      amount_micros: 37,
    })
  })

  it('reserves a conservative bounded amount before contacting upstream', () => {
    expect(reservationForRequest(model, { max_tokens: 100 }, 100)).toBe(2_651)
    expect(() => reservationForRequest(model, { max_tokens: 20_000 }, 100)).toThrow(
      'Maximum output tokens',
    )
  })

  it('parses SSE across arbitrary chunks without buffering the complete stream', () => {
    const transformer = new SseEventTransformer('gpt-upstream', 'gpt-public')
    const source = [
      'data: {"id":"1","model":"gpt-up',
      'stream","choices":[{"delta":{"content":"你',
      '好"}}]}\r\n\r\ndata: {"usage":{"prompt_tokens":8,',
      '"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ]
    const bytes = new TextEncoder().encode(source.join(''))
    const splits = [bytes.slice(0, 39), bytes.slice(39, 71), bytes.slice(71, 104), bytes.slice(104)]
    const output = [...splits.flatMap((chunk) => transformer.push(chunk)), ...transformer.finish()]
    const text = output.map((chunk) => new TextDecoder().decode(chunk)).join('')

    expect(text).toContain('"model":"gpt-public"')
    expect(text).toContain('你好')
    expect(text).toContain('data: [DONE]')
    expect(transformer.usage()).toEqual({
      input_tokens: 8,
      output_tokens: 2,
      cache_read_tokens: 0,
      estimated: false,
    })
  })
})
