import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { consumeEvents } from '../../src/gateway/queue'
import { runScheduledRecovery } from '../../src/index'
import { consumeSettingsMaintenance } from '../../src/maintenance/queue'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'admin-subscriptions-test-pepper-at-least-32-bytes'
const DAY_MS = 86_400_000
const ADMIN_ID = '00000000-0000-4000-8000-000000000001'
const ALICE_ID = '00000000-0000-4000-8000-000000000002'
const BOB_ID = '00000000-0000-4000-8000-000000000003'
const GROUP_ID = '00000000-0000-4000-8000-000000000010'
const DISABLED_GROUP_ID = '00000000-0000-4000-8000-000000000011'

class SubscriptionStateFake {
  calls: Array<{ subscriptionId: string; path: string; body: Record<string, unknown> }> = []
  failuresRemaining = 0
  failuresByPath = new Map<string, number>()

  namespace(): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: (subscriptionId: string) => ({
        fetch: async (request: Request) => {
          const body = await request.json() as Record<string, unknown>
          const path = new URL(request.url).pathname
          this.calls.push({ subscriptionId, path, body })
          const pathFailures = this.failuresByPath.get(path) ?? 0
          if (pathFailures > 0) {
            this.failuresByPath.set(path, pathFailures - 1)
            throw new Error('simulated durable object network failure')
          }
          if (this.failuresRemaining > 0) {
            this.failuresRemaining -= 1
            throw new Error('simulated durable object network failure')
          }
          return Response.json({ schema_version: 1, idempotent: false })
        },
      }),
    } as unknown as DurableObjectNamespace
  }
}

interface Fixture {
  raw: any
  env: Env
  headers: Record<string, string>
  state: SubscriptionStateFake
}

let now = Date.now()

beforeEach(() => {
  now = Date.now()
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  for (const [id, email, role] of [
    [ADMIN_ID, 'admin@example.test', 'admin'],
    [ALICE_ID, 'alice@example.test', 'user'],
    [BOB_ID, 'bob@example.test', 'user'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(id, email, email.split('@')[0], role, now, now)
  }
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, description, platform, enabled, rate_multiplier_ppm, group_type,
       daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
       created_at_ms, updated_at_ms
     ) VALUES (?, 'Pro', 'Snapshot plan', 'openai', 1, 1250000, 'subscription',
               10000000, 50000000, 100000000, ?, ?)`,
  ).run(GROUP_ID, now, now)
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, group_type, created_at_ms, updated_at_ms
     ) VALUES (?, 'Disabled', 'openai', 0, 'subscription', ?, ?)`,
  ).run(DISABLED_GROUP_ID, now, now)
  raw.prepare(
    `INSERT INTO user_group_rate_overrides (
       user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 750000, ?, ?)`,
  ).run(ALICE_ID, GROUP_ID, now, now)

  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('admin-sub-session', 'admin-sub-family', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    ADMIN_ID,
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    now,
    now + DAY_MS,
    now + 30 * DAY_MS,
  )
  const state = new SubscriptionStateFake()
  return {
    raw,
    state,
    headers: { authorization: `Bearer ${access}` },
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: state.namespace(),
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function mutationHeaders(test: Fixture, key: string, version?: number): Record<string, string> {
  return {
    ...test.headers,
    'content-type': 'application/json',
    'idempotency-key': key,
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
  }
}

async function request(test: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return await createApp().request(path, {
    ...init,
    headers: { ...test.headers, ...init.headers },
  }, test.env)
}

async function json(response: Response): Promise<any> {
  return response.json()
}

async function assign(
  test: Fixture,
  userId = ALICE_ID,
  key = 'admin-subscription-assign-1',
): Promise<Response> {
  return request(test, '/api/v1/admin/subscriptions/assign', {
    method: 'POST',
    headers: mutationHeaders(test, key),
    body: JSON.stringify({ user_id: userId, group_id: GROUP_ID, validity_days: 30, notes: 'welcome' }),
  })
}

async function projectSubscriptionUsageDuringNextBatch(
  test: Fixture,
  subscriptionId: string,
  requestId: string,
  amountMicros: number,
): Promise<() => void> {
  const originalDb = test.env.DB
  const row = test.raw.prepare(
    `SELECT daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
            quota_reset_epoch
       FROM user_subscriptions WHERE id = ?`,
  ).get(subscriptionId) as {
    daily_window_start_ms: number
    weekly_window_start_ms: number
    monthly_window_start_ms: number
    quota_reset_epoch: number
  }
  let injected = false
  test.env.DB = {
    prepare: (sql: string) => originalDb.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      if (!injected) {
        injected = true
        const updatedAt = Date.now()
        const event = {
          schema_version: 1 as const,
          event_id: `subscription-usage:${requestId}`,
          event_type: 'subscription.usage.settled.v1',
          occurred_at_ms: updatedAt,
          aggregate_type: 'subscription',
          aggregate_id: subscriptionId,
          payload: {
            request_id: requestId,
            subscription_id: subscriptionId,
            user_id: ALICE_ID,
            group_id: GROUP_ID,
            amount_micros: amountMicros,
            daily_window_start_ms: row.daily_window_start_ms,
            weekly_window_start_ms: row.weekly_window_start_ms,
            monthly_window_start_ms: row.monthly_window_start_ms,
            quota_reset_epoch: row.quota_reset_epoch,
            updated_at_ms: updatedAt,
          },
        }
        await consumeEvents({
          queue: 'events',
          messages: [{
            id: requestId,
            timestamp: new Date(updatedAt),
            body: event,
            attempts: 1,
            ack: vi.fn(),
            retry: vi.fn(),
          }],
        } as unknown as MessageBatch<unknown>, { ...test.env, DB: originalDb })
      }
      return originalDb.batch(statements)
    },
  } as D1Database
  return () => {
    test.env.DB = originalDb
  }
}

describe('admin subscriptions HTTP contract', () => {
  it('assigns UUID entitlements idempotently and lists snapshot quotas with the effective user rate', async () => {
    const test = await fixture()

    const first = await assign(test)
    expect(first.status).toBe(201)
    const subscription = (await json(first)).data
    expect(subscription).toMatchObject({
      user_id: ALICE_ID,
      group_id: GROUP_ID,
      status: 'active',
      notes: 'welcome',
      control_version: 0,
      user: { id: ALICE_ID, email: 'alice@example.test' },
      group: {
        id: GROUP_ID,
        name: 'Pro',
        subscription_type: 'subscription',
        rate_multiplier: 0.75,
        daily_limit_usd: 10,
        weekly_limit_usd: 50,
        monthly_limit_usd: 100,
      },
    })
    expect(subscription.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    const replay = await assign(test)
    expect(replay.status).toBe(200)
    expect((await json(replay)).data).toEqual(subscription)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM user_subscriptions').get()).toEqual({ total: 1 })
    expect(test.raw.prepare('SELECT status FROM subscription_state_sync').get()).toEqual({ status: 'applied' })

    const listed = await request(test, `/api/v1/admin/subscriptions?user_id=${ALICE_ID}&status=active`)
    expect(listed.status).toBe(200)
    await expect(json(listed)).resolves.toMatchObject({
      data: { items: [expect.objectContaining({ id: subscription.id })], total: 1, page: 1, pages: 1 },
    })
    expect((await request(test, `/api/v1/admin/subscriptions/${subscription.id}`)).status).toBe(200)
    expect((await request(test, `/api/v1/admin/subscriptions/${subscription.id}/progress`)).status).toBe(200)
    expect((await request(test, `/api/v1/admin/groups/${GROUP_ID}/subscriptions`)).status).toBe(200)
    expect((await request(test, `/api/v1/admin/users/${ALICE_ID}/subscriptions`)).status).toBe(200)
  })

  it('bulk assigns valid users atomically and reports disabled/missing users without duplicate rows', async () => {
    const test = await fixture()
    test.raw.prepare('UPDATE users SET status = \'disabled\' WHERE id = ?').run(BOB_ID)
    const missing = '00000000-0000-4000-8000-000000000099'
    const response = await request(test, '/api/v1/admin/subscriptions/bulk-assign', {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-bulk-assign-1'),
      body: JSON.stringify({
        user_ids: [ALICE_ID, ALICE_ID, BOB_ID, missing],
        group_id: GROUP_ID,
        validity_days: 7,
      }),
    })
    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toMatchObject({
      data: {
        success_count: 1,
        created_count: 1,
        failed_count: 2,
        subscriptions: [expect.objectContaining({ user_id: ALICE_ID })],
        statuses: {
          [ALICE_ID]: 'created',
          [BOB_ID]: 'failed',
          [missing]: 'failed',
        },
      },
    })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM user_subscriptions').get()).toEqual({ total: 1 })
  })

  it('requires CAS for mutations and enforces disabled and expired boundaries', async () => {
    const test = await fixture()
    const assigned = (await json(await assign(test))).data
    const missingCas = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/extend`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-extend-no-cas'),
      body: JSON.stringify({ days: 1 }),
    })
    expect(missingCas.status).toBe(428)
    const extended = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/extend`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-extend-1', 0),
      body: JSON.stringify({ days: 1, expected_control_version: 0 }),
    })
    expect(extended.status).toBe(200)
    expect((await json(extended)).data.control_version).toBe(1)
    const stale = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/revoke`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-revoke-stale', 0),
      body: JSON.stringify({ expected_control_version: 0 }),
    })
    expect(stale.status).toBe(412)

    const disabledGroup = await request(test, '/api/v1/admin/subscriptions/assign', {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-disabled-group'),
      body: JSON.stringify({ user_id: BOB_ID, group_id: DISABLED_GROUP_ID, validity_days: 30 }),
    })
    expect(disabledGroup.status).toBe(409)
    const invalidUuid = await request(test, '/api/v1/admin/subscriptions/assign', {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-invalid-uuid'),
      body: JSON.stringify({ user_id: 'alice', group_id: GROUP_ID, validity_days: 30 }),
    })
    expect(invalidUuid.status).toBe(400)
  })

  it('persists the entitlement and sync intent atomically, then resumes a failed DO call with the same key', async () => {
    const test = await fixture()
    test.state.failuresRemaining = 1

    const first = await assign(test, ALICE_ID, 'admin-subscription-do-recovery')
    expect(first.status).toBe(503)
    expect(test.raw.prepare(
      'SELECT status FROM user_subscriptions WHERE user_id = ?',
    ).get(ALICE_ID)).toEqual({ status: 'active' })
    expect(test.raw.prepare(
      'SELECT status, attempts FROM subscription_state_sync',
    ).get()).toEqual({ status: 'pending', attempts: 1 })

    const replay = await assign(test, ALICE_ID, 'admin-subscription-do-recovery')
    expect(replay.status).toBe(200)
    expect(test.raw.prepare(
      'SELECT status, attempts FROM subscription_state_sync',
    ).get()).toEqual({ status: 'applied', attempts: 1 })
    expect(test.state.calls.filter((call) => call.path === '/configure')).toHaveLength(2)
  })

  it('revokes and restores with versioned DO configurations, preserving the expired boundary', async () => {
    const test = await fixture()
    const assigned = (await json(await assign(test))).data
    const revoke = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/revoke`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-revoke-1', 0),
      body: JSON.stringify({ expected_control_version: 0 }),
    })
    expect(revoke.status).toBe(200)
    expect(test.raw.prepare(
      'SELECT status, control_version FROM user_subscriptions WHERE id = ?',
    ).get(assigned.id)).toEqual({ status: 'revoked', control_version: 1 })
    expect(test.state.calls.filter((call) => call.path === '/configure').at(-1)?.body)
      .toMatchObject({ enabled: false, control_version: 1 })

    const restore = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/restore`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-restore-1', 1),
      body: JSON.stringify({ expected_control_version: 1 }),
    })
    expect(restore.status).toBe(200)
    expect((await json(restore)).data).toMatchObject({ status: 'active', control_version: 2 })

    await request(test, `/api/v1/admin/subscriptions/${assigned.id}/revoke`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-revoke-2', 2),
      body: JSON.stringify({ expected_control_version: 2 }),
    })
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET starts_at_ms = ?, expires_at_ms = ?
        WHERE id = ?`,
    ).run(now - 2 * DAY_MS, now - DAY_MS, assigned.id)
    const restoreExpired = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/restore`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-restore-expired', 3),
      body: JSON.stringify({ expected_control_version: 3 }),
    })
    expect(restoreExpired.status).toBe(200)
    expect((await json(restoreExpired)).data).toMatchObject({ status: 'expired', control_version: 4 })
    expect(test.state.calls.filter((call) => call.path === '/configure').at(-1)?.body)
      .toMatchObject({ enabled: false, control_version: 4 })
  })

  it('resets selected D1 counters and sends one atomic configure-reset command', async () => {
    const test = await fixture()
    const assigned = (await json(await assign(test))).data
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET daily_used_micros = 9000000, weekly_used_micros = 40000000,
              monthly_used_micros = 80000000
        WHERE id = ?`,
    ).run(assigned.id)

    const reset = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/reset-quota`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-reset-1', 0),
      body: JSON.stringify({ daily: true, weekly: false, monthly: true, expected_control_version: 0 }),
    })
    expect(reset.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros,
              quota_reset_epoch, quota_reset_generation, control_version
         FROM user_subscriptions WHERE id = ?`,
    ).get(assigned.id)).toEqual({
      daily_used_micros: 0,
      weekly_used_micros: 40_000_000,
      monthly_used_micros: 0,
      quota_reset_epoch: 1,
      quota_reset_generation: 1,
      control_version: 1,
    })
    const command = [...test.state.calls].reverse().find((call) => call.path === '/configure-reset')
    expect(command?.body).toMatchObject({
      configuration: {
        quota_reset_epoch: 1,
        quota_reset_generation: 1,
        control_version: 1,
      },
      reset: {
        schema_version: 1,
        subscription_id: assigned.id,
        control_version: 1,
        windows: { daily: expect.any(Number), weekly: null, monthly: expect.any(Number) },
      },
    })
  })

  it('keeps a zero-used activation daily anchor aligned across reset and Queue projection', async () => {
    const test = await fixture()
    const assigned = (await json(await assign(test))).data
    // Keep the activation anchor inside the current natural window. Basing it
    // on UTC midnight made this assertion depend on which minute CI started.
    const activationAnchor = now - 10 * 60_000
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET starts_at_ms = ?, expires_at_ms = ?, daily_anchor_ms = ?,
              daily_window_start_ms = ?, daily_used_micros = 0
        WHERE id = ?`,
    ).run(
      activationAnchor,
      activationAnchor + 2 * DAY_MS,
      activationAnchor,
      activationAnchor,
      assigned.id,
    )

    const reset = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/reset-quota`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-activation-reset', 0),
      body: JSON.stringify({ daily: true, weekly: false, monthly: false, expected_control_version: 0 }),
    })
    expect(reset.status, await reset.clone().text()).toBe(200)
    expect(test.raw.prepare(
      `SELECT daily_anchor_ms, daily_window_start_ms, daily_used_micros, quota_reset_epoch
         FROM user_subscriptions WHERE id = ?`,
    ).get(assigned.id)).toEqual({
      daily_anchor_ms: activationAnchor,
      daily_window_start_ms: activationAnchor,
      daily_used_micros: 0,
      quota_reset_epoch: 1,
    })
    expect([...test.state.calls].reverse().find((call) => call.path === '/configure-reset')?.body)
      .toMatchObject({
        configuration: {
          daily_anchor_ms: activationAnchor,
          daily_window_start_ms: activationAnchor,
        },
        reset: { windows: { daily: activationAnchor } },
      })

    const updatedAt = Date.now()
    await consumeEvents({
      queue: 'events',
      messages: [{
        id: 'activation-window-settlement',
        timestamp: new Date(updatedAt),
        body: {
          schema_version: 1,
          event_id: 'subscription-usage:activation-window-settlement',
          event_type: 'subscription.usage.settled.v1',
          occurred_at_ms: updatedAt,
          aggregate_type: 'subscription',
          aggregate_id: assigned.id,
          payload: {
            request_id: 'activation-window-settlement',
            subscription_id: assigned.id,
            user_id: ALICE_ID,
            group_id: GROUP_ID,
            amount_micros: 1_000_000,
            daily_window_start_ms: activationAnchor,
            weekly_window_start_ms: activationAnchor,
            monthly_window_start_ms: activationAnchor,
            quota_reset_epoch: 1,
            updated_at_ms: updatedAt,
          },
        },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      }],
    } as unknown as MessageBatch<unknown>, test.env)
    expect(test.raw.prepare(
      `SELECT daily_window_start_ms, daily_used_micros
         FROM user_subscriptions WHERE id = ?`,
    ).get(assigned.id)).toEqual({
      daily_window_start_ms: activationAnchor,
      daily_used_micros: 1_000_000,
    })
  })

  it('preserves Queue-projected usage racing entitlement-only admin mutations', async () => {
    const test = await fixture()
    const assigned = (await json(await assign(test))).data
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET daily_used_micros = 1000000, weekly_used_micros = 2000000,
              monthly_used_micros = 3000000
        WHERE id = ?`,
    ).run(assigned.id)

    let restoreDb = await projectSubscriptionUsageDuringNextBatch(
      test, assigned.id, 'race-extend', 100_000,
    )
    const extend = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/extend`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-race-extend', 0),
      body: JSON.stringify({ days: 1, expected_control_version: 0 }),
    })
    restoreDb()
    expect(extend.status).toBe(200)

    restoreDb = await projectSubscriptionUsageDuringNextBatch(
      test, assigned.id, 'race-revoke', 100_000,
    )
    const revoke = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/revoke`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-race-revoke', 1),
      body: JSON.stringify({ expected_control_version: 1 }),
    })
    restoreDb()
    expect(revoke.status).toBe(200)

    restoreDb = await projectSubscriptionUsageDuringNextBatch(
      test, assigned.id, 'race-restore', 100_000,
    )
    const restore = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/restore`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-race-restore', 2),
      body: JSON.stringify({ expected_control_version: 2 }),
    })
    restoreDb()
    expect(restore.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros,
              control_version
         FROM user_subscriptions WHERE id = ?`,
    ).get(assigned.id)).toEqual({
      daily_used_micros: 1_300_000,
      weekly_used_micros: 2_300_000,
      monthly_used_micros: 3_300_000,
      control_version: 3,
    })
  })

  it('preserves unselected Queue-projected dimensions racing a targeted quota reset', async () => {
    const test = await fixture()
    const assigned = (await json(await assign(test))).data
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET daily_used_micros = 1000000, weekly_used_micros = 2000000,
              monthly_used_micros = 3000000
        WHERE id = ?`,
    ).run(assigned.id)
    const restoreDb = await projectSubscriptionUsageDuringNextBatch(
      test, assigned.id, 'race-targeted-reset', 100_000,
    )

    const reset = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/reset-quota`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-race-reset', 0),
      body: JSON.stringify({ daily: false, weekly: true, monthly: false, expected_control_version: 0 }),
    })
    restoreDb()

    expect(reset.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT daily_used_micros, weekly_used_micros, monthly_used_micros,
              quota_reset_epoch, control_version
         FROM user_subscriptions WHERE id = ?`,
    ).get(assigned.id)).toEqual({
      daily_used_micros: 1_100_000,
      weekly_used_micros: 0,
      monthly_used_micros: 3_100_000,
      quota_reset_epoch: 0,
      control_version: 1,
    })
  })

  it('recovers a pending quota reset from the scheduled worker without another admin request', async () => {
    const test = await fixture()
    const assigned = (await json(await assign(test))).data
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET daily_used_micros = 9000000, monthly_used_micros = 80000000
        WHERE id = ?`,
    ).run(assigned.id)
    test.state.failuresByPath.set('/configure-reset', 1)

    const reset = await request(test, `/api/v1/admin/subscriptions/${assigned.id}/reset-quota`, {
      method: 'POST',
      headers: mutationHeaders(test, 'admin-subscription-scheduled-reset-recovery', 0),
      body: JSON.stringify({ daily: true, weekly: false, monthly: true, expected_control_version: 0 }),
    })
    expect(reset.status).toBe(503)
    expect(test.raw.prepare(
      'SELECT status, attempts FROM subscription_state_sync WHERE operation = \'reset_quota\'',
    ).get()).toEqual({ status: 'pending', attempts: 1 })

    const maintenanceEvents: Array<{ event_type: string; payload: { task: string } }> = []
    test.env.EVENTS_QUEUE = { send: async (event: typeof maintenanceEvents[number]) => {
      maintenanceEvents.push(structuredClone(event))
    } } as unknown as Queue
    await runScheduledRecovery(test.env)
    expect(maintenanceEvents).toHaveLength(32)
    expect(maintenanceEvents.every(event => event.event_type === 'settings.maintenance.v1')).toBe(true)
    expect(test.raw.prepare(
      "SELECT status, attempts FROM subscription_state_sync WHERE operation = 'reset_quota'",
    ).get()).toEqual({ status: 'pending', attempts: 1 })
    const maintenance = maintenanceEvents.find(event => event.payload.task === 'subscription_state')
    expect(maintenance).toBeDefined()
    expect(await consumeSettingsMaintenance(maintenance, test.env)).toBe(true)

    expect(test.raw.prepare(
      'SELECT status, attempts FROM subscription_state_sync WHERE operation = \'reset_quota\'',
    ).get()).toEqual({ status: 'applied', attempts: 1 })
    expect(test.state.calls.filter((call) => call.path === '/configure-reset')).toHaveLength(2)
    expect(test.raw.prepare(
      `SELECT daily_used_micros, monthly_used_micros
         FROM user_subscriptions WHERE id = ?`,
    ).get(assigned.id)).toEqual({ daily_used_micros: 0, monthly_used_micros: 0 })
  })
})
