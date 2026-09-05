import { describe, expect, it } from 'vitest'
import {
  SYNC_IMAGE_MAX_JSON_BYTES,
  SYNC_IMAGE_MAX_INPUT_IMAGES,
  SYNC_IMAGE_MAX_MULTIPART_BYTES,
  SYNC_IMAGE_MAX_PART_BYTES,
  SYNC_IMAGE_MAX_PROMPT_CHARS,
  parseSyncImageEditJson,
  parseSyncImageEditMultipart,
  parseSyncImageGeneration,
} from '../../src/media/sync-domain'

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = new Uint8Array([0xff, 0xd8, 0xff])
const WEBP_SIGNATURE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

function signedBytes(signature: Uint8Array, size = signature.length): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(signature)
  return bytes
}

describe('synchronous image request domain', () => {
  it('normalizes the smallest generation request with Worker-safe defaults', () => {
    expect(parseSyncImageGeneration({ prompt: 'draw a cat' })).toEqual({
      operation: 'generations',
      model: 'gpt-image-2',
      prompt: 'draw a cat',
      n: 1,
      options: {},
      input_images: [],
      mask: null,
    })
  })

  it('preserves supported generation options in the provider manifest', () => {
    expect(parseSyncImageGeneration({
      model: ' gpt-image-2 ',
      prompt: '  draw a cat  ',
      n: 3,
      size: '1536x1024',
      quality: 'high',
      style: 'vivid',
      background: 'transparent',
      output_format: 'webp',
      output_compression: 82,
      moderation: 'low',
      response_format: 'b64_json',
      stream: true,
      partial_images: 2,
      user: 'Tenant-User-1',
    })).toEqual({
      operation: 'generations',
      model: 'gpt-image-2',
      prompt: 'draw a cat',
      n: 3,
      options: {
        size: '1536x1024',
        quality: 'high',
        style: 'vivid',
        background: 'transparent',
        output_format: 'webp',
        output_compression: 82,
        moderation: 'low',
        response_format: 'b64_json',
        stream: true,
        partial_images: 2,
        user: 'Tenant-User-1',
      },
      input_images: [],
      mask: null,
    })
  })

  it('retains provider-specific size strings for upstream and billing fallback', () => {
    expect(parseSyncImageGeneration({ prompt: 'cat', size: 'provider-auto-landscape' }).options.size)
      .toBe('provider-auto-landscape')
  })

  it.each([
    ['non-object body', null, 'IMAGE_INVALID_REQUEST'],
    ['unknown field', { prompt: 'cat', api_key: 'secret' }, 'IMAGE_UNSUPPORTED_FIELD'],
    ['wrong model type', { prompt: 'cat', model: 2 }, 'IMAGE_INVALID_MODEL'],
    ['overlong model', { prompt: 'cat', model: 'm'.repeat(201) }, 'IMAGE_INVALID_MODEL'],
    ['empty prompt', { prompt: '   ' }, 'IMAGE_INVALID_PROMPT'],
    ['overlong prompt', { prompt: 'p'.repeat(SYNC_IMAGE_MAX_PROMPT_CHARS + 1) }, 'IMAGE_INVALID_PROMPT'],
    ['string n', { prompt: 'cat', n: '1' }, 'IMAGE_INVALID_N'],
    ['fractional n', { prompt: 'cat', n: 1.5 }, 'IMAGE_INVALID_N'],
    ['zero n', { prompt: 'cat', n: 0 }, 'IMAGE_INVALID_N'],
    ['too many outputs', { prompt: 'cat', n: 11 }, 'IMAGE_INVALID_N'],
    ['invalid boolean', { prompt: 'cat', stream: 'true' }, 'IMAGE_INVALID_OPTION'],
    ['invalid compression', { prompt: 'cat', output_compression: 101 }, 'IMAGE_INVALID_OPTION'],
    ['invalid format', { prompt: 'cat', output_format: 'svg' }, 'IMAGE_INVALID_OPTION'],
  ])('rejects %s', (_name, body, code) => {
    expect(() => parseSyncImageGeneration(body)).toThrow(expect.objectContaining({ code }))
  })

  it('rejects a canonical JSON request larger than the Worker boundary', () => {
    expect(() => parseSyncImageGeneration({
      prompt: 'cat',
      user: 'u'.repeat(SYNC_IMAGE_MAX_JSON_BYTES),
    })).toThrow(expect.objectContaining({ status: 413, code: 'IMAGE_REQUEST_TOO_LARGE' }))
  })

  it('normalizes JSON edits with URL inputs, a mask, and native options', () => {
    expect(parseSyncImageEditJson({
      prompt: ' replace the background ',
      images: [
        { image_url: 'https://cdn.example.test/source.png' },
        { image_url: 'data:image/png;base64,AQID' },
      ],
      mask: { image_url: 'https://cdn.example.test/mask.png' },
      n: 2,
      size: '1024x1024',
      quality: 'high',
      style: 'natural',
      background: 'transparent',
      output_format: 'png',
      output_compression: 90,
      moderation: 'auto',
      input_fidelity: 'high',
      response_format: 'url',
      user: 'user-1',
    })).toEqual({
      operation: 'edits',
      model: 'gpt-image-2',
      prompt: 'replace the background',
      n: 2,
      options: {
        size: '1024x1024',
        quality: 'high',
        style: 'natural',
        background: 'transparent',
        output_format: 'png',
        output_compression: 90,
        moderation: 'auto',
        response_format: 'url',
        input_fidelity: 'high',
        user: 'user-1',
      },
      input_images: [
        { kind: 'url', image_url: 'https://cdn.example.test/source.png' },
        { kind: 'url', image_url: 'data:image/png;base64,AQID' },
      ],
      mask: { kind: 'url', image_url: 'https://cdn.example.test/mask.png' },
    })
  })

  it.each([
    ['missing images', { prompt: 'edit' }, 'IMAGE_INVALID_IMAGES'],
    ['non-array images', { prompt: 'edit', images: {} }, 'IMAGE_INVALID_IMAGES'],
    ['empty images', { prompt: 'edit', images: [] }, 'IMAGE_INVALID_IMAGES'],
    ['too many images', {
      prompt: 'edit',
      images: Array.from({ length: SYNC_IMAGE_MAX_INPUT_IMAGES + 1 }, () => ({ image_url: 'https://cdn.example.test/a.png' })),
    }, 'IMAGE_INVALID_IMAGES'],
    ['file ids', { prompt: 'edit', images: [{ file_id: 'file_1' }] }, 'IMAGE_UNSUPPORTED_FIELD'],
    ['wrong URL type', { prompt: 'edit', images: [{ image_url: 1 }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['script URL', { prompt: 'edit', images: [{ image_url: 'javascript:alert(1)' }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['insecure URL', { prompt: 'edit', images: [{ image_url: 'http://example.test/a.png' }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['credentialed URL', { prompt: 'edit', images: [{ image_url: 'https://user:password@example.test/a.png' }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['loopback URL', { prompt: 'edit', images: [{ image_url: 'https://127.0.0.1/a.png' }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['private URL', { prompt: 'edit', images: [{ image_url: 'https://192.168.1.5/a.png' }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['unsupported data URI', { prompt: 'edit', images: [{ image_url: 'data:image/svg+xml;base64,PHN2Zz4=' }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['invalid base64 data URI', { prompt: 'edit', images: [{ image_url: 'data:image/png;base64,not-base64!' }] }, 'IMAGE_INVALID_IMAGE_URL'],
    ['bad mask shape', {
      prompt: 'edit',
      images: [{ image_url: 'https://cdn.example.test/a.png' }],
      mask: 'https://cdn.example.test/mask.png',
    }, 'IMAGE_INVALID_IMAGES'],
    ['unknown root field', {
      prompt: 'edit',
      images: [{ image_url: 'https://cdn.example.test/a.png' }],
      credential: 'never store me',
    }, 'IMAGE_UNSUPPORTED_FIELD'],
  ])('rejects dangerous or malformed JSON edit input: %s', (_name, body, code) => {
    expect(() => parseSyncImageEditJson(body)).toThrow(expect.objectContaining({ code }))
  })

  it('normalizes extracted multipart fields and owns copies of image bytes', () => {
    const imageBytes = PNG_SIGNATURE.slice()
    const maskBuffer = WEBP_SIGNATURE.slice().buffer
    const manifest = parseSyncImageEditMultipart({
      fields: {
        prompt: ' replace the sky ',
        model: 'gpt-image-2',
        n: '2',
        size: '1536x1024',
        quality: 'high',
        style: 'natural',
        background: 'transparent',
        output_format: 'webp',
        output_compression: '85',
        moderation: 'low',
        response_format: 'b64_json',
        input_fidelity: 'high',
        stream: 'false',
        partial_images: '1',
        user: 'user-1',
      },
      images: [{ filename: 'source.png', mime_type: 'image/png', bytes: imageBytes }],
      mask: { filename: 'mask.webp', mime_type: 'image/webp', bytes: maskBuffer },
    })
    imageBytes[0] = 0

    expect(manifest).toEqual({
      operation: 'edits',
      model: 'gpt-image-2',
      prompt: 'replace the sky',
      n: 2,
      options: {
        size: '1536x1024',
        quality: 'high',
        style: 'natural',
        background: 'transparent',
        output_format: 'webp',
        output_compression: 85,
        moderation: 'low',
        response_format: 'b64_json',
        input_fidelity: 'high',
        stream: false,
        partial_images: 1,
        user: 'user-1',
      },
      input_images: [{
        kind: 'bytes',
        filename: 'source.png',
        mime_type: 'image/png',
        bytes: PNG_SIGNATURE,
      }],
      mask: {
        kind: 'bytes',
        filename: 'mask.webp',
        mime_type: 'image/webp',
        bytes: WEBP_SIGNATURE,
      },
    })
  })

  it('uses the same model and output defaults for multipart edits', () => {
    expect(parseSyncImageEditMultipart({
      fields: { prompt: 'edit this' },
      images: [{ filename: 'input.jpg', mime_type: 'image/jpeg', bytes: JPEG_SIGNATURE }],
    })).toMatchObject({
      operation: 'edits',
      model: 'gpt-image-2',
      prompt: 'edit this',
      n: 1,
      options: {},
      mask: null,
    })
  })

  it.each([
    ['non-object input', null, 'IMAGE_INVALID_REQUEST'],
    ['unknown envelope field', { fields: { prompt: 'edit' }, images: [], secret: 'x' }, 'IMAGE_UNSUPPORTED_FIELD'],
    ['missing fields', { images: [] }, 'IMAGE_INVALID_REQUEST'],
    ['array fields', { fields: [], images: [] }, 'IMAGE_INVALID_REQUEST'],
    ['unknown form field', {
      fields: { prompt: 'edit', api_key: 'secret' },
      images: [{ filename: 'a.png', mime_type: 'image/png', bytes: new Uint8Array([1]) }],
    }, 'IMAGE_UNSUPPORTED_FIELD'],
    ['non-string form field', {
      fields: { prompt: 'edit', quality: 1 },
      images: [{ filename: 'a.png', mime_type: 'image/png', bytes: new Uint8Array([1]) }],
    }, 'IMAGE_INVALID_OPTION'],
    ['invalid numeric form field', {
      fields: { prompt: 'edit', output_compression: '8.5' },
      images: [{ filename: 'a.png', mime_type: 'image/png', bytes: new Uint8Array([1]) }],
    }, 'IMAGE_INVALID_OPTION'],
    ['invalid boolean form field', {
      fields: { prompt: 'edit', stream: 'yes' },
      images: [{ filename: 'a.png', mime_type: 'image/png', bytes: new Uint8Array([1]) }],
    }, 'IMAGE_INVALID_OPTION'],
    ['missing images', { fields: { prompt: 'edit' } }, 'IMAGE_INVALID_IMAGES'],
    ['too many images', {
      fields: { prompt: 'edit' },
      images: Array.from({ length: SYNC_IMAGE_MAX_INPUT_IMAGES + 1 }, (_, index) => ({
        filename: `${index}.png`, mime_type: 'image/png', bytes: new Uint8Array([1]),
      })),
    }, 'IMAGE_INVALID_IMAGES'],
    ['unknown byte part field', {
      fields: { prompt: 'edit' },
      images: [{ filename: 'a.png', mime_type: 'image/png', bytes: new Uint8Array([1]), path: '/tmp/a' }],
    }, 'IMAGE_UNSUPPORTED_FIELD'],
    ['unsafe filename', {
      fields: { prompt: 'edit' },
      images: [{ filename: '../a.png', mime_type: 'image/png', bytes: new Uint8Array([1]) }],
    }, 'IMAGE_INVALID_IMAGES'],
    ['unsupported MIME', {
      fields: { prompt: 'edit' },
      images: [{ filename: 'a.svg', mime_type: 'image/svg+xml', bytes: new Uint8Array([1]) }],
    }, 'IMAGE_UNSUPPORTED_MIME'],
    ['empty bytes', {
      fields: { prompt: 'edit' },
      images: [{ filename: 'a.png', mime_type: 'image/png', bytes: new Uint8Array() }],
    }, 'IMAGE_INVALID_IMAGES'],
    ['MIME/signature mismatch', {
      fields: { prompt: 'edit' },
      images: [{ filename: 'a.png', mime_type: 'image/png', bytes: JPEG_SIGNATURE }],
    }, 'IMAGE_INVALID_IMAGE_SIGNATURE'],
  ])('rejects malformed multipart input: %s', (_name, body, code) => {
    expect(() => parseSyncImageEditMultipart(body)).toThrow(expect.objectContaining({ code }))
  })

  it('enforces both per-part and total multipart byte limits', () => {
    expect(() => parseSyncImageEditMultipart({
      fields: { prompt: 'edit' },
      images: [{
        filename: 'huge.png',
        mime_type: 'image/png',
        bytes: new Uint8Array(SYNC_IMAGE_MAX_PART_BYTES + 1),
      }],
    })).toThrow(expect.objectContaining({ status: 413, code: 'IMAGE_UPLOAD_TOO_LARGE' }))

    expect(() => parseSyncImageEditMultipart({
      fields: { prompt: 'edit' },
      images: [
        { filename: 'a.png', mime_type: 'image/png', bytes: signedBytes(PNG_SIGNATURE, SYNC_IMAGE_MAX_PART_BYTES) },
        {
          filename: 'b.webp',
          mime_type: 'image/webp',
          bytes: signedBytes(WEBP_SIGNATURE, SYNC_IMAGE_MAX_MULTIPART_BYTES - SYNC_IMAGE_MAX_PART_BYTES),
        },
      ],
    })).toThrow(expect.objectContaining({ status: 413, code: 'IMAGE_UPLOAD_TOO_LARGE' }))
  })
})
