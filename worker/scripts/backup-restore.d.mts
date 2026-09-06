export type BackupArtifactKind = 'd1-sql' | 'do-ndjson' | 'r2-inventory'

export interface BackupArtifactInput {
  readonly kind: BackupArtifactKind
  readonly logicalName: string
  readonly source: string
  readonly filePath: string
}

export interface BackupArtifact {
  readonly kind: BackupArtifactKind
  readonly logical_name: string
  readonly source: string
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface BackupManifest {
  readonly schema: 'sub2api-cloudflare-backup'
  readonly version: 1
  readonly created_at: string
  readonly artifacts: readonly BackupArtifact[]
}

export interface RestoreStep {
  readonly sequence: number
  readonly id: string
  readonly kind: BackupArtifactKind
  readonly operation: 'import-d1-sql' | 'import-do-ndjson' | 'reconcile-r2-inventory'
  readonly source: string
  readonly artifact: string
  readonly relative_target: string
  readonly target: string
  readonly bytes: number
  readonly sha256: string
}

export interface RestorePlan {
  readonly schema: 'sub2api-cloudflare-restore-plan'
  readonly version: 1
  readonly bundle_created_at: string
  readonly target: string
  readonly steps: readonly RestoreStep[]
}

export function createBackupBundle(options: {
  readonly outputDirectory: string
  readonly createdAt?: string
  readonly artifacts: BackupArtifactInput[]
}): Promise<BackupManifest>

export function verifyBackupBundle(bundleDirectory: string): Promise<BackupManifest>

export function createRestorePlan(options: {
  readonly bundleDirectory: string
  readonly targetDirectory: string
}): Promise<RestorePlan>

export function restoreBackupBundle(options: {
  readonly bundleDirectory: string
  readonly targetDirectory: string
  readonly dryRun?: boolean
}): Promise<RestorePlan>

export function parseCliArguments(arguments_: string[], cwd: string): Record<string, unknown>
