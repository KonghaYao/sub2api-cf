import { describe, expect, it } from 'vitest'
import { buildSyncImageResponsesRequest } from '../../src/media/sync-responses-adapter'
import type { SyncImageManifest } from '../../src/media/sync-domain'

describe('synchronous image Responses adapter', () => {
  it('builds a forced SSE image generation turn with the selected Responses model', () => {
    const manifest: SyncImageManifest = {
      operation: 'generations',
      model: 'gpt-image-2',
      prompt: '画一个蓝色马克杯，只写“SkelOT”。',
      n: 1,
      options: {},
      input_images: [],
      mask: null,
    }

    expect(buildSyncImageResponsesRequest(manifest, 'gpt-5.4-mini')).toEqual({
      model: 'gpt-5.4-mini',
      instructions: 'When invoking the image_generation tool, use the user\'s image prompt verbatim. Do not rewrite, expand, summarize, embellish, translate, normalize punctuation, or add or remove visual details or constraints. Preserve the original language, wording, capitalization, quotes, and punctuation exactly.',
      stream: true,
      store: false,
      parallel_tool_calls: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '画一个蓝色马克杯，只写“SkelOT”。' }],
      }],
      tool_choice: { type: 'image_generation' },
      tools: [{ type: 'image_generation', action: 'generate', model: 'gpt-image-2' }],
    })
  })

  it('maps supported image tool options and passes n only when multiple outputs are requested', () => {
    const manifest: SyncImageManifest = {
      operation: 'generations',
      model: 'gpt-image-2',
      prompt: 'draw three variants',
      n: 3,
      options: {
        size: '1536x1024',
        quality: 'high',
        style: 'vivid',
        background: 'transparent',
        output_format: 'webp',
        output_compression: 82,
        moderation: 'low',
        partial_images: 2,
        response_format: 'url',
        input_fidelity: 'high',
        stream: true,
        user: 'tenant-user-1',
      },
      input_images: [],
      mask: null,
    }

    const request = buildSyncImageResponsesRequest(manifest, ' responses-router-model ')

    expect(request.model).toBe('responses-router-model')
    expect(request.tools).toEqual([{
      type: 'image_generation',
      action: 'generate',
      model: 'gpt-image-2',
      n: 3,
      size: '1536x1024',
      quality: 'high',
      style: 'vivid',
      background: 'transparent',
      output_format: 'webp',
      output_compression: 82,
      moderation: 'low',
      partial_images: 2,
    }])
    expect(request.stream).toBe(true)
  })

  it('turns edit URL and byte inputs into Responses input images and a tool mask', () => {
    const manifest: SyncImageManifest = {
      operation: 'edits',
      model: 'gpt-image-2',
      prompt: 'replace the background',
      n: 2,
      options: { input_fidelity: 'high', output_format: 'png' },
      input_images: [
        { kind: 'url', image_url: 'https://cdn.example.test/source.png' },
        {
          kind: 'bytes',
          filename: 'second.jpg',
          mime_type: 'image/jpeg',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
      mask: {
        kind: 'bytes',
        filename: 'mask.webp',
        mime_type: 'image/webp',
        bytes: new Uint8Array([4, 5, 6]),
      },
    }

    const request = buildSyncImageResponsesRequest(manifest, 'gpt-5.4-mini')

    expect(request.input[0]?.content).toEqual([
      { type: 'input_text', text: 'replace the background' },
      { type: 'input_image', image_url: 'https://cdn.example.test/source.png' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AQID' },
    ])
    expect(request.tools).toEqual([{
      type: 'image_generation',
      action: 'edit',
      model: 'gpt-image-2',
      n: 2,
      output_format: 'png',
      input_image_mask: { image_url: 'data:image/webp;base64,BAUG' },
    }])
  })

  it('omits n for dall-e-3 because that image tool model does not accept multi-output n', () => {
    const manifest: SyncImageManifest = {
      operation: 'generations',
      model: 'DALL-E-3',
      prompt: 'draw a cat',
      n: 4,
      options: {},
      input_images: [],
      mask: null,
    }

    expect(buildSyncImageResponsesRequest(manifest, 'gpt-5.4-mini').tools[0]).toEqual({
      type: 'image_generation',
      action: 'generate',
      model: 'DALL-E-3',
    })
  })
})
