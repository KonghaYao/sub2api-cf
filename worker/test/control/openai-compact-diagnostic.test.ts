import { afterEach, expect, it, vi } from 'vitest'
import { compactDiagnosticFound, compactDiagnosticRequest, compactDiagnosticUpdates, openAICompactDiagnostic } from '../../src/control/openai-compact-diagnostic'
import type { Env } from '../../src/env'
const account = { platform: 'openai' as const, protocol: 'openai' as const, auth_scheme: 'bearer' as const, base_url: 'https://relay.test/v1', provider_config: {} }
const credential = { api_key: 'key', access_token: 'oauth-token', chatgpt_account_id: 'acct' }
const item = { type: 'compaction', encrypted_content: 'private-blob' }
const sse = `data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('builds original native-v2 probe with stable session and ordinary mapping (OAuth=%s)', async oauth => {
  const first = await compactDiagnosticRequest(account, credential, 'gpt-5.3-high', oauth, 'opaque-id')
  const second = await compactDiagnosticRequest(account, credential, 'gpt-5.3-high', oauth, 'opaque-id')
  expect(first.url).toBe(oauth ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://relay.test/v1/responses')
  expect(first.body).toMatchObject({ model: oauth ? 'gpt-5.3-codex' : 'gpt-5.3-high', stream: true,
    instructions: 'You are a helpful coding assistant.', input: [{ type: 'message', role: 'user', content: 'Respond with OK.' }, { type: 'compaction_trigger' }] })
  expect(first.headers.get('authorization')).toBe(oauth ? 'Bearer oauth-token' : 'Bearer key')
  expect(first.headers.get('x-codex-beta-features')).toBe('remote_compaction_v2')
  expect(first.headers.get('session_id')).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{21}$/)
  expect(first.headers.get('session_id')).toBe(second.headers.get('conversation_id'))
  expect(first.headers.get('x-codex-window-id')).not.toBe(second.headers.get('x-codex-window-id'))
})
it.each([sse, 'event: response.output_item.added\r\ndata: {"item":{"type":"compaction_summary"}}\r\n\r\n',
  `data: ${JSON.stringify({ type: 'response.completed', response: { output: [item] } })}\n\n`, JSON.stringify({ output: [item] })])('recognizes original supported response form %#', body => {
  expect(compactDiagnosticFound(body)).toBe(true)
})
it.each(['', '{"output":[]}', 'data: {"type":"response.completed","response":{"output":[{"type":"message"}]}}\n\n'])('rejects responses without compact output %#', body => expect(compactDiagnosticFound(body)).toBe(false))
it.each([404, 405, 501, 400, 403, 422])('marks explicit unsupported status %s', status => {
  expect(compactDiagnosticUpdates(status, 'compaction_trigger is not supported', false, false)).toMatchObject({ openai_compact_supported: false, openai_compact_last_status: status })
})
it.each([401, 429, 500, 502, 503])('preserves prior support on transient/auth status %s', status => {
  expect(compactDiagnosticUpdates(status, 'private credential', false, false)).not.toHaveProperty('openai_compact_supported')
})
it.each(['success', 'missing', 'network', 'race'])('streams results and persists safe capability evidence: %s', async scenario => {
  vi.stubGlobal('fetch', vi.fn(async () => { if (scenario === 'network') throw new Error('private credential'); return new Response(scenario === 'missing' ? '{"output":[]}' : sse) }))
  const persist = vi.fn(async (_updates: Record<string, unknown>) => scenario !== 'race')
  const response = openAICompactDiagnostic({} as Env, account, credential, 'gpt-test', false, 'opaque', null, new AbortController().signal, persist)
  const text = await response.text()
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(text).toContain(`"success":${scenario === 'success' || scenario === 'race'}`)
  expect(text).not.toContain('private')
  expect(persist).toHaveBeenCalledOnce()
  if (scenario === 'network') expect(persist.mock.calls[0][0]).not.toHaveProperty('openai_compact_supported')
  else expect(persist.mock.calls[0][0]).toMatchObject({ openai_compact_supported: scenario !== 'missing', openai_compact_last_status: 200 })
  if (scenario === 'race') expect(text).toContain('not saved')
})
