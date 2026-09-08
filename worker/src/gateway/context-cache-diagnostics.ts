import type { Env } from '../env'
import { stringifyJsonPreservingIntegers } from './lossless-json'

const encoder = new TextEncoder()
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Temporary, model-scoped diagnostic. Never logs request contents or raw identity
 * values. The expiration is mandatory so production collection stops by itself. */
export async function emitContextCacheFingerprint(env: Pick<Env, 'API_KEY_PEPPER' | 'CONTEXT_CACHE_DIAGNOSTICS_MODELS' | 'CONTEXT_CACHE_DIAGNOSTICS_UNTIL'>, input: {
  requestId: string; accountId: string; apiKeyId: string; model: string; operation: string;
  clientBody: unknown; upstreamBody: unknown; clientHeaders: Headers; upstreamHeaders: Headers;
}): Promise<void> {
  const until = Date.parse(env.CONTEXT_CACHE_DIAGNOSTICS_UNTIL ?? '')
  if (!env.API_KEY_PEPPER || !Number.isFinite(until) || Date.now() >= until ||
      !(env.CONTEXT_CACHE_DIAGNOSTICS_MODELS ?? '').split(',').map(value => value.trim()).includes(input.model)) return
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.API_KEY_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const digest = async (domain: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return null
      const serialized = stringifyJsonPreservingIntegers([input.apiKeyId, domain, value])
      const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(serialized)))
      return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
    }
    const describe = async (value: unknown, headers: Headers) => {
      const body = record(value)
      const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
      const selected = messages.slice(0, 128)
      return {
        format: Array.isArray(body.messages) ? 'chat' : 'responses',
        message_count: messages.length,
        message_hashes: await Promise.all(selected.map(message => digest('message', message))),
        message_hashes_truncated: messages.length > selected.length,
        context_hash: await digest('context', { messages: body.messages, input: body.input, instructions: body.instructions }),
        tools_hash: await digest('tools', { tools: body.tools, functions: body.functions }),
        prompt_cache_key_hash: await digest('identity', body.prompt_cache_key),
        session_id_hash: await digest('identity', headers.get('session_id') ?? headers.get('session-id')),
        conversation_id_hash: await digest('identity', headers.get('conversation_id')),
      }
    }
    const [client, upstream] = await Promise.all([describe(input.clientBody, input.clientHeaders), describe(input.upstreamBody, input.upstreamHeaders)])
    console.info(JSON.stringify({ event: 'context_cache_fingerprint_v1', request_id: input.requestId, account_id: input.accountId,
      model: input.model, operation: input.operation, client, upstream }))
  } catch { /* Diagnostics must never change forwarding or disclose raw errors. */ }
}
