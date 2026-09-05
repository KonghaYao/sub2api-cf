import { describe, expect, it } from 'vitest'

import type { Env, PlatformEvent, UsageSettledPayload } from '../../src/env'
import { persistSettlementRecovery } from '../../src/gateway/recovery'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('image over-delivery billing migration', () => {
  it('keeps legacy rows immediately settleable and adds bounded user spend debt', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 47)
    raw.exec(`
      INSERT INTO users (id, email, balance_micros, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'one@example.test', 100, 1, 1);
      INSERT INTO settlement_recovery (
        request_id, user_id, billing_type, subscription_id, amount_micros,
        usage_event_json, attempts, available_at_ms, created_at_ms, last_error
      ) VALUES (
        'legacy-request', 'user-1', 'balance', NULL, 10,
        '{}', 0, 1, 1, NULL
      );
    `)

    applyMigrations(raw, 48)

    expect(raw.prepare(`
      SELECT initial_reserved_micros, reservations_ensured
        FROM settlement_recovery WHERE request_id = 'legacy-request'
    `).get()).toEqual({
      initial_reserved_micros: null,
      reservations_ensured: 1,
    })
    expect(raw.prepare(
      "SELECT spend_debt_micros FROM users WHERE id = 'user-1'",
    ).get()).toEqual({ spend_debt_micros: 0 })

    raw.prepare(`
      INSERT INTO settlement_recovery (
        request_id, user_id, billing_type, subscription_id, amount_micros,
        usage_event_json, initial_reserved_micros, reservations_ensured,
        attempts, available_at_ms, created_at_ms, last_error
      ) VALUES (
        'over-delivery', 'user-1', 'balance', NULL, 20,
        '{}', 10, 0, 0, 1, 1, NULL
      )
    `).run()
    expect(raw.prepare(`
      SELECT initial_reserved_micros, reservations_ensured
        FROM settlement_recovery WHERE request_id = 'over-delivery'
    `).get()).toEqual({
      initial_reserved_micros: 10,
      reservations_ensured: 0,
    })

    expect(() => raw.prepare(
      "UPDATE users SET spend_debt_micros = -1 WHERE id = 'user-1'",
    ).run()).toThrow(/CHECK constraint failed/)
    expect(() => raw.prepare(
      "UPDATE settlement_recovery SET reservations_ensured = 2 WHERE request_id = 'over-delivery'",
    ).run()).toThrow(/CHECK constraint failed/)
    raw.close()
  })

  it('persists the v2 initial hold and a pending ensure barrier atomically', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id, email, balance_micros, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'one@example.test', 100, 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, key_prefix, created_at_ms, updated_at_ms
      ) VALUES ('key-1', 'user-1', '${'a'.repeat(64)}', 'one', 'sk-one', 1, 1);
    `)
    const usageEvent: PlatformEvent<UsageSettledPayload> = {
      schema_version: 1,
      event_id: 'usage:request-1',
      event_type: 'usage.settled.v1',
      occurred_at_ms: 1,
      aggregate_type: 'user',
      aggregate_id: 'user-1',
      payload: {
        request_id: 'request-1', user_id: 'user-1', api_key_id: 'key-1', group_id: 'group-1',
        billing_type: 'balance', subscription_id: null, account_id: 'account-1', price_id: 'price-1',
        requested_model: 'image', upstream_model: 'image', input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, input_amount_micros: 0, output_amount_micros: 0,
        cache_amount_micros: 0, base_amount_micros: 20, amount_micros: 20,
        outcome: 'completed', stream: false, platform: 'openai', request_type: 1,
        inbound_endpoint: '/v1/images/generations', upstream_endpoint: '/v1/images/generations',
        billing_mode: 'image', native_compaction_v2: false, image_count: 2,
        duration_ms: 1, estimated: false,
      },
    }

    await persistSettlementRecovery(
      { DB: d1 } as Env,
      {
        user_id: 'user-1', api_key_id: 'key-1', billing: { type: 'balance' },
        platform_quota: { platform: 'openai' },
      },
      'request-1',
      20,
      usageEvent,
      10,
    )

    expect(raw.prepare(`
      SELECT initial_reserved_micros, reservations_ensured, available_at_ms,
             billing_settled, api_key_settled, platform_quota_settled
        FROM settlement_recovery WHERE request_id = 'request-1'
    `).get()).toEqual({
      initial_reserved_micros: 10,
      reservations_ensured: 0,
      available_at_ms: Number.MAX_SAFE_INTEGER,
      billing_settled: 0,
      api_key_settled: 0,
      platform_quota_settled: 0,
    })

    raw.prepare(
      "UPDATE settlement_recovery SET reservations_ensured = 1 WHERE request_id = 'request-1'",
    ).run()
    await expect(persistSettlementRecovery(
      { DB: d1 } as Env,
      {
        user_id: 'user-1', api_key_id: 'key-1', billing: { type: 'balance' },
        platform_quota: { platform: 'openai' },
      },
      'request-1',
      20,
      usageEvent,
      10,
    )).resolves.toBeUndefined()
    raw.close()
  })
})
