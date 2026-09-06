// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { createHash } from 'node:crypto'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { tmpdir } from 'node:os'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createRemoteBackupPlan } from '../../scripts/backup-restore-remote.mjs'
import type { RemoteStep } from '../../scripts/backup-restore-remote.mjs'
import { createUserStateBackupRemoteAdapter } from '../../scripts/backup-restore-remote-user-state.mjs'

const temporaryDirectories: string[] = []
const tableNames = [
  'user_profile', 'user_state_metadata', 'user_ledger', 'user_requests',
  'user_ledger_tombstones', 'user_outbox',
]

function backupArtifact(environment: 'staging' | 'production', objectId: string) {
  const schemaContract = tableNames.map((name) => ({
    name,
    columns: [{
      cid: 0, name: 'fixture_value', type: 'TEXT', not_null: 0,
      default_value: null, primary_key: 0,
    }],
  }))
  const rows = [{ type: 'row', table: 'user_profile', rowid: 1, values: ['original'] }]
  const tables = tableNames.map((name) => ({ name, row_count: name === 'user_profile' ? 1 : 0 }))
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

    await writeFile(step.output as string, artifact.replace('original', 'tampered'))
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
})
