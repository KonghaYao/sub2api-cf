import { describe, expect, it } from 'vitest'

import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { authenticateGatewayRequest } from '../../src/gateway/repository'
import {
  acquireApiKeyAdmission,
  releaseApiKeyAdmission,
  renewApiKeyAdmission,
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
