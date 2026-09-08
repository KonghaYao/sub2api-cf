import { apiClient } from '../client'

export type WorkerModelPlatform = 'openai' | 'anthropic' | 'gemini' | 'codex' | 'grok'
export type WorkerModelEndpoint = 'chat_completions' | 'responses' | 'both'

export interface WorkerAdminModel {
  id: string
  platform: WorkerModelPlatform
  public_name: string
  upstream_name: string
  endpoint: WorkerModelEndpoint
  embeddings: boolean
  image_generation: boolean
  enabled: boolean
  control_version: number
}

export type WorkerAdminModelInput = Pick<WorkerAdminModel,
  'platform' | 'public_name' | 'upstream_name' | 'endpoint' | 'embeddings' | 'image_generation' | 'enabled'>

function operationKey(scope: string): string {
  return `${scope}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
}

export async function list(page = 1, pageSize = 100): Promise<{
  items: WorkerAdminModel[]
  total: number
  page: number
  page_size: number
  pages: number
}> {
  const { data } = await apiClient.get('/admin/models', { params: { page, page_size: pageSize } })
  return data
}

export async function create(input: WorkerAdminModelInput): Promise<WorkerAdminModel> {
  const { data } = await apiClient.post('/admin/models', input, {
    headers: { 'Idempotency-Key': operationKey('admin-model-create') },
  })
  return data
}

export async function update(model: WorkerAdminModel, input: WorkerAdminModelInput): Promise<WorkerAdminModel> {
  const { data } = await apiClient.put(`/admin/models/${model.id}`, {
    ...input,
    expected_control_version: model.control_version,
  }, { headers: { 'Idempotency-Key': operationKey('admin-model-update') } })
  return data
}

export async function disable(model: WorkerAdminModel): Promise<WorkerAdminModel> {
  const { data } = await apiClient.delete(`/admin/models/${model.id}`, {
    data: { expected_control_version: model.control_version },
    headers: { 'Idempotency-Key': operationKey('admin-model-disable') },
  })
  return data
}

export default { list, create, update, disable }
