import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function applyProviderMigration(raw: any): void {
  applyMigrations(raw, 23)
}

function insertAccount(
  raw: any,
  id: string,
  platform: string,
  protocol: string,
  authScheme: string,
  providerConfig = '{}',
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, platform, name, credential_ref, enabled, max_concurrency,
       created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
       provider_config_json
     ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, 'https://provider.example/v1', ?, ?)`,
  ).run(id, platform, id, `${id}-secret`, protocol, authScheme, providerConfig)
}

describe('provider account migration', () => {
  it('preserves legacy OpenAI accounts and adds a safe default config', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 22)
    raw.prepare(
      `INSERT INTO accounts (
         id, platform, name, credential_ref, enabled, max_concurrency,
         created_at_ms, updated_at_ms, protocol, base_url, auth_scheme
       ) VALUES ('legacy', 'openai', 'Legacy', 'legacy-secret', 1, 2,
                 1, 1, 'openai', 'https://api.openai.com/v1', 'bearer')`,
    ).run()

    applyMigrations(raw, 23)

    expect(raw.prepare(
      `SELECT platform, protocol, auth_scheme, provider_config_json
         FROM accounts WHERE id = 'legacy'`,
    ).get()).toEqual({
      platform: 'openai',
      protocol: 'openai',
      auth_scheme: 'bearer',
      provider_config_json: '{}',
    })
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 23').get())
      .toEqual({ name: 'provider_accounts' })
  })

  it('accepts only the four fixed provider contracts', () => {
    const { raw } = createSqliteD1()
    applyProviderMigration(raw)

    expect(() => insertAccount(raw, 'openai', 'openai', 'openai', 'bearer')).not.toThrow()
    expect(() => insertAccount(raw, 'anthropic', 'anthropic', 'anthropic', 'x-api-key')).not.toThrow()
    expect(() => insertAccount(raw, 'gemini', 'gemini', 'gemini', 'x-goog-api-key')).not.toThrow()
    expect(() => insertAccount(
      raw,
      'codex',
      'codex',
      'codex',
      'bearer',
      '{"account_id":"workspace_123"}',
    )).not.toThrow()

    expect(() => insertAccount(raw, 'unknown', 'vertex', 'gemini', 'x-goog-api-key')).toThrow()
    expect(() => insertAccount(raw, 'mismatch', 'anthropic', 'anthropic', 'bearer')).toThrow()
    expect(() => raw.prepare(
      `UPDATE accounts SET protocol = 'openai' WHERE id = 'gemini'`,
    ).run()).toThrow()
  })

  it('rejects malformed, oversized, secret-like, and cross-provider config', () => {
    const { raw } = createSqliteD1()
    applyProviderMigration(raw)

    expect(() => insertAccount(raw, 'invalid-json', 'codex', 'codex', 'bearer', '{')).toThrow()
    expect(() => insertAccount(raw, 'array', 'codex', 'codex', 'bearer', '[]')).toThrow()
    expect(() => insertAccount(
      raw,
      'unknown-field',
      'codex',
      'codex',
      'bearer',
      '{"api_key":"must-not-live-here"}',
    )).toThrow()
    expect(() => insertAccount(
      raw,
      'foreign-config',
      'openai',
      'openai',
      'bearer',
      '{"account_id":"workspace_123"}',
    )).toThrow()
    expect(() => insertAccount(
      raw,
      'header-injection',
      'codex',
      'codex',
      'bearer',
      JSON.stringify({ account_id: 'workspace\r\nAuthorization: attacker' }),
    )).toThrow()
    expect(() => insertAccount(
      raw,
      'oversized',
      'codex',
      'codex',
      'bearer',
      JSON.stringify({ account_id: 'a'.repeat(2_049) }),
    )).toThrow()
  })
})
