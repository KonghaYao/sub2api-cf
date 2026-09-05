import { describe, expect, it } from 'vitest'
import {
  ChatToResponsesError,
  chatCompletionsToResponsesRequest,
} from '../../src/gateway/protocols/chat-responses'

describe('legacy Chat Completions to Responses contract', () => {
  it('normalizes fast and accepts scale service tiers', () => {
    expect(chatCompletionsToResponsesRequest({
      model: 'public-model', messages: [{ role: 'user', content: 'Hello' }],
      service_tier: ' FAST ',
    }).service_tier).toBe('priority')
    expect(chatCompletionsToResponsesRequest({
      model: 'public-model', messages: [{ role: 'user', content: 'Hello' }],
      service_tier: 'scale',
    }).service_tier).toBe('scale')
  })

  it('forces the upstream stream needed by the bridge and preserves supported controls', () => {
    expect(chatCompletionsToResponsesRequest({
      model: 'public-model',
      instructions: 'Answer precisely.',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
      service_tier: 'flex',
      parallel_tool_calls: false,
    }, 'gpt-4o-upstream')).toEqual({
      model: 'gpt-4o-upstream',
      instructions: 'Answer precisely.',
      input: [{ role: 'user', content: 'Hello' }],
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      service_tier: 'flex',
      parallel_tool_calls: false,
    })
  })

  it('maps usable image and file parts and never emits null content', () => {
    const converted = chatCompletionsToResponsesRequest({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'Inspect inputs carefully.' }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe these.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
            {
              type: 'file',
              file: { filename: 'brief.pdf', file_data: 'data:application/pdf;base64,Yg==' },
            },
            { type: 'file', file: { file_id: 'file-existing' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,   ' } },
            { type: 'file', file: { filename: 'empty.pdf' } },
          ],
        },
        { role: 'user', content: null },
      ],
    })

    expect(converted.input).toEqual([
      {
        role: 'system',
        content: [{ type: 'input_text', text: 'Inspect inputs carefully.' }],
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe these.' },
          { type: 'input_image', image_url: 'data:image/png;base64,YQ==' },
          {
            type: 'input_file',
            filename: 'brief.pdf',
            file_data: 'data:application/pdf;base64,Yg==',
          },
          { type: 'input_file', file_id: 'file-existing' },
        ],
      },
      { role: 'user', content: '' },
    ])
    expect(JSON.stringify(converted.input)).not.toContain('"content":null')
  })

  it('preserves assistant text, reasoning and tool call/output identity', () => {
    const converted = chatCompletionsToResponsesRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Run it.' },
        {
          role: 'assistant',
          reasoning_content: 'I should call the tool.',
          content: 'Calling now.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'exec', arguments: '{"cmd":"pwd"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '/workspace' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec',
            description: 'Run a command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'exec' } },
    })

    expect(converted.input).toEqual([
      { role: 'user', content: 'Run it.' },
      {
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: '<thinking>I should call the tool.</thinking>\nCalling now.',
        }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'exec',
        arguments: '{"cmd":"pwd"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '/workspace' },
    ])
    expect(converted.tools).toEqual([{
      type: 'function',
      name: 'exec',
      description: 'Run a command',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
      strict: false,
    }])
    expect(converted.tool_choice).toEqual({ type: 'function', name: 'exec' })
  })

  it('applies the legacy token floor and strips sampling for gpt-5 Responses models', () => {
    const converted = chatCompletionsToResponsesRequest({
      model: 'public-alias',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      max_tokens: 64,
      max_completion_tokens: 96,
      temperature: 0.7,
      top_p: 0.8,
      reasoning_effort: 'high',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          strict: true,
        },
      },
    }, 'gpt-5.2')

    expect(converted).toMatchObject({
      model: 'gpt-5.2',
      max_output_tokens: 128,
      reasoning: { effort: 'high', summary: 'auto' },
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          strict: true,
        },
      },
    })
    expect(converted).not.toHaveProperty('temperature')
    expect(converted).not.toHaveProperty('top_p')
  })

  it('rejects malformed content and legacy function choices at the conversion boundary', () => {
    expect(() => chatCompletionsToResponsesRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: { unexpected: true } }],
    })).toThrowError(ChatToResponsesError)

    expect(() => chatCompletionsToResponsesRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      function_call: { unexpected: true },
    })).toThrowError('$.function_call.name')
  })
})
