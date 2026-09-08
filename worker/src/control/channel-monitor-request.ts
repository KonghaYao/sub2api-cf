import type { AccountFetcher } from '../proxy/account-fetch'

export const MONITOR_REQUEST_TIMEOUT_MS = 45_000
export const MONITOR_DEGRADED_MS = 6_000

/** One deadline covers transport and bounded body reads, including broken transports
 * that do not reject on abort. Cleanup must never wait for upstream cancellation. */
export async function requestMonitorJson(fetcher: AccountFetcher, url: string | URL, init: RequestInit, clientSignal?: AbortSignal): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController()
  const signal = controller.signal
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelReader = () => { try { void reader?.cancel().catch(() => undefined) } catch { /* Already closed. */ } }
  const onClientAbort = () => controller.abort(clientSignal?.reason ?? new DOMException('Cancelled', 'AbortError'))
  clientSignal?.addEventListener('abort', onClientAbort, { once: true })
  if (clientSignal?.aborted) onClientAbort()
  const timer = setTimeout(() => controller.abort(new DOMException('Monitor request timed out', 'TimeoutError')), MONITOR_REQUEST_TIMEOUT_MS)
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { cancelReader(); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  const run = async () => {
    signal.throwIfAborted()
    const response = await fetcher(url, { ...init, signal })
    if (signal.aborted || !response.ok) {
      try { void response.body?.cancel().catch(() => undefined) } catch { /* Preserve status. */ }
      signal.throwIfAborted()
      return { ok: false, status: response.status, body: null }
    }
    if (!response.body) return { ok: true, status: response.status, body: null }
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      total += next.value.byteLength
      if (total > 64 * 1024) { cancelReader(); return { ok: true, status: response.status, body: null } }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let body: unknown = null
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { /* Malformed response. */ }
    return { ok: true, status: response.status, body }
  }
  try { return await Promise.race([run(), aborted]) }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    clientSignal?.removeEventListener('abort', onClientAbort)
    cancelReader()
    try { reader?.releaseLock() } catch { /* Outstanding read is cancelled. */ }
  }
}
