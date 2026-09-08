import { buildAccountProviderRequest } from '../gateway/account-provider-request'
import type { ProviderAccount } from '../gateway/providers'
import type { UpstreamCredential } from '../gateway/types'

export function geminiDiagnosticRequest(account: ProviderAccount, credential: UpstreamCredential, model: string, prompt?: string) {
  model = model.replace(/^models\//, '')
  const image = /^(?:gemini-3\.1-flash-image|gemini-3-pro-image|gemini-2\.5-flash-image)(?:-|$)/i.test(model.replace(/^models\//i, ''))
  const text = prompt?.trim() || (image ? 'Generate a cute orange cat astronaut sticker on a clean pastel background.' : 'hi')
  return buildAccountProviderRequest({ account: { ...account, credential_kind: 'api_key' }, credential,
    operation: 'stream_generate_content', model, body: {
      contents: [{ role: 'user', parts: [{ text }] }],
      ...(image ? { generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } } }
        : { systemInstruction: { parts: [{ text: 'You are a helpful AI assistant.' }] } }),
    } })
}

export function acceptGeminiDiagnosticEvent(event: Record<string, unknown>, emit: (event: Record<string, unknown>) => void): boolean {
  const root = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : event
  if (root.error) throw new Error('Upstream diagnostic failed')
  const candidate = Array.isArray(root.candidates) ? root.candidates[0] : undefined
  if (!candidate) return false
  if (Array.isArray(candidate.content?.parts)) for (const part of candidate.content.parts) {
    if (typeof part?.text === 'string' && part.text) emit({ type: 'content', text: part.text })
    const inline = part?.inlineData
    if (typeof inline?.mimeType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(inline.mimeType) && typeof inline.data === 'string' && inline.data) {
      emit({ type: 'image', image_url: `data:${inline.mimeType};base64,${inline.data}`, mime_type: inline.mimeType })
    }
  }
  return typeof candidate.finishReason === 'string' && candidate.finishReason !== ''
}
