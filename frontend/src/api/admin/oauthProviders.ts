import { apiClient } from '../client'

export const ADMIN_OAUTH_PROVIDERS = [
  'github',
  'google',
  'linuxdo',
  'dingtalk',
  'wechat',
  'oidc',
] as const

export type AdminOAuthProvider = typeof ADMIN_OAUTH_PROVIDERS[number]

export type AdminOAuthAdapter<P extends AdminOAuthProvider = AdminOAuthProvider> =
  P extends 'github' ? 'github'
    : P extends 'dingtalk' ? 'dingtalk'
      : P extends 'wechat' ? 'wechat'
        : P extends 'oidc' ? 'oidc'
          : 'standard'

export interface AdminOAuthProviderConfig<P extends AdminOAuthProvider = AdminOAuthProvider> {
  schema_version: 1
  control_version: number
  provider: P
  adapter: AdminOAuthAdapter<P>
  enabled: boolean
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  emails_endpoint: string | null
  jwks_endpoint: string | null
  client_id: string
  client_secret_configured: boolean
  scopes: string[]
  allowed_hosts: string[]
  frontend_callback_path: string
  pkce_enabled: boolean
  created_at_ms: number
  updated_at_ms: number
}

export interface AdminOAuthProviderListResponse {
  items: AdminOAuthProviderConfig[]
  total: number
}

export interface UpsertAdminOAuthProviderInput<P extends AdminOAuthProvider> {
  adapter: AdminOAuthAdapter<P>
  enabled: boolean
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  emails_endpoint: string | null
  jwks_endpoint: string | null
  client_id: string
  /** Omit to retain the stored secret; use null to clear it. */
  client_secret?: string | null
  scopes: string[]
  allowed_hosts: string[]
  frontend_callback_path: string
  pkce_enabled: boolean
}

export interface OAuthProviderMutationOptions {
  /** Required for a create before the provider has been loaded; use 0. */
  expectedControlVersion?: number
  /** Reuse this value when retrying the same logical mutation. */
  idempotencyKey?: string
}

const loadedVersions = new Map<AdminOAuthProvider, number>()

function operationKey(scope: string, provider: AdminOAuthProvider): string {
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${provider}-${requestID}`
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function responseVersion(
  provider: AdminOAuthProvider,
  config: AdminOAuthProviderConfig,
  headers?: unknown,
): number {
  if (!validVersion(config.control_version)) {
    throw Object.assign(new Error('OAuth provider response has an invalid control version'), {
      code: 'invalid_oauth_provider_control_version',
    })
  }
  const record = headers && typeof headers === 'object'
    ? headers as Record<string, unknown>
    : undefined
  const rawETag = record?.etag ?? record?.ETag
  if (typeof rawETag === 'string') {
    const match = /^(?:W\/)?"?(\d+)"?$/.exec(rawETag.trim())
    if (match !== null) {
      const etagVersion = Number(match[1])
      if (!validVersion(etagVersion) || etagVersion !== config.control_version) {
        throw Object.assign(new Error('OAuth provider ETag does not match its control version'), {
          code: 'oauth_provider_etag_mismatch',
        })
      }
    }
  }
  loadedVersions.set(provider, config.control_version)
  return config.control_version
}

function expectedVersion(
  provider: AdminOAuthProvider,
  options?: OAuthProviderMutationOptions,
): number {
  const version = options?.expectedControlVersion ?? loadedVersions.get(provider)
  if (!validVersion(version)) {
    throw Object.assign(
      new Error('Load this OAuth provider or pass expectedControlVersion before changing it'),
      { code: 'oauth_provider_version_not_loaded' },
    )
  }
  return version
}

export async function list(): Promise<AdminOAuthProviderListResponse> {
  const { data } = await apiClient.get<AdminOAuthProviderListResponse>('/admin/oauth-providers')
  data.items.forEach((item) => responseVersion(item.provider, item))
  return data
}

export async function get<P extends AdminOAuthProvider>(
  provider: P,
): Promise<AdminOAuthProviderConfig<P>> {
  const response = await apiClient.get<AdminOAuthProviderConfig<P>>(
    `/admin/oauth-providers/${provider}`,
  )
  responseVersion(provider, response.data, response.headers)
  return response.data
}

export async function upsert<P extends AdminOAuthProvider>(
  provider: P,
  input: UpsertAdminOAuthProviderInput<P>,
  options?: OAuthProviderMutationOptions,
): Promise<AdminOAuthProviderConfig<P>> {
  const version = expectedVersion(provider, options)
  const response = await apiClient.put<AdminOAuthProviderConfig<P>>(
    `/admin/oauth-providers/${provider}`,
    { ...input, expected_control_version: version },
    {
      headers: {
        'Idempotency-Key': options?.idempotencyKey ?? operationKey('admin-oauth-provider-upsert', provider),
        'If-Match': `"${version}"`,
      },
    },
  )
  responseVersion(provider, response.data, response.headers)
  return response.data
}

export async function disable<P extends AdminOAuthProvider>(
  provider: P,
  options?: OAuthProviderMutationOptions,
): Promise<AdminOAuthProviderConfig<P>> {
  const version = expectedVersion(provider, options)
  const response = await apiClient.post<AdminOAuthProviderConfig<P>>(
    `/admin/oauth-providers/${provider}/disable`,
    { expected_control_version: version },
    {
      headers: {
        'Idempotency-Key': options?.idempotencyKey ?? operationKey('admin-oauth-provider-disable', provider),
        'If-Match': `"${version}"`,
      },
    },
  )
  responseVersion(provider, response.data, response.headers)
  return response.data
}

export default { list, get, upsert, disable }
