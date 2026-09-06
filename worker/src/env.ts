export interface Env {
  APP_VERSION: string
  ENVIRONMENT: string
  /** Enables the bounded Gemini Batch bridge for eligible image batches. */
  BATCH_PROVIDER_JOBS_ENABLED?: string
  /** Canonical externally reachable origin for OAuth callbacks and public links. */
  PUBLIC_ORIGIN?: string

  ASSETS: Fetcher
  DB: D1Database
  CONFIG_KV: KVNamespace
  OBJECTS: R2Bucket
  EVENTS_QUEUE: Queue<PlatformEvent>
  USER_STATE: DurableObjectNamespace
  /** Subscription quota authority. Optional only so unrelated unit fixtures stay compact; billing fails closed. */
  SUBSCRIPTION_STATE?: DurableObjectNamespace
  POOL_STATE: DurableObjectNamespace
  /** User-partitioned API-key ingress admission. Optional only for legacy unit fixtures; configured requests fail closed. */
  API_KEY_LIMIT_STATE?: DurableObjectNamespace
  /** Password-entry limiter. Optional in types so non-auth fixtures remain small; auth fails closed. */
  AUTH_RATE_LIMIT?: DurableObjectNamespace
  /** Native Cloudflare email delivery binding. Preferred when configured. */
  SEND_EMAIL?: SendEmail
  /** Verified sender address used with SEND_EMAIL. */
  EMAIL_FROM_ADDRESS?: string
  /** Compatibility Worker-to-Worker email renderer/delivery service. */
  EMAIL_DELIVERY?: Fetcher

  /** HMAC key for customer API keys. Must be a high-entropy Worker secret. */
  API_KEY_PEPPER?: string
  /** Independent high-entropy key used to encrypt upstream credentials. */
  CREDENTIALS_MASTER_KEY?: string
  /** Enables the minimal bootstrap endpoint when configured as a Worker secret. */
  ADMIN_TOKEN?: string
  /** Cloudflare Turnstile secret used when public authentication enables captcha checks. */
  TURNSTILE_SECRET_KEY?: string

  /** Explicit WebAuthn relying-party boundary. Never infer this from an incoming Host header. */
  WEBAUTHN_RP_ID?: string
  WEBAUTHN_RP_NAME?: string
  /** JSON array (preferred) or comma-separated allow-list of exact HTTPS origins. */
  WEBAUTHN_RP_ORIGINS?: string
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
  billing_type: 'balance' | 'subscription'
  subscription_id: string | null
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
  /** Added in v0.31; absent only on older queued events. */
  standard_cost_micros?: number
  /** Custom/channel account-statistics override before the account multiplier. */
  account_stats_cost_micros?: number | null
  /** Added in v0.31; absent only on older queued events. */
  account_rate_multiplier_ppm?: number
  /** Immutable provider-account cost after the account multiplier. */
  account_cost_micros?: number
  /** Immutable customer/channel pricing decision; absent only on older queued events. */
  customer_pricing_snapshot_json?: string | null
  outcome: 'completed' | 'failed' | 'cancelled'
  stream: boolean
  platform: string
  request_type: 0 | 1 | 2 | 3 | 4 | 5
  inbound_endpoint: string
  upstream_endpoint: string
  billing_mode: 'token' | 'per_request' | 'image' | 'video'
  native_compaction_v2: boolean
  image_count?: number
  image_size?: '1K' | '2K' | '4K' | 'mixed' | null
  image_input_size?: string | null
  image_output_size?: string | null
  image_size_source?: 'output' | 'input' | 'default' | 'legacy' | null
  image_size_breakdown?: Partial<Record<'1K' | '2K' | '4K', number>> | null
  duration_ms: number
  estimated: boolean
}

export interface UserStateChangedPayload {
  mutation_id: string
  user_id: string
  state_version: number
  balance_micros: number
  /** Added in migration 0048; absent only on pre-0048 queued events. */
  spend_debt_micros?: number
  enabled: boolean
  updated_at_ms: number
  /**
   * Exact financial transition emitted from the same Durable Object
   * transaction as the authoritative ledger entry. Missing only on legacy
   * events and non-financial enabled-state changes.
   */
  financial_event?: UserFinancialEventPayload
}

export type UserFinancialEventSource =
  | 'opening_balance'
  | 'admin_adjustment'
  | 'redeem_code'
  | 'affiliate_transfer'
  | 'affiliate_refund_clawback'
  | 'auth_source_entitlement'
  | 'usage_settlement'
  | 'other_adjustment'

export interface UserFinancialEventPayload {
  event_type: 'opening_balance' | 'balance_adjustment' | 'settlement'
  source_type: UserFinancialEventSource
  source_id: string
  request_id: string | null
  actor_user_id: string | null
  actor_session_id: string | null
  /** Exact balance change; this can differ from gross when debt is involved. */
  amount_delta_micros: number
  /** Requested adjustment or total settled charge before debt allocation. */
  gross_amount_micros: number
  spend_debt_delta_micros: number
  balance_after_micros: number
  spend_debt_after_micros: number
}

/** Idempotent D1 projection delta emitted by the authoritative subscription Durable Object. */
export interface SubscriptionStateChangedPayload {
  request_id: string
  subscription_id: string
  user_id: string
  group_id: string
  amount_micros: number
  daily_window_start_ms: number
  weekly_window_start_ms: number
  monthly_window_start_ms: number
  /** Reservation-captured discriminator for daily resets or restarted terms sharing a UTC anchor. */
  quota_reset_epoch: number
  updated_at_ms: number
}
