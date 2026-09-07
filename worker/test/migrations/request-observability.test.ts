import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('request observability migration', () => {
  it('registers v40 with bounded keyset, retry, and retention indexes', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 40',
    ).get()).toEqual({ version: 40, name: 'request_observability' })
    expect(raw.prepare(
      `SELECT COUNT(*) AS total FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_request_observations_owner_seek',
          'idx_request_observations_admin_seek',
          'idx_request_observations_error_seek',
          'idx_request_observations_request_correlation',
          'idx_request_observations_payload_retry',
          'idx_request_observations_retention'
        )`,
    ).get()).toEqual({ total: 6 })
    expect(raw.prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'limit_request_observation_bucket'`,
    ).get()?.sql).toContain('100000')
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 78',
    ).get()).toEqual({ version: 78, name: 'ops_request_context' })
    expect(raw.prepare(
      `SELECT name FROM pragma_table_info('request_observations')
        WHERE name IN ('upstream_endpoint','client_ip','user_agent') ORDER BY name`,
    ).all()).toEqual([
      { name: 'client_ip' }, { name: 'upstream_endpoint' }, { name: 'user_agent' },
    ])
    raw.close()
  })

  it('enforces lifecycle and payload-reference invariants', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    const now = Date.now()
    const insert = raw.prepare(
      `INSERT INTO request_observations (
         id, request_id, bucket_day, occurred_at_ms, lifecycle, method, request_path, updated_at_ms
       ) VALUES (?, ?, 20260905, ?, ?, 'POST', '/v1/responses', ?)`,
    )
    expect(() => insert.run('00000000-0000-4000-8000-000000000001', 'request-1', now, 'started', now)).not.toThrow()
    expect(() => insert.run('00000000-0000-4000-8000-000000000002', 'request-2', now, 'failed', now)).toThrow()
    expect(() => raw.prepare(
      `UPDATE request_observations SET payload_state = 'stored', updated_at_ms = ?
        WHERE request_id = 'request-1'`,
    ).run(now)).toThrow()
    expect(raw.prepare(
      'SELECT row_count FROM request_observation_buckets WHERE bucket_day = 20260905',
    ).get()).toEqual({ row_count: 1 })
    raw.close()
  })

  it('uses the owner-error partial index for total pagination in the original user table', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    expect(raw.prepare(
      'SELECT version, name FROM schema_migrations WHERE version = 80',
    ).get()).toEqual({ version: 80, name: 'owner_error_list_index' })

    const plan = raw.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM request_observations
        WHERE lifecycle = 'failed' AND user_id = ?
          AND request_path NOT LIKE '%/count_tokens' COLLATE NOCASE
        ORDER BY occurred_at_ms DESC, id DESC
        LIMIT ? OFFSET ?`,
    ).all('user-one', 20, 0) as Array<{ detail: string }>
    expect(plan.map((step) => step.detail).join('\n')).toContain(
      'idx_request_observations_owner_error_seek',
    )
    raw.close()
  })
})
