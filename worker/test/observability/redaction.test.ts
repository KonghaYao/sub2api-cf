import { describe, expect, it } from 'vitest'
import { encodeObservabilityPayload, sanitizeObservabilityPayload } from '../../src/observability/redaction'

describe('observability payload redaction', () => {
  it('keeps only safe headers and recursively removes credentials', async () => {
    const value = sanitizeObservabilityPayload({
      request: {
        method: 'POST',
        path: '/v1/responses?api_key=sk-query-secret&accessToken=query-access-token&ok=1',
        headers: {
          authorization: 'Bearer top-secret',
          cookie: 'session=hidden',
          'content-type': 'application/json',
          'user-agent': 'test-agent',
        },
        body: {
          model: 'gpt-5.5',
          api_key: 'sk-body-secret',
          apiKey: 'plain-body-key',
          nested: {
            password: 'hunter2',
            passwordHash: 'password-digest',
            clientSecret: 'oauth-client-secret',
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            sessionId: 'browser-session',
            note: 'Bearer nested-secret',
          },
        },
      },
      error: { message: 'provider rejected sk-message-secret', body: { token: 'hidden', code: 'bad' } },
    })
    const encoded = await encodeObservabilityPayload(value)
    expect(encoded.text).not.toMatch(/top-secret|session=hidden|sk-query-secret|query-access-token|sk-body-secret|plain-body-key|hunter2|password-digest|oauth-client-secret|oauth-access-token|oauth-refresh-token|browser-session|nested-secret|message-secret/)
    expect(JSON.parse(encoded.text)).toMatchObject({
      request: {
        headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
        body: {
          model: 'gpt-5.5',
          api_key: '[REDACTED]',
          apiKey: '[REDACTED]',
          nested: {
            password: '[REDACTED]',
            passwordHash: '[REDACTED]',
            clientSecret: '[REDACTED]',
            accessToken: '[REDACTED]',
            refreshToken: '[REDACTED]',
            sessionId: '[REDACTED]',
          },
        },
      },
      error: { body: { token: '[REDACTED]', code: 'bad' } },
    })
    expect(encoded.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('bounds oversized diagnostics before they enter Queue or R2', async () => {
    const encoded = await encodeObservabilityPayload({
      request: { body: { prompt: 'x'.repeat(200_000) } },
    })
    expect(encoded.bytes).toBeLessThanOrEqual(98_304)
    expect(JSON.parse(encoded.text)).toMatchObject({ truncated: true })
  })
})
