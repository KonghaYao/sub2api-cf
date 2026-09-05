import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptCredential } from '../../src/gateway/crypto'
import { GatewayError } from '../../src/gateway/errors'
import { createGeminiMediaProvider } from '../../src/media/provider'
import type { MediaEnv, MediaManifest, MediaTaskRow } from '../../src/media/types'

const MASTER_KEY = 'media-provider-master-key-'.repeat(2)
const ENVIRONMENT = 'test'

describe('built-in Gemini media provider', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('selects a schedulable account, decrypts its key, and generates once per requested output', async () => {
    const row = await encryptedAccount()
    const observedBindings: unknown[][] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(geminiImage('image/png', 'aGVsbG8=')))
    const env = mediaEnv(row, observedBindings)
    const manifest = mediaManifest({ outputCount: 2 })

    const result = await createGeminiMediaProvider(fetcher).generate({ env, task: mediaTask(), manifest })

    expect(result.accountId).toBe('account-gemini-1')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].error).toBeUndefined()
    expect(result.items[0].outputs).toHaveLength(2)
    expect(new TextDecoder().decode(result.items[0].outputs?.[0].bytes)).toBe('hello')
    expect(observedBindings).toEqual([['group-1', 'gemini-image', 'gemini-3.1-flash-image']])
    expect(fetcher).toHaveBeenCalledTimes(2)

    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-goog-api-key')).toBe('upstream-secret')
    expect(headers.get('authorization')).toBeNull()
    expect(String(url)).not.toContain('upstream-secret')
    expect(JSON.parse(String(init?.body))).toEqual({
      contents: [{ role: 'user', parts: [
        { text: 'draw a worker-native cat' },
        { inlineData: { mimeType: 'image/webp', data: 'd2VicA==' } },
      ] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
      },
    })
  })

  it('parses camelCase and snake_case inline image parts and reports item-scoped upstream errors', async () => {
    const row = await encryptedAccount()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/webp', data: 'b25l' } }] } }],
      }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'blocked secret detail' } }, { status: 429 }))
    const manifest = mediaManifest({
      items: [
        { custom_id: 'one', prompt: 'one', output_count: 1, reference_images: [] },
        { custom_id: 'two', prompt: 'two', output_count: 1, reference_images: [] },
      ],
    })

    const result = await createGeminiMediaProvider(fetcher).generate({
      env: mediaEnv(row),
      task: mediaTask(),
      manifest,
    })

    expect(result.items[0].outputs?.[0].mimeType).toBe('image/webp')
    expect(new TextDecoder().decode(result.items[0].outputs?.[0].bytes)).toBe('one')
    expect(result.items[1]).toEqual({
      customId: 'two',
      error: { code: 'GEMINI_UPSTREAM_429', message: 'Gemini image generation failed with status 429' },
    })
    expect(JSON.stringify(result)).not.toContain('blocked secret detail')
  })

  it('fails closed when no schedulable Gemini account exists', async () => {
    await expect(createGeminiMediaProvider(vi.fn()).generate({
      env: mediaEnv(null),
      task: mediaTask(),
      manifest: mediaManifest(),
    })).rejects.toMatchObject({
      status: 503,
      code: 'BATCH_IMAGE_NO_UPSTREAM_ACCOUNT',
    } satisfies Partial<GatewayError>)
  })

  it('rejects non-HTTPS account URLs before fetch', async () => {
    const fetcher = vi.fn()
    const row = await encryptedAccount({ base_url: 'http://generativelanguage.googleapis.com' })

    await expect(createGeminiMediaProvider(fetcher).generate({
      env: mediaEnv(row),
      task: mediaTask(),
      manifest: mediaManifest(),
    })).rejects.toMatchObject({ code: 'invalid_base_url' } satisfies Partial<GatewayError>)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fails closed when the credential cannot be decrypted', async () => {
    const row = await encryptedAccount()
    await expect(createGeminiMediaProvider(vi.fn()).generate({
      env: { ...mediaEnv(row), CREDENTIALS_MASTER_KEY: 'wrong-key'.repeat(4) },
      task: mediaTask(),
      manifest: mediaManifest(),
    })).rejects.toMatchObject({ code: 'credential_unavailable' } satisfies Partial<GatewayError>)
  })

  it('enforces Flash and Pro inline reference limits defensively', async () => {
    const row = await encryptedAccount()
    const fetcher = vi.fn(async () => Response.json(geminiImage('image/png', 'b2s=')))
    const flash = mediaManifest({ referenceCount: 4 })
    const pro = mediaManifest({ referenceCount: 14 })
    pro.upstream_model = 'gemini-3.1-pro-image'

    const flashResult = await createGeminiMediaProvider(fetcher).generate({
      env: mediaEnv(row), task: mediaTask(), manifest: flash,
    })
    const proResult = await createGeminiMediaProvider(fetcher).generate({
      env: mediaEnv(row), task: { ...mediaTask(), upstream_model: pro.upstream_model }, manifest: pro,
    })

    expect(flashResult.items[0].error?.code).toBe('GEMINI_REFERENCE_LIMIT_EXCEEDED')
    expect(proResult.items[0].outputs).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

interface AccountRow {
  account_id: string
  base_url: string
  protocol: string
  auth_scheme: string
  provider_config_json: string
  secret_id: string
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
}

async function encryptedAccount(overrides: Partial<AccountRow> = {}): Promise<AccountRow> {
  const accountId = 'account-gemini-1'
  const secretId = 'secret-gemini-1'
  const keyVersion = 1
  const encrypted = await encryptCredential(
    { api_key: 'upstream-secret' },
    MASTER_KEY,
    `${ENVIRONMENT}/${accountId}/${secretId}/${keyVersion}`,
  )
  return {
    account_id: accountId,
    base_url: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    auth_scheme: 'x-goog-api-key',
    provider_config_json: '{}',
    secret_id: secretId,
    key_version: keyVersion,
    ...encrypted,
    ...overrides,
  }
}

function mediaEnv(row: AccountRow | null, observedBindings: unknown[][] = []): MediaEnv {
  return {
    ENVIRONMENT,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    DB: {
      prepare(sql: string) {
        expect(sql).toContain("a.platform = 'gemini'")
        return {
          bind(...values: unknown[]) {
            observedBindings.push(values)
            return { first: async () => row }
          },
        }
      },
    } as unknown as D1Database,
  } as unknown as MediaEnv
}

function mediaManifest(options: {
  outputCount?: number
  referenceCount?: number
  items?: MediaManifest['items']
} = {}): MediaManifest {
  const references = Array.from({ length: options.referenceCount ?? 1 }, (_, index) => ({
    id: `ref-${index}`,
    mime_type: 'image/webp' as const,
    data: 'd2VicA==',
  }))
  return {
    model: 'gemini-image',
    upstream_model: 'gemini-3.1-flash-image',
    task_name: 'test',
    parent_batch_id: null,
    provider: 'gemini_api',
    image_size: '2K',
    response_mime_type: 'image/png',
    aspect_ratio: '1:1',
    metadata: {},
    items: options.items ?? [{
      custom_id: 'cover',
      prompt: 'draw a worker-native cat',
      output_count: options.outputCount ?? 1,
      reference_images: references,
    }],
  }
}

function mediaTask(): MediaTaskRow {
  return {
    id: 'imgbatch_1234567890123456',
    group_id: 'group-1',
    model: 'gemini-image',
    upstream_model: 'gemini-3.1-flash-image',
  } as unknown as MediaTaskRow
}

function geminiImage(mimeType: string, data: string): unknown {
  return { candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }
}
