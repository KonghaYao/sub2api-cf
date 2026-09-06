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
      temperature: 0.4,
      top_p: 0.9,
      top_k: 20,
      stop_sequences: ['END'],
      metadata: { user_id: 'count-client' },
      thinking: { type: 'enabled', budget_tokens: 4096 },
      output_config: { effort: 'high' },
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
      max_output_tokens: 64,
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', summary: 'auto' },
      text: { verbosity: 'medium' },
    })
  })

  it('retains Anthropic generation controls and maps output effort safely', () => {
    const anthropic = parseAnthropicMessagesRequest({
      model: 'claude-public',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'Think carefully.' }],
      temperature: 0.25,
      top_p: 0.8,
      top_k: 40,
      stop_sequences: ['END'],
      metadata: { user_id: 'customer-42' },
      thinking: { type: 'enabled', budget_tokens: 4096 },
      output_config: { effort: 'max' },
    })

    expect(anthropic).toMatchObject({
      temperature: 0.25,
      top_p: 0.8,
      top_k: 40,
      stop_sequences: ['END'],
      metadata: { user_id: 'customer-42' },
      thinking: { type: 'enabled', budget_tokens: 4096 },
      output_config: { effort: 'max' },
    })
    expect(toOpenAIResponsesRequest(anthropic, 'gpt-5.4')).not.toHaveProperty('temperature')
    expect(toOpenAIResponsesRequest(anthropic, 'gpt-5.4')).toMatchObject({
      reasoning: { effort: 'xhigh', summary: 'auto' },
    })
    expect(toOpenAIChatCompletionsRequest(anthropic, 'third-party-model')).toMatchObject({
      temperature: 0.25,
      top_p: 0.8,
      reasoning_effort: 'xhigh',
    })
  })

  it('rejects malformed Anthropic generation controls', () => {
    const base = {
      model: 'claude-public',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Hello' }],
    }

    expect(() => parseAnthropicMessagesRequest({ ...base, temperature: 1.1 }))
      .toThrowError(/\$\.temperature/)
    expect(() => parseAnthropicMessagesRequest({ ...base, thinking: { type: 'enabled' } }))
      .toThrowError(/budget_tokens/)
    expect(() => parseAnthropicMessagesRequest({ ...base, output_config: { effort: 'ultra' } }))
      .toThrowError(/output_config\.effort/)
    expect(() => parseAnthropicMessagesRequest({ ...base, metadata: { email: 'secret@example.com' } }))
      .toThrowError(/metadata\.email/)
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

  it('lifts tool-result images into a following multimodal user message', () => {
    const anthropic = parseAnthropicMessagesRequest({
      model: 'claude-public',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Read the screenshot.' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'view_image',
            input: { path: '/tmp/screen.png' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'render complete' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
              },
            ],
          }],
        },
      ],
    })

    expect(toOpenAIResponsesRequest(anthropic, 'gpt-upstream').input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Read the screenshot.' }],
      },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'view_image',
        arguments: '{"path":"/tmp/screen.png"}',
      },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'render complete' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }],
      },
    ])

    expect(toOpenAIChatCompletionsRequest(anthropic, 'chat-upstream').messages).toEqual([
      { role: 'user', content: 'Read the screenshot.' },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'toolu_1',
          type: 'function',
          function: { name: 'view_image', arguments: '{"path":"/tmp/screen.png"}' },
        }],
      },
      { role: 'tool', content: 'render complete', tool_call_id: 'toolu_1' },
      {
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aGVsbG8=' },
        }],
      },
    ])
  })

  it('keeps an image-only tool result paired with an empty textual output', () => {
    const anthropic = parseAnthropicMessagesRequest({
      model: 'claude-public',
      max_tokens: 128,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'view_image', input: {} }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: '', data: 'iVBOR' },
            }],
          }],
        },
      ],
    })

    expect(toOpenAIResponsesRequest(anthropic, 'gpt-upstream').input).toEqual([
      { type: 'function_call', call_id: 'toolu_2', name: 'view_image', arguments: '{}' },
      { type: 'function_call_output', call_id: 'toolu_2', output: '(empty)' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBOR' }],
      },
    ])
  })
})

describe('Responses SSE to Anthropic Messages codec', () => {
  it('wraps custom input as valid Anthropic tool JSON and flattens namespace names', () => {
    const codec = new ResponsesToAnthropicEventCodec('claude-public')
    const events = [
      ...codec.push({ type: 'response.created', response: { id: 'resp_tools' } }),
      ...codec.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'custom_tool_call', call_id: 'call_custom', name: 'shell' },
      }),
      ...codec.push({
        type: 'response.custom_tool_call_input.delta',
        output_index: 0,
        delta: 'p',
      }),
      ...codec.push({
        type: 'response.custom_tool_call_input.delta',
        output_index: 0,
        delta: 'wd',
      }),
      ...codec.push({
        type: 'response.custom_tool_call_input.done',
        output_index: 0,
        input: 'pwd',
      }),
      ...codec.push({
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          call_id: 'call_namespace',
          namespace: 'team',
          name: 'send',
        },
      }),
      ...codec.push({
        type: 'response.function_call_arguments.done',
        output_index: 1,
        arguments: '{"message":"hi"}',
      }),
      ...codec.push({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } },
      }),
    ]

    expect(events).toContainEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_custom', name: 'shell', input: {} },
    })
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"input":"pwd"}' },
    })
    expect(events).toContainEqual({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call_namespace', name: 'team__send', input: {} },
    })
    expect(events.at(-2)).toMatchObject({ delta: { stop_reason: 'tool_use' } })
  })

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

  it('emits streamed tool arguments exactly once when done includes the full value', () => {
    const codec = new ResponsesToAnthropicEventCodec('claude-public')
    const events = [
      ...codec.push({ type: 'response.created', response: { id: 'resp_tool' } }),
      ...codec.push({
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', call_id: 'toolu_weather', name: 'weather' },
      }),
      ...codec.push({
        type: 'response.function_call_arguments.delta',
        output_index: 2,
        delta: '{"city":',
      }),
      ...codec.push({
        type: 'response.function_call_arguments.delta',
        output_index: 2,
        delta: '"Paris"}',
      }),
      ...codec.push({
        type: 'response.function_call_arguments.done',
        output_index: 2,
        arguments: '{"city":"Paris"}',
      }),
      ...codec.push({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ]

    const partialJson = events.flatMap((event) => {
      if (event.type !== 'content_block_delta') return []
      const delta = event.delta as Record<string, unknown>
      return delta.type === 'input_json_delta' && typeof delta.partial_json === 'string'
        ? [delta.partial_json]
        : []
    }).join('')
    expect(partialJson).toBe('{"city":"Paris"}')
    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
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
  it('maps buffered custom and namespace calls to stable Anthropic tool_use blocks', () => {
    const result = responsesToAnthropicMessage(
      {
        id: 'resp_tools',
        status: 'completed',
        output: [
          {
            type: 'custom_tool_call',
            id: 'ctc_1',
            call_id: 'call_custom',
            name: 'shell',
            input: 'pwd',
            dangerous: 'drop-me',
          },
          {
            type: 'function_call',
            id: 'fc_2',
            call_id: 'call_namespace',
            namespace: 'team',
            name: 'send',
            arguments: '{"message":"hi"}',
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      'claude-public',
    )

    expect(result).toMatchObject({
      content: [
        { type: 'tool_use', id: 'call_custom', name: 'shell', input: { input: 'pwd' } },
        {
          type: 'tool_use',
          id: 'call_namespace',
          name: 'team__send',
          input: { message: 'hi' },
        },
      ],
      stop_reason: 'tool_use',
    })
    expect(JSON.stringify(result)).not.toContain('dangerous')
  })

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
