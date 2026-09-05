import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('usage dimensions migration', () => {
  it('registers v41 and persists bounded gateway dimensions', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 41',
    ).get()).toEqual({ version: 41, name: 'usage_dimensions' })
    const columns = raw.prepare(`PRAGMA table_info('usage_projection')`).all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'platform',
      'request_type',
      'inbound_endpoint',
      'upstream_endpoint',
      'billing_mode',
      'native_compaction_v2',
      'dimensions_version',
    ]))
    raw.close()
  })

  it('backfills platform and request type while keeping old-Worker inserts compatible', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 40)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'user-1@example.test', 1, 1);
      INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES ('group-1', 'one', 'anthropic', 1, 1);
      INSERT INTO usage_projection (
        event_id, request_id, user_id, group_id, model, input_tokens, output_tokens,
        amount_micros, occurred_at_ms, projected_at_ms, stream
      ) VALUES (
        'event-before', 'request-before', 'user-1', 'group-1', 'claude-test', 10, 5,
        1000, 2, 2, 1
      );
    `)

    applyMigrations(raw, 41)

    expect(raw.prepare(`
      SELECT platform, request_type, inbound_endpoint, upstream_endpoint,
             billing_mode, native_compaction_v2, dimensions_version
        FROM usage_projection WHERE event_id = 'event-before'
    `).get()).toEqual({
      platform: 'anthropic',
      request_type: 2,
      inbound_endpoint: '',
      upstream_endpoint: '',
      billing_mode: 'token',
      native_compaction_v2: 0,
      dimensions_version: 1,
    })

    // During a rolling deploy the previous Worker can still omit every v41
    // field; database defaults must keep those events writable and filterable.
    raw.prepare(`
      INSERT INTO usage_projection (
        event_id, request_id, user_id, group_id, model, input_tokens, output_tokens,
        amount_micros, occurred_at_ms, projected_at_ms, stream
      ) VALUES (?, ?, 'user-1', 'group-1', 'claude-test', 1, 1, 10, 3, 3, 0)
    `).run('event-during', 'request-during')
    expect(raw.prepare(`
      SELECT platform, request_type, billing_mode, native_compaction_v2, dimensions_version
        FROM usage_projection WHERE event_id = 'event-during'
    `).get()).toEqual({
      platform: '',
      request_type: 0,
      billing_mode: 'token',
      native_compaction_v2: 0,
      dimensions_version: 0,
    })
    raw.close()
  })
})
