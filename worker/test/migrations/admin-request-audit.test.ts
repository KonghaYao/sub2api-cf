import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('admin request audit migration', () => {
  it('adds a constrained 180-day retention default in migration 0077', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 76)
    expect(raw.prepare(
      "SELECT name FROM pragma_table_info('system_settings') WHERE name = 'audit_log_retention_days'",
    ).get()).toBeUndefined()

    applyMigrations(raw)
    expect(raw.prepare(
      "SELECT audit_log_retention_days FROM system_settings WHERE id = 'global'",
    ).get()).toEqual({ audit_log_retention_days: 180 })
    expect(() => raw.prepare(
      "UPDATE system_settings SET audit_log_retention_days = -1 WHERE id = 'global'",
    ).run()).toThrow()
    expect(() => raw.prepare(
      "UPDATE system_settings SET audit_log_retention_days = 3651 WHERE id = 'global'",
    ).run()).toThrow()
    expect(raw.prepare(
      'SELECT name FROM schema_migrations WHERE version = 77',
    ).get()).toEqual({ name: 'audit_log_retention' })
    expect(raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get('idx_admin_request_audit_logs_latest_clear_trace')).toEqual({
      name: 'idx_admin_request_audit_logs_latest_clear_trace',
    })

    const clearTracePlan = raw.prepare(
      `EXPLAIN QUERY PLAN
       SELECT trace.id
         FROM admin_request_audit_logs AS trace
        WHERE trace.action = 'POST /api/v1/admin/audit-logs/clear'
          AND json_extract(trace.extra_json, '$.kind') = 'clear_trace'
        ORDER BY trace.created_at_ms DESC, trace.id DESC
        LIMIT 1`,
    ).all() as Array<{ detail: string }>
    expect(clearTracePlan.map((step) => step.detail).join('\n')).toContain(
      'idx_admin_request_audit_logs_latest_clear_trace',
    )
  })

  it('creates the isolated strict table and required covering indexes', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    const table = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_request_audit_logs'",
    ).get() as { sql: string }
    expect(table.sql).toContain('STRICT')
    const indexes = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'admin_request_audit_logs' ORDER BY name",
    ).all().map((row: { name: string }) => row.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_admin_request_audit_logs_time_id',
      'idx_admin_request_audit_logs_actor_time',
      'idx_admin_request_audit_logs_client_ip_time',
      'idx_admin_request_audit_logs_auth_method_time',
      'idx_admin_request_audit_logs_method_time',
    ]))
  })

  it('rejects invalid JSON and out-of-range status codes', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    const insert = raw.prepare(
      `INSERT INTO admin_request_audit_logs (
         event_key, created_at_ms, actor_user_id, actor_email, actor_role,
         auth_method, credential_masked, action, method, path, route_template,
         request_id, client_ip, user_agent, status_code, latency_ms,
         request_body, extra_json
       ) VALUES ('event-key-0000001', 1, 'admin', 'admin@example.com', 'admin',
         'jwt', '[masked]', 'POST /admin/test', 'POST', '/admin/test', '/admin/test',
         'request-one', '', '', ?, 1, '[not_captured]', ?)`,
    )
    expect(() => insert.run(99, '{}')).toThrow()
    expect(() => insert.run(200, '[]')).toThrow()
  })
})
