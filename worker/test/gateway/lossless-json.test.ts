import { describe, expect, it } from 'vitest'
import {
  parseJsonPreservingIntegers,
  stringifyJsonPreservingIntegers,
} from '../../src/gateway/lossless-json'
import { readGatewayJsonBody } from '../../src/gateway/request-body'

describe('lossless gateway JSON', () => {
  it('protects only unsafe integer tokens outside JSON strings', () => {
    expect(parseJsonPreservingIntegers(
      '{"safe":9007199254740991,"large":9007199254740993,"negative":-9007199254740994,"text":"9007199254740993","decimal":1.25}',
    )).toEqual({
      safe: 9_007_199_254_740_991,
      large: 9_007_199_254_740_993n,
      negative: -9_007_199_254_740_994n,
      text: '9007199254740993',
      decimal: 1.25,
    })
  })

  it('serializes protected integers back as unquoted number lexemes', () => {
    const source = '{"large":9007199254740993,"items":[-9007199254740994,"9007199254740993"]}'
    expect(stringifyJsonPreservingIntegers(parseJsonPreservingIntegers(source))).toBe(source)
  })

  it('keeps native JSON syntax validation', () => {
    expect(() => parseJsonPreservingIntegers('{"large":9007199254740993 trailing}'))
      .toThrow(SyntaxError)
  })

  it('keeps lossless parsing opt-in at the protocol boundary', async () => {
    const source = '{"large":9007199254740993}'
    const native = await readGatewayJsonBody(new Request('https://gateway.test', {
      method: 'POST',
      body: source,
    }))
    const lossless = await readGatewayJsonBody(new Request('https://gateway.test', {
      method: 'POST',
      body: source,
    }), { preserveUnsafeIntegers: true })

    expect(typeof native.body.large).toBe('number')
    expect(lossless.body.large).toBe(9_007_199_254_740_993n)
  })
})
