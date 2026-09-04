import { describe, expect, it } from 'vitest'

import { GatewayError } from '../../../src/gateway/errors'
import {
  buildProviderHealthRequest,
  buildProviderRequest,
  type ProviderAccount,
  type ProviderOperation,
} from '../../../src/gateway/providers'

const credential = { api_key: 'provider-secret' }

function account(
  platform: ProviderAccount['platform'],
  overrides: Partial<ProviderAccount> = {},
): ProviderAccount {
  const contract = {
    openai: { protocol: 'openai', auth_scheme: 'bearer', base_url: 'https://api.openai.test/v1' },
    anthropic: { protocol: 'anthropic', auth_scheme: 'x-api-key', base_url: 'https://api.anthropic.test' },
    gemini: { protocol: 'gemini', auth_scheme: 'x-goog-api-key', base_url: 'https://generativelanguage.test' },
    codex: { protocol: 'codex', auth_scheme: 'bearer', base_url: 'https://chatgpt.test' },
  } as const
  return {
    platform,
    ...contract[platform],
    provider_config: {},
    ...overrides,
  }
}

describe('provider request adapters', () => {
  it('builds an OpenAI request without forwarding client-controlled reserved headers', () => {
    const plan = buildProviderRequest({
      account: account('openai'),
      credential,
      operation: 'responses',
      body: { model: 'gpt-5', input: 'hello' },
      client_headers: {
        authorization: 'Bearer attacker',
        'x-api-key': 'attacker',
        'x-goog-api-key': 'attacker',
        host: 'attacker.invalid',
        connection: 'upgrade',
        cookie: 'session=attacker',
      },
    })

    expect(plan).toMatchObject({
      url: 'https://api.openai.test/v1/responses',
      method: 'POST',
      body: { model: 'gpt-5', input: 'hello' },
      timeout_ms: 30_000,
    })
    expect(Object.fromEntries(plan.headers)).toEqual({
      accept: 'application/json',
      authorization: 'Bearer provider-secret',
      'content-type': 'application/json',
    })
  })

  it('uses Anthropic native URL and authentication contract', () => {
    const plan = buildProviderRequest({
      account: account('anthropic', { base_url: 'https://api.anthropic.test/v1/' }),
      credential,
      operation: 'messages',
      body: { model: 'claude-4', messages: [] },
    })

    expect(plan.url).toBe('https://api.anthropic.test/v1/messages')
    expect(Object.fromEntries(plan.headers)).toEqual({
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': 'provider-secret',
    })
  })

  it('keeps Gemini credentials out of the URL and escapes the model path', () => {
    const plan = buildProviderRequest({
      account: account('gemini'),
      credential,
      operation: 'stream_generate_content',
      model: 'publishers/acme/models/gemini 2',
      body: { contents: [] },
    })

    expect(plan.url).toBe(
      'https://generativelanguage.test/v1beta/models/publishers%2Facme%2Fmodels%2Fgemini%202:streamGenerateContent?alt=sse',
    )
    expect(plan.url).not.toContain(credential.api_key)
    expect(plan.headers.get('x-goog-api-key')).toBe(credential.api_key)
    expect(plan.headers.has('authorization')).toBe(false)
    expect(plan.headers.get('accept')).toBe('text/event-stream')
  })

  it('uses the Codex backend contract and forces non-persistent Responses requests', () => {
    const plan = buildProviderRequest({
      account: account('codex', { provider_config: { account_id: 'workspace_123' } }),
      credential,
      operation: 'responses',
      body: { model: 'gpt-5-codex', store: true, input: [] },
    })

    expect(plan.url).toBe('https://chatgpt.test/backend-api/codex/responses')
    expect(plan.headers.get('authorization')).toBe('Bearer provider-secret')
    expect(plan.headers.get('chatgpt-account-id')).toBe('workspace_123')
    expect(plan.headers.get('originator')).toBe('codex_cli_rs')
    expect(plan.body).toEqual({ model: 'gpt-5-codex', store: false, input: [] })
  })

  it('preserves custom proxy prefixes without duplicating provider path segments', () => {
    const anthropic = buildProviderRequest({
      account: account('anthropic', { base_url: 'https://relay.test/anthropic/v1' }),
      credential,
      operation: 'messages',
      body: {},
    })
    const codex = buildProviderRequest({
      account: account('codex', { base_url: 'https://relay.test/openai/backend-api/codex' }),
      credential,
      operation: 'responses',
      body: {},
    })

    expect(anthropic.url).toBe('https://relay.test/anthropic/v1/messages')
    expect(codex.url).toBe('https://relay.test/openai/backend-api/codex/responses')
  })

  it.each([
    ['openai', 'https://api.openai.test/v1/models', 'authorization'],
    ['anthropic', 'https://api.anthropic.test/v1/models', 'x-api-key'],
    ['gemini', 'https://generativelanguage.test/v1beta/models', 'x-goog-api-key'],
    ['codex', 'https://chatgpt.test/backend-api/codex/models', 'authorization'],
  ] as const)('builds a bounded %s health probe', (platform, url, authHeader) => {
    const plan = buildProviderHealthRequest({ account: account(platform), credential })

    expect(plan).toMatchObject({ url, method: 'GET', timeout_ms: 4_000 })
    expect(plan.headers.has(authHeader)).toBe(true)
  })

  it.each([
    ['openai', 'messages'],
    ['anthropic', 'responses'],
    ['gemini', 'chat_completions'],
    ['codex', 'chat_completions'],
  ] as const)('rejects unsupported %s/%s operation pairs', (platform, operation) => {
    expect(() => buildProviderRequest({
      account: account(platform),
      credential,
      operation: operation as ProviderOperation,
      body: {},
    })).toThrowError(GatewayError)
  })

  it('rejects invalid account contracts, credentials, config and non-HTTPS URLs', () => {
    const cases = [
      () => buildProviderRequest({
        account: account('anthropic', { auth_scheme: 'bearer' }),
        credential,
        operation: 'messages',
        body: {},
      }),
      () => buildProviderRequest({
        account: account('gemini'),
        credential: { api_key: '' },
        operation: 'generate_content',
        model: 'gemini-2',
        body: {},
      }),
      () => buildProviderRequest({
        account: account('openai'),
        credential: { api_key: 'safe\r\nx-api-key: attacker' },
        operation: 'responses',
        body: {},
      }),
      () => buildProviderRequest({
        account: account('codex', { provider_config: { account_id: 'bad\r\nheader' } }),
        credential,
        operation: 'responses',
        body: {},
      }),
      () => buildProviderRequest({
        account: account('openai', { base_url: 'http://api.openai.test/v1' }),
        credential,
        operation: 'responses',
        body: {},
      }),
    ]

    for (const run of cases) expect(run).toThrowError(GatewayError)
  })
})
