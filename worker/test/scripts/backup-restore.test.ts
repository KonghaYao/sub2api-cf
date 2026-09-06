// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { spawnSync } from 'node:child_process'
// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { tmpdir } from 'node:os'
// @ts-expect-error This Node-only CLI test runs outside the Worker runtime.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createBackupBundle,
  createRestorePlan,
  restoreBackupBundle,
  verifyBackupBundle,
} from '../../scripts/backup-restore.mjs'

const scriptPath = decodeURIComponent(
  new URL('../../scripts/backup-restore.mjs', import.meta.url).pathname,
)
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sub2api-backup-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ))
})

async function createSourceArtifacts(root: string) {
  const sourceDirectory = join(root, 'source')
  await mkdir(sourceDirectory)
  const d1 = join(sourceDirectory, 'database.sql')
  const durableObjects = join(sourceDirectory, 'users.ndjson')
  const r2 = join(sourceDirectory, 'objects.ndjson')
  await writeFile(d1, 'CREATE TABLE users(id TEXT PRIMARY KEY);\n', 'utf8')
  await writeFile(durableObjects, '{"id":"u-1","balance":42}\n', 'utf8')
  await writeFile(r2, '{"key":"media/a.png","etag":"abc","size":3}\n', 'utf8')
  return { d1, durableObjects, r2 }
}

async function tamperWithoutChangingLength(path: string): Promise<void> {
  const bytes = await readFile(path)
  bytes[0] = bytes[0] === 0x58 ? 0x59 : 0x58
  await writeFile(path, bytes)
}

function artifactInputs(source: Awaited<ReturnType<typeof createSourceArtifacts>>) {
  return [
    { kind: 'r2-inventory' as const, logicalName: 'media.ndjson', source: 'MEDIA_BUCKET', filePath: source.r2 },
    { kind: 'd1-sql' as const, logicalName: 'primary.sql', source: 'DB', filePath: source.d1 },
    { kind: 'do-ndjson' as const, logicalName: 'users.ndjson', source: 'USER_STATE', filePath: source.durableObjects },
  ]
}

describe('versioned backup bundle', () => {
  it('creates and verifies a deterministic manifest with byte length and SHA-256', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const bundleDirectory = join(root, 'backup.bundle')

    const created = await createBackupBundle({
      outputDirectory: bundleDirectory,
      createdAt: '2026-09-06T00:00:00.000Z',
      artifacts: artifactInputs(source),
    })
    const verified = await verifyBackupBundle(bundleDirectory)

    expect(created).toEqual(verified)
    expect(verified).toEqual({
      schema: 'sub2api-cloudflare-backup',
      version: 1,
      created_at: '2026-09-06T00:00:00.000Z',
      artifacts: [
        {
          kind: 'd1-sql',
          logical_name: 'primary.sql',
          source: 'DB',
          path: 'artifacts/d1-sql/primary.sql',
          bytes: 41,
          sha256: 'd9d5a4f6a257266124099dda3fd184697161cf126a4d94cf94fc4a847c374076',
        },
        {
          kind: 'do-ndjson',
          logical_name: 'users.ndjson',
          source: 'USER_STATE',
          path: 'artifacts/do-ndjson/users.ndjson',
          bytes: 26,
          sha256: '85f946b1289a95859b32281c8bd3a6643b5d84dc92ceb4858295f25581cc4876',
        },
        {
          kind: 'r2-inventory',
          logical_name: 'media.ndjson',
          source: 'MEDIA_BUCKET',
          path: 'artifacts/r2-inventory/media.ndjson',
          bytes: 44,
          sha256: '4c6cabdb80bedb55e7ee2bbd3bb82a1e7e739881be103559cdfe821bafd751c3',
        },
      ],
    })
  })

  it('rejects tampered, missing, and extra files', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)

    for (const failure of ['tampered', 'missing', 'extra'] as const) {
      const bundleDirectory = join(root, `${failure}.bundle`)
      await createBackupBundle({ outputDirectory: bundleDirectory, artifacts: artifactInputs(source) })
      if (failure === 'tampered') {
        await tamperWithoutChangingLength(join(bundleDirectory, 'artifacts/d1-sql/primary.sql'))
      } else if (failure === 'missing') {
        await rm(join(bundleDirectory, 'artifacts/do-ndjson/users.ndjson'))
      } else {
        await writeFile(join(bundleDirectory, 'unexpected.txt'), 'not in manifest')
      }

      await expect(verifyBackupBundle(bundleDirectory)).rejects.toThrow(
        failure === 'tampered' ? 'digest mismatch' : failure,
      )
    }
  })

  it('requires every Cloudflare storage domain in both new and imported manifests', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const incompleteOutput = join(root, 'incomplete.bundle')

    await expect(createBackupBundle({
      outputDirectory: incompleteOutput,
      artifacts: artifactInputs(source).filter(({ kind }) => kind !== 'r2-inventory'),
    })).rejects.toThrow('r2-inventory')
    await expect(readdir(root)).resolves.not.toContain('incomplete.bundle')

    const importedBundle = join(root, 'imported.bundle')
    await createBackupBundle({ outputDirectory: importedBundle, artifacts: artifactInputs(source) })
    const manifestPath = join(importedBundle, 'backup-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.artifacts = manifest.artifacts.filter(
      ({ kind }: { kind: string }) => kind !== 'do-ndjson',
    )
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await rm(join(importedBundle, 'artifacts/do-ndjson/users.ndjson'))
    await rm(join(importedBundle, 'artifacts/do-ndjson'), { recursive: true })

    await expect(verifyBackupBundle(importedBundle)).rejects.toThrow('do-ndjson')
  })

  it('rejects traversal, duplicate names, and symbolic-link inputs before publishing a bundle', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const link = join(root, 'database-link.sql')
    await symlink(source.d1, link)
    const danglingOutput = join(root, 'dangling-output.bundle')
    await symlink(join(root, 'does-not-exist'), danglingOutput)

    await expect(createBackupBundle({
      outputDirectory: join(root, 'traversal.bundle'),
      artifacts: [{ kind: 'd1-sql', logicalName: '../escape.sql', source: 'DB', filePath: source.d1 }],
    })).rejects.toThrow('logical name')
    await expect(createBackupBundle({
      outputDirectory: join(root, 'duplicate.bundle'),
      artifacts: [
        { kind: 'd1-sql', logicalName: 'state.ndjson', source: 'DB', filePath: source.d1 },
        { kind: 'do-ndjson', logicalName: 'state.ndjson', source: 'USER_STATE', filePath: source.durableObjects },
      ],
    })).rejects.toThrow('Duplicate logical name')
    await expect(createBackupBundle({
      outputDirectory: join(root, 'symlink.bundle'),
      artifacts: [{ kind: 'd1-sql', logicalName: 'primary.sql', source: 'DB', filePath: link }],
    })).rejects.toThrow('symbolic link')
    await expect(createBackupBundle({
      outputDirectory: danglingOutput,
      artifacts: artifactInputs(source),
    })).rejects.toThrow('already exists')

    await expect(readdir(root)).resolves.not.toContain('traversal.bundle')
    await expect(readdir(root)).resolves.not.toContain('duplicate.bundle')
    await expect(readdir(root)).resolves.not.toContain('symlink.bundle')
  })

  it('rejects unsafe manifest paths and symbolic links inside a bundle', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const traversalBundle = join(root, 'traversal.bundle')
    await createBackupBundle({ outputDirectory: traversalBundle, artifacts: artifactInputs(source) })
    const manifestPath = join(traversalBundle, 'backup-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.artifacts[0].path = '../outside.sql'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await expect(verifyBackupBundle(traversalBundle)).rejects.toThrow('artifact path')

    const symlinkBundle = join(root, 'symlink.bundle')
    await createBackupBundle({ outputDirectory: symlinkBundle, artifacts: artifactInputs(source) })
    const artifactPath = join(symlinkBundle, 'artifacts/d1-sql/primary.sql')
    await rm(artifactPath)
    await symlink(source.d1, artifactPath)
    await expect(verifyBackupBundle(symlinkBundle)).rejects.toThrow('symbolic link')
  })

  it('does not publish a partial bundle when an input disappears', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const missing = join(root, 'source/missing.ndjson')
    const outputDirectory = join(root, 'partial.bundle')

    await expect(createBackupBundle({
      outputDirectory,
      artifacts: [
        ...artifactInputs(source),
        { kind: 'do-ndjson', logicalName: 'missing.ndjson', source: 'POOL_STATE', filePath: missing },
      ],
    })).rejects.toThrow()

    await expect(readdir(root)).resolves.not.toContain('partial.bundle')
    expect((await readdir(root)).some((name: string) => name.startsWith('.partial.bundle.tmp-'))).toBe(false)
  })

  it('rejects an artifact set that cannot fit the bounded manifest', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const outputDirectory = join(root, 'oversized.bundle')
    const artifacts = Array.from({ length: 4_097 }, (_unused, index) => ({
      kind: 'do-ndjson' as const,
      logicalName: `ledger-${String(index).padStart(4, '0')}.ndjson`,
      source: 'USER_STATE',
      filePath: source.durableObjects,
    }))

    await expect(createBackupBundle({ outputDirectory, artifacts })).rejects.toThrow(
      'at most 4096 artifacts',
    )
    await expect(readdir(root)).resolves.not.toContain('oversized.bundle')
  })

  it('rejects an interrupted bundle directory that has artifacts but no manifest', async () => {
    const root = await temporaryDirectory()
    const interrupted = join(root, 'interrupted.bundle')
    await mkdir(join(interrupted, 'artifacts/d1-sql'), { recursive: true })
    await writeFile(join(interrupted, 'artifacts/d1-sql/primary.sql'), 'partial')

    await expect(verifyBackupBundle(interrupted)).rejects.toThrow('Backup manifest')
  })
})

describe('fail-closed restore plan', () => {
  it('rejects a restore target inside the source bundle', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const bundleDirectory = join(root, 'backup.bundle')
    await createBackupBundle({ outputDirectory: bundleDirectory, artifacts: artifactInputs(source) })
    const nestedTarget = join(bundleDirectory, 'restored')

    await expect(createRestorePlan({ bundleDirectory, targetDirectory: nestedTarget }))
      .rejects.toThrow('inside the backup bundle')
    await expect(restoreBackupBundle({ bundleDirectory, targetDirectory: nestedTarget }))
      .rejects.toThrow('inside the backup bundle')
    await expect(verifyBackupBundle(bundleDirectory)).resolves.toBeDefined()

    const bundleAlias = join(root, 'bundle-alias')
    await symlink(bundleDirectory, bundleAlias)
    const aliasedTarget = join(bundleAlias, 'restored-through-alias')
    await expect(createRestorePlan({ bundleDirectory, targetDirectory: aliasedTarget }))
      .rejects.toThrow('inside the backup bundle')
    await expect(restoreBackupBundle({ bundleDirectory, targetDirectory: aliasedTarget }))
      .rejects.toThrow('inside the backup bundle')
    await expect(verifyBackupBundle(bundleDirectory)).resolves.toBeDefined()
  })

  it('orders D1, Durable Object, and R2 artifacts and restores them byte-for-byte', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const bundleDirectory = join(root, 'backup.bundle')
    const targetDirectory = join(root, 'restored')
    await createBackupBundle({ outputDirectory: bundleDirectory, artifacts: artifactInputs(source) })

    const plan = await createRestorePlan({ bundleDirectory, targetDirectory })
    expect(plan.steps.map(({ sequence, kind, operation, relative_target }) => ({
      sequence,
      kind,
      operation,
      relative_target,
    }))).toEqual([
      { sequence: 1, kind: 'd1-sql', operation: 'import-d1-sql', relative_target: 'd1-sql/primary.sql' },
      { sequence: 2, kind: 'do-ndjson', operation: 'import-do-ndjson', relative_target: 'do-ndjson/users.ndjson' },
      { sequence: 3, kind: 'r2-inventory', operation: 'reconcile-r2-inventory', relative_target: 'r2-inventory/media.ndjson' },
    ])

    const dryRun = await restoreBackupBundle({ bundleDirectory, targetDirectory, dryRun: true })
    expect(dryRun).toEqual(plan)
    await expect(readdir(root)).resolves.not.toContain('restored')

    await restoreBackupBundle({ bundleDirectory, targetDirectory })
    await expect(readFile(join(targetDirectory, 'd1-sql/primary.sql'))).resolves.toEqual(
      await readFile(source.d1),
    )
    await expect(readFile(join(targetDirectory, 'do-ndjson/users.ndjson'))).resolves.toEqual(
      await readFile(source.durableObjects),
    )
    await expect(readFile(join(targetDirectory, 'r2-inventory/media.ndjson'))).resolves.toEqual(
      await readFile(source.r2),
    )
  })

  it('verifies every artifact before making any restore write', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const bundleDirectory = join(root, 'backup.bundle')
    const targetDirectory = join(root, 'must-not-exist')
    await createBackupBundle({ outputDirectory: bundleDirectory, artifacts: artifactInputs(source) })
    await tamperWithoutChangingLength(join(bundleDirectory, 'artifacts/r2-inventory/media.ndjson'))

    await expect(restoreBackupBundle({ bundleDirectory, targetDirectory })).rejects.toThrow(
      'digest mismatch',
    )
    await expect(readdir(root)).resolves.not.toContain('must-not-exist')
    expect((await readdir(root)).some((name: string) => name.startsWith('.must-not-exist.tmp-'))).toBe(false)
  })
})

describe('backup CLI', () => {
  it('creates and verifies a bundle using repeated four-part artifact arguments', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const bundleDirectory = join(root, 'cli.bundle')
    const create = spawnSync(process.execPath, [
      scriptPath,
      'create',
      '--output', bundleDirectory,
      '--created-at', '2026-09-06T00:00:00.000Z',
      '--artifact', 'd1-sql', 'primary.sql', 'DB', source.d1,
      '--artifact', 'do-ndjson', 'users.ndjson', 'USER_STATE', source.durableObjects,
      '--artifact', 'r2-inventory', 'media.ndjson', 'MEDIA_BUCKET', source.r2,
    ], { encoding: 'utf8', shell: false })

    expect(create.status).toBe(0)
    expect(JSON.parse(create.stdout).artifacts).toHaveLength(3)
    const verify = spawnSync(process.execPath, [scriptPath, 'verify', '--bundle', bundleDirectory], {
      encoding: 'utf8',
      shell: false,
    })
    expect(verify.status).toBe(0)
    expect(JSON.parse(verify.stdout).created_at).toBe('2026-09-06T00:00:00.000Z')
  })

  it('reports verification failures with a non-zero exit code', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const bundleDirectory = join(root, 'backup.bundle')
    await createBackupBundle({ outputDirectory: bundleDirectory, artifacts: artifactInputs(source) })
    await tamperWithoutChangingLength(join(bundleDirectory, 'artifacts/d1-sql/primary.sql'))

    const result = spawnSync(process.execPath, [scriptPath, 'verify', '--bundle', bundleDirectory], {
      encoding: 'utf8',
      shell: false,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('digest mismatch')
  })

  it('requires an explicit local restore target and prints a dry-run plan', async () => {
    const root = await temporaryDirectory()
    const source = await createSourceArtifacts(root)
    const bundleDirectory = join(root, 'backup.bundle')
    await createBackupBundle({ outputDirectory: bundleDirectory, artifacts: artifactInputs(source) })

    const missingTarget = spawnSync(process.execPath, [scriptPath, 'restore-plan', '--bundle', bundleDirectory], {
      encoding: 'utf8',
      shell: false,
    })
    expect(missingTarget.status).toBe(1)
    expect(missingTarget.stderr).toContain('--target is required')

    const targetDirectory = join(root, 'restored')
    const dryRun = spawnSync(process.execPath, [
      scriptPath,
      'restore',
      '--bundle', bundleDirectory,
      '--target', targetDirectory,
      '--dry-run',
    ], { encoding: 'utf8', shell: false })
    expect(dryRun.status).toBe(0)
    expect(JSON.parse(dryRun.stdout).steps).toHaveLength(3)
    await expect(readdir(root)).resolves.not.toContain('restored')
  })
})
