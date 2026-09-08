import { describe, it, expect } from 'vitest'
import { responsesProbeModel, responsesProbePayload, responsesProbeUrl, responsesProbeVerdict } from '../../src/control/openai-responses-probe'
describe('original Responses capability probe', () => {
  it.each([404, 405])('rejects missing endpoint %s', status => expect(responsesProbeVerdict(status, '')).toBe(false))
  it.each([400, 401, 403, 422, 429, 500, 503])('does not mistake HTTP %s for a missing endpoint', status => expect(responsesProbeVerdict(status, '')).toBe(true))
  it.each(['failed', 'incomplete'])('preserves unknown for unfinished %s results', status => {
    expect(responsesProbeVerdict(200, JSON.stringify({ status, incomplete_details: { reason: ' max_output_tokens ' }, output: [{ type: 'function_call' }] }))).toBeNull()
  })
  it('requires a function call only for conclusive successful responses', () => {
    expect(responsesProbeVerdict(200, JSON.stringify({ status: 'completed', output: [{ type: 'reasoning' }] }))).toBe(false)
    expect(responsesProbeVerdict(200, JSON.stringify({ output: [{ type: ' function_call ' }] }))).toBe(true)
    expect(responsesProbeVerdict(200, 'not JSON')).toBe(false)
  })
  it('selects a deterministic concrete mapped model and the original fallback', () => {
    expect(responsesProbeModel({ model_mapping: { first: 'z', second: ' a ', wild: '*' } })).toBe('a')
    expect(responsesProbeModel({ model_mapping: { wild: '*' } })).toBe('gpt-5.4')
    expect(responsesProbePayload('a')).toMatchObject({ model: 'a', tool_choice: 'required', max_output_tokens: 512, stream: false })
  })
  it.each([['', '/v1/responses'], ['/v1', '/v1/responses'], ['/coding/v3', '/coding/v3/responses'], ['/v1beta', '/v1beta/responses'], ['/v1.2', '/v1.2/responses'], ['/custom', '/custom/v1/responses'], ['/responses/', '/responses']])('builds original version-aware endpoint for %s', (base, path) => {
    expect(responsesProbeUrl(`https://probe.test${base}`)).toBe(`https://probe.test${path}`)
  })
})
