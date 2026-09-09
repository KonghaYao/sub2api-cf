import { wrapAntigravityRequest, antigravityDefaults, antigravityUserAgent, normalizeAntigravityResponse, type AntigravitySettings } from './antigravity'
import { GatewayError } from '../errors'
import { validateBaseUrl } from '../repository'

export type ProviderPlatform = 'openai' | 'anthropic' | 'gemini' | 'codex' | 'grok' | 'antigravity'
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'codex'
export type ProviderAuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key'
export type ProviderOperation =
  | 'models'
  | 'chat_completions'
  | 'responses'
  | 'responses_compact'
  | 'responses_input_tokens'
  | 'embeddings'
  | 'images_generations'
  | 'images_edits'
  | 'messages'
  | 'count_tokens'
  | 'generate_content'
  | 'stream_generate_content'

export interface ProviderConfig {
  project_id?: string
  use_default_base_url?: boolean
  account_id?: string
  /** OpenAI OAuth subscription tier used only by the account scheduler. */
  subscription_plan?: string
}

export interface ProviderAccount {
  antigravity_settings?: AntigravitySettings
  platform: ProviderPlatform
  protocol: ProviderProtocol
  auth_scheme: ProviderAuthScheme
  base_url: string
  provider_config: ProviderConfig
}

export interface ProviderCredential {
  api_key: string
}

export interface BuildProviderRequestInput {
  account: ProviderAccount
  credential: ProviderCredential
  operation: ProviderOperation
  model?: string
  body?: unknown
  /**
   * Deliberately accepted at the seam so callers cannot accidentally forward
   * client authentication, cookie, connection, or host headers. No inbound
   * header is trusted by default; OpenAI Chat and Responses use their separate
   * original allowlists. Provider authentication is rebuilt.
   */
  client_headers?: HeadersInit
}

export interface ProviderRequestPlan {
  response_adapter?: 'antigravity_sse' | 'antigravity_json'
  url: string
  method: 'GET' | 'POST'
  headers: Headers
  body?: unknown
  timeout_ms: number
}

interface ProviderContract {
  protocol: ProviderProtocol
  auth_scheme: ProviderAuthScheme
}

const CONTRACTS: Record<ProviderPlatform, ProviderContract> = {
  openai: { protocol: 'openai', auth_scheme: 'bearer' },
  grok: { protocol: 'openai', auth_scheme: 'bearer' },
  antigravity: { protocol: 'gemini', auth_scheme: 'bearer' },
  anthropic: { protocol: 'anthropic', auth_scheme: 'x-api-key' },
  gemini: { protocol: 'gemini', auth_scheme: 'x-goog-api-key' },
  codex: { protocol: 'codex', auth_scheme: 'bearer' },
}

const HEADER_TIMEOUT_MS = 30_000
// Allow compatible model catalogs to respond without exceeding the health
// consumer's 30-second processing lease. A timeout remains an unhealthy result.
const HEALTH_TIMEOUT_MS = 20_000
const CODEX_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CODEX_UNSUPPORTED_RESPONSE_FIELDS = [
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'chat_template_kwargs',
  'user',
  'metadata',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
  'truncation',
  'stop_sequences',
] as const

export function providerContract(platform: ProviderPlatform): ProviderContract {
  return CONTRACTS[platform]
}

// Match the original openaiAllowedHeaders. Raw Chat deliberately has a separate list.
const OPENAI_RESPONSES_HEADERS = ['accept-language', 'content-type', 'conversation_id', 'user-agent', 'originator', 'session_id', 'x-codex-beta-features', 'x-codex-installation-id', 'x-codex-turn-state', 'x-codex-turn-metadata', 'x-codex-window-id', 'x-openai-internal-codex-responses-lite'] as const

export function buildProviderRequest(input: BuildProviderRequestInput): ProviderRequestPlan {
  assertAccountContract(input.account)
  const credential = requireCredential(input.credential)

  if (input.account.platform === 'antigravity') return buildAntigravityPlan(input)
  const url = operationUrl(input.account, input.operation, input.model)
  const stream = input.operation === 'stream_generate_content' || bodyStreams(input.body)
  const headers = providerHeaders(input.account, credential, true, stream)
  if (input.account.platform === 'openai') {
    const clientHeaders = new Headers(input.client_headers)
    const allowed = input.operation === 'chat_completions' ? ['accept-language', 'user-agent']
      : input.operation === 'responses' || input.operation === 'responses_compact' ? OPENAI_RESPONSES_HEADERS : []
    for (const name of allowed) {
      const value = clientHeaders.get(name)
      if (value !== null) headers.set(name, value)
    }
  }
  const providerRequestBody = input.body === undefined
    ? undefined
    : providerBody(input.account, input.operation, input.body)
  const nativeCompactionV2 = input.operation === 'responses' &&
    isNativeCompactionV2Body(providerRequestBody)
  if (nativeCompactionV2) headers.set('x-codex-beta-features', 'remote_compaction_v2')
  return {
    url,
    method: input.operation === 'models' ? 'GET' : 'POST',
    headers,
    ...(providerRequestBody === undefined
      ? {}
      : { body: nativeCompactionV2 ? normalizeCompactionTriggerInput(providerRequestBody) : providerRequestBody }),
    timeout_ms: HEADER_TIMEOUT_MS,
  }
}

export function buildProviderHealthRequest(
  input: Pick<BuildProviderRequestInput, 'account' | 'credential'>,
): ProviderRequestPlan {
  assertAccountContract(input.account)
  const credential = requireCredential(input.credential)
  if (input.account.platform === 'antigravity') return { ...buildAntigravityPlan({...input, operation:'models'}), timeout_ms:HEALTH_TIMEOUT_MS }
  return {
    url: operationUrl(input.account, 'models'),
    method: 'GET',
    headers: providerHeaders(input.account, credential, false),
    timeout_ms: HEALTH_TIMEOUT_MS,
  }
}

function assertAccountContract(account: ProviderAccount): void {
  const contract = CONTRACTS[account.platform]
  if (contract === undefined) {
    throw new GatewayError(409, 'provider_not_supported', 'Upstream provider is not supported')
  }
  if (account.protocol !== contract.protocol || account.auth_scheme !== contract.auth_scheme) {
    throw new GatewayError(
      409,
      'provider_contract_mismatch',
      'Upstream provider protocol or authentication scheme is invalid',
    )
  }
  validateProviderConfig(account.platform, account.provider_config)
  validateBaseUrl(account.base_url)
}

function validateProviderConfig(platform: ProviderPlatform, config: ProviderConfig): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new GatewayError(400, 'invalid_provider_config', 'provider_config must be an object')
  }
  if (config.project_id !== undefined && (platform !== 'antigravity' || typeof config.project_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(config.project_id))) throw new GatewayError(400, 'invalid_provider_config', 'Antigravity project_id is invalid')
  if (platform === 'antigravity' && !config.project_id) throw new GatewayError(400, 'invalid_provider_config', 'Antigravity project_id is required')
  const keys = Object.keys(config)
  if (keys.some((key) => key !== 'account_id' && key !== 'subscription_plan' && key !== 'use_default_base_url' && key !== 'project_id')) {
    throw new GatewayError(400, 'invalid_provider_config', 'provider_config contains an unsupported field')
  }
  if (config.use_default_base_url !== undefined && (platform !== 'grok' || typeof config.use_default_base_url !== 'boolean')) throw new GatewayError(400, 'invalid_provider_config', 'use_default_base_url is supported only for Grok')
  if (platform !== 'codex' && config.account_id !== undefined) {
    throw new GatewayError(400, 'invalid_provider_config', 'account_id is supported only for Codex')
  }
  if (
    config.account_id !== undefined &&
    (typeof config.account_id !== 'string' || !CODEX_ACCOUNT_ID.test(config.account_id))
  ) {
    throw new GatewayError(400, 'invalid_provider_config', 'Codex account_id is invalid')
  }
  if (platform !== 'openai' && config.subscription_plan !== undefined) {
    throw new GatewayError(400, 'invalid_provider_config', 'subscription_plan is supported only for OpenAI')
  }
  if (
    config.subscription_plan !== undefined &&
    (typeof config.subscription_plan !== 'string' || config.subscription_plan.length === 0 || config.subscription_plan.length > 64)
  ) {
    throw new GatewayError(400, 'invalid_provider_config', 'OpenAI subscription_plan is invalid')
  }
}

function requireCredential(credential: ProviderCredential): string {
  const value = credential.api_key
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8_192 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GatewayError(503, 'credential_unavailable', 'Upstream account credential is unavailable', 'server_error')
  }
  return value
}

function providerHeaders(
  account: ProviderAccount,
  credential: string,
  hasBody: boolean,
  stream = false,
): Headers {
  const headers = new Headers({ accept: stream ? 'text/event-stream' : 'application/json' })
  if (hasBody) headers.set('content-type', 'application/json')
  switch (account.platform) {
    case 'antigravity':
    case 'grok':
    case 'openai':
      headers.set('authorization', `Bearer ${credential}`)
      break
    case 'anthropic':
      headers.set('x-api-key', credential)
      headers.set('anthropic-version', '2023-06-01')
      break
    case 'gemini':
      headers.set('x-goog-api-key', credential)
      break
    case 'codex':
      headers.set('authorization', `Bearer ${credential}`)
      headers.set('originator', 'codex_cli_rs')
      if (account.provider_config.account_id !== undefined) {
        headers.set('chatgpt-account-id', account.provider_config.account_id)
      }
      break
  }
  return headers
}

function operationUrl(
  account: ProviderAccount,
  operation: ProviderOperation,
  model?: string,
): string {
  const path = providerPath(account.platform, operation, model)
  const base = validateBaseUrl(account.base_url)
  const baseSegments = pathSegments(base.pathname)
  const wantedSegments = pathSegments(path.pathname)
  let overlap = Math.min(baseSegments.length, wantedSegments.length)
  while (
    overlap > 0 &&
    baseSegments.slice(-overlap).join('/') !== wantedSegments.slice(0, overlap).join('/')
  ) {
    overlap -= 1
  }
  base.pathname = `/${[...baseSegments, ...wantedSegments.slice(overlap)].join('/')}`
  base.search = path.search
  return base.toString()
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0)
}

function bodyStreams(body: unknown): boolean {
  return body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).stream === true
}

function isNativeCompactionV2Body(body: unknown): body is Record<string, unknown> {
  const record = objectRecord(body)
  return record?.stream === true &&
    Array.isArray(record.input) &&
    record.input.some((item) => objectRecord(item)?.type === 'compaction_trigger')
}

function normalizeCompactionTriggerInput(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input as unknown[]
  return {
    ...body,
    input: [
      ...input.filter((item) => objectRecord(item)?.type !== 'compaction_trigger'),
      { type: 'compaction_trigger' },
    ],
  }
}

function providerPath(
  platform: ProviderPlatform,
  operation: ProviderOperation,
  model?: string,
): { pathname: string; search: string } {
  switch (platform) {
    case 'antigravity':
      return unsupportedOperation(platform, operation)
    case 'grok':
    case 'openai':
      return openAiPath(operation)
    case 'anthropic':
      return anthropicPath(operation)
    case 'gemini':
      return geminiPath(operation, model)
    case 'codex':
      return codexPath(operation)
  }
}

function openAiPath(operation: ProviderOperation): { pathname: string; search: string } {
  const supported: Partial<Record<ProviderOperation, string>> = {
    models: '/v1/models',
    chat_completions: '/v1/chat/completions',
    responses: '/v1/responses',
    responses_compact: '/v1/responses/compact',
    responses_input_tokens: '/v1/responses/input_tokens',
    embeddings: '/v1/embeddings',
    images_generations: '/v1/images/generations',
    images_edits: '/v1/images/edits',
  }
  return supportedPath('openai', operation, supported)
}

function anthropicPath(operation: ProviderOperation): { pathname: string; search: string } {
  const supported: Partial<Record<ProviderOperation, string>> = {
    models: '/v1/models',
    messages: '/v1/messages',
    count_tokens: '/v1/messages/count_tokens',
  }
  return supportedPath('anthropic', operation, supported)
}

function geminiPath(
  operation: ProviderOperation,
  model?: string,
): { pathname: string; search: string } {
  if (operation === 'models') return { pathname: '/v1beta/models', search: '' }
  const actions: Partial<Record<ProviderOperation, string>> = {
    generate_content: 'generateContent',
    stream_generate_content: 'streamGenerateContent',
    count_tokens: 'countTokens',
    embeddings: 'embedContent',
  }
  const action = actions[operation]
  if (action === undefined) return unsupportedOperation('gemini', operation)
  if (typeof model !== 'string' || model.length === 0 || model.length > 512) {
    throw new GatewayError(400, 'invalid_upstream_model', 'A valid upstream model is required')
  }
  return {
    pathname: `/v1beta/models/${encodeURIComponent(model)}:${action}`,
    search: operation === 'stream_generate_content' ? '?alt=sse' : '',
  }
}

function codexPath(operation: ProviderOperation): { pathname: string; search: string } {
  const supported: Partial<Record<ProviderOperation, string>> = {
    models: '/backend-api/codex/models',
    responses: '/backend-api/codex/responses',
  }
  return supportedPath('codex', operation, supported)
}

function supportedPath(
  platform: ProviderPlatform,
  operation: ProviderOperation,
  supported: Partial<Record<ProviderOperation, string>>,
): { pathname: string; search: string } {
  const pathname = supported[operation]
  if (pathname === undefined) return unsupportedOperation(platform, operation)
  return { pathname, search: '' }
}

function unsupportedOperation(platform: ProviderPlatform, operation: ProviderOperation): never {
  throw new GatewayError(
    409,
    'provider_operation_not_supported',
    `${platform} does not support the ${operation} operation`,
  )
}

function providerBody(
  account: ProviderAccount,
  operation: ProviderOperation,
  body: unknown,
): unknown {
  if (account.platform !== 'codex' || operation !== 'responses') return body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new GatewayError(400, 'invalid_provider_body', 'Codex Responses body must be an object')
  }
  const normalized: Record<string, unknown> = {
    ...(body as Record<string, unknown>),
    store: false,
  }
  for (const key of CODEX_UNSUPPORTED_RESPONSE_FIELDS) delete normalized[key]
  normalizeCodexSystemInstructions(normalized)
  return normalized
}

function normalizeCodexSystemInstructions(body: Record<string, unknown>): void {
  const input = body.input
  const existingInstructions = typeof body.instructions === 'string' ? body.instructions : ''
  if (!Array.isArray(input)) {
    body.instructions = existingInstructions
    return
  }
  const textFormat = objectRecord(objectRecord(body.text)?.format)?.type
  const omitPromoted = textFormat !== 'json_object'
  const promoted: string[] = []
  const normalizedInput: unknown[] = []
  for (const value of input) {
    const item = objectRecord(value)
    if (item === null || item.role !== 'system') {
      normalizedInput.push(value)
      continue
    }
    const extracted = codexInstructionContent(item.content)
    if (extracted.text !== '') promoted.push(extracted.text)
    if (omitPromoted && extracted.lossless) continue
    normalizedInput.push({ ...item, role: 'developer' })
  }
  body.input = normalizedInput
  normalizeCodexToolCallIds(normalizedInput)
  body.instructions = promoted.length === 0
    ? existingInstructions
    : existingInstructions.trim() === ''
      ? promoted.join('\n\n')
      : `${promoted.join('\n\n')}\n\n${existingInstructions}`
}

function normalizeCodexToolCallIds(input: unknown[]): void {
  const referenceMappings = new Map<string, string>()
  const ambiguousReferences = new Set<string>()
  const rawCallIds = new Set<string>()
  const inputItemIds = new Set<string>()
  for (const value of input) {
    const item = objectRecord(value)
    const itemType = typeof item?.type === 'string' ? item.type.trim() : ''
    if (
      itemType !== 'item_reference' && itemType !== 'reasoning' &&
      typeof item?.id === 'string' && item.id.trim() !== '' &&
      !shouldStripCodexInputItemId(itemType, item.id.trim())
    ) {
      inputItemIds.add(item.id.trim())
    }
    const prefix = codexToolCallIdPrefix(itemType)
    if (item === null || prefix === null || typeof item.call_id !== 'string') continue
    const raw = item.call_id.trim()
    if (raw === '') continue
    rawCallIds.add(raw)
    const normalized = normalizedCodexToolCallId(raw, prefix)
    const existing = referenceMappings.get(raw)
    if (existing !== undefined && existing !== normalized) {
      referenceMappings.delete(raw)
      ambiguousReferences.add(raw)
    } else if (!ambiguousReferences.has(raw)) {
      referenceMappings.set(raw, normalized)
    }
  }

  for (let index = 0; index < input.length; index += 1) {
    const item = objectRecord(input[index])
    const itemType = typeof item?.type === 'string' ? item.type.trim() : ''
    const prefix = codexToolCallIdPrefix(itemType)
    if (item === null) continue
    if (itemType === 'reasoning') {
      const normalized = { ...item }
      delete normalized.id
      delete normalized.call_id
      if (normalized.summary === undefined || normalized.summary === null) normalized.summary = []
      input[index] = normalized
      continue
    }
    if (prefix !== null) {
      const normalized: Record<string, unknown> = { ...item }
      let rawCallId = typeof item.call_id === 'string' ? item.call_id.trim() : ''
      if (rawCallId === '' && typeof item.id === 'string' && item.id.trim() !== '') {
        rawCallId = item.id.trim()
      }
      if (rawCallId !== '') normalized.call_id = normalizedCodexToolCallId(rawCallId, prefix)
      if (codexInputItemRequiresName(itemType) && !nonEmptyRecordString(item.name)) {
        normalized.name = nonEmptyRecordString(item.tool_name) ??
          nonEmptyRecordString(objectRecord(item.function)?.name) ??
          'tool'
      }
      if (typeof normalized.id === 'string' && shouldStripCodexInputItemId(itemType, normalized.id)) {
        delete normalized.id
      }
      input[index] = normalized
      continue
    }
    if (itemType !== 'item_reference') {
      if ('call_id' in item || (typeof item.id === 'string' && shouldStripCodexInputItemId(itemType, item.id))) {
        const normalized = { ...item }
        delete normalized.call_id
        if (typeof item.id === 'string' && shouldStripCodexInputItemId(itemType, item.id)) {
          delete normalized.id
        }
        input[index] = normalized
      }
      continue
    }
    if (typeof item.id !== 'string') continue
    const raw = item.id.trim()
    if (!raw.startsWith('call_')) continue
    const normalized = inputItemIds.has(raw)
      ? undefined
      : referenceMappings.get(raw) ??
        (rawCallIds.has(raw) ? undefined : normalizedCodexToolCallId(raw, 'fc'))
    if (normalized !== undefined) input[index] = { ...item, id: normalized }
  }
}

function codexToolCallIdPrefix(value: unknown): 'fc' | 'ctc' | 'tsc' | null {
  if (value === 'custom_tool_call' || value === 'custom_tool_call_output') return 'ctc'
  if (value === 'tool_search_call' || value === 'tool_search_output') return 'tsc'
  if (
    value === 'function_call' || value === 'function_call_output' ||
    value === 'tool_call' || value === 'local_shell_call' ||
    value === 'mcp_tool_call' || value === 'mcp_tool_call_output'
  ) return 'fc'
  return null
}

function shouldStripCodexInputItemId(itemType: string, id: string): boolean {
  const requiredPrefix = codexInputItemIdPrefix(itemType)
  return requiredPrefix !== null && !id.startsWith(requiredPrefix)
}

function codexInputItemIdPrefix(itemType: string): string | null {
  switch (itemType) {
    case 'message': return 'msg'
    case 'reasoning': return 'rs'
    case 'web_search_call': return 'ws'
    case 'custom_tool_call': return 'ctc'
    case 'tool_search_call': return 'tsc'
    case 'function_call':
    case 'tool_call':
    case 'local_shell_call':
    case 'mcp_tool_call':
      return 'fc'
    default:
      return null
  }
}

function codexInputItemRequiresName(itemType: string): boolean {
  return itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'mcp_tool_call'
}

function nonEmptyRecordString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function normalizedCodexToolCallId(value: string, prefix: 'fc' | 'ctc' | 'tsc'): string {
  const knownPrefix = ['call_', 'fc_', 'ctc_', 'tsc_'].find((candidate) => value.startsWith(candidate))
  const suffix = knownPrefix === undefined ? value : value.slice(knownPrefix.length)
  const candidate = `${prefix}_${suffix}`
  return candidate.length <= 64 ? candidate : `${prefix}_${stableCodexCallIdDigest(candidate)}`
}

function stableCodexCallIdDigest(value: string): string {
  const mask = (1n << 64n) - 1n
  let left = 0xcbf29ce484222325n
  let right = 0x84222325cbf29ce4n
  for (let index = 0; index < value.length; index += 1) {
    const code = BigInt(value.charCodeAt(index))
    left = ((left ^ code) * 0x100000001b3n) & mask
    right = ((right ^ (code + BigInt(index))) * 0x100000001b3n) & mask
  }
  return left.toString(16).padStart(16, '0') + right.toString(16).padStart(16, '0')
}

function codexInstructionContent(value: unknown): { text: string; lossless: boolean } {
  if (typeof value === 'string') return { text: value, lossless: true }
  if (!Array.isArray(value)) return { text: '', lossless: false }
  let text = ''
  let lossless = true
  for (const valuePart of value) {
    const part = objectRecord(valuePart)
    const type = part?.type
    if (
      part !== null &&
      (type === 'text' || type === 'input_text' || type === 'output_text') &&
      typeof part.text === 'string'
    ) {
      text += part.text
    } else {
      lossless = false
    }
  }
  return { text, lossless }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function buildAntigravityPlan(input: BuildProviderRequestInput): ProviderRequestPlan {
  const { account, operation } = input
  const settings = account.antigravity_settings ?? antigravityDefaults
  const modelCatalog = operation === 'models'
  if (!modelCatalog && operation !== 'generate_content' && operation !== 'stream_generate_content') return unsupportedOperation(account.platform, operation)
  const url = validateBaseUrl(account.base_url)
  url.pathname = url.pathname.replace(/\/$/, '') + '/v1internal:' + (modelCatalog ? 'fetchAvailableModels' : 'streamGenerateContent')
  url.search = modelCatalog ? '' : '?alt=sse'
  const headers = new Headers({'authorization':'Bearer '+requireCredential(input.credential),'content-type':'application/json','user-agent':antigravityUserAgent(settings),'accept':modelCatalog?'application/json':'text/event-stream'})
  return {url:url.toString(),method:'POST',headers,body:modelCatalog?{project:account.provider_config.project_id}:wrapAntigravityRequest(account.provider_config.project_id!,input.model??'',input.body,settings),timeout_ms:HEADER_TIMEOUT_MS,...(modelCatalog?{}:{response_adapter:operation==='stream_generate_content'?'antigravity_sse' as const:'antigravity_json' as const})}
}
export async function normalizeProviderResponse(plan: ProviderRequestPlan, response: Response, signal?: AbortSignal): Promise<Response> {
  return plan.response_adapter ? normalizeAntigravityResponse(response, plan.response_adapter === 'antigravity_sse', signal) : response
}
