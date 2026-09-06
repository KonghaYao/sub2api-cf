import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)
const TOKEN = 'balance-history-admin-session-0001'

describe('admin user balance history', () => {
  let raw: any
  let env: Env

  beforeEach(async () => {
    const database = createSqliteD1()
    raw = database.raw
    applyMigrations(raw)
    const now = Date.now()
    raw.exec(`
      INSERT INTO users (
        id, email, display_name, role, status, created_at_ms, updated_at_ms
      ) VALUES
        ('root-admin', 'root@example.test', 'Root', 'admin', 'active', 1, 1),
        ('history-admin', 'admin@example.test', 'Admin', 'admin', 'active', 1, 1),
        ('history-user', 'user@example.test', 'User', 'user', 'active', 1, 1);

      INSERT INTO admin_roles (
        id, name, description, active, control_version, created_at_ms, updated_at_ms
      ) VALUES ('history-reader', 'History reader', '', 1, 0, 1, 1);
      INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
      VALUES ('history-reader', 'admin.users.read', 1);
      INSERT INTO admin_user_roles (
        user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
      ) VALUES ('history-admin', 'history-reader', 1, 1, NULL, 1);
    `)
    raw.prepare(`
      INSERT INTO admin_sessions (
        id, user_id, token_hash, created_at_ms, expires_at_ms
      ) VALUES ('history-session', 'history-admin', ?, ?, ?)
    `).run(
      await apiKeyDigest(`admin-session:v1:${TOKEN}`, PEPPER),
      now,
      now + 60_000,
    )
    seedEvent('event-a', 1, 'redeem_code', 'redeem-a', 100, 100_000, 100_000)
    seedEvent('event-b', 2, 'usage_settlement', 'request-b', 200, -25_000, 75_000, 'request-b')
    seedEvent('event-c', 3, 'admin_adjustment', 'adjust-c', 300, 50_000, 125_000, null, 80_000)

    env = {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      DB: database.d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    }
  })

  it('returns stable tuple-cursor pages with exact integer micros', async () => {
    const first = await request('/api/v1/admin/users/history-user/balance-history?limit=2')

    expect(first.status).toBe(200)
    const firstBody = await first.json() as any
    expect(firstBody).toMatchObject({
      code: 0,
      data: {
        items: [
          {
            event_id: 'event-c',
            user_id: 'history-user',
            event_type: 'balance_adjustment',
            source_type: 'admin_adjustment',
            amount_delta_micros: 50_000,
            balance_after_micros: 125_000,
            occurred_at_ms: 300,
          },
          {
            event_id: 'event-b',
            event_type: 'settlement',
            amount_delta_micros: -25_000,
            gross_amount_micros: 25_000,
            request_id: 'request-b',
          },
        ],
        total: 3,
        limit: 2,
        has_more: true,
        total_recharged_micros: 180_000,
        history_complete: false,
        history_available_from_ms: expect.any(Number),
      },
    })
    expect(firstBody.data.next_cursor).toEqual(expect.any(String))

    // A newer event arriving between reads must not shift the second page.
    seedEvent('event-new', 4, 'redeem_code', 'redeem-new', 400, 70_000, 195_000)
    const second = await request(
      `/api/v1/admin/users/history-user/balance-history?limit=2&cursor=${encodeURIComponent(firstBody.data.next_cursor)}`,
    )
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      code: 0,
      data: {
        items: [{ event_id: 'event-a', amount_delta_micros: 100_000 }],
        total: 4,
        limit: 2,
        has_more: false,
        next_cursor: null,
        total_recharged_micros: 250_000,
      },
    })
  })

  it('bounds pagination, validates cursors, and does not leak a missing user', async () => {
    const tooLarge = await request(
      '/api/v1/admin/users/history-user/balance-history?limit=101',
    )
    const invalidCursor = await request(
      '/api/v1/admin/users/history-user/balance-history?cursor=not-a-cursor',
    )
    const missing = await request(
      '/api/v1/admin/users/missing-user/balance-history',
    )

    expect(tooLarge.status).toBe(400)
    await expect(tooLarge.json()).resolves.toMatchObject({
      error: { code: 'invalid_limit' },
    })
    expect(invalidCursor.status).toBe(400)
    await expect(invalidCursor.json()).resolves.toMatchObject({
      error: { code: 'invalid_cursor' },
    })
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'user_not_found' },
    })
  })

  it('filters event rows without changing the lifetime recharge total', async () => {
    const response = await request(
      '/api/v1/admin/users/history-user/balance-history?type=admin_balance',
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        items: [{ event_id: 'event-c', source_type: 'admin_adjustment' }],
        total: 1,
        total_recharged_micros: 180_000,
      },
    })
  })

  it('declares complete history only for tracking-enabled users with a projected opening event', async () => {
    raw.prepare(
      `UPDATE users SET financial_history_complete = 1 WHERE id = 'history-user'`,
    ).run()

    const beforeOpening = await request('/api/v1/admin/users/history-user/balance-history')
    await expect(beforeOpening.json()).resolves.toMatchObject({
      data: { history_complete: false },
    })

    seedOpeningEvent('event-opening', 0, 50, 0)
    const afterOpening = await request('/api/v1/admin/users/history-user/balance-history')
    await expect(afterOpening.json()).resolves.toMatchObject({
      data: { history_complete: true },
    })
  })

  it('requires the administrator user-read permission', async () => {
    raw.prepare(
      `DELETE FROM admin_role_permissions
        WHERE role_id = 'history-reader' AND permission_key = 'admin.users.read'`,
    ).run()

    const response = await request(
      '/api/v1/admin/users/history-user/balance-history',
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.users.read'),
      },
    })
  })

  function seedEvent(
    eventId: string,
    stateVersion: number,
    sourceType: string,
    sourceId: string,
    occurredAtMs: number,
    amountDeltaMicros: number,
    balanceAfterMicros: number,
    requestId: string | null = null,
    grossAmountMicros: number = eventTypeFor(sourceType) === 'settlement'
      ? -amountDeltaMicros
      : amountDeltaMicros,
  ): void {
    const eventType = eventTypeFor(sourceType)
    raw.prepare(`
      INSERT INTO user_financial_events (
        event_id, user_id, state_version, event_type, source_type, source_id,
        request_id, amount_delta_micros, gross_amount_micros,
        spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
        occurred_at_ms, projected_at_ms
      ) VALUES (?, 'history-user', ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
    `).run(
      eventId,
      stateVersion,
      eventType,
      sourceType,
      sourceId,
      requestId,
      amountDeltaMicros,
      grossAmountMicros,
      balanceAfterMicros,
      occurredAtMs,
      occurredAtMs,
    )
  }

  function seedOpeningEvent(
    eventId: string,
    stateVersion: number,
    occurredAtMs: number,
    balanceAfterMicros: number,
  ): void {
    raw.prepare(`
      INSERT INTO user_financial_events (
        event_id, user_id, state_version, event_type, source_type, source_id,
        request_id, amount_delta_micros, gross_amount_micros,
        spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
        occurred_at_ms, projected_at_ms
      ) VALUES (?, 'history-user', ?, 'opening_balance', 'opening_balance', ?,
                NULL, ?, ?, 0, ?, 0, ?, ?)
    `).run(
      eventId,
      stateVersion,
      `opening-${stateVersion}`,
      balanceAfterMicros,
      balanceAfterMicros,
      balanceAfterMicros,
      occurredAtMs,
      occurredAtMs,
    )
  }

  function eventTypeFor(sourceType: string): 'settlement' | 'balance_adjustment' {
    return sourceType === 'usage_settlement' ? 'settlement' : 'balance_adjustment'
  }

  function request(path: string): Promise<Response> {
    return Promise.resolve(createApp().request(path, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }, env))
  }
})
