import { GatewayError } from './errors'

// Same defensive filtering as original Account.GetHeaderOverrides.
const BLOCKED_OVERRIDE_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "upgrade", "authorization", "x-api-key", "x-goog-api-key", "cookie", "accept-encoding", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "sec-websocket-accept", "session_id", "conversation_id", "x-codex-turn-state", "x-codex-turn-metadata", "chatgpt-account-id", "x-claude-code-session-id", "x-client-request-id", "x-grok-conv-id"])
export function accountHeaderOverridesEligible(platform: string, kind: string): boolean {
  return platform === 'grok' ? kind === 'api_key' || kind === 'oauth'
    : ['openai', 'anthropic', 'kimi', 'zhipu', 'deepseek'].includes(platform) && kind === 'api_key'
}

export function applyAccountCredentialHeaders(headers: Headers, credentials: Record<string, unknown>): void {
  if (credentials.header_override_enabled !== true) return
  for (const [rawName, rawValue] of Object.entries(credentials.header_overrides && typeof credentials.header_overrides === 'object' && !Array.isArray(credentials.header_overrides) ? credentials.header_overrides : {})) {
    try {
      const entry = normalizeHeaderEntry(rawName, rawValue)
      if (entry && entry[1]) headers.set(...entry)
    } catch { /* Original runtime ignores malformed legacy rows; Fetch also requires ByteStrings. */ }
  }
}

/** Original NormalizeHeaderOverrideCredentials: validate only submitted fields. */
export function normalizeHeaderOverrideCredentials(credentials: Record<string, unknown>): void {
  const enabled = credentials.header_override_enabled
  if (enabled != null && typeof enabled !== 'boolean') throw invalidHeaderOverride('header_override_enabled must be a boolean')
  const raw = credentials.header_overrides
  if (raw == null) return
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalidHeaderOverride('header_overrides must be an object of header name to string value')
  const entries = Object.entries(raw)
  if (entries.length > 64) throw invalidHeaderOverride('header_overrides supports at most 64 entries')
  const normalized: Record<string, string> = Object.create(null)
  for (const [name, value] of entries) {
    const entry = normalizeHeaderEntry(name, value)
    if (!entry) continue
    if (Object.hasOwn(normalized, entry[0])) throw invalidHeaderOverride('duplicate header name (matching is case-insensitive)')
    normalized[entry[0]] = entry[1]
  }
  credentials.header_overrides = normalized
}

function normalizeHeaderEntry(rawName: string, rawValue: unknown): [string, string] | null {
  if (typeof rawValue !== 'string') throw invalidHeaderOverride('header value must be a string')
  const name = rawName.trim().toLowerCase(), value = rawValue.trim()
  if (!name && !value) return null
  if (!name || name.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw invalidHeaderOverride('invalid header name')
  if (BLOCKED_OVERRIDE_HEADERS.has(name)) throw invalidHeaderOverride('header is not allowed to be overridden')
  if (new TextEncoder().encode(value).byteLength > 8192 || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) throw invalidHeaderOverride('header has an invalid or oversized value')
  return [name, value]
}
function invalidHeaderOverride(message: string): GatewayError {
  return new GatewayError(400, 'INVALID_HEADER_OVERRIDE', message)
}
