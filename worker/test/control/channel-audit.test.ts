import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { getAdminAuditEvent, listAdminAuditEvents } from '../../src/control/audit'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('channel administrative audit projection', () => {
  it('stores immutable channel events and exposes their real resource identity', async () => {
    const { raw, d1 } = createSqliteD1()
    try {
      applyMigrations(raw)
      raw.prepare(
        `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
         VALUES ('admin-channel', 'channel-admin@example.test', 'Admin', 'admin', 'active', 1, 1)`,
      ).run()
      raw.prepare(
        `INSERT INTO admin_channel_audit_events (
           id, actor_user_id, actor_session_id, action, resource_id,
           resource_version, idempotency_key_hash, changed_fields_json, occurred_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'channel-audit-1', 'admin-channel', 'session-channel-secret', 'channel.update',
        'channel-one', 3, 'a'.repeat(64), JSON.stringify(['name', 'restrict_models']), 2_000,
      )

      expect(() => raw.prepare(
        `UPDATE admin_channel_audit_events SET action = 'tampered' WHERE id = 'channel-audit-1'`,
      ).run()).toThrow(/admin_channel_audit_immutable/)
      expect(() => raw.prepare(
        `DELETE FROM admin_channel_audit_events WHERE id = 'channel-audit-1'`,
      ).run()).toThrow(/admin_channel_audit_immutable/)

      const env = {
        APP_VERSION: 'test', ENVIRONMENT: 'test', ASSETS: {} as Fetcher, DB: d1,
        CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
        USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
      } as Env
      const app = new Hono<{ Bindings: Env }>()
      app.get('/audit/events', listAdminAuditEvents)
      app.get('/audit/events/:category/:id', getAdminAuditEvent)

      const listed = await app.request(
        '/audit/events?category=channel&resource_type=channel&resource_id=channel-one',
        {}, env,
      )
      expect(listed.status).toBe(200)
      await expect(listed.json()).resolves.toMatchObject({
        data: {
          items: [{
            category: 'channel', event_id: 'channel-audit-1', action: 'channel.update',
            actor_user_id: 'admin-channel', resource_type: 'channel',
            resource_id: 'channel-one', resource_version: 3,
          }],
        },
      })

      const detail = await app.request('/audit/events/channel/channel-audit-1', {}, env)
      expect(detail.status).toBe(200)
      const body = await detail.json() as { data: Record<string, unknown> }
      expect(body.data).toMatchObject({
        actor_session_id_masked: 'sess…cret',
        metadata: { changed_fields: ['name', 'restrict_models'] },
      })
      expect(JSON.stringify(body)).not.toContain('idempotency_key_hash')
      expect(JSON.stringify(body)).not.toContain('session-channel-secret')
    } finally {
      raw.close()
    }
  })
})
