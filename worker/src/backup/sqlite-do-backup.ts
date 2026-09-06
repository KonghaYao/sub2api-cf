import { sha256Hex } from '../gateway/crypto'
import { StateApiError, json } from '../state/http'

const BACKUP_VERSION = 1
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 25_000
const MAX_LINE_BYTES = 256 * 1024
const DIGEST = /^[a-f0-9]{64}$/
const encoder = new TextEncoder()

export interface SqliteDoBackupIdentity {
  environment: string
  namespace: string
  objectId: string
}

export interface SqliteDoBackupColumnContract {
  cid: number
  name: string
  type: string
  not_null: number
  default_value: string | null
  primary_key: number
}

export interface SqliteDoBackupTableContract {
  name: string
  columns: SqliteDoBackupColumnContract[]
}

export interface SqliteDoBackupRow {
  type: 'row'
  table: string
  rowid: number
  values: Array<string | number | null>
}

export interface SqliteDoBackupSnapshot {
  tables: SqliteDoBackupTableContract[]
  rows: SqliteDoBackupRow[]
}

interface BackupDigests {
  schemaDigest: string
  inventoryDigest: string
  stateDigest: string
  tableCounts: Array<{ name: string; row_count: number }>
}

export interface SqliteDoBackupContract {
  artifactSchema: string
  namespace: string
  tableNames: readonly string[]
  schemaContract: readonly unknown[]
  isLogicallyEmpty(captured: SqliteDoBackupSnapshot): boolean
  validateLogicalState(captured: SqliteDoBackupSnapshot, identity: SqliteDoBackupIdentity): void
}

export async function exportSqliteDoBackup(
  storage: DurableObjectStorage,
  identity: SqliteDoBackupIdentity,
  contract: SqliteDoBackupContract,
): Promise<Response> {
  requireContractIdentity(identity, contract)
  const captured = storage.transactionSync(() => captureState(storage, contract))
  const digests = await calculateDigests(captured)
  const header = {
    type: 'header',
    schema: contract.artifactSchema,
    version: BACKUP_VERSION,
    environment: identity.environment,
    namespace: identity.namespace,
    object_id: identity.objectId,
    schema_contract: captured.tables,
    schema_digest: digests.schemaDigest,
    inventory_digest: digests.inventoryDigest,
    state_digest: digests.stateDigest,
    row_count: captured.rows.length,
    tables: digests.tableCounts,
  }
  const trailer = {
    type: 'trailer',
    row_count: captured.rows.length,
    inventory_digest: digests.inventoryDigest,
    state_digest: digests.stateDigest,
  }
  const headerLine = `${JSON.stringify(header)}\n`
  const trailerLine = `${JSON.stringify(trailer)}\n`
  let artifactBytes = encoder.encode(headerLine).byteLength + encoder.encode(trailerLine).byteLength
  for (const row of captured.rows) artifactBytes += encoder.encode(JSON.stringify(row)).byteLength + 1
  if (artifactBytes > MAX_ARTIFACT_BYTES) {
    throw new StateApiError(413, 'backup_state_too_large', 'Durable Object state exceeds the backup limit')
  }
  let lineIndex = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (lineIndex === 0) controller.enqueue(encoder.encode(headerLine))
      else if (lineIndex <= captured.rows.length) {
        controller.enqueue(encoder.encode(`${JSON.stringify(captured.rows[lineIndex - 1])}\n`))
      } else if (lineIndex === captured.rows.length + 1) controller.enqueue(encoder.encode(trailerLine))
      else {
        controller.close()
        return
      }
      lineIndex += 1
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function inspectSqliteDoBackup(
  storage: DurableObjectStorage,
  identity: SqliteDoBackupIdentity,
  contract: SqliteDoBackupContract,
): Promise<Response> {
  requireContractIdentity(identity, contract)
  const captured = storage.transactionSync(() => captureState(storage, contract))
  const digests = await calculateDigests(captured)
  return json({
    schema: contract.artifactSchema,
    version: BACKUP_VERSION,
    environment: identity.environment,
    namespace: identity.namespace,
    object_id: identity.objectId,
    logical_empty: contract.isLogicallyEmpty(captured),
    row_count: captured.rows.length,
    schema_digest: digests.schemaDigest,
    inventory_digest: digests.inventoryDigest,
    state_digest: digests.stateDigest,
  })
}

export async function restoreSqliteDoBackup(
  storage: DurableObjectStorage,
  request: Request,
  identity: SqliteDoBackupIdentity,
  contract: SqliteDoBackupContract,
): Promise<Response> {
  requireContractIdentity(identity, contract)
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    throw invalidArtifact('Backup artifact content length is invalid')
  }
  if (contentLength !== null && Number(contentLength) > MAX_ARTIFACT_BYTES) throw artifactTooLarge()
  const text = await readBoundedArtifactText(request)
  const parsed = await parseArtifact(text, identity, storage, contract)
  let result: { idempotent: boolean }
  try {
    result = storage.transactionSync(() => {
      const current = captureState(storage, contract)
      if (!contract.isLogicallyEmpty(current)) {
        if (canonicalRows(current.rows) === canonicalRows(parsed.captured.rows)) {
          return { idempotent: true }
        }
        throw new StateApiError(
          409,
          'backup_restore_conflict',
          'Durable Object already contains different logical state',
        )
      }

      for (const table of [...contract.tableNames].reverse()) {
        storage.sql.exec(`DELETE FROM ${quoteIdentifier(table)}`)
      }
      for (const table of parsed.captured.tables) {
        const rows = parsed.captured.rows.filter((row) => row.table === table.name)
        const columns = table.columns.map(({ name }) => quoteIdentifier(name))
        const placeholders = Array.from({ length: columns.length + 1 }, () => '?').join(', ')
        const statement = `INSERT INTO ${quoteIdentifier(table.name)} (rowid, ${columns.join(', ')}) VALUES (${placeholders})`
        for (const row of rows) storage.sql.exec(statement, row.rowid, ...row.values)
      }
      const restored = captureState(storage, contract)
      if (canonicalRows(restored.rows) !== canonicalRows(parsed.captured.rows)) {
        throw new StateApiError(500, 'backup_restore_verification_failed', 'Restored state failed local read-back')
      }
      return { idempotent: false }
    })
  } catch (error) {
    if (error instanceof StateApiError) throw error
    throw invalidArtifact('Backup artifact violates the target Durable Object schema')
  }

  return json({
    schema: contract.artifactSchema,
    version: BACKUP_VERSION,
    restored: true,
    idempotent: result.idempotent,
    row_count: parsed.captured.rows.length,
    inventory_digest: parsed.digests.inventoryDigest,
    state_digest: parsed.digests.stateDigest,
  })
}

async function readBoundedArtifactText(request: Request): Promise<string> {
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_ARTIFACT_BYTES) {
        await reader.cancel('backup artifact exceeds the bounded input size')
        throw artifactTooLarge()
      }
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch (error) {
    if (error instanceof StateApiError) throw error
    try { await reader.cancel('invalid backup artifact body') } catch {}
    throw invalidArtifact('Backup artifact body is not valid UTF-8')
  }
}

function captureState(
  storage: DurableObjectStorage,
  contract: SqliteDoBackupContract,
): SqliteDoBackupSnapshot {
  const tables = contract.tableNames.map((name) => ({ name, columns: tableColumns(storage, name) }))
  if (JSON.stringify(tables) !== JSON.stringify(contract.schemaContract)) {
    throw new StateApiError(500, 'backup_schema_invalid', `Durable Object backup schema is not ${contract.namespace} v1`)
  }
  const rows: SqliteDoBackupRow[] = []
  let bytes = 0
  for (const table of tables) {
    const columnNames = table.columns.map(({ name }) => quoteIdentifier(name)).join(', ')
    const selected = storage.sql.exec(
      `SELECT rowid AS __backup_rowid, ${columnNames} FROM ${quoteIdentifier(table.name)} ORDER BY rowid ASC`,
    ) as unknown as Iterable<Record<string, unknown>>
    for (const selectedRow of selected) {
      const rowid = selectedRow.__backup_rowid
      if (!Number.isSafeInteger(rowid) || (rowid as number) <= 0) {
        throw new StateApiError(500, 'backup_state_invalid', 'Durable Object state has an invalid row identifier')
      }
      const values = table.columns.map(({ name }) => canonicalSqlValue(selectedRow[name]))
      const row: SqliteDoBackupRow = { type: 'row', table: table.name, rowid: rowid as number, values }
      const lineBytes = encoder.encode(JSON.stringify(row)).byteLength + 1
      if (lineBytes > MAX_LINE_BYTES) {
        throw new StateApiError(413, 'backup_state_too_large', 'A Durable Object backup row exceeds the size limit')
      }
      bytes += lineBytes
      rows.push(row)
      if (rows.length > MAX_ROWS || bytes > MAX_ARTIFACT_BYTES) {
        throw new StateApiError(413, 'backup_state_too_large', 'Durable Object state exceeds the backup limit')
      }
    }
  }
  return { tables, rows }
}

function tableColumns(storage: DurableObjectStorage, table: string): SqliteDoBackupColumnContract[] {
  const rows = Array.from(storage.sql.exec(`PRAGMA table_info(${quoteIdentifier(table)})`)) as Array<Record<string, unknown>>
  if (rows.length === 0) {
    throw new StateApiError(500, 'backup_schema_unavailable', 'Durable Object backup schema is unavailable')
  }
  return rows.map((row, index) => {
    if (
      row.cid !== index
      || typeof row.name !== 'string'
      || typeof row.type !== 'string'
      || ![0, 1].includes(row.notnull as number)
      || !(row.dflt_value === null || typeof row.dflt_value === 'string')
      || !Number.isSafeInteger(row.pk)
    ) {
      throw new StateApiError(500, 'backup_schema_invalid', 'Durable Object backup schema is invalid')
    }
    return {
      cid: index,
      name: row.name,
      type: row.type,
      not_null: row.notnull as number,
      default_value: row.dflt_value as string | null,
      primary_key: row.pk as number,
    }
  })
}

async function calculateDigests(captured: SqliteDoBackupSnapshot): Promise<BackupDigests> {
  const tableCounts = captured.tables.map(({ name }) => ({
    name,
    row_count: captured.rows.filter((row) => row.table === name).length,
  }))
  const schemaDigest = await sha256Hex(JSON.stringify(captured.tables))
  const inventoryDigest = await sha256Hex(JSON.stringify({ schema_digest: schemaDigest, tables: tableCounts }))
  const stateDigest = await sha256Hex(canonicalRows(captured.rows))
  return { schemaDigest, inventoryDigest, stateDigest, tableCounts }
}

async function parseArtifact(
  text: string,
  identity: SqliteDoBackupIdentity,
  storage: DurableObjectStorage,
  contract: SqliteDoBackupContract,
): Promise<{ captured: SqliteDoBackupSnapshot; digests: BackupDigests }> {
  if (text.length === 0 || !text.endsWith('\n')) throw invalidArtifact('Backup artifact is empty or truncated')
  const rawLines = text.slice(0, -1).split('\n')
  if (rawLines.length < 2 || rawLines.length > MAX_ROWS + 2) throw invalidArtifact('Backup artifact line count is invalid')
  const values = rawLines.map((line) => {
    if (encoder.encode(line).byteLength > MAX_LINE_BYTES) throw invalidArtifact('Backup artifact line exceeds the size limit')
    try {
      const value = JSON.parse(line) as unknown
      if (JSON.stringify(value) !== line) throw invalidArtifact('Backup artifact is not canonical NDJSON')
      return value
    } catch (error) {
      if (error instanceof StateApiError) throw error
      throw invalidArtifact('Backup artifact is not valid NDJSON')
    }
  })
  const header = requireRecord(values[0])
  requireExactKeys(header, [
    'type', 'schema', 'version', 'environment', 'namespace', 'object_id', 'schema_contract', 'schema_digest',
    'inventory_digest', 'state_digest', 'row_count', 'tables',
  ])
  if (
    header.type !== 'header'
    || header.schema !== contract.artifactSchema
    || header.version !== BACKUP_VERSION
    || header.environment !== identity.environment
    || header.namespace !== identity.namespace
    || header.object_id !== identity.objectId
    || !Number.isSafeInteger(header.row_count)
    || (header.row_count as number) < 0
    || (header.row_count as number) > MAX_ROWS
    || typeof header.schema_digest !== 'string' || !DIGEST.test(header.schema_digest)
    || typeof header.inventory_digest !== 'string' || !DIGEST.test(header.inventory_digest)
    || typeof header.state_digest !== 'string' || !DIGEST.test(header.state_digest)
  ) throw invalidArtifact('Backup artifact header is invalid')

  const tables = contract.tableNames.map((name) => ({ name, columns: tableColumns(storage, name) }))
  if (
    JSON.stringify(tables) !== JSON.stringify(contract.schemaContract)
    || JSON.stringify(header.schema_contract) !== JSON.stringify(tables)
  ) {
    throw invalidArtifact('Backup artifact schema contract does not match the target')
  }
  const tableCounts = parseTableCounts(header.tables, contract)
  const rows = values.slice(1, -1).map((value) => parseRow(value, tables))
  if (rows.length !== header.row_count) throw invalidArtifact('Backup artifact row count does not match')
  validateRowOrder(rows, contract)
  for (const table of tableCounts) {
    if (rows.filter((row) => row.table === table.name).length !== table.row_count) {
      throw invalidArtifact('Backup artifact table inventory does not match')
    }
  }
  const captured = { tables, rows }
  contract.validateLogicalState(captured, identity)
  const digests = await calculateDigests(captured)
  if (
    digests.schemaDigest !== header.schema_digest
    || digests.inventoryDigest !== header.inventory_digest
    || digests.stateDigest !== header.state_digest
  ) throw invalidArtifact('Backup artifact digest does not match')

  const trailer = requireRecord(values.at(-1))
  requireExactKeys(trailer, ['type', 'row_count', 'inventory_digest', 'state_digest'])
  if (
    trailer.type !== 'trailer'
    || trailer.row_count !== rows.length
    || trailer.inventory_digest !== digests.inventoryDigest
    || trailer.state_digest !== digests.stateDigest
  ) throw invalidArtifact('Backup artifact trailer does not match')
  return { captured, digests }
}

function requireContractIdentity(
  identity: SqliteDoBackupIdentity,
  contract: SqliteDoBackupContract,
): void {
  if (identity.namespace !== contract.namespace) {
    throw new StateApiError(400, 'invalid_backup_identity', 'Backup namespace is invalid')
  }
}

export function rowsForBackupTable(
  captured: SqliteDoBackupSnapshot,
  table: string,
): SqliteDoBackupRow[] {
  return captured.rows.filter((row) => row.table === table)
}

export function valueForBackupRow(
  captured: SqliteDoBackupSnapshot,
  row: SqliteDoBackupRow,
  column: string,
): string | number | null {
  const table = captured.tables.find(({ name }) => name === row.table)
  const index = table?.columns.findIndex(({ name }) => name === column) ?? -1
  if (index < 0) throw invalidArtifact('Backup artifact schema is missing a required column')
  return row.values[index]
}

function parseTableCounts(
  value: unknown,
  contract: SqliteDoBackupContract,
): Array<{ name: string; row_count: number }> {
  if (!Array.isArray(value) || value.length !== contract.tableNames.length) {
    throw invalidArtifact('Backup artifact table inventory is invalid')
  }
  return value.map((candidate, index) => {
    const record = requireRecord(candidate)
    requireExactKeys(record, ['name', 'row_count'])
    if (
      record.name !== contract.tableNames[index]
      || !Number.isSafeInteger(record.row_count)
      || (record.row_count as number) < 0
      || (record.row_count as number) > MAX_ROWS
    ) throw invalidArtifact('Backup artifact table inventory is invalid')
    return { name: contract.tableNames[index]!, row_count: record.row_count as number }
  })
}

function parseRow(value: unknown, tables: SqliteDoBackupTableContract[]): SqliteDoBackupRow {
  const row = requireRecord(value)
  requireExactKeys(row, ['type', 'table', 'rowid', 'values'])
  const table = tables.find(({ name }) => name === row.table)
  if (
    row.type !== 'row'
    || table === undefined
    || !Number.isSafeInteger(row.rowid)
    || (row.rowid as number) <= 0
    || !Array.isArray(row.values)
    || row.values.length !== table.columns.length
  ) throw invalidArtifact('Backup artifact row is invalid')
  return {
    type: 'row',
    table: table.name,
    rowid: row.rowid as number,
    values: row.values.map(canonicalSqlValue),
  }
}

function validateRowOrder(rows: SqliteDoBackupRow[], contract: SqliteDoBackupContract): void {
  let tableIndex = 0
  let previousRowid = 0
  for (const row of rows) {
    const index = contract.tableNames.indexOf(row.table)
    if (index < tableIndex) throw invalidArtifact('Backup artifact rows are out of order')
    if (index > tableIndex) {
      tableIndex = index
      previousRowid = 0
    }
    if (row.rowid <= previousRowid) throw invalidArtifact('Backup artifact has duplicate or unordered rows')
    previousRowid = row.rowid
  }
}

function canonicalRows(rows: SqliteDoBackupRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n')
}

function canonicalSqlValue(value: unknown): string | number | null {
  if (value === null || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw invalidArtifact('Backup state contains an unsupported SQL value')
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArtifact('Backup artifact record is invalid')
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalidArtifact('Backup artifact has unsupported or missing fields')
  }
}

function invalidArtifact(message: string): StateApiError {
  return new StateApiError(400, 'invalid_backup_artifact', message)
}

function artifactTooLarge(): StateApiError {
  return new StateApiError(413, 'backup_artifact_too_large', 'Backup artifact exceeds the bounded input size')
}
