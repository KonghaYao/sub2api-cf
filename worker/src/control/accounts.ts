import type { Context } from 'hono'
import type { Env } from '../env'
import { decryptCredential, encryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  buildProviderHealthRequest,
  providerContract,
  type ProviderAccount,
  type ProviderAuthScheme,
  type ProviderConfig,
  type ProviderPlatform,
  type ProviderProtocol,
} from '../gateway/providers'
import { credentialAad, validateBaseUrl } from '../gateway/repository'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from './http'

type ControlBindings = { Bindings: Env }

interface AccountRow {
  id: string
  platform: ProviderPlatform
  name: string
  credential_ref: string
  enabled: number
  max_concurrency: number
  protocol: ProviderProtocol
  base_url: string
  auth_scheme: ProviderAuthScheme
  provider_config_json: string
  config_version: number
  control_version: number
  health_status: 'unknown' | 'healthy' | 'unhealthy'
  last_checked_at_ms: number | null
  last_latency_ms: number | null
  last_health_error: string | null
  created_at_ms: number
  updated_at_ms: number
  secret_id: string
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
  group_links_json: string
  model_capabilities_json: string
}

interface GroupLink {
  group_id: string
  priority: number
  weight: number
  control_version: number
}

interface ModelCapability {
  model_id: string
  chat_completions: boolean
  responses: boolean
  embeddings: boolean
  image_generation: boolean
  control_version: number
}

interface CreateAccountInput {
  name: string
  platform: ProviderPlatform
  protocol: ProviderProtocol
  base_url: string
  auth_scheme: ProviderAuthScheme
  provider_config: ProviderConfig
  api_key: string
  enabled: boolean
  max_concurrency: number
  group_links: GroupLinkInput[]
  model_capabilities: ModelCapabilityInput[]
}

interface GroupLinkInput {
  group_id: string
  priority: number
  weight: number
}

interface ModelCapabilityInput {
  model_id: string
  chat_completions: boolean
  responses: boolean
  embeddings?: boolean
  image_generation?: boolean
}

interface AccountPatch {
  name?: string
  base_url?: string
  api_key?: string
  provider_config?: ProviderConfig
  enabled?: boolean
  max_concurrency?: number
  group_links?: GroupLinkInput[]
  model_capabilities?: ModelCapabilityInput[]
}

const ACCOUNT_PROJECTION = `
  SELECT a.id, a.platform, a.name, a.credential_ref, a.enabled,
         a.max_concurrency, a.protocol, a.base_url, a.auth_scheme,
         a.provider_config_json,
         a.config_version, a.control_version, a.health_status,
         a.last_checked_at_ms, a.last_latency_ms, a.last_health_error,
         a.created_at_ms, a.updated_at_ms,
         s.id AS secret_id, s.key_version, s.nonce_b64, s.ciphertext_b64,
         COALESCE((
           SELECT json_group_array(json_object(
             'group_id', links.group_id,
             'priority', links.priority,
             'weight', links.weight,
             'control_version', links.control_version
           ))
             FROM (
               SELECT group_id, priority, weight, control_version
                 FROM account_groups
                WHERE account_id = a.id
                ORDER BY priority ASC, group_id ASC
             ) AS links
         ), '[]') AS group_links_json,
         COALESCE((
           SELECT json_group_array(json_object(
             'model_id', capabilities.model_id,
             'chat_completions', capabilities.chat_completions,
             'responses', capabilities.responses,
             'embeddings', capabilities.embeddings,
             'image_generation', capabilities.image_generation,
             'control_version', capabilities.control_version
           ))
             FROM (
               SELECT model_id, chat_completions, responses, embeddings, image_generation,
                      control_version
                 FROM account_models
                WHERE account_id = a.id
                ORDER BY model_id ASC
             ) AS capabilities
         ), '[]') AS model_capabilities_json
    FROM accounts a
    JOIN account_secrets s
      ON s.id = a.credential_ref AND s.account_id = a.id
`

export async function listAdminAccounts(context: Context<ControlBindings>): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const conditions = [
      `(
        (a.platform = 'openai' AND a.protocol = 'openai' AND a.auth_scheme = 'bearer')
        OR (a.platform = 'anthropic' AND a.protocol = 'anthropic' AND a.auth_scheme = 'x-api-key')
        OR (a.platform = 'gemini' AND a.protocol = 'gemini' AND a.auth_scheme = 'x-goog-api-key')
        OR (a.platform = 'codex' AND a.protocol = 'codex' AND a.auth_scheme = 'bearer')
      )`,
      'a.base_url IS NOT NULL',
    ]
    const values: unknown[] = []
    const platform = context.req.query('platform')
    if (platform !== undefined) {
      const supportedPlatform = requireProviderPlatform(platform)
      conditions.push('a.platform = ?')
      values.push(supportedPlatform)
    }
    const enabled = parseEnabledQuery(context.req.query('enabled'), context.req.query('status'))
    if (enabled !== undefined) {
      conditions.push('a.enabled = ?')
      values.push(enabled ? 1 : 0)
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 256) throw new GatewayError(400, 'invalid_search', 'search must not exceed 256 characters')
      conditions.push(`a.name LIKE ? ESCAPE '\\'`)
      values.push(`%${escapeLike(search)}%`)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total
           FROM accounts a
           JOIN account_secrets s
             ON s.id = a.credential_ref AND s.account_id = a.id
          ${where}`,
      ).bind(...values),
      context.env.DB.prepare(
        `${ACCOUNT_PROJECTION} ${where}
         ORDER BY a.updated_at_ms DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const totalValue = (countResult.results[0] as { total?: unknown } | undefined)?.total
    if (!Number.isSafeInteger(totalValue) || (totalValue as number) < 0) {
      throw new GatewayError(500, 'invalid_account_count', 'Account count projection is invalid', 'server_error')
    }
    const total = totalValue as number
    return controlSuccess({
      items: (rowsResult.results as unknown as AccountRow[]).map(publicAccount),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    return controlSuccess(publicAccount(account))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const input = parseCreateAccount(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency('admin.accounts.create.v1', idempotencyKey, input)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = safeIdempotentAccount(previous)
      return controlSuccess(replay)
    }

    const accountId = await deterministicUuid('admin.accounts.create.v1', idempotencyKey)
    const secretId = await deterministicUuid('admin.account-secrets.create.v1', idempotencyKey)
    if ((await findAccount(context.env, accountId)) !== null) {
      throw new GatewayError(409, 'idempotency_record_missing', 'Account exists without its idempotency record')
    }
    await validateLinks(context.env, input.platform, input.group_links, input.model_capabilities)
    const masterKey = requireCredentialsMasterKey(context.env)
    const encrypted = await encryptCredential(
      { api_key: input.api_key },
      masterKey,
      credentialAad(context.env.ENVIRONMENT, accountId, secretId, 1),
    )
    const now = Date.now()
    const safe = accountResponse({
      id: accountId,
      platform: input.platform,
      name: input.name,
      enabled: input.enabled,
      max_concurrency: input.max_concurrency,
      protocol: input.protocol,
      base_url: input.base_url,
      auth_scheme: input.auth_scheme,
      provider_config: input.provider_config,
      config_version: 1,
      control_version: 0,
      health_status: 'unknown',
      last_checked_at_ms: null,
      last_latency_ms: null,
      last_health_error: null,
      created_at_ms: now,
      updated_at_ms: now,
      credential_key_version: 1,
      group_links: input.group_links.map((value) => ({ ...value, control_version: 0 })),
      model_capabilities: input.model_capabilities.map((value) => ({
        ...value,
        embeddings: value.embeddings ?? false,
        image_generation: value.image_generation ?? false,
        control_version: 0,
      })),
    })
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO accounts (
           id, platform, name, credential_ref, enabled, max_concurrency,
           created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
           provider_config_json, config_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).bind(
        accountId,
        input.platform,
        input.name,
        secretId,
        input.enabled ? 1 : 0,
        input.max_concurrency,
        now,
        now,
        input.protocol,
        input.base_url,
        input.auth_scheme,
        JSON.stringify(input.provider_config),
      ),
      context.env.DB.prepare(
        `INSERT INTO account_secrets (
           id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).bind(secretId, accountId, encrypted.nonce_b64, encrypted.ciphertext_b64, now, now),
      ...groupInsertStatements(context.env, accountId, input.group_links, now),
      ...capabilityInsertStatements(context.env, accountId, input.model_capabilities, now),
      controlIdempotencyInsert(context.env, idempotency, 'account', accountId, safe, now),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        const replay = safeIdempotentAccount(recovered)
        return controlSuccess(replay)
      }
      throw mapAccountWriteError(error)
    }
    return controlSuccess(safe, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const patch = parseAccountPatch(body, account)
    await validateLinks(
      context.env,
      account.platform,
      patch.group_links ?? [],
      patch.model_capabilities ?? [],
    )
    const nextControlVersion = incrementVersion(account.control_version, 'control_version')
    const nextConfigVersion = incrementVersion(account.config_version, 'config_version')
    const now = Date.now()
    const baseUrl = patch.base_url ?? account.base_url
    const providerConfig = patch.provider_config ?? parseProviderConfigProjection(account.provider_config_json)
    const resetHealth = patch.base_url !== undefined ||
      patch.api_key !== undefined ||
      patch.provider_config !== undefined
    const statements: D1PreparedStatement[] = [
      accountCasStatement(context.env, account.id, account.control_version, {
        name: patch.name ?? account.name,
        enabled: patch.enabled ?? account.enabled === 1,
        max_concurrency: patch.max_concurrency ?? account.max_concurrency,
        base_url: baseUrl,
        provider_config: providerConfig,
        config_version: nextConfigVersion,
        control_version: nextControlVersion,
        now,
        reset_health: resetHealth,
      }),
    ]
    let nextKeyVersion = account.key_version
    if (patch.api_key !== undefined) {
      nextKeyVersion = incrementVersion(account.key_version, 'credential_key_version')
      const encrypted = await encryptCredential(
        { api_key: patch.api_key },
        requireCredentialsMasterKey(context.env),
        credentialAad(context.env.ENVIRONMENT, account.id, account.secret_id, nextKeyVersion),
      )
      statements.push(
        context.env.DB.prepare(
          `UPDATE account_secrets
              SET key_version = CASE WHEN key_version = ? THEN ? ELSE 0 END,
                  nonce_b64 = ?, ciphertext_b64 = ?, updated_at_ms = ?
            WHERE id = ? AND account_id = ?`,
        ).bind(
          account.key_version,
          nextKeyVersion,
          encrypted.nonce_b64,
          encrypted.ciphertext_b64,
          now,
          account.secret_id,
          account.id,
        ),
      )
    }
    if (patch.group_links !== undefined) {
      statements.push(
        context.env.DB.prepare('DELETE FROM account_groups WHERE account_id = ?').bind(account.id),
        ...groupInsertStatements(context.env, account.id, patch.group_links, now),
      )
    }
    if (patch.model_capabilities !== undefined) {
      statements.push(
        context.env.DB.prepare('DELETE FROM account_models WHERE account_id = ?').bind(account.id),
        ...capabilityInsertStatements(context.env, account.id, patch.model_capabilities, now),
      )
    }
    await runAccountBatch(context.env, statements, account.id, account.control_version)
    const updated = await requireAccount(context.env, account.id)
    if (updated.control_version !== nextControlVersion || updated.config_version !== nextConfigVersion) {
      throw new GatewayError(503, 'account_projection_failed', 'Account update could not be read', 'server_error')
    }
    if (updated.key_version !== nextKeyVersion) {
      throw new GatewayError(503, 'account_projection_failed', 'Credential update could not be read', 'server_error')
    }
    return controlSuccess(publicAccount(updated))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const expectedVersion = requireExpectedControlVersion(context.req.raw, {})
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    if (account.enabled === 0) return controlSuccess(publicAccount(account))
    const now = Date.now()
    await runAccountBatch(
      context.env,
      [accountCasStatement(context.env, account.id, account.control_version, {
        name: account.name,
        enabled: false,
        max_concurrency: account.max_concurrency,
        base_url: account.base_url,
        provider_config: parseProviderConfigProjection(account.provider_config_json),
        config_version: incrementVersion(account.config_version, 'config_version'),
        control_version: incrementVersion(account.control_version, 'control_version'),
        now,
        reset_health: false,
      })],
      account.id,
      account.control_version,
    )
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function putAdminAccountGroupLink(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const groupId = requireResourceId(context.req.param('group_id') || context.req.param('groupId'), 'group')
    const link = parseGroupLink(body, groupId)
    await validateLinks(context.env, account.platform, [link], [])
    const now = Date.now()
    await mutateAccountRelation(context.env, account, context.env.DB.prepare(
      `INSERT INTO account_groups (
         account_id, group_id, priority, weight, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, group_id) DO UPDATE SET
         priority = excluded.priority,
         weight = excluded.weight,
         control_version = account_groups.control_version + 1,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(account.id, groupId, link.priority, link.weight, now, now), now)
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminAccountGroupLink(context: Context<ControlBindings>): Promise<Response> {
  return deleteRelation(context, 'group')
}

export async function putAdminAccountModelCapability(context: Context<ControlBindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const modelId = requireResourceId(context.req.param('model_id') || context.req.param('modelId'), 'model')
    const capability = parseModelCapability(body, modelId)
    await validateLinks(context.env, account.platform, [], [capability])
    const now = Date.now()
    await mutateAccountRelation(context.env, account, context.env.DB.prepare(
      `INSERT INTO account_models (
         account_id, model_id, chat_completions, responses, embeddings, image_generation,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, model_id) DO UPDATE SET
         chat_completions = excluded.chat_completions,
         responses = excluded.responses,
         embeddings = excluded.embeddings,
         image_generation = excluded.image_generation,
         control_version = account_models.control_version + 1,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(
      account.id,
      modelId,
      capability.chat_completions ? 1 : 0,
      capability.responses ? 1 : 0,
      capability.embeddings ? 1 : 0,
      capability.image_generation ? 1 : 0,
      now,
      now,
    ), now)
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminAccountModelCapability(context: Context<ControlBindings>): Promise<Response> {
  return deleteRelation(context, 'model')
}

export async function testAdminAccount(context: Context<ControlBindings>): Promise<Response> {
  try {
    const account = await requireAccount(context.env, context.req.param('id'))
    requireSupportedAccount(account)
    const credential = await decryptCredential(
      account.nonce_b64,
      account.ciphertext_b64,
      requireCredentialsMasterKey(context.env),
      credentialAad(context.env.ENVIRONMENT, account.id, account.secret_id, account.key_version),
    )
    const plan = buildProviderHealthRequest({
      account: providerAccount(account),
      credential,
    })
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), plan.timeout_ms)
    let status: 'healthy' | 'unhealthy' = 'unhealthy'
    let healthError: string | null = null
    try {
      const response = await fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (response.ok) status = 'healthy'
      else healthError = `Upstream returned HTTP ${response.status}`
      try {
        await response.body?.cancel()
      } catch {
        // The result has already been observed; body cleanup is best effort.
      }
    } catch (error) {
      healthError = error instanceof DOMException && error.name === 'AbortError'
        ? 'Upstream probe timed out'
        : 'Upstream probe failed'
    } finally {
      clearTimeout(timer)
    }
    const checkedAt = Date.now()
    const latency = Math.max(0, checkedAt - started)
    const result = await context.env.DB.prepare(
      `UPDATE accounts
          SET health_status = ?, last_checked_at_ms = ?, last_latency_ms = ?, last_health_error = ?
        WHERE id = ? AND config_version = ? AND credential_ref = ?`,
    ).bind(
      status,
      checkedAt,
      latency,
      healthError,
      account.id,
      account.config_version,
      account.credential_ref,
    ).run()
    if (result.meta.changes !== 1) {
      throw new GatewayError(409, 'account_probe_stale', 'Account changed while the health probe was running')
    }
    return controlSuccess({
      id: account.id,
      health_status: status,
      last_checked_at_ms: checkedAt,
      last_latency_ms: latency,
      last_health_error: healthError,
      config_version: account.config_version,
      control_version: account.control_version,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function deleteRelation(context: Context<ControlBindings>, type: 'group' | 'model'): Promise<Response> {
  try {
    const expectedVersion = requireExpectedControlVersion(context.req.raw, {})
    const account = await requireAccount(context.env, context.req.param('id'))
    assertVersion(account, expectedVersion)
    const resourceId = requireResourceId(
      context.req.param(type === 'group' ? 'group_id' : 'model_id') ||
        context.req.param(type === 'group' ? 'groupId' : 'modelId'),
      type,
    )
    const table = type === 'group' ? 'account_groups' : 'account_models'
    const column = type === 'group' ? 'group_id' : 'model_id'
    const existing = await context.env.DB.prepare(
      `SELECT ${column} AS id FROM ${table} WHERE account_id = ? AND ${column} = ?`,
    ).bind(account.id, resourceId).first<{ id: string }>()
    if (existing === null) return controlSuccess(publicAccount(account))
    const now = Date.now()
    await mutateAccountRelation(
      context.env,
      account,
      context.env.DB.prepare(`DELETE FROM ${table} WHERE account_id = ? AND ${column} = ?`).bind(account.id, resourceId),
      now,
    )
    return controlSuccess(publicAccount(await requireAccount(context.env, account.id)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function mutateAccountRelation(
  env: Env,
  account: AccountRow,
  relationStatement: D1PreparedStatement,
  now: number,
): Promise<void> {
  await runAccountBatch(env, [
    accountCasStatement(env, account.id, account.control_version, {
      name: account.name,
      enabled: account.enabled === 1,
      max_concurrency: account.max_concurrency,
      base_url: account.base_url,
      provider_config: parseProviderConfigProjection(account.provider_config_json),
      config_version: incrementVersion(account.config_version, 'config_version'),
      control_version: incrementVersion(account.control_version, 'control_version'),
      now,
      reset_health: false,
    }),
    relationStatement,
  ], account.id, account.control_version)
}

function accountCasStatement(
  env: Env,
  accountId: string,
  expectedControlVersion: number,
  value: {
    name: string
    enabled: boolean
    max_concurrency: number
    base_url: string
    provider_config: ProviderConfig
    config_version: number
    control_version: number
    now: number
    reset_health: boolean
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE accounts
        SET name = ?, enabled = ?, max_concurrency = ?, base_url = ?, provider_config_json = ?,
            config_version = ?,
            control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
            health_status = CASE WHEN ? = 1 THEN 'unknown' ELSE health_status END,
            last_checked_at_ms = CASE WHEN ? = 1 THEN NULL ELSE last_checked_at_ms END,
            last_latency_ms = CASE WHEN ? = 1 THEN NULL ELSE last_latency_ms END,
            last_health_error = CASE WHEN ? = 1 THEN NULL ELSE last_health_error END,
            updated_at_ms = ?
      WHERE id = ?`,
  ).bind(
    value.name,
    value.enabled ? 1 : 0,
    value.max_concurrency,
    value.base_url,
    JSON.stringify(value.provider_config),
    value.config_version,
    expectedControlVersion,
    value.control_version,
    value.reset_health ? 1 : 0,
    value.reset_health ? 1 : 0,
    value.reset_health ? 1 : 0,
    value.reset_health ? 1 : 0,
    value.now,
    accountId,
  )
}

async function runAccountBatch(
  env: Env,
  statements: D1PreparedStatement[],
  accountId: string,
  expectedControlVersion: number,
): Promise<void> {
  try {
    await env.DB.batch(statements)
  } catch (error) {
    const current = await findAccount(env, accountId)
    if (current !== null && current.control_version !== expectedControlVersion) {
      throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
    }
    throw mapAccountWriteError(error)
  }
}

function parseCreateAccount(body: Record<string, unknown>): CreateAccountInput {
  rejectUnknownFields(body, CREATE_ACCOUNT_FIELDS)
  const platform = body.platform === undefined ? 'openai' : requireProviderPlatform(body.platform)
  const contract = providerContract(platform)
  const protocol = body.protocol === undefined
    ? contract.protocol
    : requireProviderProtocol(body.protocol)
  const authScheme = body.auth_scheme === undefined
    ? contract.auth_scheme
    : requireProviderAuthScheme(body.auth_scheme)
  if (protocol !== contract.protocol || authScheme !== contract.auth_scheme) {
    throw new GatewayError(
      409,
      'provider_contract_mismatch',
      'platform, protocol, and auth_scheme must use a supported provider contract',
    )
  }
  const baseUrl = normalizeBaseUrl(requireString(body, 'base_url', 2_048))
  const enabled = parseEnabledBody(body, true)
  validateAccountType(body)
  return {
    name: requireString(body, 'name', 128),
    platform,
    protocol,
    base_url: baseUrl,
    auth_scheme: authScheme,
    provider_config: parseProviderConfig(body.provider_config, platform),
    api_key: requireProviderCredential(body, 'api_key'),
    enabled,
    max_concurrency: body.max_concurrency === undefined
      ? 4
      : requireSafeInteger(body, 'max_concurrency', 1, 1_000),
    group_links: parseGroupLinks(body.group_links),
    model_capabilities: parseModelCapabilities(body.model_capabilities),
  }
}

function parseAccountPatch(body: Record<string, unknown>, account: AccountRow): AccountPatch {
  rejectUnknownFields(body, UPDATE_ACCOUNT_FIELDS)
  validateAccountType(body)
  assertImmutableProviderField(body.platform, account.platform, 'platform', requireProviderPlatform)
  assertImmutableProviderField(body.protocol, account.protocol, 'protocol', requireProviderProtocol)
  assertImmutableProviderField(
    body.auth_scheme,
    account.auth_scheme,
    'auth_scheme',
    requireProviderAuthScheme,
  )
  const patch: AccountPatch = {}
  if (body.name !== undefined) patch.name = requireString(body, 'name', 128)
  if (body.base_url !== undefined) patch.base_url = normalizeBaseUrl(requireString(body, 'base_url', 2_048))
  if (body.api_key !== undefined) patch.api_key = requireProviderCredential(body, 'api_key')
  if (body.provider_config !== undefined) {
    patch.provider_config = parseProviderConfig(body.provider_config, account.platform)
  }
  if (body.enabled !== undefined || body.status !== undefined) patch.enabled = parseEnabledBody(body, true)
  if (body.max_concurrency !== undefined) {
    patch.max_concurrency = requireSafeInteger(body, 'max_concurrency', 1, 1_000)
  }
  if (body.group_links !== undefined) patch.group_links = parseGroupLinks(body.group_links)
  if (body.model_capabilities !== undefined) {
    patch.model_capabilities = parseModelCapabilities(body.model_capabilities)
  }
  if (Object.keys(patch).length === 0) {
    throw new GatewayError(400, 'empty_account_update', 'Provide at least one account field to update')
  }
  return patch
}

const CREATE_ACCOUNT_FIELDS = new Set([
  'name', 'platform', 'protocol', 'base_url', 'auth_scheme', 'provider_config',
  'api_key', 'enabled', 'status', 'max_concurrency', 'group_links',
  'model_capabilities', 'type',
])
const UPDATE_ACCOUNT_FIELDS = new Set([
  ...CREATE_ACCOUNT_FIELDS,
  'control_version',
])

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unsupported = Object.keys(body).find((key) => !allowed.has(key))
  if (unsupported !== undefined) {
    throw new GatewayError(400, 'unsupported_account_field', `Field '${unsupported}' is not supported`)
  }
}

function validateAccountType(body: Record<string, unknown>): void {
  if (body.type !== undefined && body.type !== 'apikey') {
    throw new GatewayError(409, 'type_not_supported', 'Only apikey account type is supported')
  }
}

function requireProviderCredential(body: Record<string, unknown>, field: string): string {
  const value = requireString(body, field, 8_192)
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} contains an invalid control character`)
  }
  return value
}

function requireProviderPlatform(value: unknown): ProviderPlatform {
  if (value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'codex') {
    return value
  }
  throw new GatewayError(409, 'platform_not_supported', 'Supported platforms are openai, anthropic, gemini, and codex')
}

function requireProviderProtocol(value: unknown): ProviderProtocol {
  if (value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'codex') {
    return value
  }
  throw new GatewayError(409, 'protocol_not_supported', 'Provider protocol is not supported')
}

function requireProviderAuthScheme(value: unknown): ProviderAuthScheme {
  if (value === 'bearer' || value === 'x-api-key' || value === 'x-goog-api-key') return value
  throw new GatewayError(409, 'auth_scheme_not_supported', 'Provider authentication scheme is not supported')
}

function assertImmutableProviderField<T extends string>(
  raw: unknown,
  current: T,
  field: string,
  parse: (value: unknown) => T,
): void {
  if (raw !== undefined && parse(raw) !== current) {
    throw new GatewayError(409, 'provider_contract_immutable', `${field} cannot be changed after account creation`)
  }
}

function parseProviderConfig(value: unknown, platform: ProviderPlatform): ProviderConfig {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_provider_config', 'provider_config must be an object')
  }
  const raw = value as Record<string, unknown>
  const unsupported = Object.keys(raw).find((key) => key !== 'account_id')
  if (unsupported !== undefined) {
    throw new GatewayError(400, 'invalid_provider_config', `provider_config field '${unsupported}' is not supported`)
  }
  if (raw.account_id === undefined) return {}
  if (platform !== 'codex') {
    throw new GatewayError(400, 'invalid_provider_config', 'account_id is supported only for Codex')
  }
  const accountId = requireString(raw, 'account_id', 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(accountId)) {
    throw new GatewayError(400, 'invalid_provider_config', 'Codex account_id is invalid')
  }
  return { account_id: accountId }
}

function parseEnabledBody(body: Record<string, unknown>, fallback: boolean): boolean {
  if (body.enabled !== undefined && body.status !== undefined) {
    throw new GatewayError(400, 'ambiguous_status', 'Provide enabled or status, not both')
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new GatewayError(400, 'invalid_enabled', 'enabled must be a boolean')
    return body.enabled
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'inactive') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
    }
    return body.status === 'active'
  }
  return fallback
}

function parseEnabledQuery(enabled: string | undefined, status: string | undefined): boolean | undefined {
  if (enabled !== undefined && status !== undefined) {
    throw new GatewayError(400, 'ambiguous_status', 'Provide enabled or status, not both')
  }
  if (enabled !== undefined) {
    if (enabled !== 'true' && enabled !== 'false') {
      throw new GatewayError(400, 'invalid_enabled', 'enabled must be true or false')
    }
    return enabled === 'true'
  }
  if (status !== undefined) {
    if (status !== 'active' && status !== 'inactive') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
    }
    return status === 'active'
  }
  return undefined
}

function parseGroupLinks(value: unknown): GroupLinkInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 40) {
    throw new GatewayError(400, 'invalid_group_links', 'group_links must be an array with at most 40 entries')
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GatewayError(400, 'invalid_group_links', 'Each group link must be an object')
    }
    const link = parseGroupLink(entry as Record<string, unknown>)
    if (seen.has(link.group_id)) throw new GatewayError(400, 'duplicate_group_link', 'group_links contains a duplicate group')
    seen.add(link.group_id)
    return link
  })
}

function parseGroupLink(body: Record<string, unknown>, resourceId?: string): GroupLinkInput {
  const groupId = resourceId ?? requireResourceId(requireString(body, 'group_id', 128), 'group')
  return {
    group_id: groupId,
    priority: body.priority === undefined ? 0 : requireSafeInteger(body, 'priority', 0, 1_000_000),
    weight: body.weight === undefined ? 1 : requireSafeInteger(body, 'weight', 1, 1_000_000),
  }
}

function parseModelCapabilities(value: unknown): ModelCapabilityInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 40) {
    throw new GatewayError(400, 'invalid_model_capabilities', 'model_capabilities must be an array with at most 40 entries')
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GatewayError(400, 'invalid_model_capabilities', 'Each model capability must be an object')
    }
    const capability = parseModelCapability(entry as Record<string, unknown>)
    if (seen.has(capability.model_id)) {
      throw new GatewayError(400, 'duplicate_model_capability', 'model_capabilities contains a duplicate model')
    }
    seen.add(capability.model_id)
    return capability
  })
}

function parseModelCapability(body: Record<string, unknown>, resourceId?: string): ModelCapabilityInput {
  const modelId = resourceId ?? requireResourceId(requireString(body, 'model_id', 128), 'model')
  const chatCompletions = optionalBoolean(body, 'chat_completions') ?? true
  const responses = optionalBoolean(body, 'responses') ?? true
  const embeddings = optionalBoolean(body, 'embeddings')
  const imageGeneration = optionalBoolean(body, 'image_generation')
  if (!chatCompletions && !responses && !embeddings && !imageGeneration) {
    throw new GatewayError(400, 'invalid_model_capability', 'At least one endpoint capability must be enabled')
  }
  return {
    model_id: modelId,
    chat_completions: chatCompletions,
    responses,
    ...(embeddings === undefined ? {} : { embeddings }),
    ...(imageGeneration === undefined ? {} : { image_generation: imageGeneration }),
  }
}

function optionalBoolean(body: Record<string, unknown>, field: string, fallback?: boolean): boolean | undefined {
  if (body[field] === undefined) return fallback
  if (typeof body[field] !== 'boolean') throw new GatewayError(400, `invalid_${field}`, `${field} must be a boolean`)
  return body[field] as boolean
}

async function validateLinks(
  env: Env,
  platform: ProviderPlatform,
  groupLinks: GroupLinkInput[],
  modelCapabilities: ModelCapabilityInput[],
): Promise<void> {
  const groups = groupLinks.map((link) => link.group_id)
  const models = modelCapabilities.map((capability) => capability.model_id)
  const [groupCheck, modelCheck] = await Promise.all([
    groups.length === 0
      ? null
      : env.DB.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN platform = ? THEN 0 ELSE 1 END), 0) AS mismatched
           FROM "groups"
          WHERE id IN (${groups.map(() => '?').join(', ')})`,
      ).bind(platform, ...groups).first<{ total: number; mismatched: number }>(),
    models.length === 0
      ? null
      : env.DB.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN platform = ? THEN 0 ELSE 1 END), 0) AS mismatched
           FROM models
          WHERE id IN (${models.map(() => '?').join(', ')})`,
      ).bind(platform, ...models).first<{ total: number; mismatched: number }>(),
  ])
  assertLinkCheck(groupCheck, groups.length, 'group')
  assertLinkCheck(modelCheck, models.length, 'model')
}

function assertLinkCheck(
  result: { total: number; mismatched: number } | null,
  expected: number,
  resource: 'group' | 'model',
): void {
  if (expected === 0) return
  if (result === null || !Number.isSafeInteger(result.total) || !Number.isSafeInteger(result.mismatched)) {
    throw new GatewayError(500, `invalid_${resource}_link_projection`, `${resource} link validation is invalid`, 'server_error')
  }
  if (result.total !== expected) {
    throw new GatewayError(404, `${resource}_not_found`, `One or more ${resource} links were not found`)
  }
  if (result.mismatched !== 0) {
    throw new GatewayError(409, `${resource}_platform_mismatch`, `Account and ${resource} platforms must match`)
  }
}

function groupInsertStatements(env: Env, accountId: string, links: GroupLinkInput[], now: number): D1PreparedStatement[] {
  return links.map((link) => env.DB.prepare(
    `INSERT INTO account_groups (
       account_id, group_id, priority, weight, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(accountId, link.group_id, link.priority, link.weight, now, now))
}

function capabilityInsertStatements(
  env: Env,
  accountId: string,
  capabilities: ModelCapabilityInput[],
  now: number,
): D1PreparedStatement[] {
  return capabilities.map((capability) => env.DB.prepare(
    `INSERT INTO account_models (
       account_id, model_id, chat_completions, responses, embeddings, image_generation,
       created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    accountId,
    capability.model_id,
    capability.chat_completions ? 1 : 0,
    capability.responses ? 1 : 0,
    capability.embeddings ? 1 : 0,
    capability.image_generation ? 1 : 0,
    now,
    now,
  ))
}

async function requireAccount(env: Env, rawId: string | undefined): Promise<AccountRow> {
  const id = requireResourceId(rawId, 'account')
  const account = await findAccount(env, id)
  if (account === null) throw new GatewayError(404, 'account_not_found', 'Account was not found')
  requireSupportedAccount(account)
  return account
}

async function findAccount(env: Env, id: string): Promise<AccountRow | null> {
  return env.DB.prepare(`${ACCOUNT_PROJECTION} WHERE a.id = ?`).bind(id).first<AccountRow>()
}

function requireSupportedAccount(account: AccountRow): void {
  const platform = requireProviderPlatform(account.platform)
  const contract = providerContract(platform)
  if (account.protocol !== contract.protocol || account.auth_scheme !== contract.auth_scheme) {
    throw new GatewayError(409, 'account_not_supported', 'Account provider contract is not supported')
  }
  validateBaseUrl(account.base_url)
  parseProviderConfig(accountProviderConfig(account), platform)
}

function providerAccount(row: AccountRow): ProviderAccount {
  return {
    platform: row.platform,
    protocol: row.protocol,
    auth_scheme: row.auth_scheme,
    base_url: row.base_url,
    provider_config: accountProviderConfig(row),
  }
}

function accountProviderConfig(row: AccountRow): ProviderConfig {
  return parseProviderConfigProjection(row.provider_config_json)
}

function publicAccount(row: AccountRow) {
  const groups = parseProjectionArray<Record<string, unknown>>(row.group_links_json, 'group links')
    .map((value) => ({
      group_id: String(value.group_id),
      priority: Number(value.priority),
      weight: Number(value.weight),
      control_version: Number(value.control_version),
    }))
  const capabilities = parseProjectionArray<Record<string, unknown>>(row.model_capabilities_json, 'model capabilities')
    .map((value) => ({
      model_id: String(value.model_id),
      chat_completions: Number(value.chat_completions) === 1,
      responses: Number(value.responses) === 1,
      embeddings: Number(value.embeddings) === 1,
      image_generation: Number(value.image_generation) === 1,
      control_version: Number(value.control_version),
    }))
  return accountResponse({
    id: row.id,
    platform: row.platform,
    name: row.name,
    enabled: row.enabled === 1,
    max_concurrency: row.max_concurrency,
    protocol: row.protocol,
    base_url: row.base_url,
    auth_scheme: row.auth_scheme,
    provider_config: accountProviderConfig(row),
    config_version: row.config_version,
    control_version: row.control_version,
    health_status: row.health_status,
    last_checked_at_ms: row.last_checked_at_ms,
    last_latency_ms: row.last_latency_ms,
    last_health_error: row.last_health_error,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
    credential_key_version: row.key_version,
    group_links: groups,
    model_capabilities: capabilities,
  })
}

function accountResponse(value: {
  id: string
  platform: ProviderPlatform
  name: string
  enabled: boolean
  max_concurrency: number
  protocol: ProviderProtocol
  base_url: string
  auth_scheme: ProviderAuthScheme
  provider_config: ProviderConfig
  config_version: number
  control_version: number
  health_status: 'unknown' | 'healthy' | 'unhealthy'
  last_checked_at_ms: number | null
  last_latency_ms: number | null
  last_health_error: string | null
  created_at_ms: number
  updated_at_ms: number
  credential_key_version: number
  group_links: GroupLink[]
  model_capabilities: ModelCapability[]
}) {
  return {
    ...value,
    enabled: value.enabled,
    status: value.enabled ? 'active' as const : 'inactive' as const,
    credentials_status: { has_api_key: true },
  }
}

function parseProjectionArray<T>(raw: string, description: string): T[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('not an array')
    return value as T[]
  } catch {
    throw new GatewayError(500, 'invalid_account_projection', `Account ${description} projection is invalid`, 'server_error')
  }
}

function parseProviderConfigProjection(raw: string): ProviderConfig {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as ProviderConfig
  } catch {
    throw new GatewayError(500, 'invalid_account_projection', 'Account provider config projection is invalid', 'server_error')
  }
}

function assertVersion(account: AccountRow, expected: number): void {
  if (account.control_version !== expected) {
    throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
  }
}

function incrementVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, `${field}_exhausted`, `${field} is exhausted`)
  }
  return value + 1
}

function requireCredentialsMasterKey(env: Env): string {
  if (!env.CREDENTIALS_MASTER_KEY || env.CREDENTIALS_MASTER_KEY.length < 32) {
    throw new GatewayError(503, 'credential_secret_not_configured', 'Credential encryption secret is not configured', 'server_error')
  }
  return env.CREDENTIALS_MASTER_KEY
}

function normalizeBaseUrl(value: string): string {
  return validateBaseUrl(value).toString().replace(/\/$/, '')
}

function mapAccountWriteError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/UNIQUE constraint failed: accounts\.platform, accounts\.name/i.test(message)) {
    return new GatewayError(409, 'account_name_exists', 'An account with this name already exists')
  }
  if (/FOREIGN KEY constraint failed|invalid_account_(?:group|model)/i.test(message)) {
    return new GatewayError(409, 'account_link_conflict', 'Account links changed or are incompatible')
  }
  if (/CHECK constraint failed:.*control_version/i.test(message)) {
    return new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
  }
  return asGatewayError(error)
}

function invalidIdempotencyRecord(): GatewayError {
  return new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
}

function safeIdempotentAccount(
  row: Parameters<typeof parseIdempotentResponse>[0],
): ReturnType<typeof publicAccount> {
  const replay = parseIdempotentResponse<ReturnType<typeof publicAccount>>(row, 'account')
  if (row.resource_id !== replay.id || containsSensitiveCredentialField(replay)) {
    throw invalidIdempotencyRecord()
  }
  return replay
}

function containsSensitiveCredentialField(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSensitiveCredentialField)
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (['api_key', 'credential_ref', 'secret_id', 'nonce_b64', 'ciphertext_b64'].includes(key)) {
      return true
    }
    if (containsSensitiveCredentialField(nested)) return true
  }
  return false
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
