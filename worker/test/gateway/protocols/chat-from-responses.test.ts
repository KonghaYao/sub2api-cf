import { describe, expect, it } from 'vitest'
import {
  ResponsesToChatCompletionsEventCodec,
  responsesSseToChatCompletionsResponse,
  responsesToChatCompletionsResponse,
} from '../../../src/gateway/protocols/chat-from-responses'

describe('Responses to Chat Completions output bridge', () => {
  it('converts buffered text, reasoning, tools, usage details and service tier', () => {
    expect(responsesToChatCompletionsResponse({
      id: 'resp_buffered',
      status: 'completed',
      service_tier: 'priority',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'check the weather' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Calling a tool.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_weather',
          name: 'get_weather',
          arguments: '{"city":"Shanghai"}',
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 7, audio_tokens: 2 },
        output_tokens_details: {
          reasoning_tokens: 4,
          accepted_prediction_tokens: 1,
        },
      },
    }, 'public-model', 1_700_000_000)).toEqual({
      id: 'resp_buffered',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'public-model',
      service_tier: 'priority',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Calling a tool.',
          reasoning_content: 'check the weather',
          tool_calls: [{
            id: 'call_weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
        prompt_tokens_details: { cached_tokens: 7, audio_tokens: 2 },
        completion_tokens_details: {
          reasoning_tokens: 4,
          accepted_prediction_tokens: 1,
        },
      },
    })
  })

  it('maps an incomplete content-filter response to the matching finish reason', () => {
    const response = responsesToChatCompletionsResponse({
      id: 'resp_filtered',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    }, 'public-model', 123)

    expect(response.choices[0]?.finish_reason).toBe('content_filter')
    expect(response.choices[0]?.message.content).toBe('partial')
  })

  it('rejects missing and failed terminal statuses instead of fabricating a success', () => {
    expect(() => responsesToChatCompletionsResponse({
      id: 'resp_failed',
      status: 'failed',
      output: [],
    }, 'public-model')).toThrowError('Upstream Responses request failed')

    expect(() => responsesToChatCompletionsResponse({
      id: 'resp_missing',
      output: [],
    }, 'public-model')).toThrowError('Upstream Responses request failed')
  })

  it('preserves an upstream failure code and message', () => {
    let failure: unknown
    try {
      responsesToChatCompletionsResponse({
        id: 'resp_cyber',
        status: 'failed',
        output: [],
        error: { code: 'cyber_policy', message: 'flagged by policy' },
      }, 'public-model')
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'ResponsesToChatError',
      upstreamCode: 'cyber_policy',
      message: 'flagged by policy',
    })
  })

  it('converts streaming role, reasoning, text, tool and terminal usage exactly once', () => {
    const codec = new ResponsesToChatCompletionsEventCodec('public-model', true, 456)

    expect(codec.push({
      type: 'response.created',
      response: { id: 'resp_stream', model: 'upstream-model', service_tier: 'flex' },
    })).toEqual([{
      id: 'resp_stream',
      object: 'chat.completion.chunk',
      created: 456,
      model: 'public-model',
      service_tier: 'flex',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }])

    expect(codec.push({
      type: 'response.reasoning_summary_text.delta',
      delta: 'thinking',
    })[0]?.choices[0]?.delta).toEqual({ reasoning_content: 'thinking' })
    expect(codec.push({
      type: 'response.output_text.delta',
      delta: 'answer',
    })[0]?.choices[0]?.delta).toEqual({ content: 'answer' })
    expect(codec.push({
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'function_call', call_id: 'call_1', name: 'lookup' },
    })[0]?.choices[0]?.delta.tool_calls).toEqual([{
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '' },
    }])
    expect(codec.push({
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: '{"q":"x"}',
    })[0]?.choices[0]?.delta.tool_calls).toEqual([{
      index: 0,
      function: { arguments: '{"q":"x"}' },
    }])

    const terminal = codec.push({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 9, output_tokens: 3 },
      },
    })
    expect(terminal).toEqual([
      {
        id: 'resp_stream',
        object: 'chat.completion.chunk',
        created: 456,
        model: 'public-model',
        service_tier: 'flex',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }],
      },
      {
        id: 'resp_stream',
        object: 'chat.completion.chunk',
        created: 456,
        model: 'public-model',
        service_tier: 'flex',
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      },
    ])
    expect(codec.finish()).toEqual([])
  })

  it('assembles forced upstream SSE for a non-streaming Chat client', () => {
    const response = responsesSseToChatCompletionsResponse([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_forced","model":"upstream-model"}}',
      '',
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"plan"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hello"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_forced","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}',
      '',
    ].join('\n'), 'public-model', 789)

    expect(response).toMatchObject({
      id: 'resp_forced',
      object: 'chat.completion',
      created: 789,
      model: 'public-model',
      choices: [{
        message: { role: 'assistant', content: 'hello', reasoning_content: 'plan' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })
  })

  it('accepts compact event fields and rejects streams without a terminal event', () => {
    expect(responsesSseToChatCompletionsResponse([
      'event:response.created',
      'data:{"response":{"id":"resp_compact"}}',
      '',
      'event:response.output_text.delta',
      'data:{"delta":"compact"}',
      '',
      'event:response.completed',
      'data:{"response":{"status":"completed","output":[],',
      'data:"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
    ].join('\n'), 'public-model', 999)).toMatchObject({
      id: 'resp_compact',
      choices: [{ message: { content: 'compact' }, finish_reason: 'stop' }],
    })

    expect(() => responsesSseToChatCompletionsResponse([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_truncated"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      '',
    ].join('\n'), 'public-model')).toThrowError('terminal response event')
  })

  it('rejects either spelling of a canceled terminal stream', () => {
    for (const type of ['response.canceled', 'response.cancelled']) {
      expect(() => responsesSseToChatCompletionsResponse(
        `event:${type}\ndata:{"type":"${type}","response":{"status":"canceled"}}\n\n`,
        'public-model',
      )).toThrowError('request failed')
    }
  })
})
