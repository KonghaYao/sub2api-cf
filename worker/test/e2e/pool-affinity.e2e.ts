import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { poolStateName } from '../../src/gateway/state-client'

async function command(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
): Promise<{ lease?: { account_id?: string } }> {
  const response = await stub.fetch(new Request(`https://state.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, ...body }),
  }))
  expect(response.status, await response.clone().text()).toBe(200)
  return response.json() as Promise<{ lease?: { account_id?: string } }>
}

describe('PoolStateDO session affinity binding', () => {
  it('persists a digest-only binding, invalidates it on failure, and converges account sync', async () => {
    const stub = env.POOL_STATE.get(env.POOL_STATE.idFromName(
      poolStateName('affinity-e2e-group', 'affinity-e2e-model', 'embeddings'),
    ))
    const affinityKey = 'a'.repeat(64)
    await command(stub, '/accounts/sync', {
      config_revision: 1,
      config_fingerprint: '1'.repeat(64),
      accounts: [
        { account_id: 'account-1', max_concurrency: 2, priority: 1, weight: 1 },
        { account_id: 'account-2', max_concurrency: 2, priority: 0, weight: 1 },
      ],
    })
    const first = await command(stub, '/reserve', {
      request_id: 'request-1',
      lease_ttl_ms: 5_000,
      affinity_key: affinityKey,
      affinity_ttl_ms: 60_000,
    })
    expect(first.lease?.account_id).toBe('account-2')
    await command(stub, '/release', { request_id: 'request-1' })

    await command(stub, '/accounts/sync', {
      config_revision: 2,
      config_fingerprint: '2'.repeat(64),
      accounts: [
        { account_id: 'account-1', max_concurrency: 2, priority: 0, weight: 1 },
        { account_id: 'account-2', max_concurrency: 2, priority: 1, weight: 1 },
      ],
    })
    const sticky = await command(stub, '/reserve', {
      request_id: 'request-2',
      lease_ttl_ms: 5_000,
      affinity_key: affinityKey,
      affinity_ttl_ms: 60_000,
    })
    expect(sticky.lease?.account_id).toBe('account-2')
    await command(stub, '/failure', {
      event_id: 'failure-1',
      account_id: 'account-2',
      cooldown_ms: 0,
    })
    await command(stub, '/release', { request_id: 'request-2' })
    const fallback = await command(stub, '/reserve', {
      request_id: 'request-3',
      lease_ttl_ms: 5_000,
      affinity_key: affinityKey,
      affinity_ttl_ms: 60_000,
    })
    expect(fallback.lease?.account_id).toBe('account-1')
    await command(stub, '/release', { request_id: 'request-3' })

    await command(stub, '/accounts/sync', {
      config_revision: 3,
      config_fingerprint: '3'.repeat(64),
      accounts: [
        { account_id: 'account-2', max_concurrency: 2, priority: 0, weight: 1 },
      ],
    })
    const rebound = await command(stub, '/reserve', {
      request_id: 'request-4',
      lease_ttl_ms: 5_000,
      affinity_key: affinityKey,
      affinity_ttl_ms: 60_000,
    })
    expect(rebound.lease?.account_id).toBe('account-2')
  })
})
