#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { createBackupBundle, verifyBackupBundle } from './backup-restore.mjs'

const PLAN_SCHEMA = 'sub2api-cloudflare-remote-plan'
const PLAN_VERSION = 1
const PROOF_SCHEMA = 'sub2api-cloudflare-empty-target-proof'
const PROOF_VERSION = 1
const JOURNAL_SCHEMA = 'sub2api-cloudflare-remote-journal'
const JOURNAL_VERSION = 1
const MAX_PROOF_AGE_MS = 15 * 60 * 1_000
const ACCOUNT_ID = /^[a-f0-9]{32}$/
const OBJECT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9_-])?$/
const LOGICAL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/
const SHA256 = /^[a-f0-9]{64}$/
const PUBLISH_STEP_ID = 'publish-backup-bundle'

const ENVIRONMENTS = Object.freeze({
  staging: Object.freeze({
    d1: Object.freeze({ binding: 'DB', databaseName: 'sub2api-staging' }),
    durableObjectNamespaces: Object.freeze([
      'USER_STATE',
      'SUBSCRIPTION_STATE',
      'POOL_STATE',
      'AUTH_RATE_LIMIT',
      'API_KEY_LIMIT_STATE',
    ]),
    r2: Object.freeze({ binding: 'OBJECTS', bucketName: 'sub2api-staging' }),
    workerService: 'sub2api-worker-staging',
    workerOrigin: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
  }),
  production: Object.freeze({
    d1: Object.freeze({ binding: 'DB', databaseName: 'sub2api-production' }),
    durableObjectNamespaces: Object.freeze([
      'USER_STATE',
      'SUBSCRIPTION_STATE',
      'POOL_STATE',
      'AUTH_RATE_LIMIT',
      'API_KEY_LIMIT_STATE',
    ]),
    r2: Object.freeze({ binding: 'OBJECTS', bucketName: 'sub2api-production' }),
    workerService: 'sub2api-worker-production',
    workerOrigin: 'https://sub2api-worker-production.claude-code-best.workers.dev',
  }),
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

/** @param {unknown} environment */
function resourcesFor(environment) {
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error('Remote environment must be staging or production')
  }
  return ENVIRONMENTS[environment]
}

/** @param {unknown} accountId */
function validateAccountId(accountId) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
    throw new Error('Cloudflare accountId must be 32 lowercase hexadecimal characters')
  }
  return accountId
}

/** @param {unknown} value @param {string} label */
function validateObjectId(value, label = 'Durable Object objectId') {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new Error(`${label} is invalid`)
  return value
}

/** @param {unknown} value */
function validateLogicalName(value) {
  if (typeof value !== 'string' || !LOGICAL_NAME.test(value) || value === '.' || value === '..') {
    throw new Error('Durable Object logicalName is invalid')
  }
  return value
}

/** @param {unknown} value @param {readonly string[]} allowlist */
function validateNamespace(value, allowlist) {
  if (typeof value !== 'string' || !allowlist.includes(value)) {
    throw new Error(`Durable Object namespace is not allow-listed: ${String(value)}`)
  }
  return value
}

/** @param {unknown} value */
function timestamp(value) {
  if (typeof value !== 'string') throw new Error('Timestamp must be RFC 3339 UTC')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error('Timestamp must be RFC 3339 UTC')
  }
  return parsed
}

/** @param {unknown} value */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** @param {Record<string, unknown>} unsigned */
function finishPlan(unsigned) {
  return Object.freeze({
    ...unsigned,
    plan_id: digest(unsigned),
    steps: Object.freeze(unsigned.steps),
  })
}

/**
 * Create an auditable plan for exporting remote data. API contracts are
 * intentionally not treated as executable unless an injected executor says it
 * implements them.
 *
 * @param {{
 *   environment: 'staging'|'production', accountId: string,
 *   workingDirectory: string, bundleDirectory: string,
 *   durableObjects: Array<{namespace: string, objectId: string, logicalName: string}>
 * }} options
 */
export function createRemoteBackupPlan(options) {
  if (!isRecord(options)) throw new Error('Remote backup options are required')
  const resources = resourcesFor(options.environment)
  const accountId = validateAccountId(options.accountId)
  if (typeof options.workingDirectory !== 'string' || options.workingDirectory.length === 0) {
    throw new Error('workingDirectory is required')
  }
  if (typeof options.bundleDirectory !== 'string' || options.bundleDirectory.length === 0) {
    throw new Error('bundleDirectory is required')
  }
  if (!Array.isArray(options.durableObjects) || options.durableObjects.length === 0) {
    throw new Error('At least one Durable Object must be selected explicitly')
  }
  const workingDirectory = resolve(options.workingDirectory)
  const seen = new Set()
  const logicalNames = new Set(['primary.sql', 'objects.ndjson'])
  const durableObjects = options.durableObjects.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('Durable Object selection must be an object')
    const namespace = validateNamespace(candidate.namespace, resources.durableObjectNamespaces)
    const objectId = validateObjectId(candidate.objectId)
    const logicalName = validateLogicalName(candidate.logicalName)
    const foldedLogicalName = logicalName.toLowerCase()
    if ([...logicalNames].some((name) => name.toLowerCase() === foldedLogicalName)) {
      throw new Error(`Durable Object logicalName is reserved or duplicate: ${logicalName}`)
    }
    logicalNames.add(logicalName)
    const identity = `${namespace}:${objectId}`
    if (seen.has(identity)) throw new Error(`Duplicate Durable Object selection: ${identity}`)
    seen.add(identity)
    return { namespace, objectId, logicalName }
  }).sort((left, right) => `${left.namespace}:${left.objectId}`.localeCompare(`${right.namespace}:${right.objectId}`, 'en'))

  const steps = [{
    sequence: 1,
    id: `backup:d1:${resources.d1.binding}`,
    phase: 'd1',
    operation: 'export-d1-sql',
    transport: 'command',
    resource: resources.d1,
    command: {
      executable: 'wrangler',
      arguments: [
        'd1', 'export', resources.d1.binding,
        '--remote', '--env', options.environment,
        '--output', join(workingDirectory, 'primary.sql'),
      ],
    },
    output: join(workingDirectory, 'primary.sql'),
    artifact: { kind: 'd1-sql', logicalName: 'primary.sql', source: resources.d1.binding },
    postcondition: { kind: 'd1-export-artifact-proof', verification: 'sha256-local-readback' },
  }]
  for (const durableObject of durableObjects) {
    const output = join(workingDirectory, durableObject.logicalName)
    const hasWorkerHttpTransport = durableObject.namespace === 'USER_STATE'
    steps.push({
      sequence: steps.length + 1,
      id: `backup:do:${durableObject.namespace}:${durableObject.objectId}`,
      phase: 'durable-objects',
      operation: 'export-durable-object-ndjson',
      transport: hasWorkerHttpTransport ? 'worker-http' : 'api-contract',
      ...(hasWorkerHttpTransport
        ? { environment: options.environment }
        : { contract_only: true }),
      resource: { namespace: durableObject.namespace, objectId: durableObject.objectId },
      request: {
        method: 'POST',
        service: resources.workerService,
        origin: resources.workerOrigin,
        path: `/internal/backup/durable-objects/${durableObject.namespace}/${encodeURIComponent(durableObject.objectId)}/export`,
        response_format: 'ndjson',
        authentication: 'operator-service-token',
      },
      output,
      artifact: {
        kind: 'do-ndjson',
        logicalName: durableObject.logicalName,
        source: `${durableObject.namespace}:${durableObject.objectId}`,
      },
      postcondition: {
        kind: 'durable-objects-inventory-state-digest',
        verification: 'remote-readback-and-sha256-local-readback',
        required_digests: ['remote_inventory_digest', 'remote_state_digest'],
      },
    })
  }
  const r2Output = join(workingDirectory, 'objects.ndjson')
  steps.push({
    sequence: steps.length + 1,
    id: `backup:r2:${resources.r2.binding}`,
    phase: 'r2',
    operation: 'inventory-r2',
    transport: 'api-contract',
    contract_only: true,
    resource: resources.r2,
    request: {
      method: 'GET',
      api: 'cloudflare-r2-inventory-adapter',
      path: `/accounts/${accountId}/r2/buckets/${resources.r2.bucketName}/objects`,
      pagination: 'cursor-until-exhausted',
      response_format: 'canonical-ndjson-inventory',
      authentication: 'cloudflare-api-token',
    },
    output: r2Output,
    artifact: { kind: 'r2-inventory', logicalName: 'objects.ndjson', source: resources.r2.binding },
    postcondition: {
      kind: 'r2-inventory-object-digest',
      verification: 'remote-readback-and-sha256-local-readback',
      required_digests: ['remote_inventory_digest', 'remote_object_digest'],
    },
  })

  return finishPlan({
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    operation: 'backup',
    environment: options.environment,
    dry_run: true,
    account_id: accountId,
    working_directory: workingDirectory,
    bundle_directory: resolve(options.bundleDirectory),
    steps,
  })
}

/** @param {unknown} proof @param {'staging'|'production'} environment @param {string} accountId @param {ReturnType<typeof resourcesFor>} resources @param {Array<{namespace: string, objectId: string}>} expectedObjects @param {Date} now @param {boolean} requireFresh */
function validateEmptyTargetProof(proof, environment, accountId, resources, expectedObjects, now, requireFresh) {
  if (!isRecord(proof)) throw new Error('Empty-target proof is required')
  requireExactKeys(
    proof,
    ['schema', 'version', 'environment', 'account_id', 'checked_at', 'd1', 'durable_objects', 'r2'],
    'Empty-target proof',
  )
  if (proof.schema !== PROOF_SCHEMA || proof.version !== PROOF_VERSION) {
    throw new Error('Unsupported empty-target proof schema or version')
  }
  if (proof.environment !== environment) throw new Error('Empty-target proof environment does not match')
  if (validateAccountId(proof.account_id) !== accountId) {
    throw new Error('Empty-target proof account_id does not match the restore account')
  }
  const checkedAt = timestamp(proof.checked_at)
  if (checkedAt.valueOf() > now.valueOf()) throw new Error('Empty-target proof is from the future')
  if (requireFresh && now.valueOf() - checkedAt.valueOf() > MAX_PROOF_AGE_MS) {
    throw new Error('Empty-target proof is older than 15 minutes')
  }
  if (!isRecord(proof.d1)) throw new Error('D1 empty-target proof is required')
  requireExactKeys(proof.d1, ['binding', 'database_name', 'user_table_count'], 'D1 empty-target proof')
  if (
    proof.d1.binding !== resources.d1.binding
    || proof.d1.database_name !== resources.d1.databaseName
    || proof.d1.user_table_count !== 0
  ) {
    throw new Error('D1 empty-target proof does not prove the allow-listed database is empty')
  }
  if (!Array.isArray(proof.durable_objects)) throw new Error('Durable Object empty-target proof is required')
  const provenObjects = new Set()
  for (const candidate of proof.durable_objects) {
    if (!isRecord(candidate)) throw new Error('Durable Object empty-target proof entry must be an object')
    requireExactKeys(candidate, ['namespace', 'object_id', 'storage_entry_count'], 'Durable Object empty-target proof entry')
    const namespace = validateNamespace(candidate.namespace, resources.durableObjectNamespaces)
    const objectId = validateObjectId(candidate.object_id, 'Durable Object proof object_id')
    if (candidate.storage_entry_count !== 0) throw new Error(`Durable Object target is not empty: ${namespace}:${objectId}`)
    const identity = `${namespace}:${objectId}`
    if (provenObjects.has(identity)) throw new Error(`Duplicate Durable Object empty-target proof: ${identity}`)
    provenObjects.add(identity)
  }
  for (const expected of expectedObjects) {
    const identity = `${expected.namespace}:${expected.objectId}`
    if (!provenObjects.has(identity)) throw new Error(`Restore is missing empty-target proof for ${identity}`)
  }
  if (provenObjects.size !== expectedObjects.length) {
    throw new Error('Empty-target proof contains a Durable Object outside this restore plan')
  }
  if (!isRecord(proof.r2)) throw new Error('R2 empty-target proof is required')
  requireExactKeys(proof.r2, ['binding', 'bucket_name', 'object_count'], 'R2 empty-target proof')
  if (
    proof.r2.binding !== resources.r2.binding
    || proof.r2.bucket_name !== resources.r2.bucketName
    || proof.r2.object_count !== 0
  ) {
    throw new Error('R2 empty-target proof does not prove the allow-listed bucket is empty')
  }
  return proof
}

/** @param {string} source @param {readonly string[]} namespaces */
function parseDurableObjectSource(source, namespaces) {
  if (typeof source !== 'string') throw new Error('Durable Object artifact source is invalid')
  const separator = source.indexOf(':')
  if (separator <= 0) throw new Error(`Durable Object source must be NAMESPACE:OBJECT_ID: ${source}`)
  const namespace = validateNamespace(source.slice(0, separator), namespaces)
  const objectId = validateObjectId(source.slice(separator + 1))
  return { namespace, objectId }
}

/**
 * @param {{
 *   environment: 'staging'|'production', accountId: string, bundleDirectory: string,
 *   emptyTargetProof: unknown, now?: Date
 * }} options
 */
export async function createRemoteRestorePlan(options) {
  if (!isRecord(options)) throw new Error('Remote restore options are required')
  if (typeof options.bundleDirectory !== 'string' || options.bundleDirectory.length === 0) {
    throw new Error('bundleDirectory is required')
  }
  // Integrity verification deliberately precedes proof parsing and all remote planning.
  const manifest = await verifyBackupBundle(options.bundleDirectory)
  if (manifest.artifacts.filter(({ kind }) => kind === 'd1-sql').length !== 1) {
    throw new Error('Remote restore requires exactly one D1 SQL artifact')
  }
  if (manifest.artifacts.filter(({ kind }) => kind === 'r2-inventory').length !== 1) {
    throw new Error('Remote restore requires exactly one R2 inventory artifact')
  }
  const resources = resourcesFor(options.environment)
  const accountId = validateAccountId(options.accountId)
  const bundleDirectory = resolve(options.bundleDirectory)
  const durableObjects = manifest.artifacts
    .filter(({ kind }) => kind === 'do-ndjson')
    .map(({ source }) => parseDurableObjectSource(source, resources.durableObjectNamespaces))
  if (new Set(durableObjects.map(({ namespace, objectId }) => `${namespace}:${objectId}`)).size !== durableObjects.length) {
    throw new Error('Remote restore contains duplicate artifacts for one Durable Object')
  }
  const now = options.now instanceof Date ? options.now : new Date()
  const proof = validateEmptyTargetProof(
    options.emptyTargetProof,
    options.environment,
    accountId,
    resources,
    durableObjects,
    now,
    true,
  )

  const steps = manifest.artifacts.map((artifact, index) => {
    const common = {
      sequence: index + 1,
      artifact: resolve(bundleDirectory, artifact.path),
      artifact_sha256: artifact.sha256,
      artifact_bytes: artifact.bytes,
    }
    if (artifact.kind === 'd1-sql') {
      if (artifact.source !== resources.d1.binding) {
        throw new Error(`D1 source is not allow-listed for ${options.environment}: ${artifact.source}`)
      }
      return {
        ...common,
        id: `restore:d1:${resources.d1.binding}:${artifact.logical_name}`,
        phase: 'd1',
        operation: 'import-d1-sql',
        transport: 'command',
        resource: resources.d1,
        command: {
          executable: 'wrangler',
          arguments: [
            'd1', 'execute', resources.d1.binding,
            '--remote', '--env', options.environment,
            '--file', common.artifact,
          ],
        },
        postcondition: {
          kind: 'd1-schema-data-digest',
          verification: 'remote-readback',
          required_digests: ['remote_schema_digest', 'remote_data_digest'],
        },
      }
    }
    if (artifact.kind === 'do-ndjson') {
      const { namespace, objectId } = parseDurableObjectSource(artifact.source, resources.durableObjectNamespaces)
      const hasWorkerHttpTransport = namespace === 'USER_STATE'
      return {
        ...common,
        id: `restore:do:${namespace}:${objectId}:${artifact.logical_name}`,
        phase: 'durable-objects',
        operation: 'restore-durable-object-ndjson',
        transport: hasWorkerHttpTransport ? 'worker-http' : 'api-contract',
        ...(hasWorkerHttpTransport
          ? { environment: options.environment }
          : { contract_only: true }),
        resource: { namespace, objectId },
        request: {
          method: 'POST',
          service: resources.workerService,
          origin: resources.workerOrigin,
          path: `/internal/backup/durable-objects/${namespace}/${encodeURIComponent(objectId)}/restore`,
          request_format: 'ndjson',
          body_file: common.artifact,
          authentication: 'operator-service-token',
          precondition: 'empty-object-storage',
        },
        postcondition: {
          kind: 'durable-objects-inventory-state-digest',
          verification: 'remote-readback',
          required_digests: ['remote_inventory_digest', 'remote_state_digest'],
        },
      }
    }
    if (artifact.source !== resources.r2.binding) {
      throw new Error(`R2 source is not allow-listed for ${options.environment}: ${artifact.source}`)
    }
    return {
      ...common,
      id: `restore:r2:${resources.r2.binding}:${artifact.logical_name}`,
      phase: 'r2',
      operation: 'reconcile-r2-inventory',
      transport: 'api-contract',
      contract_only: true,
      resource: resources.r2,
      request: {
        method: 'POST',
        api: 'cloudflare-v4-adapter',
        path: `/accounts/${accountId}/r2/buckets/${resources.r2.bucketName}/reconcile`,
        request_format: 'canonical-ndjson-inventory-with-content-locator',
        body_file: common.artifact,
        authentication: 'cloudflare-api-token',
        precondition: 'empty-bucket',
        fail_if_content_locator_missing: true,
      },
      postcondition: {
        kind: 'r2-inventory-object-digest',
        verification: 'remote-readback',
        required_digests: ['remote_inventory_digest', 'remote_object_digest'],
      },
    }
  })

  return finishPlan({
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    operation: 'restore',
    environment: options.environment,
    dry_run: true,
    account_id: accountId,
    bundle_directory: bundleDirectory,
    manifest_sha256: digest(manifest),
    empty_target_proof: proof,
    empty_target_proof_sha256: digest(proof),
    steps,
  })
}

/** @param {string} journalPath */
async function readJournal(journalPath) {
  try {
    return JSON.parse(await readFile(journalPath, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw new Error('Remote journal is not valid JSON', { cause: error })
  }
}

/** @param {string} journalPath @param {unknown} journal */
async function writeJournal(journalPath, journal) {
  await mkdir(dirname(journalPath), { recursive: true })
  const temporaryPath = `${journalPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, journalPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

/** @param {unknown} raw @param {Record<string, unknown>} plan */
function validateJournal(raw, plan) {
  if (!isRecord(raw)) throw new Error('Remote journal must be a JSON object')
  requireExactKeys(
    raw,
    ['schema', 'version', 'plan_id', 'operation', 'environment', 'status', 'completed_step_ids', 'failed_step_id', 'next_step_id', 'verified_postconditions', 'updated_at'],
    'Remote journal',
  )
  if (raw.schema !== JOURNAL_SCHEMA || raw.version !== JOURNAL_VERSION) throw new Error('Unsupported remote journal')
  if (raw.plan_id !== plan.plan_id || raw.operation !== plan.operation || raw.environment !== plan.environment) {
    throw new Error('Remote journal belongs to a different plan')
  }
  if (!['running', 'failed', 'publishing', 'completed'].includes(raw.status)) throw new Error('Remote journal status is invalid')
  if (!Array.isArray(raw.completed_step_ids) || !raw.completed_step_ids.every((id) => typeof id === 'string')) {
    throw new Error('Remote journal completed steps are invalid')
  }
  const planIds = plan.steps.map(({ id }) => id)
  if (raw.completed_step_ids.some((id, index) => id !== planIds[index])) {
    throw new Error('Remote journal completed steps are not a valid plan prefix')
  }
  const completedAllSteps = raw.completed_step_ids.length === planIds.length
  const nextStepId = planIds[raw.completed_step_ids.length]
  if (!Array.isArray(raw.verified_postconditions) || raw.verified_postconditions.length !== raw.completed_step_ids.length) {
    throw new Error('Remote journal state is inconsistent with verified postconditions')
  }
  const ordinaryNextMatches = raw.next_step_id === (nextStepId ?? null)
  const consistent = raw.status === 'completed'
    ? completedAllSteps && raw.next_step_id === null && raw.failed_step_id === null
    : raw.status === 'publishing'
      ? plan.operation === 'backup' && completedAllSteps
        && raw.next_step_id === PUBLISH_STEP_ID && raw.failed_step_id === null
      : raw.status === 'running'
        ? ordinaryNextMatches && !completedAllSteps && raw.failed_step_id === null
        : plan.operation === 'backup' && completedAllSteps
          ? raw.next_step_id === PUBLISH_STEP_ID && raw.failed_step_id === PUBLISH_STEP_ID
          : ordinaryNextMatches && !completedAllSteps && raw.failed_step_id === nextStepId
  if (!consistent) {
    throw new Error('Remote journal state is inconsistent with the completed plan prefix')
  }
  timestamp(raw.updated_at)
  return raw
}

/** @param {string} path */
async function hashRemoteArtifact(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`Remote adapter output must be a regular file: ${path}`)
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

/** @param {Record<string, any>} step @param {Record<string, any>} proof @param {Record<string, any>} executor */
async function verifyContractReadback(step, proof, executor) {
  if (typeof executor.verify !== 'function') {
    throw new Error(`Remote executor has no independent verifier for completed contract step: ${step.id}`)
  }
  const requiredDigests = step.postcondition.required_digests ?? []
  const result = await executor.verify(step)
  if (!isRecord(result)) throw new Error(`Remote verifier returned no read-back proof: ${step.id}`)
  requireExactKeys(
    result,
    ['status', 'step_id', 'kind', 'artifact_sha256', ...requiredDigests],
    'Remote contract read-back',
  )
  if (
    result.status !== 'verified'
    || result.step_id !== step.id
    || result.kind !== step.postcondition.kind
    || result.artifact_sha256 !== proof.sha256
    || requiredDigests.some((field) => result[field] !== proof[field])
  ) {
    throw new Error(`Remote contract read-back does not match the journal postcondition: ${step.id}`)
  }
}

/** @param {Record<string, any>} step @param {Record<string, any>} proof @param {Record<string, any>} executor */
async function verifyCompletedRestoreReadback(step, proof, executor) {
  if (await executor.supports(step) !== true) {
    throw new Error(`Remote executor cannot verify completed restore step: ${step.id}`)
  }
  if (typeof executor.verify !== 'function') {
    throw new Error(`Remote executor has no independent verifier for completed restore step: ${step.id}`)
  }
  const requiredDigests = step.postcondition.required_digests
  const result = await executor.verify(step)
  if (!isRecord(result)) throw new Error(`Remote verifier returned no restore read-back proof: ${step.id}`)
  requireExactKeys(
    result,
    ['status', 'step_id', 'kind', 'artifact_sha256', ...requiredDigests],
    'Completed restore read-back',
  )
  if (
    result.status !== 'verified'
    || result.step_id !== step.id
    || result.kind !== step.postcondition.kind
    || result.artifact_sha256 !== step.artifact_sha256
    || result.artifact_sha256 !== proof.artifact_sha256
    || requiredDigests.some((field) => (
      typeof result[field] !== 'string'
      || !SHA256.test(result[field])
      || result[field] !== proof[field]
    ))
  ) {
    throw new Error(`Completed restore read-back does not match its canonical postcondition: ${step.id}`)
  }
}

/** @param {Record<string, any>} plan @param {Record<string, any>} journal @param {Record<string, any>} executor */
async function verifyJournalPostconditions(plan, journal, executor) {
  for (const [index, proof] of journal.verified_postconditions.entries()) {
    const step = plan.steps[index]
    if (!isRecord(proof) || proof.step_id !== step.id || proof.kind !== step.postcondition.kind) {
      throw new Error('Remote journal has an invalid verified postcondition')
    }
    if (plan.operation === 'backup') {
      const requiredDigests = step.postcondition.required_digests ?? []
      requireExactKeys(
        proof,
        ['step_id', 'kind', 'artifact_path', 'bytes', 'sha256', ...requiredDigests],
        'Backup postcondition',
      )
      if (
        proof.artifact_path !== step.output
        || !Number.isSafeInteger(proof.bytes)
        || proof.bytes < 0
        || !SHA256.test(proof.sha256)
        || requiredDigests.some((field) => typeof proof[field] !== 'string' || !SHA256.test(proof[field]))
      ) {
        throw new Error('Remote journal has an invalid backup artifact proof')
      }
      const actual = await hashRemoteArtifact(step.output)
      if (actual.bytes !== proof.bytes || actual.sha256 !== proof.sha256) {
        throw new Error(`Remote adapter output no longer matches its verified postcondition: ${step.id}`)
      }
      if (step.contract_only === true || step.transport === 'worker-http') {
        await verifyContractReadback(step, proof, executor)
      }
    } else {
      const requiredDigests = step.postcondition.required_digests
      requireExactKeys(
        proof,
        ['step_id', 'kind', 'artifact_sha256', ...requiredDigests],
        'Restore postcondition',
      )
      if (
        proof.artifact_sha256 !== step.artifact_sha256
        || requiredDigests.some((field) => typeof proof[field] !== 'string' || !SHA256.test(proof[field]))
      ) {
        throw new Error(`Remote journal has an invalid restore postcondition: ${step.id}`)
      }
      await verifyCompletedRestoreReadback(step, proof, executor)
    }
  }
}

/** @param {Record<string, any>} plan @param {Record<string, any>} journal */
async function verifyPublishedBackupBundle(plan, journal) {
  if (!(await pathExists(plan.bundle_directory))) {
    throw new Error('Completed backup bundle is missing')
  }
  const manifest = await verifyBackupBundle(plan.bundle_directory)
  const actualArtifacts = manifest.artifacts.map(({
    kind, logical_name: logicalName, source, bytes, sha256,
  }) => ({ kind, logicalName, source, bytes, sha256 }))
  const expectedArtifacts = plan.steps.map((step, index) => ({
    kind: step.artifact.kind,
    logicalName: step.artifact.logicalName,
    source: step.artifact.source,
    bytes: journal.verified_postconditions[index].bytes,
    sha256: journal.verified_postconditions[index].sha256,
  }))
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error('Existing backup bundle does not match the completed export plan')
  }
  return manifest
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

/** Resolve symlinks through the nearest existing ancestor for paths not created yet. @param {string} path */
async function canonicalProspectivePath(path) {
  let existing = resolve(path)
  const suffix = []
  while (!(await pathExists(existing))) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error(`Cannot resolve remote path: ${path}`)
    suffix.unshift(basename(existing))
    existing = parent
  }
  return resolve(await realpath(existing), ...suffix)
}

/** @param {Record<string, any>} plan @param {string} journalPath */
async function requireSeparatedJournalPath(plan, journalPath) {
  const protectedPaths = [
    plan.bundle_directory,
    join(plan.bundle_directory, 'backup-manifest.json'),
    ...plan.steps.flatMap((step) => [
      ...(typeof step.artifact === 'string' ? [step.artifact] : []),
      ...(typeof step.output === 'string' ? [step.output] : []),
    ]),
    ...(plan.operation === 'backup' ? [plan.working_directory] : []),
  ]
  const canonicalJournal = await canonicalProspectivePath(journalPath)
  const foldedJournal = canonicalJournal.normalize('NFC').toLowerCase()
  for (const protectedPath of protectedPaths) {
    const canonicalProtected = await canonicalProspectivePath(protectedPath)
    const foldedProtected = canonicalProtected.normalize('NFC').toLowerCase()
    if (
      foldedJournal === foldedProtected
      || foldedJournal.startsWith(`${foldedProtected}${sep}`)
      || foldedProtected.startsWith(`${foldedJournal}${sep}`)
    ) {
      throw new Error(`Remote journal path must be separate from backup data: ${journalPath}`)
    }
  }
}

/** @param {Record<string, unknown>} plan @param {Date} now */
function newJournal(plan, now) {
  return {
    schema: JOURNAL_SCHEMA,
    version: JOURNAL_VERSION,
    plan_id: plan.plan_id,
    operation: plan.operation,
    environment: plan.environment,
    status: 'running',
    completed_step_ids: [],
    failed_step_id: null,
    next_step_id: plan.steps[0].id,
    verified_postconditions: [],
    updated_at: now.toISOString(),
  }
}

/** @param {Record<string, any>} plan */
async function requireCanonicalPlan(plan) {
  let expected
  if (plan.operation === 'backup') {
    const durableObjects = plan.steps
      .filter(({ phase }) => phase === 'durable-objects')
      .map((step) => ({
        namespace: step.resource?.namespace,
        objectId: step.resource?.objectId,
        logicalName: step.artifact?.logicalName,
      }))
    expected = createRemoteBackupPlan({
      environment: plan.environment,
      accountId: plan.account_id,
      workingDirectory: plan.working_directory,
      bundleDirectory: plan.bundle_directory,
      durableObjects,
    })
  } else {
    const proofTime = isRecord(plan.empty_target_proof)
      ? timestamp(plan.empty_target_proof.checked_at)
      : new Date(Number.NaN)
    expected = await createRemoteRestorePlan({
      environment: plan.environment,
      accountId: plan.account_id,
      bundleDirectory: plan.bundle_directory,
      emptyTargetProof: plan.empty_target_proof,
      now: proofTime,
    })
  }
  if (JSON.stringify(plan) !== JSON.stringify(expected)) {
    throw new Error('Remote plan is not a canonical plan for the resource allow-list')
  }
}

/** @param {Record<string, any>} plan @param {Record<string, any>} step @param {Record<string, any>} executor */
export async function verifyExecutedStep(plan, step, executor) {
  if (plan.operation === 'backup') {
    const actual = await hashRemoteArtifact(step.output)
    const proof = {
      step_id: step.id,
      kind: step.postcondition.kind,
      artifact_path: step.output,
      bytes: actual.bytes,
      sha256: actual.sha256,
    }
    if (step.transport !== 'worker-http') return proof
    if (typeof executor.verify !== 'function') {
      throw new Error(`Remote executor has no independent verifier for step: ${step.id}`)
    }
    const requiredDigests = step.postcondition.required_digests ?? []
    const result = await executor.verify(step)
    if (!isRecord(result)) throw new Error(`Remote verifier returned no postcondition: ${step.id}`)
    requireExactKeys(
      result,
      ['status', 'step_id', 'kind', 'artifact_sha256', ...requiredDigests],
      'Remote verifier postcondition',
    )
    if (
      result.status !== 'verified'
      || result.step_id !== step.id
      || result.kind !== step.postcondition.kind
      || result.artifact_sha256 !== actual.sha256
      || requiredDigests.some((field) => typeof result[field] !== 'string' || !SHA256.test(result[field]))
    ) throw new Error(`Remote verifier did not prove the required postcondition: ${step.id}`)
    return {
      ...proof,
      ...Object.fromEntries(requiredDigests.map((field) => [field, result[field]])),
    }
  }
  if (typeof executor.verify !== 'function') {
    throw new Error(`Remote executor has no independent verifier for step: ${step.id}`)
  }
  const result = await executor.verify(step)
  const requiredDigests = step.postcondition.required_digests
  const expectedKeys = ['status', 'step_id', 'kind', 'artifact_sha256', ...requiredDigests]
  if (!isRecord(result)) throw new Error(`Remote verifier returned no postcondition: ${step.id}`)
  requireExactKeys(result, expectedKeys, 'Remote verifier postcondition')
  if (
    result.status !== 'verified'
    || result.step_id !== step.id
    || result.kind !== step.postcondition.kind
    || result.artifact_sha256 !== step.artifact_sha256
    || requiredDigests.some((field) => typeof result[field] !== 'string' || !SHA256.test(result[field]))
  ) {
    throw new Error(`Remote verifier did not prove the required postcondition: ${step.id}`)
  }
  const { status: _status, ...proof } = result
  return proof
}

/**
 * Execute only through a caller-provided adapter. `supports` is checked for all
 * remaining steps before the first side effect, so a missing DO/R2 adapter
 * cannot leave D1 partially restored.
 *
 * @param {{
 *   plan: Record<string, any>,
 *   executor?: {supports(step: Record<string, any>): boolean|Promise<boolean>, execute(step: Record<string, any>): Promise<unknown>},
 *   apply?: boolean, confirmation?: string, journalPath?: string, now?: Date,
 * }} options
 */
export async function executeRemotePlan(options) {
  if (!isRecord(options) || !isRecord(options.plan)) throw new Error('Remote plan is required')
  const plan = options.plan
  if (plan.schema !== PLAN_SCHEMA || plan.version !== PLAN_VERSION || !['backup', 'restore'].includes(plan.operation)) {
    throw new Error('Unsupported remote plan')
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) throw new Error('Remote plan has no steps')
  const now = options.now instanceof Date ? options.now : new Date()

  await requireCanonicalPlan(plan)

  if (plan.operation === 'restore') {
    const manifest = await verifyBackupBundle(plan.bundle_directory)
    if (digest(manifest) !== plan.manifest_sha256) throw new Error('Restore manifest no longer matches the remote plan')
  }
  if (options.apply !== true) return { status: 'dry-run', plan }
  if (plan.operation === 'restore' && options.confirmation !== `RESTORE ${plan.environment}`) {
    throw new Error(`Remote restore requires exact confirmation: RESTORE ${plan.environment}`)
  }
  if (!options.executor || typeof options.executor.supports !== 'function' || typeof options.executor.execute !== 'function') {
    throw new Error('Remote apply requires an injected executor')
  }
  if (typeof options.journalPath !== 'string' || options.journalPath.length === 0) {
    throw new Error('Remote apply requires journalPath')
  }
  const journalPath = resolve(options.journalPath)
  await requireSeparatedJournalPath(plan, journalPath)
  // Reserve the journal parent, then resolve again so a newly materialized
  // path cannot change identity between the prospective and write checks.
  await mkdir(dirname(journalPath), { recursive: true })
  await requireSeparatedJournalPath(plan, journalPath)
  const existing = await readJournal(journalPath)
  let journal = existing ? validateJournal(existing, plan) : newJournal(plan, now)
  await verifyJournalPostconditions(plan, journal, options.executor)
  if (journal.status === 'completed') {
    if (plan.operation === 'backup') await verifyPublishedBackupBundle(plan, journal)
    return { status: 'completed', plan, journal }
  }
  if (plan.operation === 'backup' && !existing && await pathExists(plan.bundle_directory)) {
    throw new Error(`Remote backup bundle output already exists: ${plan.bundle_directory}`)
  }
  if (plan.operation === 'backup' && !existing && await pathExists(plan.working_directory)) {
    throw new Error(`Remote backup working directory already exists: ${plan.working_directory}`)
  }
  if (plan.operation === 'restore') {
    const resources = resourcesFor(plan.environment)
    const expectedObjects = plan.steps
      .filter(({ phase }) => phase === 'durable-objects')
      .map(({ resource }) => ({ namespace: resource.namespace, objectId: resource.objectId }))
    validateEmptyTargetProof(
      plan.empty_target_proof,
      plan.environment,
      plan.account_id,
      resources,
      expectedObjects,
      now,
      journal.completed_step_ids.length === 0,
    )
    if (digest(plan.empty_target_proof) !== plan.empty_target_proof_sha256) {
      throw new Error('Empty-target proof no longer matches the remote plan')
    }
  }
  const completed = new Set(journal.completed_step_ids)
  const remaining = plan.steps.filter(({ id }) => !completed.has(id))
  const contractOnly = remaining.find(({ contract_only: contractOnlyStep }) => contractOnlyStep === true)
  if (contractOnly) {
    throw new Error(`Remote contract-only step cannot be applied: ${contractOnly.id}`)
  }
  const support = await Promise.all(remaining.map((step) => options.executor.supports(step)))
  for (let index = 0; index < remaining.length; index += 1) {
    if (support[index] !== true) throw new Error(`Remote executor does not support step: ${remaining[index].id}`)
  }
  if (remaining.length > 0) {
    journal = { ...journal, status: 'running', failed_step_id: null, updated_at: now.toISOString() }
    await writeJournal(journalPath, journal)
  }
  if (plan.operation === 'backup') await mkdir(plan.working_directory, { recursive: true })

  for (const step of remaining) {
    try {
      const result = await options.executor.execute(step)
      if (
        !isRecord(result)
        || result.status !== 'completed'
        || !isRecord(result.evidence)
        || result.evidence.step_id !== step.id
      ) {
        throw new Error(`Remote executor did not return step-bound completion evidence: ${step.id}`)
      }
      const postcondition = await verifyExecutedStep(plan, step, options.executor)
      const completedStepIds = [...journal.completed_step_ids, step.id]
      const completedAllSteps = completedStepIds.length === plan.steps.length
      journal = {
        ...journal,
        status: completedAllSteps
          ? plan.operation === 'backup' ? 'publishing' : 'completed'
          : 'running',
        completed_step_ids: completedStepIds,
        failed_step_id: null,
        next_step_id: completedAllSteps
          ? plan.operation === 'backup' ? PUBLISH_STEP_ID : null
          : plan.steps[completedStepIds.length].id,
        verified_postconditions: [...journal.verified_postconditions, postcondition],
        updated_at: (options.now instanceof Date ? options.now : new Date()).toISOString(),
      }
      await writeJournal(journalPath, journal)
    } catch (error) {
      journal = {
        ...journal,
        status: 'failed',
        failed_step_id: step.id,
        next_step_id: step.id,
        updated_at: (options.now instanceof Date ? options.now : new Date()).toISOString(),
      }
      await writeJournal(journalPath, journal)
      throw error
    }
  }

  if (plan.operation === 'backup') {
    const artifacts = plan.steps.map((step) => ({ ...step.artifact, filePath: step.output }))
    try {
      if (await pathExists(plan.bundle_directory)) {
        await verifyPublishedBackupBundle(plan, journal)
      } else {
        await createBackupBundle({ outputDirectory: plan.bundle_directory, artifacts })
      }
    } catch (error) {
      journal = {
        ...journal,
        status: 'failed',
        failed_step_id: PUBLISH_STEP_ID,
        next_step_id: PUBLISH_STEP_ID,
        updated_at: (options.now instanceof Date ? options.now : new Date()).toISOString(),
      }
      await writeJournal(journalPath, journal)
      throw error
    }
  }
  journal = {
    ...journal,
    status: 'completed',
    completed_step_ids: plan.steps.map(({ id }) => id),
    failed_step_id: null,
    next_step_id: null,
    updated_at: (options.now instanceof Date ? options.now : new Date()).toISOString(),
  }
  await writeJournal(journalPath, journal)
  return { status: 'completed', plan, journal }
}

/** @param {string[]} args @param {string} cwd */
export function parseRemoteCliArguments(args, cwd) {
  const command = args[0]
  if (command !== 'backup-plan' && command !== 'restore-plan') {
    throw new Error('Remote CLI is plan-only; command must be backup-plan or restore-plan')
  }
  let environment
  let accountId
  let workingDirectory
  let bundleDirectory
  let proofPath
  const durableObjects = []
  const readValue = (index, flag) => {
    const value = args[index]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    return value
  }
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--env') {
      environment = readValue(index + 1, argument); index += 1; continue
    }
    if (argument === '--account-id') {
      accountId = readValue(index + 1, argument); index += 1; continue
    }
    if (argument === '--work-dir') {
      workingDirectory = resolve(cwd, readValue(index + 1, argument)); index += 1; continue
    }
    if (argument === '--bundle') {
      bundleDirectory = resolve(cwd, readValue(index + 1, argument)); index += 1; continue
    }
    if (argument === '--empty-target-proof') {
      proofPath = resolve(cwd, readValue(index + 1, argument)); index += 1; continue
    }
    if (argument === '--do-object') {
      durableObjects.push({
        namespace: readValue(index + 1, argument),
        objectId: readValue(index + 2, argument),
        logicalName: readValue(index + 3, argument),
      })
      index += 3
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (!environment) throw new Error('--env is required')
  if (!accountId) throw new Error('--account-id is required')
  if (!bundleDirectory) throw new Error('--bundle is required')
  if (command === 'backup-plan') {
    if (!workingDirectory) throw new Error('--work-dir is required for backup-plan')
    if (durableObjects.length === 0) throw new Error('--do-object is required for backup-plan')
    if (proofPath) throw new Error('backup-plan does not accept --empty-target-proof')
    return { command, environment, accountId, workingDirectory, bundleDirectory, durableObjects }
  }
  if (!proofPath) throw new Error('--empty-target-proof is required for restore-plan')
  if (workingDirectory || durableObjects.length > 0) throw new Error('restore-plan does not accept backup options')
  return { command, environment, accountId, bundleDirectory, proofPath }
}

async function main() {
  try {
    const cli = parseRemoteCliArguments(process.argv.slice(2), process.cwd())
    let plan
    if (cli.command === 'backup-plan') {
      plan = createRemoteBackupPlan(cli)
    } else {
      let proof
      try {
        proof = JSON.parse(await readFile(cli.proofPath, 'utf8'))
      } catch (error) {
        throw new Error('Empty-target proof is not valid JSON', { cause: error })
      }
      plan = await createRemoteRestorePlan({ ...cli, emptyTargetProof: proof })
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Remote backup/restore failed: ${message}\n`)
    process.exitCode = 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) await main()
