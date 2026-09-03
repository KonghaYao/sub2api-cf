export type GatewayEndpoint = 'chat_completions' | 'responses'

export interface GatewayPrincipal {
  api_key_id: string
  api_key_auth_version: number
  user_id: string
  group_id: string
  platform: string
  balance_micros: number
  user_state_version: number
}

export interface ModelRoute {
  model_id: string
  public_name: string
  upstream_name: string
  endpoint: GatewayEndpoint | 'both'
  price_id: string
  price_version: number
  input_micros_per_million: number
  output_micros_per_million: number
  cache_read_micros_per_million: number
  per_request_micros: number
  minimum_reservation_micros: number
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
