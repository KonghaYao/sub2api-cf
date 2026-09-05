import type { Env, PlatformEvent } from '../env'
import type { GatewayPrincipal } from '../gateway/types'

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

export interface MediaBillingCancellationInput {
  env: MediaEnv
  task: MediaTaskRow
}

export interface MediaBilling {
  reserve(input: MediaBillingInput): Promise<void>
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
}

export interface MediaTaskExecutePayload {
  task_id: string
}

export type MediaTaskExecuteEvent = PlatformEvent<MediaTaskExecutePayload> & {
  event_type: 'media.task.execute.v1'
  aggregate_type: 'media_task'
}

export interface MediaTaskOwner {
  userId: string
  apiKeyId?: string
}
