import { describe, expect, it } from 'vitest'
import {
  convertGeminiToChatCompletions,
  createGeminiSseTransform,
  mapGeminiError,
  normalizeGeminiModelName,
} from '../../src/gateway/protocols/gemini'

describe('legacy Gemini response contract', () => {
  it('preserves safe inline images and omits unsupported or malformed media', () => {
    const response = convertGeminiToChatCompletions({
      candidates: [{
        content: {
          parts: [
            { text: 'before' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
            { inlineData: { mimeType: 'image/svg+xml', data: 'PHN2Zz4=' } },
            { inlineData: { mimeType: 'image/webp', data: 'not-valid!!!' } },
            { text: 'after' },
          ],
        },
        finishReason: 'STOP',
      }],
    }, { model: 'gemini-public', id: 'chatcmpl_legacy', createdAt: 123 })

    expect(response.choices[0]).toMatchObject({
      finish_reason: 'stop',
      message: {
        content: 'before![image](data:image/png;base64,aW1hZ2U=)after',
      },
    })
  })

  it('uses semantic Gemini status when the transport status is generic', () => {
    expect(mapGeminiError(500, {
      error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted' },
    })).toEqual({
      status: 429,
      error: {
        message: 'quota exhausted',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    })
  })

  it('rejects model path and query injection before URL construction', () => {
    expect(normalizeGeminiModelName('models/gemini-2.5-pro')).toBe('gemini-2.5-pro')
    for (const model of ['../gemini', 'gemini/path', 'gemini?key=secret', 'gemini#fragment']) {
      expect(() => normalizeGeminiModelName(model)).toThrowError('model contains invalid characters')
    }
  })

  it('turns malformed upstream SSE into one terminal error and one Chat sentinel', async () => {
    const transform = createGeminiSseTransform({
      target: 'chat_completions',
      model: 'gemini-public',
      id: 'chatcmpl_bad_stream',
      createdAt: 123,
    })
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {not-json}\n\ndata: {"candidates":[]}\n\n'))
        controller.close()
      },
    })

    const wire = await new Response(source.pipeThrough(transform)).text()
    expect(wire.match(/Failed to parse Gemini stream event/g)).toHaveLength(1)
    expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1)
    expect(wire).not.toContain('chat.completion.chunk')
  })
})
