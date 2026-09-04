import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('OAuth identity migration', () => {
  it('creates encrypted provider, one-time flow, bind-ticket, and canonical identity storage', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)

    const tables = raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'oauth_%' OR name = 'auth_identities'
        ORDER BY name`,
    ).all() as Array<{ name: string }>
    expect(tables.map(({ name }) => name)).toEqual([
      'auth_identities',
      'oauth_bind_tickets',
      'oauth_flows',
      'oauth_providers',
    ])

    const now = Date.now()
    raw.prepare(
      `INSERT INTO oauth_providers (
         provider, adapter, enabled, issuer, authorization_endpoint,
         token_endpoint, userinfo_endpoint, emails_endpoint, jwks_endpoint,
         client_id, secret_key_version, secret_nonce_b64, secret_ciphertext_b64,
         scopes_json, allowed_hosts_json, frontend_callback_path,
         pkce_enabled, created_at_ms, updated_at_ms
       ) VALUES ('github', 'github', 1, 'github', 'https://github.com/login/oauth/authorize',
         'https://github.com/login/oauth/access_token', 'https://api.github.com/user',
         'https://api.github.com/user/emails', NULL, 'client', 1, 'nonce', 'ciphertext',
         '["read:user","user:email"]', '["github.com","api.github.com"]',
         '/auth/oauth/callback', 1, ?, ?)`,
    ).run(now, now)
    expect(raw.prepare('SELECT provider, pkce_enabled FROM oauth_providers').get()).toEqual({
      provider: 'github',
      pkce_enabled: 1,
    })

    expect(() => raw.prepare(
      `INSERT INTO oauth_providers (
         provider, adapter, enabled, issuer, authorization_endpoint,
         token_endpoint, userinfo_endpoint, client_id, secret_key_version,
         secret_nonce_b64, secret_ciphertext_b64, scopes_json, allowed_hosts_json,
         frontend_callback_path, pkce_enabled, created_at_ms, updated_at_ms
       ) VALUES ('unknown', 'standard', 1, 'unknown', 'https://oauth.example/authorize',
         'https://oauth.example/token', 'https://oauth.example/user', 'client', 1,
         'nonce', 'ciphertext', '[]', '["oauth.example"]', '/auth/oauth/callback', 1, ?, ?)`,
    ).run(now, now)).toThrow()

    raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('user-1', 'one@example.test', 'One', ?, ?),
              ('user-2', 'two@example.test', 'Two', ?, ?)`,
    ).run(now, now, now, now)
    raw.prepare(
      `INSERT INTO auth_identities (
         id, user_id, provider, provider_key, provider_subject, metadata_json,
         verified_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('identity-1', 'user-1', 'github', 'github', 'subject-1', '{}', ?, ?, ?)`,
    ).run(now, now, now)
    expect(() => raw.prepare(
      `INSERT INTO auth_identities (
         id, user_id, provider, provider_key, provider_subject, metadata_json,
         verified_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('identity-2', 'user-2', 'github', 'github', 'subject-1', '{}', ?, ?, ?)`,
    ).run(now, now, now)).toThrow(/UNIQUE/)

    raw.prepare('DELETE FROM users WHERE id = ?').run('user-1')
    expect(raw.prepare('SELECT COUNT(*) AS total FROM auth_identities').get()).toEqual({ total: 0 })
  })
})
