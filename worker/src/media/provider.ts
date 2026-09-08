import { accountModelRateLimited } from '../gateway/account-model-rate-limit'
import { accountQuotaExceeded } from '../gateway/account-quota-policy'
import { accountNotRateLimitedSql, accountNotTemporarilyBlockedSql } from '../gateway/account-rate-limit'
import { accountNotExpiredSql } from '../gateway/account-expiry'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { accountModelPolicy, accountModelAllowedSql } from '../gateway/account-model-policy'
import { decryptCredential } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'
import { buildProviderRequest, type ProviderConfig } from '../gateway/providers'
import { credentialAad } from '../gateway/repository'
import type {
  MediaEnv,
  MediaManifest,
  MediaProvider,
  MediaProviderJobAccount,
  MediaProviderJobAccountResolver,
  MediaProviderItemResult,
  MediaProviderOutput,
  MediaSubmitItem,
} from './types'

const MAX_PROVIDER_RESPONSE_BYTES = 48 * 1024 * 1024
const PROVIDER_ERROR_MESSAGE_LIMIT = 240

interface GeminiMediaAccountRow {
  credential_kind?: string
  account_id: string
  base_url: string
  protocol: string
  auth_scheme: string
  provider_config_json: string
  ui_config_json?: string
  secret_id: string
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
}

interface GeminiMediaAccount extends MediaProviderJobAccount {
  id: string
  baseUrl: string
  providerConfig: ProviderConfig
  apiKey: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Worker-native Gemini image execution. The optional fetcher exists only for
 * deterministic tests; production obtains accounts and credentials from D1.
 */
export function createGeminiMediaProvider(fetcher: Fetcher = fetch): MediaProvider {
  return {
    async generate(input) {
      const account = await resolveGeminiMediaAccount(
        input.env,
        input.task.group_id,
        input.task.model,
        input.task.upstream_model,
      )
      const items: MediaProviderItemResult[] = []
      for (const item of input.manifest.items) {
        items.push(await generateItem(mediaAccountFetcher(input.env, account, fetcher), account, input.manifest, item))
      }
      return { accountId: account.id, items }
    },
  }
}

/** Default production provider; no optional Worker binding is required. */
export const geminiMediaProvider: MediaProvider = createGeminiMediaProvider()

export async function resolveGeminiMediaAccount(
  env: MediaEnv,
  groupId: string,
  publicModel: string,
  upstreamModel: string,
): Promise<GeminiMediaAccount> {
  for (let offset = 0; ; offset += 100) {
    const rows = await env.DB.prepare(
      `SELECT a.id AS account_id, a.base_url, a.protocol, a.auth_scheme, a.credential_kind,
              a.provider_config_json, a.ui_config_json, secret.id AS secret_id, secret.key_version,
              secret.nonce_b64, secret.ciphertext_b64
         FROM account_groups AS account_group
         JOIN accounts AS a ON a.id = account_group.account_id
         JOIN models AS model ON model.platform = a.platform
         LEFT JOIN account_models AS account_model ON account_model.account_id = a.id AND account_model.model_id = model.id
         JOIN group_models AS group_model
           ON group_model.group_id = account_group.group_id
          AND group_model.model_id = model.id
         JOIN "groups" AS group_row ON group_row.id = account_group.group_id
         JOIN account_secrets AS secret
           ON secret.id = a.credential_ref AND secret.account_id = a.id
        WHERE account_group.group_id = ?
          AND model.public_name = ?
          AND (account_model.model_id IS NOT NULL OR json_extract(a.ui_config_json, '$.original_model_routing') = 1)
          AND ${accountModelAllowedSql('COALESCE(group_model.upstream_name_override, model.upstream_name)')}
          AND COALESCE(group_model.upstream_name_override, model.upstream_name) = ?
          AND group_row.enabled = 1 AND group_row.platform = 'gemini'
          AND group_row.allow_image_generation = 1
          AND group_row.allow_batch_image_generation = 1
          AND group_model.enabled = 1 AND model.enabled = 1
          AND model.platform = 'gemini'
          AND a.platform = 'gemini' AND a.protocol = 'gemini'
          AND a.auth_scheme = 'x-goog-api-key'
          AND a.base_url IS NOT NULL AND trim(a.base_url) <> ''
          AND a.enabled = 1 AND COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1) = 1 AND ${accountNotExpiredSql()} AND ${accountNotRateLimitedSql()} AND ${accountNotTemporarilyBlockedSql()} AND a.max_concurrency > 0
          AND a.health_status <> 'unhealthy'
        ORDER BY account_group.priority ASC, account_group.weight DESC, a.id ASC
        LIMIT 100 OFFSET ?`,
    ).bind(groupId, publicModel, upstreamModel, offset).all<GeminiMediaAccountRow>()
    for (const row of rows.results) {
      if (accountQuotaExceeded(row.ui_config_json, row.credential_kind ?? 'api_key')) continue
      const policy = accountModelPolicy(row.ui_config_json, upstreamModel, 'gemini')
      if (!policy.allowed || accountModelRateLimited(row.ui_config_json, upstreamModel, 'gemini', row.credential_kind ?? 'api_key')) continue
      return materializeGeminiMediaAccount(env, row, policy.upstream || upstreamModel)
    }
    if (rows.results.length < 100) break
  }
  throw new GatewayError(503, 'BATCH_IMAGE_NO_UPSTREAM_ACCOUNT', 'No schedulable Gemini image account is configured', 'server_error')
}

export async function resolveExactGeminiMediaAccount(
  env: MediaEnv,
  accountId: string,
): Promise<GeminiMediaAccount> {
  const row = await env.DB.prepare(
    `SELECT a.id AS account_id, a.base_url, a.protocol, a.auth_scheme,
            a.provider_config_json, a.ui_config_json, secret.id AS secret_id, secret.key_version,
            secret.nonce_b64, secret.ciphertext_b64
       FROM accounts AS a
       JOIN account_secrets AS secret
         ON secret.id = a.credential_ref AND secret.account_id = a.id
      WHERE a.id = ? AND a.platform = 'gemini' AND a.protocol = 'gemini'
        AND a.auth_scheme = 'x-goog-api-key'
        AND a.base_url IS NOT NULL AND trim(a.base_url) <> ''
      LIMIT 1`,
  ).bind(accountId).first<GeminiMediaAccountRow>()
  if (row === null) {
    throw new GatewayError(
      503,
      'BATCH_IMAGE_UPSTREAM_ACCOUNT_LOST',
      'The Gemini account assigned to this batch is unavailable',
      'server_error',
    )
  }
  return materializeGeminiMediaAccount(env, row)
}

export const geminiMediaProviderJobAccounts: MediaProviderJobAccountResolver = {
  async select(env, task) {
    return resolveGeminiMediaAccount(env, task.group_id, task.model, task.upstream_model)
  },
  exact: resolveExactGeminiMediaAccount,
}

async function materializeGeminiMediaAccount(
  env: MediaEnv,
  row: GeminiMediaAccountRow,
  upstreamModel = 'gemini-provider-job',
): Promise<GeminiMediaAccount> {
  const masterKey = env.CREDENTIALS_MASTER_KEY
  if (typeof masterKey !== 'string' || masterKey.length < 32) {
    throw new GatewayError(
      503,
      'credential_secret_not_configured',
      'Credential encryption secret is not configured',
      'server_error',
    )
  }
  const providerConfig = parseProviderConfig(row.provider_config_json)
  const credential = await decryptCredential(
    row.nonce_b64,
    row.ciphertext_b64,
    masterKey,
    credentialAad(env.ENVIRONMENT, row.account_id, row.secret_id, row.key_version),
  )
  // Build a request before returning so an invalid/non-HTTPS base URL or
  // provider contract fails before any item attempts reach the network.
  buildProviderRequest({
    account: {
      platform: 'gemini',
      protocol: row.protocol as 'gemini',
      auth_scheme: row.auth_scheme as 'x-goog-api-key',
      base_url: row.base_url,
      provider_config: providerConfig,
    },
    credential,
    operation: 'generate_content',
    model: upstreamModel,
    body: {},
  })
  const proxyId = row.ui_config_json ? (JSON.parse(row.ui_config_json) as { proxy_id?: unknown }).proxy_id : undefined
  return {
    id: row.account_id,
    ...(proxyId == null || String(proxyId) === '0' ? {} : { proxyId: String(proxyId) }),
    baseUrl: row.base_url,
    providerConfig,
    apiKey: credential.api_key,
    upstreamModel,
  }
}

export function mediaAccountFetcher(env: MediaEnv, account: MediaProviderJobAccount, fallback: Fetcher = fetch): Fetcher {
  if (!account.proxyId) return fallback
  return (input, init) => {
    const request = input instanceof Request ? input : undefined
    const options = request ? { method: request.method, headers: request.headers, body: request.body, signal: request.signal, ...init } : init ?? {}
    return fetchAccountProxy(env, account.proxyId!, new URL(request?.url ?? String(input)), options,
      options.signal ?? new AbortController().signal)
  }
}

async function generateItem(
  fetcher: Fetcher,
  account: GeminiMediaAccount,
  manifest: MediaManifest,
  item: MediaSubmitItem,
): Promise<MediaProviderItemResult> {
  const validationError = validateItem(account.upstreamModel ?? manifest.upstream_model, item)
  if (validationError !== null) return { customId: item.custom_id, error: validationError }
  const outputs: MediaProviderOutput[] = []
  for (let imageIndex = 0; imageIndex < item.output_count; imageIndex += 1) {
    try {
      const plan = buildProviderRequest({
        account: {
          platform: 'gemini',
          protocol: 'gemini',
          auth_scheme: 'x-goog-api-key',
          base_url: account.baseUrl,
          provider_config: account.providerConfig,
        },
        credential: { api_key: account.apiKey },
        operation: 'generate_content',
        model: account.upstreamModel ?? manifest.upstream_model,
        body: geminiImageRequest(manifest, item),
      })
      const response = await fetchWithTimeout(fetcher, plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: JSON.stringify(plan.body),
      }, plan.timeout_ms)
      if (!response.ok) {
        await discardBounded(response)
        return itemError(
          item.custom_id,
          `GEMINI_UPSTREAM_${response.status}`,
          `Gemini image generation failed with status ${response.status}`,
        )
      }
      const payload = await readJsonResponse(response)
      const image = parseFirstGeminiImage(payload)
      if (image === null) {
        return itemError(
          item.custom_id,
          'GEMINI_IMAGE_MISSING',
          'Gemini image generation returned no inline image',
        )
      }
      outputs.push(image)
    } catch (error) {
      if (error instanceof GatewayError) throw error
      return itemError(item.custom_id, 'GEMINI_UPSTREAM_UNAVAILABLE', providerFailureMessage(error))
    }
  }
  return { customId: item.custom_id, outputs }
}

function geminiImageRequest(manifest: MediaManifest, item: MediaSubmitItem): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: item.prompt }]
  for (const reference of item.reference_images) {
    parts.push({
      inlineData: {
        mimeType: reference.mime_type,
        data: reference.data,
      },
    })
  }
  const imageConfig: Record<string, string> = { imageSize: manifest.image_size }
  if (manifest.aspect_ratio !== null) imageConfig.aspectRatio = manifest.aspect_ratio
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig,
    },
  }
}

function validateItem(
  upstreamModel: string,
  item: MediaSubmitItem,
): { code: string; message: string } | null {
  const maxReferences = /(?:^|[-_.])pro(?:[-_.]|$)/i.test(upstreamModel) ? 14 : 3
  if (item.reference_images.length > maxReferences) {
    return {
      code: 'GEMINI_REFERENCE_LIMIT_EXCEEDED',
      message: `Gemini model accepts at most ${maxReferences} reference images`,
    }
  }
  for (const reference of item.reference_images) {
    if (reference.file_uri !== undefined || typeof reference.data !== 'string') {
      return {
        code: 'GEMINI_INLINE_REFERENCE_REQUIRED',
        message: 'Gemini Worker image generation supports inline reference data only',
      }
    }
  }
  return null
}

async function fetchWithTimeout(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('Gemini response exceeded the Worker media limit')
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('Gemini response exceeded the Worker media limit')
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('Gemini response was not valid JSON')
  }
}

async function discardBounded(response: Response): Promise<void> {
  const length = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel()
    return
  }
  try {
    await response.arrayBuffer()
  } catch {
    // Error bodies are deliberately ignored and never reflected to the client.
  }
}

function parseFirstGeminiImage(payload: unknown): MediaProviderOutput | null {
  const root = record(payload)
  const candidates = Array.isArray(root?.candidates) ? root.candidates : []
  for (const candidateValue of candidates) {
    const candidate = record(candidateValue)
    const content = record(candidate?.content)
    const parts = Array.isArray(content?.parts) ? content.parts : []
    for (const partValue of parts) {
      const part = record(partValue)
      const inline = record(part?.inlineData) ?? record(part?.inline_data)
      if (inline === null) continue
      const mimeValue = inline.mimeType ?? inline.mime_type
      const mimeType = normalizeMimeType(mimeValue)
      if (mimeType === null || typeof inline.data !== 'string' || inline.data === '') continue
      const bytes = decodeBase64(inline.data)
      if (bytes !== null) return { mimeType, bytes }
    }
  }
  return null
}

function decodeBase64(value: string): ArrayBuffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes.buffer
  } catch {
    return null
  }
}

function normalizeMimeType(value: unknown): MediaProviderOutput['mimeType'] | null {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase()
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp') {
    return normalized
  }
  return null
}

function parseProviderConfig(value: string): ProviderConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as ProviderConfig
  } catch {
    throw new GatewayError(
      503,
      'credential_unavailable',
      'Upstream account configuration is unavailable',
      'server_error',
    )
  }
}

function itemError(customId: string, code: string, message: string): MediaProviderItemResult {
  return { customId, error: { code, message } }
}

function providerFailureMessage(error: unknown): string {
  const prefix = error instanceof DOMException && error.name === 'AbortError'
    ? 'Gemini image generation timed out'
    : 'Gemini image generation is unavailable'
  return prefix.slice(0, PROVIDER_ERROR_MESSAGE_LIMIT)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
