import { expect, it } from 'vitest'
import { openAIRateLimitReset } from '../../src/gateway/openai-rate-limit-reset'
const now = 1788840000000
const body = (error: unknown) => JSON.stringify({ error })
it.each([false, true])('prioritizes the exhausted weekly window with inverted providers=%s', reversed => {
  const headers = new Headers()
  for (const [name, minutes, used, reset] of [[reversed ? 'secondary' : 'primary', 10080, 100, 400], [reversed ? 'primary' : 'secondary', 300, 100, 900]]) {
    headers.set(`x-codex-${name}-window-minutes`, String(minutes))
    headers.set(`x-codex-${name}-used-percent`, String(used))
    headers.set(`x-codex-${name}-reset-after-seconds`, String(reset))
  }
  expect(openAIRateLimitReset(headers, body({ type: 'usage_limit_reached', resets_in_seconds: 10 }), now)).toBe(now + 400000)
})
it.each([{}, { 'x-codex-primary-window-minutes': '10080' }, { 'x-codex-secondary-window-minutes': '300' }])('uses legacy/one-window classification %#', windows => {
  const headers = new Headers({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-after-seconds': '20', 'x-codex-secondary-reset-after-seconds': '90' })
  for (const [key, value] of Object.entries(windows)) if (value !== undefined) headers.set(key, value)
  expect(openAIRateLimitReset(headers, '', now)).toBe(now + 20000)
})
it('chooses longest available reset when neither limit reports exhaustion', () => {
  expect(openAIRateLimitReset(new Headers({ 'x-codex-primary-reset-after-seconds': '10', 'x-codex-secondary-reset-after-seconds': '30' }), '', now)).toBe(now + 30000)
})
it.each([{'x-codex-primary-window-minutes': '300'}, {'x-codex-secondary-window-minutes': '10080'}])('recognizes a primary short window from one header %#', windows => {
  const headers = new Headers({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-after-seconds': '20',
    'x-codex-secondary-used-percent': '100', 'x-codex-secondary-reset-after-seconds': '90' })
  for (const [key, value] of Object.entries(windows)) if (value !== undefined) headers.set(key, value)
  expect(openAIRateLimitReset(headers, '', now)).toBe(now + 90000)
})
it('preserves header milliseconds but matches original Unix-second body precision', () => {
  expect(openAIRateLimitReset(new Headers({ 'x-codex-primary-reset-after-seconds': '10' }), '', now + 999)).toBe(now + 10999)
  expect(openAIRateLimitReset(new Headers(), body({ type: 'usage_limit_reached', resets_in_seconds: 10.8 }), now + 999)).toBe(now + 10000)
})
it.each(['usage_limit_reached', 'rate_limit_exceeded', 'GoUsageLimitError'])('parses recognized %s body with absolute priority', type => {
  expect(openAIRateLimitReset(new Headers(), body({ type, resets_at: '1788840010', resets_in_seconds: 90 }), now)).toBe(now + 10000)
  expect(openAIRateLimitReset(new Headers(), body({ type, resets_in_seconds: '90' }), now)).toBe(now + 90000)
})
it('parses OpenCode compound and fractional reset durations', () => {
  expect(openAIRateLimitReset(new Headers(), body({ type: 'GoUsageLimitError', message: 'Weekly usage limit reached. Resets in 2 days 1.5 hours.' }), now)).toBe(now + (172800 + 5400) * 1000)
})
it.each(['not JSON', body({ type: 'other', resets_in_seconds: 10 }), body({ type: 'usage_limit_reached', resets_in_seconds: '1e3' }), body({ type: 'usage_limit_reached', resets_at: 1e30 }), body({ type: 'GoUsageLimitError', message: 'Resets in 0 days.' })])('does not invent reset for invalid input %#', value => {
  expect(openAIRateLimitReset(new Headers({ 'retry-after': '60' }), value, now)).toBeNull()
})
