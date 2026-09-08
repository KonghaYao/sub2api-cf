import { buildAccountProviderRequest } from '../gateway/account-provider-request'
import type { ProviderAccount } from '../gateway/providers'
import type { UpstreamCredential } from '../gateway/types'

export function isOpenAIImageDiagnosticModel(model: string): boolean {
  return model.toLowerCase().startsWith('gpt-image-')
}

export function openAIImageDiagnosticRequest(account: ProviderAccount, credential: UpstreamCredential, model: string, prompt?: string, oauth = false, authorization?:string) {
  const text = prompt?.trim() || 'Generate a cute orange cat astronaut sticker on a clean pastel background.'
  if (oauth) return buildAccountProviderRequest({ account: { ...account, credential_kind: 'oauth' }, credential, authorization,
    operation: 'responses', model: 'gpt-5.4-mini', body: {
      instructions: "When invoking the image_generation tool, use the user's image prompt verbatim. Do not rewrite, expand, summarize, embellish, translate, normalize punctuation, or add or remove visual details or constraints. Preserve the original language, wording, capitalization, quotes, and punctuation exactly.",
      stream: true, store: false, reasoning: { effort: 'medium', summary: 'auto' }, parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'], tool_choice: { type: 'image_generation' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
      tools: [{ type: 'image_generation', action: 'generate', model }],
    } })
  return buildAccountProviderRequest({ account: { ...account, credential_kind: 'api_key' }, credential,
    operation: 'images_generations', model, body: { model,
      prompt: text,
      n: 1, response_format: 'b64_json' } })
}

/** Output-item events may carry images absent from the terminal response. */
export function createOpenAIImageDiagnosticCollector(emit: (event: Record<string, unknown>) => void) {
  const images = new Map<string, Record<string, unknown>>()
  const add = (item: any) => {
    if (item?.type !== 'image_generation_call' || typeof item.result !== 'string' || !item.result.trim()) return
    images.set(typeof item.id === 'string' && item.id ? item.id : item.result, item)
  }
  const finish = () => {
    if (!images.size) throw new Error('Upstream diagnostic returned no images')
    for (const item of images.values()) {
      if (typeof item.revised_prompt === 'string' && item.revised_prompt) emit({ type: 'content', text: item.revised_prompt })
      const mime = item.output_format === 'jpeg' || item.output_format === 'jpg' ? 'image/jpeg' : item.output_format === 'webp' ? 'image/webp' : 'image/png'
      emit({ type: 'image', image_url: `data:${mime};base64,${item.result}`, mime_type: mime })
    }
    return true
  }
  return { finish, accept(event: Record<string, unknown>): boolean {
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('Upstream diagnostic failed')
    if (event.type === 'response.output_item.done') add(event.item)
    if (event.type !== 'response.completed') return false
    const result = event.response as Record<string, unknown> | undefined
    if (!result || (result.status !== undefined && result.status !== 'completed')) throw new Error('Upstream diagnostic failed')
    if (Array.isArray(result.output) && result.output.some(item => item?.type === 'image_generation_call' && typeof item.result === 'string' && item.result.trim())) {
      images.clear()
      result.output.forEach(add)
    }
    return finish()
  } }
}

export function acceptOpenAIImageDiagnosticResult(value: unknown, emit: (event: Record<string, unknown>) => void): void {
  const data = value && typeof value === 'object' && 'data' in value ? value.data : undefined
  if (!Array.isArray(data) || !data.some(item => typeof item?.b64_json === 'string' && item.b64_json)) {
    throw new Error('Upstream diagnostic returned no images')
  }
  for (const item of data) {
    if (typeof item?.revised_prompt === 'string' && item.revised_prompt) emit({ type: 'content', text: item.revised_prompt })
    if (typeof item?.b64_json === 'string' && item.b64_json) emit({ type: 'image',
      image_url: `data:image/png;base64,${item.b64_json}`, mime_type: 'image/png' })
  }
}
