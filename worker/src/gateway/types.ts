export type GatewayEndpoint = 'chat_completions' | 'responses' | 'embeddings'
export type GenerativeGatewayEndpoint = Exclude<GatewayEndpoint, 'embeddings'>

export interface GatewayPrincipal {
  api_key_id: string
  api_key_auth_version: number
  user_id: string
  group_id: string
  platform: string
  balance_micros: number
  user_state_version: number
  billing: GatewayBilling
}

export type GatewayBilling =
  | { type: 'balance' }
  | {
      type: 'subscription'
      subscription_id: string
      starts_at_ms: number
      expires_at_ms: number
      daily_quota_micros: number | null
      weekly_quota_micros: number | null
      monthly_quota_micros: number | null
      daily_used_micros: number
      weekly_used_micros: number
      monthly_used_micros: number
      daily_anchor_ms: number
      daily_window_start_ms: number | null
      weekly_window_start_ms: number | null
      monthly_window_start_ms: number | null
      quota_reset_epoch: number
      quota_reset_generation: number
      control_version: number
    }

export interface ModelRoute {
  config_revision: number
  model_id: string
  public_name: string
  upstream_name: string
  endpoint: GenerativeGatewayEndpoint | 'both'
  /** D1 capability flag; absent only in legacy test fixtures constructed before migration 0008. */
  embeddings?: number
  price_id: string
  price_version: number
  input_micros_per_million: number
  output_micros_per_million: number
  cache_read_micros_per_million: number
  per_request_micros: number
  minimum_reservation_micros: number
  group_rate_multiplier_ppm: number
  user_rate_multiplier_ppm: number | null
  /** Effective multiplier used for reservation and settlement calculations. */
  rate_multiplier_ppm: number
  max_output_tokens: number
  default_max_output_tokens: number
}

export interface AccountCandidate {
  account_id: string
  base_url: string
  max_concurrency: number
  priority: number
  weight: number
  config_version: number
  config_revision: number
}

export interface AccountCredential {
  account_id: string
  base_url: string
  auth_scheme: 'bearer'
  secret_id: string
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
}

export interface UpstreamCredential {
  api_key: string
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  estimated: boolean
}

export interface CostBreakdown {
  input_amount_micros: number
  output_amount_micros: number
  cache_amount_micros: number
  base_amount_micros: number
  amount_micros: number
}
