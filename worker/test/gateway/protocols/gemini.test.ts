import { describe, expect, it } from 'vitest'
import {
  GeminiCodecError,
  convertChatCompletionsToGemini,
  convertGeminiGenerateContentToResponsesRequest,
  convertGeminiToChatCompletions,
  convertGeminiToResponses,
  convertOpenAIResponsesResponseToGemini,
  convertResponsesToGemini,
  createGeminiSseConverter,
  createGeminiSseTransform,
  createOpenAIResponsesToGeminiSseConverter,
  createOpenAIResponsesToGeminiSseTransform,
  mapGeminiError,
  type GeminiSseFrame,
} from '../../../src/gateway/protocols/gemini'

function frameData(frames: GeminiSseFrame[]): unknown[] {
  return frames
    .filter((frame) => frame.data !== '[DONE]')
    .map((frame) => frame.data)
}

function concatTextParts(contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>): string[] {
  return contents.flatMap((content) =>
    content.parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : [])),
  )
}

describe('OpenAI request to Gemini generateContent', () => {
  it('converts Chat contents, system instructions, tools and generation controls', () => {
    const converted = convertChatCompletionsToGemini(
      {
        model: 'public-gemini',
        messages: [
          { role: 'system', content: 'Answer briefly.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is here?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
            ],
          },
          {
            role: 'assistant',
            content: 'I will inspect it.',
            tool_calls: [
              {
                id: 'call_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_weather', content: '{"temperature":21}' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Read the weather',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
        max_completion_tokens: 321,
        temperature: 0.25,
        top_p: 0.8,
        stop: ['END'],
        stream: true,
      },
      { mappedModel: 'models/gemini-2.5-flash' },
    )

    expect(converted).toMatchObject({
      clientModel: 'public-gemini',
      model: 'gemini-2.5-flash',
      stream: true,
      body: {
        systemInstruction: { parts: [{ text: 'Answer briefly.' }] },
        generationConfig: {
          maxOutputTokens: 321,
          temperature: 0.25,
          topP: 0.8,
          stopSequences: ['END'],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Read the weather',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
          },
        ],
      },
    })
    expect(converted.body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'What is here?' },
          { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'I will inspect it.' },
          {
            thoughtSignature: 'skip_thought_signature_validator',
            functionCall: { name: 'get_weather', args: { city: 'Paris' } },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'get_weather',
              response: { content: '{"temperature":21}' },
            },
          },
        ],
      },
    ])
  })

  it('converts Responses input items including function calls and outputs', () => {
    const converted = convertResponsesToGemini(
      {
        model: 'gemini-public',
        instructions: 'Use tools when useful.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Forecast?' },
              { type: 'input_image', image_url: 'https://example.com/map.png' },
            ],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'forecast',
            arguments: '{"days":2}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: [{ type: 'input_text', text: 'sunny' }],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'forecast',
            description: 'Read forecast',
            parameters: { type: 'object', properties: { days: { type: 'integer' } } },
          },
        ],
        max_output_tokens: 99,
        stream: false,
      },
      { mappedModel: 'gemini-2.5-pro' },
    )

    expect(converted.model).toBe('gemini-2.5-pro')
    expect(converted.body.systemInstruction).toEqual({ parts: [{ text: 'Use tools when useful.' }] })
    expect(converted.body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Forecast?' },
          { fileData: { mimeType: 'image/*', fileUri: 'https://example.com/map.png' } },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            thoughtSignature: 'skip_thought_signature_validator',
            functionCall: { name: 'forecast', args: { days: 2 } },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'forecast', response: { content: 'sunny' } } },
        ],
      },
    ])
    expect(converted.body.generationConfig).toEqual({ maxOutputTokens: 99 })
  })

  it('rewrites safe model names and rejects malformed requests before URL construction', () => {
    expect(
      convertChatCompletionsToGemini(
        { model: 'client-name', messages: [{ role: 'user', content: 'hello' }] },
        { mappedModel: ' models/gemini-2.5-pro-preview ' },
      ).model,
    ).toBe('gemini-2.5-pro-preview')

    for (const model of ['', '../secret', 'models/a/b', 'gemini?key=leak', 'https://evil.invalid/model']) {
      expect(() =>
        convertChatCompletionsToGemini({ model, messages: [{ role: 'user', content: 'hello' }] }),
      ).toThrow(GeminiCodecError)
    }
    expect(() => convertChatCompletionsToGemini({ model: 'gemini-2.5-pro', messages: 'nope' })).toThrow(
      /messages must be an array/,
    )
    expect(() =>
      convertChatCompletionsToGemini({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'x', arguments: '{' } }] }],
      }),
    ).toThrow(/valid JSON object/)
  })
})

describe('Gemini response to OpenAI protocols', () => {
  const geminiResponse = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { text: 'Checking.' },
            { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 5,
      cachedContentTokenCount: 3,
      thoughtsTokenCount: 2,
    },
  }

  it('maps parts, function calls, finish reason and usage to Chat Completions', () => {
    expect(
      convertGeminiToChatCompletions(geminiResponse, {
        model: 'public-gemini',
        id: 'chatcmpl_test',
        createdAt: 1_700_000_000,
      }),
    ).toEqual({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'public-gemini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Checking.',
            tool_calls: [
              {
                id: 'call_chatcmpl_test_0_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })
  })

  it('maps MAX_TOKENS and content filters to Chat finish reasons', () => {
    const make = (finishReason: string) =>
      convertGeminiToChatCompletions(
        { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }] },
        { model: 'gemini', id: 'chatcmpl_reason', createdAt: 1 },
      ).choices[0]?.finish_reason

    expect(make('MAX_TOKENS')).toBe('length')
    expect(make('SAFETY')).toBe('content_filter')
    expect(make('RECITATION')).toBe('content_filter')
    expect(make('STOP')).toBe('stop')
  })

  it('maps Gemini output and tool calls to a completed Responses object', () => {
    expect(
      convertGeminiToResponses(geminiResponse, {
        model: 'public-gemini',
        id: 'resp_test',
        createdAt: 1_700_000_000,
      }),
    ).toEqual({
      id: 'resp_test',
      object: 'response',
      created_at: 1_700_000_000,
      status: 'completed',
      model: 'public-gemini',
      output: [
        {
          id: 'msg_resp_test_0',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
        },
        {
          id: 'fc_resp_test_0_1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_resp_test_0_1',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
        },
      ],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 19,
      },
      error: null,
      incomplete_details: null,
    })
  })

  it('marks a MAX_TOKENS Responses result incomplete', () => {
    const response = convertGeminiToResponses(
      { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] },
      { model: 'gemini', id: 'resp_partial', createdAt: 2 },
    )

    expect(response.status).toBe('incomplete')
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('preserves supported inline image parts and drops malformed ones', () => {
    const response = convertGeminiToChatCompletions(
      {
        candidates: [
          {
            content: {
              parts: [
                { text: 'image:\n' },
                { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
                { inlineData: { mimeType: 'image/svg+xml', data: 'PHN2Zz4=' } },
                { inlineData: { mimeType: 'image/webp', data: 'invalid!!!' } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
      { model: 'gemini', id: 'chatcmpl_image', createdAt: 3 },
    )

    expect(response.choices[0]?.message.content).toBe(
      'image:\n![image](data:image/png;base64,aW1hZ2U=)',
    )
  })
})

describe('Gemini errors', () => {
  it.each([
    [400, 'INVALID_ARGUMENT', 400, 'invalid_request_error', 'invalid_request'],
    [401, 'UNAUTHENTICATED', 401, 'authentication_error', 'invalid_api_key'],
    [403, 'PERMISSION_DENIED', 403, 'permission_error', 'permission_denied'],
    [404, 'NOT_FOUND', 404, 'not_found_error', 'model_not_found'],
    [429, 'RESOURCE_EXHAUSTED', 429, 'rate_limit_error', 'rate_limit_exceeded'],
    [529, 'UNAVAILABLE', 503, 'overloaded_error', 'upstream_overloaded'],
    [500, 'INTERNAL', 502, 'upstream_error', 'upstream_error'],
  ])('maps HTTP %i / %s into a stable OpenAI error', (status, geminiStatus, expectedStatus, type, code) => {
    expect(
      mapGeminiError(status, {
        error: { code: status, status: geminiStatus, message: 'Provider rejected the request' },
      }),
    ).toEqual({
      status: expectedStatus,
      error: {
        message: 'Provider rejected the request',
        type,
        code,
      },
    })
  })

  it('does not reflect malformed or excessively large provider messages', () => {
    expect(mapGeminiError(500, '<html>private proxy page</html>').error.message).toBe(
      'Gemini upstream request failed',
    )
    expect(mapGeminiError(500, { error: { message: 'x'.repeat(2_000) } }).error.message).toBe(
      'Gemini upstream request failed',
    )
  })
})

describe('Gemini SSE conversion', () => {
  it('converts cumulative text and function-call chunks, then terminates Chat exactly once', () => {
    const converter = createGeminiSseConverter({
      target: 'chat_completions',
      model: 'public-gemini',
      id: 'chatcmpl_stream',
      createdAt: 123,
      includeUsage: true,
    })

    const frames = [
      ...converter.push({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
      ...converter.push({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }),
      ...converter.push({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'weather', args: { city: 'Pa' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, cachedContentTokenCount: 1 },
      }),
      ...converter.finish(),
      ...converter.finish(),
    ]

    const payloads = frameData(frames) as Array<Record<string, any>>
    expect(payloads.map((payload) => payload.choices?.[0]?.delta?.content).filter(Boolean)).toEqual([
      'Hel',
      'lo',
    ])
    const toolDelta = payloads.find((payload) => payload.choices?.[0]?.delta?.tool_calls)
    expect(toolDelta?.choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_chatcmpl_stream_0_0',
        type: 'function',
        function: { name: 'weather', arguments: '{"city":"Pa"}' },
      },
    ])
    expect(payloads.at(-1)).toMatchObject({
      choices: [{ finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 3,
        total_tokens: 7,
        prompt_tokens_details: { cached_tokens: 1 },
      },
    })
    expect(frames.filter((frame) => frame.data === '[DONE]')).toHaveLength(1)
  })

  it('emits the Responses lifecycle and an incomplete terminal event', () => {
    const converter = createGeminiSseConverter({
      target: 'responses',
      model: 'public-gemini',
      id: 'resp_stream',
      createdAt: 456,
    })

    const frames = [
      ...converter.push({ candidates: [{ content: { parts: [{ text: 'Partial' }] } }] }),
      ...converter.push({
        candidates: [{ content: { parts: [{ text: 'Partial answer' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
      }),
      ...converter.finish(),
    ]

    expect(frames.map((frame) => frame.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.incomplete',
    ])
    expect(frames[4]?.data).toMatchObject({ delta: 'Partial' })
    expect(frames[5]?.data).toMatchObject({ delta: ' answer' })
    expect(frames.at(-1)?.data).toMatchObject({
      type: 'response.incomplete',
      response: {
        id: 'resp_stream',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      },
    })
  })

  it('parses fragmented upstream SSE with Web Streams and honors [DONE]', async () => {
    const transform = createGeminiSseTransform({
      target: 'chat_completions',
      model: 'public-gemini',
      id: 'chatcmpl_pipe',
      createdAt: 789,
    })
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hi"}'))
        controller.enqueue(encoder.encode(']}}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })

    const output = await new Response(source.pipeThrough(transform)).text()
    expect(output).toContain('"content":"hi"')
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1)
  })
})

describe('Gemini native generateContent to OpenAI Responses request', () => {
  it('converts strict Gemini contents, tools and generation config without tunneling fields', () => {
    const converted = convertGeminiGenerateContentToResponsesRequest(
      {
        systemInstruction: { parts: [{ text: 'Be concise.' }, { text: 'Use SI units.' }] },
        contents: [
          { role: 'user', parts: [{ text: 'Weather?' }] },
          {
            role: 'model',
            parts: [
              { text: 'I will check.' },
              {
                thoughtSignature: 'provider-signature',
                functionCall: { name: 'weather', args: { city: 'Paris' } },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'weather', response: { temperature: 21, unit: 'C' } } },
            ],
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'weather',
                description: 'Read weather',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 256,
          temperature: 0.2,
          topP: 0.9,
        },
      },
      { publicModel: 'gemini-public', mappedModel: 'gpt-5.4', stream: true },
    )

    expect(converted).toEqual({
      publicModel: 'gemini-public',
      upstreamModel: 'gpt-5.4',
      stream: true,
      body: {
        model: 'gpt-5.4',
        instructions: 'Be concise.\nUse SI units.',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
          { role: 'assistant', content: [{ type: 'output_text', text: 'I will check.' }] },
          {
            type: 'function_call',
            id: 'fc_gemini_1_1',
            call_id: 'call_gemini_1_1',
            name: 'weather',
            arguments: '{"city":"Paris"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_gemini_1_1',
            output: '{"temperature":21,"unit":"C"}',
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'weather',
            description: 'Read weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
        max_output_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
        stream: true,
        store: false,
      },
    })
    expect(JSON.stringify(converted)).not.toContain('provider-signature')
  })

  it.each([
    [{}, 'contents must be a non-empty array'],
    [{ contents: [] }, 'contents must be a non-empty array'],
    [{ contents: [{ role: 'system', parts: [{ text: 'bad role' }] }] }, 'content role'],
    [{ contents: [{ role: 'user', parts: [] }] }, 'parts must be a non-empty array'],
    [
      { contents: [{ role: 'model', parts: [{ functionCall: { name: 'x', args: [] } }] }] },
      'functionCall.args must be an object',
    ],
    [
      { contents: [{ role: 'user', parts: [{ text: 'ok', private_field: 'secret' }] }] },
      'unsupported field',
    ],
    [
      { contents: [{ role: 'user', parts: [{ text: 'ok' }] }], proxy_url: 'http://localhost' },
      'unsupported field',
    ],
    [
      {
        contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
        generationConfig: { candidateCount: 2 },
      },
      'candidateCount must be 1',
    ],
  ])('rejects malformed or transport-tunneling Gemini payload %#', (body, message) => {
    expect(() =>
      convertGeminiGenerateContentToResponsesRequest(body, {
        publicModel: 'gemini-public',
        mappedModel: 'gpt-5.4',
      }),
    ).toThrow(message)
  })

  it('pairs repeated same-name function responses with calls in order', () => {
    const converted = convertGeminiGenerateContentToResponsesRequest(
      {
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'lookup', args: { id: 1 } } },
              { functionCall: { name: 'lookup', args: { id: 2 } } },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'lookup', response: { value: 'first' } } },
              { functionResponse: { name: 'lookup', response: { value: 'second' } } },
            ],
          },
        ],
      },
      { publicModel: 'gemini-public', mappedModel: 'gpt-5.4' },
    )

    expect(converted.body.input).toEqual([
      expect.objectContaining({ call_id: 'call_gemini_0_0' }),
      expect.objectContaining({ call_id: 'call_gemini_0_1' }),
      expect.objectContaining({ call_id: 'call_gemini_0_0', output: '{"value":"first"}' }),
      expect.objectContaining({ call_id: 'call_gemini_0_1', output: '{"value":"second"}' }),
    ])
  })
})

describe('OpenAI Responses non-streaming response to Gemini native response', () => {
  it('restores the public model and maps text, tools and usage through a field whitelist', () => {
    const converted = convertOpenAIResponsesResponseToGemini(
      {
        id: 'resp_upstream',
        object: 'response',
        model: 'private-upstream-model',
        status: 'completed',
        provider_debug: { credential: 'must-not-leak' },
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            provider_secret: 'must-not-leak',
            content: [{ type: 'output_text', text: 'Checking.' }],
          },
          {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'weather',
            arguments: '{"city":"Paris"}',
            status: 'completed',
          },
        ],
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 27,
        },
      },
      { publicModel: 'gemini-public' },
    )

    expect(converted).toEqual({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: 'Checking.' },
              { functionCall: { name: 'weather', args: { city: 'Paris' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 5,
        totalTokenCount: 27,
        cachedContentTokenCount: 5,
        thoughtsTokenCount: 2,
      },
      modelVersion: 'gemini-public',
    })
    expect(JSON.stringify(converted)).not.toContain('private-upstream-model')
    expect(JSON.stringify(converted)).not.toContain('must-not-leak')
  })

  it.each([
    ['max_output_tokens', 'MAX_TOKENS'],
    ['content_filter', 'SAFETY'],
  ])('maps incomplete reason %s to Gemini %s', (reason, finishReason) => {
    const converted = convertOpenAIResponsesResponseToGemini(
      {
        status: 'incomplete',
        incomplete_details: { reason },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      { publicModel: 'gemini-public' },
    )

    expect(converted).toMatchObject({ candidates: [{ finishReason }] })
  })

  it('maps a failed Responses result to a sanitized Gemini error', () => {
    expect(
      convertOpenAIResponsesResponseToGemini(
        {
          status: 'failed',
          model: 'private-upstream-model',
          error: {
            code: 'server_error',
            message: 'private-upstream-model generation failed',
            trace: 'private',
          },
          output: [],
        },
        { publicModel: 'gemini-public' },
      ),
    ).toEqual({
      error: { code: 502, message: 'gemini-public generation failed', status: 'INTERNAL' },
    })
  })
})

describe('OpenAI Responses SSE to Gemini native SSE', () => {
  it('emits only Gemini text/tool/terminal chunks and restores the public model', () => {
    const converter = createOpenAIResponsesToGeminiSseConverter({ publicModel: 'gemini-public' })
    const frames = [
      ...converter.push({
        type: 'response.created',
        response: { id: 'resp_1', model: 'private-upstream-model', status: 'in_progress' },
      }),
      ...converter.push({ type: 'response.output_text.delta', delta: 'Hel', provider_debug: 'secret' }),
      ...converter.push({ type: 'response.output_text.delta', delta: 'lo' }),
      ...converter.push({
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'weather' },
      }),
      ...converter.push({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"city":',
      }),
      ...converter.push({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        arguments: '{"city":"Paris"}',
      }),
      ...converter.push({
        type: 'response.completed',
        response: {
          status: 'completed',
          model: 'private-upstream-model',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'must-not-repeat' }] }],
          usage: {
            input_tokens: 9,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 13,
          },
        },
      }),
      ...converter.finish(),
    ]

    expect(frames.map((frame) => frame.data)).toEqual([
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hel' }] } }],
        modelVersion: 'gemini-public',
      },
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'lo' }] } }],
        modelVersion: 'gemini-public',
      },
      {
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ functionCall: { name: 'weather', args: { city: 'Paris' } } }] },
          },
        ],
        modelVersion: 'gemini-public',
      },
      {
        candidates: [{ index: 0, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 3,
          totalTokenCount: 13,
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 1,
        },
        modelVersion: 'gemini-public',
      },
    ])
    const wire = frames.map((frame) => JSON.stringify(frame.data)).join('\n')
    expect(wire).not.toContain('private-upstream-model')
    expect(wire).not.toContain('provider_debug')
    expect(wire).not.toContain('must-not-repeat')
  })

  it('ignores unknown events and emits a Gemini error when the stream ends without a terminal event', () => {
    const converter = createOpenAIResponsesToGeminiSseConverter({ publicModel: 'gemini-public' })

    expect(converter.push({ type: 'response.provider_debug', secret: 'nope' })).toEqual([])
    expect(converter.finish()).toEqual([
      {
        data: {
          error: {
            code: 502,
            message: 'OpenAI Responses stream ended before a terminal event',
            status: 'INTERNAL',
          },
        },
      },
    ])
    expect(converter.finish()).toEqual([])
  })

  it('parses fragmented Responses SSE event names with Web Streams and terminates once', async () => {
    const transform = createOpenAIResponsesToGeminiSseTransform({ publicModel: 'gemini-public' })
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: response.output_text.delta\ndata: {"delta":"hi"}\n\nevent: response.comp'),
        )
        controller.enqueue(
          encoder.encode(
            'leted\ndata: {"response":{"status":"completed","model":"private","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
          ),
        )
        controller.close()
      },
    })

    const wire = await new Response(source.pipeThrough(transform)).text()
    expect(wire).toContain('"text":"hi"')
    expect(wire).toContain('"finishReason":"STOP"')
    expect(wire).toContain('"modelVersion":"gemini-public"')
    expect(wire).not.toContain('private')
    expect(wire.match(/"finishReason":"STOP"/g)).toHaveLength(1)
  })
})
