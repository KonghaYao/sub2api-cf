import type { Env } from '../env'
import { CODEX_ORIGINATOR, CODEX_VERSION } from '../gateway/codex-original-contract'
import { GatewayError } from '../gateway/errors'
import { fetchAccountProxy } from '../gateway/proxy-fetch'

export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export interface OpenAITokens {
  access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; token_type?: string
}

export class OpenAITokenEndpointError extends GatewayError {
  constructor(readonly upstreamStatus: number, refresh: boolean) {
    super(502, refresh ? 'OPENAI_OAUTH_TOKEN_REFRESH_FAILED' : 'OPENAI_OAUTH_TOKEN_EXCHANGE_FAILED',
      `OpenAI rejected the OAuth request (HTTP ${upstreamStatus})`)
  }
}

/** Bound both fetch and body consumption, including transports that ignore abort. */
export async function openAIOAuthHttp(env: Env, url: string, init: RequestInit, proxyId: string | null,
  timeoutMs = 20_000, maximumBytes = 1024 * 1024): Promise<{ status: number; text: string }> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const operation = (async () => {
    const options = { ...init, redirect: 'manual' as const, signal: controller.signal }
    const response = proxyId ? await fetchAccountProxy(env, proxyId, new URL(url), options, controller.signal) : await fetch(url, options)
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('aborted') }
    reader = response.body?.getReader()
    const decoder = new TextDecoder(); let size = 0; let text = ''
    try {
      while (reader) {
        const part = await reader.read()
        if (controller.signal.aborted) throw new Error('aborted')
        if (part.done) break
        size += part.value.byteLength
        if (size > maximumBytes) throw new GatewayError(502, 'OPENAI_OAUTH_INVALID_RESPONSE', 'OAuth upstream response is too large')
        text += decoder.decode(part.value, { stream: true })
      }
      return { status: response.status, text: text + decoder.decode() }
    } finally { if (size > maximumBytes) void reader?.cancel().catch(() => {}); reader?.releaseLock() }
  })()
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(); void reader?.cancel().catch(() => {})
        reject(new GatewayError(504, 'OPENAI_OAUTH_TIMEOUT', 'OpenAI OAuth request timed out'))
      }, timeoutMs)
    })])
  } catch (error) {
    if (error instanceof GatewayError) throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new GatewayError(504, 'OPENAI_OAUTH_TIMEOUT', 'OpenAI OAuth request timed out')
    }
    throw new GatewayError(502, 'OPENAI_OAUTH_REQUEST_FAILED', 'Could not reach the OpenAI OAuth upstream')
  } finally { clearTimeout(timer) }
}

export async function requestOpenAITokens(env: Env, form: URLSearchParams, proxyId: string | null): Promise<OpenAITokens> {
  const response = await openAIOAuthHttp(env, 'https://auth.openai.com/oauth/token', {
    method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded',
      'user-agent': `${CODEX_ORIGINATOR}/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`, originator: CODEX_ORIGINATOR },
  }, proxyId)
  if (response.status < 200 || response.status >= 300) {
    throw new OpenAITokenEndpointError(response.status, form.get('grant_type') === 'refresh_token')
  }
  let value: Record<string, unknown>
  try { value = JSON.parse(response.text) } catch { throw invalidTokens() }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validToken(value.access_token)) throw invalidTokens()
  for (const key of ['refresh_token', 'id_token']) if (value[key] != null && value[key] !== '' && !validToken(value[key])) throw invalidTokens()
  if (value.expires_in !== undefined && (!Number.isSafeInteger(value.expires_in) || Number(value.expires_in) < 0 || Number(value.expires_in) > 31_536_000)) throw invalidTokens()
  return { access_token: value.access_token as string,
    ...(validToken(value.refresh_token) ? { refresh_token: value.refresh_token as string } : {}),
    ...(validToken(value.id_token) ? { id_token: value.id_token as string } : {}),
    ...(typeof value.expires_in === 'number' ? { expires_in: value.expires_in } : {}),
    ...(typeof value.token_type === 'string' ? { token_type: value.token_type } : {}),
  }
}
function validToken(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\u0000-\u0020\u007f]/.test(value) }
function invalidTokens() { return new GatewayError(502, 'OPENAI_OAUTH_INVALID_RESPONSE', 'OpenAI returned invalid token data') }
