import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('media task migration', () => {
  it('creates strict task, item, output, and event storage', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)

    const tables = raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'media_task%'
        ORDER BY name`,
    ).all().map((row: { name: string }) => row.name)

    expect(tables).toEqual([
      'media_task_events',
      'media_task_items',
      'media_task_outputs',
      'media_tasks',
    ])
    expect(() => raw.prepare(
      `INSERT INTO media_tasks (
         id, user_id, api_key_id, group_id, provider, model, status,
         item_count, expected_output_count, estimated_cost_micros,
         hold_amount_micros, billing_type, idempotency_key_hash,
         request_hash, input_object_key, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'not-a-status', 1, 1, 0, 0, 'balance', ?, ?, ?, 1, 1)`,
    ).run(
      'imgbatch_00000000000000000000000000000000',
      'user',
      'key',
      'group',
      'gemini_api',
      'gemini-2.5-flash-image',
      'a'.repeat(64),
      'b'.repeat(64),
      'media/input.json',
    )).toThrow()
  })
})
