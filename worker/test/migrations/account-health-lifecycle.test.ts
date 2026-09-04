import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('migration 0026 account health lifecycle', () => {
  it('makes existing accounts immediately due and creates a credential-free durable outbox', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 25)
    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
      ) VALUES (
        'account-1', 'openai', 'primary', 'secret-1', 1, 4,
        1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
      );
    `)

    applyMigrations(raw, 26)

    expect(raw.prepare(
      `SELECT health_probe_generation, consecutive_health_failures,
              next_health_probe_at_ms, health_probe_lease_until_ms, health_revision
         FROM accounts WHERE id = 'account-1'`,
    ).get()).toEqual({
      health_probe_generation: 0,
      consecutive_health_failures: 0,
      next_health_probe_at_ms: 0,
      health_probe_lease_until_ms: null,
      health_revision: 0,
    })
    expect(raw.prepare(
      `SELECT name FROM schema_migrations WHERE version = 26`,
    ).get()).toEqual({ name: 'account_health_lifecycle' })
    const columns = raw.prepare(`PRAGMA table_info(account_health_probes)`).all()
      .map((column: { name: string }) => column.name)
    expect(columns).not.toContain('api_key')
    expect(columns).not.toContain('ciphertext_b64')
    expect(columns).not.toContain('nonce_b64')
    expect(raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'bump_gateway_revision_account_update'`,
    ).get().sql).toContain('health_status')
    raw.close()
  })

  it('enforces bounded attempts and consistent probing leases/results', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
      ) VALUES (
        'account-1', 'openai', 'primary', 'secret-1', 1, 4,
        1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
      );
    `)
    const insert = raw.prepare(`
      INSERT INTO account_health_probes (
        id, account_id, generation, config_version, credential_ref, status,
        processing_attempts, dispatch_attempts, next_dispatch_at_ms,
        run_token, run_lease_until_ms, health_status, checked_at_ms, latency_ms,
        account_health_revision, pool_revision, created_at_ms, updated_at_ms
      ) VALUES (?, 'account-1', 1, 1, 'secret-1', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1)
    `)

    expect(() => insert.run(
      'bad-attempts', 'queued', 6, 0, null, null, null, null, null, null, null,
    )).toThrow()
    expect(() => insert.run(
      'bad-lease', 'probing', 1, 1, null, null, null, null, null, null, null,
    )).toThrow()
    expect(() => insert.run(
      'bad-result', 'probed', 1, 1, null, null, 'healthy', 2, 0, null, 2,
    )).toThrow()
    expect(() => insert.run(
      'valid-result', 'probed', 1, 1, null, null, 'healthy', 2, 0, 1, 2,
    )).not.toThrow()
    raw.close()
  })
})
