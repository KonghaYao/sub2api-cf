import type { BackupArtifactKind } from './backup-restore.mjs'

export type RemoteEnvironment = 'staging' | 'production'
export type RemotePhase = 'd1' | 'durable-objects' | 'r2'
export type RemoteTransport = 'command' | 'api-contract'

export interface DurableObjectSelection {
  readonly namespace: string
  readonly objectId: string
  readonly logicalName: string
}

export interface EmptyTargetProof {
  readonly schema: 'sub2api-cloudflare-empty-target-proof'
  readonly version: 1
  readonly environment: RemoteEnvironment
  readonly account_id: string
  readonly checked_at: string
  readonly d1: {
    readonly binding: string
    readonly database_name: string
    readonly user_table_count: number
  }
  readonly durable_objects: readonly {
    readonly namespace: string
    readonly object_id: string
    readonly storage_entry_count: number
  }[]
  readonly r2: {
    readonly binding: string
    readonly bucket_name: string
    readonly object_count: number
  }
}

export interface RemoteStep {
  readonly sequence: number
  readonly id: string
  readonly phase: RemotePhase
  readonly operation: string
  readonly transport: RemoteTransport
  readonly contract_only?: true
  readonly resource: Readonly<Record<string, unknown>>
  readonly command?: {
    readonly executable: 'wrangler'
    readonly arguments: readonly string[]
  }
  readonly request?: Readonly<Record<string, unknown>>
  readonly output?: string
  readonly artifact?: {
    readonly kind: BackupArtifactKind
    readonly logicalName: string
    readonly source: string
  } | string
  readonly artifact_sha256?: string
  readonly artifact_bytes?: number
  readonly postcondition: Readonly<Record<string, unknown>>
}

export interface RemotePlan {
  readonly schema: 'sub2api-cloudflare-remote-plan'
  readonly version: 1
  readonly plan_id: string
  readonly operation: 'backup' | 'restore'
  readonly environment: RemoteEnvironment
  readonly dry_run: true
  readonly account_id: string
  readonly bundle_directory: string
  readonly steps: readonly RemoteStep[]
  readonly working_directory?: string
  readonly manifest_sha256?: string
  readonly empty_target_proof?: EmptyTargetProof
  readonly empty_target_proof_sha256?: string
}

export interface RemoteJournal {
  readonly schema: 'sub2api-cloudflare-remote-journal'
  readonly version: 1
  readonly plan_id: string
  readonly operation: 'backup' | 'restore'
  readonly environment: RemoteEnvironment
  readonly status: 'running' | 'failed' | 'publishing' | 'completed'
  readonly completed_step_ids: readonly string[]
  readonly failed_step_id: string | null
  readonly next_step_id: string | null
  readonly verified_postconditions: readonly Readonly<Record<string, unknown>>[]
  readonly updated_at: string
}

export interface RemoteExecutor {
  supports(step: RemoteStep): boolean | Promise<boolean>
  execute(step: RemoteStep): Promise<unknown>
  verify?(step: RemoteStep): Promise<unknown>
}

export function createRemoteBackupPlan(options: {
  readonly environment: RemoteEnvironment
  readonly accountId: string
  readonly workingDirectory: string
  readonly bundleDirectory: string
  readonly durableObjects: DurableObjectSelection[]
}): RemotePlan

export function createRemoteRestorePlan(options: {
  readonly environment: RemoteEnvironment
  readonly accountId: string
  readonly bundleDirectory: string
  readonly emptyTargetProof: EmptyTargetProof
  readonly now?: Date
}): Promise<RemotePlan>

export function executeRemotePlan(options: {
  readonly plan: RemotePlan
  readonly executor?: RemoteExecutor
  readonly apply?: boolean
  readonly confirmation?: string
  readonly journalPath?: string
  readonly now?: Date
}): Promise<
  | { readonly status: 'dry-run'; readonly plan: RemotePlan }
  | { readonly status: 'completed'; readonly plan: RemotePlan; readonly journal: RemoteJournal }
>

export function parseRemoteCliArguments(
  arguments_: string[],
  cwd: string,
): Record<string, unknown>
