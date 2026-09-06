import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

import { USER_STATE_BACKUP_V1_SCHEMA } from '../src/backup/user-state-backup-schema.mjs'

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 25_000
const MAX_LINE_BYTES = 256 * 1024
const DIGEST = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9_-])?$/
const ALLOWED_ORIGINS = Object.freeze({
  staging: 'https://sub2api-worker-staging.claude-code-best.workers.dev',
  production: 'https://sub2api-worker-production.claude-code-best.workers.dev',
})
const TABLE_NAMES = Object.freeze([
  'user_profile',
  'user_state_metadata',
  'user_ledger',
  'user_requests',
  'user_ledger_tombstones',
  'user_outbox',
])

/**
 * Node-side adapter for the authenticated USER_STATE Worker transport. It is
 * deliberately only one adapter: callers may compose it with D1/R2 adapters,
 * while the remote plan keeps its all-capabilities-before-writes invariant.
 *
 * @param {{
 *   environment: 'staging'|'production', origin: string, token: string,
 *   fetcher?: (request: Request) => Promise<Response>, timeoutMs?: number
 * }} options
 */
export function createUserStateBackupRemoteAdapter(options) {
  if (options?.environment !== 'staging' && options?.environment !== 'production') {
    throw new Error('USER_STATE backup adapter environment must be staging or production')
  }
  const origin = canonicalOrigin(options.origin)
  if (origin !== ALLOWED_ORIGINS[options.environment]) {
    throw new Error('USER_STATE backup adapter origin is not allow-listed for its environment')
  }
  if (typeof options.token !== 'string' || options.token.length < 32) {
    throw new Error('USER_STATE backup adapter token must contain at least 32 characters')
  }
  const fetcher = options.fetcher ?? ((request) => fetch(request))
  if (typeof fetcher !== 'function') throw new Error('USER_STATE backup adapter fetcher is required')
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('USER_STATE backup adapter timeout must be between 1000 and 300000 milliseconds')
  }

  return Object.freeze({
    supports(step) {
      return isSupportedStep(step, options.environment, origin)
    },
    async execute(step) {
      requireSupportedStep(step, options.environment, origin)
      if (step.operation === 'export-durable-object-ndjson') {
        await exportArtifact(step, requestFor(step, origin, options.environment, options.token, timeoutMs), fetcher)
      } else {
        await restoreArtifact(step, requestFor(step, origin, options.environment, options.token, timeoutMs), fetcher)
      }
      return { status: 'completed', evidence: { step_id: step.id } }
    },
    async verify(step) {
      requireSupportedStep(step, options.environment, origin)
      const artifactPath = step.operation === 'export-durable-object-ndjson' ? step.output : step.artifact
      const artifactFile = await readArtifactFile(artifactPath)
      const artifact = readArtifactSummary(artifactFile.buffer, step, options.environment)
      const integrity = artifactFile.integrity
      if (step.operation === 'restore-durable-object-ndjson') {
        if (integrity.bytes !== step.artifact_bytes || integrity.sha256 !== step.artifact_sha256) {
          throw new Error(`USER_STATE restore artifact no longer matches its plan: ${step.id}`)
        }
      }
      const verifyRequest = requestFor(step, origin, options.environment, options.token, timeoutMs, 'verify')
      const response = await fetcher(verifyRequest)
      if (!response.ok) throw new Error(`USER_STATE remote verifier failed with HTTP ${response.status}: ${step.id}`)
      const remote = await safeJson(response, `USER_STATE remote verifier returned invalid JSON: ${step.id}`)
      if (
        remote.schema !== 'sub2api-user-state-backup'
        || remote.version !== 1
        || remote.environment !== options.environment
        || remote.namespace !== 'USER_STATE'
        || remote.object_id !== step.resource.objectId
        || remote.inventory_digest !== artifact.inventoryDigest
        || remote.state_digest !== artifact.stateDigest
      ) throw new Error(`USER_STATE remote read-back does not match the artifact: ${step.id}`)
      return {
        status: 'verified',
        step_id: step.id,
        kind: step.postcondition.kind,
        artifact_sha256: integrity.sha256,
        remote_inventory_digest: artifact.inventoryDigest,
        remote_state_digest: artifact.stateDigest,
      }
    },
  })
}

async function exportArtifact(step, request, fetcher) {
  const response = await fetcher(request)
  if (!response.ok || response.body === null) {
    throw new Error(`USER_STATE export failed with HTTP ${response.status}: ${step.id}`)
  }
  if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-ndjson')) {
    throw new Error(`USER_STATE export returned an unsupported content type: ${step.id}`)
  }
  await writeNewFileAtomically(step.output, response.body)
  try {
    const artifactFile = await readArtifactFile(step.output)
    readArtifactSummary(artifactFile.buffer, step, step.environment)
  } catch (error) {
    await rm(step.output, { force: true })
    throw error
  }
}

async function restoreArtifact(step, request, fetcher) {
  const artifactFile = await readArtifactFile(step.artifact)
  const integrity = artifactFile.integrity
  if (integrity.bytes !== step.artifact_bytes || integrity.sha256 !== step.artifact_sha256) {
    throw new Error(`USER_STATE restore artifact no longer matches its plan: ${step.id}`)
  }
  const artifact = readArtifactSummary(artifactFile.buffer, step, step.environment)
  const response = await fetcher(new Request(request, {
    method: 'POST',
    headers: { ...Object.fromEntries(request.headers), 'content-type': 'application/x-ndjson' },
    body: artifactFile.buffer,
  }))
  if (!response.ok) throw new Error(`USER_STATE restore failed with HTTP ${response.status}: ${step.id}`)
  const result = await safeJson(response, `USER_STATE restore returned invalid JSON: ${step.id}`)
  if (
    result.restored !== true
    || result.inventory_digest !== artifact.inventoryDigest
    || result.state_digest !== artifact.stateDigest
  ) throw new Error(`USER_STATE restore completion evidence does not match the artifact: ${step.id}`)
}

function requestFor(step, origin, environment, token, timeoutMs, action) {
  const plannedPath = step.request.path
  const path = action === undefined
    ? plannedPath
    : plannedPath.replace(/\/(?:export|restore)$/, `/${action}`)
  const request = new Request(new URL(path, origin), {
    method: action === 'verify' ? 'GET' : step.request.method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-sub2api-backup-environment': environment,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  return request
}

function isSupportedStep(step, environment, origin) {
  if (
    !isRecord(step)
    || step.phase !== 'durable-objects'
    || !['export-durable-object-ndjson', 'restore-durable-object-ndjson'].includes(step.operation)
    || step.transport !== 'worker-http'
    || !isRecord(step.resource)
    || step.resource.namespace !== 'USER_STATE'
    || typeof step.resource.objectId !== 'string' || !OBJECT_ID.test(step.resource.objectId)
    || !isRecord(step.request)
    || typeof step.request.path !== 'string'
    || step.request.method !== 'POST'
    || step.request.service !== `sub2api-worker-${environment}`
    || step.request.origin !== origin
    || step.environment !== environment
    || step.contract_only !== undefined
  ) return false
  const action = step.operation === 'export-durable-object-ndjson' ? 'export' : 'restore'
  return step.request.path === `/internal/backup/durable-objects/USER_STATE/${encodeURIComponent(step.resource.objectId)}/${action}`
}

function requireSupportedStep(step, environment, origin) {
  if (!isSupportedStep(step, environment, origin)) {
    throw new Error(`USER_STATE backup adapter does not support step: ${String(step?.id)}`)
  }
}

function canonicalOrigin(value) {
  if (typeof value !== 'string') throw new Error('USER_STATE backup adapter origin is required')
  let url
  try { url = new URL(value) } catch { throw new Error('USER_STATE backup adapter origin is invalid') }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) throw new Error('USER_STATE backup adapter origin must be an HTTPS origin')
  return url.origin
}

async function writeNewFileAtomically(path, body) {
  await mkdir(dirname(path), { recursive: true })
  try {
    await lstat(path)
    throw new Error(`USER_STATE adapter output already exists: ${path}`)
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let bytes = 0
  try {
    const reader = body.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_ARTIFACT_BYTES) throw new Error('USER_STATE export exceeded the bounded artifact size')
      await handle.write(next.value)
    }
    await handle.sync()
    await handle.close()
    await link(temporary, path)
  } finally {
    try { await handle.close() } catch {}
    await rm(temporary, { force: true })
  }
}

function readArtifactSummary(bytes, step, environment) {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`USER_STATE artifact is too large: ${step.id}`)
  const text = bytes.toString('utf8')
  if (!text.endsWith('\n')) throw new Error(`USER_STATE artifact is truncated: ${step.id}`)
  const lines = text.slice(0, -1).split('\n')
  if (lines.length < 2 || lines.length > MAX_ROWS + 2) {
    throw new Error(`USER_STATE artifact line count is invalid: ${step.id}`)
  }
  const records = lines.map((line) => parseCanonicalLine(line, step.id))
  const header = records[0]
  const trailer = records.at(-1)
  if (
    !isRecord(header) || !isRecord(trailer)
    || !hasExactKeys(header, [
      'type', 'schema', 'version', 'environment', 'namespace', 'object_id',
      'schema_contract', 'schema_digest', 'inventory_digest', 'state_digest',
      'row_count', 'tables',
    ])
    || header.type !== 'header' || trailer.type !== 'trailer'
    || header.schema !== 'sub2api-user-state-backup' || header.version !== 1
    || header.environment !== environment || header.namespace !== 'USER_STATE'
    || header.object_id !== step.resource.objectId
    || !Number.isSafeInteger(header.row_count) || header.row_count < 0 || header.row_count > MAX_ROWS
    || typeof header.inventory_digest !== 'string' || !DIGEST.test(header.inventory_digest)
    || typeof header.state_digest !== 'string' || !DIGEST.test(header.state_digest)
  ) throw new Error(`USER_STATE artifact summary is invalid: ${step.id}`)

  const schemaContract = parseSchemaContract(header.schema_contract, step.id)
  const tableCounts = parseTableCounts(header.tables, step.id)
  const rows = records.slice(1, -1).map((record) => parseRow(record, schemaContract, step.id))
  if (rows.length !== header.row_count) throw new Error(`USER_STATE artifact row count does not match: ${step.id}`)
  validateRowOrder(rows, step.id)
  for (const table of tableCounts) {
    if (rows.filter((row) => row.table === table.name).length !== table.row_count) {
      throw new Error(`USER_STATE artifact table inventory does not match: ${step.id}`)
    }
  }
  const schemaDigest = sha256Json(schemaContract)
  const inventoryDigest = sha256Json({ schema_digest: schemaDigest, tables: tableCounts })
  const stateDigest = createHash('sha256')
    .update(rows.map((row) => JSON.stringify(row)).join('\n'))
    .digest('hex')
  if (
    header.schema_digest !== schemaDigest
    || header.inventory_digest !== inventoryDigest
    || header.state_digest !== stateDigest
    || !hasExactKeys(trailer, ['type', 'row_count', 'inventory_digest', 'state_digest'])
    || trailer.row_count !== rows.length
    || trailer.inventory_digest !== inventoryDigest
    || trailer.state_digest !== stateDigest
  ) throw new Error(`USER_STATE artifact digest does not match: ${step.id}`)
  return { inventoryDigest: header.inventory_digest, stateDigest: header.state_digest }
}

function parseCanonicalLine(line, stepId) {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new Error(`USER_STATE artifact line exceeds the size limit: ${stepId}`)
  }
  let record
  try { record = JSON.parse(line) } catch { throw new Error(`USER_STATE artifact is invalid NDJSON: ${stepId}`) }
  if (!isRecord(record) || JSON.stringify(record) !== line) {
    throw new Error(`USER_STATE artifact is not canonical NDJSON: ${stepId}`)
  }
  return record
}

function parseSchemaContract(value, stepId) {
  if (JSON.stringify(value) !== JSON.stringify(USER_STATE_BACKUP_V1_SCHEMA)) {
    throw new Error(`USER_STATE artifact schema contract is not the exact v1 schema: ${stepId}`)
  }
  if (!Array.isArray(value) || value.length !== TABLE_NAMES.length) {
    throw new Error(`USER_STATE artifact schema contract is invalid: ${stepId}`)
  }
  return value.map((candidate, tableIndex) => {
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ['name', 'columns'])
      || candidate.name !== TABLE_NAMES[tableIndex]
      || !Array.isArray(candidate.columns)
      || candidate.columns.length === 0
    ) throw new Error(`USER_STATE artifact schema contract is invalid: ${stepId}`)
    return {
      name: candidate.name,
      columns: candidate.columns.map((column, columnIndex) => {
        if (
          !isRecord(column)
          || !hasExactKeys(column, ['cid', 'name', 'type', 'not_null', 'default_value', 'primary_key'])
          || column.cid !== columnIndex
          || typeof column.name !== 'string' || column.name.length === 0
          || typeof column.type !== 'string'
          || ![0, 1].includes(column.not_null)
          || !(column.default_value === null || typeof column.default_value === 'string')
          || !Number.isSafeInteger(column.primary_key) || column.primary_key < 0
        ) throw new Error(`USER_STATE artifact schema contract is invalid: ${stepId}`)
        return column
      }),
    }
  })
}

function parseTableCounts(value, stepId) {
  if (!Array.isArray(value) || value.length !== TABLE_NAMES.length) {
    throw new Error(`USER_STATE artifact table inventory is invalid: ${stepId}`)
  }
  return value.map((candidate, index) => {
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ['name', 'row_count'])
      || candidate.name !== TABLE_NAMES[index]
      || !Number.isSafeInteger(candidate.row_count)
      || candidate.row_count < 0 || candidate.row_count > MAX_ROWS
    ) throw new Error(`USER_STATE artifact table inventory is invalid: ${stepId}`)
    return candidate
  })
}

function parseRow(value, schemaContract, stepId) {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'table', 'rowid', 'values'])) {
    throw new Error(`USER_STATE artifact row is invalid: ${stepId}`)
  }
  const table = schemaContract.find(({ name }) => name === value.table)
  if (
    value.type !== 'row' || table === undefined
    || !Number.isSafeInteger(value.rowid) || value.rowid <= 0
    || !Array.isArray(value.values) || value.values.length !== table.columns.length
    || value.values.some((item) => !(item === null || typeof item === 'string' || Number.isSafeInteger(item)))
  ) throw new Error(`USER_STATE artifact row is invalid: ${stepId}`)
  return value
}

function validateRowOrder(rows, stepId) {
  let tableIndex = 0
  let previousRowid = 0
  for (const row of rows) {
    const index = TABLE_NAMES.indexOf(row.table)
    if (index < tableIndex) throw new Error(`USER_STATE artifact rows are out of order: ${stepId}`)
    if (index > tableIndex) {
      tableIndex = index
      previousRowid = 0
    }
    if (row.rowid <= previousRowid) {
      throw new Error(`USER_STATE artifact has duplicate or unordered rows: ${stepId}`)
    }
    previousRowid = row.rowid
  }
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

async function readArtifactFile(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new Error(`USER_STATE artifact is not a bounded regular file: ${path}`)
    }
    const buffer = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || BigInt(buffer.byteLength) !== before.size
    ) {
      throw new Error(`USER_STATE artifact changed while it was being read: ${path}`)
    }
    return {
      buffer,
      integrity: {
        bytes: buffer.byteLength,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      },
    }
  } finally {
    await handle.close()
  }
}

async function safeJson(response, message) {
  try {
    const value = await response.json()
    if (isRecord(value)) return value
  } catch {}
  throw new Error(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
