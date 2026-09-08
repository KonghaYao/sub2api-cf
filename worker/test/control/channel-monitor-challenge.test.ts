import { describe, it, expect, vi } from 'vitest'
import { createMonitorChallenge, monitorChallengeBody, monitorResponseText, validMonitorAnswer } from '../../src/control/channel-monitor-challenge'

describe('original arithmetic channel monitor', () => {
  it('uses inclusive operand bounds and nonnegative subtraction', () => {
    const random = vi.spyOn(Math, 'random')
    try {
      random.mockReturnValueOnce(0).mockReturnValueOnce(0.999).mockReturnValueOnce(0)
      expect(createMonitorChallenge()).toMatchObject({ expected: '51', prompt: expect.stringContaining('Q: 1 + 50 = ?\nA:') })
      random.mockReturnValueOnce(0).mockReturnValueOnce(0.999).mockReturnValueOnce(0.999)
      expect(createMonitorChallenge()).toMatchObject({ expected: '49', prompt: expect.stringContaining('Q: 50 - 1 = ?\nA:') })
    } finally { random.mockRestore() }
  })
  it.each([
    ['6', '6', true], ['Answer: 6.', '6', true], ['16', '6', false], ['-6', '6', false], ['06', '6', false], ['OK', '6', false], ['', '6', false], ['0', '0', true], ['6', '', false],
  ])('validates integer tokens %s against %s', (answer, expected, valid) => {
    expect(validMonitorAnswer(answer, expected)).toBe(valid)
  })
  it('builds provider-specific requests with enough output tokens', () => {
    expect(monitorChallengeBody('openai', 'chat_completions', 'm', 'p')).toMatchObject({ max_tokens: 50, messages: [{ role: 'user', content: 'p' }] })
    expect(monitorChallengeBody('anthropic', 'chat_completions', 'm', 'p')).toMatchObject({ max_tokens: 50 })
    expect(monitorChallengeBody('openai', 'responses', 'm', 'p')).toMatchObject({ max_output_tokens: 50, input: 'p' })
    expect(monitorChallengeBody('gemini', 'chat_completions', 'm', 'p')).toMatchObject({ generationConfig: { maxOutputTokens: 50 }, contents: [{ parts: [{ text: 'p' }] }] })
  })
  it('reads final provider text without accepting reasoning and errors', () => {
    expect(monitorResponseText('openai', 'responses', { output_text: '6' })).toBe('6')
    expect(monitorResponseText('openai', 'responses', { output: [{ type: 'reasoning', content: [{ text: '99' }] }, { type: 'message', content: [{ type: 'output_text', text: '6' }] }] })).toBe('6')
    expect(monitorResponseText('anthropic', 'chat_completions', { content: [{ type: 'thinking', text: '99' }, { type: 'text', text: '6' }] })).toBe('6')
    expect(monitorResponseText('gemini', 'chat_completions', { candidates: [{ content: { parts: [{ text: '6' }] } }] })).toBe('6')
    expect(monitorResponseText('openai', 'chat_completions', { choices: [{ message: { content: '6' } }] })).toBe('6')
    expect(monitorResponseText('openai', 'responses', { output_text: '6', error: { message: 'failed' } })).toBe('')
    expect(monitorResponseText('openai', 'responses', { output_text: '6', status: 'incomplete' })).toBe('')
  })
})
