import type { ProviderPlatform } from '../gateway/providers'

type ApiMode = 'chat_completions' | 'responses'
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''

// Keep the original monitor's few-shot challenge and integer-token validation.
export function createMonitorChallenge() {
  let a = 1 + Math.floor(Math.random() * 50)
  let b = 1 + Math.floor(Math.random() * 50)
  const add = Math.random() < 0.5
  if (!add && a < b) [a, b] = [b, a]
  return {
    expected: String(add ? a + b : a - b),
    prompt: `Calculate and respond with ONLY the number, nothing else.\n\nQ: 3 + 5 = ?\nA: 8\n\nQ: 12 - 7 = ?\nA: 5\n\nQ: ${a} ${add ? '+' : '-'} ${b} = ?\nA:`,
  }
}

export function monitorChallengeBody(platform: ProviderPlatform, mode: ApiMode, model: string, prompt: string): Record<string, unknown> {
  if (platform === 'gemini') return { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 50 } }
  if (platform === 'openai' && mode === 'responses') return {
    model, input: prompt, max_output_tokens: 50, stream: false,
    instructions: 'You are a channel health-check endpoint. Answer the arithmetic challenge exactly and briefly.',
  }
  return { model, messages: [{ role: 'user', content: prompt }], max_tokens: 50, stream: false }
}

export function monitorResponseText(platform: ProviderPlatform, mode: ApiMode, value: unknown): string {
  const body = record(value)
  // Never accept an error envelope merely because it contains partial text.
  if (body.error != null || body.type === 'error' || ['failed', 'cancelled', 'canceled', 'incomplete'].includes(String(body.status))) return ''
  if (platform === 'anthropic') return items(body.content).map(record)
    .filter(part => part.type === 'text').map(part => text(part.text)).join('\n').trim()
  if (platform === 'gemini') {
    const content = record(record(items(body.candidates)[0]).content)
    return text(record(items(content.parts)[0]).text).trim()
  }
  if (mode === 'responses') {
    if (text(body.output_text).trim()) return text(body.output_text)
    return items(body.output).map(record).filter(item => item.type == null || item.type === '' || item.type === 'message')
      .flatMap(item => items(item.content).map(record))
      .filter(part => part.type == null || part.type === '' || part.type === 'output_text')
      .map(part => text(part.text)).join('\n').trim()
  }
  return text(record(record(items(body.choices)[0]).message).content).trim()
}

export function validMonitorAnswer(answer: string, expected: string): boolean {
  const numbers: string[] = answer.match(/-?\d+/g) ?? []
  return expected !== '' && numbers.includes(expected)
}
