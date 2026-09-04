import type { Context } from 'hono'

import { authenticateAdminSession } from './admin-auth'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
} from './http'
import type { Env } from '../env'
import { encryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'

type ControlBindings = { Bindings: Env }
type OAuthProviderContext = Context<ControlBindings>

const providers = ['github', 'google', 'linuxdo', 'dingtalk', 'wechat', 'oidc'] as const
const expectedAdapters = {
  github: 'github',
  google: 'standard',
  linuxdo: 'standard',
  dingtalk: 'dingtalk',
  wechat: 'wechat',
  oidc: 'oidc',
} as const
const MAX_ENDPOINT_LENGTH = 2_048
const MAX_SCOPES = 32
const MAX_SCOPE_LENGTH = 128
const MAX_SCOPES_TOTAL_LENGTH = 2_048
const MAX_ALLOWED_HOSTS = 16

export type AdminOAuthProvider = typeof providers[number]
type OAuthAdapter = typeof expectedAdapters[AdminOAuthProvider]

interface OAuthProviderRow {
  provider: AdminOAuthProvider
  schema_version: number
  adapter: OAuthAdapter
  enabled: number
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  emails_endpoint: string | null
  jwks_endpoint: string | null
  client_id: string
  secret_key_version: number | null
  secret_nonce_b64: string | null
  secret_ciphertext_b64: string | null
  scopes_json: string
  allowed_hosts_json: string
  frontend_callback_path: string
  pkce_enabled: number
  created_at_ms: number
  updated_at_ms: number
}

export interface AdminOAuthProviderResponse {
  schema_version: 1
  control_version: number
  provider: AdminOAuthProvider
  adapter: OAuthAdapter
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

interface ParsedProviderInput {
  adapter: OAuthAdapter
  enabled: boolean
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  emailsEndpoint: string | null
  jwksEndpoint: string | null
  clientId: string
  clientSecret: string | null | undefined
  scopes: string[]
  allowedHosts: string[]
  frontendCallbackPath: string
  pkceEnabled: boolean
}

export async function listAdminOAuthProviders(context: OAuthProviderContext): Promise<Response> {
  try {
    const result = await context.env.DB.prepare(
      `${providerSelect()} ORDER BY provider`,
    ).all<OAuthProviderRow>()
    const items = result.results.map(publicProvider)
    return controlSuccess({ items, total: items.length })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminOAuthProvider(context: OAuthProviderContext): Promise<Response> {
  try {
    const provider = parseProvider(context.req.param('provider'))
    const row = await requireProvider(context.env, provider)
    return providerResponse(publicProvider(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function upsertAdminOAuthProvider(context: OAuthProviderContext): Promise<Response> {
  try {
    const provider = parseProvider(context.req.param('provider'))
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const input = parseProviderInput(provider, body, context.env)
    const idempotency = await controlIdempotency(
      'admin.oauth-providers.upsert.v1',
      requireIdempotencyKey(context.req.raw),
      { provider, expected_control_version: expectedVersion, ...input },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) return providerResponse(validIdempotentProvider(previous, provider))

    const current = await findProvider(context.env, provider)
    if (current !== null) {
      if (current.updated_at_ms !== expectedVersion) throw providerVersionConflict()
      return await updateProvider(context, provider, current, input, idempotency)
    }
    if (expectedVersion !== 0) throw providerVersionConflict()
    if (input.enabled && (input.clientSecret === undefined || input.clientSecret === null)) {
      throw clientSecretRequired()
    }
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const masterKey = input.clientSecret === undefined || input.clientSecret === null
      ? null
      : requireMasterKey(context.env)
    const encrypted = input.clientSecret === undefined || input.clientSecret === null
      ? null
      : await encryptCredential(
        { api_key: input.clientSecret },
        masterKey!,
        providerSecretAad(context.env.ENVIRONMENT, provider, 1),
      )
    const now = Date.now()
    const created: AdminOAuthProviderResponse = {
      schema_version: 1,
      control_version: now,
      provider,
      adapter: input.adapter,
      enabled: input.enabled,
      issuer: input.issuer,
      authorization_endpoint: input.authorizationEndpoint,
      token_endpoint: input.tokenEndpoint,
      userinfo_endpoint: input.userinfoEndpoint,
      emails_endpoint: input.emailsEndpoint,
      jwks_endpoint: input.jwksEndpoint,
      client_id: input.clientId,
      client_secret_configured: encrypted !== null,
      scopes: input.scopes,
      allowed_hosts: input.allowedHosts,
      frontend_callback_path: input.frontendCallbackPath,
      pkce_enabled: input.pkceEnabled,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const statements = [
      context.env.DB.prepare(
        `INSERT INTO oauth_providers (
           provider, schema_version, adapter, enabled, issuer,
           authorization_endpoint, token_endpoint, userinfo_endpoint,
           emails_endpoint, jwks_endpoint, client_id,
           secret_key_version, secret_nonce_b64, secret_ciphertext_b64,
           scopes_json, allowed_hosts_json, frontend_callback_path,
           pkce_enabled, created_at_ms, updated_at_ms
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        provider,
        input.adapter,
        input.enabled ? 1 : 0,
        input.issuer,
        input.authorizationEndpoint,
        input.tokenEndpoint,
        input.userinfoEndpoint,
        input.emailsEndpoint,
        input.jwksEndpoint,
        input.clientId,
        encrypted === null ? null : 1,
        encrypted?.nonce_b64 ?? null,
        encrypted?.ciphertext_b64 ?? null,
        JSON.stringify(input.scopes),
        JSON.stringify(input.allowedHosts),
        input.frontendCallbackPath,
        input.pkceEnabled ? 1 : 0,
        now,
        now,
      ),
      providerAuditInsert(
        context.env,
        actor.user_id,
        actor.session_id,
        'admin.oauth_provider.upsert',
        provider,
        idempotency.key_hash,
        now,
      ),
      controlIdempotencyInsert(context.env, idempotency, 'oauth_provider', provider, created, now),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return providerResponse(validIdempotentProvider(recovered, provider))
      throw mapProviderWriteError(error)
    }
    return providerResponse(created, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function disableAdminOAuthProvider(context: OAuthProviderContext): Promise<Response> {
  try {
    const provider = parseProvider(context.req.param('provider'))
    const body = await readJsonObject(context.req.raw)
    rejectUnknownKeys(body, ['expected_control_version'])
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      'admin.oauth-providers.disable.v1',
      requireIdempotencyKey(context.req.raw),
      { provider, expected_control_version: expectedVersion },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) return providerResponse(validIdempotentProvider(previous, provider))

    const current = await requireProvider(context.env, provider)
    if (current.updated_at_ms !== expectedVersion) throw providerVersionConflict()
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const now = nextControlVersion(current.updated_at_ms)
    const disabled = { ...publicProvider(current), enabled: false, control_version: now, updated_at_ms: now }
    const statements = [
      context.env.DB.prepare(
        `UPDATE oauth_providers
            SET schema_version = CASE WHEN updated_at_ms = ? THEN 1 ELSE 0 END,
                enabled = 0,
                updated_at_ms = ?
          WHERE provider = ?`,
      ).bind(expectedVersion, now, provider),
      providerAuditInsert(
        context.env,
        actor.user_id,
        actor.session_id,
        'admin.oauth_provider.disable',
        provider,
        idempotency.key_hash,
        now,
      ),
      controlIdempotencyInsert(context.env, idempotency, 'oauth_provider', provider, disabled, now),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return providerResponse(validIdempotentProvider(recovered, provider))
      throw mapProviderWriteError(error)
    }
    return providerResponse(disabled)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function updateProvider(
  context: OAuthProviderContext,
  provider: AdminOAuthProvider,
  current: OAuthProviderRow,
  input: ParsedProviderInput,
  idempotency: Awaited<ReturnType<typeof controlIdempotency>>,
): Promise<Response> {
  const actor = await authenticateAdminSession(context.req.raw, context.env)
  let keyVersion = current.secret_key_version
  let nonce = current.secret_nonce_b64
  let ciphertext = current.secret_ciphertext_b64
  if (input.clientSecret === null) {
    keyVersion = null
    nonce = null
    ciphertext = null
  } else if (input.clientSecret !== undefined) {
    keyVersion = (current.secret_key_version ?? 0) + 1
    const encrypted = await encryptCredential(
      { api_key: input.clientSecret },
      requireMasterKey(context.env),
      providerSecretAad(context.env.ENVIRONMENT, provider, keyVersion),
    )
    nonce = encrypted.nonce_b64
    ciphertext = encrypted.ciphertext_b64
  }
  if (
    input.enabled &&
    (keyVersion === null || nonce === null || nonce === '' || ciphertext === null || ciphertext === '')
  ) {
    throw clientSecretRequired()
  }
  const now = nextControlVersion(current.updated_at_ms)
  const updated: AdminOAuthProviderResponse = {
    schema_version: 1,
    control_version: now,
    provider,
    adapter: input.adapter,
    enabled: input.enabled,
    issuer: input.issuer,
    authorization_endpoint: input.authorizationEndpoint,
    token_endpoint: input.tokenEndpoint,
    userinfo_endpoint: input.userinfoEndpoint,
    emails_endpoint: input.emailsEndpoint,
    jwks_endpoint: input.jwksEndpoint,
    client_id: input.clientId,
    client_secret_configured: keyVersion !== null,
    scopes: input.scopes,
    allowed_hosts: input.allowedHosts,
    frontend_callback_path: input.frontendCallbackPath,
    pkce_enabled: input.pkceEnabled,
    created_at_ms: current.created_at_ms,
    updated_at_ms: now,
  }
  const statements = [
    context.env.DB.prepare(
      `UPDATE oauth_providers
          SET schema_version = CASE WHEN updated_at_ms = ? THEN 1 ELSE 0 END,
              adapter = ?, enabled = ?, issuer = ?, authorization_endpoint = ?,
              token_endpoint = ?, userinfo_endpoint = ?, emails_endpoint = ?,
              jwks_endpoint = ?, client_id = ?, secret_key_version = ?,
              secret_nonce_b64 = ?, secret_ciphertext_b64 = ?, scopes_json = ?,
              allowed_hosts_json = ?, frontend_callback_path = ?, pkce_enabled = ?,
              updated_at_ms = ?
        WHERE provider = ?`,
    ).bind(
      current.updated_at_ms,
      input.adapter,
      input.enabled ? 1 : 0,
      input.issuer,
      input.authorizationEndpoint,
      input.tokenEndpoint,
      input.userinfoEndpoint,
      input.emailsEndpoint,
      input.jwksEndpoint,
      input.clientId,
      keyVersion,
      nonce,
      ciphertext,
      JSON.stringify(input.scopes),
      JSON.stringify(input.allowedHosts),
      input.frontendCallbackPath,
      input.pkceEnabled ? 1 : 0,
      now,
      provider,
    ),
    providerAuditInsert(
      context.env,
      actor.user_id,
      actor.session_id,
      'admin.oauth_provider.upsert',
      provider,
      idempotency.key_hash,
      now,
    ),
    controlIdempotencyInsert(context.env, idempotency, 'oauth_provider', provider, updated, now),
  ]
  try {
    await context.env.DB.batch(statements)
  } catch (error) {
    const recovered = await findControlIdempotency(context.env, idempotency)
    if (recovered !== null) return providerResponse(validIdempotentProvider(recovered, provider))
    throw mapProviderWriteError(error)
  }
  return providerResponse(updated)
}

function providerSelect(): string {
  return `SELECT provider, schema_version, adapter, enabled, issuer,
                 authorization_endpoint, token_endpoint, userinfo_endpoint,
                 emails_endpoint, jwks_endpoint, client_id,
                 secret_key_version, secret_nonce_b64, secret_ciphertext_b64,
                 scopes_json, allowed_hosts_json, frontend_callback_path,
                 pkce_enabled, created_at_ms, updated_at_ms
            FROM oauth_providers`
}

async function findProvider(env: Env, provider: AdminOAuthProvider): Promise<OAuthProviderRow | null> {
  return env.DB.prepare(`${providerSelect()} WHERE provider = ? LIMIT 1`)
    .bind(provider)
    .first<OAuthProviderRow>()
}

async function requireProvider(env: Env, provider: AdminOAuthProvider): Promise<OAuthProviderRow> {
  const row = await findProvider(env, provider)
  if (row === null) {
    throw new GatewayError(404, 'oauth_provider_not_found', 'OAuth provider configuration was not found')
  }
  return row
}

function publicProvider(row: OAuthProviderRow): AdminOAuthProviderResponse {
  const scopes = parseStoredStringArray(row.scopes_json)
  const allowedHosts = parseStoredStringArray(row.allowed_hosts_json)
  if (
    row.schema_version !== 1 || ![0, 1].includes(row.enabled) ||
    ![0, 1].includes(row.pkce_enabled) || !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0 || !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
    !providers.includes(row.provider) || expectedAdapters[row.provider] !== row.adapter ||
    ((row.secret_key_version === null) !== (row.secret_nonce_b64 === null)) ||
    ((row.secret_key_version === null) !== (row.secret_ciphertext_b64 === null))
  ) throw invalidStoredProvider()
  return {
    schema_version: 1,
    control_version: row.updated_at_ms,
    provider: row.provider,
    adapter: row.adapter,
    enabled: row.enabled === 1,
    issuer: row.issuer,
    authorization_endpoint: row.authorization_endpoint,
    token_endpoint: row.token_endpoint,
    userinfo_endpoint: row.userinfo_endpoint,
    emails_endpoint: row.emails_endpoint,
    jwks_endpoint: row.jwks_endpoint,
    client_id: row.client_id,
    client_secret_configured: row.secret_key_version !== null,
    scopes,
    allowed_hosts: allowedHosts,
    frontend_callback_path: row.frontend_callback_path,
    pkce_enabled: row.pkce_enabled === 1,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  }
}

function parseProviderInput(
  provider: AdminOAuthProvider,
  body: Record<string, unknown>,
  env: Env,
): ParsedProviderInput {
  rejectUnknownKeys(body, [
    'expected_control_version', 'adapter', 'enabled', 'issuer',
    'authorization_endpoint', 'token_endpoint', 'userinfo_endpoint',
    'emails_endpoint', 'jwks_endpoint', 'client_id', 'client_secret',
    'scopes', 'allowed_hosts', 'frontend_callback_path', 'pkce_enabled',
  ])
  const adapter = requiredString(body.adapter, 'adapter', 32)
  if (adapter !== expectedAdapters[provider]) {
    throw new GatewayError(400, 'invalid_adapter', `adapter must be ${expectedAdapters[provider]} for ${provider}`)
  }
  const allowedHosts = parseAllowedHosts(body.allowed_hosts, env)
  const allowedHostSet = new Set(allowedHosts)
  const authorizationEndpoint = externalEndpoint(body.authorization_endpoint, 'authorization_endpoint', allowedHostSet, env)
  const tokenEndpoint = externalEndpoint(body.token_endpoint, 'token_endpoint', allowedHostSet, env)
  const userinfoEndpoint = externalEndpoint(body.userinfo_endpoint, 'userinfo_endpoint', allowedHostSet, env)
  const emailsEndpoint = nullableEndpoint(body.emails_endpoint, 'emails_endpoint', allowedHostSet, env)
  const jwksEndpoint = nullableEndpoint(body.jwks_endpoint, 'jwks_endpoint', allowedHostSet, env)
  if (provider === 'oidc' && jwksEndpoint === null) {
    throw new GatewayError(400, 'invalid_jwks_endpoint', 'OIDC providers require jwks_endpoint')
  }
  const issuer = requiredString(body.issuer, 'issuer', MAX_ENDPOINT_LENGTH)
  if (provider === 'oidc') externalUrl(issuer, 'issuer', allowedHostSet, env)
  return {
    adapter: adapter as OAuthAdapter,
    enabled: optionalBoolean(body.enabled, true),
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint,
    emailsEndpoint,
    jwksEndpoint,
    clientId: requiredString(body.client_id, 'client_id', 512),
    clientSecret: optionalNullableSecret(body.client_secret),
    scopes: parseScopes(body.scopes),
    allowedHosts,
    frontendCallbackPath: callbackPath(body.frontend_callback_path),
    pkceEnabled: optionalBoolean(body.pkce_enabled, true),
  }
}

function parseProvider(value: unknown): AdminOAuthProvider {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!providers.includes(normalized as AdminOAuthProvider)) {
    throw new GatewayError(400, 'invalid_oauth_provider', 'OAuth provider is invalid')
  }
  return normalized as AdminOAuthProvider
}

function parseAllowedHosts(value: unknown, env: Env): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALLOWED_HOSTS) {
    throw new GatewayError(400, 'invalid_allowed_hosts', `allowed_hosts must contain 1-${MAX_ALLOWED_HOSTS} hosts`)
  }
  const result: string[] = []
  for (const item of value) {
    const host = requiredString(item, 'allowed_hosts', 253).toLowerCase()
    if (!validExternalHost(host, env) || result.includes(host)) {
      throw new GatewayError(400, 'invalid_allowed_hosts', 'allowed_hosts contains an invalid or duplicate host')
    }
    result.push(host)
  }
  return result
}

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) {
    throw new GatewayError(400, 'invalid_scopes', `scopes must contain at most ${MAX_SCOPES} values`)
  }
  const result: string[] = []
  for (const item of value) {
    const scope = requiredString(item, 'scopes', MAX_SCOPE_LENGTH)
    if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope) || result.includes(scope)) {
      throw new GatewayError(400, 'invalid_scopes', 'scopes contains an invalid or duplicate value')
    }
    result.push(scope)
  }
  if (result.join(' ').length > MAX_SCOPES_TOTAL_LENGTH) {
    throw new GatewayError(400, 'invalid_scopes', 'scopes is too large')
  }
  return result
}

function externalEndpoint(
  value: unknown,
  field: string,
  allowedHosts: Set<string>,
  env: Env,
): string {
  const endpoint = requiredString(value, field, MAX_ENDPOINT_LENGTH)
  return externalUrl(endpoint, field, allowedHosts, env).toString()
}

function nullableEndpoint(
  value: unknown,
  field: string,
  allowedHosts: Set<string>,
  env: Env,
): string | null {
  if (value === undefined || value === null || value === '') return null
  return externalEndpoint(value, field, allowedHosts, env)
}

function externalUrl(value: string, field: string, allowedHosts: Set<string>, env: Env): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a valid HTTPS URL`)
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.hash !== '' || !allowedHosts.has(host) ||
    !validExternalHost(host, env)
  ) throw new GatewayError(400, `invalid_${field}`, `${field} must use an allowed HTTPS host`)
  return url
}

function validExternalHost(host: string, env: Env): boolean {
  if (
    host === '' || host === 'localhost' || host.includes(':') ||
    /^\d+(?:\.\d+){3}$/.test(host) || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.localhost')
  ) return false
  if (host.endsWith('.test') && env.ENVIRONMENT !== 'test') return false
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
}

function callbackPath(value: unknown): string {
  const path = requiredString(value, 'frontend_callback_path', 512)
  if (
    !path.startsWith('/') || path.startsWith('//') || !path.startsWith('/auth/') ||
    path.includes('://') || path.includes('\\') || path.includes('\r') ||
    path.includes('\n') || path.includes('?') || path.includes('#')
  ) {
    throw new GatewayError(
      400,
      'invalid_frontend_callback_path',
      'frontend_callback_path must be an internal /auth/ path',
    )
  }
  return path
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new GatewayError(400, 'invalid_boolean', 'Boolean field is invalid')
  return value
}

function optionalNullableSecret(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return value === undefined ? undefined : null
  return requiredString(value, 'client_secret', 8_192)
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  }
  return value.trim()
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unexpected !== undefined) {
    throw new GatewayError(400, 'unknown_field', `Unsupported field: ${unexpected}`)
  }
}

function parseStoredStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error()
    return parsed
  } catch {
    throw invalidStoredProvider()
  }
}

function providerResponse(value: AdminOAuthProviderResponse, status = 200): Response {
  const response = controlSuccess(value, status)
  response.headers.set('etag', `"${value.control_version}"`)
  return response
}

function providerAuditInsert(
  env: Env,
  userId: string,
  sessionId: string,
  eventType: string,
  provider: AdminOAuthProvider,
  idempotencyKeyHash: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, 'succeeded', NULL, NULL, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    userId,
    eventType,
    sessionId,
    JSON.stringify({ provider, idempotency_key_hash: idempotencyKeyHash }),
    now,
  )
}

function validIdempotentProvider(
  row: Parameters<typeof parseIdempotentResponse>[0],
  provider: AdminOAuthProvider,
): AdminOAuthProviderResponse {
  const value = parseIdempotentResponse<AdminOAuthProviderResponse>(row, 'oauth_provider')
  if (
    row.resource_id !== provider || value.provider !== provider || value.schema_version !== 1 ||
    typeof value.client_secret_configured !== 'boolean' || containsSecret(value)
  ) throw invalidStoredProvider()
  return value
}

function containsSecret(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSecret)
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (['client_secret', 'secret_nonce_b64', 'secret_ciphertext_b64', 'secret_key_version'].includes(key)) return true
    if (containsSecret(nested)) return true
  }
  return false
}

function providerSecretAad(environment: string, provider: AdminOAuthProvider, keyVersion: number): string {
  return `oauth-provider-secret/${environment}/${provider}/${keyVersion}`
}

function requireMasterKey(env: Env): string {
  if (!env.CREDENTIALS_MASTER_KEY || new TextEncoder().encode(env.CREDENTIALS_MASTER_KEY).byteLength < 32) {
    throw new GatewayError(
      503,
      'oauth_provider_encryption_not_configured',
      'OAuth provider encryption is not configured',
      'server_error',
    )
  }
  return env.CREDENTIALS_MASTER_KEY
}

function providerVersionConflict(): GatewayError {
  return new GatewayError(412, 'oauth_provider_version_conflict', 'OAuth provider changed; reload it and retry')
}

function clientSecretRequired(): GatewayError {
  return new GatewayError(
    400,
    'oauth_client_secret_required',
    'A client secret is required before enabling this OAuth provider',
  )
}

function nextControlVersion(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'oauth_provider_version_exhausted', 'OAuth provider version is exhausted')
  }
  return Math.max(Date.now(), current + 1)
}

function mapProviderWriteError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/UNIQUE constraint failed: oauth_providers\.provider/i.test(message)) return providerVersionConflict()
  if (/CHECK constraint failed:.*schema_version/i.test(message)) return providerVersionConflict()
  return asGatewayError(error)
}

function invalidStoredProvider(): GatewayError {
  return new GatewayError(
    503,
    'invalid_oauth_provider_record',
    'OAuth provider configuration is invalid',
    'server_error',
  )
}
