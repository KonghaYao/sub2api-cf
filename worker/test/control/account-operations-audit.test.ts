import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { getAdminAuditEvent, listAdminAuditEvents } from '../../src/control/audit'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('account administrative audit projection', () => {
  it('exposes account operations without leaking idempotency material or invented provider facts', async () => {
    const { raw, d1 } = createSqliteD1()
    try {
      applyMigrations(raw)
      raw.exec(`
        INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
        VALUES ('account-admin', 'account-admin@example.test', 'Admin', 'admin', 'active', 1, 1);
        INSERT INTO admin_account_audit_events (
          id, actor_user_id, actor_session_id, action, resource_id,
          resource_version, idempotency_key_hash, metadata_json, occurred_at_ms
        ) VALUES (
          'account-audit-1', 'account-admin', 'account-session-secret',
          'account.health_probe.queue', 'account-one', 3, '${'b'.repeat(64)}',
          '{"job_id":"account-one:health:4","generation":4,"quota":0,"privacy_mode":"success"}',
          2000
        );
      `)
      const env = {
        APP_VERSION: 'test', ENVIRONMENT: 'test', ASSETS: {} as Fetcher, DB: d1,
        CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
        USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
      } as Env
      const app = new Hono<{ Bindings: Env }>()
      app.get('/audit/events', listAdminAuditEvents)
      app.get('/audit/events/:category/:id', getAdminAuditEvent)

      const listed = await app.request('/audit/events?category=account&resource_id=account-one', {}, env)
      expect(listed.status).toBe(200)
      await expect(listed.json()).resolves.toMatchObject({
        data: { items: [{
          category: 'account', action: 'account.health_probe.queue',
          resource_type: 'account', resource_id: 'account-one', resource_version: 3,
        }] },
      })

      const detail = await app.request('/audit/events/account/account-audit-1', {}, env)
      const payload = await detail.json()
      expect(detail.status).toBe(200)
      expect(payload).toMatchObject({
        data: { metadata: { job_id: 'account-one:health:4', generation: 4 } },
      })
      expect(JSON.stringify(payload)).not.toContain('idempotency_key_hash')
      expect(JSON.stringify(payload)).not.toContain('account-session-secret')
      expect(JSON.stringify(payload)).not.toContain('privacy_mode')
      expect(JSON.stringify(payload)).not.toContain('quota')
    } finally {
      raw.close()
    }
  })
})
