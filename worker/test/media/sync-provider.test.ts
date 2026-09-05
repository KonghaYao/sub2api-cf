import { describe, expect, it } from 'vitest'

import { GatewayError } from '../../src/gateway/errors'
import {
  normalizeNativeImageResponse,
  normalizeResponsesImageResponse,
  readSyncImageResponse,
} from '../../src/media/sync-provider'

describe('synchronous image provider response boundary', () => {
  it('deduplicates repeated native outputs before billing', () => {
    const result = normalizeNativeImageResponse({
      created: 1,
      data: [{ b64_json: 'aGVsbG8=' }, { b64_json: 'aGVsbG8=' }],
    })
    expect(result.outputs).toHaveLength(1)
    expect(result.publicBody.data).toHaveLength(1)
  })

  it('accepts unpadded provider base64 output', () => {
    const result = normalizeNativeImageResponse({ data: [{ b64_json: 'aGVsbG8' }] })
    expect(result.outputs).toEqual([{ bytes: new TextEncoder().encode('hello') }])
  })

  it('retains every native image, revised prompt, URL/base64 and usage fields', () => {
    const result = normalizeNativeImageResponse({
      created: 1_700_000_000,
      data: [
        { b64_json: 'aGVsbG8=', revised_prompt: 'first', size: '1024x1024' },
        { url: 'https://cdn.example.test/image.png', revised_prompt: 'second' },
      ],
      usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
    })

    expect(result.publicBody).toEqual({
      created: 1_700_000_000,
      data: [
        { b64_json: 'aGVsbG8=', revised_prompt: 'first', size: '1024x1024' },
        { url: 'https://cdn.example.test/image.png', revised_prompt: 'second' },
      ],
      usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
    })
    expect(result.outputs).toEqual([
      { bytes: new TextEncoder().encode('hello'), size: '1024x1024' },
      { url: 'https://cdn.example.test/image.png' },
    ])
  })

  it('converts all completed Responses image tool outputs and restores the public model', () => {
    const result = normalizeResponsesImageResponse({
      created_at: 1_700_000_001,
      model: 'internal-model',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'ignored' }] },
        {
          id: 'img_1', type: 'image_generation_call', status: 'completed',
          result: 'Zmlyc3Q=', revised_prompt: 'first prompt', size: '1024x1024', output_format: 'png',
        },
        {
          id: 'img_2', type: 'image_generation_call', status: 'completed',
          result: 'c2Vjb25k', revised_prompt: 'second prompt', size: '2048x1152', output_format: 'jpeg',
        },
      ],
      usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
    }, 'gpt-image-2', 'b64_json')

    expect(result.publicBody).toEqual({
      created: 1_700_000_001,
      data: [
        { b64_json: 'Zmlyc3Q=', revised_prompt: 'first prompt', size: '1024x1024' },
        { b64_json: 'c2Vjb25k', revised_prompt: 'second prompt', size: '2048x1152' },
      ],
      usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
      model: 'gpt-image-2',
    })
    expect(result.outputs).toHaveLength(2)
  })

  it('produces data URLs when a Responses-backed client requested url output', () => {
    const result = normalizeResponsesImageResponse({
      output: [{ type: 'image_generation_call', status: 'completed', result: 'aW1hZ2U=', output_format: 'webp' }],
    }, 'gpt-image-2', 'url')
    expect(result.publicBody).toMatchObject({
      data: [{ url: 'data:image/webp;base64,aW1hZ2U=' }],
      model: 'gpt-image-2',
    })
  })

  it('rejects missing images, malformed base64, unsafe URLs and oversized responses', async () => {
    const invalid = [
      () => normalizeNativeImageResponse({ data: [] }),
      () => normalizeNativeImageResponse({ data: [{ b64_json: '%%%bad' }] }),
      () => normalizeNativeImageResponse({ data: [{ url: 'file:///etc/passwd' }] }),
      () => normalizeResponsesImageResponse({ output: [{ type: 'message' }] }, 'gpt-image-2', 'b64_json'),
    ]
    for (const run of invalid) expect(run).toThrowError(GatewayError)

    const response = new Response(new Uint8Array(9), {
      headers: { 'content-type': 'application/json', 'content-length': '9' },
    })
    await expect(readSyncImageResponse(response, 8)).rejects.toMatchObject({
      code: 'IMAGE_UPSTREAM_RESPONSE_TOO_LARGE',
    })

    const unannounced = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5))
        controller.enqueue(new Uint8Array(5))
        controller.close()
      },
    }))
    await expect(readSyncImageResponse(unannounced, 8)).rejects.toMatchObject({
      code: 'IMAGE_UPSTREAM_RESPONSE_TOO_LARGE',
    })
  })
})
