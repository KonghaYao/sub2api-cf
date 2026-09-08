import { resolveAccountRequestAuthentication } from './account-request-authentication'
import { applyAccountCredentialHeaders } from '../gateway/account-header-overrides'
export { applyAccountCredentialHeaders } from '../gateway/account-header-overrides'
import { isAccountModelPassthrough } from '../gateway/account-model-policy'
import type { Context } from 'hono'
import type { Env } from '../env'
import { decryptCredentialPayload } from '../gateway/crypto'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { credentialAad, validateBaseUrl } from '../gateway/repository'
import { buildProviderRequest, providerContract, type ProviderAccount, type ProviderPlatform } from '../gateway/providers'
import { controlError, controlSuccess, readJsonObject, requireResourceId, requireString } from './http'
import { DEFAULT_ACCOUNT_MODELS } from './account-model-defaults'

type Bindings = { Bindings: Env }
type Json = Record<string, unknown>
interface Account extends ProviderAccount {
  id: string
  credential_kind: string
  credential_ref: string
  control_version: number
  config_version: number
  ui_config_json: string
}
interface Metadata {
  id: string
  display_name?: string
  description?: string
  reasoning?: boolean
  default_reasoning_level?: string
  supported_reasoning_levels?: string[]
  input_modalities?: string[]
  context_window?: number
  max_output_tokens?: number
}
interface Catalog { models: string[]; metadata: Record<string, Metadata>; warnings?: Array<{ code: string; message: string }> }
const BODY_LIMIT = 8 * 1024 * 1024
const REGISTRY_URL = 'https://models.dev/api.json'
const REGISTRY_KEY = 'upstream-model-registry:v1'
const DEFAULT_BASES = { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com', codex: 'https://chatgpt.com' }
// Original backend/internal/service/openai_gateway_service.go compiled fallback.
const CODEX_VERSION = '0.146.0'

function object(value: unknown): Json { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {} }
function str(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(str).filter(Boolean) : [] }
function parseConfig(value: string): Json {
  try { return object(JSON.parse(value)) } catch { throw new GatewayError(500, 'invalid_account_projection', 'Account configuration is invalid', 'server_error') }
}
async function account(env: Env, id: string): Promise<Account> {
  const row = await env.DB.prepare(`SELECT id, platform, protocol, auth_scheme, base_url,
    provider_config_json, credential_kind, credential_ref, control_version, config_version, ui_config_json
    FROM accounts WHERE id = ?`).bind(id).first<Account & { provider_config_json: string }>()
  if (!row) throw new GatewayError(404, 'account_not_found', 'Account was not found')
  return { ...row, provider_config: parseConfig(row.provider_config_json) }
}

export async function getAdminAccountModels(context: Context<Bindings>): Promise<Response> {
  try {
    const saved = await account(context.env, requireResourceId(context.req.param('id'), 'account'))
    const config = parseConfig(saved.ui_config_json)
    const extra = object(config.extra)
    const platform = saved.platform === 'codex' ? 'openai' : saved.platform
    const defaults = DEFAULT_ACCOUNT_MODELS[platform]
    if (!defaults) throw new GatewayError(400, 'provider_not_supported', 'Account model catalog is not available for this provider')
    const mapping = object(object(config.credentials).model_mapping)
    const bypass = isAccountModelPassthrough(platform, extra)
    const oauthDefault = platform !== 'openai' && saved.credential_kind !== 'api_key'
    const names = Object.keys(mapping).filter(name => str(name) !== '').sort()
    if (bypass || oauthDefault || names.length === 0) return controlSuccess(defaults)
    return controlSuccess(names.map(id => defaults.find(model => model.id === id) ?? {
      id, type: 'model', display_name: id, ...(platform === 'openai' ? { object: 'model' } : { created_at: '' }),
    }))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function syncAdminAccountModels(context: Context<Bindings>): Promise<Response> {
  try {
    let saved = await account(context.env, requireResourceId(context.req.param('id'), 'account'))
    let secret = await context.env.DB.prepare(`SELECT id, key_version, nonce_b64, ciphertext_b64
      FROM account_secrets WHERE id = ? AND account_id = ?`).bind(saved.credential_ref, saved.id)
      .first<{ id: string; key_version: number; nonce_b64: string; ciphertext_b64: string }>()
    if (!secret || !context.env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503, 'credential_unavailable', 'Account credentials are unavailable')
    let credentials = object(await decryptCredentialPayload(secret.nonce_b64, secret.ciphertext_b64,
      context.env.CREDENTIALS_MASTER_KEY, credentialAad(context.env.ENVIRONMENT, saved.id, secret.id, secret.key_version)))
    let authorization:string|undefined
    if(saved.platform==='openai' && saved.credential_kind==='oauth' && str(credentials.auth_mode).toLowerCase()==='agentidentity') {
      const auth=await resolveAccountRequestAuthentication(context.env,{account_id:saved.id,platform:'openai',credential_kind:'oauth',
        secret_id:secret.id,key_version:secret.key_version,nonce_b64:secret.nonce_b64,ciphertext_b64:secret.ciphertext_b64})
      credentials=object(auth.credential);authorization=auth.authorization
      saved=await account(context.env,saved.id)
      secret=await context.env.DB.prepare('SELECT id,key_version,nonce_b64,ciphertext_b64 FROM account_secrets WHERE id=? AND account_id=?')
        .bind(saved.credential_ref,saved.id).first<typeof secret>()
      if(!secret) throw new GatewayError(409,'account_changed','Account credentials changed during model synchronization')
    }
    const { catalog, source } = await syncCatalog(context.env, saved, credentials,authorization)
    if (!catalog.warnings && Object.keys(catalog.metadata).length > 0) {
      const snapshot = JSON.stringify({ source, synced_at: new Date().toISOString(), models: catalog.metadata })
      // Metadata is a runtime observation, not a user configuration edit. Preserve the
      // displayed CAS version and every unrelated field; reject a concurrent config/credential change.
      const result = await context.env.DB.prepare(`UPDATE accounts SET ui_config_json = json_set(
          ui_config_json, '$.extra', json_set(CASE WHEN json_type(ui_config_json, '$.extra') = 'object'
            THEN json_extract(ui_config_json, '$.extra') ELSE '{}' END, '$.upstream_model_metadata', json(?)))
        WHERE id = ? AND control_version = ? AND config_version = ? AND credential_ref = ?
          AND EXISTS (SELECT 1 FROM account_secrets WHERE id = ? AND key_version = ?)`)
        .bind(snapshot, saved.id, saved.control_version, saved.config_version, saved.credential_ref, secret.id, secret.key_version).run()
      if (result.meta.changes !== 1) throw new GatewayError(412, 'account_version_conflict', 'Account changed during model synchronization; reload and retry')
    }
    return controlSuccess(catalog)
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function previewAdminAccountModels(context: Context<Bindings>): Promise<Response> {
  try {
    const body = await readJsonObject(context.req.raw, 128 * 1024)
    if (Object.keys(body).some(key => !['platform', 'type', 'base_url', 'api_key', 'model_mapping'].includes(key))) {
      throw new GatewayError(400, 'invalid_model_sync_request', 'Unknown model sync field')
    }
    const platform = requireString(body, 'platform', 32) as ProviderPlatform
    if (!Object.hasOwn(DEFAULT_BASES, platform)) throw new GatewayError(400, 'provider_not_supported', 'Account provider is not implemented')
    if (body.type !== 'apikey') throw new GatewayError(400, 'type_not_supported', 'Model preview requires API-key credentials')
    const baseUrl = str(body.base_url) || DEFAULT_BASES[platform]
    validateBaseUrl(baseUrl)
    validateMapping(body.model_mapping)
    const credentials = { api_key: requireString(body, 'api_key', 8192), model_mapping: body.model_mapping }
    const { catalog } = await syncCatalog(context.env, { platform, ...providerContract(platform),
      base_url: baseUrl, provider_config: {}, credential_kind: 'api_key' }, credentials)
    return controlSuccess(catalog)
  } catch (error) { return controlError(asGatewayError(error)) }
}

function validateMapping(value: unknown): void {
  if (value === undefined) return
  if (value === null || Array.isArray(value) || typeof value !== 'object' ||
      Object.entries(value).some(([key, mapped]) => !key.trim() || typeof mapped !== 'string' || key.length > 512 || mapped.length > 512)) {
    throw new GatewayError(400, 'invalid_model_mapping', 'model_mapping must map model names to strings')
  }
}

function applyModelHeaders(headers: Headers, saved: ProviderAccount & { credential_kind: string; ui_config_json?: string }, credentials: Json, token: string): void {
  headers.set('accept', 'application/json')
  if (saved.platform === 'anthropic') {
    const defaults = { 'user-agent': 'claude-cli/2.1.220 (external, cli)', 'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.94.0', 'x-stainless-os': 'Linux', 'x-stainless-arch': 'arm64',
      'x-stainless-runtime': 'node', 'x-stainless-runtime-version': 'v24.3.0', 'x-stainless-retry-count': '0',
      'x-stainless-timeout': '600', 'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true' }
    for (const [name, value] of Object.entries(defaults)) headers.set(name, value)
    headers.set('anthropic-beta', 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14')
    const extra = object(saved.ui_config_json ? parseConfig(saved.ui_config_json).extra : undefined)
    if (extra.anthropic_apikey_auth_scheme === 'authorization_bearer') {
      headers.delete('x-api-key')
      headers.set('authorization', `Bearer ${token}`)
    }
  }
  if (saved.credential_kind !== 'api_key' || !['openai', 'anthropic'].includes(saved.platform) || credentials.header_override_enabled !== true) return
  applyAccountCredentialHeaders(headers, credentials)
}


async function syncCatalog(env: Env, saved: ProviderAccount & { credential_kind: string; ui_config_json?: string }, credentials: Json,authorization?:string): Promise<{ catalog: Catalog; source: string }> {
  let upstream = saved
  const oauth = (saved.platform === 'openai' || saved.platform === 'codex') && saved.credential_kind !== 'api_key'
  const token = authorization ?? (oauth ? str(credentials.access_token) || (saved.platform === 'codex' ? str(credentials.api_key) : '') : str(credentials.api_key))
  if (!token) throw new GatewayError(400, 'credential_unavailable', 'No upstream credential is available for model synchronization')
  if (oauth && saved.platform === 'openai') upstream = {
    ...saved, platform: 'codex', ...providerContract('codex'), base_url: DEFAULT_BASES.codex,
    provider_config: str(credentials.chatgpt_account_id) ? { account_id: str(credentials.chatgpt_account_id) } : {},
  }
  const plan = buildProviderRequest({ account: upstream, credential: { api_key: token }, operation: 'models' })
  applyModelHeaders(plan.headers, saved, credentials, token)
  if(authorization) plan.headers.set('authorization',authorization)
  if (upstream.platform === 'codex') {
    const url = new URL(plan.url)
    url.searchParams.set('client_version', CODEX_VERSION)
    plan.url = url.toString()
    plan.headers.set('originator', 'codex-tui')
    plan.headers.set('user-agent', `codex-tui/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`)
    plan.headers.set('version', CODEX_VERSION)
  }
  let catalog: Catalog
  const proxyId = saved.ui_config_json ? parseConfig(saved.ui_config_json).proxy_id : undefined
  const proxy = proxyId == null || String(proxyId) === '0' ? undefined : String(proxyId)
  try {
    catalog = parseUpstreamCatalog(await fetchJson(plan.url, plan.headers, plan.timeout_ms,
      proxy ? (url, init) => fetchAccountProxy(env, proxy, new URL(url), init, init.signal!) : undefined))
  } catch (error) {
    // Only unavailable listing endpoints may fall back to concrete configured targets.
    const fallback = [...new Set(Object.values(object(credentials.model_mapping)).map(str).filter(name => name && !name.includes('*')))].sort()
    if (!(error instanceof UpstreamHttpError) || ![404, 405].includes(error.upstreamStatus) || !fallback.length) throw error
    catalog = { models: fallback, metadata: Object.create(null) }
  }
  let source = 'upstream'
  if (needsMetadata(catalog)) {
    try {
      const fallback = await registryMetadata(env, saved.base_url, catalog.models)
      for (const [id, fields] of Object.entries(fallback)) {
        const current = catalog.metadata[id] ?? { id }
        for (const [key, value] of Object.entries(fields)) {
          const old = (current as unknown as Json)[key]
          if (old === undefined || old === '' || (Array.isArray(old) && old.length === 0)) {
            ;(current as unknown as Json)[key] = value
            source = 'models.dev'
          }
        }
        catalog.metadata[id] = current
      }
    } catch { /* Enrichment failure must not lose a valid upstream model list. */ }
  }
  if (needsMetadata(catalog)) catalog.warnings = [{ code: 'upstream_model_metadata_incomplete', message: 'Model IDs were synced, but capability metadata is incomplete.' }]
  return { catalog, source }
}

class UpstreamHttpError extends GatewayError {
  constructor(readonly upstreamStatus: number) {
    super(502, 'upstream_model_sync_failed', `Upstream model list request failed with HTTP ${upstreamStatus}`, 'api_error')
  }
}
async function fetchJson(url: string, headers: Headers, timeout: number,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<unknown> {
  const signal = AbortSignal.timeout(timeout)
  try {
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'manual', signal })
    if (!response.ok) { await response.body?.cancel(); throw new UpstreamHttpError(response.status) }
    if (!response.body) throw new Error('missing body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > BODY_LIMIT) { await reader.cancel(); throw new GatewayError(502, 'upstream_model_response_too_large', 'Upstream model response exceeds 8 MiB') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const result = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result))
  } catch (error) {
    if (signal.aborted) throw new GatewayError(504, 'upstream_model_sync_timeout', 'Upstream model synchronization timed out')
    if (error instanceof GatewayError) throw error
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new GatewayError(504, 'upstream_model_sync_timeout', 'Upstream model synchronization timed out')
    }
    throw new GatewayError(502, 'upstream_model_sync_failed', 'Failed to read a valid upstream model list')
  }
}

export function parseUpstreamCatalog(value: unknown): Catalog {
  const root = object(value)
  const entries = Array.isArray(value) ? value : [...(Array.isArray(root.data) ? root.data : []), ...(Array.isArray(root.models) ? root.models : [])]
  const metadata: Record<string, Metadata> = Object.create(null)
  const names = new Set<string>()
  for (const raw of entries) {
    const entry = object(raw)
    const id = (str(entry.id) || str(entry.slug) || str(entry.name)).replace(/^models\//, '')
    if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) continue
    names.add(id)
    const fields = modelMetadata(id, entry)
    if (Object.keys(fields).length > 1) metadata[id] = fields
  }
  if (!names.size) throw new GatewayError(502, 'upstream_models_empty', 'Upstream returned no supported models')
  return { models: [...names].sort(), metadata }
}
function reasoningLevel(value: unknown): string {
  let level = str(value).toLowerCase()
  if (level === 'off' || level === 'disabled') level = 'none'
  if (level === 'extra-high' || level === 'extra_high') level = 'xhigh'
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(level) ? level : ''
}
function modelMetadata(id: string, entry: Json): Metadata {
  const options = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : []
  const direct = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []
  const normalized = (items: unknown[]) => [...new Set(items.map(item => reasoningLevel(typeof item === 'string' ? item : object(item).effort)).filter(Boolean))]
  let levels = normalized(direct)
  if (!levels.length) levels = normalized(options.flatMap(option => Array.isArray(object(option).values) ? object(option).values as unknown[] : []))
  const rawModalities = strings(entry.input_modalities).length ? strings(entry.input_modalities) : strings(object(entry.modalities).input)
  const modalities = [...new Set(rawModalities.map(value => value.toLowerCase()).filter(value => ['text', 'image'].includes(value)))]
  const reasoning = typeof entry.reasoning === 'boolean' ? entry.reasoning : levels.length ? !(levels.length === 1 && levels[0] === 'none') : undefined
  const name = str(entry.display_name) || str(entry.displayName) || (str(entry.name) !== id ? str(entry.name) : '')
  const context = positive(entry.context_window) ?? positive(entry.max_context_window) ?? positive(object(entry.limit).context) ?? positive(entry.inputTokenLimit)
  const output = positive(entry.max_output_tokens) ?? positive(object(entry.limit).output) ?? positive(entry.outputTokenLimit)
  const defaultLevel = reasoningLevel(entry.default_reasoning_level) || levels[0]
  return { id, ...(name ? { display_name: name } : {}), ...(str(entry.description) ? { description: str(entry.description) } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}), ...(defaultLevel ? { default_reasoning_level: defaultLevel } : {}),
    ...(levels.length ? { supported_reasoning_levels: levels } : {}), ...(modalities.length ? { input_modalities: modalities } : {}),
    ...(context ? { context_window: context } : {}), ...(output ? { max_output_tokens: output } : {}) }
}
function needsMetadata(catalog: Catalog): boolean {
  return catalog.models.some(id => {
    const model = catalog.metadata[id]
    return !model || model.reasoning === undefined || !model.input_modalities?.length || !model.context_window ||
      (model.reasoning && !model.supported_reasoning_levels?.length)
  })
}
function registryBase(value: unknown): string {
  try { const url = new URL(str(value)); return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '').replace(/\/models$/i, '')}` } catch { return '' }
}
async function registryMetadata(env: Env, baseUrl: string, models: string[]): Promise<Record<string, Metadata>> {
  let registry: Json | null = null
  try { registry = await env.CONFIG_KV.get<Json>(REGISTRY_KEY, 'json') } catch { /* optional cache */ }
  if (!registry) {
    registry = object(await fetchJson(REGISTRY_URL, new Headers({ accept: 'application/json' }), 10_000))
    try { await env.CONFIG_KV.put(REGISTRY_KEY, JSON.stringify(registry), { expirationTtl: 6 * 3600 }) } catch { /* cache does not affect the result */ }
  }
  const base = registryBase(baseUrl)
  const candidates = Object.values(registry).map(object).filter(provider => {
    const api = registryBase(provider.api)
    return api && (base === api || base.startsWith(`${api}/`) || api.startsWith(`${base}/`))
  }).sort((a, b) => registryBase(b.api).length - registryBase(a.api).length)
  const entries = object(candidates[0]?.models)
  const result: Record<string, Metadata> = Object.create(null)
  for (const id of models) {
    const entry = entries[id] ?? Object.entries(entries).find(([key, model]) => key.toLowerCase() === id.toLowerCase() || str(object(model).id).toLowerCase() === id.toLowerCase())?.[1]
    if (entry) result[id] = modelMetadata(id, { ...object(entry), display_name: object(entry).name })
  }
  return result
}
