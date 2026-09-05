import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: clientMocks,
  buildGatewayUrl: (path: string) => `https://gateway.example${path}`,
}))

import {
  cancelBatchImageJob,
  deleteBatchImageJobRecord,
  downloadBatchImageZip,
  getBatchImageItemContent,
  getBatchImageJob,
  listBatchImageItems,
  listBatchImageJobs,
  listBatchImageModels,
  submitBatchImageJob,
  type BatchImageCredential,
  type BatchImageJob,
  type BatchImageSubmitRequest,
} from '@/api/batchImage'
import { setCloudflareWorkerContractActive } from '@/utils/adminCapabilities'

const credential: BatchImageCredential = { id: 'key/id' }
const job: BatchImageJob = {
  id: 'imgbatch/job 1',
  object: 'image.batch',
  task_name: 'hero batch',
  status: 'queued',
  model: 'gemini-2.5-flash-image',
  provider: 'gemini_api',
  item_count: 1,
  success_count: 0,
  fail_count: 0,
  estimated_cost: 0.25,
  hold_amount: 0.15,
  actual_cost: null,
  created_at: 1_783_123_200,
  submitted_at: 1_783_123_201,
  settled_at: null,
}
const payload: BatchImageSubmitRequest = {
  model: 'gemini-2.5-flash-image',
  task_name: 'hero batch',
  items: [{ custom_id: 'cover/1', prompt: 'Draw a cover', output_count: 2 }],
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  })
}

describe('Cloudflare Worker batch image API contract', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    setCloudflareWorkerContractActive(true)
    fetchMock.mockReset()
    clientMocks.get.mockReset()
    clientMocks.post.mockReset()
    clientMocks.delete.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    setCloudflareWorkerContractActive(true)
    vi.unstubAllGlobals()
  })

  it('submits through the session-auth alias with only the API key id and idempotency key', async () => {
    clientMocks.post.mockResolvedValueOnce({ data: job })

    await expect(submitBatchImageJob(credential, payload, 'batch-submit-01')).resolves.toEqual(job)

    expect(clientMocks.post).toHaveBeenCalledWith(
      '/user/image-batches',
      { ...payload, api_key_id: 'key/id' },
      { headers: { 'Idempotency-Key': 'batch-submit-01' } },
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the key id only for collection and model queries', async () => {
    clientMocks.get
      .mockResolvedValueOnce({ data: { object: 'list', data: [job], has_more: true } })
      .mockResolvedValueOnce({ data: { object: 'list', data: [] } })

    await listBatchImageJobs(credential, {
      limit: 25,
      cursor: 'page/2',
      status: 'completed',
      taskName: 'hero & cover',
      downloaded: 'false',
      from: '2026-09-01',
      to: '2026-09-05',
    })
    await listBatchImageModels(credential)

    expect(clientMocks.get).toHaveBeenNthCalledWith(1, '/user/image-batches', {
      params: {
        api_key_id: 'key/id',
        limit: 25,
        cursor: 'page/2',
        status: 'completed',
        task_name: 'hero & cover',
        downloaded: 'false',
        from: '2026-09-01',
        to: '2026-09-05',
      },
    })
    expect(clientMocks.get).toHaveBeenNthCalledWith(2, '/user/image-batches/models', {
      params: { api_key_id: 'key/id' },
    })
  })

  it('uses encoded task routes and supports item pagination without repeating the key id', async () => {
    const items = { object: 'list', data: [], has_more: false }
    clientMocks.get
      .mockResolvedValueOnce({ data: job })
      .mockResolvedValueOnce({ data: items })
      .mockResolvedValueOnce({ data: items })

    await getBatchImageJob(credential, 'imgbatch/job 1')
    await listBatchImageItems(credential, 'batch/id', {
      status: 'succeeded',
      limit: 50,
      cursor: 'item/50',
    })
    await listBatchImageItems(credential, 'batch/id', 'failed')

    expect(clientMocks.get).toHaveBeenNthCalledWith(1, '/user/image-batches/imgbatch%2Fjob%201')
    expect(clientMocks.get).toHaveBeenNthCalledWith(2, '/user/image-batches/batch%2Fid/items', {
      params: { status: 'succeeded', limit: 50, cursor: 'item/50' },
    })
    expect(clientMocks.get).toHaveBeenNthCalledWith(3, '/user/image-batches/batch%2Fid/items', {
      params: { status: 'failed' },
    })
  })

  it('requests content and ZIPs as blobs through the session-auth client', async () => {
    const image = new Blob(['image'], { type: 'image/png' })
    const archive = new Blob(['zip'], { type: 'application/zip' })
    clientMocks.get
      .mockResolvedValueOnce({ data: image })
      .mockResolvedValueOnce({ data: archive })

    await expect(getBatchImageItemContent(credential, 'batch/id', 'cover 1', 2)).resolves.toBe(image)
    await expect(downloadBatchImageZip(credential, 'batch/id')).resolves.toBe(archive)

    expect(clientMocks.get).toHaveBeenNthCalledWith(
      1,
      '/user/image-batches/batch%2Fid/items/cover%201/content',
      { params: { image_index: 2 }, responseType: 'blob' },
    )
    expect(clientMocks.get).toHaveBeenNthCalledWith(
      2,
      '/user/image-batches/batch%2Fid/download',
      { responseType: 'blob' },
    )
  })

  it('cancels and deletes task-scoped records through session-auth aliases', async () => {
    clientMocks.post.mockResolvedValueOnce({ data: { ...job, status: 'cancelled' } })
    clientMocks.delete.mockResolvedValueOnce({ data: undefined })

    await expect(cancelBatchImageJob(credential, 'batch/id')).resolves.toMatchObject({ status: 'cancelled' })
    await expect(deleteBatchImageJobRecord(credential, 'batch/id')).resolves.toBeUndefined()

    expect(clientMocks.post).toHaveBeenCalledWith('/user/image-batches/batch%2Fid/cancel')
    expect(clientMocks.delete).toHaveBeenCalledWith('/user/image-batches/batch%2Fid')
  })

  it('does not serialize an optional plaintext key into Worker requests', async () => {
    clientMocks.get.mockResolvedValueOnce({ data: job })
    await getBatchImageJob({ id: 7, key: 'must-not-leak' }, job.id)

    expect(JSON.stringify(clientMocks.get.mock.calls)).not.toContain('must-not-leak')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the default Worker item request unbounded so all 200 task items survive the API adapter', async () => {
    const allItems = Array.from({ length: 200 }, (_, index) => ({
      custom_id: `item-${index + 1}`,
      status: 'succeeded',
      prompt_preview: `Prompt ${index + 1}`,
      mime_type: 'image/png',
      file_extension: 'png',
      image_count: 1,
    }))
    clientMocks.get.mockResolvedValueOnce({
      data: { object: 'list', data: allItems, has_more: false },
    })

    const result = await listBatchImageItems({ id: 7, key: 'must-not-leak' }, 'batch-200')

    expect(result.data).toHaveLength(200)
    expect(result.data.at(-1)?.custom_id).toBe('item-200')
    expect(clientMocks.get).toHaveBeenCalledWith('/user/image-batches/batch-200/items', { params: {} })
    expect(JSON.stringify(clientMocks.get.mock.calls)).not.toContain('must-not-leak')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('legacy batch image gateway contract', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const legacyCredential: BatchImageCredential = { id: 7, key: 'sk-gateway' }

  beforeEach(() => {
    setCloudflareWorkerContractActive(false)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    setCloudflareWorkerContractActive(true)
    vi.unstubAllGlobals()
  })

  it('preserves direct gateway URLs, Bearer auth, filters, and idempotency', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(job))
      .mockResolvedValueOnce(jsonResponse({ object: 'list', data: [], has_more: false }))

    await submitBatchImageJob(legacyCredential, payload, 'legacy-submit-01')
    await listBatchImageJobs(legacyCredential, { limit: 25, cursor: 'page/2' })

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://gateway.example/v1/images/batches', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-gateway',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'legacy-submit-01',
      },
      body: JSON.stringify(payload),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gateway.example/v1/images/batches?limit=25&cursor=page%2F2',
      { headers: { Authorization: 'Bearer sk-gateway' } },
    )
  })

  it('rejects legacy calls when the one-time plaintext key is unavailable', async () => {
    await expect(listBatchImageModels({ id: 7 })).rejects.toMatchObject({
      code: 'BATCH_IMAGE_API_KEY_PLAINTEXT_REQUIRED',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves gateway error code, status, and request id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: { code: 'BATCH_IMAGE_NOT_FOUND', message: 'batch image job not found' },
    }, {
      status: 404,
      headers: { 'X-Request-Id': 'gateway-request-1' },
    }))

    await expect(getBatchImageJob(legacyCredential, 'missing')).rejects.toMatchObject({
      message: 'batch image job not found',
      code: 'BATCH_IMAGE_NOT_FOUND',
      status: 404,
      requestId: 'gateway-request-1',
    })
  })
})
