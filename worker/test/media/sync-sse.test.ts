import { describe, expect, it } from 'vitest'

import {
  buildSyncImageBufferedResponse,
  createSyncImageSseTransformer,
  SyncImageSseError,
} from '../../src/media/sync-sse'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function text(frames: Uint8Array[]): string {
  return frames.map((frame) => decoder.decode(frame)).join('')
}

describe('synchronous Images SSE transformer', () => {
  it('maps a Responses generation partial and completion into Images client events', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation',
      responseFormat: 'url',
      publicModel: 'gpt-image-2',
      now: () => 1_710_000_099,
    })

    const output = text(transformer.push(encoder.encode(
      'data: {"type":"response.created","response":{"created_at":1710000001,"tools":[{"type":"image_generation","model":"gpt-image-2","background":"auto","output_format":"png","quality":"high","size":"1024x1024"}]}}\n\n' +
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0,"output_format":"png"}\n\n' +
      'data: {"type":"response.completed","response":{"created_at":1710000001,"tool_usage":{"image_gen":{"input_tokens":46,"output_tokens":2459,"output_tokens_details":{"image_tokens":2459},"images":1}},"output":[{"id":"ig_1","type":"image_generation_call","result":"ZmluYWw=","output_format":"png"}]}}\n\n',
    )))

    expect(output).toContain('event: image_generation.partial_image\n')
    expect(output).toContain('"type":"image_generation.partial_image"')
    expect(output).toContain('"url":"data:image/png;base64,cGFydGlhbA=="')
    expect(output).toContain('event: image_generation.completed\n')
    expect(output).toContain('"type":"image_generation.completed"')
    expect(output).toContain('"url":"data:image/png;base64,ZmluYWw="')
    expect(transformer.snapshot()).toMatchObject({
      state: 'completed',
      imageCount: 1,
      completedImages: [{ id: 'ig_1', b64: 'ZmluYWw=', size: '1024x1024' }],
      usage: { inputTokens: 46, outputTokens: 2459, imageOutputTokens: 2459, images: 1 },
    })
  })

  it('never exposes the internal Responses tool model as the public Images model', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'public-image-alias',
    })
    const output = text(transformer.push(encoder.encode(
      'data: {"type":"response.created","response":{"tools":[{"type":"image_generation","model":"private-upstream-model"}]}}\n\n' +
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"image_generation_call","result":"aW1hZ2U="}]}}\n\n',
    )))
    expect(output).toContain('"model":"public-image-alias"')
    expect(output).not.toContain('private-upstream-model')
    expect(buildSyncImageBufferedResponse(transformer.snapshot())).toMatchObject({ model: 'public-image-alias' })
  })

  it('applies the byte limit per event rather than per transport chunk', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2', maxEventBytes: 120,
    })
    const output = text(transformer.push(encoder.encode(
      'data: {"type":"response.in_progress","response":{"created_at":1}}\n\n' +
      'data: {"type":"response.in_progress","response":{"created_at":2}}\n\n',
    )))
    expect(output).toBe('')
    expect(transformer.snapshot().state).toBe('open')
  })

  it('retains every native completed image until the done marker', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2',
    })
    const output = text(transformer.push(encoder.encode(
      'data: {"type":"image_generation.completed","id":"img_1","b64_json":"Zmlyc3Q=","size":"1024x1024"}\n\n' +
      'data: {"type":"image_generation.completed","id":"img_2","b64_json":"c2Vjb25k","size":"2048x1152"}\n\n' +
      'data: [DONE]\n\n',
    )))

    expect(output.match(/event: image_generation\.completed/g)).toHaveLength(2)
    expect(transformer.snapshot()).toMatchObject({
      state: 'completed',
      imageCount: 2,
      completedImages: [{ id: 'img_1' }, { id: 'img_2' }],
    })
  })

  it('maps CRLF and multiline edit events and deduplicates output-item fallback', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'edit', responseFormat: 'url', publicModel: 'gpt-image-2', now: () => 99,
    })
    const source =
      ': upstream keepalive\r\n\r\n' +
      'event: response.output_item.done\r\n' +
      'data: {"type":"response.output_item.done","item":{"id":"ig_edit","type":"image_generation_call","result":"ZWRpdGVk","output_format":"webp"}}\r\n\r\n' +
      'event: response.completed\r\n' +
      'data: {"type":"response.completed",\r\n' +
      'data: "response":{"created_at":1710000003,"tool_usage":{"image_gen":{"images":1}},"tools":[{"type":"image_generation","model":"gpt-image-2","size":"1024x1024","quality":"high","background":"transparent","output_format":"webp"}],"output":[{"id":"ig_edit","type":"image_generation_call","result":"ZWRpdGVk","output_format":"webp"}]}}\r\n\r\n'
    const split = Math.floor(source.length / 2)
    const output = text([
      ...transformer.push(encoder.encode(source.slice(0, split))),
      ...transformer.push(encoder.encode(source.slice(split))),
    ])

    expect(output.match(/event: image_edit\.completed/g)).toHaveLength(1)
    expect(output).toContain('"url":"data:image/webp;base64,ZWRpdGVk"')
    expect(output).toContain('"usage":{"images":1}')
    expect(transformer.snapshot()).toMatchObject({
      state: 'completed', imageCount: 1, usage: { images: 1 },
    })
  })

  it.each([
    {
      name: 'completed without an image',
      input: 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      expected: { responseStatus: 'completed', incompleteReason: '', classification: 'completed_no_image', status: 502, retryable: true },
    },
    {
      name: 'content-filtered incomplete response',
      input: 'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n',
      expected: { responseStatus: 'incomplete', incompleteReason: 'content_filter', classification: 'content_filter', status: 400, retryable: false },
    },
    {
      name: 'model text fallback',
      input: 'data: {"type":"response.output_text.delta","delta":"Try a different image prompt"}\n\n' +
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      expected: { responseStatus: 'completed', incompleteReason: '', classification: 'text_fallback', status: 502, retryable: true },
      text: 'Try a different image prompt',
    },
    {
      name: 'structured tool unavailable',
      input: 'data: {"type":"error","error":{"type":"server_error","code":"image_generation_unavailable","message":"tool unavailable","retry_after":3}}\n\n',
      expected: { responseStatus: 'failed', incompleteReason: '', classification: 'structured_unavailable', status: 502, retryable: true },
      retryAfter: '3',
    },
  ])('exposes failover semantics for $name', ({ input, expected, text: expectedText = '', retryAfter = '' }) => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2',
    })
    const output = text(transformer.push(encoder.encode(input)))
    const afterTerminal = text(transformer.push(encoder.encode(
      'data: {"type":"error","error":{"message":"must be ignored"}}\n\n',
    )))

    expect(output.match(/event: error/g)).toHaveLength(1)
    expect(afterTerminal).toBe('')
    expect(transformer.finish()).toEqual([])
    expect(transformer.snapshot()).toMatchObject({
      state: 'error',
      responseStatus: expected.responseStatus,
      incompleteReason: expected.incompleteReason,
      error: {
        classification: expected.classification,
        status: expected.status,
        retryable: expected.retryable,
      },
      textOutput: expectedText,
      retryAfter,
    })
  })

  it('builds a stable buffered Images body from the terminal accounting snapshot', () => {
    const image = pngHeader(1672, 941)
    const b64 = toBase64(image)
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'url', publicModel: 'gpt-image-2',
    })
    transformer.push(encoder.encode(
      `data: {"type":"response.completed","response":{"created_at":1710000007,"usage":{"input_tokens":5,"output_tokens":9,"output_tokens_details":{"image_tokens":4}},"output":[{"id":"ig_actual","type":"image_generation_call","result":"${b64}","revised_prompt":"polished","size":"1024x1024","output_format":"png"}]}}\n\n`,
    ))

    expect(buildSyncImageBufferedResponse(transformer.snapshot())).toEqual({
      created: 1_710_000_007,
      data: [{
        url: `data:image/png;base64,${b64}`,
        revised_prompt: 'polished',
        size: '1672x941',
      }],
      model: 'gpt-image-2',
      usage: {
        input_tokens: 5,
        output_tokens: 9,
        output_tokens_details: { image_tokens: 4 },
        images: 1,
      },
    })
  })

  it('stops client output after disconnect but drains completion and usage for accounting', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'edit', responseFormat: 'b64_json', publicModel: 'gpt-image-2',
    })
    expect(text(transformer.keepalive())).toBe(': keepalive\n\n')
    expect(text(transformer.push(encoder.encode(
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0}\n\n',
    )))).toContain('event: image_edit.partial_image')

    transformer.disconnectOutput()
    expect(transformer.keepalive()).toEqual([])
    expect(transformer.push(encoder.encode(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":9,"output_tokens_details":{"image_tokens":4}},"output":[{"id":"img_after_disconnect","type":"image_generation_call","result":"ZmluYWw="}]}}\n\n',
    ))).toEqual([])
    expect(transformer.snapshot()).toMatchObject({
      state: 'completed', outputSuppressed: true, imageCount: 1,
      completedImages: [{ id: 'img_after_disconnect', b64: 'ZmluYWw=' }],
      usage: { inputTokens: 5, outputTokens: 9, imageOutputTokens: 4, images: 1 },
    })
  })

  it('parses arbitrary byte-sized chunks and treats whitespace-only separators as keepalive boundaries', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2',
    })
    const source = encoder.encode(
      'data: {"type":"response.output_text.delta","delta":"安全策略"}\r\n   \r\n' +
      'data: {"type":"response.completed","response":{"output":[]}}\r\n\r\n',
    )
    const frames: Uint8Array[] = []
    for (const byte of source) frames.push(...transformer.push(Uint8Array.of(byte)))

    expect(text(frames).match(/event: error/g)).toHaveLength(1)
    expect(transformer.snapshot()).toMatchObject({
      textOutput: '安全策略',
      error: { classification: 'content_filter', retryable: false },
    })
  })

  it('finalizes an output-item.done fallback when the Responses stream closes without response.completed', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2', now: () => 123,
    })
    transformer.push(encoder.encode(
      'data: {"type":"response.output_item.done","item":{"id":"fallback","type":"image_generation_call","result":"aW1hZ2U=","output_format":"png"}}\n\n',
    ))
    const output = text(transformer.finish())

    expect(output).toContain('event: image_generation.completed')
    expect(transformer.snapshot()).toMatchObject({
      state: 'completed', responseStatus: 'completed', imageCount: 1,
    })
  })

  it('keeps safe generic usage when completed tool usage is malformed or hostile', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2',
    })
    transformer.push(encoder.encode(
      'data: {"type":"response.in_progress","response":{"usage":{"input_tokens":3,"output_tokens":4,"output_tokens_details":{"image_tokens":2}}}}\n\n' +
      'data: {"type":"response.completed","response":{"tool_usage":{"image_gen":{"input_tokens":46,"output_tokens":1e1000000000,"output_tokens_details":{"image_tokens":2459},"images":999}},"output":[{"type":"image_generation_call","result":"aW1hZ2U="}]}}\n\n',
    ))

    expect(transformer.snapshot().usage).toEqual({
      inputTokens: 3, outputTokens: 4, imageOutputTokens: 2, images: 1,
    })
  })

  it('fails closed when one SSE event exceeds its configured memory bound', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2', maxEventBytes: 64,
    })
    expect(() => transformer.push(encoder.encode(`data: ${'x'.repeat(65)}`))).toThrowError(
      expect.objectContaining<Partial<SyncImageSseError>>({ code: 'IMAGE_SSE_EVENT_TOO_LARGE' }),
    )
    expect(transformer.snapshot()).toMatchObject({
      state: 'error', error: { classification: 'protocol', code: 'IMAGE_SSE_EVENT_TOO_LARGE' },
    })
  })

  it('rejects buffering before a successful terminal image sequence', () => {
    const transformer = createSyncImageSseTransformer({
      operation: 'generation', responseFormat: 'b64_json', publicModel: 'gpt-image-2',
    })
    expect(() => buildSyncImageBufferedResponse(transformer.snapshot())).toThrowError(
      expect.objectContaining<Partial<SyncImageSseError>>({ code: 'IMAGE_STREAM_NOT_COMPLETED' }),
    )
  })
})

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
