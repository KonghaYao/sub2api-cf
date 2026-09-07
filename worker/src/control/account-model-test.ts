import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Env } from '../env'
import { buildProviderRequest, type ProviderAccount, type ProviderCredential, type ProviderOperation } from '../gateway/providers'
import { requireString } from './http'
import { redactDiagnosticText } from '../observability/redaction'
import { GatewayError } from '../gateway/errors'

type TestEvent = { type: string; text?: string; image_url?: string; mime_type?: string }

/** An explicit administrator test uses this account directly, outside user billing. */
export function testAccountModel(context: Context<{ Bindings: Env }>, account: ProviderAccount, credential: ProviderCredential, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const model = requireString(input, 'model_id', 256)
  const prompt = typeof input.prompt === 'string' && input.prompt.trim()
    ? requireString(input, 'prompt', 4000) : 'Reply with OK.'
  if (input.mode !== undefined && input.mode !== 'default' && input.mode !== 'compact') {
    throw new GatewayError(400, 'unsupported_test_mode', 'This account test mode is not supported')
  }
  let operation: ProviderOperation = 'chat_completions'
  let body: Record<string, unknown> = { model, messages: [{ role: 'user', content: prompt }], max_tokens: 256, stream: false }
  if (account.platform === 'anthropic') operation = 'messages'
  if (account.platform === 'gemini') {
    operation = 'generate_content'
    body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 256 } }
  }
  const useResponses = extra.openai_responses_mode === 'force_responses' ||
    (extra.openai_responses_mode !== 'force_chat_completions' && extra.openai_responses_supported !== false)
  if (account.platform === 'codex' || (account.platform === 'openai' && useResponses) || input.mode === 'compact') {
    operation = input.mode === 'compact' ? 'responses_compact' : 'responses'
    body = { model, instructions: 'Reply briefly to the user.', store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], max_output_tokens: 256, stream: operation === 'responses' }
  }
  if (account.platform === 'openai' && model.startsWith('gpt-image-')) {
    operation = 'images_generations'
    body = { model, prompt, n: 1 }
  }
  const plan = buildProviderRequest({ account, credential, model, operation, body })
  return streamSSE(context, async (stream) => {
    const controller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => { controller.abort(); void reader?.cancel().catch(() => {}) }
    stream.onAbort(stop)
    await stream.writeSSE({ data: JSON.stringify({ type: 'test_start', model }) })
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { stop(); reject(new Error('Upstream model test timed out')) }, 60_000)
      })
      const run = async () => {
        const response = await fetch(plan.url, {
          method: plan.method, headers: plan.headers, body: JSON.stringify(plan.body),
          redirect: 'manual', cache: 'no-store', signal: controller.signal,
        })
        reader = response.body?.getReader()
        const decoder = new TextDecoder()
        let text = '', size = 0
        while (reader) {
          const next = await reader.read(); if (next.done) break
          size += next.value.byteLength
          if (size > 16 * 1024 * 1024) throw new Error('Upstream model test response is too large')
          text += decoder.decode(next.value, { stream: true })
        }
        text += decoder.decode()
        if (!response.ok) {
          let detail = ''
          try {
            const failure = JSON.parse(text)
            const message = failure?.error?.message ?? failure?.message
            if (typeof message === 'string') {
              detail = redactDiagnosticText(message.split(credential.api_key).join('[REDACTED]')).slice(0, 500)
            }
          } catch { /* Do not echo non-JSON error pages. */ }
          throw new Error(`Upstream model test returned HTTP ${response.status}${detail ? ': ' + detail : ''}`)
        }
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const events: TestEvent[] = []
          let completed = false
          for (const line of text.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') { completed = true; continue }
            if (!data) continue
            const event = JSON.parse(data)
            if (event.error || event.type === 'error' || event.type === 'response.failed') throw new Error('Upstream model test returned an error event')
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') events.push({ type: 'content', text: event.delta })
            if (event.type === 'response.completed') completed = true
          }
          if (!completed || !events.length) throw new Error('Upstream model test ended without a complete result')
          return events
        }
        return resultEvents(JSON.parse(text))
      }
      const events = await Promise.race([run(), timeout])
      for (const event of events) await stream.writeSSE({ data: JSON.stringify(event) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'test_complete', success: true }) })
    } catch (error) {
      const message = error instanceof SyntaxError ? 'Upstream returned an invalid test response'
        : error instanceof Error && error.message.startsWith('Upstream ') ? error.message
          : 'Unable to complete the upstream model test'
      await stream.writeSSE({ data: JSON.stringify({ type: 'test_complete', success: false, error: message }) })
    } finally { clearTimeout(timer); stop() }
  })
}

function resultEvents(value: any): TestEvent[] {
  if (!value || typeof value !== 'object' || value.error || value.status === 'failed') throw new Error('Upstream model test returned an error response')
  const events: TestEvent[] = []
  const addText = (text: unknown) => { if (typeof text === 'string' && text) events.push({ type: 'content', text }) }
  addText(value.choices?.[0]?.message?.content)
  for (const part of value.content ?? []) addText(part.text)
  for (const output of value.output ?? []) {
    for (const part of output.content ?? []) addText(part.text)
    if (output.type === 'compaction' && output.encrypted_content) addText('Compaction completed.')
  }
  for (const part of value.candidates?.[0]?.content?.parts ?? []) {
    addText(part.text)
    if (part.inlineData?.mimeType?.startsWith('image/') && typeof part.inlineData.data === 'string') {
      events.push({ type: 'image', image_url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`, mime_type: part.inlineData.mimeType })
    }
  }
  for (const image of value.data ?? []) {
    if (typeof image.b64_json === 'string') events.push({ type: 'image', image_url: `data:image/png;base64,${image.b64_json}`, mime_type: 'image/png' })
    else if (typeof image.url === 'string' && image.url.startsWith('https://')) events.push({ type: 'image', image_url: image.url })
  }
  if (!events.length) throw new Error('Upstream model test returned no output')
  return events
}
