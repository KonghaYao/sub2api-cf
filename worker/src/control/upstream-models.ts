import { GatewayError } from '../gateway/errors'
import { buildProviderHealthRequest, type ProviderAccount, type ProviderCredential } from '../gateway/providers'

const MAX_CATALOG_BYTES = 2 * 1024 * 1024

/** Fetch a catalog only; callers decide whether to save the returned selection. */
export async function fetchUpstreamModels(account: ProviderAccount, credential: ProviderCredential) {
  const plan = buildProviderHealthRequest({ account, credential })
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      void reader?.cancel().catch(() => {})
      reject(new GatewayError(504, 'upstream_models_timeout', 'Upstream model sync timed out', 'server_error'))
    }, plan.timeout_ms)
  })
  const fetchCatalog = async () => {
    const response = await fetch(plan.url, {
      method: plan.method, headers: plan.headers, redirect: 'manual',
      cache: 'no-store', signal: controller.signal,
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      // Never reflect an upstream body: it may echo credentials or internal details.
      throw new GatewayError(502, 'upstream_models_http_error', `Upstream model sync returned HTTP ${response.status}`, 'server_error')
    }
    reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = '', size = 0
    while (reader) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_CATALOG_BYTES) {
        throw new GatewayError(502, 'upstream_models_too_large', 'Upstream model catalog exceeds the response size limit', 'server_error')
      }
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
    let value: unknown
    try { value = JSON.parse(text) } catch { throw invalidCatalog() }
    const catalog = record(value)
    const rows = catalog?.data ?? catalog?.models
    if (!Array.isArray(rows)) throw invalidCatalog()
    const models: string[] = []
    const metadata: Record<string, Record<string, unknown>> = Object.create(null)
    for (const item of rows) {
      const row = record(item)
      const rawId = row?.id ?? row?.name
      if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 256) throw invalidCatalog()
      const id = account.platform === 'gemini' ? rawId.trim().replace(/^models\//, '') : rawId.trim()
      if (Object.hasOwn(metadata, id)) continue
      models.push(id)
      const details: Record<string, unknown> = { id }
      for (const key of ['display_name', 'description', 'default_reasoning_level']) {
        if (typeof row?.[key] === 'string') details[key] = row[key]
      }
      if (typeof row?.reasoning === 'boolean') details.reasoning = row.reasoning
      for (const key of ['context_window', 'max_output_tokens']) {
        if (Number.isSafeInteger(row?.[key]) && (row![key] as number) > 0) details[key] = row![key]
      }
      for (const key of ['supported_reasoning_levels', 'input_modalities']) {
        if (Array.isArray(row?.[key]) && row[key].every((entry: unknown) => typeof entry === 'string')) details[key] = row[key]
      }
      metadata[id] = details
    }
    return { models, metadata }
  }
  try {
    return await Promise.race([fetchCatalog(), timeout])
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError(502, 'upstream_models_unreachable', 'Unable to connect to the upstream model endpoint', 'server_error')
  } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function invalidCatalog() {
  return new GatewayError(502, 'upstream_models_invalid_response', 'Upstream returned an invalid model catalog; expected a JSON model list', 'server_error')
}
