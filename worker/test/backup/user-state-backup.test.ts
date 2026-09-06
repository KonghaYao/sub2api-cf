// Node's SQLite binding is used only by this Node-hosted contract test.
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
import { createUserStateBackupRemoteAdapter } from '../../scripts/backup-restore-remote-user-state.mjs'
import { createApp } from '../../src/app'
import { USER_STATE_BACKUP_V1_SCHEMA } from '../../src/backup/user-state-backup-schema.mjs'
import type { Env } from '../../src/env'
import { UserStateDO } from '../../src/state/user-state-do'

class SqliteDurableObjectStorage {
  private alarm: number | null = null

  constructor(readonly database = new DatabaseSync(':memory:')) {}

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]): object[] => {
      const normalized = query.trimStart()
      if (bindings.length > 0 || /^(?:SELECT|PRAGMA|WITH)\b/i.test(normalized)) {
        return this.database.prepare(query).all(...bindings) as object[]
      }
      this.database.exec(query)
      return []
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

function createObject(env?: Env): { object: UserStateDO; storage: SqliteDurableObjectStorage } {
  const storage = new SqliteDurableObjectStorage()
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
  } as unknown as DurableObjectState
  return { object: new UserStateDO(state, env), storage }
}

function request(
  object: UserStateDO,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('x-sub2api-backup-environment', 'staging')
  headers.set('x-sub2api-backup-namespace', 'USER_STATE')
  headers.set('x-sub2api-backup-object-id', 'user-1')
  return object.fetch(new Request(`https://user-state.test${path}`, { ...init, headers }))
}

async function postJson(
  object: UserStateDO,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return request(object, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function rebuildArtifact(records: any[]): Promise<string> {
  const header = records[0]
  const rows = records.filter((record) => record.type === 'row')
  header.row_count = rows.length
  for (const table of header.tables) {
    table.row_count = rows.filter((row) => row.table === table.name).length
  }
  header.inventory_digest = await sha256(JSON.stringify({
    schema_digest: header.schema_digest,
    tables: header.tables,
  }))
  header.state_digest = await sha256(rows.map((row) => JSON.stringify(row)).join('\n'))
  const trailer = records.at(-1)
  trailer.row_count = rows.length
  trailer.inventory_digest = header.inventory_digest
  trailer.state_digest = header.state_digest
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

describe('UserStateDO privileged backup contract', () => {
  it('stops reading an oversized streaming restore body before buffering the whole request', async () => {
    const target = createObject()
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(256 * 1024).fill(0x20))
        if (pulls >= 40) controller.close()
      },
      cancel() { cancelled = true },
    })
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }

    const response = await request(target.object, '/backup/restore', init)

    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(25)
  })

  it('produces a real export accepted by the Node USER_STATE v1 adapter', async () => {
    const source = createObject()
    await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-adapter-contract',
      user_id: 'user-1',
      balance_micros: 1_000,
      enabled: true,
    })
    const artifact = await (await request(source.object, '/backup/export', { method: 'POST' })).text()
    const header = JSON.parse(artifact.split('\n')[0])
    const root = await mkdtemp(join(tmpdir(), 'sub2api-user-state-contract-'))
    try {
      const plan = createRemoteBackupPlan({
        environment: 'staging', accountId: 'a'.repeat(32),
        workingDirectory: root, bundleDirectory: join(root, 'bundle'),
        durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
      })
      const step = plan.steps[1]
      const adapter = createUserStateBackupRemoteAdapter({
        environment: 'staging',
        origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
        token: 't'.repeat(32),
        fetcher: async (remoteRequest) => {
          if (new URL(remoteRequest.url).pathname.endsWith('/export')) {
            return new Response(artifact, { headers: { 'content-type': 'application/x-ndjson' } })
          }
          return Response.json({
            schema: 'sub2api-user-state-backup', version: 1,
            environment: 'staging', namespace: 'USER_STATE', object_id: 'user-1',
            inventory_digest: header.inventory_digest, state_digest: header.state_digest,
          })
        },
      })

      await expect(adapter.execute(step)).resolves.toMatchObject({ status: 'completed' })
      await expect(adapter.verify(step)).resolves.toMatchObject({
        remote_inventory_digest: header.inventory_digest,
        remote_state_digest: header.state_digest,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never exports an artifact larger than the restore and adapter byte limit', async () => {
    const source = createObject()
    expect((await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-bounded-export',
      user_id: 'user-1',
      balance_micros: 10_000,
      enabled: true,
    })).status).toBe(200)
    for (let index = 0; index < 7_000; index += 1) {
      expect((await postJson(source.object, '/balance/adjust', {
        schema_version: 1,
        mutation_id: `large-${index}-${'x'.repeat(100)}`,
        amount_delta_micros: 1,
      })).status).toBe(200)
    }
    const withinLimit = await request(source.object, '/backup/export', { method: 'POST' })
    expect(withinLimit.status).toBe(200)
    const lastArtifact = await withinLimit.text()
    expect(new TextEncoder().encode(lastArtifact).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)

    for (let index = 7_000; index < 12_000; index += 1) {
      expect((await postJson(source.object, '/balance/adjust', {
        schema_version: 1,
        mutation_id: `large-${index}-${'x'.repeat(100)}`,
        amount_delta_micros: 1,
      })).status).toBe(200)
    }
    expect((await request(source.object, '/backup/export', { method: 'POST' })).status).toBe(413)

    const target = createObject()
    expect((await request(target.object, '/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: lastArtifact,
    })).status).toBe(200)
  })

  it('round-trips the complete financial state through canonical NDJSON', async () => {
    const source = createObject()
    expect((await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-1',
      user_id: 'user-1',
      balance_micros: 1_000,
      spend_debt_micros: 100,
      enabled: true,
    })).status).toBe(200)
    expect((await postJson(source.object, '/balance/adjust', {
      schema_version: 1,
      mutation_id: 'admin-balance:credit-1',
      amount_delta_micros: 250,
    })).status).toBe(200)

    const exported = await request(source.object, '/backup/export', { method: 'POST' })
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toContain('application/x-ndjson')
    const artifact = await exported.text()
    const lines = artifact.trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({
      type: 'header',
      schema: 'sub2api-user-state-backup',
      version: 1,
      environment: 'staging',
      namespace: 'USER_STATE',
      object_id: 'user-1',
      row_count: 4,
    })
    expect(lines[0].schema_contract).toEqual(USER_STATE_BACKUP_V1_SCHEMA)
    expect(lines.filter((line) => line.type === 'row').map((line) => line.table)).toEqual([
      'user_profile',
      'user_state_metadata',
      'user_ledger',
      'user_ledger',
    ])
    expect(lines.at(-1)).toMatchObject({
      type: 'trailer',
      row_count: 4,
      inventory_digest: lines[0].inventory_digest,
      state_digest: lines[0].state_digest,
    })

    const target = createObject()
    const empty = await request(target.object, '/backup/verify')
    expect(empty.status).toBe(200)
    await expect(empty.json()).resolves.toMatchObject({ logical_empty: true, row_count: 1 })
    await target.storage.setAlarm(123)

    const restored = await request(target.object, '/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: artifact,
    })
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({
      restored: true,
      idempotent: false,
      state_digest: lines[0].state_digest,
    })
    await expect(target.storage.getAlarm()).resolves.toBeNull()

    const snapshot = await request(target.object, '/snapshot')
    await expect(snapshot.json()).resolves.toMatchObject({
      state_version: 1,
      profile: {
        user_id: 'user-1',
        balance_micros: 1_150,
        spend_debt_micros: 0,
      },
      ledger: expect.arrayContaining([
        expect.objectContaining({ mutation_id: 'admin-balance:credit-1', balance_after_micros: 1_150 }),
        expect.objectContaining({ mutation_id: 'opening-1', balance_after_micros: 1_000 }),
      ]),
    })

    const readback = await request(target.object, '/backup/export', { method: 'POST' })
    const readbackHeader = JSON.parse((await readback.text()).split('\n')[0])
    expect(readbackHeader).toMatchObject({
      inventory_digest: lines[0].inventory_digest,
      state_digest: lines[0].state_digest,
      row_count: 4,
    })
  })

  it('rejects a digest-valid row that violates the target schema without logging its body', async () => {
    const source = createObject()
    await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-sensitive-value',
      user_id: 'user-1',
      balance_micros: 1_000,
      enabled: true,
    })
    const exported = await request(source.object, '/backup/export', { method: 'POST' })
    const records = (await exported.text()).trimEnd().split('\n').map((line) => JSON.parse(line))
    const profile = records.find((record) => record.type === 'row' && record.table === 'user_profile')
    profile.values[3] = -1
    const rowRecords = records.filter((record) => record.type === 'row')
    const canonicalRows = rowRecords.map((record) => JSON.stringify(record)).join('\n')
    const stateDigest = await sha256(canonicalRows)
    records[0].state_digest = stateDigest
    records.at(-1).state_digest = stateDigest
    const artifact = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

    const target = createObject()
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...values: unknown[]) => { logged.push(values) }
    try {
      const response = await request(target.object, '/backup/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body: artifact,
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_backup_artifact' },
      })
    } finally {
      console.error = originalError
    }
    expect(logged).toEqual([])
    const empty = await request(target.object, '/backup/verify')
    await expect(empty.json()).resolves.toMatchObject({ logical_empty: true })
  })

  it('rejects an orphan request/outbox artifact instead of creating residue that looks restorable', async () => {
    const queue = { send: async () => undefined }
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ group_enabled: 1, platform: 'openai', group_accessible: 1 }),
        }),
      }),
    }
    const source = createObject({ DB: db, EVENTS_QUEUE: queue } as unknown as Env)
    await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-orphan-source',
      user_id: 'user-1',
      balance_micros: 1_000,
      enabled: true,
    })
    await postJson(source.object, '/authorize', {
      schema_version: 1,
      request_id: 'request-1',
      user_id: 'user-1',
      api_key_id: 'key-1',
      api_key_auth_version: 1,
    })
    const exported = await request(source.object, '/backup/export', { method: 'POST' })
    const records = (await exported.text()).trimEnd().split('\n').map((line) => JSON.parse(line))
    const header = records[0]
    const trailer = records.at(-1)
    const residue = records.filter((record) => (
      record.type !== 'row'
      || record.table === 'user_state_metadata'
      || record.table === 'user_requests'
      || record.table === 'user_outbox'
    ))
    residue[0] = header
    residue[residue.length - 1] = trailer
    const artifact = await rebuildArtifact(residue)

    const target = createObject()
    const response = await request(target.object, '/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: artifact,
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_backup_artifact' },
    })
    const verified = await request(target.object, '/backup/verify')
    await expect(verified.json()).resolves.toMatchObject({ logical_empty: true })
  })

  it('round-trips requests, outbox events, and rollback tombstones created by public commands', async () => {
    const queue = { send: async () => undefined }
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ group_enabled: 1, platform: 'openai', group_accessible: 1 }),
        }),
      }),
    }
    const source = createObject({ DB: db, EVENTS_QUEUE: queue } as unknown as Env)
    await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-complete',
      user_id: 'user-1',
      balance_micros: 2_000,
      enabled: true,
    })
    await postJson(source.object, '/authorize', {
      schema_version: 1,
      request_id: 'request-complete',
      user_id: 'user-1',
      api_key_id: 'key-1',
      api_key_auth_version: 1,
    })
    await postJson(source.object, '/reserve', {
      schema_version: 1,
      request_id: 'request-complete',
      amount_micros: 200,
      reservation_ttl_ms: 60_000,
    })
    await postJson(source.object, '/enabled', {
      schema_version: 1,
      mutation_id: 'disable-complete',
      enabled: false,
    })
    await postJson(source.object, '/enabled', {
      schema_version: 1,
      mutation_id: 'restore-enable-complete',
      rollback_mutation_id: 'disable-complete',
      enabled: true,
    })

    const exported = await request(source.object, '/backup/export', { method: 'POST' })
    const artifact = await exported.text()
    const records = artifact.trimEnd().split('\n').map((line) => JSON.parse(line))
    const tables = new Set(records.filter((record) => record.type === 'row').map((record) => record.table))
    expect(tables).toEqual(new Set([
      'user_profile', 'user_state_metadata', 'user_ledger', 'user_requests',
      'user_ledger_tombstones', 'user_outbox',
    ]))

    const target = createObject()
    expect((await request(target.object, '/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: artifact,
    })).status).toBe(200)
    const snapshot = await request(target.object, '/snapshot')
    await expect(snapshot.json()).resolves.toMatchObject({
      state_version: 2,
      profile: { user_id: 'user-1', balance_micros: 2_000, reserved_micros: 200 },
      requests: [{ request_id: 'request-complete', status: 'reserved', reserved_micros: 200 }],
    })
    const sourceHeader = records[0]
    const readback = await request(target.object, '/backup/export', { method: 'POST' })
    const readbackHeader = JSON.parse((await readback.text()).split('\n')[0])
    expect(readbackHeader).toMatchObject({
      row_count: sourceHeader.row_count,
      inventory_digest: sourceHeader.inventory_digest,
      state_digest: sourceHeader.state_digest,
    })
  })

  it('accepts an identical replay and rejects a later conflicting target without overwriting it', async () => {
    const source = createObject()
    await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-replay',
      user_id: 'user-1',
      balance_micros: 1_000,
      enabled: true,
    })
    const exported = await request(source.object, '/backup/export', { method: 'POST' })
    const artifact = await exported.text()
    const target = createObject()
    const restore = () => request(target.object, '/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: artifact,
    })

    expect((await restore()).status).toBe(200)
    const replay = await restore()
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ restored: true, idempotent: true })
    expect((await postJson(target.object, '/balance/adjust', {
      schema_version: 1,
      mutation_id: 'after-restore',
      amount_delta_micros: 50,
    })).status).toBe(200)
    const conflict = await restore()
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'backup_restore_conflict' },
    })
    const snapshot = await request(target.object, '/snapshot')
    await expect(snapshot.json()).resolves.toMatchObject({ profile: { balance_micros: 1_050 } })
  })

  it.each([
    ['truncated', (records: any[], artifact: string) => artifact.slice(0, -1)],
    ['bad digest', (records: any[]) => {
      records[0].state_digest = '0'.repeat(64)
      return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    }],
    ['duplicate row', (records: any[]) => {
      records.splice(records.length - 1, 0, structuredClone(records[1]))
      return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    }],
    ['unordered row', (records: any[]) => {
      ;[records[1], records[2]] = [records[2], records[1]]
      return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    }],
    ['unsupported schema', (records: any[]) => {
      records[0].version = 2
      return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    }],
  ])('rejects a %s artifact before changing an empty target', async (_case, mutate) => {
    const source = createObject()
    await postJson(source.object, '/configure', {
      schema_version: 1,
      mutation_id: 'opening-invalid-artifact',
      user_id: 'user-1',
      balance_micros: 1_000,
      enabled: true,
    })
    const exported = await request(source.object, '/backup/export', { method: 'POST' })
    const artifact = await exported.text()
    const records = artifact.trimEnd().split('\n').map((line) => JSON.parse(line))
    const invalid = mutate(records, artifact)
    const target = createObject()
    const response = await request(target.object, '/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: invalid,
    })
    expect(response.status).toBe(400)
    const verified = await request(target.object, '/backup/verify')
    await expect(verified.json()).resolves.toMatchObject({ logical_empty: true })
  })
})

describe('Worker privileged backup transport', () => {
  it('fails closed and forwards only an environment-bound USER_STATE request', async () => {
    const forwarded: Request[] = []
    const names: string[] = []
    const namespace = {
      idFromName(name: string) {
        names.push(name)
        return { name } as unknown as DurableObjectId
      },
      get() {
        return {
          fetch: async (request: Request) => {
            forwarded.push(request)
            return Response.json({ logical_empty: true })
          },
        } as unknown as DurableObjectStub
      },
    } as unknown as DurableObjectNamespace
    const base = {
      APP_VERSION: 'test',
      ENVIRONMENT: 'staging',
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: {} as D1Database,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: namespace,
      POOL_STATE: {} as DurableObjectNamespace,
    } as Env
    const app = createApp()
    const path = '/internal/backup/durable-objects/USER_STATE/user-1/verify'

    expect((await app.request(path, {}, base)).status).toBe(503)
    expect((await app.request(path, {
      headers: {
        authorization: `Bearer ${'x'.repeat(32)}`,
        'x-sub2api-backup-environment': 'staging',
      },
    }, { ...base, BACKUP_OPERATOR_TOKEN: 's'.repeat(32) })).status).toBe(401)
    expect((await app.request(path, {
      headers: {
        authorization: `Bearer ${'s'.repeat(32)}`,
        'x-sub2api-backup-environment': 'production',
      },
    }, { ...base, BACKUP_OPERATOR_TOKEN: 's'.repeat(32) })).status).toBe(403)
    expect((await app.request(
      '/internal/backup/durable-objects/POOL_STATE/pool-1/verify',
      {
        headers: {
          authorization: `Bearer ${'s'.repeat(32)}`,
          'x-sub2api-backup-environment': 'staging',
        },
      },
      { ...base, BACKUP_OPERATOR_TOKEN: 's'.repeat(32) },
    )).status).toBe(404)

    const accepted = await app.request(path, {
      headers: {
        authorization: `Bearer ${'s'.repeat(32)}`,
        'x-sub2api-backup-environment': 'staging',
      },
    }, { ...base, BACKUP_OPERATOR_TOKEN: 's'.repeat(32) })
    expect(accepted.status).toBe(200)
    expect(names).toEqual(['user-1'])
    expect(forwarded).toHaveLength(1)
    expect(new URL(forwarded[0].url).pathname).toBe('/backup/verify')
    expect(forwarded[0].headers.get('authorization')).toBeNull()
    expect(forwarded[0].headers.get('x-sub2api-backup-environment')).toBe('staging')
    expect(forwarded[0].headers.get('x-sub2api-backup-namespace')).toBe('USER_STATE')
    expect(forwarded[0].headers.get('x-sub2api-backup-object-id')).toBe('user-1')
  })
})
