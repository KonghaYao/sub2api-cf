import { StateApiError } from '../state/http'
import {
  exportSqliteDoBackup,
  inspectSqliteDoBackup,
  restoreSqliteDoBackup,
  rowsForBackupTable,
  valueForBackupRow,
  type SqliteDoBackupContract,
  type SqliteDoBackupIdentity,
  type SqliteDoBackupSnapshot,
} from './sqlite-do-backup'
import { USER_STATE_BACKUP_V1_SCHEMA } from './user-state-backup-schema.mjs'

const TABLE_NAMES = [
  'user_profile',
  'user_state_metadata',
  'user_ledger',
  'user_requests',
  'user_ledger_tombstones',
  'user_outbox',
] as const

const CONTRACT: SqliteDoBackupContract = {
  artifactSchema: 'sub2api-user-state-backup',
  namespace: 'USER_STATE',
  tableNames: TABLE_NAMES,
  schemaContract: USER_STATE_BACKUP_V1_SCHEMA,
  isLogicallyEmpty,
  validateLogicalState,
}

export function exportUserStateBackup(
  storage: DurableObjectStorage,
  identity: SqliteDoBackupIdentity,
): Promise<Response> {
  return exportSqliteDoBackup(storage, identity, CONTRACT)
}

export function inspectUserStateBackup(
  storage: DurableObjectStorage,
  identity: SqliteDoBackupIdentity,
): Promise<Response> {
  return inspectSqliteDoBackup(storage, identity, CONTRACT)
}

export function restoreUserStateBackup(
  storage: DurableObjectStorage,
  request: Request,
  identity: SqliteDoBackupIdentity,
): Promise<Response> {
  return restoreSqliteDoBackup(storage, request, identity, CONTRACT)
}

export function readUserStateBackupIdentity(request: Request): SqliteDoBackupIdentity {
  const environment = request.headers.get('x-sub2api-backup-environment') ?? ''
  const namespace = request.headers.get('x-sub2api-backup-namespace') ?? ''
  const objectId = request.headers.get('x-sub2api-backup-object-id') ?? ''
  if (environment.length === 0 || environment.length > 64) {
    throw new StateApiError(400, 'invalid_backup_identity', 'Backup environment is invalid')
  }
  if (namespace !== 'USER_STATE') {
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
  const profiles = rowsForBackupTable(captured, 'user_profile')
  const metadata = rowsForBackupTable(captured, 'user_state_metadata')
  if (metadata.length !== 1) throw invalidArtifact('Backup artifact requires one state metadata row')
  if (
    valueForBackupRow(captured, metadata[0], 'singleton') !== 1
    || !Number.isSafeInteger(valueForBackupRow(captured, metadata[0], 'state_version'))
    || (valueForBackupRow(captured, metadata[0], 'state_version') as number) < 0
  ) throw invalidArtifact('Backup artifact state metadata is invalid')

  if (profiles.length === 0) {
    if (!isLogicallyEmpty(captured)) {
      throw invalidArtifact('Backup artifact contains state without a user profile')
    }
    return
  }
  if (profiles.length !== 1 || valueForBackupRow(captured, profiles[0], 'singleton') !== 1) {
    throw invalidArtifact('Backup artifact user profile is invalid')
  }
  if (valueForBackupRow(captured, profiles[0], 'user_id') !== identity.objectId) {
    throw invalidArtifact('Backup artifact user identity does not match its object')
  }
  for (const table of ['user_ledger', 'user_ledger_tombstones'] as const) {
    for (const row of rowsForBackupTable(captured, table)) {
      if (valueForBackupRow(captured, row, 'user_id') !== identity.objectId) {
        throw invalidArtifact('Backup artifact contains state for a different user')
      }
    }
  }
}

function isLogicallyEmpty(captured: SqliteDoBackupSnapshot): boolean {
  if (captured.rows.length !== 1) return false
  const metadata = captured.rows[0]
  if (metadata?.table !== 'user_state_metadata') return false
  const table = captured.tables.find(({ name }) => name === 'user_state_metadata')
  if (table === undefined) return false
  const singleton = table.columns.findIndex(({ name }) => name === 'singleton')
  const stateVersion = table.columns.findIndex(({ name }) => name === 'state_version')
  return singleton >= 0 && stateVersion >= 0
    && metadata.values[singleton] === 1
    && metadata.values[stateVersion] === 0
}

function invalidArtifact(message: string): StateApiError {
  return new StateApiError(400, 'invalid_backup_artifact', message)
}
