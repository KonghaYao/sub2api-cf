import { describe, expect, it } from 'vitest'
import {
  ChatCompletionsToResponsesEventCodec,
  chatCompletionsResponseToResponses,
  parseResponsesRequest,
  responsesToChatCompletionsRequest,
} from '../../../src/gateway/protocols/responses'

describe('Responses client-tool compatibility', () => {
  it('lowers and restores the client tool-search proxy', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'find a deployment tool',
      tools: [{ type: 'tool_search' }, { type: 'tool_search' }],
      tool_choice: { type: 'tool_search' },
    })

    const converted = responsesToChatCompletionsRequest(request, 'upstream-model')
    expect(converted.tools).toEqual([{
      type: 'function',
      function: {
        name: 'tool_search',
        description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for tools or connectors to load.',
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of tool groups to return.',
            },
          },
          required: ['query'],
        },
        strict: false,
      },
    }])
    expect(converted.tool_choice).toEqual({
      type: 'function',
      function: { name: 'tool_search' },
    })

    const response = chatCompletionsResponseToResponses({
      id: 'chatcmpl_tool_search',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_search',
            type: 'function',
            function: { name: 'tool_search', arguments: '{"query":"deploy"}' },
          }],
        },
      }],
    }, 'public-model', 123, request.tool_mapping)
    expect(response.output).toEqual([{
      type: 'tool_search_call',
      id: expect.stringMatching(/^tsc_/),
      call_id: 'call_search',
      execution: 'client',
      arguments: { query: 'deploy' },
      status: 'completed',
    }])
  })

  it('lowers tool-search history and promotes completed discoveries', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      tools: [
        { type: 'function', name: 'static_first', parameters: { type: 'object' } },
        { type: 'tool_search' },
      ],
      input: [
        {
          type: 'tool_search_call',
          id: 'tsc_history',
          call_id: 'call_search',
          execution: 'client',
          arguments: { query: 'agents' },
          status: 'completed',
        },
        {
          type: 'tool_search_output',
          id: 'tso_history',
          call_id: 'call_search',
          execution: 'client',
          status: 'completed',
          tools: [{
            type: 'namespace',
            name: 'collaboration',
            tools: [{
              type: 'function',
              name: 'spawn_agent',
              description: 'Spawn an agent',
              parameters: { type: 'object' },
            }],
          }],
        },
      ],
    })

    const converted = responsesToChatCompletionsRequest(request, 'upstream-model')
    expect(converted.tools?.map((tool) =>
      (tool.function as { name: string }).name)).toEqual([
      'static_first',
      'tool_search',
      'collaboration__spawn_agent',
    ])
    expect(converted.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_search',
          type: 'function',
          function: { name: 'tool_search', arguments: '{"query":"agents"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_search',
        content: JSON.stringify([{
          type: 'namespace',
          name: 'collaboration',
          tools: [{
            type: 'function',
            name: 'spawn_agent',
            description: 'Spawn an agent',
            parameters: { type: 'object' },
          }],
        }]),
      },
    ])
  })

  it('emits the client tool-search SSE lifecycle without function argument events', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'find tools',
      tools: [{ type: 'tool_search' }],
    })
    const codec = new ChatCompletionsToResponsesEventCodec(
      'public-model',
      123,
      request.tool_mapping,
    )
    const events = [
      ...codec.push({
        id: 'chatcmpl_search_stream',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_search',
              type: 'function',
              function: { name: 'tool_search', arguments: '{"query":' },
            }],
          },
          finish_reason: null,
        }],
      }),
      ...codec.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"deploy"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      ...codec.finish(),
    ]

    const toolEvents = events.filter((event) =>
      event.item?.type === 'tool_search_call' ||
      event.type.startsWith('response.function_call_arguments'))
    expect(toolEvents.map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.output_item.done',
    ])
    expect(toolEvents[0]?.item).toMatchObject({
      type: 'tool_search_call',
      id: expect.stringMatching(/^tsc_/),
      call_id: 'call_search',
      execution: 'client',
      status: 'in_progress',
    })
    expect(toolEvents[1]?.item).toMatchObject({
      type: 'tool_search_call',
      id: toolEvents[0]?.item?.id,
      call_id: 'call_search',
      execution: 'client',
      arguments: { query: 'deploy' },
      status: 'completed',
    })
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { output: [toolEvents[1]?.item] },
    })
  })

  it('bounds discovery promotion and rejects executable identity conflicts', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      tools: [{ type: 'tool_search' }],
      input: [
        {
          type: 'tool_search_output',
          call_id: 'search_in_progress',
          status: 'in_progress',
          tools: [{ type: 'function', name: 'not_ready' }],
        },
        {
          type: 'tool_search_output',
          call_id: 'search_malformed',
          status: 'completed',
          tools: [{ type: 'function' }],
        },
      ],
    })
    expect(responsesToChatCompletionsRequest(request, 'upstream-model').tools)
      .toHaveLength(1)

    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: [],
      tools: [
        { type: 'tool_search' },
        { type: 'function', name: 'tool_search', parameters: {} },
      ],
    })).toThrowError('tool_search')

    expect(() => parseResponsesRequest({
      model: 'public-model',
      tools: [
        { type: 'tool_search' },
        { type: 'function', name: 'inspect', parameters: { type: 'object' } },
      ],
      input: [{
        type: 'tool_search_output',
        call_id: 'search_conflict',
        status: 'completed',
        tools: [{ type: 'function', name: 'inspect', parameters: { type: 'string' } }],
      }],
    })).toThrowError('inspect')
  })

  it('lowers a custom declaration to an allow-listed Chat function', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'run pwd',
      tools: [{
        type: 'custom',
        name: 'exec',
        description: 'Run JavaScript',
        format: { type: 'grammar', grammar: 'must-not-leak' },
        upstream_url: 'https://attacker.invalid',
      }],
      tool_choice: { type: 'custom', name: 'exec' },
    })

    expect(responsesToChatCompletionsRequest(request, 'upstream-model')).toMatchObject({
      tools: [{
        type: 'function',
        function: {
          name: 'exec',
          description: 'Run JavaScript',
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'The raw input for this tool, passed through verbatim.',
              },
            },
            required: ['input'],
            additionalProperties: false,
          },
          strict: false,
        },
      }],
      tool_choice: { type: 'function', function: { name: 'exec' } },
    })
    expect(JSON.stringify(responsesToChatCompletionsRequest(request, 'upstream-model')))
      .not.toContain('attacker.invalid')
  })

  it('flattens a namespace declaration, qualified history, and tool choice reversibly', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: [
        {
          type: 'function_call',
          id: 'fc_history',
          call_id: 'call_history',
          namespace: 'collaboration',
          name: 'send_message',
          arguments: '{"message":"continue"}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          call_id: 'call_history',
          output: 'queued',
        },
      ],
      tools: [{
        type: 'namespace',
        name: 'collaboration',
        description: 'must-not-leak',
        tools: [{
          type: 'function',
          name: 'send_message',
          description: 'Send a message',
          parameters: { type: 'object' },
          private_route: 'must-not-leak',
        }],
      }],
      tool_choice: {
        type: 'function',
        namespace: 'collaboration',
        name: 'send_message',
      },
    })

    const converted = responsesToChatCompletionsRequest(request, 'upstream-model')
    expect(converted.tools).toEqual([{
      type: 'function',
      function: {
        name: 'collaboration__send_message',
        description: 'Send a message',
        parameters: { type: 'object' },
        strict: false,
      },
    }])
    expect(converted.tool_choice).toEqual({
      type: 'function',
      function: { name: 'collaboration__send_message' },
    })
    expect(converted.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_history',
          type: 'function',
          function: {
            name: 'collaboration__send_message',
            arguments: '{"message":"continue"}',
          },
        }],
      },
      { role: 'tool', tool_call_id: 'call_history', content: 'queued' },
    ])
    expect(JSON.stringify(converted)).not.toContain('must-not-leak')
  })

  it('falls a namespace-group tool choice back to auto after flattening its children', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'delegate work',
      tools: [{
        type: 'namespace',
        name: 'collaboration',
        tools: [
          { type: 'function', name: 'spawn_agent', parameters: {} },
          { type: 'function', name: 'send_message', parameters: {} },
        ],
      }],
      tool_choice: { type: 'namespace', name: 'collaboration' },
    })

    expect(responsesToChatCompletionsRequest(request, 'upstream-model').tool_choice).toBe('auto')
  })

  it('rejects a custom/function name collision deterministically', () => {
    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [
        { type: 'custom', name: 'exec' },
        { type: 'function', name: 'exec', parameters: { type: 'object' } },
      ],
    })).toThrowError('exec')
  })

  it('rejects namespace names that flatten to an existing executable', () => {
    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [
        { type: 'function', name: 'team__send', parameters: {} },
        {
          type: 'namespace',
          name: 'team',
          tools: [{ type: 'function', name: 'send', parameters: {} }],
        },
      ],
    })).toThrowError('team__send')
  })

  it('deduplicates identical namespace children and rejects ambiguous namespace mappings', () => {
    const duplicate = parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [
        { type: 'namespace', name: 'team', tools: [{ type: 'function', name: 'send' }] },
        { type: 'namespace', name: 'team', tools: [{ type: 'function', name: 'send' }] },
      ],
    })
    expect(responsesToChatCompletionsRequest(duplicate, 'upstream-model').tools).toHaveLength(1)

    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [
        { type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'b__c' }] },
        { type: 'namespace', name: 'a__b', tools: [{ type: 'function', name: 'c' }] },
      ],
    })).toThrowError('a__b__c')
  })

  it('rejects a tool choice whose flattened mapping is missing', () => {
    expect(() => parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [{ type: 'namespace', name: 'team', tools: [{ type: 'function', name: 'wait' }] }],
      tool_choice: { type: 'function', namespace: 'team', name: 'send' },
    })).toThrowError('$.tool_choice.name')
  })

  it('lifts additional_tools without fabricating a Chat message', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: [
        'plain input is retained as a user message',
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            { type: 'custom', name: 'exec' },
            {
              type: 'namespace',
              name: 'collaboration',
              tools: [{ type: 'function', name: 'wait_agent', parameters: {} }],
            },
          ],
        },
        { type: 'message', role: 'user', content: 'continue' },
      ],
    })

    const converted = responsesToChatCompletionsRequest(request, 'upstream-model')
    expect(converted.tools?.map((tool) =>
      (tool.function as { name: string }).name)).toEqual(['exec', 'collaboration__wait_agent'])
    expect(converted.messages).toEqual([
      { role: 'user', content: 'plain input is retained as a user message' },
      { role: 'user', content: 'continue' },
    ])
  })

  it('lowers custom call history while preserving call pairing', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      tools: [{ type: 'custom', name: 'exec' }],
      input: [
        { role: 'user', content: 'list files' },
        {
          type: 'custom_tool_call',
          id: 'ctc_history',
          call_id: 'call_exec',
          name: 'exec',
          input: 'pwd',
          status: 'completed',
        },
        {
          type: 'custom_tool_call_output',
          id: 'ctco_history',
          call_id: 'call_exec',
          output: '/workspace',
          status: 'completed',
        },
      ],
    })

    expect(responsesToChatCompletionsRequest(request, 'upstream-model').messages).toEqual([
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_exec',
          type: 'function',
          function: { name: 'exec', arguments: '{"input":"pwd"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_exec', content: '/workspace' },
    ])
  })

  it('restores custom and namespace calls in a buffered Responses result', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [
        { type: 'custom', name: 'exec' },
        {
          type: 'namespace',
          name: 'collaboration',
          tools: [{ type: 'function', name: 'wait_agent', parameters: {} }],
        },
      ],
    })

    const response = chatCompletionsResponseToResponses({
      id: 'chatcmpl_tools',
      created: 1_700_000_000,
      service_tier: 'priority',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_exec',
              type: 'function',
              function: { name: 'exec', arguments: '{"input":"pwd"}' },
            },
            {
              id: 'call_wait',
              type: 'function',
              function: {
                name: 'collaboration__wait_agent',
                arguments: '{"timeout_ms":1000}',
              },
            },
            {
              id: 'call_alias',
              type: 'function',
              function: { name: 'collaboration__exec', arguments: 'not-json' },
            },
          ],
        },
      }],
    }, 'public-model', 1_800_000_000, request.tool_mapping)

    expect(response).toMatchObject({
      service_tier: 'priority',
      output: [
        {
          type: 'custom_tool_call',
          id: expect.stringMatching(/^ctc_/),
          call_id: 'call_exec',
          name: 'exec',
          input: 'pwd',
          status: 'completed',
        },
        {
          type: 'function_call',
          id: expect.stringMatching(/^fc_/),
          call_id: 'call_wait',
          namespace: 'collaboration',
          name: 'wait_agent',
          arguments: '{"timeout_ms":1000}',
          status: 'completed',
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_alias',
          name: 'exec',
          input: 'not-json',
          status: 'completed',
        },
      ],
    })
    expect(response.output[0]).not.toHaveProperty('arguments')
  })

  it('keeps a long flattened namespace identity stable and reversible', () => {
    const namespace = 'very_long_namespace_prefix_for_testing_purposes'
    const name = 'and_a_rather_long_tool_name_too'
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [{
        type: 'namespace',
        name: namespace,
        tools: [{ type: 'function', name, parameters: {} }],
      }],
    })
    const converted = responsesToChatCompletionsRequest(request, 'upstream-model')
    const flattened = (converted.tools?.[0]?.function as { name: string }).name

    expect(flattened.length).toBeLessThanOrEqual(64)
    const response = chatCompletionsResponseToResponses({
      id: 'chatcmpl_long_namespace',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_long',
            type: 'function',
            function: { name: flattened, arguments: '{}' },
          }],
        },
      }],
    }, 'public-model', 123, request.tool_mapping)
    expect(response.output[0]).toMatchObject({
      type: 'function_call',
      namespace,
      name,
    })
  })

  it('emits one stable custom-tool SSE lifecycle when the name arrives late', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [{ type: 'custom', name: 'exec' }],
    })
    const codec = new ChatCompletionsToResponsesEventCodec(
      'public-model',
      123,
      request.tool_mapping,
    )

    const events = [
      ...codec.push({
        id: 'chatcmpl_custom_stream',
        service_tier: 'flex',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_exec',
              type: 'function',
              function: { arguments: '{"inp' },
            }],
          },
          finish_reason: null,
        }],
      }),
      ...codec.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'exec', arguments: 'ut":"pwd"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      ...codec.finish(),
    ]

    const toolEvents = events.filter((event) =>
      event.item?.type === 'custom_tool_call' ||
      event.type.startsWith('response.custom_tool_call_input'))
    expect(toolEvents.map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
    ])
    const itemIds = toolEvents.flatMap((event) => {
      const id = event.item?.id ?? event.item_id
      return typeof id === 'string' ? [id] : []
    })
    expect(new Set(itemIds).size).toBe(1)
    expect(itemIds[0]).toMatch(/^ctc_/)
    expect(toolEvents[1]).toMatchObject({
      output_index: 0,
      delta: 'pwd',
      call_id: 'call_exec',
      name: 'exec',
    })
    expect(toolEvents[2]).toMatchObject({
      output_index: 0,
      input: 'pwd',
      call_id: 'call_exec',
      name: 'exec',
    })
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: {
        service_tier: 'flex',
        output: [{
          type: 'custom_tool_call',
          id: itemIds[0],
          call_id: 'call_exec',
          name: 'exec',
          input: 'pwd',
        }],
      },
    })
    expect(events.map((event) => event.sequence_number)).toEqual(
      Array.from({ length: events.length }, (_, index) => index),
    )
    expect(events.some((event) => event.type.startsWith('response.function_call_arguments')))
      .toBe(false)
  })

  it('keeps mixed custom and namespace stream items ordered and associated', () => {
    const request = parseResponsesRequest({
      model: 'public-model',
      input: 'run',
      tools: [
        { type: 'custom', name: 'exec' },
        {
          type: 'namespace',
          name: 'browser',
          tools: [{ type: 'function', name: 'open', parameters: {} }],
        },
      ],
    })
    const codec = new ChatCompletionsToResponsesEventCodec('public-model', 123, request.tool_mapping)
    const events = [
      ...codec.push({
        id: 'chatcmpl_mixed',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_exec',
                function: { name: 'exec', arguments: '{"input":"pwd"}' },
              },
              {
                index: 1,
                id: 'call_open',
                function: { name: 'browser__open', arguments: '{"url":"https://' },
              },
            ],
          },
          finish_reason: null,
        }],
      }),
      ...codec.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 1, function: { arguments: 'example.com"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      ...codec.finish(),
    ]

    const added = events.filter((event) => event.type === 'response.output_item.added')
    expect(added.map((event) => event.item)).toMatchObject([
      { type: 'custom_tool_call', call_id: 'call_exec', name: 'exec' },
      {
        type: 'function_call',
        call_id: 'call_open',
        namespace: 'browser',
        name: 'open',
      },
    ])
    expect(events.at(-1)).toMatchObject({
      response: {
        output: [
          { type: 'custom_tool_call', call_id: 'call_exec', input: 'pwd' },
          {
            type: 'function_call',
            call_id: 'call_open',
            namespace: 'browser',
            name: 'open',
            arguments: '{"url":"https://example.com"}',
          },
        ],
      },
    })
    const namespaceItemId = added[1]?.item?.id
    const namespaceEvents = events.filter((event) => event.call_id === 'call_open')
    expect(namespaceEvents.length).toBeGreaterThan(0)
    for (const event of namespaceEvents) expect(event.item_id).toBe(namespaceItemId)
  })
})
