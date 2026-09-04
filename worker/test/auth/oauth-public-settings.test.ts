import { describe, expect, it } from 'vitest'
import { oauthPublicSettings } from '../../src/auth/oauth-public-settings'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('OAuth public settings', () => {
  it('advertises only enabled D1 providers and no provider configuration', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    const now = Date.now()
    const insert = raw.prepare(
      `INSERT INTO oauth_providers (
         provider, adapter, enabled, issuer, authorization_endpoint,
         token_endpoint, userinfo_endpoint, client_id, scopes_json,
         allowed_hosts_json, frontend_callback_path,
         secret_key_version, secret_nonce_b64, secret_ciphertext_b64,
         created_at_ms, updated_at_ms
       ) VALUES (?, 'standard', ?, ?, ?, ?, ?, 'private-client', '[]', ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const [provider, enabled, secretConfigured] of [
      ['github', 1, true],
      ['google', 0, true],
      ['linuxdo', 1, true],
      // Simulates a row written by an older control-plane version.
      ['dingtalk', 1, false],
    ] as const) {
      insert.run(
        provider,
        enabled,
        provider,
        `https://${provider}.example/authorize`,
        `https://${provider}.example/token`,
        `https://${provider}.example/user`,
        JSON.stringify([`${provider}.example`]),
        '/auth/oauth/callback',
        secretConfigured ? 1 : null,
        secretConfigured ? 'encrypted-nonce' : null,
        secretConfigured ? 'encrypted-secret' : null,
        now,
        now,
      )
    }
    const result = await oauthPublicSettings({ DB: d1 } as Env)
    expect(result).toMatchObject({
      github_oauth_enabled: true,
      google_oauth_enabled: false,
      linuxdo_oauth_enabled: true,
      dingtalk_oauth_enabled: false,
      wechat_oauth_enabled: false,
      oidc_oauth_enabled: false,
    })
    expect(JSON.stringify(result)).not.toContain('private-client')
  })

  it('fails closed when provider state is unavailable', async () => {
    await expect(oauthPublicSettings({ DB: {
      prepare: () => { throw new Error('D1 unavailable') },
    } as unknown as D1Database } as Env)).resolves.toMatchObject({
      github_oauth_enabled: false,
      google_oauth_enabled: false,
      linuxdo_oauth_enabled: false,
    })
  })
})
