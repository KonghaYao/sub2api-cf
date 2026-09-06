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
  platform: 'openai',
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

  it('prices priority service at 2x, with the gpt-5.5 family at 2.5x', () => {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, estimated: false }
    expect(calculateCost(
      { ...model, upstream_name: 'gpt-5.6-sol' }, usage, 'priority',
    )).toMatchObject({
      input_amount_micros: 4,
      output_amount_micros: 8,
      base_amount_micros: 6,
      amount_micros: 18,
    })
    expect(calculateCost(
      { ...model, upstream_name: 'gpt-5.5' }, usage, 'priority',
    )).toMatchObject({
      input_amount_micros: 5,
      output_amount_micros: 10,
      base_amount_micros: 8,
      amount_micros: 23,
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

  it('preserves provider-reported cache-write input for account-cost settlement', () => {
    expect(extractUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
      },
    })).toMatchObject({
      input_tokens: 10,
      cache_read_tokens: 2,
      cache_write_tokens: 3,
      estimated: false,
    })
  })

  it('reserves a conservative bounded amount before contacting upstream', () => {
    expect(reservationForRequest(model, { max_tokens: 100 }, 100)).toBe(2_651)
    expect(reservationForRequest(
      model,
      { max_tokens: 100, service_tier: 'priority' },
      100,
    )).toBe(5_302)
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
    expect(transformer.responseModel()).toBe('gpt-upstream')
    expect(transformer.usage()).toEqual({
      input_tokens: 8,
      output_tokens: 2,
      cache_read_tokens: 0,
      estimated: false,
    })
  })

  it('does not adopt a conflicting model declaration from an upstream stream', () => {
    const transformer = new SseEventTransformer('gpt-upstream', 'gpt-public')
    transformer.push(new TextEncoder().encode(
      'data: {"model":"actual-model-a"}\n\ndata: {"response":{"model":"actual-model-b"}}\n\n',
    ))
    expect(transformer.responseModel()).toBeNull()
  })

  it('treats an incomplete Responses terminal as billable completion and real errors as failures', () => {
    const incomplete = new SseEventTransformer('gpt-upstream', 'gpt-public')
    incomplete.push(new TextEncoder().encode([
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":4,"output_tokens":2}}}',
      '',
      '',
    ].join('\n')))
    expect(incomplete.terminal('responses')).toBe('completed')

    const incompleteWithError = new SseEventTransformer('gpt-upstream', 'gpt-public')
    incompleteWithError.push(new TextEncoder().encode([
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","error":{"code":"server_error","message":"provider failed"},"usage":{"input_tokens":4,"output_tokens":1}}}',
      '',
      '',
    ].join('\n')))
    expect(incompleteWithError.terminal('responses')).toBe('failed')
    expect(incompleteWithError.failure()).toEqual({
      code: 'server_error',
      message: 'provider failed',
      cyberPolicy: false,
    })

    for (const type of ['response.failed', 'response.cancelled', 'error']) {
      const failed = new SseEventTransformer('gpt-upstream', 'gpt-public')
      failed.push(new TextEncoder().encode(`event: ${type}\ndata: {"type":"${type}"}\n\n`))
      expect(failed.terminal('responses')).toBe('failed')
    }
  })

  it('classifies response.done from its embedded final status', () => {
    for (const status of ['completed', 'incomplete']) {
      const successful = new SseEventTransformer('gpt-upstream', 'gpt-public')
      successful.push(new TextEncoder().encode(
        `event: response.done\ndata: {"type":"response.done","response":{"status":"${status}"}}\n\n`,
      ))
      expect(successful.terminal('responses')).toBe('completed')
    }

    const failed = new SseEventTransformer('gpt-upstream', 'gpt-public')
    failed.push(new TextEncoder().encode(
      'event: response.done\ndata: {"type":"response.done","response":{"status":"failed"}}\n\n',
    ))
    expect(failed.terminal('responses')).toBe('failed')
  })

  it('parses a terminal Responses event across multiple SSE data lines', () => {
    const transformer = new SseEventTransformer('gpt-upstream', 'gpt-public')
    transformer.push(new TextEncoder().encode([
      'event:response.done',
      'data:{"type":"response.done","response":{"status":',
      'data:"completed","usage":{"input_tokens":7,"output_tokens":3}}}',
      '',
      '',
    ].join('\n')))

    expect(transformer.terminal('responses')).toBe('completed')
    expect(transformer.usage()).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_tokens: 0,
      estimated: false,
    })
  })

  it('recognizes both spellings of a canceled Responses terminal', () => {
    for (const type of ['response.canceled', 'response.cancelled']) {
      const transformer = new SseEventTransformer('gpt-upstream', 'gpt-public')
      transformer.push(new TextEncoder().encode(`event:${type}\ndata:{"type":"${type}"}\n\n`))
      expect(transformer.terminal('responses')).toBe('failed')
    }
  })
})
