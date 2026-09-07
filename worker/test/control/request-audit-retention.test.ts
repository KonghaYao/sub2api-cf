import { describe, expect, it } from 'vitest'
import {
  ADMIN_REQUEST_AUDIT_RETENTION_BATCH,
  runAdminRequestAuditRetention,
} from '../../src/control/request-audit-retention'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const DAY_MS = 86_400_000

function fixture(retentionDays: number) {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  database.raw.prepare(
    "UPDATE system_settings SET audit_log_retention_days = ? WHERE id = 'global'",
  ).run(retentionDays)
  return database
}

function insertRequestAudit(raw: any, index: number, createdAtMs: number, clearTrace = false): void {
  raw.prepare(
    `INSERT INTO admin_request_audit_logs (
       event_key, created_at_ms, actor_user_id, actor_email, actor_role,
       auth_method, credential_masked, action, method, path, route_template,
       request_id, client_ip, user_agent, status_code, latency_ms,
       request_body, extra_json
     ) VALUES (?, ?, 'admin-one', 'admin@example.com', 'admin', 'jwt', '[masked]',
       ?, 'POST', '/api/v1/admin/test', '/api/v1/admin/test', ?, '', '', 200, 1,
       '[not_captured]', ?)`,
  ).run(
    `retention-event-${String(index).padStart(8, '0')}`,
    createdAtMs,
    clearTrace ? 'POST /api/v1/admin/audit-logs/clear' : 'POST /api/v1/admin/test',
    `retention-request-${String(index).padStart(8, '0')}`,
    clearTrace ? '{"kind":"clear_trace","deleted_rows":1}' : '{}',
  )
}

describe('admin request audit scheduled retention', () => {
  it('treats zero as permanent retention', async () => {
    const subject = fixture(0)
    insertRequestAudit(subject.raw, 1, 1)

    await expect(runAdminRequestAuditRetention({ DB: subject.d1 }, 10 * DAY_MS))
      .resolves.toEqual({ retention_days: 0, cutoff_ms: null, deleted: 0, has_more: false })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get())
      .toEqual({ count: 1 })
  })

  it('uses a strict absolute cutoff and always retains the newest clear trace', async () => {
    const subject = fixture(1)
    const now = 10 * DAY_MS
    const cutoff = now - DAY_MS
    insertRequestAudit(subject.raw, 1, cutoff - 1)
    insertRequestAudit(subject.raw, 2, cutoff)
    insertRequestAudit(subject.raw, 3, cutoff + 1)
    insertRequestAudit(subject.raw, 4, cutoff - 2, true)

    await expect(runAdminRequestAuditRetention({ DB: subject.d1 }, now)).resolves.toEqual({
      retention_days: 1,
      cutoff_ms: cutoff,
      deleted: 1,
      has_more: false,
    })
    expect(subject.raw.prepare(
      'SELECT event_key FROM admin_request_audit_logs ORDER BY created_at_ms, id',
    ).all()).toEqual([
      { event_key: 'retention-event-00000004' },
      { event_key: 'retention-event-00000002' },
      { event_key: 'retention-event-00000003' },
    ])
  })

  it('deletes at most 500 oldest rows and leaves the next page for a future tick', async () => {
    const subject = fixture(1)
    for (let index = 0; index < 503; index += 1) {
      insertRequestAudit(subject.raw, index, index + 1)
    }

    const first = await runAdminRequestAuditRetention({ DB: subject.d1 }, 10 * DAY_MS)
    expect(first).toMatchObject({
      deleted: ADMIN_REQUEST_AUDIT_RETENTION_BATCH,
      has_more: true,
    })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get())
      .toEqual({ count: 3 })

    const second = await runAdminRequestAuditRetention({ DB: subject.d1 }, 10 * DAY_MS)
    expect(second).toMatchObject({ deleted: 3, has_more: false })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get())
      .toEqual({ count: 0 })
  })

  it('never touches immutable domain audit tables', async () => {
    const subject = fixture(1)
    insertRequestAudit(subject.raw, 1, 1)
    subject.raw.prepare(
      `INSERT INTO auth_audit_events (
         id, event_type, outcome, metadata_json, occurred_at_ms
       ) VALUES ('domain-audit-event', 'login', 'succeeded', '{}', 1)`,
    ).run()

    await runAdminRequestAuditRetention({ DB: subject.d1 }, 10 * DAY_MS)
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get())
      .toEqual({ count: 0 })
    expect(subject.raw.prepare('SELECT id FROM auth_audit_events').all())
      .toEqual([{ id: 'domain-audit-event' }])
  })
})
