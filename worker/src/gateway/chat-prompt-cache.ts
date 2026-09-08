import { sha256Hex } from './crypto'
import { normalizeCodexModel } from './codex-model-normalization'

const SESSION_HEADERS = ['session-id', 'session_id', 'conversation_id', 'x-session-affinity', 'x-session-id', 'x-opencode-session', 'x-conversation-id']
type JsonObject = Record<string, unknown>

/** Original Chat compat seed: system instructions + first user + tool contract.
 * Later assistant/user turns intentionally do not change the cache identity.
 */
export async function deriveChatPromptCacheKey(body: JsonObject, model: string): Promise<string> {
  const parts = ['model=' + normalizeCodexModel(model)]
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort !== '') parts.push('reasoning_effort=' + body.reasoning_effort.trim())
  if (body.tool_choice !== undefined) parts.push('tool_choice=' + stableJson(body.tool_choice))
  for (const field of ['tools', 'functions']) if (Array.isArray(body[field]) && body[field].length) parts.push(field + '=' + stableJson(body[field]))
  let firstUser = false
  if (Array.isArray(body.messages)) for (const raw of body.messages) {
    const message = object(raw)
    const role = typeof message?.role === 'string' ? message.role.trim() : ''
    if (role === 'system') parts.push('system=' + stableJson(message?.content))
    if (role === 'user' && !firstUser) { parts.push('first_user=' + stableJson(message?.content)); firstUser = true }
  }
  return 'compat_cc_' + (await sha256Hex(parts.join('|'))).slice(0, 16)
}

export async function chatPromptCacheIdentity(input: {
  body: unknown; model: string; headers: Headers; apiKeyId: string; oauth: boolean
}): Promise<{ promptCacheKey: string; sessionId: string } | null> {
  const body = object(input.body)
  if (!body) return null
  const responsesShape = !Object.hasOwn(body, 'messages') && Object.hasOwn(body, 'input')
  if (!responsesShape && !Array.isArray(body.messages)) return null
  let key = SESSION_HEADERS.map(header => input.headers.get(header)?.trim()).find(Boolean)
    || (typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key.trim() : '')
  let isolated = false
  if (!key) {
    if (responsesShape) return null
    const model = input.model.trim().toLowerCase()
    if (!model.includes('gpt-5') && !model.includes('codex')) return null
    const normalized = normalizeCodexModel(model).toLowerCase()
    if (!normalized.startsWith('gpt-5') && !normalized.includes('codex')) return null
    key = await deriveChatPromptCacheKey(body, input.model)
    if (!input.oauth) { key = await isolate(input.apiKeyId, key); isolated = true }
  }
  const sessionSeed = isolated ? key : await isolate(input.apiKeyId, key)
  const hash = await sha256Hex(sessionSeed)
  const variant = (parseInt(hash[16]!, 16) & 3 | 8).toString(16)
  return { promptCacheKey: key, sessionId: `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${variant}${hash.slice(17,20)}-${hash.slice(20,32)}` }
}

// Worker API-key IDs are strings. Use an unambiguous tenant namespace rather
// than Go's integer-ID xxhash encoding; the isolation and stability contract is the same.
async function isolate(apiKeyId: string, key: string): Promise<string> {
  return (await sha256Hex(JSON.stringify(['worker-openai-cache-v1', apiKeyId, key]))).slice(0, 32)
}
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}
function stableJson(value: unknown): string {
  if (value === undefined) return ''
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  const record = object(value)
  if (record) return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}'
  return JSON.stringify(value)
}

/** Original deriveOpenAIContentSessionSeed; scheduling identity is separate
 * from the provider cache key and applies to all OpenAI-compatible models.
 */
export function openAIContentSessionSeed(body: JsonObject): string | undefined {
  let seed = typeof body.model === 'string' && body.model ? 'model=' + body.model : ''
  for (const field of ['tools','functions']) if (Array.isArray(body[field]) && body[field].length) seed += '|' + field + '=' + stableJson(body[field])
  if (typeof body.instructions === 'string' && body.instructions) seed += '|instructions=' + body.instructions
  let firstUser = false
  if (Array.isArray(body.messages)) {
    let prefixOpen = true
    for (const raw of body.messages) {
      const message = object(raw), role = message?.role
      if (role === 'system' || role === 'developer') {
        if (prefixOpen) seed += '|system=' + stableJson(message?.content)
      } else {
        prefixOpen = false
        if (role === 'user' && !firstUser) { seed += '|first_user=' + stableJson(message?.content); firstUser = true }
      }
    }
  } else if (typeof body.input === 'string') seed += '|input=' + body.input
  else if (Array.isArray(body.input)) for (const raw of body.input) {
    const item = object(raw), role = item?.role
    if (role === 'system' || role === 'developer') seed += '|system=' + stableJson(item?.content)
    if (role === 'user' && !firstUser) { seed += '|first_user=' + stableJson(item?.content); firstUser = true }
    if (!firstUser && item?.type === 'input_text') { seed += '|first_user=' + (typeof item.text === 'string' ? item.text : ''); firstUser = true }
  }
  return seed ? 'compat_cs_' + seed : undefined
}
