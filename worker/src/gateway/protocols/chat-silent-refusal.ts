import { GatewayError } from '../errors'

const MIN_REQUEST_BYTES = 64 * 1024
const MAX_PREFIX_BYTES = 16 * 1024 * 1024
const MAX_EVENT_CHARS = 256 * 1024
const BODY_TIMEOUT_MS = 15 * 60_000
const RENEW_MS = 20_000
const object = (value: unknown): Record<string, any> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null

/** Original Go raw Chat detector: the threshold and evidence rules are deliberate.
 * Reasoning/tool fields (even empty), usage objects and explicit errors are not
 * silent refusals. A stop marker alone is insufficient until DONE or EOF.
 */
export class ChatSilentRefusalDetector {
  private released = false
  private finishReason = ''
  private done = false
  observe(frame: string): void {
    const lines = frame.split(/\r?\n/)
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? ''
    if (event === 'error' || event === 'response.failed' || event.includes('reasoning')) this.released = true
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data.trim() === '[DONE]') { this.done = true; return }
    if (!data.trim()) return
    let root: Record<string, any> | null
    try { root = object(JSON.parse(data)) } catch { this.released = true; return }
    if (!root) return
    if (Object.hasOwn(root, 'error') || object(root.usage) || object(object(root.response)?.usage)) this.released = true
    if (root.type === 'error' || root.type === 'response.failed' || typeof root.type === 'string' && root.type.includes('reasoning')) this.released = true
    const type = typeof root.type === 'string' ? root.type.trim() : event
    if (type === 'error' || type === 'response.failed') this.released = true
    if (type === 'response.output_text.delta' && typeof root.delta === 'string' && root.delta !== '') this.released = true
    if (type === 'response.output_item.added' && ['function_call', 'reasoning'].includes(root.item?.type)) this.released = true
    if (type === 'response.function_call_arguments.delta') this.released = true
    if (type === 'response.completed' || type === 'response.done') this.finishReason = 'stop'
    if (type === 'response.incomplete') this.finishReason = 'length'
    if (Array.isArray(root.response?.output)) for (const item of root.response.output) {
      if (['function_call', 'reasoning'].includes(item?.type)) this.released = true
      if (item?.type === 'message' && Array.isArray(item.content) && item.content.some((part: any) => typeof part?.text === 'string' && part.text !== '')) this.released = true
    }
    if (Array.isArray(root.choices)) for (const choice of root.choices) {
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.trim()) this.finishReason = choice.finish_reason.trim()
      const delta = object(choice?.delta)
      if (!delta) continue
      if (delta.content != null && delta.content !== '' ||
          ['tool_calls', 'function_call', 'reasoning', 'reasoning_content', 'reasoning_summary'].some(key => Object.hasOwn(delta, key))) this.released = true
    }
  }
  canRelease(): boolean { return this.released || this.finishReason !== '' && this.finishReason !== 'stop' }
  terminal(): boolean { return this.done }
  isSilent(): boolean { return !this.released && this.finishReason === 'stop' }
}

/** Holds only a bounded prefix until evidence permits exposing the same reader.
 * No tee, no second upstream request, and no output from a refused attempt leaks.
 */
export async function inspectChatSilentRefusal(response: Response, requestBytes: number,
  options: { signal: AbortSignal; keepAlive?: () => Promise<void>; timeoutMs?: number },
): Promise<Response> {
  if (requestBytes < MIN_REQUEST_BYTES || !response.body) return response
  const reader = response.body.getReader(), decoder = new TextDecoder(), detector = new ChatSilentRefusalDetector()
  const prefix: Uint8Array[] = []
  let total = 0, buffer = '', nextRenew = Date.now() + RENEW_MS
  const deadline = Date.now() + (options.timeoutMs ?? BODY_TIMEOUT_MS)
  let transferred = false
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new GatewayError(499, 'client_cancelled', 'Client cancelled the request', 'invalid_request_error'))
    options.signal.addEventListener('abort', onAbort, { once: true })
    if (options.signal.aborted) onAbort()
  })
  // The listener may reject while renewal work is pending; keep it observed.
  void aborted.catch(() => undefined)
  const observe = (flush = false) => {
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
      detector.observe(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length)
      if (detector.canRelease() || detector.terminal()) return
    }
    if (flush && buffer.trim()) { detector.observe(buffer); buffer = '' }
    if (buffer.length > MAX_EVENT_CHARS) throw new GatewayError(502, 'invalid_upstream_stream', 'Upstream SSE event exceeded the size limit', 'server_error')
  }
  try {
    while (true) {
      const pending = reader.read()
      let result: ReadableStreamReadResult<Uint8Array>
      while (true) {
        const now = Date.now()
        if (now >= deadline) throw new GatewayError(504, 'upstream_timeout', 'Upstream stream did not complete in time', 'server_error')
        let timer: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([pending, aborted, new Promise<'tick'>(resolve => {
          timer = setTimeout(() => resolve('tick'), Math.max(1, Math.min(deadline, nextRenew) - now))
        })]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
        if (outcome !== 'tick') { result = outcome; break }
        if (Date.now() >= nextRenew) { await options.keepAlive?.(); nextRenew = Date.now() + RENEW_MS }
      }
      if (result.done) { buffer += decoder.decode(); observe(true); break }
      prefix.push(result.value); total += result.value.byteLength
      if (total > MAX_PREFIX_BYTES) throw new GatewayError(502, 'invalid_upstream_stream', 'Upstream SSE prefix exceeded the size limit', 'server_error')
      buffer += decoder.decode(result.value, { stream: true }); observe()
      if (detector.canRelease() || detector.terminal()) break
      if (Date.now() >= nextRenew) { await options.keepAlive?.(); nextRenew = Date.now() + RENEW_MS }
    }
    if (!detector.canRelease() && detector.isSilent()) {
      throw new GatewayError(502, 'openai_silent_refusal', 'Upstream returned an empty completion without usage; no fallback account was available', 'upstream_error')
    }
    let index = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < prefix.length) { const chunk = prefix[index]; prefix[index++] = new Uint8Array(0); controller.enqueue(chunk); return }
        try {
          const result = await reader.read()
          if (result.done) { reader.releaseLock(); controller.close() } else controller.enqueue(result.value)
        } catch (error) { reader.releaseLock(); controller.error(error) }
      },
      cancel(reason) { void reader.cancel(reason).catch(() => undefined); reader.releaseLock() },
    })
    transferred = true
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } finally {
    if (onAbort) options.signal.removeEventListener('abort', onAbort)
    if (!transferred) { void reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
}
