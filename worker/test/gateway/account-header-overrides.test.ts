import { expect, it } from 'vitest'
import { accountHeaderOverridesEligible, applyAccountCredentialHeaders, normalizeHeaderOverrideCredentials } from '../../src/gateway/account-header-overrides'
import { buildAccountProviderRequest } from '../../src/gateway/account-provider-request'

it.each(['openai', 'anthropic', 'kimi', 'zhipu', 'deepseek'])('limits %s overrides to API key accounts', platform => {
  expect(accountHeaderOverridesEligible(platform, 'api_key')).toBe(true)
  expect(accountHeaderOverridesEligible(platform, 'oauth')).toBe(false)
})
it('matches original Grok and unsupported-provider eligibility', () => {
  expect(accountHeaderOverridesEligible('grok', 'oauth')).toBe(true)
  expect(accountHeaderOverridesEligible('grok', 'api_key')).toBe(true)
  for (const platform of ['gemini', 'antigravity', 'codex']) expect(accountHeaderOverridesEligible(platform, 'api_key')).toBe(false)
})
it('applies saved safe headers while retaining authoritative auth and message framing', () => {
  const credential = { api_key: 'vault-key', header_override_enabled: true, header_overrides: {
    ' X-Relay-Route ': ' route-a ', Authorization: 'Bearer attacker', 'Content-Type': 'wrong',
    Cookie: 'shared-cookie', 'chatgpt-account-id': 'shared-id', 'session_id': 'shared-session',
    'X-Bad': 'value\r\ninjected: yes', 'X-Blank': '', 'X-Nonstring': 3,
  } }
  const plan = buildAccountProviderRequest({ account: { platform: 'openai', protocol: 'openai', auth_scheme: 'bearer',
    base_url: 'https://relay.test', provider_config: {}, credential_kind: 'api_key' }, credential,
    operation: 'responses', body: { model: 'model-a', stream: true } })
  expect(plan.headers.get('x-relay-route')).toBe('route-a')
  expect(plan.headers.get('authorization')).toBe('Bearer vault-key')
  expect(plan.headers.get('content-type')).toBe('application/json')
  for (const name of ['cookie', 'chatgpt-account-id', 'session_id', 'x-bad', 'x-blank', 'x-nonstring']) expect(plan.headers.has(name)).toBe(false)
})
it.each([false, 'true', undefined])('does not apply disabled or malformed enable flags: %s', enabled => {
  const headers = new Headers()
  applyAccountCredentialHeaders(headers, { header_override_enabled: enabled, header_overrides: { 'x-route': 'route-a' } })
  expect(headers.has('x-route')).toBe(false)
})

it('normalizes saved names and values while retaining named empty template entries', () => {
  const credentials = { header_override_enabled: false, header_overrides: { ' X-Route ': ' route-a ', 'X-Template': '', ' ': ' ' }, other: 'preserved' }
  normalizeHeaderOverrideCredentials(credentials)
  expect(credentials).toEqual({ header_override_enabled: false, header_overrides: { 'x-route': 'route-a', 'x-template': '' }, other: 'preserved' })
})
it.each([
  { header_override_enabled: 'true' }, { header_overrides: [] }, { header_overrides: { 'x-value': 7 } },
  { header_overrides: { 'x-name': 'a', 'X-NAME': 'b' } }, { header_overrides: { authorization: '' } },
  { header_overrides: { '': 'nonempty' } }, { header_overrides: { 'bad name': 'value' } },
  { header_overrides: { 'x-value': 'bad\r\nvalue' } }, { header_overrides: { 'x-value': 'é'.repeat(4097) } },
  { header_overrides: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-${i}`, ''])) },
])('rejects malformed saved override configuration %j', credentials => {
  expect(() => normalizeHeaderOverrideCredentials(credentials)).toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_HEADER_OVERRIDE' }))
})
