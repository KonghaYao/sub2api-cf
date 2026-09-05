import type { SyncImageManifest } from './sync-domain'

export const SYNC_IMAGE_VERBATIM_PROMPT_INSTRUCTIONS =
  'When invoking the image_generation tool, use the user\'s image prompt verbatim. Do not rewrite, expand, summarize, embellish, translate, normalize punctuation, or add or remove visual details or constraints. Preserve the original language, wording, capitalization, quotes, and punctuation exactly.'

export interface SyncImageResponsesRequest {
  model: string
  instructions: string
  stream: true
  store: false
  parallel_tool_calls: true
  reasoning: { effort: 'medium'; summary: 'auto' }
  include: ['reasoning.encrypted_content']
  input: Array<{
    type: 'message'
    role: 'user'
    content: Array<Record<string, unknown>>
  }>
  tool_choice: { type: 'image_generation' }
  tools: Array<Record<string, unknown>>
}

export function buildSyncImageResponsesRequest(
  manifest: SyncImageManifest,
  responsesModel: string,
): SyncImageResponsesRequest {
  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: manifest.prompt },
    ...manifest.input_images.map((input) => ({
      type: 'input_image',
      image_url: syncImageInputUrl(input),
    })),
  ]
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: manifest.operation === 'edits' ? 'edit' : 'generate',
    model: manifest.model,
  }
  if (manifest.n > 1 && manifest.model.toLowerCase() !== 'dall-e-3') tool.n = manifest.n
  copyToolOptions(tool, manifest)
  if (manifest.mask !== null) {
    tool.input_image_mask = { image_url: syncImageInputUrl(manifest.mask) }
  }

  return {
    model: responsesModel.trim(),
    instructions: SYNC_IMAGE_VERBATIM_PROMPT_INSTRUCTIONS,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    input: [{
      type: 'message',
      role: 'user',
      content,
    }],
    tool_choice: { type: 'image_generation' },
    tools: [tool],
  }
}

function syncImageInputUrl(input: SyncImageManifest['input_images'][number]): string {
  if (input.kind === 'url') return input.image_url
  return `data:${input.mime_type};base64,${encodeBase64(input.bytes)}`
}

function encodeBase64(bytes: Uint8Array): string {
  const output: string[] = []
  const chunkSize = 12_288
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
    output.push(btoa(String.fromCharCode(...chunk)))
  }
  return output.join('')
}

function copyToolOptions(tool: Record<string, unknown>, manifest: SyncImageManifest): void {
  for (const key of [
    'size',
    'quality',
    'style',
    'background',
    'output_format',
    'output_compression',
    'moderation',
    'partial_images',
  ] as const) {
    const value = manifest.options[key]
    if (value !== undefined) tool[key] = value
  }
}
