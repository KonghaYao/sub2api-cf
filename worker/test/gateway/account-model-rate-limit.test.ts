import { describe, expect, it } from 'vitest'
import { accountModelRateLimited } from '../../src/gateway/account-model-rate-limit'
const now = Date.parse('2026-09-08T00:00:00Z')
const future = '2026-09-08T01:00:00Z'
const ui = (limits: unknown, mapping = {}) => ({ credentials: { model_mapping: mapping }, extra: { model_rate_limits: limits } })
describe('original model cooldown scope', () => {
  it('checks mapped model identity and keeps other models eligible', () => {
    const data = ui({ target: { rate_limit_reset_at: future } }, { 'alias-*': 'target' })
    expect(accountModelRateLimited(data, 'alias-a', 'openai', 'api_key', now)).toBe(true)
    expect(accountModelRateLimited(data, 'other', 'openai', 'api_key', now)).toBe(false)
  })
  it('honors expiry and ignores malformed legacy shapes', () => {
    for (const value of [future, {}, { rate_limit_reset_at: '2099-01-01' }, { rate_limit_reset_at: '2026-09-08T00:00:00Z' }, null]) {
      expect(accountModelRateLimited(ui({ model: value }), 'model', 'openai', 'api_key', now)).toBe(false)
    }
  })
  it('applies the OpenAI image family scope only to image models', () => {
    const data = ui({ 'openai:image_generation': { rate_limit_reset_at: future } })
    for (const model of ['gpt-image-1', 'grok-imagine', 'grok-imagine-edit', 'grok-imagine-image-x']) {
      expect(accountModelRateLimited(data, model, 'openai', 'api_key', now)).toBe(true)
    }
    expect(accountModelRateLimited(data, 'gpt-5', 'openai', 'api_key', now)).toBe(false)
    expect(accountModelRateLimited(data, 'gpt-image-1', 'gemini', 'api_key', now)).toBe(false)
  })
  it('applies Fable family cooldown to Anthropic variants only', () => {
    const data = ui({ 'claude-fable-5': { rate_limit_reset_at: future } })
    expect(accountModelRateLimited(data, 'claude-fable-5[1m]', 'anthropic', 'api_key', now)).toBe(true)
    expect(accountModelRateLimited(data, 'claude-sonnet-4-5', 'anthropic', 'api_key', now)).toBe(false)
    expect(accountModelRateLimited(data, 'claude-fable-5[1m]', 'openai', 'api_key', now)).toBe(false)
  })
})
