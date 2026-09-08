import { accountModelPolicy } from './account-model-policy'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Original model-rate-limit scopes are resolved after account model mapping. */
export function accountModelRateLimited(raw: unknown, requested: string, platform: string, credentialKind = 'api_key', now = Date.now()): boolean {
  let ui: Record<string, unknown>
  try { ui = typeof raw === 'string' ? object(JSON.parse(raw)) : object(raw) } catch { return false }
  const model = accountModelPolicy(ui, requested, platform, credentialKind).upstream.trim()
  if (!model) return false
  const keys = [model]
  const lower = model.toLowerCase()
  const image = (name: string) => /^(gpt-image-|grok-imagine-image)/.test(name.toLowerCase().trim()) || ['grok-imagine', 'grok-imagine-edit'].includes(name.toLowerCase().trim())
  if (platform === 'openai' && (image(model) || image(requested))) keys.push('openai:image_generation')
  if (platform === 'anthropic' && lower.includes('fable')) keys.push('claude-fable-5')
  const limits = object(object(ui.extra).model_rate_limits)
  return keys.some(key => {
    const reset = object(limits[key]).rate_limit_reset_at
    return typeof reset === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(reset) && Date.parse(reset) > now
  })
}
