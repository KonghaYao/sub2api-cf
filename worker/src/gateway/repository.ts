import type { Env } from '../env'
import { apiKeyDigest } from './crypto'
import { GatewayError } from './errors'
import type {
  AccountCandidate,
  AccountCredential,
  GatewayEndpoint,
  GatewayPrincipal,
  ModelRoute,
} from './types'

interface PrincipalRow {
  api_key_id: string
  api_key_auth_version: number
  api_key_enabled: number
  expires_at_ms: number | null
  revoked_at_ms: number | null
  user_id: string
  user_status: string
  balance_micros: number
  user_state_version: number
  group_id: string
  group_enabled: number
  platform: string
}

export async function authenticateGatewayRequest(
  request: Request,
  env: Env,
): Promise<GatewayPrincipal> {
  const url = new URL(request.url)
  if (url.searchParams.has('key') || url.searchParams.has('api_key')) {
    throw new GatewayError(
      400,
      'api_key_in_query_deprecated',
      'API key in query parameters is not supported; use Authorization: Bearer instead',
    )
  }

  const rawKey = readApiKey(request.headers)
  if (!env.API_KEY_PEPPER) {
    throw new GatewayError(503, 'gateway_not_configured', 'Gateway API key secret is not configured', 'server_error')
  }
  const digest = await apiKeyDigest(rawKey, env.API_KEY_PEPPER)
  const row = await env.DB.prepare(
    `SELECT k.id AS api_key_id, k.auth_version AS api_key_auth_version,
            k.enabled AS api_key_enabled, k.expires_at_ms, k.revoked_at_ms,
            u.id AS user_id, u.status AS user_status, u.balance_micros,
            u.state_version AS user_state_version,
            g.id AS group_id, g.enabled AS group_enabled, g.platform
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       JOIN "groups" g ON g.id = k.group_id
      WHERE k.key_hash = ?
      LIMIT 1`,
  )
    .bind(digest)
    .first<PrincipalRow>()

  if (
    row === null ||
    row.api_key_enabled !== 1 ||
    row.revoked_at_ms !== null ||
    (row.expires_at_ms !== null && row.expires_at_ms <= Date.now())
  ) {
    throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API key', 'authentication_error')
  }
  if (row.user_status !== 'active') {
    throw new GatewayError(403, 'user_disabled', 'User account is disabled', 'permission_error')
  }
  if (row.group_enabled !== 1 || row.platform !== 'openai') {
    throw new GatewayError(403, 'group_unavailable', 'API key group is unavailable', 'permission_error')
  }

  return {
    api_key_id: row.api_key_id,
    api_key_auth_version: row.api_key_auth_version,
    user_id: row.user_id,
    group_id: row.group_id,
    platform: row.platform,
    balance_micros: row.balance_micros,
    user_state_version: row.user_state_version,
  }
}

export async function listModels(env: Env, groupId: string): Promise<ModelRoute[]> {
  const result = await env.DB.prepare(
    `${modelSelect()}
      WHERE gm.group_id = ? AND gm.enabled = 1 AND m.enabled = 1 AND p.active = 1
        AND (g.catalog_mode = 'all_routable' OR gm.catalog_visible = 1)
        AND EXISTS (
          SELECT 1
            FROM account_groups ag
            JOIN accounts a ON a.id = ag.account_id
            JOIN account_models am ON am.account_id = a.id AND am.model_id = m.id
           WHERE ag.group_id = gm.group_id AND a.enabled = 1
             AND a.platform = 'openai' AND a.protocol = 'openai'
             AND (
               (m.endpoint = 'chat_completions' AND am.chat_completions = 1) OR
               (m.endpoint = 'responses' AND am.responses = 1) OR
               (m.endpoint = 'both' AND (am.chat_completions = 1 OR am.responses = 1))
             )
        )
      ORDER BY gm.sort_order ASC, m.public_name ASC`,
  )
    .bind(groupId)
    .all<ModelRoute>()
  return result.results
}

export async function resolveGatewayRoute(
  env: Env,
  groupId: string,
  publicName: string,
  endpoint: GatewayEndpoint,
): Promise<{ model: ModelRoute; candidates: AccountCandidate[] }> {
  const capabilityColumn = endpoint === 'chat_completions' ? 'am.chat_completions' : 'am.responses'
  const [modelResult, candidateResult] = await env.DB.batch([
    env.DB.prepare(
      `${modelSelect()}
        WHERE gm.group_id = ? AND m.public_name = ?
          AND gm.enabled = 1 AND m.enabled = 1 AND p.active = 1
          AND g.enabled = 1 AND g.platform = 'openai' AND m.platform = g.platform
          AND (m.endpoint = ? OR m.endpoint = 'both')
        LIMIT 1`,
    ).bind(groupId, publicName, endpoint),
    accountCandidatesStatement(env, groupId, publicName, capabilityColumn),
  ])
  const model = modelResult.results[0] as unknown as ModelRoute | undefined
  if (model === undefined) {
    throw new GatewayError(404, 'model_not_found', `Model '${publicName}' is not available`, 'invalid_request_error')
  }
  const candidates = candidateResult.results as unknown as AccountCandidate[]
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => candidate.config_revision !== model.config_revision)
  ) {
    throw new GatewayError(503, 'no_upstream_accounts', 'No upstream account is configured', 'server_error')
  }
  return { model, candidates }
}

function accountCandidatesStatement(
  env: Env,
  groupId: string,
  publicName: string,
  capabilityColumn: 'am.chat_completions' | 'am.responses',
): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT a.id AS account_id, a.base_url, a.max_concurrency,
            ag.priority, ag.weight, a.config_version,
            revision.revision AS config_revision, am.model_id
       FROM account_groups ag
       JOIN accounts a ON a.id = ag.account_id
       JOIN account_models am ON am.account_id = a.id
       CROSS JOIN gateway_config_revision revision
      WHERE ag.group_id = ? AND a.enabled = 1 AND a.platform = 'openai'
        AND a.protocol = 'openai' AND a.base_url IS NOT NULL
        AND am.model_id = (
          SELECT id FROM models WHERE platform = 'openai' AND public_name = ? LIMIT 1
        )
        AND ${capabilityColumn} = 1
      ORDER BY ag.priority ASC, a.id ASC`,
  )
    .bind(groupId, publicName)
}

export async function getAccountCredential(
  env: Env,
  groupId: string,
  modelId: string,
  endpoint: GatewayEndpoint,
  accountId: string,
): Promise<AccountCredential> {
  const capabilityColumn = endpoint === 'chat_completions' ? 'am.chat_completions' : 'am.responses'
  const row = await env.DB.prepare(
    `SELECT a.id AS account_id, a.base_url, a.auth_scheme,
            s.id AS secret_id, s.key_version, s.nonce_b64, s.ciphertext_b64
       FROM accounts a
       JOIN account_groups ag ON ag.account_id = a.id
       JOIN account_models am ON am.account_id = a.id
       JOIN account_secrets s ON s.id = a.credential_ref AND s.account_id = a.id
      WHERE a.id = ? AND ag.group_id = ? AND am.model_id = ?
        AND ${capabilityColumn} = 1 AND a.enabled = 1
        AND a.platform = 'openai' AND a.protocol = 'openai'
        AND a.base_url IS NOT NULL
      LIMIT 1`,
  )
    .bind(accountId, groupId, modelId)
    .first<AccountCredential>()
  if (row === null || row.auth_scheme !== 'bearer') {
    throw new GatewayError(503, 'credential_unavailable', 'Upstream account credential is unavailable', 'server_error')
  }
  return row
}

export function credentialAad(
  environment: string,
  accountId: string,
  secretId: string,
  keyVersion: number,
): string {
  return `${environment}/${accountId}/${secretId}/${keyVersion}`
}

export function validateBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GatewayError(400, 'invalid_base_url', 'Upstream base_url must be a valid HTTPS URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    url.port !== ''
  ) {
    throw new GatewayError(400, 'invalid_base_url', 'Upstream base_url must be HTTPS on port 443 without credentials, query, or fragment')
  }
  const hostname = url.hostname.toLowerCase()
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.includes(':')
  ) {
    throw new GatewayError(400, 'invalid_base_url', 'Private or local upstream hosts are not allowed')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

function readApiKey(headers: Headers): string {
  const authorization = headers.get('authorization')?.trim() ?? ''
  const alternate = headers.get('x-api-key')?.trim() ?? ''
  let bearer = ''
  if (authorization !== '') {
    if (authorization.length > 8_320) {
      throw new GatewayError(401, 'invalid_api_key', 'Invalid API key', 'authentication_error')
    }
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
    if (match === null) {
      throw new GatewayError(401, 'invalid_auth_header', "Authorization header must use the Bearer scheme", 'authentication_error')
    }
    bearer = match[1]
  }
  if (bearer !== '' && alternate !== '' && bearer !== alternate) {
    throw new GatewayError(400, 'conflicting_api_keys', 'Authorization and x-api-key credentials conflict')
  }
  const value = bearer || alternate
  if (value === '' || value.length > 8_192) {
    throw new GatewayError(401, 'api_key_required', 'API key is required', 'authentication_error')
  }
  return value
}

function modelSelect(): string {
  return `SELECT revision.revision AS config_revision,
                 m.id AS model_id, m.public_name,
                 COALESCE(gm.upstream_name_override, m.upstream_name) AS upstream_name,
                 m.endpoint, p.id AS price_id, p.version AS price_version,
                 p.input_micros_per_million, p.output_micros_per_million,
                 p.cache_read_micros_per_million, p.per_request_micros,
                 p.minimum_reservation_micros,
                 g.rate_multiplier_ppm,
                 gm.max_output_tokens, gm.default_max_output_tokens
            FROM group_models gm
            JOIN "groups" g ON g.id = gm.group_id
            JOIN models m ON m.id = gm.model_id
            JOIN model_prices p ON p.group_id = gm.group_id AND p.model_id = gm.model_id
            CROSS JOIN gateway_config_revision revision`
}
