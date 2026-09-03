import type { Env } from '../env'
import { apiKeyDigest, constantTimeEqual, encryptCredential, randomToken } from './crypto'
import { GatewayError } from './errors'
import { credentialAad, validateBaseUrl } from './repository'

interface BootstrapBody {
  user: { email: string; display_name?: string; balance_micros: number }
  group: { name: string }
  account: { name: string; base_url: string; api_key: string; max_concurrency?: number }
  api_key?: { name?: string }
  models: Array<{
    public_name: string
    upstream_name?: string
    endpoint?: 'chat_completions' | 'responses' | 'both'
    input_micros_per_million: number
    output_micros_per_million: number
    cache_read_micros_per_million?: number
    per_request_micros?: number
    minimum_reservation_micros?: number
    max_output_tokens?: number
    default_max_output_tokens?: number
  }>
}

export async function bootstrapGateway(request: Request, env: Env): Promise<Response> {
  requireBootstrapSecrets(env)
  const presented = parseBearer(request.headers.get('authorization'))
  if (!constantTimeEqual(presented, env.ADMIN_TOKEN!)) {
    throw new GatewayError(401, 'invalid_admin_token', 'Invalid admin token', 'authentication_error')
  }

  const body = await readBody(request)
  const now = Date.now()
  const userId = crypto.randomUUID()
  const groupId = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const secretId = crypto.randomUUID()
  const customerKey = `sk-sub2api-${randomToken(24)}`
  const keyId = crypto.randomUUID()
  const baseUrl = validateBaseUrl(requireString(body.account.base_url, 'account.base_url', 2_048))
  const upstreamKey = requireString(body.account.api_key, 'account.api_key', 8_192)
  const encrypted = await encryptCredential(
    { api_key: upstreamKey },
    env.CREDENTIALS_MASTER_KEY!,
    credentialAad(env.ENVIRONMENT, accountId, secretId, 1),
  )
  const keyHash = await apiKeyDigest(customerKey, env.API_KEY_PEPPER!)
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, balance_micros,
         state_version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'admin', 'active', ?, 0, ?, ?)`,
    ).bind(
      userId,
      requireEmail(body.user.email),
      optionalString(body.user.display_name, 'user.display_name', 256) ?? '',
      requireInteger(body.user.balance_micros, 'user.balance_micros', 1),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'openai', 1, ?, ?)`,
    ).bind(groupId, requireString(body.group.name, 'group.name', 128), now, now),
    env.DB.prepare(
      `INSERT INTO accounts (
         id, platform, name, credential_ref, enabled, max_concurrency,
         created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
       ) VALUES (?, 'openai', ?, ?, 1, ?, ?, ?, 'openai', ?, 'bearer', 1)`,
    ).bind(
      accountId,
      requireString(body.account.name, 'account.name', 128),
      secretId,
      requireInteger(body.account.max_concurrency ?? 4, 'account.max_concurrency', 1, 1_000),
      now,
      now,
      baseUrl.toString().replace(/\/$/, ''),
    ),
    env.DB.prepare(
      `INSERT INTO account_secrets (
         id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).bind(secretId, accountId, encrypted.nonce_b64, encrypted.ciphertext_b64, now, now),
    env.DB.prepare(
      `INSERT INTO account_groups (
         account_id, group_id, priority, weight, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 0, 1, ?, ?)`,
    ).bind(accountId, groupId, now, now),
    env.DB.prepare(
      `INSERT INTO api_keys (
         id, user_id, key_hash, name, enabled, created_at_ms, updated_at_ms,
         group_id, key_prefix, auth_version
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
    ).bind(
      keyId,
      userId,
      keyHash,
      optionalString(body.api_key?.name, 'api_key.name', 128) ?? 'default',
      now,
      now,
      groupId,
      customerKey.slice(0, 16),
    ),
  ]

  if (!Array.isArray(body.models) || body.models.length === 0 || body.models.length > 20) {
    throw new GatewayError(400, 'invalid_models', 'models must contain between 1 and 20 entries')
  }
  const publicNames = new Set<string>()
  for (const model of body.models) {
    const publicName = requireString(model.public_name, 'models.public_name', 256)
    if (publicNames.has(publicName)) {
      throw new GatewayError(400, 'duplicate_model', `Model '${publicName}' is duplicated`)
    }
    publicNames.add(publicName)
    const modelId = crypto.randomUUID()
    const priceId = crypto.randomUUID()
    const endpoint = model.endpoint ?? 'both'
    if (!['chat_completions', 'responses', 'both'].includes(endpoint)) {
      throw new GatewayError(400, 'invalid_model_endpoint', `Invalid endpoint for model '${publicName}'`)
    }
    const maximum = requireInteger(model.max_output_tokens ?? 16_384, 'models.max_output_tokens', 1, 1_000_000)
    const defaultMaximum = requireInteger(
      model.default_max_output_tokens ?? Math.min(4_096, maximum),
      'models.default_max_output_tokens',
      1,
      maximum,
    )
    statements.push(
      env.DB.prepare(
        `INSERT INTO models (
           id, platform, public_name, upstream_name, endpoint, enabled, created_at_ms, updated_at_ms
         ) VALUES (?, 'openai', ?, ?, ?, 1, ?, ?)`,
      ).bind(
        modelId,
        publicName,
        optionalString(model.upstream_name, 'models.upstream_name', 256) ?? publicName,
        endpoint,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO group_models (
           group_id, model_id, enabled, sort_order, max_output_tokens,
           default_max_output_tokens, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 1, 0, ?, ?, ?, ?)`,
      ).bind(groupId, modelId, maximum, defaultMaximum, now, now),
      env.DB.prepare(
        `INSERT INTO account_models (
           account_id, model_id, chat_completions, responses, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        accountId,
        modelId,
        endpoint === 'responses' ? 0 : 1,
        endpoint === 'chat_completions' ? 0 : 1,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO model_prices (
           id, group_id, model_id, version, active,
           input_micros_per_million, output_micros_per_million,
           cache_read_micros_per_million, per_request_micros,
           minimum_reservation_micros, effective_at_ms, created_at_ms
         ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        priceId,
        groupId,
        modelId,
        requireInteger(model.input_micros_per_million, 'models.input_micros_per_million'),
        requireInteger(model.output_micros_per_million, 'models.output_micros_per_million'),
        requireInteger(model.cache_read_micros_per_million ?? 0, 'models.cache_read_micros_per_million'),
        requireInteger(model.per_request_micros ?? 0, 'models.per_request_micros'),
        requireInteger(model.minimum_reservation_micros ?? 1, 'models.minimum_reservation_micros', 1),
        now,
        now,
      ),
    )
  }

  await env.DB.batch(statements)
  return Response.json(
    {
      code: 0,
      data: {
        user_id: userId,
        group_id: groupId,
        account_id: accountId,
        api_key_id: keyId,
        api_key: customerKey,
        warning: 'This API key is shown only once.',
      },
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  )
}

function requireBootstrapSecrets(env: Env): void {
  if (!env.ADMIN_TOKEN || !env.API_KEY_PEPPER || !env.CREDENTIALS_MASTER_KEY) {
    throw new GatewayError(503, 'bootstrap_not_configured', 'Bootstrap secrets are not configured', 'server_error')
  }
  if (env.ADMIN_TOKEN.length < 24 || env.API_KEY_PEPPER.length < 32 || env.CREDENTIALS_MASTER_KEY.length < 32) {
    throw new GatewayError(503, 'weak_bootstrap_secrets', 'Bootstrap secrets do not meet minimum length requirements', 'server_error')
  }
}

async function readBody(request: Request): Promise<BootstrapBody> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_body', 'Request body must be a JSON object')
  }
  const body = value as Partial<BootstrapBody>
  if (!body.user || !body.group || !body.account) {
    throw new GatewayError(400, 'invalid_body', 'user, group, account, and models are required')
  }
  return body as BootstrapBody
}

function parseBearer(value: string | null): string {
  const match = /^Bearer\s+([^\s]+)$/i.exec(value?.trim() ?? '')
  if (match === null) {
    throw new GatewayError(401, 'admin_token_required', 'Admin Bearer token is required', 'authentication_error')
  }
  return match[1]
}

function requireEmail(value: unknown): string {
  const email = requireString(value, 'user.email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GatewayError(400, 'invalid_email', 'user.email must be a valid email address')
  }
  return email
}

function requireString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new GatewayError(400, `invalid_${field.replace(/\./g, '_')}`, `${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requireString(value, field, maximum)
}

function requireInteger(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GatewayError(400, `invalid_${field.replace(/\./g, '_')}`, `${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}
