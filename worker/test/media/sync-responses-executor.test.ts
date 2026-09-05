import { describe, expect, it, vi } from 'vitest'

import type { ProviderAccount } from '../../src/gateway/providers'
import type { SyncImageManifest } from '../../src/media/sync-domain'
import { executeSyncImageResponses } from '../../src/media/sync-responses-executor'

const generation: SyncImageManifest = {
  operation: 'generations',
  model: 'public-image-model',
  prompt: '画一个蓝色马克杯，只写“SkelOT”。',
  n: 2,
  options: { size: '1024x1024', quality: 'high' },
  input_images: [],
  mask: null,
}

function codexAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    platform: 'codex',
    protocol: 'codex',
    auth_scheme: 'bearer',
    base_url: 'https://chatgpt.example.test',
    provider_config: { account_id: 'workspace-123' },
    ...overrides,
  }
}

describe('synchronous image Responses executor', () => {
  it('executes an OAuth generation through the forced Codex Responses SSE contract', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('accepted', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))

    const result = await executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'oauth-access-token' },
      credential_kind: 'oauth',
      fetcher,
    })

    expect(result).toMatchObject({
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      credential_kind: 'oauth',
      response: expect.any(Response),
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://chatgpt.example.test/backend-api/codex/responses')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    const headers = new Headers(init?.headers)
    expect(Object.fromEntries(headers)).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer oauth-access-token',
      'chatgpt-account-id': 'workspace-123',
      'content-type': 'application/json',
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: true,
      store: false,
      tool_choice: { type: 'image_generation' },
      tools: [{
        type: 'image_generation',
        action: 'generate',
        model: 'gpt-image-2',
        n: 2,
        size: '1024x1024',
        quality: 'high',
      }],
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: generation.prompt }],
      }],
    })
  })

  it('uses the same Responses execution for setup-token edits and forwards only safe client context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('accepted'))
    const edit: SyncImageManifest = {
      operation: 'edits',
      model: 'public-edit-model',
      prompt: 'replace the background',
      n: 1,
      options: { output_format: 'webp', input_fidelity: 'high' },
      input_images: [{
        kind: 'bytes',
        filename: 'source.png',
        mime_type: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      }],
      mask: {
        kind: 'bytes',
        filename: 'mask.png',
        mime_type: 'image/png',
        bytes: new Uint8Array([4, 5, 6]),
      },
    }

    const result = await executeSyncImageResponses({
      manifest: edit,
      public_model: 'public-edit-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'setup-access-token' },
      credential_kind: 'setup-token',
      client_headers: {
        authorization: 'Bearer caller-secret',
        cookie: 'session=caller-secret',
        host: 'attacker.invalid',
        'accept-language': 'zh-CN',
        'user-agent': 'sub2api-test/1.0',
        session_id: 'session-safe',
        conversation_id: 'conversation-safe',
        'openai-beta': 'attacker-beta',
        originator: 'attacker-originator',
      },
      fetcher,
    })

    expect(result.credential_kind).toBe('setup-token')
    const [, init] = fetcher.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer setup-access-token')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('host')).toBeNull()
    expect(headers.get('accept-language')).toBe('zh-CN')
    expect(headers.get('user-agent')).toBe('sub2api-test/1.0')
    expect(headers.get('session_id')).toBe('session-safe')
    expect(headers.get('conversation_id')).toBe('conversation-safe')
    expect(headers.get('openai-beta')).toBe('responses=experimental')
    expect(headers.get('originator')).toBe('codex_cli_rs')
    const body = JSON.parse(String(init?.body))
    expect(body.tools).toEqual([{
      type: 'image_generation',
      action: 'edit',
      model: 'gpt-image-2',
      output_format: 'webp',
      input_image_mask: { image_url: 'data:image/png;base64,BAUG' },
    }])
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'replace the background' },
      { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
    ])
  })

  it('bounds the detached upstream header wait and returns a sanitized timeout error', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('oauth-access-token leaked')), { once: true })
      })
    })

    await expect(executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'oauth-access-token' },
      fetcher,
      timeout_ms: 5,
    })).rejects.toMatchObject({
      status: 504,
      code: 'IMAGE_RESPONSES_UPSTREAM_TIMEOUT',
      message: 'Image Responses provider did not return response headers in time',
    })
  })

  it('never follows an upstream redirect that could replay the bearer token', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('redirected'))
      },
      cancel() {},
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 307,
      headers: { location: 'https://attacker.invalid/steal' },
    }))

    await expect(executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'oauth-access-token' },
      fetcher,
    })).rejects.toMatchObject({
      status: 502,
      code: 'IMAGE_RESPONSES_REDIRECT_REJECTED',
      message: 'Image Responses provider redirect was rejected',
    })
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual')
  })

  it('rejects a Codex account explicitly marked as API-key before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>()

    await expect(executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'provider-api-key' },
      credential_kind: 'api_key',
      fetcher,
    })).rejects.toMatchObject({
      status: 409,
      code: 'IMAGE_RESPONSES_CREDENTIAL_KIND_MISMATCH',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects invalid timeout policy before starting paid upstream work', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('must not run'))

    await expect(executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'oauth-access-token' },
      fetcher,
      timeout_ms: 0,
    })).rejects.toMatchObject({
      status: 500,
      code: 'IMAGE_RESPONSES_TIMEOUT_INVALID',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('infers API-key for OpenAI accounts and keeps them on the native Images executor', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const account: ProviderAccount = {
      platform: 'openai',
      protocol: 'openai',
      auth_scheme: 'bearer',
      base_url: 'https://api.openai.example.test/v1',
      provider_config: {},
    }

    await expect(executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account,
      credential: { api_key: 'provider-api-key' },
      fetcher,
    })).rejects.toMatchObject({
      status: 409,
      code: 'IMAGE_RESPONSES_ACCOUNT_REQUIRED',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects unsafe base URLs at the public executor boundary', async () => {
    const fetcher = vi.fn<typeof fetch>()

    await expect(executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount({ base_url: 'http://127.0.0.1:8787' }),
      credential: { api_key: 'oauth-access-token' },
      fetcher,
    })).rejects.toMatchObject({ code: 'invalid_base_url' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sanitizes transport failures without exposing the upstream token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new Error('connect failed for Bearer oauth-access-token'),
    )

    const error = await executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'oauth-access-token' },
      fetcher,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      status: 502,
      code: 'IMAGE_RESPONSES_CONNECTION_ERROR',
      message: 'Image Responses provider connection failed',
    })
    expect(String(error)).not.toContain('oauth-access-token')
  })

  it('combines lease cancellation with the independent header timeout', async () => {
    const lease = new AbortController()
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      init?.signal?.addEventListener('abort', () => reject(new Error('lease stopped')), { once: true })
      lease.abort('renewal failed')
    }))

    await expect(executeSyncImageResponses({
      manifest: generation,
      public_model: 'public-image-model',
      upstream_model: 'gpt-image-2',
      responses_model: 'gpt-5.4-mini',
      account: codexAccount(),
      credential: { api_key: 'oauth-access-token' },
      fetcher,
      signal: lease.signal,
      timeout_ms: 10_000,
    })).rejects.toMatchObject({
      status: 503,
      code: 'IMAGE_LEASE_RENEWAL_FAILED',
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
