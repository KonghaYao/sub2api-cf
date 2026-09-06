// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { createHash } from 'node:crypto'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { tmpdir } from 'node:os'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createRemoteBackupPlan } from '../../scripts/backup-restore-remote.mjs'
import type { RemoteStep } from '../../scripts/backup-restore-remote.mjs'
import { createUserStateBackupRemoteAdapter } from '../../scripts/backup-restore-remote-user-state.mjs'
import { USER_STATE_BACKUP_V1_SCHEMA } from '../../src/backup/user-state-backup-schema.mjs'

const temporaryDirectories: string[] = []
const tableNames = [
  'user_profile', 'user_state_metadata', 'user_ledger', 'user_requests',
  'user_ledger_tombstones', 'user_outbox',
]

function backupArtifact(
  environment: 'staging' | 'production',
  objectId: string,
  exactSchema = true,
) {
  const schemaContract = exactSchema
    ? structuredClone(USER_STATE_BACKUP_V1_SCHEMA)
    : tableNames.map((name) => ({
        name,
        columns: [{
          cid: 0, name: 'fixture_value', type: 'TEXT', not_null: 0,
          default_value: null, primary_key: 0,
        }],
      }))
  const rows = exactSchema
    ? [
        {
          type: 'row', table: 'user_profile', rowid: 1,
          values: [1, 1, objectId, 1, 0, 0, 0, 0, 0],
        },
        { type: 'row', table: 'user_state_metadata', rowid: 1, values: [1, 0] },
      ]
    : [{ type: 'row', table: 'user_profile', rowid: 1, values: ['not-v1'] }]
  const tables = tableNames.map((name) => ({
    name,
    row_count: rows.filter((row) => row.table === name).length,
  }))
  const schemaDigest = createHash('sha256').update(JSON.stringify(schemaContract)).digest('hex')
  const inventoryDigest = createHash('sha256')
    .update(JSON.stringify({ schema_digest: schemaDigest, tables }))
    .digest('hex')
  const stateDigest = createHash('sha256')
    .update(rows.map((row) => JSON.stringify(row)).join('\n'))
    .digest('hex')
  return {
    text: [
      JSON.stringify({
        type: 'header', schema: 'sub2api-user-state-backup', version: 1,
        environment, namespace: 'USER_STATE', object_id: objectId,
        schema_contract: schemaContract, schema_digest: schemaDigest,
        inventory_digest: inventoryDigest, state_digest: stateDigest,
        row_count: rows.length, tables,
      }),
      ...rows.map((row) => JSON.stringify(row)),
      JSON.stringify({
        type: 'trailer', row_count: rows.length,
        inventory_digest: inventoryDigest, state_digest: stateDigest,
      }),
      '',
    ].join('\n'),
    inventoryDigest,
    stateDigest,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('USER_STATE remote HTTP adapter', () => {
  it('rejects a self-consistent artifact whose schema is not the exact USER_STATE v1 schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sub2api-user-state-adapter-'))
    temporaryDirectories.push(root)
    const fixture = backupArtifact('staging', 'user-1', false)
    const artifactPath = join(root, 'wrong-schema.ndjson')
    await writeFile(artifactPath, fixture.text)
    const step: RemoteStep = {
      sequence: 2,
      id: 'restore:do:USER_STATE:user-1:wrong-schema.ndjson',
      phase: 'durable-objects', operation: 'restore-durable-object-ndjson',
      transport: 'worker-http', environment: 'staging',
      resource: { namespace: 'USER_STATE', objectId: 'user-1' },
      request: {
        method: 'POST', service: 'sub2api-worker-staging',
        origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
        path: '/internal/backup/durable-objects/USER_STATE/user-1/restore',
      },
      artifact: artifactPath,
      artifact_bytes: Buffer.byteLength(fixture.text),
      artifact_sha256: createHash('sha256').update(fixture.text).digest('hex'),
      postcondition: { kind: 'durable-objects-inventory-state-digest' },
    }
    const adapter = createUserStateBackupRemoteAdapter({
      environment: 'staging',
      origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
      token: 't'.repeat(32),
      fetcher: async () => { throw new Error('must reject before fetch') },
    })

    await expect(adapter.execute(step)).rejects.toThrow('schema contract')
  })

  it('atomically exports a DO artifact and independently verifies its remote digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sub2api-user-state-adapter-'))
    temporaryDirectories.push(root)
    const fixture = backupArtifact('staging', 'user-1')
    const { inventoryDigest, stateDigest } = fixture
    const artifact = fixture.text
    const requests: Request[] = []
    const fetcher = async (request: Request): Promise<Response> => {
      requests.push(request)
      const action = new URL(request.url).pathname.split('/').at(-1)
      if (action === 'export') return new Response(artifact, { headers: { 'content-type': 'application/x-ndjson' } })
      return Response.json({
        schema: 'sub2api-user-state-backup', version: 1,
        environment: 'staging', namespace: 'USER_STATE', object_id: 'user-1',
        logical_empty: false, row_count: 0, schema_digest: 'c'.repeat(64),
        inventory_digest: inventoryDigest, state_digest: stateDigest,
      })
    }
    const plan = createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory: root,
      bundleDirectory: join(root, 'bundle'),
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })
    const step = plan.steps[1]
    expect(step).toMatchObject({ transport: 'worker-http' })
    expect(step.contract_only).toBeUndefined()
    const adapter = createUserStateBackupRemoteAdapter({
      environment: 'staging',
      origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
      token: 't'.repeat(32),
      fetcher,
    })

    expect(await adapter.supports(step)).toBe(true)
    await expect(adapter.execute(step)).resolves.toEqual({
      status: 'completed', evidence: { step_id: step.id },
    })
    await expect(readFile(step.output as string, 'utf8')).resolves.toBe(artifact)
    const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
    await expect(adapter.verify(step)).resolves.toEqual({
      status: 'verified',
      step_id: step.id,
      kind: 'durable-objects-inventory-state-digest',
      artifact_sha256: artifactSha256,
      remote_inventory_digest: inventoryDigest,
      remote_state_digest: stateDigest,
    })
    expect(requests).toHaveLength(2)
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${'t'.repeat(32)}`)
    expect(requests[0].headers.get('x-sub2api-backup-environment')).toBe('staging')
    expect(requests[0].redirect).toBe('error')

    const tamperedRecords = artifact.trimEnd().split('\n').map((line) => JSON.parse(line))
    tamperedRecords[1].values[4] = 1
    await writeFile(step.output as string, `${tamperedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`)
    await expect(adapter.verify(step)).rejects.toThrow('digest does not match')
    expect(requests).toHaveLength(2)
  })

  it('restores only a plan-bound USER_STATE artifact and verifies remote read-back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sub2api-user-state-adapter-'))
    temporaryDirectories.push(root)
    const fixture = backupArtifact('production', 'user-2')
    const { inventoryDigest, stateDigest } = fixture
    const artifact = fixture.text
    const artifactPath = join(root, 'user-2.ndjson')
    await writeFile(artifactPath, artifact)
    const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
    const step: RemoteStep = {
      sequence: 2,
      id: 'restore:do:USER_STATE:user-2:user-2.ndjson',
      phase: 'durable-objects',
      operation: 'restore-durable-object-ndjson',
      transport: 'worker-http',
      environment: 'production',
      resource: { namespace: 'USER_STATE', objectId: 'user-2' },
      request: {
        method: 'POST', service: 'sub2api-worker-production',
        origin: 'https://sub2api-worker-production.claude-code-best.workers.dev',
        path: '/internal/backup/durable-objects/USER_STATE/user-2/restore',
      },
      artifact: artifactPath,
      artifact_bytes: Buffer.byteLength(artifact),
      artifact_sha256: artifactSha256,
      postcondition: { kind: 'durable-objects-inventory-state-digest' },
    }
    const requests: Request[] = []
    const fetcher = async (request: Request): Promise<Response> => {
      requests.push(request)
      const action = new URL(request.url).pathname.split('/').at(-1)
      if (action === 'restore') {
        expect(await request.text()).toBe(artifact)
        return Response.json({ restored: true, inventory_digest: inventoryDigest, state_digest: stateDigest })
      }
      return Response.json({
        schema: 'sub2api-user-state-backup', version: 1,
        environment: 'production', namespace: 'USER_STATE', object_id: 'user-2',
        inventory_digest: inventoryDigest, state_digest: stateDigest,
      })
    }
    const adapter = createUserStateBackupRemoteAdapter({
      environment: 'production',
      origin: 'https://sub2api-worker-production.claude-code-best.workers.dev',
      token: 's'.repeat(32),
      fetcher,
    })

    expect(() => createUserStateBackupRemoteAdapter({
      environment: 'production',
      origin: 'https://sub2api-worker-production.evil.com',
      token: 's'.repeat(32),
      fetcher,
    })).toThrow('allow-listed')

    expect(adapter.supports({
      ...step,
      resource: { namespace: 'SUBSCRIPTION_STATE', objectId: 'user-2' },
    })).toBe(false)
    expect(adapter.supports({
      ...step,
      request: { ...step.request, path: 'https://attacker.invalid/restore' },
    })).toBe(false)
    await expect(adapter.execute(step)).resolves.toEqual({
      status: 'completed', evidence: { step_id: step.id },
    })
    await expect(adapter.verify(step)).resolves.toEqual({
      status: 'verified',
      step_id: step.id,
      kind: 'durable-objects-inventory-state-digest',
      artifact_sha256: artifactSha256,
      remote_inventory_digest: inventoryDigest,
      remote_state_digest: stateDigest,
    })
    expect(requests.map((request) => new URL(request.url).pathname.split('/').at(-1)))
      .toEqual(['restore', 'verify'])
  })

  it('sends the same validated bytes when the artifact path is atomically replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sub2api-user-state-adapter-'))
    temporaryDirectories.push(root)
    const original = backupArtifact('staging', 'user-1')
    const replacement = backupArtifact('staging', 'user-1')
    const replacementRecords = replacement.text.trimEnd().split('\n').map((line) => JSON.parse(line))
    replacementRecords[1].values[4] = 1
    const replacementText = `${replacementRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
    const artifactPath = join(root, 'user-1.ndjson')
    const replacementPath = join(root, 'replacement.ndjson')
    await writeFile(artifactPath, original.text)
    await writeFile(replacementPath, replacementText)
    const step: RemoteStep = {
      sequence: 2,
      id: 'restore:do:USER_STATE:user-1:user-1.ndjson',
      phase: 'durable-objects', operation: 'restore-durable-object-ndjson',
      transport: 'worker-http', environment: 'staging',
      resource: { namespace: 'USER_STATE', objectId: 'user-1' },
      request: {
        method: 'POST', service: 'sub2api-worker-staging',
        origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
        path: '/internal/backup/durable-objects/USER_STATE/user-1/restore',
      },
      artifact: artifactPath,
      artifact_bytes: Buffer.byteLength(original.text),
      artifact_sha256: createHash('sha256').update(original.text).digest('hex'),
      postcondition: { kind: 'durable-objects-inventory-state-digest' },
    }
    const adapter = createUserStateBackupRemoteAdapter({
      environment: 'staging',
      origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
      token: 't'.repeat(32),
      fetcher: async (request) => {
        await rename(replacementPath, artifactPath)
        expect(await request.text()).toBe(original.text)
        return Response.json({
          restored: true,
          inventory_digest: original.inventoryDigest,
          state_digest: original.stateDigest,
        })
      },
    })

    await expect(adapter.execute(step)).resolves.toMatchObject({ status: 'completed' })
    await expect(adapter.verify(step)).rejects.toThrow(/plan|digest/)
  })
})
