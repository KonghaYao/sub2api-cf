export interface SubscriptionStateBackupColumnContract {
  readonly cid: number
  readonly name: string
  readonly type: string
  readonly not_null: number
  readonly default_value: string | null
  readonly primary_key: number
}

export interface SubscriptionStateBackupTableContract {
  readonly name: string
  readonly columns: readonly SubscriptionStateBackupColumnContract[]
}

export const SUBSCRIPTION_STATE_BACKUP_V1_SCHEMA: readonly SubscriptionStateBackupTableContract[]
