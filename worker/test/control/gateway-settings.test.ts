import { describe, expect, it } from 'vitest'
import { applyGatewayBodySettings, enforceGatewayClientVersion, normalizeGatewaySettings, parseGatewaySettingsPatch } from '../../src/control/gateway-settings'

describe('gateway settings consumers', () => {
  it('rejects unknown fields, invalid types and inverted client version ranges', () => {
    expect(() => parseGatewaySettingsPatch({ unimplemented: true })).toThrow('Invalid gateway setting')
    expect(() => parseGatewaySettingsPatch({ enable_model_fallback: 'true' })).toThrow()
    expect(() => normalizeGatewaySettings({ min_codex_version: '2.0.0', max_codex_version: '1.0.0' })).toThrow()
  })
  it('enforces version boundaries numerically and leaves unrelated clients unaffected', () => {
    const settings = normalizeGatewaySettings({ min_codex_version: '0.9.0', max_codex_version: '0.100.0' })
    expect(() => enforceGatewayClientVersion(settings, 'codex_cli_rs/0.10.0')).not.toThrow()
    expect(() => enforceGatewayClientVersion(settings, 'codex_cli_rs/0.101.0')).toThrow('outside')
    expect(() => enforceGatewayClientVersion(settings, 'other/0.1.0')).not.toThrow()
  })
  it('applies metadata and cache changes without changing original content', () => {
    const source = { metadata: { user_id: 'original' }, system: 'original system', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '5m' } }] }] }
    const settings = normalizeGatewaySettings({ enable_metadata_passthrough: false, enable_anthropic_cache_ttl_1h_injection: true })
    const result = applyGatewayBodySettings(settings, source, 'anthropic')
    expect(result.metadata).toBeUndefined()
    expect(result.system).toBe('original system')
    expect(JSON.stringify(result.messages)).toContain('"ttl":"5m"')
    expect(source.messages[0].content[0].cache_control.ttl).toBe('5m')
    expect(applyGatewayBodySettings(settings, source, 'openai').system).toBe('original system')
  })
})
