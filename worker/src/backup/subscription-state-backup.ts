import { StateApiError } from '../state/http'
import { SUBSCRIPTION_STATE_BACKUP_V1_SCHEMA } from './subscription-state-backup-schema.mjs'
import {
  exportSqliteDoBackup,
  inspectSqliteDoBackup,
  restoreSqliteDoBackup,
  rowsForBackupTable,
  valueForBackupRow,
  type SqliteDoBackupContract,
  type SqliteDoBackupIdentity,
  type SqliteDoBackupRow,
  type SqliteDoBackupSnapshot,
} from './sqlite-do-backup'

const TABLE_NAMES = [
  'subscription_profile',
  'subscription_windows',
  'subscription_requests',
  'subscription_term_windows',
  'subscription_schema_migrations',
  'subscription_outbox',
  'subscription_mutations',
] as const

const CONTRACT: SqliteDoBackupContract = {
  artifactSchema: 'sub2api-subscription-state-backup',
  namespace: 'SUBSCRIPTION_STATE',
  tableNames: TABLE_NAMES,
  schemaContract: SUBSCRIPTION_STATE_BACKUP_V1_SCHEMA,
  isLogicallyEmpty,
  validateLogicalState,
}

export function exportSubscriptionStateBackup(
  storage: DurableObjectStorage,
  identity: SqliteDoBackupIdentity,
): Promise<Response> {
  return exportSqliteDoBackup(storage, identity, CONTRACT)
}

export function inspectSubscriptionStateBackup(
  storage: DurableObjectStorage,
  identity: SqliteDoBackupIdentity,
): Promise<Response> {
  return inspectSqliteDoBackup(storage, identity, CONTRACT)
}

export function restoreSubscriptionStateBackup(
  storage: DurableObjectStorage,
  request: Request,
  identity: SqliteDoBackupIdentity,
): Promise<Response> {
  return restoreSqliteDoBackup(storage, request, identity, CONTRACT)
}

export function readSubscriptionStateBackupIdentity(request: Request): SqliteDoBackupIdentity {
  const environment = request.headers.get('x-sub2api-backup-environment') ?? ''
  const namespace = request.headers.get('x-sub2api-backup-namespace') ?? ''
  const objectId = request.headers.get('x-sub2api-backup-object-id') ?? ''
  if (environment.length === 0 || environment.length > 64) {
    throw new StateApiError(400, 'invalid_backup_identity', 'Backup environment is invalid')
  }
  if (namespace !== 'SUBSCRIPTION_STATE') {
    throw new StateApiError(400, 'invalid_backup_identity', 'Backup namespace is invalid')
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9_-])?$/.test(objectId)) {
    throw new StateApiError(400, 'invalid_backup_identity', 'Backup object identifier is invalid')
  }
  return { environment, namespace, objectId }
}

function validateLogicalState(
  captured: SqliteDoBackupSnapshot,
  identity: SqliteDoBackupIdentity,
): void {
  const migrations = captured.rows.filter(({ table }) => table === 'subscription_schema_migrations')
  if (migrations.length !== 1 || valueForBackupRow(captured, migrations[0], 'version') !== 1) {
    throw invalidArtifact('Backup artifact requires the v1 schema migration marker')
  }
  const profiles = captured.rows.filter(({ table }) => table === 'subscription_profile')
  if (profiles.length === 0) {
    if (!isLogicallyEmpty(captured)) {
      throw invalidArtifact('Backup artifact contains state without a subscription profile')
    }
    return
  }
  if (
    profiles.length !== 1
    || valueForBackupRow(captured, profiles[0], 'singleton') !== 1
    || valueForBackupRow(captured, profiles[0], 'subscription_id') !== identity.objectId
  ) throw invalidArtifact('Backup artifact subscription identity is invalid')

  for (const row of rowsForBackupTable(captured, 'subscription_outbox')) {
    validateOutboxRow(captured, row, identity)
  }
  for (const row of rowsForBackupTable(captured, 'subscription_mutations')) {
    validateMutationRow(captured, row, identity)
  }
}

function isLogicallyEmpty(captured: SqliteDoBackupSnapshot): boolean {
  if (
    captured.rows.length !== 1
    || captured.rows[0]?.table !== 'subscription_schema_migrations'
  ) return false
  return valueForBackupRow(captured, captured.rows[0], 'version') === 1
}

function invalidArtifact(message: string): StateApiError {
  return new StateApiError(400, 'invalid_backup_artifact', message)
}

function parseJsonObject(value: string | number | null): Record<string, unknown> {
  if (typeof value !== 'string') throw invalidArtifact('Backup artifact payload JSON is invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalidArtifact('Backup artifact payload JSON is invalid')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidArtifact('Backup artifact payload JSON must be an object')
  }
  return parsed as Record<string, unknown>
}

function validateOutboxRow(
  captured: SqliteDoBackupSnapshot,
  row: SqliteDoBackupRow,
  identity: SqliteDoBackupIdentity,
): void {
  const eventId = valueForBackupRow(captured, row, 'event_id')
  const dedupeKey = valueForBackupRow(captured, row, 'dedupe_key')
  const event = parseJsonObject(valueForBackupRow(captured, row, 'payload_json'))
  const payload = parseEmbeddedObject(event.payload)
  const requestId = nonEmptyString(payload.request_id)
  if (
    event.schema_version !== 1
    || event.event_id !== eventId
    || typeof eventId !== 'string'
    || typeof dedupeKey !== 'string'
    || requestId === null
  ) throw invalidArtifact('Backup artifact outbox event identity is invalid')

  if (event.event_type === 'usage.settled.v1') {
    if (
      event.aggregate_type !== 'user'
      || event.aggregate_id !== payload.user_id
      || payload.subscription_id !== identity.objectId
      || eventId !== `usage:${requestId}`
      || dedupeKey !== `usage:${requestId}`
    ) throw invalidArtifact('Backup artifact usage outbox event is inconsistent')
    return
  }

  if (event.event_type === 'subscription.usage.settled.v1') {
    if (
      event.aggregate_type !== 'subscription'
      || event.aggregate_id !== identity.objectId
      || payload.subscription_id !== identity.objectId
      || eventId !== `subscription-usage:${requestId}`
      || dedupeKey !== `subscription:${requestId}`
    ) throw invalidArtifact('Backup artifact subscription outbox event is inconsistent')
    return
  }

  throw invalidArtifact('Backup artifact outbox event type is invalid')
}

function validateMutationRow(
  captured: SqliteDoBackupSnapshot,
  row: SqliteDoBackupRow,
  identity: SqliteDoBackupIdentity,
): void {
  const operation = valueForBackupRow(captured, row, 'operation')
  const controlVersion = valueForBackupRow(captured, row, 'control_version')
  const payload = parseJsonObject(valueForBackupRow(captured, row, 'payload_json'))
  const windows = parseEmbeddedObject(payload.windows)
  const resetWindows = ['daily', 'weekly', 'monthly'].map((kind) => windows[kind])
  if (
    operation !== 'reset_quota'
    || payload.subscription_id !== identity.objectId
    || !Number.isSafeInteger(controlVersion) || (controlVersion as number) < 0
    || payload.control_version !== controlVersion
    || resetWindows.some((value) => value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))
    || resetWindows.every((value) => value === null)
  ) throw invalidArtifact('Backup artifact subscription mutation is inconsistent')
}

function parseEmbeddedObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArtifact('Backup artifact payload contains an invalid object')
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
