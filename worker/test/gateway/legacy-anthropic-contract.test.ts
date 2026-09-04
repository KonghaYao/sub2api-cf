import { describe, expect, it } from 'vitest'
import {
  ResponsesToAnthropicEventCodec,
  mapOpenAIErrorToAnthropic,
} from '../../src/gateway/protocols/anthropic'

describe('legacy Responses to Anthropic terminal contract', () => {
  it('closes partial output and terminates normally when Responses reports failure', () => {
    const codec = new ResponsesToAnthropicEventCodec('claude-public')
    codec.push({
      type: 'response.created',
      response: { id: 'resp_failed', model: 'private-upstream-model' },
    })
    codec.push({ type: 'response.output_text.delta', delta: 'Partial output' })

    const events = codec.push({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { code: 'server_error', message: 'private upstream detail' },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    })

    expect(events).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      { type: 'message_stop' },
    ])
    expect(codec.finish()).toEqual([])
    expect(codec.push({ type: 'response.completed' })).toEqual([])
  })

  it('terminates a failed empty response without manufacturing a content block', () => {
    const codec = new ResponsesToAnthropicEventCodec('claude-public')
    codec.push({ type: 'response.created', response: { id: 'resp_empty' } })

    expect(codec.push({
      type: 'response.failed',
      response: {
        status: 'failed',
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    }).map((event) => event.type)).toEqual(['message_delta', 'message_stop'])
  })
})

describe('legacy Anthropic error envelope contract', () => {
  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [529, 'overloaded_error'],
    [503, 'api_error'],
  ] as const)('maps HTTP %i without reflecting provider details', (status, type) => {
    const mapped = mapOpenAIErrorToAnthropic(status, {
      error: { message: 'secret account and private-upstream-model' },
    })
    expect(mapped.type).toBe('error')
    expect(mapped.error.type).toBe(type)
    expect(mapped.error.message).not.toContain('secret account')
    expect(mapped.error.message).not.toContain('private-upstream-model')
  })
})
