// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { spawnSync } from 'node:child_process'
// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { createHash } from 'node:crypto'
// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { tmpdir } from 'node:os'
// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createBackupBundle, verifyBackupBundle } from '../../scripts/backup-restore.mjs'
import {
  createRemoteBackupPlan,
  createRemoteRestorePlan,
  executeRemotePlan,
  verifyExecutedStep,
} from '../../scripts/backup-restore-remote.mjs'

const scriptPath = decodeURIComponent(
  new URL('../../scripts/backup-restore-remote.mjs', import.meta.url).pathname,
)

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sub2api-remote-backup-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ))
})

async function remoteBundle(root: string) {
  const sourceDirectory = join(root, 'source')
  await mkdir(sourceDirectory)
  const d1 = join(sourceDirectory, 'database.sql')
  const durableObject = join(sourceDirectory, 'user-1.ndjson')
  const r2 = join(sourceDirectory, 'objects.ndjson')
  await writeFile(d1, 'CREATE TABLE users(id TEXT PRIMARY KEY);\n')
  await writeFile(durableObject, '{"key":"balance","value":42}\n')
  await writeFile(r2, '{"key":"media/a.png","etag":"abc","size":3}\n')
  const bundleDirectory = join(root, 'backup.bundle')
  await createBackupBundle({
    outputDirectory: bundleDirectory,
    createdAt: '2026-09-06T00:00:00.000Z',
    artifacts: [
      { kind: 'd1-sql', logicalName: 'primary.sql', source: 'DB', filePath: d1 },
      { kind: 'do-ndjson', logicalName: 'user-1.ndjson', source: 'USER_STATE:user-1', filePath: durableObject },
      { kind: 'r2-inventory', logicalName: 'objects.ndjson', source: 'OBJECTS', filePath: r2 },
    ],
  })
  return bundleDirectory
}

function emptyTargetProof(
  environment: 'staging' | 'production' = 'staging',
  accountId = 'a'.repeat(32),
) {
  return {
    schema: 'sub2api-cloudflare-empty-target-proof' as const,
    version: 1 as const,
    environment,
    account_id: accountId,
    checked_at: '2026-09-06T00:00:00.000Z',
    d1: {
      binding: 'DB',
      database_name: `sub2api-${environment}`,
      user_table_count: 0,
    },
    durable_objects: [{
      namespace: 'USER_STATE',
      object_id: 'user-1',
      storage_entry_count: 0,
    }],
    r2: {
      binding: 'OBJECTS',
      bucket_name: `sub2api-${environment}`,
      object_count: 0,
    },
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('remote Cloudflare adapter plans', () => {
  it('uses an explicit environment, allow-listed resources, argument arrays, and endpoint contracts', () => {
    const root = '/safe/work'
    const plan = createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory: root,
      bundleDirectory: '/safe/backup.bundle',
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })

    expect(plan.dry_run).toBe(true)
    expect(plan.steps[0]).toMatchObject({
      phase: 'd1',
      transport: 'command',
      command: {
        executable: 'wrangler',
        arguments: ['d1', 'export', 'DB', '--remote', '--env', 'staging', '--output', '/safe/work/primary.sql'],
      },
    })
    expect(plan.steps[1]).toMatchObject({
      phase: 'durable-objects',
      transport: 'worker-http',
      request: {
        method: 'POST',
        service: 'sub2api-worker-staging',
        origin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
        path: '/internal/backup/durable-objects/USER_STATE/user-1/export',
        response_format: 'ndjson',
      },
    })
    expect(plan.steps[2]).toMatchObject({
      phase: 'r2',
      transport: 'api-contract',
      request: {
        method: 'GET',
        path: `/accounts/${'a'.repeat(32)}/r2/buckets/sub2api-staging/objects`,
        pagination: 'cursor-until-exhausted',
        response_format: 'canonical-ndjson-inventory',
      },
    })

    const mixedPlan = createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory: root,
      bundleDirectory: '/safe/mixed-backup.bundle',
      durableObjects: [
        { namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' },
        { namespace: 'SUBSCRIPTION_STATE', objectId: 'subscription-1', logicalName: 'subscription-1.ndjson' },
      ],
    })
    expect(mixedPlan.steps.find(({ phase, resource }) => (
      phase === 'durable-objects' && resource.namespace === 'USER_STATE'
    ))).toMatchObject({ transport: 'worker-http' })
    expect(mixedPlan.steps.find(({ phase, resource }) => (
      phase === 'durable-objects' && resource.namespace === 'SUBSCRIPTION_STATE'
    ))).toMatchObject({ transport: 'worker-http' })

    expect(() => createRemoteBackupPlan({
      environment: 'development' as 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory: root,
      bundleDirectory: '/safe/backup.bundle',
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })).toThrow('staging or production')
    expect(() => createRemoteBackupPlan({
      environment: 'production',
      accountId: 'a'.repeat(32),
      workingDirectory: root,
      bundleDirectory: '/safe/backup.bundle',
      durableObjects: [{ namespace: 'UNBOUND_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })).toThrow('allow-listed')
    expect(() => createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory: root,
      bundleDirectory: '/safe/backup.bundle',
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'primary.sql' }],
    })).toThrow('reserved or duplicate')
  })

  it('exposes plan-only CLI commands and rejects shell-shaped object identifiers', () => {
    const accountId = 'a'.repeat(32)
    const planned = spawnSync(process.execPath, [
      scriptPath,
      'backup-plan',
      '--env', 'staging',
      '--account-id', accountId,
      '--work-dir', '/safe/work',
      '--bundle', '/safe/backup.bundle',
      '--do-object', 'USER_STATE', 'user-1', 'user-1.ndjson',
    ], { encoding: 'utf8', shell: false })
    expect(planned.status).toBe(0)
    expect(JSON.parse(planned.stdout)).toMatchObject({
      operation: 'backup',
      environment: 'staging',
      dry_run: true,
    })

    const unsafe = spawnSync(process.execPath, [
      scriptPath,
      'backup-plan',
      '--env', 'staging',
      '--account-id', accountId,
      '--work-dir', '/safe/work',
      '--bundle', '/safe/backup.bundle',
      '--do-object', 'USER_STATE', 'user-1;touch-pwned', 'user-1.ndjson',
    ], { encoding: 'utf8', shell: false })
    expect(unsafe.status).toBe(1)
    expect(unsafe.stderr).toContain('objectId is invalid')

    const apply = spawnSync(process.execPath, [scriptPath, 'restore', '--apply'], {
      encoding: 'utf8',
      shell: false,
    })
    expect(apply.status).toBe(1)
    expect(apply.stderr).toContain('plan-only')
  })

  it('verifies the local manifest before constructing any remote restore write', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const artifact = join(bundleDirectory, 'artifacts/r2-inventory/objects.ndjson')
    await writeFile(artifact, '{"key":"tampered","etag":"abc","size":3}\n')

    await expect(createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })).rejects.toThrow(/length mismatch|digest mismatch/)
  })

  it('requires a fresh, complete proof that the selected remote target is empty', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const incomplete = emptyTargetProof()
    incomplete.durable_objects = []

    await expect(createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: incomplete,
      now: new Date('2026-09-06T00:05:00.000Z'),
    })).rejects.toThrow('missing empty-target proof')
    await expect(createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:16:00.001Z'),
    })).rejects.toThrow('older than 15 minutes')
  })

  it('rejects an empty-target proof issued for a different Cloudflare account', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)

    await expect(createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'b'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof('staging', 'a'.repeat(32)),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })).rejects.toThrow('account_id does not match')
  })

  it('plans restore in D1, per-object DO, then R2 order', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const plan = await createRemoteRestorePlan({
      environment: 'production',
      accountId: 'b'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof('production', 'b'.repeat(32)),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })

    expect(plan.steps.map(({ phase }) => phase)).toEqual(['d1', 'durable-objects', 'r2'])
    expect(plan.steps.map(({ postcondition }) => postcondition.kind)).toEqual([
      'd1-schema-data-digest',
      'durable-objects-inventory-state-digest',
      'r2-inventory-object-digest',
    ])
    expect(plan.steps[0]).toMatchObject({
      command: {
        executable: 'wrangler',
        arguments: ['d1', 'execute', 'DB', '--remote', '--env', 'production', '--file', join(bundleDirectory, 'artifacts/d1-sql/primary.sql')],
      },
    })
    expect(plan.steps[1]).toMatchObject({
      request: {
        method: 'POST',
        path: '/internal/backup/durable-objects/USER_STATE/user-1/restore',
        request_format: 'ndjson',
      },
    })
    expect(plan.steps[2]).toMatchObject({
      request: {
        method: 'POST',
        path: `/accounts/${'b'.repeat(32)}/r2/buckets/sub2api-production/reconcile`,
        request_format: 'canonical-ndjson-inventory-with-content-locator',
      },
    })
  })

  it('keeps non-USER_STATE restore artifacts contract-only', async () => {
    const root = await temporaryDirectory()
    const sourceDirectory = join(root, 'source')
    await mkdir(sourceDirectory)
    const d1 = join(sourceDirectory, 'database.sql')
    const userState = join(sourceDirectory, 'user-1.ndjson')
    const subscriptionState = join(sourceDirectory, 'subscription-1.ndjson')
    const r2 = join(sourceDirectory, 'objects.ndjson')
    await Promise.all([
      writeFile(d1, 'CREATE TABLE users(id TEXT PRIMARY KEY);\n'),
      writeFile(userState, '{"state":"user"}\n'),
      writeFile(subscriptionState, '{"state":"subscription"}\n'),
      writeFile(r2, '{"key":"media/a.png","etag":"abc","size":3}\n'),
    ])
    const bundleDirectory = join(root, 'mixed.bundle')
    await createBackupBundle({
      outputDirectory: bundleDirectory,
      createdAt: '2026-09-06T00:00:00.000Z',
      artifacts: [
        { kind: 'd1-sql', logicalName: 'primary.sql', source: 'DB', filePath: d1 },
        { kind: 'do-ndjson', logicalName: 'user-1.ndjson', source: 'USER_STATE:user-1', filePath: userState },
        {
          kind: 'do-ndjson', logicalName: 'subscription-1.ndjson',
          source: 'SUBSCRIPTION_STATE:subscription-1', filePath: subscriptionState,
        },
        { kind: 'r2-inventory', logicalName: 'objects.ndjson', source: 'OBJECTS', filePath: r2 },
      ],
    })
    const proof = emptyTargetProof()
    proof.durable_objects.push({
      namespace: 'SUBSCRIPTION_STATE', object_id: 'subscription-1', storage_entry_count: 0,
    })
    const plan = await createRemoteRestorePlan({
      environment: 'staging', accountId: 'a'.repeat(32), bundleDirectory,
      emptyTargetProof: proof, now: new Date('2026-09-06T00:05:00.000Z'),
    })

    expect(plan.steps.find(({ resource }) => resource.namespace === 'USER_STATE'))
      .toMatchObject({ transport: 'worker-http' })
    expect(plan.steps.find(({ resource }) => resource.namespace === 'SUBSCRIPTION_STATE'))
      .toMatchObject({ transport: 'worker-http' })
  })
})

describe('remote execution safety and recovery', () => {
  it('records independent remote digests for a first-run USER_STATE export', async () => {
    const root = await temporaryDirectory()
    const plan = createRemoteBackupPlan({
      environment: 'staging', accountId: 'a'.repeat(32),
      workingDirectory: root, bundleDirectory: join(root, 'bundle'),
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })
    const step = plan.steps[1]
    await writeFile(step.output!, '{"verified":"artifact"}\n')
    const verifyCalls: string[] = []

    await expect(verifyExecutedStep(plan, step, {
      supports: () => true,
      execute: async () => ({ status: 'completed' }),
      verify: async (candidate) => {
        verifyCalls.push(candidate.id)
        return {
          status: 'verified', step_id: candidate.id, kind: candidate.postcondition.kind,
          artifact_sha256: sha256('{"verified":"artifact"}\n'),
          remote_inventory_digest: 'a'.repeat(64),
          remote_state_digest: 'b'.repeat(64),
        }
      },
    })).resolves.toMatchObject({
      step_id: step.id,
      sha256: sha256('{"verified":"artifact"}\n'),
      remote_inventory_digest: 'a'.repeat(64),
      remote_state_digest: 'b'.repeat(64),
    })
    expect(verifyCalls).toEqual([step.id])
  })

  it('keeps the journal realpath-separated from bundle, work directory, manifest, and artifacts', async () => {
    const root = await temporaryDirectory()
    const workingDirectory = join(root, 'exports')
    const backupPlan = createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory,
      bundleDirectory: join(root, 'remote.bundle'),
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })
    const calls: string[] = []
    const executor = {
      supports: () => true,
      execute: async (step: { id: string }) => {
        calls.push(step.id)
        return { status: 'completed', evidence: { step_id: step.id } }
      },
    }

    for (const journalPath of [
      backupPlan.steps[0].output!,
      workingDirectory,
      join(workingDirectory, 'journal.json'),
      join(backupPlan.steps[0].output!, 'journal.json'),
      join(root, 'EXPORTS', 'journal.json'),
    ]) {
      await expect(executeRemotePlan({
        plan: backupPlan,
        apply: true,
        journalPath,
        executor,
      })).rejects.toThrow('journal path must be separate')
    }

    const bundleDirectory = await remoteBundle(root)
    const bundleAlias = join(root, 'bundle-alias')
    await symlink(bundleDirectory, bundleAlias)
    const restorePlan = await createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })
    for (const journalPath of [
      root,
      bundleDirectory,
      join(bundleDirectory, 'backup-manifest.json'),
      restorePlan.steps[0].artifact as string,
      join(bundleAlias, 'journal.json'),
    ]) {
      await expect(executeRemotePlan({
        plan: restorePlan,
        apply: true,
        confirmation: 'RESTORE staging',
        journalPath,
        now: new Date('2026-09-06T00:05:00.000Z'),
        executor,
      })).rejects.toThrow('journal path must be separate')
    }
    expect(calls).toEqual([])
  })

  it('resumes bundle publishing without rerunning completed remote exports', async () => {
    const root = await temporaryDirectory()
    const workingDirectory = join(root, 'exports')
    const bundleDirectory = join(root, 'remote.bundle')
    const journalPath = join(root, 'backup.journal.json')
    const plan = createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory,
      bundleDirectory,
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })
    const contents = [
      'CREATE TABLE users(id TEXT PRIMARY KEY);\n',
      '{"key":"balance","value":42}\n',
      '{"key":"media/a.png","etag":"abc","size":3}\n',
    ]
    await mkdir(workingDirectory)
    for (const [index, step] of plan.steps.entries()) await writeFile(step.output!, contents[index])
    const verifiedPostconditions = plan.steps.map((step, index) => ({
      step_id: step.id,
      kind: step.postcondition.kind,
      artifact_path: step.output,
      bytes: Buffer.byteLength(contents[index]),
      sha256: sha256(contents[index]),
      ...Object.fromEntries(
        ((step.postcondition.required_digests as string[] | undefined) ?? [])
          .map((field) => [field, index === 1 ? 'c'.repeat(64) : 'd'.repeat(64)]),
      ),
    }))
    await writeFile(journalPath, `${JSON.stringify({
      schema: 'sub2api-cloudflare-remote-journal',
      version: 1,
      plan_id: plan.plan_id,
      operation: 'backup',
      environment: 'staging',
      status: 'publishing',
      completed_step_ids: plan.steps.map(({ id }) => id),
      failed_step_id: null,
      next_step_id: 'publish-backup-bundle',
      verified_postconditions: verifiedPostconditions,
      updated_at: '2026-09-06T00:05:00.000Z',
    }, null, 2)}\n`)
    const calls: string[] = []
    const result = await executeRemotePlan({
      plan,
      apply: true,
      journalPath,
      executor: {
        supports: () => true,
        execute: async (step) => { calls.push(step.id); throw new Error('must not rerun') },
        verify: async (step) => {
          calls.push(`verify:${step.id}`)
          const proof = verifiedPostconditions.find(({ step_id: stepId }) => stepId === step.id)!
          const digestProof = proof as Record<string, unknown>
          return Object.fromEntries([
            ['status', 'verified'],
            ['step_id', step.id],
            ['kind', proof.kind],
            ['artifact_sha256', proof.sha256],
            ...((step.postcondition.required_digests as string[]).map((field) => [field, digestProof[field]])),
          ])
        },
      },
    })

    expect(result.status).toBe('completed')
    expect(calls).toEqual(plan.steps.slice(1).map(({ id }) => `verify:${id}`))
    const manifest = await verifyBackupBundle(bundleDirectory)
    expect(manifest.artifacts.map(({ kind }) => kind)).toEqual([
      'd1-sql',
      'do-ndjson',
      'r2-inventory',
    ])
    await rm(bundleDirectory, { recursive: true })
    await expect(executeRemotePlan({
      plan,
      apply: true,
      journalPath,
      executor: {
        supports: () => true,
        execute: async () => { throw new Error('must not rerun') },
        verify: async (step) => {
          const proof = verifiedPostconditions.find(({ step_id: stepId }) => stepId === step.id)!
          const digestProof = proof as Record<string, unknown>
          return Object.fromEntries([
            ['status', 'verified'],
            ['step_id', step.id],
            ['kind', proof.kind],
            ['artifact_sha256', proof.sha256],
            ...((step.postcondition.required_digests as string[]).map((field) => [field, digestProof[field]])),
          ])
        },
      },
    })).rejects.toThrow('Completed backup bundle is missing')
  })

  it('rejects an existing bundle whose bytes differ from the verified publishing journal', async () => {
    const root = await temporaryDirectory()
    const workingDirectory = join(root, 'exports')
    const bundleDirectory = join(root, 'remote.bundle')
    const journalPath = join(root, 'backup.journal.json')
    const plan = createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory,
      bundleDirectory,
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })
    const contents = [
      'CREATE TABLE users(id TEXT PRIMARY KEY);\n',
      '{"key":"balance","value":42}\n',
      '{"key":"media/a.png","etag":"abc","size":3}\n',
    ]
    await mkdir(workingDirectory)
    for (const [index, step] of plan.steps.entries()) await writeFile(step.output!, contents[index])
    const verifiedPostconditions = plan.steps.map((step, index) => ({
      step_id: step.id,
      kind: step.postcondition.kind,
      artifact_path: step.output,
      bytes: Buffer.byteLength(contents[index]),
      sha256: sha256(contents[index]),
      ...Object.fromEntries(
        ((step.postcondition.required_digests as string[] | undefined) ?? [])
          .map((field) => [field, index === 1 ? 'c'.repeat(64) : 'd'.repeat(64)]),
      ),
    }))
    await writeFile(journalPath, `${JSON.stringify({
      schema: 'sub2api-cloudflare-remote-journal',
      version: 1,
      plan_id: plan.plan_id,
      operation: 'backup',
      environment: 'staging',
      status: 'publishing',
      completed_step_ids: plan.steps.map(({ id }) => id),
      failed_step_id: null,
      next_step_id: 'publish-backup-bundle',
      verified_postconditions: verifiedPostconditions,
      updated_at: '2026-09-06T00:05:00.000Z',
    }, null, 2)}\n`)

    const alternateDirectory = join(root, 'alternate')
    await mkdir(alternateDirectory)
    const alternateFiles = contents.map((content, index) => join(alternateDirectory, `${index}.data`))
    await Promise.all(alternateFiles.map((path, index) => writeFile(
      path,
      index === 0 ? `${contents[index]}-- different valid SQL\n` : contents[index],
    )))
    await createBackupBundle({
      outputDirectory: bundleDirectory,
      artifacts: plan.steps.map((step, index) => ({
        ...(step.artifact as { kind: 'd1-sql' | 'do-ndjson' | 'r2-inventory'; logicalName: string; source: string }),
        filePath: alternateFiles[index],
      })),
    })

    await expect(executeRemotePlan({
      plan,
      apply: true,
      journalPath,
      executor: {
        supports: () => true,
        execute: async () => { throw new Error('must not rerun') },
        verify: async (step) => {
          const proof = verifiedPostconditions.find(({ step_id: stepId }) => stepId === step.id)!
          const digestProof = proof as Record<string, unknown>
          return Object.fromEntries([
            ['status', 'verified'],
            ['step_id', step.id],
            ['kind', proof.kind],
            ['artifact_sha256', proof.sha256],
            ...((step.postcondition.required_digests as string[]).map((field) => [field, digestProof[field]])),
          ])
        },
      },
    })).rejects.toThrow('does not match the completed export plan')
  })

  it('never applies contract-only steps even when an executor claims success', async () => {
    const root = await temporaryDirectory()
    const plan = createRemoteBackupPlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      workingDirectory: join(root, 'exports'),
      bundleDirectory: join(root, 'remote.bundle'),
      durableObjects: [{ namespace: 'USER_STATE', objectId: 'user-1', logicalName: 'user-1.ndjson' }],
    })
    const calls: string[] = []

    await expect(executeRemotePlan({
      plan,
      apply: true,
      journalPath: join(root, 'journal.json'),
      executor: {
        supports: () => true,
        execute: async (step) => {
          calls.push(`execute:${step.id}`)
          return { status: 'completed', evidence: { step_id: step.id } }
        },
        verify: async (step) => {
          calls.push(`verify:${step.id}`)
          return { status: 'verified', step_id: step.id }
        },
      },
    })).rejects.toThrow('contract-only')
    expect(calls).toEqual([])
  })

  it('is dry-run by default and refuses apply without exact confirmation', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const plan = await createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })
    const calls: string[] = []
    const executor = {
      supports: () => true,
      execute: async (step: { id: string }) => {
        calls.push(step.id)
        return { status: 'completed' as const, evidence: { step_id: step.id } }
      },
    }

    const dryRun = await executeRemotePlan({ plan, executor })
    expect(dryRun.status).toBe('dry-run')
    expect(calls).toEqual([])
    await expect(executeRemotePlan({ plan, executor, apply: true, confirmation: 'yes' }))
      .rejects.toThrow('RESTORE staging')
    expect(calls).toEqual([])
  })

  it('rejects contract-only restore before capability probing or journal creation', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const journalPath = join(root, 'restore.journal.json')
    const plan = await createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })
    const preflightCalls: string[] = []
    await expect(executeRemotePlan({
      plan,
      apply: true,
      confirmation: 'RESTORE staging',
      journalPath,
      now: new Date('2026-09-06T00:05:00.000Z'),
      executor: {
        supports: (step: { id: string; phase: string }) => {
          preflightCalls.push(step.id)
          return step.phase !== 'r2'
        },
        execute: async () => { throw new Error('must not execute') },
      },
    })).rejects.toThrow('contract-only')
    expect(preflightCalls).toEqual([])
    await expect(readFile(journalPath)).rejects.toThrow()
  })

  it('rejects structurally impossible or tampered journal states', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const journalPath = join(root, 'tamper.journal.json')
    const plan = await createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })
    const validRunning = {
      schema: 'sub2api-cloudflare-remote-journal',
      version: 1,
      plan_id: plan.plan_id,
      operation: 'restore',
      environment: 'staging',
      status: 'running',
      completed_step_ids: [],
      failed_step_id: null,
      next_step_id: plan.steps[0].id,
      verified_postconditions: [],
      updated_at: '2026-09-06T00:05:00.000Z',
    }
    const allPostconditions = plan.steps.map((step) => Object.fromEntries([
      ['step_id', step.id],
      ['kind', step.postcondition.kind],
      ['artifact_sha256', step.artifact_sha256],
      ...((step.postcondition.required_digests as string[]).map((field) => [field, 'c'.repeat(64)])),
    ]))
    const impossible = [
      { ...validRunning, status: 'completed', failed_step_id: null },
      {
        ...validRunning,
        status: 'running',
        completed_step_ids: plan.steps.map(({ id }) => id),
        next_step_id: null,
        verified_postconditions: allPostconditions,
        failed_step_id: null,
      },
      { ...validRunning, status: 'failed', failed_step_id: plan.steps[2].id },
      { ...validRunning, status: 'running', failed_step_id: plan.steps[0].id },
    ]
    const calls: string[] = []
    for (const tampered of impossible) {
      await writeFile(journalPath, `${JSON.stringify(tampered, null, 2)}\n`)
      await expect(executeRemotePlan({
        plan,
        apply: true,
        confirmation: 'RESTORE staging',
        journalPath,
        now: new Date('2026-09-06T00:05:00.000Z'),
        executor: {
          supports: () => true,
          execute: async (step) => {
            calls.push(step.id)
            return { status: 'completed', evidence: { step_id: step.id } }
          },
        },
      })).rejects.toThrow('journal state is inconsistent')
    }
    expect(calls).toEqual([])
  })

  it('rejects a forged completed restore journal without independent remote read-back', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const journalPath = join(root, 'forged-completed.journal.json')
    const plan = await createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })
    const forgedPostconditions = plan.steps.map((step) => Object.fromEntries([
      ['step_id', step.id],
      ['kind', step.postcondition.kind],
      ['artifact_sha256', step.artifact_sha256],
      ...((step.postcondition.required_digests as string[]).map((field) => [field, 'f'.repeat(64)])),
    ]))
    await writeFile(journalPath, `${JSON.stringify({
      schema: 'sub2api-cloudflare-remote-journal',
      version: 1,
      plan_id: plan.plan_id,
      operation: 'restore',
      environment: 'staging',
      status: 'completed',
      completed_step_ids: plan.steps.map(({ id }) => id),
      failed_step_id: null,
      next_step_id: null,
      verified_postconditions: forgedPostconditions,
      updated_at: '2026-09-06T00:05:00.000Z',
    }, null, 2)}\n`)
    const executeCalls: string[] = []

    await expect(executeRemotePlan({
      plan,
      apply: true,
      confirmation: 'RESTORE staging',
      journalPath,
      now: new Date('2026-09-06T00:05:00.000Z'),
      executor: {
        supports: () => true,
        execute: async (step) => {
          executeCalls.push(step.id)
          return { status: 'completed', evidence: { step_id: step.id } }
        },
      },
    })).rejects.toThrow('independent verifier')
    expect(executeCalls).toEqual([])

    const readbackCalls: string[] = []
    await expect(executeRemotePlan({
      plan,
      apply: true,
      confirmation: 'RESTORE staging',
      journalPath,
      now: new Date('2026-09-06T00:05:00.000Z'),
      executor: {
        supports: () => true,
        execute: async (step) => {
          executeCalls.push(step.id)
          return { status: 'completed', evidence: { step_id: step.id } }
        },
        verify: async (step) => {
          readbackCalls.push(step.id)
          return Object.fromEntries([
            ['status', 'verified'],
            ['step_id', step.id],
            ['kind', step.postcondition.kind],
            ['artifact_sha256', step.artifact_sha256],
            ...((step.postcondition.required_digests as string[]).map((field) => [field, 'e'.repeat(64)])),
          ])
        },
      },
    })).rejects.toThrow('canonical postcondition')
    expect(readbackCalls).toEqual([plan.steps[0].id])
    expect(executeCalls).toEqual([])
  })

  it('rejects a mutated command plan before invoking the executor', async () => {
    const root = await temporaryDirectory()
    const bundleDirectory = await remoteBundle(root)
    const plan = await createRemoteRestorePlan({
      environment: 'staging',
      accountId: 'a'.repeat(32),
      bundleDirectory,
      emptyTargetProof: emptyTargetProof(),
      now: new Date('2026-09-06T00:05:00.000Z'),
    })
    const altered = structuredClone(plan)
    const alteredArguments = altered.steps[0].command!.arguments as string[]
    alteredArguments[2] = 'UNLISTED_DATABASE'
    const calls: string[] = []

    await expect(executeRemotePlan({
      plan: altered,
      apply: true,
      confirmation: 'RESTORE staging',
      journalPath: join(root, 'journal.json'),
      now: new Date('2026-09-06T00:05:00.000Z'),
      executor: {
        supports: () => true,
        execute: async (step) => {
          calls.push(step.id)
          return { status: 'completed', evidence: { step_id: step.id } }
        },
      },
    })).rejects.toThrow('canonical plan')
    expect(calls).toEqual([])
  })
})
