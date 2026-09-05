import { describe, expect, it } from 'vitest'

import type { Env, PlatformEvent, UsageSettledPayload } from '../../src/env'
import {
  persistSettlementRecovery,
  settleRecoveryRequest,
} from '../../src/gateway/recovery'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('API key monetary migration', () => {
  it('backfills existing keys and keeps old-Worker inserts deploy-compatible', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 23)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'user-1@example.test', 1, 1);
      INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES ('group-1', 'one', 'openai', 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, created_at_ms, updated_at_ms, group_id, key_prefix
      ) VALUES (
        'key-before', 'user-1', '${'a'.repeat(64)}', 'before', 2, 2, 'group-1', 'sk-before'
      );
    `)

    applyMigrations(raw, 24)

    expect(raw.prepare(
      `SELECT quota_micros, quota_used_micros,
              rate_limit_5h_micros, rate_limit_1d_micros, rate_limit_7d_micros,
              usage_5h_micros, usage_1d_micros, usage_7d_micros,
              window_5h_start_ms, window_1d_start_ms, window_7d_start_ms,
              quota_reset_epoch, rate_limit_reset_epoch
         FROM api_keys WHERE id = 'key-before'`,
    ).get()).toEqual({
      quota_micros: 0,
      quota_used_micros: 0,
      rate_limit_5h_micros: 0,
      rate_limit_1d_micros: 0,
      rate_limit_7d_micros: 0,
      usage_5h_micros: 0,
      usage_1d_micros: 0,
      usage_7d_micros: 0,
      window_5h_start_ms: null,
      window_1d_start_ms: null,
      window_7d_start_ms: null,
      quota_reset_epoch: 0,
      rate_limit_reset_epoch: 0,
    })

    raw.prepare(`
      INSERT INTO api_keys (
        id, user_id, key_hash, name, created_at_ms, updated_at_ms, group_id, key_prefix
      ) VALUES (?, 'user-1', ?, 'during', 3, 3, 'group-1', 'sk-during')
    `).run('key-during', 'b'.repeat(64))
    expect(raw.prepare(
      'SELECT quota_micros, usage_5h_micros, quota_reset_epoch FROM api_keys WHERE id = ?',
    ).get('key-during')).toEqual({ quota_micros: 0, usage_5h_micros: 0, quota_reset_epoch: 0 })
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 24').get())
      .toEqual({ name: 'api_key_monetary' })
    raw.close()
  })

  it('enforces non-negative safe integer storage constraints', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'user-1@example.test', 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, created_at_ms, updated_at_ms, key_prefix
      ) VALUES ('key-1', 'user-1', '${'c'.repeat(64)}', 'one', 1, 1, 'sk-one');
    `)

    expect(() => raw.prepare('UPDATE api_keys SET quota_micros = -1 WHERE id = ?').run('key-1'))
      .toThrow(/CHECK constraint failed/)
    expect(() => raw.prepare('UPDATE api_keys SET usage_5h_micros = ? WHERE id = ?')
      .run(Number.MAX_SAFE_INTEGER + 1, 'key-1')).toThrow(/CHECK constraint failed/)
    expect(() => raw.prepare('UPDATE api_keys SET window_1d_start_ms = -1 WHERE id = ?').run('key-1'))
      .toThrow(/CHECK constraint failed/)
    expect(() => raw.prepare('UPDATE api_keys SET rate_limit_reset_epoch = ? WHERE id = ?')
      .run(Number.MAX_SAFE_INTEGER + 1, 'key-1')).toThrow(/CHECK constraint failed/)
    raw.close()
  })

  it('migrates legacy recovery rows as main-only commands and inserts new three-stage commands explicitly', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw, 24)
    raw.exec(`
      INSERT INTO users (id, email, status, balance_micros, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'recovery@example.test', 'active', 1000, 1, 1);
      INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES ('group-1', 'one', 'openai', 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, group_id, key_prefix, created_at_ms, updated_at_ms
      ) VALUES (
        'key-1', 'user-1', '${'d'.repeat(64)}', 'key', 'group-1', 'sk-key', 1, 1
      );
    `)
    const legacyEvent = usageEvent('legacy-request')
    raw.prepare(`
      INSERT INTO settlement_recovery (
        request_id, user_id, billing_type, subscription_id, amount_micros,
        usage_event_json, attempts, available_at_ms, created_at_ms, last_error
      ) VALUES (?, 'user-1', 'balance', NULL, 10, ?, 0, 1, 1, NULL)
    `).run('legacy-request', JSON.stringify(legacyEvent))

    applyMigrations(raw, 25)
    expect(raw.prepare(`
      SELECT api_key_id, billing_settled, api_key_settled, api_key_projected
        FROM settlement_recovery WHERE request_id = 'legacy-request'
    `).get()).toEqual({
      api_key_id: null,
      billing_settled: 0,
      api_key_settled: 1,
      api_key_projected: 1,
    })

    // A rolling deploy can leave an old Worker serving briefly after 0025 is
    // applied. Its INSERT omits every new column and must remain main-only.
    const rollingLegacyEvent = usageEvent('rolling-legacy-request')
    raw.prepare(`
      INSERT INTO settlement_recovery (
        request_id, user_id, billing_type, subscription_id, amount_micros,
        usage_event_json, attempts, available_at_ms, created_at_ms, last_error
      ) VALUES (?, 'user-1', 'balance', NULL, 10, ?, 0, 1, 1, NULL)
    `).run('rolling-legacy-request', JSON.stringify(rollingLegacyEvent))
    expect(raw.prepare(`
      SELECT api_key_id, billing_settled, api_key_settled, api_key_projected
        FROM settlement_recovery WHERE request_id = 'rolling-legacy-request'
    `).get()).toEqual({
      api_key_id: null,
      billing_settled: 0,
      api_key_settled: 1,
      api_key_projected: 1,
    })

    const userState = {
      fetch: async () => Response.json({ profile: { balance_micros: 990, settled_micros: 10 } }),
    }
    const env = {
      DB: d1,
      USER_STATE: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => userState,
      } as unknown as DurableObjectNamespace,
    } as Env
    await expect(settleRecoveryRequest(env, 'legacy-request')).resolves.toBe(true)
    expect(raw.prepare(
      "SELECT request_id FROM settlement_recovery WHERE request_id = 'legacy-request'",
    ).get()).toBeUndefined()
    await expect(settleRecoveryRequest(env, 'rolling-legacy-request')).resolves.toBe(true)
    expect(raw.prepare(
      "SELECT request_id FROM settlement_recovery WHERE request_id = 'rolling-legacy-request'",
    ).get()).toBeUndefined()

    const newEvent = usageEvent('new-request')
    await persistSettlementRecovery(
      env,
      { user_id: 'user-1', api_key_id: 'key-1', billing: { type: 'balance' } },
      'new-request',
      10,
      newEvent,
    )
    expect(raw.prepare(`
      SELECT billing_settled, api_key_settled, api_key_usage_json, api_key_projected
        FROM settlement_recovery WHERE request_id = 'new-request'
    `).get()).toEqual({
      billing_settled: 0,
      api_key_settled: 0,
      api_key_usage_json: null,
      api_key_projected: 0,
    })
    raw.close()
  })
})

function usageEvent(requestId: string): PlatformEvent<UsageSettledPayload> {
  return {
    schema_version: 1,
    event_id: `usage:${requestId}`,
    event_type: 'usage.settled.v1',
    occurred_at_ms: 1,
    aggregate_type: 'user',
    aggregate_id: 'user-1',
    payload: {
      request_id: requestId,
      user_id: 'user-1',
      api_key_id: 'key-1',
      group_id: 'group-1',
      billing_type: 'balance',
      subscription_id: null,
      account_id: 'account-1',
      price_id: 'price-1',
      requested_model: 'model',
      upstream_model: 'model',
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      input_amount_micros: 5,
      output_amount_micros: 5,
      cache_amount_micros: 0,
      base_amount_micros: 0,
      amount_micros: 10,
      outcome: 'completed',
      stream: false,
      platform: 'openai',
      request_type: 1,
      inbound_endpoint: '/v1/responses',
      upstream_endpoint: '/v1/responses',
      billing_mode: 'token',
      native_compaction_v2: false,
      duration_ms: 1,
      estimated: false,
    },
  }
}
