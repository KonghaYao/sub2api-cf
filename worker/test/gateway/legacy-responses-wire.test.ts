import { describe, expect, it } from 'vitest'
import {
  ChatCompletionsToResponsesEventCodec,
  chatCompletionsResponseToResponses,
  formatResponsesSseEvent,
} from '../../src/gateway/protocols/responses'

describe('legacy Chat to Responses wire contract', () => {
  it('preserves upstream created_at and service tier on a buffered response', () => {
    const response = chatCompletionsResponseToResponses({
      id: 'chatcmpl_legacy',
      object: 'chat.completion',
      created: 1_700_000_123,
      model: 'private-upstream-model',
      service_tier: 'priority',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'hello' },
      }],
    }, 'public-model', 1_800_000_000)

    expect(response.created_at).toBe(1_700_000_123)
    expect(response.service_tier).toBe('priority')
    expect(response.model).toBe('public-model')
    expect(JSON.stringify(response)).not.toContain('private-upstream-model')
  })

  it('keeps created_at stable and zero index fields present across a stream', () => {
    const codec = new ChatCompletionsToResponsesEventCodec('public-model', 123)
    const events = [
      ...codec.push({
        id: 'chatcmpl_stream',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
      }),
      ...codec.finish(),
    ]

    const responseEvents = events.filter((event) => event.response !== undefined)
    expect(responseEvents.map((event) => event.response?.created_at)).toEqual([123, 123])

    const delta = events.find((event) => event.type === 'response.output_text.delta')
    expect(delta).toMatchObject({ output_index: 0, content_index: 0, delta: 'hi' })
    const wire = formatResponsesSseEvent(delta!)
    expect(wire).toContain('"output_index":0')
    expect(wire).toContain('"content_index":0')
  })

  it('emits complete function-call fields and only one terminal event', () => {
    const codec = new ChatCompletionsToResponsesEventCodec('public-model', 123)
    const events = [
      ...codec.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'exec', arguments: '' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      ...codec.finish(),
      ...codec.finish(),
    ]

    expect(events.find((event) => event.type === 'response.output_item.added')).toMatchObject({
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'exec',
        arguments: '',
        status: 'in_progress',
      },
    })
    expect(events.filter((event) =>
      event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed',
    )).toHaveLength(1)
  })

  it('maps content filtering to an incomplete Responses terminal', () => {
    const codec = new ChatCompletionsToResponsesEventCodec('public-model', 123)
    codec.push({
      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'content_filter' }],
    })
    expect(codec.finish().at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      },
    })
  })
})
