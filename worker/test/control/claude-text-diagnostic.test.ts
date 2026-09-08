import { afterEach, expect, it, vi } from 'vitest'
import { claudeTextDiagnosticRequest } from '../../src/control/claude-text-diagnostic'
import { accountTextDiagnostic } from '../../src/control/account-text-diagnostic'
import type { Env } from '../../src/env'

const account = { platform: 'anthropic' as const, protocol: 'anthropic' as const, auth_scheme: 'x-api-key' as const,
  base_url: 'https://relay.test/v1', provider_config: {} }
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('uses original payload, isolated session, and API key auth mode (bearer=%s)', bearer => {
  const credential = { api_key: 'vault-secret', header_override_enabled: true, header_overrides: { 'x-route': 'saved', 'user-agent': 'custom-cli' } }
  const a = claudeTextDiagnosticRequest(account, credential, 'mapped-claude', bearer)
  const b = claudeTextDiagnosticRequest(account, credential, 'mapped-claude', bearer)
  expect(a.url).toBe('https://relay.test/v1/messages?beta=true')
  expect(a.headers.get(bearer ? 'authorization' : 'x-api-key')).toBe(bearer ? 'Bearer vault-secret' : 'vault-secret')
  expect(a.headers.has(bearer ? 'x-api-key' : 'authorization')).toBe(false)
  expect(a.headers.get('anthropic-version')).toBe('2023-06-01')
  expect(a.headers.get('anthropic-beta')).not.toContain('oauth')
  expect(a.headers.get('user-agent')).toBe('custom-cli')
  expect(a.headers.get('x-route')).toBe('saved')
  expect(a.body).toMatchObject({ model: 'mapped-claude', stream: true, max_tokens: 1024, temperature: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }] })
  const metadata = (plan: typeof a) => JSON.parse((plan.body as { metadata: { user_id: string } }).metadata.user_id)
  expect(metadata(a).device_id).toMatch(/^[a-f0-9]{64}$/)
  expect(metadata(a).account_uuid).toBe('')
  expect(metadata(a).session_id).not.toBe(metadata(b).session_id)
})
it.each(['message_stop', 'done', 'truncated', 'error'])('reports original modal events for Claude %s', async ending => {
  const wire = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello Claude"}}\r\n\r\n' +
    (ending === 'message_stop' ? 'data: {"type":"message_stop"}\r\n\r\n' : ending === 'done' ? 'data: [DONE]\r\n\r\n' :
      ending === 'error' ? 'data: {"type":"error","error":{"message":"private upstream details"}}\r\n\r\n' : '')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wire)))
  const result = await accountTextDiagnostic({} as Env, account, { api_key: 'key' }, 'mapped-claude', null, new AbortController().signal).text()
  expect(result).toContain('Hello Claude')
  expect(result).toContain(`"success":${ending === 'message_stop' || ending === 'done'}`)
  expect(result).not.toContain('private upstream details')
})
