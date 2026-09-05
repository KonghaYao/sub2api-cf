import { describe, expect, it } from 'vitest'
import {
  ChatCompletionsToResponsesEventCodec,
  ResponsesBridgeError,
  chatCompletionsResponseToResponses,
  formatResponsesSseEvent,
  parseResponsesRequest,
  responsesToChatCompletionsRequest,
} from '../../../src/gateway/protocols/responses'

describe('Responses request to Chat Completions', () => {
  it('normalizes fast and accepts scale while keeping null as omission', () => {
    expect(parseResponsesRequest({
      model: 'public-model', input: 'hello', service_tier: '  FAST ',
    }).service_tier).toBe('priority')
    expect(parseResponsesRequest({
      model: 'public-model', input: 'hello', service_tier: 'scale',
    }).service_tier).toBe('scale')
    expect(parseResponsesRequest({
      model: 'public-model', input: 'hello', service_tier: null,
    }).service_tier).toBeUndefined()
  })

  it('maps public controls through an allow-listed request shape', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      instructions: 'Be concise.',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Return JSON.' }],
        },
        { type: 'message', role: 'user', content: 'Hello' },
      ],
      max_output_tokens: 321,
      temperature: 0.25,
      top_p: 0.8,
      stream: true,
      service_tier: 'priority',
      parallel_tool_calls: false,
      reasoning: { effort: 'high', summary: 'auto' },
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          strict: true,
        },
      },
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look something up',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          strict: true,
        },
      ],
      tool_choice: { type: 'function', name: 'lookup' },
      store: false,
      include: ['reasoning.encrypted_content'],
    })

    expect(responsesToChatCompletionsRequest(request, 'upstream-model')).toEqual({
      model: 'upstream-model',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'system', content: 'Return JSON.' },
        { role: 'user', content: 'Hello' },
      ],
      max_completion_tokens: 321,
      temperature: 0.25,
      top_p: 0.8,
      stream: true,
      stream_options: { include_usage: true },
      service_tier: 'priority',
      parallel_tool_calls: false,
      reasoning_effort: 'high',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          strict: true,
        },
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look something up',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
            strict: true,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    })
  })

  it('rejects unknown controls and malformed function schemas instead of forwarding them', () => {
    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: 'hello',
      upstream_url: 'https://attacker.invalid',
    })).toThrowError(ResponsesBridgeError)

    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: 'hello',
      tools: [{ type: 'function', name: 'lookup', parameters: 'not-an-object' }],
    })).toThrowError('$.tools[0].parameters')
  })

  it('normalizes parallel tool history into adjacent answered Chat messages', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      instructions: 'Use project instructions.',
      input: [
        { type: 'message', role: 'user', content: 'Inspect the repo.' },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'run both commands' }],
          encrypted_content: 'opaque-not-forwarded',
        },
        { type: 'function_call', call_id: 'call_log', name: 'exec', arguments: '{"cmd":"git log"}' },
        { type: 'function_call', call_id: 'call_tag', name: 'exec', arguments: '{"cmd":"git tag"}' },
        {
          type: 'message',
          role: 'developer',
          content: 'Approved command prefix saved.',
        },
        { type: 'web_search_call', id: 'ignored-server-item', status: 'completed' },
        { type: 'function_call_output', call_id: 'call_tag', output: 'v1.0.0' },
        { type: 'function_call_output', call_id: 'call_log', output: 'deadbeef' },
        { type: 'function_call', call_id: 'dangling', name: 'exec', arguments: '{}' },
        { type: 'function_call_output', call_id: 'orphan', output: 'must not leak' },
      ],
    })

    expect(responsesToChatCompletionsRequest(request, 'upstream-model').messages).toEqual([
      { role: 'system', content: 'Use project instructions.' },
      { role: 'user', content: 'Inspect the repo.' },
      {
        role: 'assistant',
        reasoning_content: 'run both commands',
        tool_calls: [
          {
            id: 'call_log',
            type: 'function',
            function: { name: 'exec', arguments: '{"cmd":"git log"}' },
          },
          {
            id: 'call_tag',
            type: 'function',
            function: { name: 'exec', arguments: '{"cmd":"git tag"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_log', content: 'deadbeef' },
      { role: 'tool', tool_call_id: 'call_tag', content: 'v1.0.0' },
      { role: 'system', content: 'Approved command prefix saved.' },
    ])
  })

  it('moves image tool output into a following multimodal user message', () => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        {
          type: 'function_call',
          call_id: 'call_image',
          name: 'view_image',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_image',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
        },
      ],
    })

    expect(responsesToChatCompletionsRequest(request, 'upstream-model').messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_image',
          type: 'function',
          function: { name: 'view_image', arguments: '{}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_image',
        content: '[{"type":"input_text","text":"[Tool output media moved to the following user message]"}]',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Tool output media for call call_image]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
        ],
      },
    ])
  })

  it.each([
    {
      name: 'nested image URL',
      call: { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
      outputType: 'function_call_output',
      output: [
        { type: 'input_text', text: 'render complete' },
        { type: 'image_url', image_url: { url: 'https://example.com/tool-output.png' } },
      ],
      expectedUrl: 'https://example.com/tool-output.png',
    },
    {
      name: 'JSON string output',
      call: { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
      outputType: 'function_call_output',
      output: '[{"type":"input_image","image_url":"data:image/png;base64,AQID"}]',
      expectedUrl: 'data:image/png;base64,AQID',
    },
    {
      name: 'bare image data URL',
      call: { type: 'custom_tool_call', call_id: 'call_image', name: 'view_image', input: '{}' },
      outputType: 'custom_tool_call_output',
      output: 'data:image/jpeg;base64,BAUG',
      expectedUrl: 'data:image/jpeg;base64,BAUG',
    },
    {
      name: 'tool search output',
      call: { type: 'tool_search_call', call_id: 'call_image', arguments: { query: 'image' } },
      outputType: 'tool_search_output',
      output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
      expectedUrl: 'data:image/png;base64,AQID',
    },
  ])('extracts supported $name without leaking its URL into tool content', ({
    call,
    outputType,
    output,
    expectedUrl,
  }) => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [call, { type: outputType, call_id: 'call_image', output }],
    })

    const messages = responsesToChatCompletionsRequest(request, 'upstream-model').messages
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'user'])
    expect(messages[1]?.content).not.toContain(expectedUrl)
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[Tool output media for call call_image]' },
        { type: 'image_url', image_url: { url: expectedUrl } },
      ],
    })
  })

  it('orders parallel tool replies and media by call order rather than output arrival order', () => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_A', name: 'view_image', arguments: '{}' },
        { type: 'function_call', call_id: 'call_B', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_B',
          output: [{ type: 'input_image', image_url: { url: 'https://example.com/b.png' } }],
        },
        {
          type: 'function_call_output',
          call_id: 'call_A',
          output: [{ type: 'input_image', image_url: { url: 'https://example.com/a.png' } }],
        },
      ],
    })

    const messages = responsesToChatCompletionsRequest(request, 'upstream-model').messages
    expect(messages[0]?.tool_calls).toEqual([
      expect.objectContaining({ id: 'call_A' }),
      expect.objectContaining({ id: 'call_B' }),
    ])
    expect(messages.slice(1, 3).map((message) => message.tool_call_id)).toEqual(['call_A', 'call_B'])
    expect(messages[3]?.content).toEqual([
      { type: 'text', text: '[Tool output media for call call_A]' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'text', text: '[Tool output media for call call_B]' },
      { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
    ])
  })

  it('places extracted media before interleaved developer and user messages', () => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_A', name: 'view_image', arguments: '{}' },
        { type: 'message', role: 'developer', content: 'approval saved' },
        { type: 'message', role: 'user', content: 'continue' },
        {
          type: 'function_call_output',
          call_id: 'call_A',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
        },
      ],
    })

    const messages = responsesToChatCompletionsRequest(request, 'upstream-model').messages
    expect(messages.map((message) => message.role)).toEqual([
      'assistant', 'tool', 'user', 'system', 'user',
    ])
    expect(messages[2]?.content).toEqual([
      { type: 'text', text: '[Tool output media for call call_A]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ])
    expect(messages[3]?.content).toBe('approval saved')
    expect(messages[4]?.content).toBe('continue')
  })

  it('drops orphan output media and media for unanswered parallel calls', () => {
    const orphan = parseResponsesRequest({
      model: 'vision-model',
      input: [{
        type: 'function_call_output',
        call_id: 'call_ghost',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
      }],
    })
    expect(responsesToChatCompletionsRequest(orphan, 'upstream-model').messages).toEqual([])

    const unanswered = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_A', name: 'view_image', arguments: '{}' },
        { type: 'function_call', call_id: 'call_B', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_A',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
        },
      ],
    })
    const messages = responsesToChatCompletionsRequest(unanswered, 'upstream-model').messages
    expect(messages[0]?.tool_calls).toEqual([
      expect.objectContaining({ id: 'call_A' }),
    ])
    expect(JSON.stringify(messages)).not.toContain('call_B')
  })

  it.each([
    '{"type":"result","url":"https://example.com/result","extra":{"count":2}}',
    '[ { "type": "input_text", "text": "ok" }, {"unknown":true} ]',
    'plain output',
    '{ "ok": true }',
    'prefix data:image/png;base64,AQID suffix',
  ])('preserves media-free tool output bytes: %s', (mediaFreeOutput) => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_text', name: 'exec', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_text', output: mediaFreeOutput },
      ],
    })

    const messages = responsesToChatCompletionsRequest(request, 'upstream-model').messages
    expect(messages).toHaveLength(2)
    expect(messages[1]?.content).toBe(mediaFreeOutput)
  })

  it('removes extracted media URLs from every tool output family in one batch', () => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_function', name: 'view_image', arguments: '{}' },
        { type: 'custom_tool_call', call_id: 'call_custom', name: 'custom_image', input: '{}' },
        { type: 'tool_search_call', call_id: 'call_search', arguments: { query: 'image' } },
        {
          type: 'function_call_output',
          call_id: 'call_function',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_custom',
          output: { content: [{ type: 'image_url', image_url: { url: 'https://example.com/custom.png' } }] },
        },
        {
          type: 'tool_search_output',
          call_id: 'call_search',
          output: 'data:image/jpeg;base64,BAUG',
        },
      ],
    })

    const messages = responsesToChatCompletionsRequest(request, 'upstream-model').messages
    const toolMessages = messages.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(3)
    for (const message of toolMessages) {
      expect(String(message.content)).not.toContain('data:image/')
      expect(String(message.content)).not.toContain('https://example.com/custom.png')
    }
    expect(messages.map((message) => message.role)).toEqual([
      'assistant', 'tool', 'tool', 'tool', 'user',
    ])
  })

  it('rewrites only image nodes while preserving rich sibling tool output', () => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_image',
          output: {
            status: 'ok',
            content: [
              {
                type: 'result',
                url: 'https://example.com/result',
                score: 0.9,
                text: 'complete',
                extra: { count: 2 },
              },
              { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
            ],
            unknown: { large: 9_007_199_254_740_991 },
          },
        },
      ],
    })

    const messages = responsesToChatCompletionsRequest(request, 'upstream-model').messages
    expect(JSON.parse(String(messages[1]?.content))).toEqual({
      status: 'ok',
      content: [
        {
          type: 'result',
          url: 'https://example.com/result',
          score: 0.9,
          text: 'complete',
          extra: { count: 2 },
        },
        { type: 'input_text', text: '[Tool output media moved to the following user message]' },
      ],
      unknown: { large: 9_007_199_254_740_991 },
    })
  })

  it('preserves unsafe integer lexemes while extracting nested tool media', () => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_image',
          output: '{"status":"ok","content":[{"type":"input_image","image_url":"data:image/png;base64,AQID"}],"unknown":{"large":9007199254740993}}',
        },
      ],
    })

    const toolContent = String(
      responsesToChatCompletionsRequest(request, 'upstream-model').messages[1]?.content,
    )
    expect(toolContent).toContain('"large":9007199254740993')
    expect(toolContent).not.toContain('9007199254740992')
  })

  it('uses the latest duplicate tool output and clears stale media', () => {
    const request = parseResponsesRequest({
      model: 'vision-model',
      input: [
        { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_image',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
        },
        { type: 'function_call_output', call_id: 'call_image', output: 'latest text' },
      ],
    })

    expect(responsesToChatCompletionsRequest(request, 'upstream-model').messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_image',
          type: 'function',
          function: { name: 'view_image', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_image', content: 'latest text' },
    ])
  })

  it('rejects truncated historical tool arguments before they poison the upstream turn', () => {
    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: [
        {
          type: 'function_call',
          call_id: 'call_bad',
          name: 'exec',
          arguments: '{"cmd":"ssh root@host',
        },
      ],
    })).toThrowError('$.input[0].arguments')

    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: [{ type: 'function_call_output', call_id: 'call_missing' }],
    })).toThrowError(ResponsesBridgeError)
  })
})

describe('Chat Completions response to Responses', () => {
  it('preserves reasoning, valid tools, usage, status and service tier without upstream names', () => {
    const converted = chatCompletionsResponseToResponses(
      {
        id: 'chatcmpl_123',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'private-upstream-model',
        service_tier: 'priority',
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: 'Partial answer',
              reasoning_content: 'I checked both sources.',
              tool_calls: [
                {
                  id: 'call_ok',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"one"}' },
                },
                {
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"truncated' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 7,
          total_tokens: 27,
          prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      },
      'public-model',
      1_800_000_000,
    )

    expect(converted).toEqual({
      id: 'chatcmpl_123',
      object: 'response',
      created_at: 1_700_000_000,
      model: 'public-model',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      service_tier: 'priority',
      output: [
        {
          type: 'reasoning',
          id: expect.stringMatching(/^rs_/),
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'I checked both sources.' }],
        },
        {
          type: 'message',
          id: expect.stringMatching(/^msg_/),
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Partial answer' }],
        },
        {
          type: 'function_call',
          id: expect.stringMatching(/^fc_/),
          call_id: 'call_ok',
          name: 'lookup',
          arguments: '{"q":"one"}',
          status: 'completed',
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        total_tokens: 27,
        cache_creation_input_tokens: 3,
        input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 5 },
      },
    })
    expect(JSON.stringify(converted)).not.toContain('private-upstream-model')
    expect(JSON.stringify(converted)).not.toContain('call_bad')
  })

  it('makes a reasoning-only answer visible but does not duplicate it beside tool calls', () => {
    const reasoningOnly = chatCompletionsResponseToResponses({
      id: 'chat_reasoning',
      created: 0,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '', reasoning: 'reasoning-only answer' },
      }],
    }, 'public-model', 123)
    expect(reasoningOnly.created_at).toBe(123)
    expect(reasoningOnly.output.map((item) => item.type)).toEqual(['reasoning', 'message'])
    expect(reasoningOnly.output[1]).toMatchObject({
      content: [{ type: 'output_text', text: 'reasoning-only answer' }],
    })

    const withTool = chatCompletionsResponseToResponses({
      id: 'chat_tool',
      created: 123,
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'call a tool',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          }],
        },
      }],
    }, 'public-model', 123)
    expect(withTool.output.map((item) => item.type)).toEqual(['reasoning', 'function_call'])
  })

  it('maps an assistant refusal to a Responses refusal content item', () => {
    const converted = chatCompletionsResponseToResponses({
      id: 'chat_refusal',
      created: 123,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: null,
          refusal: 'I cannot help with that request.',
        },
      }],
    }, 'public-model', 123)

    expect(converted.output).toEqual([{
      type: 'message',
      id: expect.stringMatching(/^msg_/),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'refusal', refusal: 'I cannot help with that request.' }],
    }])
  })
})

describe('Chat Completions SSE to Responses', () => {
  it('emits ordered reasoning, text, tool and terminal lifecycles exactly once', () => {
    const codec = new ChatCompletionsToResponsesEventCodec('public-model', 1_700_000_000)
    const events = [
      ...codec.push({
        id: 'chatcmpl_stream',
        object: 'chat.completion.chunk',
        created: 1_699_999_999,
        model: 'private-model',
        service_tier: 'flex',
        choices: [{
          index: 0,
          delta: { role: 'assistant', reasoning_content: 'plan' },
          finish_reason: null,
        }],
      }),
      ...codec.push({
        choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }],
      }),
      ...codec.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'exec', arguments: '{"cmd":' },
            }],
          },
          finish_reason: null,
        }],
      }),
      ...codec.push({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
      ...codec.finish(),
    ]

    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ])
    expect(events.map((event) => event.sequence_number)).toEqual(
      Array.from({ length: events.length }, (_, index) => index),
    )

    const reasoningDelta = events.find((event) => event.type === 'response.reasoning_summary_text.delta')!
    const reasoningAdded = events.find((event) =>
      event.type === 'response.output_item.added' && event.item?.type === 'reasoning')!
    expect(reasoningDelta.output_index).toBe(reasoningAdded.output_index)

    const toolAdded = events.find((event) =>
      event.type === 'response.output_item.added' && event.item?.type === 'function_call')!
    expect(toolAdded.item).toMatchObject({
      call_id: 'call_a',
      name: 'exec',
      arguments: '',
      status: 'in_progress',
    })
    const argsDone = events.find((event) => event.type === 'response.function_call_arguments.done')!
    expect(argsDone.arguments).toBe('{"cmd":"ls"}')

    const terminal = events.at(-1)!
    expect(terminal).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'chatcmpl_stream',
        created_at: 1_699_999_999,
        model: 'public-model',
        status: 'completed',
        service_tier: 'flex',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
          { type: 'function_call', call_id: 'call_a', arguments: '{"cmd":"ls"}' },
        ],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      },
    })
    expect(codec.finish()).toEqual([])
    expect(JSON.stringify(events)).not.toContain('private-model')
    expect(formatResponsesSseEvent(toolAdded)).toMatch(
      /^event: response\.output_item\.added\ndata: .*"arguments":"".*\n\n$/,
    )
  })

  it.each([
    ['length', 'max_output_tokens'],
    ['content_filter', 'content_filter'],
  ] as const)('emits response.incomplete for an upstream %s finish', (finishReason, incompleteReason) => {
    const codec = new ChatCompletionsToResponsesEventCodec('public-model', 123)
    const events = [
      ...codec.push({
        id: 'chat_incomplete',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: 'Partial answer' },
          finish_reason: finishReason,
        }],
      }),
      ...codec.finish(),
    ]

    expect(events.some((event) => event.type === 'response.completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: incompleteReason },
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Partial answer' }],
        }],
      },
    })
  })

  it('emits a complete refusal content-part lifecycle without dropping delta.refusal', () => {
    const codec = new ChatCompletionsToResponsesEventCodec('public-model', 123)
    const events = [
      ...codec.push({
        id: 'chat_refusal_stream',
        choices: [{
          index: 0,
          delta: { role: 'assistant', refusal: 'I cannot ' },
          finish_reason: null,
        }],
      }),
      ...codec.push({
        choices: [{
          index: 0,
          delta: { refusal: 'help with that.' },
          finish_reason: 'stop',
        }],
      }),
      ...codec.finish(),
    ]

    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.refusal.delta',
      'response.refusal.delta',
      'response.refusal.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    expect(events.map((event) => event.sequence_number)).toEqual(
      Array.from({ length: events.length }, (_, index) => index),
    )
    expect(events.at(-1)).toMatchObject({
      response: {
        status: 'completed',
        output: [{
          type: 'message',
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        }],
      },
    })
  })

  it('rejects truncated tool deltas and maps an upstream error to one failed terminal', () => {
    const invalid = new ChatCompletionsToResponsesEventCodec('public-model', 123)
    invalid.push({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_bad',
            type: 'function',
            function: { name: 'exec', arguments: '{"cmd":"truncated' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(() => invalid.finish()).toThrowError('arguments contain invalid JSON')

    const failed = new ChatCompletionsToResponsesEventCodec('public-model', 123)
    const events = failed.push({
      error: { type: 'server_error', code: null, message: 'Upstream failed' },
    })
    expect(events.map((event) => event.type)).toEqual(['response.created', 'response.failed'])
    expect(events[1]).toMatchObject({
      response: {
        status: 'failed',
        error: { code: 'server_error', message: 'Upstream failed' },
      },
    })
    expect(failed.finish()).toEqual([])
  })
})
