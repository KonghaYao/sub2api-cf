import { afterEach, describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const databases: any[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop().close()
})

describe('user financial event projection migration', () => {
  it('creates an immutable integer-micros ledger with a tuple-cursor index', () => {
    const { raw } = createSqliteD1()
    databases.push(raw)
    applyMigrations(raw)

    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 55',
    ).get()).toEqual({ version: 55, name: 'user_financial_events' })

    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-finance', 'finance@example.test', 1, 1);

      INSERT INTO user_financial_events (
        event_id, user_id, state_version, event_type, source_type, source_id,
        request_id, actor_user_id, actor_session_id,
        amount_delta_micros, gross_amount_micros,
        spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
        occurred_at_ms, projected_at_ms
      ) VALUES (
        'user-state:user-finance:1', 'user-finance', 1,
        'balance_adjustment', 'admin_adjustment', 'adjust-1', NULL,
        'user-finance', 'session-1',
        250000, 250000, 0, 1250000, 0, 10, 11
      );
    `)

    expect(raw.prepare(`
      SELECT event_id, user_id, event_type, source_type, actor_user_id,
             amount_delta_micros, balance_after_micros
        FROM user_financial_events
    `).get()).toEqual({
      event_id: 'user-state:user-finance:1',
      user_id: 'user-finance',
      event_type: 'balance_adjustment',
      source_type: 'admin_adjustment',
      actor_user_id: 'user-finance',
      amount_delta_micros: 250_000,
      balance_after_micros: 1_250_000,
    })

    expect(() => raw.exec(`
      UPDATE user_financial_events
         SET amount_delta_micros = 0
       WHERE event_id = 'user-state:user-finance:1'
    `)).toThrow(/user_financial_event_immutable/)
    expect(() => raw.exec(`
      DELETE FROM user_financial_events
       WHERE event_id = 'user-state:user-finance:1'
    `)).toThrow(/user_financial_event_immutable/)

    const index = raw.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_user_financial_events_user_cursor'
    `).get() as { sql: string }
    expect(index.sql.replace(/\s+/g, ' ')).toContain(
      '(user_id, occurred_at_ms DESC, event_id DESC)',
    )
  })
})
