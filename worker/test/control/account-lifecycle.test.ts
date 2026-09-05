import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  consumeAccountHealthProbe,
  type AccountHealthProbeEvent,
  scheduleAccountHealthLifecycle,
} from '../../src/control/account-lifecycle'
import type { Env, PlatformEvent } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { consumeEvents } from '../../src/gateway/queue'
import { credentialAad } from '../../src/gateway/repository'
import type { ProviderPlatform } from '../../src/gateway/providers'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const MASTER_KEY = 'lifecycle-master-key-material-32-bytes'
const NOW = Date.UTC(2026, 8, 5, 2, 0, 0)

class CapturingQueue {
  readonly messages: PlatformEvent[] = []
  failures = 0

  async send(body: PlatformEvent): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('queue body must not enter logs')
    }
    this.messages.push(structuredClone(body))
  }
}

class CapturingPoolNamespace {
  readonly calls: Array<{ name: string; body: any }> = []
  failures = 0

  idFromName(name: string): DurableObjectId {
    return name as unknown as DurableObjectId
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = id as unknown as string
    return {
      fetch: async (request: Request) => {
        this.calls.push({ name, body: await request.json() })
        if (this.failures > 0) {
          this.failures -= 1
          return Response.json({ error: { code: 'temporary' } }, { status: 503 })
        }
        return Response.json({ ok: true })
      },
    } as unknown as DurableObjectStub
  }
}

interface Fixture {
  raw: any
  env: Env
  queue: CapturingQueue
  pool: CapturingPoolNamespace
}

function fixture(): Fixture {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const queue = new CapturingQueue()
  const pool = new CapturingPoolNamespace()
  return {
    raw,
    queue,
    pool,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      CREDENTIALS_MASTER_KEY: MASTER_KEY,
      ASSETS: {} as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: queue as unknown as Queue<PlatformEvent>,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: pool as unknown as DurableObjectNamespace,
      AUTH_RATE_LIMIT: {} as DurableObjectNamespace,
      API_KEY_LIMIT_STATE: {} as DurableObjectNamespace,
    },
  }
}

const providers = {
  openai: {
    protocol: 'openai', auth: 'bearer', base: 'https://openai.lifecycle.test/v1', config: {},
  },
  anthropic: {
    protocol: 'anthropic', auth: 'x-api-key', base: 'https://anthropic.lifecycle.test', config: {},
  },
  gemini: {
    protocol: 'gemini', auth: 'x-goog-api-key', base: 'https://gemini.lifecycle.test', config: {},
  },
  codex: {
    protocol: 'codex', auth: 'bearer', base: 'https://codex.lifecycle.test',
    config: { account_id: 'workspace-lifecycle' },
  },
} as const

async function seedAccount(
  test: Fixture,
  platform: ProviderPlatform,
  suffix: string = platform,
  enabled = true,
): Promise<string> {
  const id = `account-${suffix}`
  const secretId = `secret-${suffix}`
  const input = providers[platform]
  const encrypted = await encryptCredential(
    { api_key: `${platform}-secret-${suffix}` },
    MASTER_KEY,
    credentialAad('test', id, secretId, 1),
  )
  test.raw.prepare(
    `INSERT INTO accounts (
       id, platform, name, credential_ref, enabled, max_concurrency,
       created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
       config_version, provider_config_json
     ) VALUES (?, ?, ?, ?, ?, 4, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    platform,
    `name-${suffix}`,
    secretId,
    enabled ? 1 : 0,
    NOW,
    NOW,
    input.protocol,
    input.base,
    input.auth,
    JSON.stringify(input.config),
  )
  test.raw.prepare(
    `INSERT INTO account_secrets (
       id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(secretId, id, encrypted.nonce_b64, encrypted.ciphertext_b64, NOW, NOW)
  return id
}

function linkResponsePool(
  test: Fixture,
  accountId: string,
  platform: ProviderPlatform = 'openai',
): void {
  const groupId = `group-${platform}`
  const modelId = `model-${platform}`
  test.raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(groupId, `lifecycle-group-${platform}`, platform, NOW, NOW)
  test.raw.prepare(
    `INSERT INTO models (
       id, platform, public_name, upstream_name, endpoint, embeddings,
       enabled, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, 'responses', 0, 1, ?, ?)`,
  ).run(modelId, platform, `public-${platform}`, `upstream-${platform}`, NOW, NOW)
  test.raw.prepare(
    `INSERT INTO group_models (
       group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 1, 1, ?, ?)`,
  ).run(groupId, modelId, NOW, NOW)
  linkExistingResponsePool(test, accountId, platform)
}

function linkExistingResponsePool(
  test: Fixture,
  accountId: string,
  platform: ProviderPlatform,
): void {
  const groupId = `group-${platform}`
  const modelId = `model-${platform}`
  test.raw.prepare(
    `INSERT INTO account_groups (
       account_id, group_id, priority, weight, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 7, 3, ?, ?)`,
  ).run(accountId, groupId, NOW, NOW)
  test.raw.prepare(
    `INSERT INTO account_models (
       account_id, model_id, chat_completions, responses, embeddings,
       created_at_ms, updated_at_ms
     ) VALUES (?, ?, 0, 1, 0, ?, ?)`,
  ).run(accountId, modelId, NOW, NOW)
}

function job(test: Fixture, accountId: string): any {
  return test.raw.prepare(
    `SELECT * FROM account_health_probes WHERE account_id = ? ORDER BY generation DESC LIMIT 1`,
  ).get(accountId)
}

function account(test: Fixture, accountId: string): any {
  return test.raw.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scheduled account health lifecycle', () => {
  it('paginates due accounts, skips disabled accounts, and does not duplicate active jobs', async () => {
    const test = fixture()
    for (let index = 0; index < 5; index += 1) {
      await seedAccount(test, 'openai', String(index))
    }
    await seedAccount(test, 'openai', 'disabled', false)

    const first = await scheduleAccountHealthLifecycle(test.env, NOW, { pageSize: 2, maxPages: 2 })
    expect(first).toEqual({ recovered: 0, claimed: 4, dispatched: 4 })
    expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM account_health_probes`).get())
      .toEqual({ total: 4 })

    const second = await scheduleAccountHealthLifecycle(test.env, NOW, { pageSize: 2, maxPages: 2 })
    expect(second).toEqual({ recovered: 0, claimed: 1, dispatched: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM account_health_probes WHERE account_id = 'account-disabled'`,
    ).get()).toEqual({ total: 0 })
    expect(new Set(test.queue.messages.map((event) => event.event_id))).toHaveLength(5)
    test.raw.close()
  })

  it('uses every provider adapter and persists success, HTTP failure, backoff, and no credentials', async () => {
    const test = fixture()
    for (const platform of Object.keys(providers) as ProviderPlatform[]) {
      await seedAccount(test, platform)
    }
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      new Response('{}', { status: String(input).includes('anthropic') ? 401 : 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await scheduleAccountHealthLifecycle(test.env, NOW)
    for (const event of test.queue.messages) {
      expect(JSON.stringify(event)).not.toContain('secret-')
      await consumeAccountHealthProbe(event as AccountHealthProbeEvent, test.env, NOW)
    }

    expect(account(test, 'account-openai')).toMatchObject({
      health_status: 'healthy', consecutive_health_failures: 0,
      next_health_probe_at_ms: NOW + 5 * 60_000, health_revision: 1,
    })
    expect(account(test, 'account-anthropic')).toMatchObject({
      health_status: 'unhealthy', consecutive_health_failures: 1,
      next_health_probe_at_ms: NOW + 60_000, health_revision: 1,
      last_health_error: 'Upstream returned HTTP 401',
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM account_health_probes WHERE status = 'completed'`,
    ).get()).toEqual({ total: 4 })
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url), headers: Object.fromEntries(new Headers((init as RequestInit).headers)),
      signal: (init as RequestInit).signal,
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://openai.lifecycle.test/v1/models',
        headers: expect.objectContaining({ authorization: 'Bearer openai-secret-openai' }),
        signal: expect.any(AbortSignal),
      }),
      expect.objectContaining({
        url: 'https://anthropic.lifecycle.test/v1/models',
        headers: expect.objectContaining({ 'x-api-key': 'anthropic-secret-anthropic' }),
      }),
      expect.objectContaining({
        url: 'https://gemini.lifecycle.test/v1beta/models',
        headers: expect.objectContaining({ 'x-goog-api-key': 'gemini-secret-gemini' }),
      }),
      expect.objectContaining({
        url: 'https://codex.lifecycle.test/backend-api/codex/models',
        headers: expect.objectContaining({
          authorization: 'Bearer codex-secret-codex',
          'chatgpt-account-id': 'workspace-lifecycle',
        }),
      }),
    ]))
    test.raw.close()
  })

  it('classifies timeouts and exponentially backs off repeated failures', async () => {
    const test = fixture()
    const accountId = await seedAccount(test, 'gemini')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    }))

    await scheduleAccountHealthLifecycle(test.env, NOW)
    await consumeAccountHealthProbe(test.queue.messages[0] as AccountHealthProbeEvent, test.env, NOW)
    expect(account(test, accountId)).toMatchObject({
      health_status: 'unhealthy', consecutive_health_failures: 1,
      last_health_error: 'Upstream probe timed out', next_health_probe_at_ms: NOW + 60_000,
    })

    const secondAt = NOW + 60_000
    await scheduleAccountHealthLifecycle(test.env, secondAt)
    await consumeAccountHealthProbe(test.queue.messages[1] as AccountHealthProbeEvent, test.env, secondAt)
    expect(account(test, accountId)).toMatchObject({
      consecutive_health_failures: 2,
      next_health_probe_at_ms: secondAt + 120_000,
    })
    test.raw.close()
  })

  it('rejects stale, disabled, and deleted tasks without fetching upstream', async () => {
    const test = fixture()
    const staleId = await seedAccount(test, 'openai', 'stale')
    const disabledId = await seedAccount(test, 'openai', 'disabled-after-claim')
    const deletedId = await seedAccount(test, 'openai', 'deleted-after-claim')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await scheduleAccountHealthLifecycle(test.env, NOW)

    test.raw.prepare(
      `UPDATE accounts SET config_version = config_version + 1 WHERE id = ?`,
    ).run(staleId)
    test.raw.prepare(`UPDATE accounts SET enabled = 0 WHERE id = ?`).run(disabledId)
    test.raw.prepare(`DELETE FROM accounts WHERE id = ?`).run(deletedId)
    for (const event of test.queue.messages) {
      await consumeAccountHealthProbe(event as AccountHealthProbeEvent, test.env, NOW)
    }

    expect(job(test, staleId)).toMatchObject({ status: 'stale' })
    expect(job(test, disabledId)).toMatchObject({ status: 'stale' })
    expect(job(test, deletedId)).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    test.raw.close()
  })

  it('acknowledges duplicate Queue deliveries after one probe and one revision update', async () => {
    const test = fixture()
    const accountId = await seedAccount(test, 'openai')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    await scheduleAccountHealthLifecycle(test.env, NOW)
    const event = test.queue.messages[0] as AccountHealthProbeEvent
    const message = {
      id: 'delivery-1', timestamp: new Date(NOW), body: event, attempts: 1,
      ack: vi.fn(), retry: vi.fn(),
    }

    await consumeEvents(
      { queue: 'events', messages: [message] } as unknown as MessageBatch<unknown>,
      test.env,
    )
    await consumeAccountHealthProbe(event, test.env, NOW)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
    expect(account(test, accountId).health_revision).toBe(1)
    expect(job(test, accountId)).toMatchObject({
      status: 'completed', processing_attempts: 1,
    })
    test.raw.close()
  })

  it('increments the D1 routing revision and synchronizes the full affected Pool snapshot', async () => {
    const test = fixture()
    const accountId = await seedAccount(test, 'openai')
    linkResponsePool(test, accountId)
    test.raw.exec(`
      UPDATE models SET image_generation = 1 WHERE id = 'model-openai';
      UPDATE account_models SET image_generation = 1
       WHERE account_id = '${accountId}' AND model_id = 'model-openai';
    `)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    const before = test.raw.prepare(
      `SELECT revision FROM gateway_config_revision WHERE singleton = 1`,
    ).get().revision

    await scheduleAccountHealthLifecycle(test.env, NOW)
    await consumeAccountHealthProbe(test.queue.messages[0] as AccountHealthProbeEvent, test.env, NOW)

    const after = test.raw.prepare(
      `SELECT revision FROM gateway_config_revision WHERE singleton = 1`,
    ).get().revision
    expect(after).toBe(before + 1)
    expect(test.pool.calls).toHaveLength(2)
    expect(test.pool.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'group:group-openai:platform:openai:model:model-openai:endpoint:responses:shard:0',
        body: expect.objectContaining({
          schema_version: 1,
          config_revision: after,
          config_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          accounts: [{ account_id: accountId, max_concurrency: 4, priority: 7, weight: 3 }],
        }),
      }),
      expect.objectContaining({
        name: 'group:group-openai:platform:openai:model:model-openai:endpoint:images:shard:0',
        body: expect.objectContaining({
          schema_version: 1,
          config_revision: after,
          accounts: [{ account_id: accountId, max_concurrency: 4, priority: 7, weight: 3 }],
        }),
      }),
    ]))
    expect(job(test, accountId)).toMatchObject({
      status: 'completed', account_health_revision: 1, pool_revision: after,
    })
    test.raw.close()
  })

  it('removes an unhealthy account from Pool and restores it after a later successful probe', async () => {
    const test = fixture()
    const accountId = await seedAccount(test, 'gemini')
    const unknownBackupId = await seedAccount(test, 'gemini', 'gemini-backup')
    linkResponsePool(test, accountId, 'gemini')
    linkExistingResponsePool(test, unknownBackupId, 'gemini')
    test.raw.prepare(
      `UPDATE accounts SET next_health_probe_at_ms = ? WHERE id = ?`,
    ).run(NOW + 24 * 60 * 60_000, unknownBackupId)
    let upstreamStatus = 503
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: upstreamStatus })))

    await scheduleAccountHealthLifecycle(test.env, NOW)
    await consumeAccountHealthProbe(test.queue.messages[0] as AccountHealthProbeEvent, test.env, NOW)
    expect(test.pool.calls[0].body.accounts).toEqual([
      { account_id: unknownBackupId, max_concurrency: 4, priority: 7, weight: 3 },
    ])
    expect(account(test, accountId)).toMatchObject({
      health_status: 'unhealthy', consecutive_health_failures: 1,
    })

    upstreamStatus = 200
    const retryAt = NOW + 60_000
    await scheduleAccountHealthLifecycle(test.env, retryAt)
    await consumeAccountHealthProbe(test.queue.messages[1] as AccountHealthProbeEvent, test.env, retryAt)
    expect(test.pool.calls[1].body.accounts).toEqual(expect.arrayContaining([
      { account_id: accountId, max_concurrency: 4, priority: 7, weight: 3 },
      { account_id: unknownBackupId, max_concurrency: 4, priority: 7, weight: 3 },
    ]))
    expect(test.pool.calls[1].body.config_revision)
      .toBeGreaterThan(test.pool.calls[0].body.config_revision)
    expect(test.pool.calls[1].name).toBe(
      'group:group-gemini:platform:openai:model:model-gemini:endpoint:responses:shard:0',
    )
    expect(account(test, accountId)).toMatchObject({
      health_status: 'healthy', consecutive_health_failures: 0,
    })
    test.raw.close()
  })

  it('persists Pool sync recovery and retries it without probing the provider again', async () => {
    const test = fixture()
    const accountId = await seedAccount(test, 'openai')
    linkResponsePool(test, accountId)
    test.pool.failures = 1
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    await scheduleAccountHealthLifecycle(test.env, NOW)
    await consumeAccountHealthProbe(test.queue.messages[0] as AccountHealthProbeEvent, test.env, NOW)
    expect(job(test, accountId)).toMatchObject({
      status: 'probed', last_internal_error: 'Pool state synchronization failed',
      next_dispatch_at_ms: NOW + 30_000,
    })

    const recoveredAt = NOW + 30_000
    const scheduled = await scheduleAccountHealthLifecycle(test.env, recoveredAt)
    expect(scheduled).toMatchObject({ dispatched: 1, claimed: 0 })
    await consumeAccountHealthProbe(test.queue.messages[1] as AccountHealthProbeEvent, test.env, recoveredAt)
    expect(job(test, accountId)).toMatchObject({ status: 'completed' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(test.pool.calls).toHaveLength(2)
    test.raw.close()
  })

  it('recovers expired consumer leases and terminates bounded retry exhaustion', async () => {
    const test = fixture()
    const accountId = await seedAccount(test, 'openai')
    await scheduleAccountHealthLifecycle(test.env, NOW)
    const current = job(test, accountId)
    test.raw.prepare(
      `UPDATE account_health_probes
          SET status = 'probing', processing_attempts = 5,
              run_token = 'abandoned', run_lease_until_ms = ?
        WHERE id = ?`,
    ).run(NOW + 1, current.id)

    const result = await scheduleAccountHealthLifecycle(test.env, NOW + 2)

    expect(result.recovered).toBe(1)
    expect(job(test, accountId)).toMatchObject({
      status: 'failed', processing_attempts: 5,
      last_internal_error: 'Probe processing attempts exhausted',
    })
    expect(account(test, accountId)).toMatchObject({
      health_probe_lease_until_ms: null,
      next_health_probe_at_ms: NOW + 2 + 5 * 60_000,
    })
    test.raw.close()
  })

  it('bounds Queue outbox dispatch retries and releases the account claim', async () => {
    const test = fixture()
    const accountId = await seedAccount(test, 'openai')
    test.queue.failures = 8

    await scheduleAccountHealthLifecycle(test.env, NOW)
    for (let attempt = 1; attempt < 8; attempt += 1) {
      const pending = job(test, accountId)
      expect(pending).toMatchObject({ status: 'queued', dispatch_attempts: attempt })
      await scheduleAccountHealthLifecycle(test.env, pending.next_dispatch_at_ms)
    }
    const exhausted = job(test, accountId)
    expect(exhausted).toMatchObject({ status: 'queued', dispatch_attempts: 8 })

    await scheduleAccountHealthLifecycle(test.env, exhausted.next_dispatch_at_ms)

    expect(job(test, accountId)).toMatchObject({
      status: 'failed', dispatch_attempts: 8,
      last_internal_error: 'Queue dispatch attempts exhausted',
    })
    expect(account(test, accountId).health_probe_lease_until_ms).toBeNull()
    expect(test.queue.messages).toHaveLength(0)
    test.raw.close()
  })
})
