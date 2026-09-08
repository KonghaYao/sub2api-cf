import { describe, expect, it, vi } from 'vitest'
import {
  captureAdminRequestBody,
  REQUEST_BODY_PLACEHOLDERS,
} from '../../src/control/request-audit-body'

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }

function jsonRequest(body: string, path = '/api/v1/admin/widgets', headers = JSON_HEADERS): Request {
  return new Request(`https://worker.example${path}`, { method: 'POST', headers, body })
}

describe('admin request audit body capture', () => {
  it('recursively redacts normalized sensitive keys in objects and arrays without leaking value length', async () => {
    const body = JSON.stringify({
      safe: 'visible',
      nested: [{ PASSWORD: 'short' }, { 'access-token': 'x'.repeat(20_000) }],
      api_key: { deeply: 'hidden' },
      clientSecret: ['also hidden'],
    })
    await expect(captureAdminRequestBody(jsonRequest(body), '/api/v1/admin/widgets')).resolves.toEqual({
      kind: 'captured',
      body: JSON.stringify({
        api_key: '[REDACTED]',
        clientSecret: '[REDACTED]',
        nested: [{ PASSWORD: '[REDACTED]' }, { 'access-token': '[REDACTED]' }],
        safe: 'visible',
      }),
    })
  })

  it('serializes non-sensitive JSON deterministically and accepts +json content types', async () => {
    const result = await captureAdminRequestBody(
      jsonRequest('{"z":1,"a":{"d":4,"b":2}}', '/api/v1/admin/widgets', {
        'content-type': 'application/problem+json; charset=UTF-8',
      }),
      '/api/v1/admin/widgets',
    )
    expect(result).toEqual({ kind: 'captured', body: '{"a":{"b":2,"d":4},"z":1}' })
  })

  it.each([
    ['/api/v1/admin/openai/generate-auth-url', '{"redirect_uri":"https://callback.test"}'],
    ['/api/v1/admin/openai/exchange-code', '{"code":"one-use-secret","state":"private-state"}'],
    ['/api/v1/admin/openai/refresh-token', '{"rt":"refresh-secret"}'],
    ['/api/v1/admin/accounts', '{"label":"safe"}'],
    ['/api/v1/admin/accounts/account-one/credentials', '{"value":"secret"}'],
    ['/api/v1/admin/oauth-providers/github', '{"client_id":"id"}'],
    ['/api/v1/admin/settings', '{"site_name":"name"}'],
    ['/api/v1/admin/users/user-one/api-keys', '{"name":"key"}'],
    ['/api/v1/admin/payment/providers/provider-one', '{"enabled":true}'],
    ['/api/v1/admin/promo-codes', '{"code":"PROMO-PLAINTEXT"}'],
    ['/api/v1/admin/invitation-codes/code-one', '{"code":"INVITE-PLAINTEXT"}'],
    ['/api/v1/admin/redeem-codes/generate', '{"code":"REDEEM-PLAINTEXT"}'],
    ['/api/v1/admin/data/import', '{"rows":[]}'],
    ['/api/v1/admin/totp/enable', '{"code":"123456"}'],
    ['/api/v1/admin/passkey/register', '{"response":{}}'],
    ['/api/v1/admin/payment/webhook', '{"event":{}}'],
  ])('never reads denylisted body for %s', async (path, body) => {
    const request = jsonRequest(body, path)
    const clone = vi.spyOn(request, 'clone')
    await expect(captureAdminRequestBody(request, path)).resolves.toEqual({
      body: REQUEST_BODY_PLACEHOLDERS.sensitive,
      kind: 'sensitive_route',
    })
    expect(clone).not.toHaveBeenCalled()
  })

  it('does not trust a client-declared zero length when a real body stream exists', async () => {
    const request = jsonRequest('{"password":"must-not-appear","safe":"visible"}', '/api/v1/admin/widgets', {
      ...JSON_HEADERS,
      'content-length': '0',
    })
    await expect(captureAdminRequestBody(request, '/api/v1/admin/widgets')).resolves.toEqual({
      kind: 'captured',
      body: '{"password":"[REDACTED]","safe":"visible"}',
    })
  })

  it('uses distinct placeholders for empty, invalid JSON, and non-JSON bodies', async () => {
    await expect(captureAdminRequestBody(
      new Request('https://worker.example/api/v1/admin/widgets', { method: 'POST' }),
      '/api/v1/admin/widgets',
    )).resolves.toEqual({ body: REQUEST_BODY_PLACEHOLDERS.empty, kind: 'empty' })
    await expect(captureAdminRequestBody(
      jsonRequest('{broken'),
      '/api/v1/admin/widgets',
    )).resolves.toEqual({ body: REQUEST_BODY_PLACEHOLDERS.invalidJson, kind: 'invalid_json' })
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=secret-boundary',
      'application/octet-stream',
    ]) {
      await expect(captureAdminRequestBody(
        new Request('https://worker.example/api/v1/admin/widgets', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: 'password=must-not-appear',
        }),
        '/api/v1/admin/widgets',
      )).resolves.toEqual({ body: REQUEST_BODY_PLACEHOLDERS.nonJson, kind: 'non_json' })
    }
  })

  it('enforces the 256 KiB raw boundary from both Content-Length and the stream', async () => {
    const early = jsonRequest('{}', '/api/v1/admin/widgets', {
      ...JSON_HEADERS,
      'content-length': String(256 * 1_024 + 1),
    })
    const clone = vi.spyOn(early, 'clone')
    await expect(captureAdminRequestBody(early, '/api/v1/admin/widgets')).resolves.toEqual({
      body: REQUEST_BODY_PLACEHOLDERS.tooLarge,
      kind: 'too_large',
    })
    expect(clone).not.toHaveBeenCalled()

    const exact = JSON.stringify({ v: 'x'.repeat(256 * 1_024 - 8) })
    expect(new TextEncoder().encode(exact)).toHaveLength(256 * 1_024)
    await expect(captureAdminRequestBody(jsonRequest(exact), '/api/v1/admin/widgets'))
      .resolves.toMatchObject({ kind: 'captured' })

    const tooLarge = JSON.stringify({ v: 'x'.repeat(256 * 1_024 - 7) })
    await expect(captureAdminRequestBody(jsonRequest(tooLarge), '/api/v1/admin/widgets'))
      .resolves.toEqual({ body: REQUEST_BODY_PLACEHOLDERS.tooLarge, kind: 'too_large' })
  })

  it('bounds stored UTF-8 to 16 KiB with a deterministic truncation marker', async () => {
    const result = await captureAdminRequestBody(
      jsonRequest(JSON.stringify({ message: '界'.repeat(8_000) })),
      '/api/v1/admin/widgets',
    )
    expect(result.kind).toBe('captured')
    const stored = JSON.parse(result.body) as Record<string, string>
    expect(stored._audit_truncation).toBe('[TRUNCATED]')
    expect(stored.preview.length).toBeGreaterThan(0)
    expect(new TextEncoder().encode(result.body).byteLength).toBeLessThanOrEqual(16 * 1_024)
    expect(result.body).not.toContain('\uFFFD')
  })
})
