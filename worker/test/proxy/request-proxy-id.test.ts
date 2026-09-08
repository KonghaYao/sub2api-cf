import { describe, expect, it } from 'vitest'
import { requestProxyId } from '../../src/proxy/request-selection'

describe('account proxy binding compatibility', () => {
  it.each([10001, '10001', 'imported-proxy'])('keeps an assigned proxy %j instead of direct access', value => {
    expect(requestProxyId(value)).toBe(String(value))
  })
  it.each([undefined, null, 0, '0', ''])('retains the original unassigned sentinel %j', value => {
    expect(requestProxyId(value)).toBeNull()
  })
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, {}, [], ' ', 'x'.repeat(129)])('fails closed for an invalid binding %j', value => {
    expect(() => requestProxyId(value)).toThrow(expect.objectContaining({ status: 503, code: 'invalid_proxy_binding' }))
  })
})
