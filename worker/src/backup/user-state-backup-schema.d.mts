export interface UserStateBackupColumnContract {
  readonly cid: number
  readonly name: string
  readonly type: string
  readonly not_null: number
  readonly default_value: string | null
  readonly primary_key: number
}

export interface UserStateBackupTableContract {
  readonly name: string
  readonly columns: readonly UserStateBackupColumnContract[]
}

export const USER_STATE_BACKUP_V1_SCHEMA: readonly UserStateBackupTableContract[]
