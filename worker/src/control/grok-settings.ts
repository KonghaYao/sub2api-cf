import { GatewayError } from '../gateway/errors'

// Defaults and aliases match the original Go xAI integration. These settings
// only apply after a Grok account/model has passed normal group authorization.
export const grokDefaults = {
  grok_default_text_model: 'grok-4.6',
  grok_cross_client_model_map_enabled: true,
  grok_default_base_url_mode: 'cli',
}
export type GrokSettings = typeof grokDefaults
export const grokBaseURLs = {
  api: 'https://api.x.ai/v1',
  'us-east-1': 'https://us-east-1.api.x.ai/v1',
  'us-west-2': 'https://us-west-2.api.x.ai/v1',
  'eu-west-1': 'https://eu-west-1.api.x.ai/v1',
  cli: 'https://cli-chat-proxy.grok.com/v1',
} as const
export function parseGrokSettings(value: unknown): Partial<GrokSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('object')
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(grokDefaults, key) || typeof item !== typeof grokDefaults[key as keyof GrokSettings]) throw invalid(key)
    if (key === 'grok_default_base_url_mode' && !Object.hasOwn(grokBaseURLs, item as string)) throw invalid(key)
    if (key === 'grok_default_text_model' && (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(item))) throw invalid(key)
    output[key] = item
  }
  return output
}
function invalid(field: string): GatewayError { return new GatewayError(400, 'invalid_grok_settings', 'Invalid Grok setting: ' + field) }
export function grokBaseURL(settings: GrokSettings, explicitBaseURL?: string): string {
  return explicitBaseURL?.trim() || grokBaseURLs[settings.grok_default_base_url_mode as keyof typeof grokBaseURLs]
}
const aliases: Record<string, string> = {
  "grok-4.6": "grok-4.6",
  "grok-4.6-latest": "grok-4.6",
  "grok-4.5": "grok-4.5",
  "grok-4.5-latest": "grok-4.5",
  "grok-4.3": "grok-4.3",
  "grok-4.3-latest": "grok-4.3",
  "grok-3-mini": "grok-3-mini",
  "grok-3-mini-fast": "grok-3-mini-fast",
  "grok-build": "grok-build-0.1",
  "grok-build-latest": "grok-build-0.1",
  "grok-build-0.1": "grok-build-0.1",
  "grok-composer-2.5-fast": "grok-composer-2.5-fast",
  "grok-composer": "grok-composer-2.5-fast",
  "composer-2.5": "grok-composer-2.5-fast",
  "grok-4.20-reasoning": "grok-4.20-0309-reasoning",
  "grok-4.20-0309-reasoning": "grok-4.20-0309-reasoning",
  "grok-4.20-non-reasoning": "grok-4.20-0309-non-reasoning",
  "grok-4.20-0309-non-reasoning": "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent": "grok-4.20-multi-agent-0309",
  "grok-4.20-multi-agent-latest": "grok-4.20-multi-agent-0309",
  "grok-4.20-multi-agent-0309": "grok-4.20-multi-agent-0309"
}
export function resolveGrokModel(settings: GrokSettings, model: string): string {
  const native = model.trim().replace(/^(?:xai|x-ai|grok)\//i, '').trim()
  const name = native.toLowerCase()
  if (!name || name === 'grok' || name === 'grok-latest') return settings.grok_default_text_model
  if (settings.grok_cross_client_model_map_enabled && /^(?:gpt-|codex-|o1|o3|o4|claude-)/.test(name)) return settings.grok_default_text_model
  return aliases[name] ?? native
}
