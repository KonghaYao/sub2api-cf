import type { Env } from '../env'
import type { ObservabilityPayload } from './redaction'

export type RequestLifecycle = 'started' | 'completed' | 'failed' | 'cancelled'
export type PayloadState = 'none' | 'pending' | 'stored' | 'retry' | 'deleted'

/** Optional dedicated bindings; production may initially reuse OBJECTS/EVENTS_QUEUE. */
export type ObservabilityEnv = Env & {
  OBSERVABILITY_OBJECTS?: R2Bucket
  OBSERVABILITY_QUEUE?: Queue<ObservabilityQueueMessage>
}

export interface RequestObservationStart {
  requestId: string
  clientRequestId?: string | null
  userId?: string | null
  apiKeyId?: string | null
  accountId?: string | null
  groupId?: string | null
  method: string
  requestPath: string
  inboundEndpoint?: string
  platform?: string
  requestedModel?: string
  requestType?: number | null
  stream?: boolean
  occurredAtMs?: number
}

export interface RequestObservationHandle {
  id: string
  requestId: string
  occurredAtMs: number
}

export interface RequestObservationContextUpdate {
  userId?: string | null
  apiKeyId?: string | null
  groupId?: string | null
  platform?: string
  requestedModel?: string
  requestType?: number | null
  stream?: boolean
}

export interface RequestObservationOutcome {
  lifecycle: Exclude<RequestLifecycle, 'started'>
  statusCode: number
  completedAtMs?: number
  upstreamModel?: string
  accountId?: string | null
  durationMs?: number
  outcome?: 'completed' | 'failed' | 'cancelled'
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  amountMicros?: number
  error?: {
    phase?: string
    type?: string
    owner?: string
    source?: string
    severity?: string
    message?: string
    upstreamStatusCode?: number | null
    isBusinessLimited?: boolean
  }
  payload?: ObservabilityPayload
}

export interface ObservabilityPayloadRetryMessage {
  schema_version: 1
  event_type: 'observability.payload.retry'
  observation_id: string
  object_key: string
  sha256: string
  content_type: 'application/json'
  payload: string
  attempt: number
  not_before_ms: number
}

export type ObservabilityQueueMessage = ObservabilityPayloadRetryMessage

export interface PayloadProjection {
  state: 'available' | 'missing' | 'expired' | 'pending_recovery'
  body: string | null
  content_type: string | null
  redacted: boolean
}

export interface ObservationRow {
  id: string
  request_id: string
  client_request_id: string | null
  bucket_day: number
  occurred_at_ms: number
  completed_at_ms: number | null
  lifecycle: RequestLifecycle
  user_id: string | null
  api_key_id: string | null
  account_id: string | null
  group_id: string | null
  method: string
  request_path: string
  inbound_endpoint: string
  platform: string
  requested_model: string
  upstream_model: string
  request_type: number | null
  stream: number
  status_code: number | null
  duration_ms: number | null
  outcome: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  amount_micros: number
  error_phase: string
  error_type: string
  error_owner: string
  error_source: string
  severity: string
  error_message: string
  upstream_status_code: number | null
  is_business_limited: number
  resolved: number
  resolved_at_ms: number | null
  resolved_by_user_id: string | null
  payload_state: PayloadState
  payload_object_key: string | null
  payload_sha256: string | null
  payload_bytes: number
  payload_content_type: string | null
  payload_attempts: number
  payload_retry_after_ms: number | null
  payload_lease_id: string | null
  payload_lease_expires_at_ms: number | null
  payload_last_error: string | null
  updated_at_ms: number
}
