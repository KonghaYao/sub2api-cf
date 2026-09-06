#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { pathToFileURL } from 'node:url'

const MANIFEST_FILENAME = 'backup-manifest.json'
const MANIFEST_SCHEMA = 'sub2api-cloudflare-backup'
const MANIFEST_VERSION = 1
const RESTORE_PLAN_SCHEMA = 'sub2api-cloudflare-restore-plan'
const RESTORE_PLAN_VERSION = 1
const MAX_MANIFEST_BYTES = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const LOGICAL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/
const KINDS = Object.freeze(['d1-sql', 'do-ndjson', 'r2-inventory'])
const KIND_ORDER = new Map(KINDS.map((kind, index) => [kind, index]))
const OPERATIONS = Object.freeze({
  'd1-sql': 'import-d1-sql',
  'do-ndjson': 'import-do-ndjson',
  'r2-inventory': 'reconcile-r2-inventory',
})

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {Record<string, unknown>} value @param {string[]} expected @param {string} label */
function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`)
  }
}

/** @param {unknown} value */
function validateCreatedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error('Manifest created_at must be an RFC 3339 UTC timestamp')
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error('Manifest created_at must be an RFC 3339 UTC timestamp')
  }
  return value
}

/** @param {unknown} value */
function validateKind(value) {
  if (typeof value !== 'string' || !KINDS.includes(value)) {
    throw new Error(`Unsupported artifact kind: ${String(value)}`)
  }
  return value
}

/** @param {unknown} value */
function validateLogicalName(value) {
  if (typeof value !== 'string' || !LOGICAL_NAME.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid artifact logical name: ${String(value)}`)
  }
  return value
}

/** @param {unknown} value */
function validateSource(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Artifact source must be a non-empty printable string of at most 256 characters')
  }
  return value
}

/** @param {string} kind @param {string} logicalName */
function artifactRelativePath(kind, logicalName) {
  return posix.join('artifacts', kind, logicalName)
}

/** @param {string} root @param {string} relativePath */
function resolveInside(root, relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('\\')
    || posix.isAbsolute(relativePath)
    || posix.normalize(relativePath) !== relativePath
    || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid artifact path: ${String(relativePath)}`)
  }
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(absoluteRoot, ...relativePath.split('/'))
  if (!absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Invalid artifact path: ${relativePath}`)
  }
  return absolutePath
}

/** @param {string} path */
async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}

/** @param {string} path @param {string} label */
async function requireRegularFile(path, label) {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`${label} is missing`)
    }
    throw error
  }
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`)
}

/** @param {string} source @param {string} destination */
async function copyAndHash(source, destination) {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow)
  try {
    const initial = await sourceHandle.stat()
    if (!initial.isFile()) throw new Error(`Artifact input must be a regular file: ${source}`)
    const hash = createHash('sha256')
    let bytes = 0
    const digestStream = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      digestStream,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    )
    const final = await sourceHandle.stat()
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || bytes !== final.size) {
      throw new Error(`Artifact changed while it was being copied: ${source}`)
    }
    return { bytes, sha256: hash.digest('hex') }
  } finally {
    await sourceHandle.close()
  }
}

/** @param {string} path */
async function hashFile(path) {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`Bundle artifact must be a regular file: ${path}`)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      hash.update(chunk)
    }
    return { bytes, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

/** @param {string} root */
async function listBundleEntries(root) {
  const rootMetadata = await lstat(root)
  if (rootMetadata.isSymbolicLink()) throw new Error('Bundle directory must not be a symbolic link')
  if (!rootMetadata.isDirectory()) throw new Error('Bundle path must be a directory')
  const entries = []
  const walk = async (directory, prefix) => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name
      const absolutePath = join(directory, child.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        throw new Error(`Bundle entry must not be a symbolic link: ${relativePath}`)
      }
      if (metadata.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory' })
        await walk(absolutePath, relativePath)
      } else if (metadata.isFile()) {
        entries.push({ path: relativePath, type: 'file' })
      } else {
        throw new Error(`Bundle entry must be a regular file or directory: ${relativePath}`)
      }
    }
  }
  await walk(root, '')
  return entries
}

/** @param {unknown} value */
function validateManifest(value) {
  if (!isRecord(value)) throw new Error('Backup manifest must be a JSON object')
  requireExactKeys(value, ['schema', 'version', 'created_at', 'artifacts'], 'Backup manifest')
  if (value.schema !== MANIFEST_SCHEMA || value.version !== MANIFEST_VERSION) {
    throw new Error('Unsupported backup manifest schema or version')
  }
  const createdAt = validateCreatedAt(value.created_at)
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error('Backup manifest must contain at least one artifact')
  }
  const names = new Set()
  const paths = new Set()
  const artifacts = value.artifacts.map((rawArtifact, index) => {
    if (!isRecord(rawArtifact)) throw new Error(`Manifest artifact ${index + 1} must be an object`)
    requireExactKeys(
      rawArtifact,
      ['kind', 'logical_name', 'source', 'path', 'bytes', 'sha256'],
      `Manifest artifact ${index + 1}`,
    )
    const kind = validateKind(rawArtifact.kind)
    const logicalName = validateLogicalName(rawArtifact.logical_name)
    const source = validateSource(rawArtifact.source)
    const expectedPath = artifactRelativePath(kind, logicalName)
    if (rawArtifact.path !== expectedPath) {
      throw new Error(`Invalid artifact path: ${String(rawArtifact.path)}`)
    }
    if (!Number.isSafeInteger(rawArtifact.bytes) || rawArtifact.bytes < 0) {
      throw new Error(`Manifest artifact ${logicalName} has an invalid byte length`)
    }
    if (typeof rawArtifact.sha256 !== 'string' || !SHA256.test(rawArtifact.sha256)) {
      throw new Error(`Manifest artifact ${logicalName} has an invalid SHA-256 digest`)
    }
    const foldedName = logicalName.toLowerCase()
    if (names.has(foldedName)) throw new Error(`Duplicate logical name in manifest: ${logicalName}`)
    if (paths.has(expectedPath)) throw new Error(`Duplicate artifact path in manifest: ${expectedPath}`)
    names.add(foldedName)
    paths.add(expectedPath)
    return Object.freeze({
      kind,
      logical_name: logicalName,
      source,
      path: expectedPath,
      bytes: rawArtifact.bytes,
      sha256: rawArtifact.sha256,
    })
  })
  const canonical = [...artifacts].sort(compareArtifacts)
  if (artifacts.some((artifact, index) => artifact !== canonical[index])) {
    throw new Error('Manifest artifacts must be in canonical kind/name/source order')
  }
  return Object.freeze({
    schema: MANIFEST_SCHEMA,
    version: MANIFEST_VERSION,
    created_at: createdAt,
    artifacts: Object.freeze(artifacts),
  })
}

/** @param {{kind: string, logical_name: string, source: string}} left @param {{kind: string, logical_name: string, source: string}} right */
function compareArtifacts(left, right) {
  return KIND_ORDER.get(left.kind) - KIND_ORDER.get(right.kind)
    || left.logical_name.localeCompare(right.logical_name, 'en')
    || left.source.localeCompare(right.source, 'en')
}

/**
 * Atomically create a self-describing Cloudflare backup bundle.
 *
 * @param {{
 *   outputDirectory: string,
 *   createdAt?: string,
 *   artifacts: Array<{kind: 'd1-sql'|'do-ndjson'|'r2-inventory', logicalName: string, source: string, filePath: string}>,
 * }} options
 */
export async function createBackupBundle(options) {
  if (!isRecord(options) || typeof options.outputDirectory !== 'string') {
    throw new Error('outputDirectory is required')
  }
  if (!Array.isArray(options.artifacts) || options.artifacts.length === 0) {
    throw new Error('At least one artifact is required')
  }
  const outputDirectory = resolve(options.outputDirectory)
  if (await pathExists(outputDirectory)) throw new Error(`Bundle output already exists: ${outputDirectory}`)
  const createdAt = validateCreatedAt(options.createdAt ?? new Date().toISOString())
  const names = new Set()
  const inputs = options.artifacts.map((artifact) => {
    if (!isRecord(artifact)) throw new Error('Artifact input must be an object')
    const kind = validateKind(artifact.kind)
    const logicalName = validateLogicalName(artifact.logicalName)
    const source = validateSource(artifact.source)
    if (typeof artifact.filePath !== 'string' || artifact.filePath.length === 0) {
      throw new Error(`Artifact ${logicalName} requires a file path`)
    }
    const foldedName = logicalName.toLowerCase()
    if (names.has(foldedName)) throw new Error(`Duplicate logical name: ${logicalName}`)
    names.add(foldedName)
    return { kind, logicalName, source, filePath: resolve(artifact.filePath) }
  }).sort((left, right) => compareArtifacts(
    { kind: left.kind, logical_name: left.logicalName, source: left.source },
    { kind: right.kind, logical_name: right.logicalName, source: right.source },
  ))
  await Promise.all(inputs.map((input) => requireRegularFile(input.filePath, `Artifact ${input.logicalName}`)))

  const parent = dirname(outputDirectory)
  await mkdir(parent, { recursive: true })
  const temporaryDirectory = await mkdtemp(join(parent, `.${basename(outputDirectory)}.tmp-`))
  let published = false
  try {
    const artifacts = []
    for (const input of inputs) {
      const relativePath = artifactRelativePath(input.kind, input.logicalName)
      const destination = resolveInside(temporaryDirectory, relativePath)
      await mkdir(dirname(destination), { recursive: true })
      const digest = await copyAndHash(input.filePath, destination)
      artifacts.push({
        kind: input.kind,
        logical_name: input.logicalName,
        source: input.source,
        path: relativePath,
        ...digest,
      })
    }
    const manifest = validateManifest({
      schema: MANIFEST_SCHEMA,
      version: MANIFEST_VERSION,
      created_at: createdAt,
      artifacts,
    })
    await writeFile(
      join(temporaryDirectory, MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    await rename(temporaryDirectory, outputDirectory)
    published = true
    return manifest
  } finally {
    if (!published) await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/** @param {string} bundleDirectory */
export async function verifyBackupBundle(bundleDirectory) {
  if (typeof bundleDirectory !== 'string' || bundleDirectory.length === 0) {
    throw new Error('bundleDirectory is required')
  }
  const root = resolve(bundleDirectory)
  const manifestPath = join(root, MANIFEST_FILENAME)
  await requireRegularFile(manifestPath, 'Backup manifest')
  const manifestMetadata = await lstat(manifestPath)
  if (manifestMetadata.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Backup manifest exceeds ${MAX_MANIFEST_BYTES} bytes`)
  }
  let decoded
  try {
    decoded = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error('Backup manifest is not valid JSON', { cause: error })
  }
  const manifest = validateManifest(decoded)
  const entries = await listBundleEntries(root)
  const expectedFiles = new Set([MANIFEST_FILENAME, ...manifest.artifacts.map((artifact) => artifact.path)])
  const expectedDirectories = new Set(['artifacts'])
  for (const artifact of manifest.artifacts) expectedDirectories.add(posix.dirname(artifact.path))
  for (const entry of entries) {
    const expected = entry.type === 'file' ? expectedFiles : expectedDirectories
    if (!expected.has(entry.path)) throw new Error(`Bundle contains extra ${entry.type}: ${entry.path}`)
    expected.delete(entry.path)
  }
  if (expectedFiles.size > 0) {
    throw new Error(`Bundle is missing file: ${[...expectedFiles].sort()[0]}`)
  }
  if (expectedDirectories.size > 0) {
    throw new Error(`Bundle is missing directory: ${[...expectedDirectories].sort()[0]}`)
  }
  for (const artifact of manifest.artifacts) {
    const absolutePath = resolveInside(root, artifact.path)
    const actual = await hashFile(absolutePath)
    if (actual.bytes !== artifact.bytes) {
      throw new Error(`Artifact byte length mismatch: ${artifact.logical_name}`)
    }
    if (actual.sha256 !== artifact.sha256) {
      throw new Error(`Artifact digest mismatch: ${artifact.logical_name}`)
    }
  }
  return manifest
}

/** @param {ReturnType<typeof validateManifest>} manifest @param {string} bundleDirectory @param {string} targetDirectory */
function restorePlanForManifest(manifest, bundleDirectory, targetDirectory) {
  const bundleRoot = resolve(bundleDirectory)
  const targetRoot = resolve(targetDirectory)
  return Object.freeze({
    schema: RESTORE_PLAN_SCHEMA,
    version: RESTORE_PLAN_VERSION,
    bundle_created_at: manifest.created_at,
    target: targetRoot,
    steps: Object.freeze(manifest.artifacts.map((artifact, index) => {
      const relativeTarget = posix.join(artifact.kind, artifact.logical_name)
      return Object.freeze({
        sequence: index + 1,
        id: `${String(index + 1).padStart(4, '0')}:${artifact.kind}:${artifact.logical_name}`,
        kind: artifact.kind,
        operation: OPERATIONS[artifact.kind],
        source: artifact.source,
        artifact: resolveInside(bundleRoot, artifact.path),
        relative_target: relativeTarget,
        target: resolveInside(targetRoot, relativeTarget),
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      })
    })),
  })
}

/** @param {{bundleDirectory: string, targetDirectory: string}} options */
export async function createRestorePlan(options) {
  if (!isRecord(options) || typeof options.targetDirectory !== 'string' || options.targetDirectory.length === 0) {
    throw new Error('targetDirectory is required')
  }
  const manifest = await verifyBackupBundle(options.bundleDirectory)
  return restorePlanForManifest(manifest, options.bundleDirectory, options.targetDirectory)
}

/** @param {{bundleDirectory: string, targetDirectory: string, dryRun?: boolean}} options */
export async function restoreBackupBundle(options) {
  if (!isRecord(options) || typeof options.targetDirectory !== 'string' || options.targetDirectory.length === 0) {
    throw new Error('targetDirectory is required')
  }
  const manifest = await verifyBackupBundle(options.bundleDirectory)
  const plan = restorePlanForManifest(manifest, options.bundleDirectory, options.targetDirectory)
  if (options.dryRun === true) return plan
  const targetDirectory = resolve(options.targetDirectory)
  if (await pathExists(targetDirectory)) throw new Error(`Restore target already exists: ${targetDirectory}`)
  const parent = dirname(targetDirectory)
  await mkdir(parent, { recursive: true })
  const temporaryDirectory = await mkdtemp(join(parent, `.${basename(targetDirectory)}.tmp-`))
  let published = false
  try {
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const step = plan.steps[index]
      const destination = resolveInside(temporaryDirectory, step.relative_target)
      await mkdir(dirname(destination), { recursive: true })
      const actual = await copyAndHash(resolveInside(options.bundleDirectory, artifact.path), destination)
      if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
        throw new Error(`Artifact changed after verification: ${artifact.logical_name}`)
      }
    }
    await rename(temporaryDirectory, targetDirectory)
    published = true
    return plan
  } finally {
    if (!published) await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/** @param {string[]} args @param {string} cwd */
export function parseCliArguments(args, cwd) {
  const command = args[0]
  if (!['create', 'verify', 'restore-plan', 'restore'].includes(command)) {
    throw new Error('Command must be one of: create, verify, restore-plan, restore')
  }
  let bundle
  let output
  let target
  let createdAt
  let dryRun = false
  const artifacts = []
  const readValue = (index, flag) => {
    const value = args[index]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    return value
  }
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--bundle') {
      bundle = resolve(cwd, readValue(index + 1, argument)); index += 1; continue
    }
    if (argument === '--output') {
      output = resolve(cwd, readValue(index + 1, argument)); index += 1; continue
    }
    if (argument === '--target') {
      target = resolve(cwd, readValue(index + 1, argument)); index += 1; continue
    }
    if (argument === '--created-at') {
      createdAt = readValue(index + 1, argument); index += 1; continue
    }
    if (argument === '--dry-run') {
      if (dryRun) throw new Error('--dry-run may be specified only once')
      dryRun = true; continue
    }
    if (argument === '--artifact') {
      const kind = readValue(index + 1, argument)
      const logicalName = readValue(index + 2, argument)
      const source = readValue(index + 3, argument)
      const filePath = resolve(cwd, readValue(index + 4, argument))
      artifacts.push({ kind, logicalName, source, filePath })
      index += 4
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (command === 'create') {
    if (!output) throw new Error('--output is required for create')
    if (artifacts.length === 0) throw new Error('--artifact is required for create')
    if (bundle || target || dryRun) throw new Error('create accepts only --output, --created-at, and --artifact')
    return { command, outputDirectory: output, ...(createdAt ? { createdAt } : {}), artifacts }
  }
  if (!bundle) throw new Error('--bundle is required')
  if (output || createdAt || artifacts.length > 0) throw new Error(`${command} does not accept create options`)
  if (command === 'verify') {
    if (target || dryRun) throw new Error('verify accepts only --bundle')
    return { command, bundleDirectory: bundle }
  }
  if (!target) throw new Error('--target is required')
  if (command === 'restore-plan' && dryRun) throw new Error('restore-plan is already a dry run')
  return { command, bundleDirectory: bundle, targetDirectory: target, dryRun }
}

async function main() {
  try {
    const cli = parseCliArguments(process.argv.slice(2), process.cwd())
    let result
    if (cli.command === 'create') result = await createBackupBundle(cli)
    else if (cli.command === 'verify') result = await verifyBackupBundle(cli.bundleDirectory)
    else if (cli.command === 'restore-plan') result = await createRestorePlan(cli)
    else result = await restoreBackupBundle(cli)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Backup/restore failed: ${message}\n`)
    process.exitCode = 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) await main()
