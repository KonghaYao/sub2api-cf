import { afterEach, expect, it, vi } from 'vitest'
import { accountTextDiagnostic } from '../../src/control/account-text-diagnostic'
import { openAIImageDiagnosticRequest } from '../../src/control/openai-image-diagnostic'
import type { Env } from '../../src/env'
const account = { platform: 'openai' as const, protocol: 'openai' as const, auth_scheme: 'bearer' as const,
  base_url: 'https://relay.test/v1', provider_config: {} }
afterEach(() => vi.unstubAllGlobals())
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`
const credential = { api_key: 'key', access_token: 'access', chatgpt_account_id: 'acct', header_override_enabled: true, header_overrides: { 'x-image-route': 'saved' } }
const item = { id: 'img_1', type: 'image_generation_call', result: 'aGVsbG8=', output_format: 'webp', revised_prompt: 'A cat' }
it('matches original API-key image payload, base path and saved headers', () => {
  const plan = openAIImageDiagnosticRequest(account, credential, 'gpt-image-2', '  Draw a cat  ')
  expect(plan.url).toBe('https://relay.test/v1/images/generations')
  expect(plan.headers.get('authorization')).toBe('Bearer key')
  expect(plan.headers.get('x-image-route')).toBe('saved')
  expect(plan.body).toEqual({ model: 'gpt-image-2', prompt: 'Draw a cat', n: 1, response_format: 'b64_json' })
})
it('uses the original OAuth image tool and actual OAuth credential', () => {
  const plan = openAIImageDiagnosticRequest(account, { ...credential, api_key: 'wrong' }, 'gpt-image-2', undefined, true)
  expect(plan.url).toBe('https://chatgpt.com/backend-api/codex/responses')
  expect(plan.headers.get('authorization')).toBe('Bearer access')
  expect(plan.headers.get('chatgpt-account-id')).toBe('acct')
  expect(plan.body).toMatchObject({ model: 'gpt-5.4-mini', store: false, stream: true,
    tool_choice: { type: 'image_generation' }, tools: [{ type: 'image_generation', action: 'generate', model: 'gpt-image-2' }],
    reasoning: { effort: 'medium', summary: 'auto' },
    input: [{ content: [{ text: 'Generate a cute orange cat astronaut sticker on a clean pastel background.' }] }] })
})
it.each(['json', 'terminal', 'item', 'item-only'])('returns images and revised prompts in modal events: %s', async source => {
  const payload = source === 'json' ? JSON.stringify({ data: [{ b64_json: item.result, revised_prompt: item.revised_prompt }] })
    : event({ type: 'response.output_item.done', item }) + (source === 'item-only' ? '' : event({ type: 'response.completed', response: { status: 'completed', output: source === 'terminal' ? [item] : [] } }))
  // Split at every byte to exercise fragmented JSON/SSE decoding.
  const bytes = new TextEncoder().encode(payload)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close() } }))))
  const text = await accountTextDiagnostic({} as Env, account, credential, 'gpt-image-2', null, new AbortController().signal, { oauth: source !== 'json' }).text()
  expect(text).toContain('"text":"A cat"')
  expect(text).toContain(`data:image/${source === 'json' ? 'png' : 'webp'};base64,aGVsbG8=`)
  expect(text.match(/"type":"image"/g)).toHaveLength(1)
  expect(text).toContain('"success":true')
})
it.each(['empty', 'url-only', 'malformed', 'http-error', 'truncated', 'no-image-terminal'])('never reports successful image generation on %s', async scenario => {
  const oauth = scenario === 'truncated' || scenario === 'no-image-terminal'
  const payload = scenario === 'truncated' ? event({ type: 'response.image_generation_call.partial_image', partial_image_b64: item.result })
    : scenario === 'no-image-terminal' ? event({ type: 'response.completed', response: { status: 'completed', output: [] } })
    : scenario === 'empty' ? '{"data":[]}' : scenario === 'url-only' ? '{"data":[{"url":"https://private.test/image"}]}' : 'private provider details'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, { status: scenario === 'http-error' ? 401 : 200 })))
  const text = await accountTextDiagnostic({} as Env, account, credential, 'gpt-image-2', null, new AbortController().signal, { oauth }).text()
  expect(text).toContain('"success":false')
  expect(text).not.toContain('private provider details')
  expect(text).not.toContain('"type":"image"')
})
