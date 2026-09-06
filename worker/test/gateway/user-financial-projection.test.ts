import { describe, expect, it, vi } from 'vitest'

import type { Env, PlatformEvent, UserStateChangedPayload } from '../../src/env'
import { consumeEvents } from '../../src/gateway/queue'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function message(body: unknown) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

describe('user financial event projection', () => {
  it('projects a shared-classifier opening event without mistaking a legacy snapshot for completeness', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (
        id, email, balance_micros, spend_debt_micros,
        state_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'user-1@example.test', 0, 0, 0, 1, 1)
    `)
    const env = { DB: d1 } as Env
    const opening = userStateEvent({
      stateVersion: 0,
      balanceMicros: 1_000_000,
      spendDebtMicros: 300_000,
      mutationId: 'd1-user:0',
      financialEvent: {
        event_type: 'opening_balance',
        source_type: 'opening_balance',
        source_id: '0',
        request_id: null,
        actor_user_id: null,
        actor_session_id: null,
        amount_delta_micros: 1_000_000,
        gross_amount_micros: 1_000_000,
        spend_debt_delta_micros: 300_000,
        balance_after_micros: 1_000_000,
        spend_debt_after_micros: 300_000,
      },
    })

    const delivery = message(opening)
    await consumeEvents(
      { queue: 'events', messages: [delivery] } as unknown as MessageBatch<unknown>,
      env,
    )

    expect(delivery.ack).toHaveBeenCalledOnce()
    expect(raw.prepare(`
      SELECT event_type, source_type, source_id, spend_debt_after_micros
        FROM user_financial_events WHERE event_id = 'user-state:user-1:0'
    `).get()).toEqual({
      event_type: 'opening_balance',
      source_type: 'opening_balance',
      source_id: '0',
      spend_debt_after_micros: 300_000,
    })
    expect(raw.prepare(
      `SELECT financial_history_complete FROM users WHERE id = 'user-1'`,
    ).get()).toEqual({ financial_history_complete: 0 })
    raw.close()
  })

  it('projects exact balance and debt deltas once from the UserStateDO outbox', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (
        id, email, balance_micros, spend_debt_micros,
        state_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'user-1@example.test', 1000000, 0, 0, 1, 1)
    `)
    const env = { DB: d1 } as Env
    const adjustment = userStateEvent({
      stateVersion: 1,
      balanceMicros: 1_250_000,
      spendDebtMicros: 0,
      mutationId: 'admin-balance:adjust-1',
      financialEvent: {
        event_type: 'balance_adjustment',
        source_type: 'admin_adjustment',
        source_id: 'adjust-1',
        request_id: null,
        actor_user_id: null,
        actor_session_id: null,
        amount_delta_micros: 250_000,
        gross_amount_micros: 250_000,
        spend_debt_delta_micros: 0,
        balance_after_micros: 1_250_000,
        spend_debt_after_micros: 0,
      },
    })
    const settlement = userStateEvent({
      stateVersion: 2,
      balanceMicros: 0,
      spendDebtMicros: 250_000,
      mutationId: 'settlement:request-1',
      occurredAtMs: 3,
      financialEvent: {
        event_type: 'settlement',
        source_type: 'usage_settlement',
        source_id: 'request-1',
        request_id: 'request-1',
        actor_user_id: null,
        actor_session_id: null,
        amount_delta_micros: -1_250_000,
        gross_amount_micros: 1_500_000,
        spend_debt_delta_micros: 250_000,
        balance_after_micros: 0,
        spend_debt_after_micros: 250_000,
      },
    })

    for (const event of [adjustment, adjustment, settlement]) {
      const delivery = message(event)
      await consumeEvents(
        { queue: 'events', messages: [delivery] } as unknown as MessageBatch<unknown>,
        env,
      )
      expect(delivery.ack).toHaveBeenCalledOnce()
      expect(delivery.retry).not.toHaveBeenCalled()
    }

    expect(raw.prepare(`
      SELECT event_id, state_version, event_type, source_type, source_id,
             request_id, amount_delta_micros, gross_amount_micros,
             spend_debt_delta_micros, balance_after_micros,
             spend_debt_after_micros, occurred_at_ms
        FROM user_financial_events
       ORDER BY state_version
    `).all()).toEqual([
      {
        event_id: 'user-state:user-1:1',
        state_version: 1,
        event_type: 'balance_adjustment',
        source_type: 'admin_adjustment',
        source_id: 'adjust-1',
        request_id: null,
        amount_delta_micros: 250_000,
        gross_amount_micros: 250_000,
        spend_debt_delta_micros: 0,
        balance_after_micros: 1_250_000,
        spend_debt_after_micros: 0,
        occurred_at_ms: 2,
      },
      {
        event_id: 'user-state:user-1:2',
        state_version: 2,
        event_type: 'settlement',
        source_type: 'usage_settlement',
        source_id: 'request-1',
        request_id: 'request-1',
        amount_delta_micros: -1_250_000,
        gross_amount_micros: 1_500_000,
        spend_debt_delta_micros: 250_000,
        balance_after_micros: 0,
        spend_debt_after_micros: 250_000,
        occurred_at_ms: 3,
      },
    ])
    expect(raw.prepare(`
      SELECT balance_micros, spend_debt_micros, state_version
        FROM users WHERE id = 'user-1'
    `).get()).toEqual({
      balance_micros: 0,
      spend_debt_micros: 250_000,
      state_version: 2,
    })
    raw.close()
  })
})

function userStateEvent(input: {
  stateVersion: number
  balanceMicros: number
  spendDebtMicros: number
  mutationId: string
  occurredAtMs?: number
  financialEvent: NonNullable<UserStateChangedPayload['financial_event']>
}): PlatformEvent<UserStateChangedPayload> {
  const occurredAtMs = input.occurredAtMs ?? 2
  const payload: UserStateChangedPayload = {
    mutation_id: input.mutationId,
    user_id: 'user-1',
    state_version: input.stateVersion,
    balance_micros: input.balanceMicros,
    spend_debt_micros: input.spendDebtMicros,
    enabled: true,
    updated_at_ms: occurredAtMs,
    financial_event: input.financialEvent,
  }
  return {
    schema_version: 1,
    event_id: `user-state:user-1:${input.stateVersion}`,
    event_type: 'user.state.changed.v1',
    occurred_at_ms: occurredAtMs,
    aggregate_type: 'user',
    aggregate_id: 'user-1',
    payload,
  }
}
