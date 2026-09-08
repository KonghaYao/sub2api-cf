import { CODEX_MODEL_ALIASES } from './codex-original-contract'

/** Original normalizeCodexModel + openai_model_alias.go; unknown names stay intact. */
export function normalizeCodexModel(value: string): string {
  const original = value.trim()
  if (!original) return 'gpt-5.4'
  if (/^(?:gpt-image-|grok-imagine-image)/i.test(original) || /^(?:grok-imagine|grok-imagine-edit)$/i.test(original)) return original
  let key = original.split('/').at(-1)!.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-')
  if (key.startsWith('gpt5')) key = 'gpt-5' + key.slice(4)
  if (!key.startsWith('gpt-') && !key.includes('codex')) return original
  for (const [from, to] of [
    ['gpt-5.4mini', 'gpt-5.4-mini'], ['gpt-5.4nano', 'gpt-5.4-nano'],
    ['gpt-5.3-codexspark', 'gpt-5.3-codex-spark'], ['gpt-5.3codexspark', 'gpt-5.3-codex-spark'],
    ['gpt-5.3codex', 'gpt-5.3-codex'],
  ]) key = key.replaceAll(from, to)
  if (Object.hasOwn(CODEX_MODEL_ALIASES, key)) return CODEX_MODEL_ALIASES[key]
  const compactBase = key.endsWith('-openai-compact') ? key.slice(0, -15) : ''
  if (Object.hasOwn(CODEX_MODEL_ALIASES, compactBase)) return CODEX_MODEL_ALIASES[compactBase]
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) if (key.includes(model)) return model
  if (key === 'gpt-5.6') return 'gpt-5.6-sol'
  if (key.startsWith('gpt-5.6-')) return /^(?:max|none|minimal|low|medium|high|xhigh|\d{4}-\d{2}-\d{2})$/.test(key.slice(8)) ? 'gpt-5.6-sol' : original
  for (const model of ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4', 'gpt-5.2', 'gpt-5.3-codex-spark', 'gpt-5.3-codex']) {
    if (key.includes(model)) return model
  }
  if (key.includes('gpt-5.3') || key.includes('codex')) return 'gpt-5.3-codex'
  if (key.includes('gpt-5')) return 'gpt-5.4'
  return original
}
