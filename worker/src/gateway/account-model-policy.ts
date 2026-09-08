import { GatewayError } from './errors'

// Original openai_model_mapping.go conservative OAuth exclusions.
const OAUTH_FOREIGN_PREFIXES = ["deepseek-", "glm-", "kimi-", "moonshot-", "qwen-", "qwen2-", "qwen3-", "qwen4-", "qwq-", "minimax-", "gemini-", "gemma-", "grok-", "doubao-", "hunyuan-", "llama-", "llama2-", "llama3-", "meta-llama", "mistral-", "mixtral-", "baichuan-", "ernie-", "step-", "seed-", "yi-"]

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function isAccountModelPassthrough(platform: string, rawExtra: unknown): boolean {
  const extra = object(rawExtra)
  return ['openai', 'codex'].includes(platform) &&
    (typeof extra.openai_passthrough === 'boolean' ? extra.openai_passthrough : extra.openai_oauth_passthrough === true)
}
export function accountModelPolicy(raw: unknown, requested: string, platform = 'openai', credentialKind = 'api_key'): { allowed: boolean; upstream: string } {
  let config: Record<string, unknown>
  try { config = typeof raw === 'string' ? object(JSON.parse(raw)) : object(raw) }
  catch { throw new GatewayError(500, 'invalid_account_model_policy', 'Account model policy is invalid', 'server_error') }
  if (isAccountModelPassthrough(platform, config.extra)) return { allowed: true, upstream: requested }
  const mapping = object(object(config.credentials).model_mapping)
  const entries = Object.entries(mapping).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  if (!entries.length) {
    const lastSegment = requested.trim().split('/').at(-1)!.trim().toLowerCase()
    const foreignOAuth = ['openai', 'codex'].includes(platform) && credentialKind === 'oauth' &&
      (['k3', 'k3-256k'].includes(lastSegment) || OAUTH_FOREIGN_PREFIXES.some(prefix => lastSegment.startsWith(prefix)))
    return { allowed: !foreignOAuth, upstream: requested }
  }
  // Go account.go: only a trailing * is special; target strings are literal.
  const lookup = (name: string) => entries.find(([pattern]) => pattern === name) ?? entries
    .filter(([pattern]) => pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)))
    .sort(([a], [b]) => b.length - a.length || (a < b ? -1 : 1))[0]
  let normalized = requested.trim()
  if (['gemini', 'antigravity'].includes(platform) && normalized === 'gemini-3.1-pro-preview-customtools') normalized = 'gemini-3.1-pro-preview'
  const match = lookup(requested) ?? (normalized === requested ? undefined : lookup(normalized))
  return { allowed: !!match, upstream: match ? match[1] : requested }
}

export function modelCapabilityCompatibleSql(model = 'm', accountModel = 'am', account = 'a'): string {
  return `(CASE
    WHEN ${model}.image_generation = 1 THEN ${accountModel}.image_generation = 1
    WHEN ${model}.embeddings = 1 THEN ${accountModel}.embeddings = 1
    WHEN ${model}.endpoint = 'chat_completions' THEN (${accountModel}.chat_completions = 1 OR
      (${account}.platform IN ('openai', 'codex', 'grok', 'antigravity') AND ${accountModel}.responses = 1))
    WHEN ${model}.endpoint = 'responses' THEN (${accountModel}.responses = 1 OR
      (${account}.platform IN ('openai', 'grok', 'antigravity') AND ${accountModel}.chat_completions = 1))
    ELSE (${accountModel}.chat_completions = 1 OR ${accountModel}.responses = 1)
  END)`
}

/** SQL counterpart for model discovery. Identifiers are fixed internal expressions. */
export function accountModelAllowedSql(model = 'COALESCE(gm.upstream_name_override, m.upstream_name)'): string {
  const mapping = `CASE WHEN json_type(a.ui_config_json, '$.credentials.model_mapping') = 'object'
    THEN json_extract(a.ui_config_json, '$.credentials.model_mapping') ELSE '{}' END`
  const rows = `json_each(${mapping}) mapping`
  const normalized = `CASE WHEN a.platform IN ('gemini', 'antigravity') AND trim(${model}) = 'gemini-3.1-pro-preview-customtools'
    THEN 'gemini-3.1-pro-preview' ELSE trim(${model}) END`
  const matches = (name: string) => `(mapping.key = ${name} OR (substr(mapping.key, -1) = '*' AND
    substr(${name}, 1, length(mapping.key) - 1) = substr(mapping.key, 1, length(mapping.key) - 1)))`
  const lastSegment = `lower(trim(json_extract('[' || replace(json_quote(trim(${model})), '/', '","') || ']', '$[#-1]')))`
  const foreign = `(${lastSegment} IN ('k3', 'k3-256k') OR EXISTS (
    SELECT 1 FROM json_each('${JSON.stringify(OAUTH_FOREIGN_PREFIXES)}') prefix
    WHERE substr(${lastSegment}, 1, length(prefix.value)) = prefix.value))`
  return `(
    (a.platform IN ('openai', 'codex') AND (CASE WHEN json_type(a.ui_config_json, '$.extra.openai_passthrough') IN ('true', 'false') THEN json_extract(a.ui_config_json, '$.extra.openai_passthrough') ELSE json_type(a.ui_config_json, '$.extra.openai_oauth_passthrough') = 'true' END))
    OR (NOT EXISTS (SELECT 1 FROM ${rows} WHERE mapping.type = 'text') AND
      NOT (a.platform IN ('openai', 'codex') AND a.credential_kind = 'oauth' AND ${foreign}))
    OR EXISTS (SELECT 1 FROM ${rows} WHERE mapping.type = 'text' AND (${matches(model)} OR ${matches(normalized)}))
  )`
}
