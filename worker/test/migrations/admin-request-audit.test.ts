import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('admin request audit migration', () => {
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
