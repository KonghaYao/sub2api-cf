import { describe, expect, it } from 'vitest'
import { parseMediaSubmit } from '../../src/media/domain'

describe('media submit normalization', () => {
  it('expands outputs deterministically and defaults missing custom ids by source ordinal', async () => {
    const parsed = await parseMediaSubmit({
      model: 'gemini-image',
      items: [
        { prompt: 'first', output_count: 3 },
        { custom_id: '', prompt: 'second' },
        { custom_id: 'cover', prompt: 'third', output_count: 2 },
      ],
    }, 'gemini-2.5-flash-image', 1)

    expect(parsed.expectedOutputCount).toBe(6)
    expect(parsed.manifest.items.map((item) => [item.custom_id, item.output_count])).toEqual([
      ['item_000001_01', 1],
      ['item_000001_02', 1],
      ['item_000001_03', 1],
      ['item_000002', 1],
      ['cover_01', 1],
      ['cover_02', 1],
    ])
  })

  it('enforces the upstream Flash/Pro reference boundary and rejects file_uri', async () => {
    const references = Array.from({ length: 4 }, () => ({ mime_type: 'image/png', data: 'aGVsbG8=' }))
    await expect(parseMediaSubmit({
      model: 'alias', items: [{ custom_id: 'x', prompt: 'x', reference_images: references }],
    }, 'gemini-flash-image')).rejects.toMatchObject({ code: 'BATCH_IMAGE_INVALID_REFERENCE_IMAGES' })
    await expect(parseMediaSubmit({
      model: 'alias', items: [{ custom_id: 'x', prompt: 'x', reference_images: references }],
    }, 'gemini-pro-image')).resolves.toMatchObject({ expectedOutputCount: 1 })
    await expect(parseMediaSubmit({
      model: 'alias',
      items: [{ custom_id: 'x', prompt: 'x', reference_images: [{ mime_type: 'image/png', file_uri: 'gs://x' }] }],
    }, 'gemini-pro-image')).rejects.toMatchObject({ code: 'BATCH_IMAGE_REFERENCE_URI_UNSUPPORTED' })
  })
})
