import { describe, expect, it } from 'vitest'
import {
  ResponsesToChatCompletionsEventCodec,
  BufferedResponsesToChatCompletions,
  responsesSseToChatCompletionsResponse,
  responsesToChatCompletionsResponse,
} from '../../../src/gateway/protocols/chat-from-responses'

describe('Responses to Chat Completions output bridge', () => {
  it.each([false, true])('fills terminal-only content without duplicating streamed text (deltas=%s)', deltas => {
    const codec = new ResponsesToChatCompletionsEventCodec('public-model')
    const chunks = deltas ? codec.push({ type: 'response.output_text.delta', delta: 'Hello' }) : []
    chunks.push(...codec.push({ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
    ] } }))
    expect(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.content ?? '').join('')).toBe('Hello')
  })

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

  it('keeps a standard incomplete terminal as partial success for stream and buffer clients', () => {
    const codec = new ResponsesToChatCompletionsEventCodec('public-model', true, 456)
    codec.push({ type: 'response.created', response: { id: 'resp_incomplete' } })
    codec.push({ type: 'response.output_text.delta', delta: 'partial' })
    const terminal = codec.push({
      type: 'response.incomplete',
      response: {
        id: 'resp_incomplete',
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        usage: { input_tokens: 4, output_tokens: 1 },
      },
    })
    expect(terminal[0]?.choices[0]?.finish_reason).toBe('content_filter')
    expect(terminal[1]?.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 1,
      total_tokens: 5,
    })

    expect(responsesSseToChatCompletionsResponse([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":1}}}',
      '',
    ].join('\n'), 'public-model')).toMatchObject({
      choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    })
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

it.each(['arguments.done', 'item.done', 'terminal'] as const)('recovers missing tool argument suffix from %s without duplication', completion => {
  const codec = new ResponsesToChatCompletionsEventCodec('public-model')
  const item = { type: 'function_call', call_id: 'call-weather', name: 'weather', arguments: '{"city":"上海"}' }
  const chunks = codec.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } })
  chunks.push(...codec.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' }))
  if (completion === 'arguments.done') chunks.push(...codec.push({ type: 'response.function_call_arguments.done', output_index: 0, arguments: item.arguments }))
  if (completion === 'item.done') chunks.push(...codec.push({ type: 'response.output_item.done', output_index: 0, item }))
  chunks.push(...codec.push({ type: 'response.completed', response: { status: 'completed', output: [item] } }))
  const calls = chunks.flatMap(c => c.choices.flatMap(choice => choice.delta.tool_calls ?? []))
  expect(calls.map(c => c.function.arguments).join('')).toBe(item.arguments)
  expect(calls.filter(c => c.id)).toHaveLength(1)
  expect(calls.every(c => c.index === 0)).toBe(true)
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls')
})

it('rejects inconsistent final arguments instead of emitting a corrupted tool invocation', () => {
  const codec = new ResponsesToChatCompletionsEventCodec('model')
  codec.push({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c', name: 'f' } })
  codec.push({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"a":1' })
  expect(() => codec.push({ type: 'response.output_item.done', output_index: 1,
    item: { type: 'function_call', call_id: 'c', name: 'f', arguments: '{"a":2}' } })).toThrow('streamed prefix')
})

it('accepts argument completion without an output index and resolves custom tools by call ID', () => {
  const codec = new ResponsesToChatCompletionsEventCodec('model')
  const item = { type: 'custom_tool_call', call_id: 'patch-id', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' }
  const chunks = codec.push({ type: 'response.output_item.added', output_index: 2, item })
  expect(codec.push({ type: 'response.function_call_arguments.done', arguments: '{}' })).toEqual([])
  chunks.push(...codec.push({ type: 'response.custom_tool_call_input.done', call_id: 'patch-id', input: item.input }))
  chunks.push(...codec.push({ type: 'response.output_item.done', output_index: 2, item }))
  const calls = chunks.flatMap(c => c.choices.flatMap(choice => choice.delta.tool_calls ?? []))
  expect(calls.map(c => c.function.arguments).join('')).toBe(item.input)
  expect(calls.filter(c => c.id).map(c => c.id)).toEqual(['patch-id'])
})

it('keeps interleaved tool IDs and argument suffixes separate in compact terminal output', () => {
  const codec = new ResponsesToChatCompletionsEventCodec('model')
  const a = { type: 'function_call', call_id: 'a', name: 'alpha', arguments: '{"a":1}' }
  const b = { type: 'function_call', call_id: 'b', name: 'beta', arguments: '{"b":2}' }
  const chunks = codec.push({ type: 'response.output_item.added', output_index: 2, item: a })
  chunks.push(...codec.push({ type: 'response.output_item.added', output_index: 4, item: b }))
  chunks.push(...codec.push({ type: 'response.function_call_arguments.delta', output_index: 4, delta: '{"b":' }))
  chunks.push(...codec.push({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"a":' }))
  chunks.push(...codec.push({ type: 'response.completed', response: { status: 'completed', output: [a, b] } }))
  const calls = chunks.flatMap(c => c.choices.flatMap(choice => choice.delta.tool_calls ?? []))
  expect(calls.filter(c => c.id).map(c => [c.index, c.id])).toEqual([[0, 'a'], [1, 'b']])
  expect(calls.filter(c => c.index === 0).map(c => c.function.arguments).join('')).toBe(a.arguments)
  expect(calls.filter(c => c.index === 1).map(c => c.function.arguments).join('')).toBe(b.arguments)
})


it.each(['delta', 'refusal.done', 'part.done', 'item.done', 'terminal'] as const)('preserves refusal content through streaming and buffered bridges from %s', source => {
  const refusal = '抱歉，无法帮助处理此请求。'
  const item = { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal }] }
  const events: Array<Record<string, unknown>> = []
  if (source === 'delta') events.push({ type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: refusal })
  if (source === 'refusal.done') events.push({ type: 'response.refusal.done', output_index: 0, content_index: 0, refusal })
  if (source === 'part.done') events.push({ type: 'response.content_part.done', output_index: 0, content_index: 0, part: item.content[0] })
  if (source === 'item.done') events.push({ type: 'response.output_item.done', output_index: 0, item })
  events.push({ type: 'response.completed', response: { status: 'completed', output: source === 'terminal' ? [item] : [] } })
  const codec = new ResponsesToChatCompletionsEventCodec('model')
  const chunks = events.flatMap(event => codec.push(event))
  expect(chunks.flatMap(c => c.choices).map(c => c.delta.refusal ?? '').join('')).toBe(refusal)
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop')
  const buffered = new BufferedResponsesToChatCompletions('model')
  buffered.push(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')))
  buffered.finish()
  expect(buffered.hasOutput()).toBe(true)
  expect(buffered.response().choices[0].message).toEqual({ role: 'assistant', refusal })
  expect(JSON.stringify(buffered.nativeResponse().output)).toContain(refusal)
})

it('does not duplicate refusal deltas when part, item and terminal snapshots repeat them', () => {
  const codec = new ResponsesToChatCompletionsEventCodec('model')
  const item = { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }
  const events = [
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Cannot ' },
    { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: 'Cannot comply.' },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [item] } },
  ]
  expect(events.flatMap(e => codec.push(e)).flatMap(c => c.choices).map(c => c.delta.refusal ?? '').join('')).toBe('Cannot comply.')
})

it.each(['text.done', 'part.done', 'item.done', 'terminal'] as const)('completes partial text and reasoning without repetition from %s', source => {
  const text = '你好，完整内容。', reasoning = '检查后给出结论。'
  const message = { type: 'message', content: [{ type: 'output_text', text }] }
  const summary = { type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] }
  const events: Array<Record<string, unknown>> = [
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '检查后' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '你好，' },
  ]
  if (source === 'text.done') events.push(
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: reasoning },
    { type: 'response.output_text.done', output_index: 1, content_index: 0, text },
  )
  if (source === 'part.done') events.push(
    { type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 0, part: summary.summary[0] },
    { type: 'response.content_part.done', output_index: 1, content_index: 0, part: message.content[0] },
  )
  if (source === 'item.done') events.push(
    { type: 'response.output_item.done', output_index: 0, item: summary },
    { type: 'response.output_item.done', output_index: 1, item: message },
  )
  events.push({ type: 'response.completed', response: { status: 'completed', output: source === 'terminal' ? [summary, message] : [] } })
  const codec = new ResponsesToChatCompletionsEventCodec('model')
  const choices = events.flatMap(e => codec.push(e)).flatMap(c => c.choices)
  expect(choices.map(c => c.delta.content ?? '').join('')).toBe(text)
  expect(choices.map(c => c.delta.reasoning_content ?? '').join('')).toBe(reasoning)
  const result = responsesSseToChatCompletionsResponse(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), 'model')
  expect(result.choices[0].message).toMatchObject({ content: text, reasoning_content: reasoning })
})

it('retains every content part and does not repeat item or terminal snapshots', () => {
  const codec = new ResponsesToChatCompletionsEventCodec('model')
  const item = { type: 'message', content: [{ type: 'output_text', text: 'Part one. ' }, { type: 'output_text', text: 'Part two.' }] }
  const events = [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Part one. ' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 1, delta: 'Part ' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [item] } },
  ]
  expect(events.flatMap(e => codec.push(e)).flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('Part one. Part two.')
})

it('preserves complete native output items, order, annotations and custom tool identity', () => {
  const output = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning', summary: [{ type: 'summary_text', text: 'Checked.' }] },
    { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'First.', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'Source', start_index: 0, end_index: 5 }] }] },
    { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch', status: 'completed' },
    { type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Second.' }] },
    { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'example' } },
  ]
  const events = [4, 2, 0, 3, 1].map(index => ({ type: 'response.output_item.done', output_index: index, item: output[index] })) as Array<Record<string, unknown>>
  events.push({ type: 'response.completed', response: { status: 'completed', output: [] } })
  const acc = new BufferedResponsesToChatCompletions('model')
  acc.push(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')))
  acc.finish()
  expect(acc.nativeResponse().output).toEqual(output)
  expect(acc.nativeResponse().output).toEqual(output)
  expect(acc.response().choices[0].message).toMatchObject({ content: 'First.Second.', tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '*** Begin Patch' } }] })
})

it('fills deltas into an added native message without dropping its ID or content metadata', () => {
  const acc = new BufferedResponsesToChatCompletions('model')
  const events = [
    { type: 'response.output_item.added', output_index: 3, item: { type: 'message', id: 'msg_live', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] } },
    { type: 'response.output_text.delta', output_index: 3, content_index: 0, delta: 'Hello.' },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]
  acc.push(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')))
  expect(acc.nativeResponse().output).toEqual([{ type: 'message', id: 'msg_live', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.', annotations: [] }] }])
})


it.each(['function_call', 'custom_tool_call'] as const)('retains buffered %s arguments supplied only by argument completion', type => {
  const accumulator = new BufferedResponsesToChatCompletions('model')
  const field = type === 'function_call' ? 'arguments' : 'input'
  const eventType = type === 'function_call' ? 'function_call_arguments' : 'custom_tool_call_input'
  const full = type === 'function_call' ? '{"city":"上海"}' : '*** Begin Patch\n*** End Patch'
  const item = { type, id: 'item-1', call_id: 'call-1', name: 'tool', [field]: '' }
  const events = [
    { type: 'response.output_item.added', output_index: 2, item },
    { type: `response.${eventType}.delta`, output_index: 2, delta: full.slice(0, 3) },
    { type: `response.${eventType}.done`, call_id: 'call-1', item_id: 'item-1', [field]: full },
    { type: `response.${eventType}.done`, output_index: 2, [field]: full },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]
  accumulator.push(new TextEncoder().encode(events.map(event => 'data: '+JSON.stringify(event)+'\n\n').join('')))
  accumulator.finish()
  expect(accumulator.nativeResponse().output).toEqual([{ ...item, [field]: full }])
  expect(accumulator.response().choices[0].message.tool_calls).toMatchObject([{ id: 'call-1', function: { name: 'tool', arguments: full } }])
})

it.each([{ call_id: 'another-call' }, { item_id: 'another-item' }])('rejects buffered argument completion with conflicting identity %j', identity => {
  const accumulator = new BufferedResponsesToChatCompletions('model')
  const push = (event: unknown) => accumulator.push(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'))
  push({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'f' } })
  expect(() => push({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}', ...identity })).toThrow('identity')
})
