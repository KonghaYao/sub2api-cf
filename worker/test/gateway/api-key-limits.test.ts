import { describe, expect, it } from 'vitest'

import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { authenticateGatewayRequest } from '../../src/gateway/repository'
import {
  acquireApiKeyAdmission,
  cancelApiKeyMonetaryReservation,
  prepareApiKeyMonetaryReservation,
  projectApiKeyMonetaryUsage,
  releaseApiKeyAdmission,
  renewApiKeyAdmission,
  settleApiKeyMonetaryReservation,
} from '../../src/gateway/state-client'
import type { GatewayPrincipal } from '../../src/gateway/types'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const pepper = 'p'.repeat(32)

describe('gateway API key limit projection', () => {
  it('migrates the original user/group limits and resolves the effective group override', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 22').get()).toEqual({
      name: 'api_key_limits',
    })

    const rawKey = 'sk-customer-limit-test'
    const digest = await apiKeyDigest(rawKey, pepper)
    raw.prepare(`
      INSERT INTO users (
        id, email, status, balance_micros, concurrency, rpm_limit, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'active', 1000000, 3, 10, 1, 1)
    `).run('user-1', 'limit@example.com')
    raw.prepare(`
      INSERT INTO "groups" (
        id, name, platform, enabled, rpm_limit, created_at_ms, updated_at_ms
      ) VALUES ('group-1', 'limited', 'openai', 1, 4, 1, 1)
    `).run()
    raw.prepare(`
      INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
      VALUES ('user-1', 'group-1', 1)
    `).run()
    raw.prepare(`
      INSERT INTO user_group_rpm_overrides (
        user_id, group_id, rpm_override, control_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'group-1', 2, 0, 1, 1)
    `).run()
    raw.prepare(`
      INSERT INTO api_keys (
        id, user_id, key_hash, name, enabled, group_id, key_prefix,
        created_at_ms, updated_at_ms
      ) VALUES ('key-1', 'user-1', ?, 'limited', 1, 'group-1', 'sk-customer', 1, 1)
    `).run(digest)

    const principal = await authenticateGatewayRequest(new Request('https://gateway.test/v1/models', {
      headers: { authorization: `Bearer ${rawKey}` },
    }), { DB: d1, API_KEY_PEPPER: pepper } as Env)

    expect(principal).toMatchObject({
      api_key_id: 'key-1',
      user_id: 'user-1',
      group_id: 'group-1',
      concurrency_limit: 3,
      user_rpm_limit: 10,
      group_rpm_limit: 2,
      api_key_monetary: {
        control_version: 0,
        quota_micros: 0,
        quota_used_micros: 0,
        quota_reset_epoch: 0,
        rate_limit_reset_epoch: 0,
      },
    })

    raw.prepare("UPDATE \"groups\" SET platform = 'composite' WHERE id = 'group-1'").run()
    await expect(authenticateGatewayRequest(new Request('https://gateway.test/v1/models', {
      headers: { authorization: `Bearer ${rawKey}` },
    }), { DB: d1, API_KEY_PEPPER: pepper } as Env)).resolves.toMatchObject({
      group_id: 'group-1', platform: 'composite', platform_quota: null,
    })
    raw.close()
  })
})

class AdmissionStub {
  readonly requests: Array<{ path: string; body: Record<string, unknown> }> = []
  fail = false

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const body = await request.json() as Record<string, unknown>
    this.requests.push({ path, body })
    if (this.fail) throw new Error('DO unavailable')
    if (path === '/admit') {
      return Response.json({ admitted: true, lease: { request_id: body.request_id, status: 'active' } })
    }
    if (path === '/monetary/settle') {
      return Response.json({
        usage: {
          api_key_id: body.api_key_id,
          quota_reset_epoch: 2,
          rate_limit_reset_epoch: 3,
          total_settled_micros: 40,
          active_reserved_micros: 0,
          windows: [
            { api_key_id: body.api_key_id, kind: '5h', window_started_at_ms: 100, settled_micros: 40, updated_at_ms: 200 },
            { api_key_id: body.api_key_id, kind: '1d', window_started_at_ms: 100, settled_micros: 40, updated_at_ms: 200 },
            { api_key_id: body.api_key_id, kind: '7d', window_started_at_ms: 100, settled_micros: 40, updated_at_ms: 200 },
          ],
        },
      })
    }
    return Response.json({})
  }
}

function limitedPrincipal(overrides: Partial<GatewayPrincipal> = {}): GatewayPrincipal {
  return {
    api_key_id: 'key-1',
    api_key_auth_version: 1,
    user_id: 'user-1',
    group_id: 'group-1',
    platform: 'openai',
    balance_micros: 1_000_000,
    user_state_version: 0,
    limit_config_version: 1,
    concurrency_limit: 3,
    user_rpm_limit: 10,
    group_rpm_limit: 2,
    api_key_monetary: {
      control_version: 4,
      quota_micros: 1_000,
      quota_used_micros: 20,
      rate_limit_5h_micros: 100,
      rate_limit_1d_micros: 200,
      rate_limit_7d_micros: 300,
      usage_5h_micros: 10,
      usage_1d_micros: 10,
      usage_7d_micros: 10,
      window_5h_start_ms: 100,
      window_1d_start_ms: 100,
      window_7d_start_ms: 100,
      quota_reset_epoch: 2,
      rate_limit_reset_epoch: 3,
    },
    billing: { type: 'balance' },
    ...overrides,
  }
}

function admissionEnv(stub: AdmissionStub | null): { env: Env; names: string[] } {
  const names: string[] = []
  return {
    env: {
      API_KEY_LIMIT_STATE: stub === null ? undefined : {
        idFromName(name: string) {
          names.push(name)
          return name as unknown as DurableObjectId
        },
        get() {
          return stub as unknown as DurableObjectStub
        },
      } as unknown as DurableObjectNamespace,
    } as Env,
    names,
  }
}

describe('gateway API key admission client', () => {
  it('projects effective limits to the user-partitioned DO and renews/releases the lease', async () => {
    const stub = new AdmissionStub()
    const { env, names } = admissionEnv(stub)
    const lease = await acquireApiKeyAdmission(env, limitedPrincipal(), 'request-1')
    await renewApiKeyAdmission(lease, 1)
    await releaseApiKeyAdmission(lease)

    expect(names).toEqual(['user:user-1'])
    expect(stub.requests).toEqual([
      {
        path: '/admit',
        body: {
          schema_version: 1,
          request_id: 'request-1',
          api_key_id: 'key-1',
          group_id: 'group-1',
          concurrency_limit: 3,
          user_rpm_limit: 10,
          group_rpm_limit: 2,
          lease_ttl_ms: 60_000,
        },
      },
      {
        path: '/renew',
        body: {
          schema_version: 1,
          request_id: 'request-1',
          renewal_sequence: 1,
          lease_ttl_ms: 60_000,
        },
      },
      {
        path: '/release',
        body: { schema_version: 1, request_id: 'request-1' },
      },
    ])
  })

  it('fails closed when the binding is absent or the Durable Object is unavailable', async () => {
    await expect(acquireApiKeyAdmission(
      admissionEnv(null).env,
      limitedPrincipal(),
      'request-missing',
    )).rejects.toMatchObject({ status: 503, code: 'api_key_limits_unavailable' })

    const stub = new AdmissionStub()
    stub.fail = true
    await expect(acquireApiKeyAdmission(
      admissionEnv(stub).env,
      limitedPrincipal(),
      'request-failed',
    )).rejects.toMatchObject({ status: 503, code: 'api_key_limits_unavailable' })
  })
})

describe('gateway API key monetary client', () => {
  it('configures, reserves, settles, projects, and cancels using one user-sharded authority', async () => {
    const stub = new AdmissionStub()
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id, email, status, balance_micros, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'money@example.com', 'active', 1000, 1, 1);
      INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
      VALUES ('group-1', 'default', 'openai', 1, 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, enabled, group_id, key_prefix,
        quota_reset_epoch, rate_limit_reset_epoch, created_at_ms, updated_at_ms
      ) VALUES ('key-1', 'user-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'key', 1, 'group-1', 'prefix', 2, 3, 1, 1);
    `)
    const { env, names } = admissionEnv(stub)
    env.DB = d1
    const principal = limitedPrincipal()

    await prepareApiKeyMonetaryReservation(env, principal, 'request-money', 80)
    const usage = await settleApiKeyMonetaryReservation(
      env,
      principal,
      'request-money',
      40,
    )
    await projectApiKeyMonetaryUsage(env, usage)
    await cancelApiKeyMonetaryReservation(env, principal, 'request-cancel')

    expect(names).toEqual(['user:user-1', 'user:user-1', 'user:user-1'])
    expect(stub.requests.slice(0, 2)).toEqual([
      expect.objectContaining({
        path: '/monetary/configure',
        body: expect.objectContaining({
          api_key_id: 'key-1',
          control_version: 4,
          total_limit_micros: 1_000,
          quota_reset_epoch: 2,
          rate_limit_reset_epoch: 3,
        }),
      }),
      expect.objectContaining({
        path: '/monetary/reserve',
        body: expect.objectContaining({ request_id: 'request-money', amount_micros: 80 }),
      }),
    ])
    expect(raw.prepare(`
      SELECT quota_used_micros, usage_5h_micros, usage_1d_micros, usage_7d_micros,
             window_5h_start_ms, quota_reset_epoch, rate_limit_reset_epoch
        FROM api_keys WHERE id = 'key-1'
    `).get()).toEqual({
      quota_used_micros: 40,
      usage_5h_micros: 40,
      usage_1d_micros: 40,
      usage_7d_micros: 40,
      window_5h_start_ms: 100,
      quota_reset_epoch: 2,
      rate_limit_reset_epoch: 3,
    })
    raw.close()
  })

  it('rejects old epochs, keeps same-window usage monotonic, and advances a rolling-window boundary', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id, email, status, balance_micros, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'projection@example.com', 'active', 1000, 1, 1);
      INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
      VALUES ('group-1', 'default', 'openai', 1, 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, enabled, group_id, key_prefix,
        quota_used_micros, usage_5h_micros, usage_1d_micros, usage_7d_micros,
        window_5h_start_ms, window_1d_start_ms, window_7d_start_ms,
        quota_reset_epoch, rate_limit_reset_epoch, created_at_ms, updated_at_ms
      ) VALUES (
        'key-1', 'user-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'key', 1, 'group-1', 'prefix',
        60, 60, 60, 60, 100, 100, 100, 5, 7, 1, 1
      );
    `)
    const snapshot = {
      api_key_id: 'key-1',
      quota_reset_epoch: 4,
      rate_limit_reset_epoch: 6,
      total_settled_micros: 999,
      active_reserved_micros: 0,
      windows: (['5h', '1d', '7d'] as const).map((kind) => ({
        api_key_id: 'key-1', kind, window_started_at_ms: 100,
        settled_micros: 999, updated_at_ms: 200,
      })) as any,
    }
    await projectApiKeyMonetaryUsage({ DB: d1 } as Env, snapshot)
    await projectApiKeyMonetaryUsage({ DB: d1 } as Env, {
      ...snapshot,
      quota_reset_epoch: 5,
      rate_limit_reset_epoch: 7,
      total_settled_micros: 40,
      windows: snapshot.windows.map((window: any) => ({ ...window, settled_micros: 40 })) as any,
    })
    await projectApiKeyMonetaryUsage({ DB: d1 } as Env, {
      ...snapshot,
      quota_reset_epoch: 5,
      rate_limit_reset_epoch: 7,
      total_settled_micros: 70,
      windows: snapshot.windows.map((window: any) => ({
        ...window,
        window_started_at_ms: 200,
        settled_micros: 5,
      })) as any,
    })
    await projectApiKeyMonetaryUsage({ DB: d1 } as Env, {
      ...snapshot,
      quota_reset_epoch: 5,
      rate_limit_reset_epoch: 7,
      total_settled_micros: 65,
      windows: snapshot.windows.map((window: any) => ({ ...window, settled_micros: 99 })) as any,
    })
    expect(raw.prepare(`
      SELECT quota_used_micros, usage_5h_micros, window_5h_start_ms
        FROM api_keys WHERE id = 'key-1'
    `).get()).toEqual({ quota_used_micros: 70, usage_5h_micros: 5, window_5h_start_ms: 200 })
    raw.close()
  })
})
