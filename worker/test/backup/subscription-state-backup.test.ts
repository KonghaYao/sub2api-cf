// Node SQLite backs only this Durable Object contract fixture.
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { mkdtemp, rm } from 'node:fs/promises'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { tmpdir } from 'node:os'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createRemoteBackupPlan } from '../../scripts/backup-restore-remote.mjs'
import { createSubscriptionStateBackupRemoteAdapter } from '../../scripts/backup-restore-remote-user-state.mjs'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { SubscriptionStateDO } from '../../src/state/subscription-state-do'

class SqliteDurableObjectStorage {
  private alarm: number | null = null
  constructor(readonly database = new DatabaseSync(':memory:')) {}

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]): object[] => {
      const statement = this.database.prepare(query)
      return statement.all(...bindings) as object[]
    },
  }

  transactionSync<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async getAlarm(): Promise<number | null> { return this.alarm }
  async setAlarm(timestamp: number | Date): Promise<void> {
    this.alarm = timestamp instanceof Date ? timestamp.valueOf() : timestamp
  }
  async deleteAlarm(): Promise<void> { this.alarm = null }
}

function createObject(): SubscriptionStateDO {
  const storage = new SqliteDurableObjectStorage()
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
  } as unknown as DurableObjectState
  const env = {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({
        subscription_id: 'subscription-1', group_enabled: 1, platform: 'openai',
      }) }) }),
    } as unknown as D1Database,
    EVENTS_QUEUE: { send: async () => undefined } as unknown as Queue,
  } as Env
  return new SubscriptionStateDO(state, env)
}

function backupRequest(
  object: SubscriptionStateDO,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('x-sub2api-backup-environment', 'staging')
  headers.set('x-sub2api-backup-namespace', 'SUBSCRIPTION_STATE')
  headers.set('x-sub2api-backup-object-id', 'subscription-1')
  return object.fetch(new Request(`https://subscription-state.test${path}`, { ...init, headers }))
}

function post(object: SubscriptionStateDO, path: string, body: Record<string, unknown>): Promise<Response> {
  return object.fetch(new Request(`https://subscription-state.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function configuration(): Record<string, unknown> {
  const startsAt = Date.now() - 86_400_000
  return {
    schema_version: 1,
    subscription_id: 'subscription-1',
    user_id: 'user-1',
    group_id: 'group-1',
    starts_at_ms: startsAt,
    expires_at_ms: startsAt + 31 * 86_400_000,
    daily_quota_micros: 100,
    weekly_quota_micros: 1_000,
    monthly_quota_micros: 10_000,
    daily_used_micros: 1,
    weekly_used_micros: 2,
    monthly_used_micros: 3,
    daily_anchor_ms: 0,
    daily_window_start_ms: null,
    weekly_window_start_ms: null,
    monthly_window_start_ms: null,
    control_version: 0,
    quota_reset_epoch: 0,
    quota_reset_generation: 0,
  }
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function artifactWithResignedRow(
  artifact: string,
  row: { type: 'row'; table: string; rowid: number; values: unknown[] },
): Promise<string> {
  const records = artifact.trimEnd().split('\n').map((line) => JSON.parse(line))
  const header = records[0]
  const trailer = records.at(-1)
  records.splice(records.length - 1, 0, row)
  const rows = records.slice(1, -1)
  header.row_count = rows.length
  const table = header.tables.find((candidate: { name: string }) => candidate.name === row.table)
  table.row_count += 1
  header.inventory_digest = await sha256(JSON.stringify({
    schema_digest: header.schema_digest,
    tables: header.tables,
  }))
  header.state_digest = await sha256(rows.map((candidate: unknown) => JSON.stringify(candidate)).join('\n'))
  trailer.row_count = rows.length
  trailer.inventory_digest = header.inventory_digest
  trailer.state_digest = header.state_digest
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

describe('SubscriptionStateDO privileged backup contract', () => {
  it('round-trips a configured subscription through canonical NDJSON', async () => {
    const source = createObject()
    expect((await post(source, '/configure', configuration())).status).toBe(200)
    const sourceSnapshot = await (await source.fetch(new Request('https://subscription-state.test/snapshot'))).json()

    const exported = await backupRequest(source, '/backup/export', { method: 'POST' })
    expect(exported.status).toBe(200)
    const artifact = await exported.text()
    const records = artifact.trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({
      schema: 'sub2api-subscription-state-backup', version: 1,
      environment: 'staging', namespace: 'SUBSCRIPTION_STATE', object_id: 'subscription-1',
    })
    expect(new Set(records.filter((record) => record.type === 'row').map((record) => record.table)))
      .toEqual(new Set([
        'subscription_profile', 'subscription_term_windows',
        'subscription_schema_migrations',
      ]))

    const root = await mkdtemp(join(tmpdir(), 'sub2api-subscription-state-contract-'))
    try {
      const plan = createRemoteBackupPlan({
        environment: 'staging', accountId: 'a'.repeat(32),
        workingDirectory: root, bundleDirectory: join(root, 'bundle'),
        durableObjects: [{
          namespace: 'SUBSCRIPTION_STATE', objectId: 'subscription-1',
          logicalName: 'subscription-1.ndjson',
        }],
      })
      const step = plan.steps[1]
      const adapter = createSubscriptionStateBackupRemoteAdapter({
        environment: 'staging',
        origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
        token: 't'.repeat(32),
        fetcher: async (remoteRequest) => new URL(remoteRequest.url).pathname.endsWith('/export')
          ? new Response(artifact, { headers: { 'content-type': 'application/x-ndjson' } })
          : Response.json({
              schema: 'sub2api-subscription-state-backup', version: 1,
              environment: 'staging', namespace: 'SUBSCRIPTION_STATE', object_id: 'subscription-1',
              inventory_digest: records[0].inventory_digest, state_digest: records[0].state_digest,
            }),
      })
      expect(adapter.supports(step)).toBe(true)
      await expect(adapter.execute(step)).resolves.toMatchObject({ status: 'completed' })
      await expect(adapter.verify(step)).resolves.toMatchObject({
        remote_inventory_digest: records[0].inventory_digest,
        remote_state_digest: records[0].state_digest,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const target = createObject()
    await expect((await backupRequest(target, '/backup/verify')).json())
      .resolves.toMatchObject({ logical_empty: true })
    const restored = await backupRequest(target, '/backup/restore', {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: artifact,
    })
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({
      restored: true, idempotent: false,
      inventory_digest: records[0].inventory_digest,
      state_digest: records[0].state_digest,
    })
    await expect((await target.fetch(new Request('https://subscription-state.test/snapshot'))).json())
      .resolves.toMatchObject(sourceSnapshot as Record<string, unknown>)

    const replay = await backupRequest(target, '/backup/restore', {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: artifact,
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })
    expect((await post(target, '/configure', {
      ...configuration(), control_version: 1, daily_quota_micros: 200,
    })).status).toBe(200)
    const conflict = await backupRequest(target, '/backup/restore', {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: artifact,
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'backup_restore_conflict' } })
  })

  it.each([
    ['truncated', (records: any[], artifact: string) => artifact.slice(0, -1)],
    ['non-canonical line', (_records: any[], artifact: string) => artifact.replace('{"type"', '{ "type"')],
    ['bad digest', (records: any[]) => {
      records[0].state_digest = '0'.repeat(64)
      return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    }],
    ['duplicate row', (records: any[]) => {
      records.splice(records.length - 1, 0, structuredClone(records[1]))
      return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    }],
  ])('rejects a %s artifact without changing an empty target', async (_case, mutate) => {
    const source = createObject()
    await post(source, '/configure', configuration())
    const artifact = await (await backupRequest(source, '/backup/export', { method: 'POST' })).text()
    const records = artifact.trimEnd().split('\n').map((line) => JSON.parse(line))
    const target = createObject()
    const response = await backupRequest(target, '/backup/restore', {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
      body: mutate(records, artifact),
    })
    expect(response.status).toBe(400)
    await expect((await backupRequest(target, '/backup/verify')).json())
      .resolves.toMatchObject({ logical_empty: true })
  })

  it.each([
    ['outbox', {
      type: 'row' as const,
      table: 'subscription_outbox',
      rowid: 1,
      values: ['usage:request-1', 'usage:request-1', '{', 0, 1, null, 1],
    }],
    ['mutation', {
      type: 'row' as const,
      table: 'subscription_mutations',
      rowid: 1,
      values: ['reset-1', 'reset_quota', '{', 0, 1],
    }],
  ])('atomically rejects a digest-valid %s row with malformed payload JSON', async (_case, row) => {
    const source = createObject()
    await post(source, '/configure', configuration())
    const exported = await backupRequest(source, '/backup/export', { method: 'POST' })
    const artifact = await artifactWithResignedRow(await exported.text(), row)
    const target = createObject()

    const response = await backupRequest(target, '/backup/restore', {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: artifact,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_backup_artifact' } })
    await expect((await backupRequest(target, '/backup/verify')).json())
      .resolves.toMatchObject({ logical_empty: true })
  })

  it.each([
    ['outbox event identity', {
      type: 'row' as const,
      table: 'subscription_outbox',
      rowid: 1,
      values: [
        'usage:request-1',
        'usage:request-1',
        JSON.stringify({
          schema_version: 1,
          event_id: 'usage:another-request',
          event_type: 'usage.settled.v1',
          occurred_at_ms: 1,
          aggregate_type: 'user',
          aggregate_id: 'user-1',
          payload: { request_id: 'request-1' },
        }),
        0, 1, null, 1,
      ],
    }],
    ['outbox dedupe identity', {
      type: 'row' as const,
      table: 'subscription_outbox',
      rowid: 1,
      values: [
        'usage:request-1',
        'usage:another-request',
        JSON.stringify({
          schema_version: 1,
          event_id: 'usage:request-1',
          event_type: 'usage.settled.v1',
          occurred_at_ms: 1,
          aggregate_type: 'user',
          aggregate_id: 'user-1',
          payload: { request_id: 'request-1' },
        }),
        0, 1, null, 1,
      ],
    }],
    ['mutation payload identity', {
      type: 'row' as const,
      table: 'subscription_mutations',
      rowid: 1,
      values: [
        'reset-1',
        'reset_quota',
        JSON.stringify({
          subscription_id: 'another-subscription',
          control_version: 1,
          windows: { daily: 1, weekly: null, monthly: null },
        }),
        0,
        1,
      ],
    }],
  ])('atomically rejects a digest-valid row with mismatched %s', async (_case, row) => {
    const source = createObject()
    await post(source, '/configure', configuration())
    const exported = await backupRequest(source, '/backup/export', { method: 'POST' })
    const artifact = await artifactWithResignedRow(await exported.text(), row)
    const target = createObject()

    const response = await backupRequest(target, '/backup/restore', {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: artifact,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_backup_artifact' } })
    await expect((await backupRequest(target, '/backup/verify')).json())
      .resolves.toMatchObject({ logical_empty: true })
  })

  it('restores outbox and mutation payloads produced through the state API', async () => {
    const source = createObject()
    const initial = configuration()
    expect((await post(source, '/configure', initial)).status).toBe(200)
    expect((await post(source, '/configure-reset', {
      configuration: {
        ...initial,
        control_version: 1,
        quota_reset_epoch: 1,
        quota_reset_generation: 1,
      },
      reset: {
        schema_version: 1,
        mutation_id: 'reset-1',
        subscription_id: 'subscription-1',
        control_version: 1,
        windows: { daily: initial.starts_at_ms, weekly: null, monthly: null },
      },
    })).status).toBe(200)
    expect((await post(source, '/authorize', {
      schema_version: 1,
      request_id: 'request-1',
      subscription_id: 'subscription-1',
      user_id: 'user-1',
      group_id: 'group-1',
      api_key_id: 'key-1',
      api_key_auth_version: 1,
    })).status).toBe(200)
    expect((await post(source, '/reserve', {
      schema_version: 1,
      request_id: 'request-1',
      amount_micros: 1,
      reservation_ttl_ms: 60_000,
    })).status).toBe(200)
    expect((await post(source, '/settle', {
      schema_version: 1,
      request_id: 'request-1',
      amount_micros: 1,
      usage_event: {
        schema_version: 1,
        event_id: 'usage:request-1',
        event_type: 'usage.settled.v1',
        occurred_at_ms: 1,
        aggregate_type: 'user',
        aggregate_id: 'user-1',
        payload: {
          request_id: 'request-1',
          user_id: 'user-1',
          group_id: 'group-1',
          billing_type: 'subscription',
          subscription_id: 'subscription-1',
          amount_micros: 1,
        },
      },
    })).status).toBe(200)
    const artifact = await (await backupRequest(source, '/backup/export', { method: 'POST' })).text()
    const target = createObject()

    const restored = await backupRequest(target, '/backup/restore', {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: artifact,
    })

    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({ restored: true, idempotent: false })
  })

  it('allows the protected Worker route to reach only SUBSCRIPTION_STATE', async () => {
    const forwarded: Request[] = []
    const namespace = {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ fetch: async (request: Request) => {
        forwarded.push(request)
        return Response.json({ logical_empty: true })
      } }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace
    const env = {
      APP_VERSION: 'test', ENVIRONMENT: 'staging', BACKUP_OPERATOR_TOKEN: 's'.repeat(32),
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: {} as D1Database, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: namespace, POOL_STATE: {} as DurableObjectNamespace,
    } as Env
    const response = await createApp().request(
      '/internal/backup/durable-objects/SUBSCRIPTION_STATE/subscription-1/verify',
      { headers: {
        authorization: `Bearer ${'s'.repeat(32)}`,
        'x-sub2api-backup-environment': 'staging',
      } },
      env,
    )

    expect(response.status).toBe(200)
    expect(forwarded).toHaveLength(1)
    expect(new URL(forwarded[0].url).pathname).toBe('/backup/verify')
    expect(forwarded[0].headers.get('x-sub2api-backup-namespace')).toBe('SUBSCRIPTION_STATE')
  })
})
