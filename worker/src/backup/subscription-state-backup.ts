import { StateApiError } from '../state/http'
import { SUBSCRIPTION_STATE_BACKUP_V1_SCHEMA } from './subscription-state-backup-schema.mjs'
import {
  exportSqliteDoBackup,
  inspectSqliteDoBackup,
  restoreSqliteDoBackup,
  valueForBackupRow,
  type SqliteDoBackupContract,
  type SqliteDoBackupIdentity,
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
