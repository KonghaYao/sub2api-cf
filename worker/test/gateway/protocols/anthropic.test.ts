import { describe, expect, it } from 'vitest'
import {
  ProtocolValidationError,
  ChatCompletionsToAnthropicEventCodec,
  ResponsesToAnthropicEventCodec,
  chatCompletionsToAnthropicMessage,
  formatAnthropicSseEvent,
  mapOpenAIErrorToAnthropic,
  parseAnthropicCountTokensRequest,
  parseAnthropicMessagesRequest,
  responsesToAnthropicMessage,
  toOpenAIChatCompletionsRequest,
  toOpenAIResponsesRequest,
  toOpenAIResponsesInputTokensRequest,
} from '../../../src/gateway/protocols/anthropic'

describe('Anthropic Messages request codec', () => {
  it('converts count_tokens without generation-only fields and permits an empty conversation', () => {
    const request = parseAnthropicCountTokensRequest({
      model: 'claude-public',
      system: 'Be concise.',
      messages: [],
      max_tokens: 999,
      stream: true,
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    })

    expect(toOpenAIResponsesInputTokensRequest(request, 'gpt-upstream')).toEqual({
      model: 'gpt-upstream',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Be concise.' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object' },
          strict: false,
        },
      ],
    })
  })

  it('converts text and structured system content to a Responses request', () => {
    const anthropic = parseAnthropicMessagesRequest({
      model: 'claude-public',
      max_tokens: 64,
      stream: true,
      system: [
        { type: 'text', text: 'Be concise.' },
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(toOpenAIResponsesRequest(anthropic, 'gpt-upstream')).toEqual({
      model: 'gpt-upstream',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Be concise.' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }],
        },
      ],
      max_output_tokens: 128,
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', summary: 'auto' },
      text: { verbosity: 'medium' },
    })
  })

  it('rejects unknown request and content fields instead of forwarding them', () => {
    expect(() =>
      parseAnthropicMessagesRequest({
        model: 'claude-public',
        max_tokens: 128,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', secret: 'nope' }] }],
        upstream_override: 'leak-me',
      }),
    ).toThrowError(ProtocolValidationError)
  })

  it('preserves tool_use/tool_result pairing for Responses and Chat', () => {
    const anthropic = parseAnthropicMessagesRequest({
      model: 'claude-public',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny', is_error: false },
          ],
        },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      tool_choice: { type: 'tool', name: 'get_weather' },
    })

    const responses = toOpenAIResponsesRequest(anthropic, 'gpt-upstream')
    expect(responses.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
      { type: 'function_call', call_id: 'toolu_1', name: 'get_weather', arguments: '{"city":"NYC"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'Sunny' },
    ])
    expect(responses.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        strict: false,
      },
    ])
    expect(responses.tool_choice).toEqual({ type: 'function', name: 'get_weather' })

    expect(toOpenAIChatCompletionsRequest(anthropic, 'chat-upstream')).toMatchObject({
      model: 'chat-upstream',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: 'Checking.',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: 'tool', content: 'Sunny', tool_call_id: 'toolu_1' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
            strict: false,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    })
  })
})

describe('Responses SSE to Anthropic Messages codec', () => {
  it('converts text events and emits one valid terminal sequence', () => {
    const codec = new ResponsesToAnthropicEventCodec('claude-public')
    const events = [
      ...codec.push({
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-upstream-secret' },
      }),
      ...codec.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      ...codec.push({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' }),
      ...codec.push({ type: 'response.output_text.done', output_index: 0 }),
      ...codec.push({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 4 },
          },
        },
      }),
    ]

    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[0]).toMatchObject({
      message: {
        id: 'resp_1',
        model: 'claude-public',
        stop_reason: null,
      },
    })
    expect(events[2]).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    })
    expect(events[4]).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4,
      },
    })
    expect(codec.finish()).toEqual([])
    expect(JSON.stringify(events)).not.toContain('gpt-upstream-secret')
    expect(formatAnthropicSseEvent(events[2])).toBe(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    )
  })

  it('synthesizes tool_use termination when a Responses stream is truncated', () => {
    const codec = new ResponsesToAnthropicEventCodec('claude-public')
    codec.push({ type: 'response.created', response: { id: 'resp_tool' } })
    expect(
      codec.push({
        type: 'response.output_item.added',
        output_index: 3,
        item: { type: 'function_call', call_id: 'toolu_9', name: 'lookup' },
      }),
    ).toEqual([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_9', name: 'lookup', input: {} },
      },
    ])
    expect(
      codec.push({
        type: 'response.function_call_arguments.delta',
        output_index: 3,
        delta: '{"id":9}',
      }),
    ).toEqual([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"id":9}' },
      },
    ])

    expect(codec.finish().map((event) => event.type)).toEqual([
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(codec.finish()).toEqual([])
  })
})

describe('Chat Completions SSE to Anthropic Messages codec', () => {
  it('converts text, usage, and finish reason with an explicit finalizer', () => {
    const codec = new ChatCompletionsToAnthropicEventCodec('claude-public')
    const events = [
      ...codec.push({
        id: 'chat_stream_1',
        model: 'chat-upstream-secret',
        choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
      }),
      ...codec.push({
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      }),
      ...codec.finish(),
    ]

    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[0]).toMatchObject({ message: { id: 'chat_stream_1', model: 'claude-public' } })
    expect(events[4]).toMatchObject({
      delta: { stop_reason: 'max_tokens' },
      usage: { input_tokens: 7, output_tokens: 2 },
    })
    expect(JSON.stringify(events)).not.toContain('chat-upstream-secret')
  })

  it('converts fragmented Chat tool calls to Anthropic tool blocks', () => {
    const codec = new ChatCompletionsToAnthropicEventCodec('claude-public')
    const events = [
      ...codec.push({
        id: 'chat_stream_tool',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'toolu_3',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"id":' },
                },
              ],
            },
          },
        ],
      }),
      ...codec.push({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '3}' } }] } }],
      }),
      ...codec.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...codec.finish(),
    ]

    expect(events).toContainEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_3', name: 'lookup', input: {} },
    })
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"id":' },
    })
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '3}' },
    })
    expect(events.at(-2)).toMatchObject({ delta: { stop_reason: 'tool_use' } })
  })
})

describe('Anthropic Messages response codec', () => {
  it('maps Responses text, tools, stop reason, and usage without exposing the upstream model', () => {
    const result = responsesToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-upstream-secret',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Checking.' }],
          },
          {
            type: 'function_call',
            call_id: 'toolu_1',
            name: 'get_weather',
            arguments: '{"city":"NYC"}',
          },
        ],
        usage: {
          input_tokens: 120,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
        },
        internal_trace: 'must-not-leak',
      },
      'claude-public',
    )

    expect(result).toEqual({
      id: 'resp_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-public',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 30,
        output_tokens: 12,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 80,
      },
    })
    expect(JSON.stringify(result)).not.toContain('gpt-upstream-secret')
    expect(JSON.stringify(result)).not.toContain('internal_trace')
  })

  it('maps Responses max-output termination and Chat completion semantics', () => {
    expect(
      responsesToAnthropicMessage(
        {
          id: 'resp_2',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial' }] }],
          usage: { input_tokens: 4, output_tokens: 2 },
        },
        'claude-public',
      ).stop_reason,
    ).toBe('max_tokens')

    expect(
      chatCompletionsToAnthropicMessage(
        {
          id: 'chat_1',
          model: 'chat-upstream-secret',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'toolu_2',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"id":7}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 3 },
        },
        'claude-public',
      ),
    ).toMatchObject({
      id: 'chat_1',
      model: 'claude-public',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'lookup', input: { id: 7 } }],
      usage: { input_tokens: 9, output_tokens: 3 },
    })
  })

  it('maps upstream errors to a bounded Anthropic error envelope', () => {
    const result = mapOpenAIErrorToAnthropic(429, {
      error: {
        type: 'rate_limit_error',
        message: 'model gpt-upstream-secret exhausted; key sk-secret',
      },
    })
    expect(result).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'The service is rate limited. Please retry later.',
      },
    })
    expect(JSON.stringify(result)).not.toContain('gpt-upstream-secret')
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })
})
