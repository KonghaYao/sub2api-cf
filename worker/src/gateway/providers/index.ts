import { GatewayError } from '../errors'
import { validateBaseUrl } from '../repository'

export type ProviderPlatform = 'openai' | 'anthropic' | 'gemini' | 'codex'
export type ProviderProtocol = ProviderPlatform
export type ProviderAuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key'
export type ProviderOperation =
  | 'models'
  | 'chat_completions'
  | 'responses'
  | 'responses_compact'
  | 'responses_input_tokens'
  | 'embeddings'
  | 'messages'
  | 'count_tokens'
  | 'generate_content'
  | 'stream_generate_content'

export interface ProviderConfig {
  account_id?: string
}

export interface ProviderAccount {
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
   * header is trusted by the provider layer; provider headers are rebuilt.
   */
  client_headers?: HeadersInit
}

export interface ProviderRequestPlan {
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
  anthropic: { protocol: 'anthropic', auth_scheme: 'x-api-key' },
  gemini: { protocol: 'gemini', auth_scheme: 'x-goog-api-key' },
  codex: { protocol: 'codex', auth_scheme: 'bearer' },
}

const HEADER_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 4_000
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

export function buildProviderRequest(input: BuildProviderRequestInput): ProviderRequestPlan {
  assertAccountContract(input.account)
  const credential = requireCredential(input.credential)
  // Read the value to make the security boundary intentional: no client header
  // is copied. The provider layer is the sole authority for upstream headers.
  void input.client_headers

  const url = operationUrl(input.account, input.operation, input.model)
  const stream = input.operation === 'stream_generate_content' || bodyStreams(input.body)
  const headers = providerHeaders(input.account, credential, true, stream)
  return {
    url,
    method: input.operation === 'models' ? 'GET' : 'POST',
    headers,
    ...(input.body === undefined ? {} : { body: providerBody(input.account, input.operation, input.body) }),
    timeout_ms: HEADER_TIMEOUT_MS,
  }
}

export function buildProviderHealthRequest(
  input: Pick<BuildProviderRequestInput, 'account' | 'credential'>,
): ProviderRequestPlan {
  assertAccountContract(input.account)
  const credential = requireCredential(input.credential)
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
  const keys = Object.keys(config)
  if (keys.some((key) => key !== 'account_id')) {
    throw new GatewayError(400, 'invalid_provider_config', 'provider_config contains an unsupported field')
  }
  if (platform !== 'codex' && config.account_id !== undefined) {
    throw new GatewayError(400, 'invalid_provider_config', 'account_id is supported only for Codex')
  }
  if (
    config.account_id !== undefined &&
    (typeof config.account_id !== 'string' || !CODEX_ACCOUNT_ID.test(config.account_id))
  ) {
    throw new GatewayError(400, 'invalid_provider_config', 'Codex account_id is invalid')
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

function providerPath(
  platform: ProviderPlatform,
  operation: ProviderOperation,
  model?: string,
): { pathname: string; search: string } {
  switch (platform) {
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
  normalizeCodexFunctionCallIds(normalizedInput)
  body.instructions = promoted.length === 0
    ? existingInstructions
    : existingInstructions.trim() === ''
      ? promoted.join('\n\n')
      : `${promoted.join('\n\n')}\n\n${existingInstructions}`
}

function normalizeCodexFunctionCallIds(input: unknown[]): void {
  const mappings = new Map<string, string>()
  for (const value of input) {
    const item = objectRecord(value)
    if (item === null || !isCodexFunctionCallItem(item.type) || typeof item.call_id !== 'string') {
      continue
    }
    const raw = item.call_id.trim()
    if (raw !== '' && !mappings.has(raw)) mappings.set(raw, normalizedCodexFunctionCallId(raw))
  }
  for (let index = 0; index < input.length; index += 1) {
    const item = objectRecord(input[index])
    if (item === null || !isCodexFunctionCallItem(item.type) || typeof item.call_id !== 'string') {
      continue
    }
    const normalized = mappings.get(item.call_id.trim())
    if (normalized !== undefined) input[index] = { ...item, call_id: normalized }
  }
}

function isCodexFunctionCallItem(value: unknown): boolean {
  return value === 'function_call' || value === 'function_call_output'
}

function normalizedCodexFunctionCallId(value: string): string {
  const suffix = value.startsWith('call_')
    ? value.slice('call_'.length)
    : value.startsWith('fc_')
      ? value.slice('fc_'.length)
      : value
  const candidate = `fc_${suffix}`
  return candidate.length <= 64 ? candidate : `fc_${stableCodexCallIdDigest(candidate)}`
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
