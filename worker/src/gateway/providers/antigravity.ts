import { GatewayError } from '../errors'

export const antigravityDefaults = {
  fallback_model_antigravity: '',
  enable_identity_patch: true,
  identity_patch_prompt: '',
  antigravity_user_agent_version: '',
}
export type AntigravitySettings = typeof antigravityDefaults
export function parseAntigravitySettings(value: unknown): Partial<AntigravitySettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('object')
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(antigravityDefaults, key) || typeof item !== typeof antigravityDefaults[key as keyof AntigravitySettings]) throw invalid(key)
    if (typeof item === 'string' && (item.length > (key === 'identity_patch_prompt' ? 32768 : 256) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item))) throw invalid(key)
    if (key === 'antigravity_user_agent_version' && item !== '' && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(item as string)) throw invalid(key)
    output[key] = item
  }
  return output
}
function invalid(field: string) { return new GatewayError(400, 'invalid_antigravity_settings', 'Invalid Antigravity setting: ' + field) }
function upstreamInvalid() { return new GatewayError(502, 'invalid_upstream_response', 'Antigravity returned an invalid or incomplete response', 'server_error') }
function record(value: unknown): Record<string, any> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null }
export function antigravityUserAgent(settings: AntigravitySettings): string { return `antigravity/${settings.antigravity_user_agent_version || '1.23.2'} windows/amd64` }
export function wrapAntigravityRequest(project: string, model: string, body: unknown, settings: AntigravitySettings = antigravityDefaults): Record<string, unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(project)) throw invalid('project_id')
  if (!model || model.length > 512) throw invalid('model')
  const request = record(structuredClone(body))
  if (!request || !Array.isArray(request.contents)) throw invalid('request')
  const system = record(request.systemInstruction) ?? {}
  const parts = Array.isArray(system.parts) ? system.parts : []
  if (settings.enable_identity_patch && !parts.some(part => typeof part?.text === 'string' && part.text.includes('You are Antigravity'))) {
    request.systemInstruction = { ...system, parts: [{ text: settings.identity_patch_prompt.trim() || antigravityIdentity }, ...parts] }
  }
  return { project, requestId: 'agent-' + crypto.randomUUID(), userAgent: 'antigravity', requestType: 'agent', model, request }
}

/** Decode the v1internal envelope while retaining Gemini usage and tool parts. */
export function unwrapAntigravityValue(value: unknown): Record<string, any> {
  const root = record(value), response = record(root?.response) ?? root
  if (!response) throw upstreamInvalid()
  if (response.error) return {error:{code:502,status:'UNAVAILABLE',message:'Antigravity upstream returned an error'}}
  if (!Array.isArray(response.candidates) && !response.promptFeedback && !response.usageMetadata) throw upstreamInvalid()
  return response
}
const MAX_EVENT_CHARS = 1024 * 1024
const MAX_RESULT_BYTES = 16 * 1024 * 1024
class EnvelopeDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private lines: string[] = []
  private eventSize = 0
  private afterCR = false
  push(bytes: Uint8Array, emit: (value: Record<string, any>) => void) { this.text(this.decoder.decode(bytes, { stream: true }), emit) }
  finish(emit: (value: Record<string, any>) => void) { this.text(this.decoder.decode(), emit); if (this.line) this.endLine(emit); this.event(emit) }
  private text(text: string, emit: (value: Record<string, any>) => void) {
    for (const char of text) {
      if (this.afterCR) { this.afterCR = false; if (char === '\n') continue }
      if (char === '\r' || char === '\n') { this.endLine(emit); this.afterCR = char === '\r' }
      else { this.line += char; if (this.line.length + this.eventSize > MAX_EVENT_CHARS) throw upstreamInvalid() }
    }
  }
  private endLine(emit: (value: Record<string, any>) => void) {
    if (!this.line) this.event(emit)
    else if (this.line.startsWith('data:')) { const data = this.line.slice(5).replace(/^ /, ''); this.lines.push(data); this.eventSize += data.length + 1 }
    this.line = ''
  }
  private event(emit: (value: Record<string, any>) => void) {
    const data = this.lines.join('\n'); this.lines = []; this.eventSize = 0
    if (!data || data === '[DONE]') return
    let value: unknown; try { value = JSON.parse(data) } catch { throw upstreamInvalid() }
    emit(unwrapAntigravityValue(value))
  }
}
/** Backpressure and cancellation propagate through the standard stream pipe. */
export function createAntigravityStreamTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new EnvelopeDecoder(), encoder = new TextEncoder()
  let complete = false
  const mark = (value: Record<string, any>) => { complete ||= !!value.error || !!value.promptFeedback?.blockReason || value.candidates?.some((candidate: any) => typeof candidate.finishReason === 'string') === true }
  return new TransformStream({
    transform(chunk, controller) { decoder.push(chunk, value => { mark(value); controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n')) }) },
    flush(controller) { decoder.finish(value => { mark(value); controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n')) }); if (!complete) throw upstreamInvalid() },
  })
}
export async function normalizeAntigravityResponse(response: Response, stream: boolean, signal?: AbortSignal): Promise<Response> {
  if (!response.ok || !response.body) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length'); headers.delete('content-encoding')
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = response.body.pipeThrough(createAntigravityStreamTransform())
    if (stream) { headers.set('content-type', 'text/event-stream'); return new Response(body, { status: response.status, headers }) }
    const reader = body.getReader(), decoder = new EnvelopeDecoder(), candidates = new Map<number, Record<string, any>>()
    let total = 0, result: Record<string, any> = {}, aborted = false
    const cancel = () => { aborted = true; void reader.cancel().catch(() => {}) }
    const timeout = setTimeout(cancel, 60_000)
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel()
    const merge = (value: Record<string, any>) => {
      for (const [key, item] of Object.entries(value)) if (key !== 'candidates') result[key] = item
      for (const candidate of value.candidates ?? []) {
        const index = candidate.index ?? 0, previous = candidates.get(index)
        const parts = [...(previous?.content?.parts ?? []), ...(candidate.content?.parts ?? [])]
        candidates.set(index, { ...previous, ...candidate, ...(parts.length ? { content: { ...(previous?.content ?? {}), ...(candidate.content ?? {}), parts } } : {}) })
      }
    }
    try {
      while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > MAX_RESULT_BYTES) throw upstreamInvalid(); decoder.push(next.value, merge) }
      if (aborted) throw new GatewayError(504, 'upstream_timeout', 'Antigravity response timed out or was cancelled', 'server_error')
      decoder.finish(merge); result = { ...result, candidates: [...candidates.values()] }
      headers.set('content-type', 'application/json'); return Response.json(result, { status: response.status, headers })
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', size = 0, stopped = false
  const stop = () => { stopped = true; void reader.cancel().catch(() => {}) }
  const timer = setTimeout(stop, 60_000); signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_RESULT_BYTES) throw upstreamInvalid(); text += decoder.decode(next.value, { stream: true }) } text += decoder.decode(); if (stopped) throw new GatewayError(504, 'upstream_timeout', 'Antigravity response timed out or was cancelled', 'server_error') } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); reader.releaseLock() }
  let value: unknown; try { value = JSON.parse(text) } catch { throw upstreamInvalid() }
  const native = unwrapAntigravityValue(value)
  if (!native.error && !native.promptFeedback?.blockReason && !native.candidates?.some((candidate: any) => typeof candidate.finishReason === 'string')) throw upstreamInvalid()
  headers.set('content-type', stream ? 'text/event-stream' : 'application/json')
  return stream ? new Response('data: ' + JSON.stringify(native) + '\n\n', { status: response.status, headers }) : Response.json(native, { status: response.status, headers })
}

const antigravityIdentity = "<identity>\nYou are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\nYou are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\nThe USER will send you requests, which you must always prioritize addressing. Along with each USER request, we will attach additional metadata about their current state, such as what files they have open and where their cursor is.\nThis information may or may not be relevant to the coding task, it is up for you to decide.\n</identity>\n<communication_style>\n- **Proactiveness**. As an agent, you are allowed to be proactive, but only in the course of completing the user's task. For example, if the user asks you to add a new component, you can edit the code, verify build and test statuses, and take any other obvious follow-up actions, such as performing additional research. However, avoid surprising the user. For example, if the user asks HOW to approach something, you should answer their question and instead of jumping into editing a file.</communication_style>"
