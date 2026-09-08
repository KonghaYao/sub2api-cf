import type { Env, PlatformEvent } from '../env'
import type { GatewayPrincipal } from '../gateway/types'
import type { GeminiBatchClient } from './gemini-batch'

export type MediaTaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'settling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'output_deleted'

export interface MediaReferenceImage {
  id?: string
  type?: string
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  data?: string
  file_uri?: string
}

export interface MediaSubmitItem {
  custom_id: string
  prompt: string
  output_count: number
  reference_images: MediaReferenceImage[]
}

export interface MediaManifest {
  model: string
  upstream_model: string
  task_name: string
  parent_batch_id: string | null
  provider: 'gemini_api'
  image_size: '1K' | '2K' | '4K'
  response_mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  aspect_ratio: string | null
  metadata: Record<string, string>
  items: MediaSubmitItem[]
}

export interface MediaTaskRow {
  id: string
  user_id: string
  api_key_id: string
  group_id: string
  parent_task_id: string | null
  task_name: string
  provider: 'gemini_api'
  model: string
  upstream_model: string
  image_size: '1K' | '2K' | '4K'
  response_mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  aspect_ratio: string | null
  execution_mode: 'inline_v1' | 'provider_job_v1'
  status: MediaTaskStatus
  item_count: number
  expected_output_count: number
  success_count: number
  fail_count: number
  cancelled_count: number
  base_unit_price_micros: number
  price_id: string
  effective_rate_multiplier_ppm: number
  batch_discount_multiplier_ppm: number
  hold_multiplier_ppm: number
  billable_unit_price_micros: number
  hold_unit_price_micros: number
  estimated_cost_micros: number
  hold_amount_micros: number
  actual_cost_micros: number | null
  billing_type: 'balance' | 'subscription'
  subscription_id: string | null
  platform_quota_platform: string | null
  billing_status: 'unreserved' | 'reserved' | 'settling' | 'settled' | 'released'
  idempotency_key_hash: string
  request_hash: string
  input_object_key: string
  enqueued_at_ms: number | null
  provider_account_id: string | null
  last_error_code: string | null
  last_error_message: string | null
  version: number
  created_at_ms: number
  updated_at_ms: number
  submitted_at_ms: number | null
  started_at_ms: number | null
  finished_at_ms: number | null
  settled_at_ms: number | null
  downloaded_at_ms: number | null
  output_deleted_at_ms: number | null
  user_deleted_at_ms: number | null
}

export interface MediaTaskItemRow {
  task_id: string
  custom_id: string
  ordinal: number
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  output_count: number
  image_count: number
  prompt_preview: string | null
  request_hash: string
  mime_type: string | null
  file_extension: string | null
  error_code: string | null
  error_message: string | null
  attempt_token: string | null
  attempt_started_at_ms: number | null
  attempt_count: number
  created_at_ms: number
  completed_at_ms: number | null
  provider_record_object_key: string | null
  provider_record_sha256: string | null
  provider_record_ordinal: number | null
}

export type MediaProviderJobPhase =
  | 'input_pending'
  | 'submit_pending'
  | 'submit_unknown'
  | 'poll_pending'
  | 'result_pending'
  | 'materialize_pending'
  | 'cancel_pending'
  | 'attention'
  | 'cleanup_pending'
  | 'done'

export interface MediaProviderJobRow {
  provider_model?: string | null
  task_id: string
  provider_account_id: string
  submission_key: string
  provider_job_id: string | null
  phase: MediaProviderJobPhase
  provider_raw_state: string | null
  next_action_at_ms: number
  deadline_at_ms: number
  attempt_count: number
  consecutive_errors: number
  poll_count: number
  reservation_renewal_sequence: number
  lease_token: string | null
  lease_expires_at_ms: number | null
  result_manifest_object_key: string | null
  result_manifest_sha256: string | null
  result_cursor_json: string | null
  result_complete: number
  cancel_requested_at_ms: number | null
  provider_terminal_at_ms: number | null
  version: number
  created_at_ms: number
  updated_at_ms: number
  last_error_class: string | null
  last_error_code: string | null
}

export interface MediaProviderJobAccount {
  proxyId?: string
  upstreamModel?: string
  id: string
  baseUrl: string
  apiKey: string
}

export interface MediaProviderJobAccountResolver {
  select(env: MediaEnv, task: Pick<MediaTaskRow, 'group_id' | 'model' | 'upstream_model'>): Promise<MediaProviderJobAccount>
  exact(env: MediaEnv, accountId: string): Promise<MediaProviderJobAccount>
}

export interface MediaTaskOutputRow {
  task_id: string
  custom_id: string
  image_index: number
  object_key: string
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  file_extension: 'png' | 'jpg' | 'webp'
  byte_length: number
  sha256: string
  created_at_ms: number
}

export interface MediaProviderOutput {
  bytes: ArrayBuffer
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
}

export interface MediaProviderItemResult {
  customId: string
  outputs?: MediaProviderOutput[]
  error?: { code: string; message: string }
}

export interface MediaProviderRequest {
  env: MediaEnv
  task: MediaTaskRow
  manifest: MediaManifest
}

export interface MediaProviderResult {
  accountId?: string
  items: MediaProviderItemResult[]
}

export interface MediaProvider {
  generate(input: MediaProviderRequest): Promise<MediaProviderResult>
}

export interface MediaBillingInput {
  env: MediaEnv
  principal: GatewayPrincipal
  requestId: string
  amountMicros: number
}

export interface MediaBillingSettlementInput {
  env: MediaEnv
  task: MediaTaskRow
  amountMicros: number
  occurredAtMs: number
}

export interface MediaBillingRenewalInput {
  env: MediaEnv
  task: MediaTaskRow
  sequence: number
}

export interface MediaBillingCancellationInput {
  env: MediaEnv
  task: MediaTaskRow
}

export interface MediaBilling {
  reserve(input: MediaBillingInput): Promise<void>
  renew(input: MediaBillingRenewalInput): Promise<void>
  settle(input: MediaBillingSettlementInput): Promise<void>
  cancel(input: MediaBillingCancellationInput): Promise<void>
}

export interface MediaEnv extends Env {
  /** Test/extension seam. Production falls back to the built-in Gemini provider. */
  MEDIA_PROVIDER?: MediaProvider
  /** Test seam. Production falls back to the Durable Object billing adapter. */
  MEDIA_BILLING?: MediaBilling
  /** Optional dedicated bucket. Production otherwise uses OBJECTS. */
  MEDIA_OBJECTS?: R2Bucket
  /** Test/extension seam. Production uses the built-in Gemini Batch client. */
  MEDIA_PROVIDER_JOB_CLIENT?: GeminiBatchClient
  /** Test seam for schedulable and exact-account credential resolution. */
  MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER?: MediaProviderJobAccountResolver
}

export interface MediaTaskExecutePayload {
  task_id: string
}

export type MediaTaskExecuteEvent = PlatformEvent<MediaTaskExecutePayload> & {
  event_type: 'media.task.execute.v1'
  aggregate_type: 'media_task'
}

export interface MediaProviderJobAdvancePayload {
  task_id: string
  expected_version: number
}

export type MediaProviderJobAdvanceEvent = PlatformEvent<MediaProviderJobAdvancePayload> & {
  event_type: 'media.provider_job.advance.v1'
  aggregate_type: 'media_provider_job'
}

export interface MediaTaskOwner {
  userId: string
  apiKeyId?: string
}
