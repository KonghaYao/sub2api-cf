import { describe, expect, it, vi } from 'vitest'

import type { Env, PlatformEvent, SubscriptionStateChangedPayload } from '../../src/env'
import { consumeEvents } from '../../src/gateway/queue'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function event(
  requestId: string,
  amountMicros: number,
  windowStartMs: number,
  quotaResetEpoch = 0,
  periodicWindowStartMs = windowStartMs,
): PlatformEvent<SubscriptionStateChangedPayload> {
  const payload: SubscriptionStateChangedPayload = {
    request_id: requestId,
    subscription_id: 'subscription-1',
    user_id: 'user-1',
    group_id: 'group-1',
    amount_micros: amountMicros,
    daily_window_start_ms: windowStartMs,
    weekly_window_start_ms: periodicWindowStartMs,
    monthly_window_start_ms: periodicWindowStartMs,
    quota_reset_epoch: quotaResetEpoch,
    updated_at_ms: windowStartMs + 1,
  }
  return {
    schema_version: 1,
    event_id: `subscription-usage:${requestId}`,
    event_type: 'subscription.usage.settled.v1',
    occurred_at_ms: payload.updated_at_ms,
    aggregate_type: 'subscription',
    aggregate_id: payload.subscription_id,
    payload,
  }
}

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

describe('subscription usage projection', () => {
  it('projects each settlement exactly once and ignores older-window deliveries', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    const startsAt = Date.UTC(2026, 8, 1)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'user-1@example.test', ${startsAt}, ${startsAt});
      INSERT INTO "groups" (
        id, name, platform, group_type, is_exclusive, created_at_ms, updated_at_ms
      ) VALUES ('group-1', 'Subscription', 'openai', 'subscription', 1, ${startsAt}, ${startsAt});
      INSERT INTO user_subscriptions (
        id, user_id, group_id, status, starts_at_ms, expires_at_ms,
        source_type, source_id, created_at_ms, updated_at_ms
      ) VALUES (
        'subscription-1', 'user-1', 'group-1', 'active', ${startsAt},
        ${startsAt + 45 * 86_400_000}, 'admin', 'seed', ${startsAt}, ${startsAt}
      );
    `)
    const env = { DB: d1 } as Env

    const first = event('request-1', 40, startsAt)
    const firstMessage = message(first)
    await consumeEvents(
      { queue: 'events', messages: [firstMessage] } as unknown as MessageBatch<unknown>,
      env,
    )
    expect(firstMessage.ack).toHaveBeenCalledOnce()
    expect(raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros
         FROM user_subscriptions WHERE id = 'subscription-1'`,
    ).get()).toEqual({
      daily_used_micros: 40,
      weekly_used_micros: 40,
      monthly_used_micros: 40,
    })

    const replay = message(first)
    await consumeEvents(
      { queue: 'events', messages: [replay] } as unknown as MessageBatch<unknown>,
      env,
    )
    expect(replay.ack).toHaveBeenCalledOnce()
    expect(raw.prepare(
      `SELECT daily_used_micros FROM user_subscriptions WHERE id = 'subscription-1'`,
    ).get()).toEqual({ daily_used_micros: 40 })

    const newerStart = startsAt + 30 * 86_400_000
    await consumeEvents(
      { queue: 'events', messages: [message(event('request-2', 10, newerStart))] } as unknown as MessageBatch<unknown>,
      env,
    )
    await consumeEvents(
      { queue: 'events', messages: [message(event('request-3', 20, startsAt))] } as unknown as MessageBatch<unknown>,
      env,
    )
    expect(raw.prepare(
      `SELECT daily_used_micros, daily_window_start_ms,
              weekly_used_micros, weekly_window_start_ms,
              monthly_used_micros, monthly_window_start_ms
         FROM user_subscriptions WHERE id = 'subscription-1'`,
    ).get()).toEqual({
      daily_used_micros: 10,
      daily_window_start_ms: newerStart,
      weekly_used_micros: 10,
      weekly_window_start_ms: newerStart,
      monthly_used_micros: 10,
      monthly_window_start_ms: newerStart,
    })
    raw.close()
  })

  it('does not add a delayed pre-reset settlement back after quota reset', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    const startsAt = Date.UTC(2026, 8, 1)
    const resetAt = startsAt + 1_000
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'user-1@example.test', ${startsAt}, ${startsAt});
      INSERT INTO "groups" (
        id, name, platform, group_type, is_exclusive, created_at_ms, updated_at_ms
      ) VALUES ('group-1', 'Subscription', 'openai', 'subscription', 1, ${startsAt}, ${startsAt});
      INSERT INTO user_subscriptions (
        id, user_id, group_id, status, starts_at_ms, expires_at_ms,
        source_type, source_id, daily_used_micros, weekly_used_micros,
        monthly_used_micros, daily_window_start_ms, weekly_window_start_ms,
        monthly_window_start_ms, created_at_ms, updated_at_ms
      ) VALUES (
        'subscription-1', 'user-1', 'group-1', 'active', ${startsAt},
        ${startsAt + 45 * 86_400_000}, 'admin', 'seed', 70, 70, 70,
        ${startsAt}, ${startsAt}, ${startsAt}, ${startsAt}, ${startsAt}
      );
      UPDATE user_subscriptions
         SET daily_used_micros = 0, weekly_used_micros = 0, monthly_used_micros = 0,
             weekly_window_start_ms = ${resetAt}, monthly_window_start_ms = ${resetAt},
             quota_reset_epoch = 1, control_version = 1
       WHERE id = 'subscription-1';
    `)
    const env = { DB: d1 } as Env

    const delayed = message(event('before-reset', 40, startsAt, 0))
    await consumeEvents(
      { queue: 'events', messages: [delayed] } as unknown as MessageBatch<unknown>,
      env,
    )
    expect(delayed.ack).toHaveBeenCalledOnce()
    expect(raw.prepare(
      `SELECT COUNT(*) AS total FROM inbox
        WHERE consumer = 'subscription-state-projection-v1'
          AND event_id = 'subscription-usage:before-reset'`,
    ).get()).toEqual({ total: 1 })
    expect(raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros
         FROM user_subscriptions WHERE id = 'subscription-1'`,
    ).get()).toEqual({
      daily_used_micros: 0,
      weekly_used_micros: 0,
      monthly_used_micros: 0,
    })

    const current = message(event('after-reset', 10, startsAt, 1, resetAt))
    await consumeEvents(
      { queue: 'events', messages: [current] } as unknown as MessageBatch<unknown>,
      env,
    )
    expect(current.ack).toHaveBeenCalledOnce()
    expect(raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros
         FROM user_subscriptions WHERE id = 'subscription-1'`,
    ).get()).toEqual({
      daily_used_micros: 10,
      weekly_used_micros: 10,
      monthly_used_micros: 10,
    })
    raw.close()
  })

  it('consumes and replays an expired old-term settlement without polluting a same-day new term', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    const dailyStart = Date.UTC(2026, 8, 1)
    const oldPeriodicStart = Date.UTC(2026, 7, 29, 12)
    const newStartsAt = Date.UTC(2026, 8, 1, 12)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'user-1@example.test', ${dailyStart}, ${dailyStart});
      INSERT INTO "groups" (
        id, name, platform, group_type, is_exclusive, created_at_ms, updated_at_ms
      ) VALUES ('group-1', 'Subscription', 'openai', 'subscription', 1, ${dailyStart}, ${dailyStart});
      INSERT INTO user_subscriptions (
        id, user_id, group_id, status, starts_at_ms, expires_at_ms,
        source_type, source_id, daily_used_micros, weekly_used_micros,
        monthly_used_micros, daily_window_start_ms, weekly_window_start_ms,
        monthly_window_start_ms, quota_reset_epoch, created_at_ms, updated_at_ms
      ) VALUES (
        'subscription-1', 'user-1', 'group-1', 'active', ${newStartsAt},
        ${newStartsAt + 31 * 86_400_000}, 'admin', 'restarted', 7, 7, 7,
        ${dailyStart}, ${newStartsAt}, ${newStartsAt}, 1, ${newStartsAt}, ${newStartsAt}
      );
    `)
    const env = { DB: d1 } as Env
    const oldTermEvent = event('old-term-late', 40, dailyStart, 0, oldPeriodicStart)

    for (const delivery of [message(oldTermEvent), message(oldTermEvent)]) {
      await consumeEvents(
        { queue: 'events', messages: [delivery] } as unknown as MessageBatch<unknown>,
        env,
      )
      expect(delivery.ack).toHaveBeenCalledOnce()
      expect(delivery.retry).not.toHaveBeenCalled()
    }
    expect(raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros,
              daily_window_start_ms, quota_reset_epoch
         FROM user_subscriptions WHERE id = 'subscription-1'`,
    ).get()).toEqual({
      daily_used_micros: 7,
      weekly_used_micros: 7,
      monthly_used_micros: 7,
      daily_window_start_ms: dailyStart,
      quota_reset_epoch: 1,
    })
    expect(raw.prepare(
      `SELECT COUNT(*) AS total FROM inbox
        WHERE consumer = 'subscription-state-projection-v1'
          AND event_id = 'subscription-usage:old-term-late'`,
    ).get()).toEqual({ total: 1 })

    const current = message(event('new-term', 10, dailyStart, 1, newStartsAt))
    await consumeEvents(
      { queue: 'events', messages: [current] } as unknown as MessageBatch<unknown>,
      env,
    )
    expect(raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros
         FROM user_subscriptions WHERE id = 'subscription-1'`,
    ).get()).toEqual({
      daily_used_micros: 17,
      weekly_used_micros: 17,
      monthly_used_micros: 17,
    })
    raw.close()
  })
})
