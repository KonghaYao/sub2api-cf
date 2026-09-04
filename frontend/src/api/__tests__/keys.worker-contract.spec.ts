import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put, deleteRequest } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  deleteRequest: vi.fn()
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, put, delete: deleteRequest }
}))

import { create, deleteKey, getById, update } from '@/api/keys'

describe('user API keys Cloudflare Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    put.mockReset()
    deleteRequest.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('keeps UUID resource identifiers as strings', async () => {
    const key = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'primary',
      status: 'active',
      key_prefix: 'sk-sub2api-abcd'
    }
    get.mockResolvedValueOnce({ data: key })

    await expect(getById(key.id)).resolves.toEqual(key)
    expect(get).toHaveBeenCalledWith(`/keys/${key.id}`)
  })

  it('creates with an idempotency key and only Worker-supported fields', async () => {
    const created = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'primary',
      status: 'active',
      key_prefix: 'sk-sub2api-abcd',
      key: 'sk-sub2api-secret'
    }
    post.mockResolvedValueOnce({ data: created })

    await expect(create('primary', created.group_id, undefined, undefined, undefined, undefined, 30))
      .resolves.toEqual(created)

    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe('/keys')
    expect(post.mock.calls[0][1]).toEqual({
      name: 'primary',
      group_id: created.group_id,
      expires_at_ms: expect.any(Number)
    })
    expect(post.mock.calls[0][2]).toEqual({
      headers: {
        'Idempotency-Key': 'user-api-key-create-11111111-1111-4111-8111-111111111111'
      }
    })
  })

  it('rejects unsupported create fields instead of pretending they were saved', async () => {
    await expect(
      create('primary', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'custom-secret')
    ).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    expect(post).not.toHaveBeenCalled()
  })

  it('whitelists supported update fields and converts the expiry to milliseconds', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const expiresAt = '2027-01-01T00:00:00.000Z'
    put.mockResolvedValueOnce({ data: { id, status: 'inactive' } })

    await update(id, {
      name: 'renamed',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'inactive',
      expires_at: expiresAt
    })

    expect(put).toHaveBeenCalledWith(`/keys/${id}`, {
      name: 'renamed',
      group_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'inactive',
      expires_at_ms: Date.parse(expiresAt)
    })
  })

  it('rejects unsupported update operations before making a request', async () => {
    await expect(
      update('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { reset_quota: true })
    ).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    expect(put).not.toHaveBeenCalled()
  })

  it('returns the revoked key projection from delete', async () => {
    const revoked = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'inactive',
      revoked_at: '2026-09-04T00:00:00.000Z'
    }
    deleteRequest.mockResolvedValueOnce({ data: revoked })

    await expect(deleteKey(revoked.id)).resolves.toEqual(revoked)
  })
})
