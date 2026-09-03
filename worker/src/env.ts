export interface Env {
  APP_VERSION: string
  ENVIRONMENT: string

  ASSETS: Fetcher
  DB: D1Database
  CONFIG_KV: KVNamespace
  OBJECTS: R2Bucket
  EVENTS_QUEUE: Queue<PlatformEvent>
  USER_STATE: DurableObjectNamespace
  POOL_STATE: DurableObjectNamespace

  /** HMAC key for customer API keys. Must be a high-entropy Worker secret. */
  API_KEY_PEPPER?: string
  /** Independent high-entropy key used to encrypt upstream credentials. */
  CREDENTIALS_MASTER_KEY?: string
  /** Enables the minimal bootstrap endpoint when configured as a Worker secret. */
  ADMIN_TOKEN?: string
}

export interface PlatformEvent<TPayload = unknown> {
  schema_version: 1
  event_id: string
  event_type: string
  occurred_at_ms: number
  aggregate_type: string
  aggregate_id: string
  payload: TPayload
}

export interface UsageSettledPayload {
  request_id: string
  user_id: string
  api_key_id: string
  group_id: string
  account_id: string
  price_id: string
  requested_model: string
  upstream_model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  input_amount_micros: number
  output_amount_micros: number
  cache_amount_micros: number
  base_amount_micros: number
  amount_micros: number
  outcome: 'completed' | 'failed' | 'cancelled'
  stream: boolean
  duration_ms: number
  estimated: boolean
}

export interface UserStateChangedPayload {
  mutation_id: string
  user_id: string
  state_version: number
  balance_micros: number
  enabled: boolean
  updated_at_ms: number
}
