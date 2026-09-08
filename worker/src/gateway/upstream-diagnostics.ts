import { sanitizeObservabilityPayload } from '../observability/redaction'

/** Bounded diagnostics for a response that the retry loop will discard. */
export async function captureUpstreamDiagnostic(
  response: Response,
  credential: string,
): Promise<{ status: number; body: unknown }> {
  const reader = response.body?.getReader()
  if (!reader) return { status: response.status, body: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const text = await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 16_384) return '[diagnostic exceeds size limit]'
          chunks.push(chunk.value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        return new TextDecoder().decode(bytes)
      })(),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('[diagnostic timed out]'), 250) }),
    ])
    const stripped = (credential ? text.split(credential).join('[REDACTED]') : text)
      .replace(/\bcrsr_[A-Za-z0-9._~+\/=-]+/g, '[REDACTED]')
    let body: unknown = stripped
    try { body = JSON.parse(stripped) } catch { /* Keep a bounded text error. */ }
    const safe = sanitizeObservabilityPayload({ response: { status: response.status, body } })
    return safe.response as { status: number; body: unknown }
  } catch {
    return { status: response.status, body: '[diagnostic unavailable]' }
  } finally {
    clearTimeout(timer)
    // Initiate cancellation without waiting on an uncooperative upstream, then
    // release ownership even when the diagnostic deadline raced a pending read.
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
