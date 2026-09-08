import { expect, it } from 'vitest'
import { normalizeCodexModel } from '../../src/gateway/codex-model-normalization'
import { CODEX_MODEL_ALIASES } from '../../src/gateway/codex-original-contract'

it.each(Object.entries(CODEX_MODEL_ALIASES))('normalizes original alias %s', (model, expected) => {
  expect(normalizeCodexModel(model)).toBe(expected)
})
it.each([
  ['', 'gpt-5.4'], ['vendor/GPT5.3_CODEXSPARK', 'gpt-5.3-codex-spark'],
  [' GPT-5.4mini high ', 'gpt-5.4-mini'], ['gpt-5.3-openai-compact', 'gpt-5.3-codex'],
  ['gpt-5.6-max', 'gpt-5.6-sol'], ['gpt-5.6-2026-08-20', 'gpt-5.6-sol'],
  ['gpt-5.6-new-provider', 'gpt-5.6-new-provider'], ['vendor/UnknownModel', 'vendor/UnknownModel'],
  ['gpt-image-2', 'gpt-image-2'], ['gpt-5.5-pro-high', 'gpt-5.5-pro'],
])('preserves original spelling and family rules for %s', (model, expected) => {
  expect(normalizeCodexModel(model)).toBe(expected)
})
