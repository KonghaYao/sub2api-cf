import type {
  ProviderAuthScheme,
  ProviderConfig,
  ProviderPlatform,
  ProviderProtocol,
} from './providers'

export type GatewayEndpoint = 'chat_completions' | 'responses' | 'embeddings' | 'images'
export type GenerativeGatewayEndpoint = Exclude<GatewayEndpoint, 'embeddings' | 'images'>

export interface GatewayPrincipal {
  api_key_id: string
  api_key_auth_version: number
  user_id: string
  group_id: string
  platform: string
  balance_micros: number
  user_state_version: number
  /** D1-to-DO limit projection contract. Version 1 is introduced by migration 0022. */
  limit_config_version: number
  /** Original user-wide concurrency ceiling; zero means unlimited. */
  concurrency_limit: number
  /** Original user-wide fixed-minute request ceiling; zero means unlimited. */
  user_rpm_limit: number
  /** Effective override-or-group fixed-minute ceiling; zero means exempt/unlimited. */
  group_rpm_limit: number
  /** Complete D1 projection used to configure the user-sharded monetary authority. */
  api_key_monetary: ApiKeyMonetaryPolicy
  /** User-wide standard-billing quota for this request's canonical platform. */
  platform_quota?: PlatformQuotaPolicy | null
  billing: GatewayBilling
}

export interface PlatformQuotaPolicy {
  platform: 'anthropic' | 'openai' | 'gemini' | 'antigravity' | 'grok'
  control_version: number
  daily_limit_micros: number | null
  weekly_limit_micros: number | null
  monthly_limit_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  daily_reset_epoch: number
  weekly_reset_epoch: number
  monthly_reset_epoch: number
}

export interface PlatformQuotaWindowSnapshot {
  reset_epoch: number
  window_start_ms: number
  settled_micros: number
  active_reserved_micros: number
  updated_at_ms: number
}

export interface PlatformQuotaUsageSnapshot {
  user_id: string
  platform: PlatformQuotaPolicy['platform']
  control_version: number
  daily: PlatformQuotaWindowSnapshot
  weekly: PlatformQuotaWindowSnapshot
  monthly: PlatformQuotaWindowSnapshot
}

export interface ApiKeyMonetaryPolicy {
  control_version: number
  quota_micros: number
  quota_used_micros: number
  rate_limit_5h_micros: number
  rate_limit_1d_micros: number
  rate_limit_7d_micros: number
  usage_5h_micros: number
  usage_1d_micros: number
  usage_7d_micros: number
  window_5h_start_ms: number | null
  window_1d_start_ms: number | null
  window_7d_start_ms: number | null
  quota_reset_epoch: number
  rate_limit_reset_epoch: number
}

export interface ApiKeyMonetaryWindowSnapshot {
  api_key_id: string
  kind: '5h' | '1d' | '7d'
  window_started_at_ms: number
  settled_micros: number
  updated_at_ms: number
}

export interface ApiKeyMonetaryUsageSnapshot {
  api_key_id: string
  quota_reset_epoch: number
  rate_limit_reset_epoch: number
  total_settled_micros: number
  active_reserved_micros: number
  windows: [
    ApiKeyMonetaryWindowSnapshot,
    ApiKeyMonetaryWindowSnapshot,
    ApiKeyMonetaryWindowSnapshot,
  ]
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
  platform: ProviderPlatform
  model_id: string
  public_name: string
  upstream_name: string
  endpoint: GenerativeGatewayEndpoint | 'both'
  /** D1 capability flag; absent only in legacy test fixtures constructed before migration 0008. */
  embeddings?: number
  /** D1 capability flag; absent only in legacy test fixtures constructed before migration 0044. */
  image_generation?: number
  price_id: string
  price_version: number
  input_micros_per_million: number
  output_micros_per_million: number
  cache_read_micros_per_million: number
  per_request_micros: number
  minimum_reservation_micros: number
  /**
   * Immutable base catalog price used for provider-account cost reporting.
   * A channel mapping may point these fields at a different known catalog
   * model while the unprefixed price fields remain the customer charge basis.
   */
  account_cost_base_price_id?: string
  account_cost_base_price_version?: number
  account_cost_base_input_micros_per_million?: number
  account_cost_base_output_micros_per_million?: number
  account_cost_base_cache_read_micros_per_million?: number
  account_cost_base_per_request_micros?: number
  group_rate_multiplier_ppm: number
  user_rate_multiplier_ppm: number | null
  /** Effective multiplier used for reservation and settlement calculations. */
  rate_multiplier_ppm: number
  max_output_tokens: number
  default_max_output_tokens: number
}

export interface AccountCandidate {
  upstream_endpoint?: GatewayEndpoint
  account_id: string
  upstream_billing_probe_json?: string | null
  billing_rate_multiplier_ppm?: number
  image_adapter: AccountImageAdapter
  credential_kind: AccountCredentialKind
  platform: ProviderPlatform
  protocol: ProviderProtocol
  auth_scheme: ProviderAuthScheme
  provider_config: ProviderConfig
  base_url: string
  max_concurrency: number
  load_factor?: number
  priority: number
  weight: number
  config_version: number
  /** Administrative recovery signal consumed by the pool on the next config sync. */
  recovery_revision: number
  config_revision: number
}

export type AccountImageAdapter = 'direct_images' | 'responses_image_tool'
export type AccountCredentialKind = 'api_key' | 'oauth' | 'setup_token'

export interface AccountCredential {
  runtime_snapshot?: { config_version: number; control_version: number; ui_config_json: string }
  anthropic_auth_scheme?: 'authorization_bearer'
  upstream_model_name?: string
  codex_cli_only?: number | boolean
  codex_cli_only_allow_app_server?: number | boolean
  proxy_id?: string | number | null
  account_id: string
  image_adapter: AccountImageAdapter
  credential_kind: AccountCredentialKind
  platform: ProviderPlatform
  protocol: ProviderProtocol
  base_url: string
  auth_scheme: ProviderAuthScheme
  provider_config: ProviderConfig
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
  /** Cache-creation input included in input_tokens, when the provider reports it. */
  cache_write_tokens?: number
  cache_write_5m_tokens?: number
  cache_write_1h_tokens?: number
  cache_ttl_overridden?: boolean
  estimated: boolean
}

export interface CostBreakdown {
  cache_write_amount_micros?: number
  input_amount_micros: number
  output_amount_micros: number
  cache_amount_micros: number
  base_amount_micros: number
  amount_micros: number
}
