import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  getAdminAuditEvent,
  listAdminAuditEvents,
} from '../../src/control/audit'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

interface Harness {
  app: Hono<{ Bindings: Env }>
  env: Env
  raw: any
}

function harness(): Harness {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw, 19)
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ASSETS: {} as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.get('/audit/events', listAdminAuditEvents)
  app.get('/audit/events/:category/:id', getAdminAuditEvent)

  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, created_at_ms, updated_at_ms
     ) VALUES ('admin-one', 'admin@example.com', 'Admin', 'admin', 'active', 1, 1)`,
  ).run()
  raw.exec('PRAGMA foreign_keys = OFF')
  raw.prepare(
    `INSERT INTO admin_settings_audit_events (
       id, actor_user_id, actor_session_id, action, resource_id,
       resource_version, idempotency_key_hash, request_hash,
       changed_fields_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'settings-1', 'admin-one', 'session-super-secret-value', 'system_settings.update',
    'global', 2, 'a'.repeat(64), 'b'.repeat(64),
    JSON.stringify([
      'public.site_name',
      'secrets.turnstile_secret_key:set',
      'secrets.turnstile_secret_key:actual-secret',
    ]),
    4_000,
  )
  raw.prepare(
    `INSERT INTO admin_rbac_audit_events (
       id, actor_user_id, actor_session_id, action, resource_type,
       resource_id, resource_version, idempotency_key_hash,
       request_hash, details_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'rbac-1', 'admin-one', 'session-rbac-secret-value', 'admin_role.update',
    'admin_role', 'role-one', 3, 'c'.repeat(64), 'd'.repeat(64),
    JSON.stringify({
      before: {
        id: 'role-one',
        name: 'name must not be copied from arbitrary payloads',
        description: 'Bearer payload-secret',
        permissions: ['admin.users.read', 'not-a-permission'],
        active: true,
        control_version: 2,
      },
      token: 'payload-token',
    }),
    3_000,
  )
  raw.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'auth-1', 'admin-one', 'auth.password.change', 'failed', 'e'.repeat(64),
    'f'.repeat(64), 'session-auth-secret-value',
    JSON.stringify({
      api_key_id: 'key-one',
      reason: 'invalid_current_password',
      target_session_id: 'target-session-secret',
      password: 'payload-password',
    }),
    3_000,
  )
  raw.prepare(
    `INSERT INTO payment_events (
       id, order_id, event_type, source_type, source_id,
       payload_json, occurred_at_ms, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'payment-1', 'order-one', 'REFUND_FAILED', 'provider', 'provider-source-secret',
    JSON.stringify({
      refund_id: 'refund-one',
      amount_micros: 123_000,
      currency: 'CNY',
      provider_order_id: 'provider-order-secret',
      error: 'Authorization: Bearer payload-secret',
    }),
    3_000, 3_000,
  )
  raw.exec('PRAGMA foreign_keys = ON')
  return { app, env, raw }
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>
}

describe('unified admin audit event view', () => {
  let subject: Harness

  beforeEach(() => {
    subject = harness()
  })

  it('uses a bounded stable cursor across event tables without returning payloads', async () => {
    const first = await subject.app.request('/audit/events?limit=2', {}, subject.env)
    expect(first.status).toBe(200)
    const firstBody = await json(first)
    expect(firstBody.data.items.map((item: any) => [item.category, item.event_id])).toEqual([
      ['settings', 'settings-1'],
      ['rbac', 'rbac-1'],
    ])
    expect(firstBody.data.items[0]).not.toHaveProperty('metadata')
    expect(firstBody.data.items[0]).not.toHaveProperty('actor_session_id')
    expect(firstBody.data.has_more).toBe(true)
    expect(firstBody.data.next_cursor).toEqual(expect.any(String))

    subject.raw.prepare(
      `INSERT INTO auth_audit_events (
         id, user_id, event_type, outcome, metadata_json, occurred_at_ms
       ) VALUES ('newer', 'admin-one', 'auth.login', 'succeeded', '{}', 5000)`,
    ).run()

    const second = await subject.app.request(
      `/audit/events?limit=2&cursor=${encodeURIComponent(firstBody.data.next_cursor)}`,
      {},
      subject.env,
    )
    const secondBody = await json(second)
    expect(secondBody.data.items.map((item: any) => [item.category, item.event_id])).toEqual([
      ['payment', 'payment-1'],
      ['auth', 'auth-1'],
    ])
    expect(secondBody.data.has_more).toBe(false)
    expect(secondBody.data.next_cursor).toBeNull()
  })

  it('supports exact category, action, outcome, actor, resource, and RFC3339 filters', async () => {
    const response = await subject.app.request(
      '/audit/events?category=auth&action=auth.password.change&outcome=failed' +
      '&actor_user_id=admin-one&resource_type=user&resource_id=admin-one' +
      '&start_time=1970-01-01T00%3A00%3A03.000Z&end_time=1970-01-01T00%3A00%3A03.000Z',
      {},
      subject.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0]).toMatchObject({
      category: 'auth',
      event_id: 'auth-1',
      action: 'auth.password.change',
      outcome: 'failed',
      actor_user_id: 'admin-one',
      resource_type: 'user',
      resource_id: 'admin-one',
    })

    const failedPayment = await subject.app.request(
      '/audit/events?category=payment&outcome=failed',
      {},
      subject.env,
    )
    expect((await json(failedPayment)).data.items).toEqual([
      expect.objectContaining({
        category: 'payment',
        event_id: 'payment-1',
        action: 'REFUND_FAILED',
        outcome: 'failed',
      }),
    ])
  })

  it('returns only source-specific allowlisted detail and masks session identifiers', async () => {
    const checks = [
      {
        path: '/audit/events/settings/settings-1',
        sessionMasked: 'sess…alue',
        metadata: {
          changed_fields: ['public.site_name', 'secrets.turnstile_secret_key:set'],
        },
      },
      {
        path: '/audit/events/rbac/rbac-1',
        sessionMasked: 'sess…alue',
        metadata: {
          before: {
            id: 'role-one',
            permissions: ['admin.users.read'],
            active: true,
            control_version: 2,
          },
        },
      },
      {
        path: '/audit/events/auth/auth-1',
        sessionMasked: 'sess…alue',
        metadata: { api_key_id: 'key-one', reason: 'invalid_current_password' },
      },
      {
        path: '/audit/events/payment/payment-1',
        sessionMasked: null,
        outcome: 'failed',
        metadata: { refund_id: 'refund-one', amount_micros: 123_000, currency: 'CNY' },
      },
    ]

    for (const check of checks) {
      const response = await subject.app.request(check.path, {}, subject.env)
      expect(response.status).toBe(200)
      const body = await json(response)
      expect(body.data.metadata).toEqual(check.metadata)
      if (check.outcome !== undefined) expect(body.data.outcome).toBe(check.outcome)
      expect(body.data.actor_session_id_masked).toBe(check.sessionMasked)
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('payload-secret')
      expect(serialized).not.toContain('payload-password')
      expect(serialized).not.toContain('target-session-secret')
      expect(serialized).not.toContain('provider-order-secret')
      expect(serialized).not.toContain('provider-source-secret')
      expect(serialized).not.toContain('session-super-secret-value')
      expect(serialized).not.toContain('session-rbac-secret-value')
      expect(serialized).not.toContain('session-auth-secret-value')
      expect(serialized).not.toContain('idempotency_key_hash')
      expect(serialized).not.toContain('request_hash')
      expect(serialized).not.toContain('email_hash')
      expect(serialized).not.toContain('ip_hash')
    }
  })

  it('rejects invalid bounds and cursors and returns a stable not-found error', async () => {
    const invalidLimit = await subject.app.request('/audit/events?limit=101', {}, subject.env)
    expect(invalidLimit.status).toBe(400)
    expect((await json(invalidLimit)).error.code).toBe('invalid_limit')

    const invalidCursor = await subject.app.request('/audit/events?cursor=not-base64', {}, subject.env)
    expect(invalidCursor.status).toBe(400)
    expect((await json(invalidCursor)).error.code).toBe('invalid_audit_cursor')

    const reversedTime = await subject.app.request(
      '/audit/events?start_time=2026-01-02T00%3A00%3A00Z&end_time=2026-01-01T00%3A00%3A00Z',
      {},
      subject.env,
    )
    expect(reversedTime.status).toBe(400)
    expect((await json(reversedTime)).error.code).toBe('invalid_audit_time_range')

    const missing = await subject.app.request('/audit/events/auth/missing', {}, subject.env)
    expect(missing.status).toBe(404)
    expect((await json(missing)).error.code).toBe('admin_audit_event_not_found')
  })
})
