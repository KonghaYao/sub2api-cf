import { apiClient } from '../client'

export interface WorkerAdminModel {
  id: string
  platform: 'openai' | 'anthropic' | 'gemini' | 'codex'
  public_name: string
  upstream_name: string
  endpoint: 'chat_completions' | 'responses' | 'both'
  embeddings: boolean
  image_generation: boolean
  enabled: boolean
  control_version: number
}

export async function list(page = 1, pageSize = 100): Promise<{
  items: WorkerAdminModel[]
  total: number
  page: number
  page_size: number
  pages: number
}> {
  const { data } = await apiClient.get('/admin/models', {
    params: { page, page_size: pageSize },
  })
  return data
}

export default { list }
