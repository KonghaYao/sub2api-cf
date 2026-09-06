import { afterEach, describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const databases: any[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop().close()
})

describe('customer pricing snapshot migration', () => {
  it('adds a bounded nullable object snapshot without backfilling historical usage', () => {
    const { raw } = createSqliteD1()
    databases.push(raw)
    applyMigrations(raw, 53)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-customer-price', 'customer-price@example.test', 1, 1);
      INSERT INTO usage_projection (
        event_id, request_id, user_id, model, amount_micros,
        occurred_at_ms, projected_at_ms
      ) VALUES (
        'usage-customer-price', 'request-customer-price', 'user-customer-price',
        'gpt-test', 7, 1, 1
      );
    `)

    applyMigrations(raw, 54)

    expect(raw.prepare(`
      SELECT customer_pricing_snapshot_json
        FROM usage_projection WHERE event_id = 'usage-customer-price'
    `).get()).toEqual({ customer_pricing_snapshot_json: null })
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 54',
    ).get()).toEqual({ version: 54, name: 'customer_pricing' })
    expect(raw.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'index' AND lower(sql) LIKE '%customer_pricing_snapshot_json%'
    `).get()).toEqual({ count: 0 })

    const insert = raw.prepare(`
      INSERT INTO usage_projection (
        event_id, request_id, user_id, model, amount_micros,
        customer_pricing_snapshot_json, occurred_at_ms, projected_at_ms
      ) VALUES (?, ?, 'user-customer-price', 'gpt-test', 0, ?, 2, 2)
    `)
    expect(() => insert.run('invalid-array', 'invalid-array', '[]')).toThrow(/CHECK/)
    expect(() => insert.run(
      'invalid-size', 'invalid-size', `{"payload":"${'x'.repeat(65_536)}"}`,
    )).toThrow(/CHECK/)
  })

  it('freezes customer economics and snapshot while leaving catalog price_id mutable', () => {
    const { raw } = createSqliteD1()
    databases.push(raw)
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-customer-price', 'customer-price@example.test', 1, 1);
      INSERT INTO usage_projection (
        event_id, request_id, user_id, model,
        input_amount_micros, output_amount_micros, cache_amount_micros,
        base_amount_micros, amount_micros, customer_pricing_snapshot_json,
        occurred_at_ms, projected_at_ms
      ) VALUES (
        'usage-customer-price', 'request-customer-price', 'user-customer-price',
        'gpt-test', 1, 2, 3, 4, 10, '{"version":1}', 1, 1
      );
    `)

    for (const column of [
      'billing_mode', 'input_amount_micros', 'output_amount_micros', 'cache_amount_micros',
      'base_amount_micros', 'amount_micros', 'customer_pricing_snapshot_json',
    ]) {
      expect(() => raw.exec(
        `UPDATE usage_projection SET ${column} = ${column} WHERE event_id = 'usage-customer-price'`,
      )).toThrow(/usage_customer_pricing_immutable/)
    }

    expect(() => raw.exec(`
      UPDATE usage_projection SET price_id = NULL WHERE event_id = 'usage-customer-price'
    `)).not.toThrow()
  })
})
