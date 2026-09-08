import { afterEach, expect, it, vi } from 'vitest'
import { geminiDiagnosticRequest } from '../../src/control/gemini-text-diagnostic'
import { accountTextDiagnostic } from '../../src/control/account-text-diagnostic'
import type { Env } from '../../src/env'
const account = { platform: 'gemini' as const, protocol: 'gemini' as const, auth_scheme: 'x-goog-api-key' as const,
  base_url: 'https://relay.test/v1beta', provider_config: {} }
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('builds original Gemini payload and header auth (image=%s)', image => {
  const model = image ? 'models/gemini-3.1-flash-image-preview' : 'gemini-2.5-flash'
  const plan = geminiDiagnosticRequest(account, { api_key: 'vault-key' }, model, '  test prompt  ')
  expect(plan.url).toBe(`https://relay.test/v1beta/models/${model.replace('models/', '')}:streamGenerateContent?alt=sse`)
  expect(plan.headers.get('x-goog-api-key')).toBe('vault-key')
  expect(plan.url).not.toContain('vault-key')
  expect(plan.body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'test prompt' }] }] })
  if (image) expect(plan.body).toMatchObject({ generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } } })
  else expect(plan.body).toHaveProperty('systemInstruction')
})
it.each([false, true])('streams Gemini text and inline images before completion (wrapped=%s)', wrapped => {
  const chunk = { candidates: [{ content: { parts: [{ text: 'Hello Gemini' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }, finishReason: 'STOP' }] }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`data:${JSON.stringify(wrapped ? { response: chunk } : chunk)}\r\n\r\n`)))
  return accountTextDiagnostic({} as Env, account, { api_key: 'key' }, 'gemini-2.5-flash', null, new AbortController().signal).text().then(text => {
    expect(text).toContain('Hello Gemini')
    expect(text).toContain('data:image/png;base64,aGVsbG8=')
    expect(text).toContain('"success":true')
    expect(text.indexOf('"type":"image"')).toBeLessThan(text.indexOf('"type":"test_complete"'))
  })
})
it.each(['truncated', 'error'])('does not report success for Gemini %s', async ending => {
  const chunk = ending === 'error' ? { error: { message: 'private provider details' } } : { candidates: [{ content: { parts: [{ text: 'partial' }] } }] }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify(chunk)}\n\n`)))
  const text = await accountTextDiagnostic({} as Env, account, { api_key: 'key' }, 'gemini-2.5-flash', null, new AbortController().signal).text()
  expect(text).toContain('"success":false')
  expect(text).not.toContain('private provider details')
})
