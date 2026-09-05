import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import { apiClient, buildGatewayUrl } from './client'

export type BatchImageStatus =
  | 'queued'
  | 'running'
  | 'indexing'
  | 'processing_results'
  | 'settling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'output_deleted'
  | string

export interface BatchImageSubmitItem {
  custom_id: string
  prompt: string
  output_count?: number
  reference_images?: BatchImageReferenceImage[]
}

export interface BatchImageReferenceImage {
  id?: string
  type?: string
  mime_type: string
  data?: string
  file_uri?: string
}

export interface BatchImageSubmitRequest {
  model: string
  task_name?: string
  parent_batch_id?: string
  provider?: '' | 'gemini_api' | 'vertex' | string
  image_size?: '1K' | '2K' | '4K' | string
  response_mime_type?: string
  aspect_ratio?: string
  items: BatchImageSubmitItem[]
  metadata?: Record<string, string>
}

export interface BatchImageJob {
  id: string
  object: string
  task_name: string
  parent_batch_id?: string | null
  status: BatchImageStatus
  model: string
  provider: string
  item_count: number
  success_count: number
  fail_count: number
  estimated_cost: number
  hold_amount: number
  actual_cost: number | null
  created_at: number
  submitted_at: number | null
  settled_at: number | null
  downloaded_at?: number | null
  output_deleted_at?: number | null
}

export interface BatchImageItem {
  batch_id?: string
  source_task_name?: string
  custom_id: string
  status: string
  prompt_preview?: string | null
  mime_type: string | null
  file_extension: string | null
  image_count: number
  error?: {
    code: string
    message: string
    source?: 'provider' | 'system' | string
  } | null
}

export interface BatchImageItemsResponse {
  object: string
  data: BatchImageItem[]
  has_more: boolean
}

export interface BatchImageJobsResponse {
  object: string
  data: BatchImageJob[]
  has_more: boolean
}

export interface BatchImageModel {
  id: string
  object: string
  provider: string
}

export interface BatchImageModelsResponse {
  object: string
  data: BatchImageModel[]
}

export interface BatchImageJobsListOptions {
  limit?: number
  cursor?: string
  status?: string
  taskName?: string
  downloaded?: '' | 'true' | 'false' | string
  from?: string
  to?: string
}

export interface BatchImageItemsListOptions {
  status?: string
  limit?: number
  cursor?: string
}

export interface BatchImageCredential {
  id: string | number
  key?: string
}

async function parseBatchImageError(response: Response): Promise<Error> {
  try {
    const body = await response.json()
    const message = body?.error?.message || body?.message || response.statusText
    const error = new Error(message)
    ;(error as any).code = body?.error?.code || response.status
    ;(error as any).status = response.status
    ;(error as any).requestId = response.headers.get('X-Request-Id') || ''
    return error
  } catch {
    const error = new Error(response.statusText || `HTTP ${response.status}`)
    ;(error as any).code = response.status
    ;(error as any).status = response.status
    ;(error as any).requestId = response.headers.get('X-Request-Id') || ''
    return error
  }
}

function authHeaders(apiKey: string, extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  }
}

function requireLegacyApiKey(credential: BatchImageCredential): string {
  if (typeof credential.key === 'string' && credential.key.length > 0) {
    return credential.key
  }
  const error = new Error('The legacy batch image gateway requires the API key plaintext.')
  ;(error as Error & { code: string }).code = 'BATCH_IMAGE_API_KEY_PLAINTEXT_REQUIRED'
  throw error
}

function jobsListParams(
  credential: BatchImageCredential,
  options: number | BatchImageJobsListOptions,
  includeApiKeyId: boolean,
): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  if (includeApiKeyId) params.api_key_id = credential.id
  if (typeof options === 'number') {
    params.limit = options
    return params
  }
  params.limit = options.limit || 20
  if (options.cursor) params.cursor = options.cursor
  if (options.status) params.status = options.status
  if (options.taskName) params.task_name = options.taskName
  if (options.downloaded) params.downloaded = options.downloaded
  if (options.from) params.from = options.from
  if (options.to) params.to = options.to
  return params
}

function itemsListParams(options: string | BatchImageItemsListOptions): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  if (typeof options === 'string') {
    if (options) params.status = options
    return params
  }
  if (options.status) params.status = options.status
  if (options.limit !== undefined) params.limit = options.limit
  if (options.cursor) params.cursor = options.cursor
  return params
}

export async function submitBatchImageJob(
  credential: BatchImageCredential,
  payload: BatchImageSubmitRequest,
  idempotencyKey: string,
): Promise<BatchImageJob> {
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.post<BatchImageJob>(
      '/user/image-batches',
      { ...payload, api_key_id: credential.id },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    )
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const response = await fetch(buildGatewayUrl('/v1/images/batches'), {
    method: 'POST',
    headers: authHeaders(apiKey, {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    }),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.json()
}

export async function getBatchImageJob(credential: BatchImageCredential, batchId: string): Promise<BatchImageJob> {
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.get<BatchImageJob>(`/user/image-batches/${encodeURIComponent(batchId)}`)
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const response = await fetch(buildGatewayUrl(`/v1/images/batches/${encodeURIComponent(batchId)}`), {
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.json()
}

export async function listBatchImageJobs(credential: BatchImageCredential, options: number | BatchImageJobsListOptions = 20): Promise<BatchImageJobsResponse> {
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.get<BatchImageJobsResponse>('/user/image-batches', {
      params: jobsListParams(credential, options, true),
    })
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(jobsListParams(credential, options, false))) {
    params.set(name, String(value))
  }
  const response = await fetch(buildGatewayUrl(`/v1/images/batches?${params.toString()}`), {
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.json()
}

export async function listBatchImageModels(credential: BatchImageCredential): Promise<BatchImageModelsResponse> {
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.get<BatchImageModelsResponse>('/user/image-batches/models', {
      params: { api_key_id: credential.id },
    })
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const response = await fetch(buildGatewayUrl('/v1/images/batches/models'), {
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.json()
}

export async function listBatchImageItems(
  credential: BatchImageCredential,
  batchId: string,
  options: string | BatchImageItemsListOptions = '',
): Promise<BatchImageItemsResponse> {
  const itemParams = itemsListParams(options)
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.get<BatchImageItemsResponse>(
      `/user/image-batches/${encodeURIComponent(batchId)}/items`,
      { params: itemParams },
    )
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(itemParams)) {
    params.set(name, String(value))
  }
  const serialized = params.toString()
  const query = serialized ? `?${serialized}` : ''
  const response = await fetch(buildGatewayUrl(`/v1/images/batches/${encodeURIComponent(batchId)}/items${query}`), {
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.json()
}

export async function cancelBatchImageJob(credential: BatchImageCredential, batchId: string): Promise<BatchImageJob> {
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.post<BatchImageJob>(`/user/image-batches/${encodeURIComponent(batchId)}/cancel`)
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const response = await fetch(buildGatewayUrl(`/v1/images/batches/${encodeURIComponent(batchId)}/cancel`), {
    method: 'POST',
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.json()
}

export async function downloadBatchImageZip(credential: BatchImageCredential, batchId: string): Promise<Blob> {
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.get<Blob>(`/user/image-batches/${encodeURIComponent(batchId)}/download`, {
      responseType: 'blob',
    })
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const response = await fetch(buildGatewayUrl(`/v1/images/batches/${encodeURIComponent(batchId)}/download`), {
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.blob()
}

export async function getBatchImageItemContent(credential: BatchImageCredential, batchId: string, customId: string, imageIndex = 0): Promise<Blob> {
  if (isCloudflareWorkerContractActive()) {
    const response = await apiClient.get<Blob>(
      `/user/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(customId)}/content`,
      { params: { image_index: imageIndex }, responseType: 'blob' },
    )
    return response.data
  }
  const apiKey = requireLegacyApiKey(credential)
  const response = await fetch(buildGatewayUrl(`/v1/images/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(customId)}/content?image_index=${encodeURIComponent(String(imageIndex))}`), {
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
  return response.blob()
}

export async function deleteBatchImageJobRecord(credential: BatchImageCredential, batchId: string): Promise<void> {
  if (isCloudflareWorkerContractActive()) {
    await apiClient.delete(`/user/image-batches/${encodeURIComponent(batchId)}`)
    return
  }
  const apiKey = requireLegacyApiKey(credential)
  const response = await fetch(buildGatewayUrl(`/v1/images/batches/${encodeURIComponent(batchId)}`), {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  })
  if (!response.ok) throw await parseBatchImageError(response)
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
