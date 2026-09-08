// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from '../helpers/sqlite-d1'
import { accountModelPolicy, accountModelAllowedSql } from '../../src/gateway/account-model-policy'

const config = (model_mapping: unknown, extra = {}) => ({ credentials: { model_mapping }, extra })
describe('original account model whitelist and mapping', () => {
  it('excludes every foreign OAuth model family declared by the original Go implementation', () => {
    const go = readFileSync('../backend/internal/service/openai_model_mapping.go', 'utf8') as string
    const block = go.match(/var openAIOAuthForeignModelPrefixes = \[\]string\{([\s\S]*?)\n\}/)![1]
    const prefixes = [...block.matchAll(/"([^"]+)"/g)].map(match => match[1])
    expect(prefixes.length).toBeGreaterThan(20)
    for (const prefix of prefixes) {
      const model = `provider/${prefix.toUpperCase()}test`
      expect(accountModelPolicy(config({}), model, 'openai', 'oauth').allowed, model).toBe(false)
      expect(accountModelPolicy(config({}), model, 'openai', 'api_key').allowed, model).toBe(true)
    }
  })

  it('matches Go Gemini alias fallback while preferring any match for the original requested name', () => {
    expect(accountModelPolicy(config({ 'gemini-3.1-pro-preview': 'canonical' }), ' gemini-3.1-pro-preview-customtools ', 'gemini'))
      .toEqual({ allowed: true, upstream: 'canonical' })
    expect(accountModelPolicy(config({ 'gemini-3.1-pro-preview': 'canonical', 'gemini-3.1-pro-preview-custom*': 'raw-target' }), 'gemini-3.1-pro-preview-customtools', 'gemini').upstream)
      .toBe('raw-target')
  })

  it('keeps discovery SQL consistent with scheduling for aliases, OAuth restrictions and explicit overrides', () => {
    const { raw } = createSqliteD1()
    const cases: Array<[unknown, string, string, string, boolean]> = [
      [config({}), 'openai', 'oauth', 'namespace/ DeepSeek-V4 ', false],
      [config({}), 'openai', 'oauth', 'k3-256k', false],
      [config({}), 'openai', 'oauth', 'custom-k3-alias', true],
      [config({}), 'openai', 'oauth', 'claude-3-5-haiku-20241022', true],
      [config({}), 'openai', 'api_key', 'deepseek-v4', true],
      [config({ 'deepseek-*': 'gpt-5' }), 'openai', 'oauth', 'deepseek-v4', true],
      [config({ old: 'target' }, { openai_passthrough: true }), 'openai', 'oauth', 'deepseek-v4', true],
      [config({ old: 'target' }, { openai_passthrough: true }), 'anthropic', 'api_key', 'new', false],
      [config({ old: 'target' }, { openai_passthrough: false, openai_oauth_passthrough: true }), 'openai', 'api_key', 'new', false],
      [config({ old: 'target' }, { openai_passthrough: null, openai_oauth_passthrough: true }), 'openai', 'api_key', 'new', true],
      [config({ 'gemini-3.1-pro-preview': 'target' }), 'gemini', 'api_key', 'gemini-3.1-pro-preview-customtools', true],
      [config({ 'gemini-3.1-pro-preview': 'target' }), 'openai', 'api_key', 'gemini-3.1-pro-preview-customtools', false],
      [config({ 'custom-*': 'literal' }), 'openai', 'api_key', ' custom-model ', true],
      [config({ 'gpt_%': 'target' }), 'openai', 'api_key', 'gpt-5', false],
      [config({ ignored: null }), 'openai', 'api_key', 'any-model', true],
      [config({}), 'openai', 'oauth', 'quoted"namespace/gpt-5', true],
    ]
    try {
      const query = raw.prepare(`SELECT ${accountModelAllowedSql('input.name')} allowed
        FROM (SELECT ? ui_config_json, ? platform, ? credential_kind) a CROSS JOIN (SELECT ? name) input`)
      for (const [value, platform, kind, model, allowed] of cases) {
        expect(accountModelPolicy(value, model, platform, kind).allowed, `${platform}/${kind}/${model}`).toBe(allowed)
        expect(Boolean((query.get(JSON.stringify(value), platform, kind, model) as any).allowed), `discovery: ${model}`).toBe(allowed)
      }
    } finally { raw.close() }
  })

  it('allows empty mapping and treats exact matches as higher priority than prefix patterns', () => {
    expect(accountModelPolicy(config({}), 'model')).toEqual({ allowed: true, upstream: 'model' })
    expect(accountModelPolicy(config({ '*': 'all', 'gpt-*': 'family', 'gpt-special': 'exact' }), 'gpt-special'))
      .toEqual({ allowed: true, upstream: 'exact' })
  })
  it('uses the longest trailing prefix and a literal target without substituting the suffix', () => {
    expect(accountModelPolicy(config({ '*': 'all', 'gpt-*': 'family', 'gpt-5*': 'target-*' }), 'gpt-5.4'))
      .toEqual({ allowed: true, upstream: 'target-*' })
  })
  it('denies nonmatching models and does not treat interior stars or SQL wildcard characters as special', () => {
    for (const pattern of ['gpt-4', 'gpt-*-mini', 'gpt_%']) {
      expect(accountModelPolicy(config({ [pattern]: 'target' }), 'gpt-5-mini').allowed).toBe(false)
    }
  })
  it('bypasses stale mappings in OpenAI passthrough without changing other providers', () => {
    const value = config({ old: 'target' }, { openai_passthrough: true })
    expect(accountModelPolicy(value, 'new', 'openai')).toEqual({ allowed: true, upstream: 'new' })
    expect(accountModelPolicy(value, 'new', 'anthropic').allowed).toBe(false)
  })
  it('ignores non-string mapping entries and safely handles prototype-looking model names', () => {
    expect(accountModelPolicy(config({ ignored: false }), 'model').allowed).toBe(true)
    expect(accountModelPolicy(config(JSON.parse('{"__proto__":"upstream"}')), '__proto__'))
      .toEqual({ allowed: true, upstream: 'upstream' })
    expect(() => accountModelPolicy('{broken', 'model')).toThrow('policy is invalid')
  })
})
