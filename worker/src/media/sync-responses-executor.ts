import { GatewayError } from '../gateway/errors'
import {
  buildProviderRequest,
  type ProviderAccount,
  type ProviderCredential,
} from '../gateway/providers'
import type { SyncImageManifest } from './sync-domain'
import { buildSyncImageResponsesRequest } from './sync-responses-adapter'

export type SyncImageResponsesCredentialKind = 'oauth' | 'setup-token' | 'api_key'
export const SYNC_IMAGE_RESPONSES_HEADER_TIMEOUT_MS = 120_000

export interface ExecuteSyncImageResponsesInput {
  manifest: SyncImageManifest
  public_model: string
  upstream_model: string
  responses_model: string
  account: ProviderAccount
  credential: ProviderCredential
  credential_kind?: SyncImageResponsesCredentialKind
  client_headers?: HeadersInit
  fetcher?: typeof fetch
  timeout_ms?: number
  /** Account lease-renewal signal; intentionally never use the client disconnect signal here. */
  signal?: AbortSignal
}

export interface SyncImageResponsesExecution {
  response: Response
  public_model: string
  upstream_model: string
  credential_kind: 'oauth' | 'setup-token'
}

export async function executeSyncImageResponses(
  input: ExecuteSyncImageResponsesInput,
): Promise<SyncImageResponsesExecution> {
  const timeoutMs = input.timeout_ms ?? SYNC_IMAGE_RESPONSES_HEADER_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new GatewayError(
      500,
      'IMAGE_RESPONSES_TIMEOUT_INVALID',
      'Image Responses upstream timeout configuration is invalid',
      'server_error',
    )
  }
  const responsesModel = input.responses_model.trim()
  if (responsesModel === '' || responsesModel.length > 200 || /[\u0000-\u001f\u007f]/.test(responsesModel)) {
    throw new GatewayError(
      500,
      'IMAGE_RESPONSES_MODEL_INVALID',
      'Image Responses upstream model configuration is invalid',
      'server_error',
    )
  }
  const credentialKind = syncImageResponsesCredentialKind(input.account, input.credential_kind)
  if (input.account.platform === 'codex' && credentialKind === 'api_key') {
    throw new GatewayError(
      409,
      'IMAGE_RESPONSES_CREDENTIAL_KIND_MISMATCH',
      'A Codex account cannot use API-key image execution',
    )
  }
  if (credentialKind === 'api_key' || input.account.platform !== 'codex') {
    throw new GatewayError(
      409,
      'IMAGE_RESPONSES_ACCOUNT_REQUIRED',
      'The synchronous image Responses executor requires an OAuth or setup-token account',
    )
  }
  const body = buildSyncImageResponsesRequest(
    { ...input.manifest, model: input.upstream_model },
    responsesModel,
  )
  const plan = buildProviderRequest({
    account: input.account,
    credential: input.credential,
    operation: 'responses',
    body,
  })
  copySafeClientHeaders(plan.headers, input.client_headers)
  plan.headers.set('openai-beta', 'responses=experimental')
  if (input.signal?.aborted) throw leaseRenewalError()
  const controller = new AbortController()
  const abortForLease = (): void => controller.abort(input.signal?.reason ?? 'lease renewal failed')
  input.signal?.addEventListener('abort', abortForLease, { once: true })
  const timeout = setTimeout(
    () => controller.abort('image Responses upstream header timeout'),
    timeoutMs,
  )
  let response: Response
  try {
    response = await (input.fetcher ?? fetch)(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      redirect: 'manual',
      signal: controller.signal,
    })
  } catch {
    if (controller.signal.aborted) {
      if (input.signal?.aborted) throw leaseRenewalError()
      throw new GatewayError(
        504,
        'IMAGE_RESPONSES_UPSTREAM_TIMEOUT',
        'Image Responses provider did not return response headers in time',
        'server_error',
      )
    }
    throw new GatewayError(
      502,
      'IMAGE_RESPONSES_CONNECTION_ERROR',
      'Image Responses provider connection failed',
      'server_error',
    )
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abortForLease)
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new GatewayError(
      502,
      'IMAGE_RESPONSES_REDIRECT_REJECTED',
      'Image Responses provider redirect was rejected',
      'server_error',
    )
  }
  return {
    response,
    public_model: input.public_model,
    upstream_model: input.upstream_model,
    credential_kind: credentialKind,
  }
}

function leaseRenewalError(): GatewayError {
  return new GatewayError(
    503,
    'IMAGE_LEASE_RENEWAL_FAILED',
    'Image concurrency lease could not be renewed',
    'server_error',
  )
}

function copySafeClientHeaders(target: Headers, sourceInit: HeadersInit | undefined): void {
  if (sourceInit === undefined) return
  const source = new Headers(sourceInit)
  for (const name of [
    'accept-language',
    'conversation_id',
    'session_id',
    'user-agent',
    'x-codex-installation-id',
    'x-codex-turn-state',
    'x-codex-turn-metadata',
    'x-codex-window-id',
  ]) {
    const value = source.get(name)
    if (value !== null && value.length <= 8_192 && !/[\u0000-\u001f\u007f]/.test(value)) {
      target.set(name, value)
    }
  }
}

export function syncImageResponsesCredentialKind(
  account: ProviderAccount,
  explicit?: SyncImageResponsesCredentialKind,
): SyncImageResponsesCredentialKind {
  return explicit ?? (account.platform === 'codex' ? 'oauth' : 'api_key')
}
