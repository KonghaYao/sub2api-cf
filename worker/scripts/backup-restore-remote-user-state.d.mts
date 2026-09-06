import type { RemoteExecutor, RemoteStep } from './backup-restore-remote.mjs'

export interface StateBackupRemoteAdapter extends RemoteExecutor {
  supports(step: RemoteStep): boolean
  execute(step: RemoteStep): Promise<unknown>
  verify(step: RemoteStep): Promise<unknown>
}

export type UserStateBackupRemoteAdapter = StateBackupRemoteAdapter

export function createUserStateBackupRemoteAdapter(options: {
  readonly environment: 'staging' | 'production'
  readonly origin: string
  readonly token: string
  readonly fetcher?: (request: Request) => Promise<Response>
  readonly timeoutMs?: number
}): StateBackupRemoteAdapter

export function createSubscriptionStateBackupRemoteAdapter(options: {
  readonly environment: 'staging' | 'production'
  readonly origin: string
  readonly token: string
  readonly fetcher?: (request: Request) => Promise<Response>
  readonly timeoutMs?: number
}): StateBackupRemoteAdapter
