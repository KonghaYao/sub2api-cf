/**
 * Stateless Gemini generateContent codecs plus a small stateful SSE adapter.
 *
 * The gateway owns authentication and HTTP routing. This module only validates
 * protocol payloads and translates their public wire shapes, so it is safe to
 * use in a Cloudflare Worker without Node.js compatibility APIs.
 */

export type JsonObject = Record<string, unknown>

export interface GeminiPart extends JsonObject {
  text?: string
  inlineData?: { mimeType: string; data: string }
  fileData?: { mimeType: string; fileUri: string }
  functionCall?: { name: string; args: JsonObject }
  functionResponse?: { name: string; response: JsonObject }
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiGenerateContentBody extends JsonObject {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig?: JsonObject
  tools?: Array<{ functionDeclarations: JsonObject[] }>
  toolConfig?: JsonObject
}

export interface GeminiRequestConversion {
  /** The model supplied by the client and returned in the client protocol. */
  clientModel: string
  /** A validated bare Gemini model name, suitable for URL path construction. */
  model: string
  stream: boolean
  body: GeminiGenerateContentBody
}

export interface GeminiConversionOptions {
  mappedModel?: string
}

export interface GeminiResponseContext {
  model: string
  id?: string
  createdAt?: number
}

export interface OpenAIChatCompletion extends JsonObject {
  choices: Array<{
    index: number
    message: JsonObject
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls'
  }>
}

export interface GeminiSseOptions extends GeminiResponseContext {
  target: 'chat_completions' | 'responses'
  includeUsage?: boolean
}

export interface GeminiSseFrame {
  event?: string
  data: unknown | '[DONE]'
}

export interface MappedGeminiError {
  status: number
  error: {
    message: string
    type: string
    code: string
  }
}

export class GeminiCodecError extends Error {
  readonly status = 400
  readonly code = 'invalid_request_error'

  constructor(message: string) {
    super(message)
    this.name = 'GeminiCodecError'
  }
}

const IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new GeminiCodecError(`${label} must be an object`)
  return value
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GeminiCodecError(`${label} is required`)
  }
  return value.trim()
}

/** Strip the optional REST prefix and reject path/query injection. */
export function normalizeGeminiModelName(value: unknown): string {
  let model = requireNonEmptyString(value, 'model')
  if (model.startsWith('models/')) model = model.slice('models/'.length)
  if (!MODEL_NAME.test(model) || model === '.' || model === '..') {
    throw new GeminiCodecError('model contains invalid characters')
  }
  return model
}

function finiteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GeminiCodecError(`${label} must be a finite number`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GeminiCodecError(`${label} must be a positive integer`)
  }
  return value
}

function asStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || values.some((item) => typeof item !== 'string')) {
    throw new GeminiCodecError(`${label} must be a string or string array`)
  }
  return values as string[]
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  if (value === undefined || value === null || value === '') return {}
  if (isObject(value)) return value
  if (typeof value !== 'string') throw new GeminiCodecError(`${label} must be a valid JSON object`)
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isObject(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new GeminiCodecError(`${label} must be a valid JSON object`)
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) return ''
    return JSON.stringify(value)
  }
  let result = ''
  for (const item of value) {
    if (typeof item === 'string') {
      result += item
      continue
    }
    if (!isObject(item)) continue
    if (
      (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') &&
      typeof item.text === 'string'
    ) {
      result += item.text
    }
  }
  return result
}

function parseDataImage(url: string): GeminiPart | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url)
  if (!match || !match[1] || !match[2] || match[2].length % 4 !== 0) return undefined
  return { inlineData: { mimeType: match[1], data: match[2] } }
}

function imagePart(value: unknown): GeminiPart | undefined {
  const image = typeof value === 'string' ? value : isObject(value) ? value.url : undefined
  if (typeof image !== 'string' || image.trim() === '') return undefined
  const url = image.trim()
  if (url.startsWith('data:')) {
    const parsed = parseDataImage(url)
    if (!parsed) throw new GeminiCodecError('image_url contains an invalid data URL')
    return parsed
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GeminiCodecError('image_url must be an absolute URL or base64 data URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GeminiCodecError('image_url uses an unsupported protocol')
  }
  return { fileData: { mimeType: 'image/*', fileUri: parsed.toString() } }
}

function openAIContentParts(value: unknown): GeminiPart[] {
  if (typeof value === 'string') return [{ text: value }]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new GeminiCodecError('message content must be a string or array')

  const parts: GeminiPart[] = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      parts.push({ text: raw })
      continue
    }
    if (!isObject(raw)) continue
    const type = raw.type
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      if (typeof raw.text !== 'string') throw new GeminiCodecError(`${String(type)}.text must be a string`)
      parts.push({ text: raw.text })
    } else if (type === 'image_url' || type === 'input_image') {
      const part = imagePart(type === 'image_url' ? raw.image_url : raw.image_url)
      if (part) parts.push(part)
    } else {
      parts.push({ text: JSON.stringify(raw) })
    }
  }
  return parts
}

function appendContent(contents: GeminiContent[], role: 'user' | 'model', parts: GeminiPart[]): void {
  if (parts.length === 0) return
  const previous = contents.at(-1)
  if (previous?.role === role) previous.parts.push(...parts)
  else contents.push({ role, parts })
}

function convertTools(value: unknown, source: 'chat' | 'responses'): GeminiGenerateContentBody['tools'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new GeminiCodecError('tools must be an array')
  const declarations: JsonObject[] = []
  for (const raw of value) {
    if (!isObject(raw) || raw.type !== 'function') continue
    const fn = source === 'chat' ? requireObject(raw.function, 'tool.function') : raw
    const name = requireNonEmptyString(fn.name, 'tool function name')
    const parameters = fn.parameters === undefined ? { type: 'object', properties: {} } : requireObject(fn.parameters, 'tool parameters')
    declarations.push({
      name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters,
    })
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined
}

function convertToolChoice(value: unknown): JsonObject | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (value === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (value === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  if (!isObject(value)) throw new GeminiCodecError('tool_choice is invalid')

  const fn = value.type === 'function' && isObject(value.function) ? value.function : value
  const name = requireNonEmptyString(fn.name, 'tool_choice function name')
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } }
}

function chatGenerationConfig(request: JsonObject): JsonObject | undefined {
  const config: JsonObject = {}
  const maximum = positiveInteger(
    request.max_completion_tokens ?? request.max_tokens,
    'max_completion_tokens',
  )
  const temperature = finiteNumber(request.temperature, 'temperature')
  const topP = finiteNumber(request.top_p, 'top_p')
  const stop = asStringArray(request.stop, 'stop')
  if (maximum !== undefined) config.maxOutputTokens = maximum
  if (temperature !== undefined) config.temperature = temperature
  if (topP !== undefined) config.topP = topP
  if (stop !== undefined) config.stopSequences = stop
  return Object.keys(config).length > 0 ? config : undefined
}

function responsesGenerationConfig(request: JsonObject): JsonObject | undefined {
  const config: JsonObject = {}
  const maximum = positiveInteger(request.max_output_tokens, 'max_output_tokens')
  const temperature = finiteNumber(request.temperature, 'temperature')
  const topP = finiteNumber(request.top_p, 'top_p')
  if (maximum !== undefined) config.maxOutputTokens = maximum
  if (temperature !== undefined) config.temperature = temperature
  if (topP !== undefined) config.topP = topP
  return Object.keys(config).length > 0 ? config : undefined
}

function requestConversion(
  clientModelValue: unknown,
  mappedModel: string | undefined,
  stream: unknown,
  body: GeminiGenerateContentBody,
): GeminiRequestConversion {
  const clientModel = normalizeGeminiModelName(clientModelValue)
  const model = normalizeGeminiModelName(mappedModel ?? clientModel)
  if (stream !== undefined && typeof stream !== 'boolean') throw new GeminiCodecError('stream must be a boolean')
  return { clientModel, model, stream: stream === true, body }
}

export function convertChatCompletionsToGemini(
  input: unknown,
  options: GeminiConversionOptions = {},
): GeminiRequestConversion {
  const request = requireObject(input, 'request')
  if (!Array.isArray(request.messages)) throw new GeminiCodecError('messages must be an array')

  const contents: GeminiContent[] = []
  const systemParts: Array<{ text: string }> = []
  const callNames = new Map<string, string>()

  for (const raw of request.messages) {
    if (!isObject(raw)) continue
    if (raw.role !== 'assistant' || !Array.isArray(raw.tool_calls)) continue
    for (const rawCall of raw.tool_calls) {
      if (!isObject(rawCall) || !isObject(rawCall.function)) continue
      if (typeof rawCall.id === 'string' && typeof rawCall.function.name === 'string') {
        callNames.set(rawCall.id, rawCall.function.name)
      }
    }
  }

  for (const raw of request.messages) {
    const message = requireObject(raw, 'message')
    const role = requireNonEmptyString(message.role, 'message role')
    if (role === 'system' || role === 'developer') {
      const parts = openAIContentParts(message.content)
      for (const part of parts) if (typeof part.text === 'string') systemParts.push({ text: part.text })
      continue
    }
    if (role === 'assistant') {
      const parts = openAIContentParts(message.content)
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) throw new GeminiCodecError('tool_calls must be an array')
        for (const rawCall of message.tool_calls) {
          const call = requireObject(rawCall, 'tool call')
          const fn = requireObject(call.function, 'tool call function')
          const name = requireNonEmptyString(fn.name, 'tool call function name')
          parts.push({
            thoughtSignature:
              typeof call.thought_signature === 'string' && call.thought_signature.trim() !== ''
                ? call.thought_signature
                : GEMINI_FALLBACK_THOUGHT_SIGNATURE,
            functionCall: { name, args: parseJsonObject(fn.arguments, 'tool call arguments') },
          })
        }
      }
      appendContent(contents, 'model', parts)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      const name =
        (callId === '' ? undefined : callNames.get(callId)) ??
        (typeof message.name === 'string' && message.name.trim() !== '' ? message.name.trim() : 'tool')
      appendContent(contents, 'user', [
        { functionResponse: { name, response: { content: contentText(message.content) } } },
      ])
      continue
    }
    appendContent(contents, 'user', openAIContentParts(message.content))
  }

  const body: GeminiGenerateContentBody = { contents }
  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts }
  const tools = convertTools(request.tools, 'chat')
  if (tools) body.tools = tools
  const toolConfig = convertToolChoice(request.tool_choice ?? request.function_call)
  if (toolConfig) body.toolConfig = toolConfig
  const generationConfig = chatGenerationConfig(request)
  if (generationConfig) body.generationConfig = generationConfig
  return requestConversion(request.model, options.mappedModel, request.stream, body)
}

export function convertResponsesToGemini(
  input: unknown,
  options: GeminiConversionOptions = {},
): GeminiRequestConversion {
  const request = requireObject(input, 'request')
  const contents: GeminiContent[] = []
  const callNames = new Map<string, string>()
  const items = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input
  if (!Array.isArray(items)) throw new GeminiCodecError('input must be a string or array')

  for (const raw of items) {
    if (!isObject(raw) || raw.type !== 'function_call') continue
    const callId = typeof raw.call_id === 'string' ? raw.call_id : typeof raw.id === 'string' ? raw.id : ''
    if (callId !== '' && typeof raw.name === 'string') callNames.set(callId, raw.name)
  }

  for (const raw of items) {
    if (typeof raw === 'string') {
      appendContent(contents, 'user', [{ text: raw }])
      continue
    }
    const item = requireObject(raw, 'input item')
    if (item.type === 'function_call') {
      appendContent(contents, 'model', [
        {
          thoughtSignature:
            typeof item.thought_signature === 'string' && item.thought_signature.trim() !== ''
              ? item.thought_signature
              : GEMINI_FALLBACK_THOUGHT_SIGNATURE,
          functionCall: {
            name: requireNonEmptyString(item.name, 'function call name'),
            args: parseJsonObject(item.arguments, 'function call arguments'),
          },
        },
      ])
    } else if (item.type === 'function_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : ''
      appendContent(contents, 'user', [
        {
          functionResponse: {
            name: callNames.get(callId) ?? 'tool',
            response: { content: contentText(item.output) },
          },
        },
      ])
    } else {
      const role = item.role === 'assistant' ? 'model' : 'user'
      appendContent(contents, role, openAIContentParts(item.content))
    }
  }

  const body: GeminiGenerateContentBody = { contents }
  if (typeof request.instructions === 'string' && request.instructions !== '') {
    body.systemInstruction = { parts: [{ text: request.instructions }] }
  }
  const tools = convertTools(request.tools, 'responses')
  if (tools) body.tools = tools
  const toolConfig = convertToolChoice(request.tool_choice)
  if (toolConfig) body.toolConfig = toolConfig
  const generationConfig = responsesGenerationConfig(request)
  if (generationConfig) body.generationConfig = generationConfig
  return requestConversion(request.model, options.mappedModel, request.stream, body)
}

interface NormalizedUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  reasoningTokens: number
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function normalizeUsage(payload: JsonObject): NormalizedUsage {
  const metadata = isObject(payload.usageMetadata) ? payload.usageMetadata : {}
  const promptTokens = tokenCount(metadata.promptTokenCount)
  const reasoningTokens = tokenCount(metadata.thoughtsTokenCount)
  const completionTokens = tokenCount(metadata.candidatesTokenCount) + reasoningTokens
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens: tokenCount(metadata.cachedContentTokenCount),
    reasoningTokens,
  }
}

function chatUsage(usage: NormalizedUsage): JsonObject {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  }
}

function responsesUsage(usage: NormalizedUsage): JsonObject {
  return {
    input_tokens: usage.promptTokens,
    input_tokens_details: { cached_tokens: usage.cachedTokens },
    output_tokens: usage.completionTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.totalTokens,
  }
}

function responseId(prefix: 'chatcmpl' | 'resp', supplied?: string): string {
  if (supplied && supplied.trim() !== '') return supplied
  const random = crypto.randomUUID().replaceAll('-', '')
  return `${prefix}_${random}`
}

function createdAt(value?: number): number {
  return value === undefined ? Math.floor(Date.now() / 1_000) : Math.trunc(value)
}

function unwrapGeminiPayload(input: unknown): JsonObject {
  const payload = requireObject(input, 'Gemini response')
  return isObject(payload.response) ? payload.response : payload
}

function candidates(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.candidates)) return []
  return payload.candidates.filter(isObject)
}

function parts(candidate: JsonObject): JsonObject[] {
  if (!isObject(candidate.content) || !Array.isArray(candidate.content.parts)) return []
  return candidate.content.parts.filter(isObject)
}

function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

function partText(part: JsonObject): string {
  if (typeof part.text === 'string') return part.text
  if (isObject(part.inlineData)) {
    const mimeType = part.inlineData.mimeType
    const data = part.inlineData.data
    if (
      typeof mimeType === 'string' &&
      IMAGE_MIME_TYPES.has(mimeType) &&
      typeof data === 'string' &&
      validBase64(data)
    ) {
      return `![image](data:${mimeType};base64,${data})`
    }
  }
  return ''
}

function geminiFinishReason(payload: JsonObject): string {
  const first = candidates(payload)[0]
  return typeof first?.finishReason === 'string' ? first.finishReason.toUpperCase() : ''
}

function chatFinishReason(reason: string): 'stop' | 'length' | 'content_filter' {
  if (reason === 'MAX_TOKENS') return 'length'
  if (
    reason === 'SAFETY' ||
    reason === 'RECITATION' ||
    reason === 'BLOCKLIST' ||
    reason === 'PROHIBITED_CONTENT' ||
    reason === 'SPII' ||
    reason === 'IMAGE_SAFETY'
  ) {
    return 'content_filter'
  }
  return 'stop'
}

function responsesStatus(reason: string): {
  status: 'completed' | 'incomplete'
  incompleteDetails: JsonObject | null
} {
  if (reason === 'MAX_TOKENS') {
    return { status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } }
  }
  if (chatFinishReason(reason) === 'content_filter') {
    return { status: 'incomplete', incompleteDetails: { reason: 'content_filter' } }
  }
  return { status: 'completed', incompleteDetails: null }
}

function promptBlocked(payload: JsonObject): boolean {
  return isObject(payload.promptFeedback) && typeof payload.promptFeedback.blockReason === 'string'
}

function requireGeminiResult(payload: JsonObject): void {
  if (payload.error !== undefined) throw new GeminiCodecError('Gemini response contains an error')
  if (candidates(payload).length === 0 && !promptBlocked(payload) && payload.usageMetadata === undefined) {
    throw new GeminiCodecError('Gemini response must contain candidates')
  }
}

export function convertGeminiToChatCompletions(
  input: unknown,
  context: GeminiResponseContext,
): OpenAIChatCompletion {
  const payload = unwrapGeminiPayload(input)
  requireGeminiResult(payload)
  const id = responseId('chatcmpl', context.id)
  const reason = promptBlocked(payload) ? 'SAFETY' : geminiFinishReason(payload)
  const choices: OpenAIChatCompletion['choices'] = candidates(payload).map((candidate, candidateIndex) => {
    let text = ''
    const toolCalls: JsonObject[] = []
    for (const [partIndex, part] of parts(candidate).entries()) {
      text += partText(part)
      if (!isObject(part.functionCall)) continue
      const name =
        typeof part.functionCall.name === 'string' && part.functionCall.name.trim() !== ''
          ? part.functionCall.name.trim()
          : 'tool'
      const args = isObject(part.functionCall.args) ? part.functionCall.args : {}
      toolCalls.push({
        id: `call_${id}_${candidateIndex}_${partIndex}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      })
    }
    const message: JsonObject = { role: 'assistant', content: text === '' ? null : text }
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    return {
      index: candidateIndex,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : chatFinishReason(reason),
    }
  })
  if (choices.length === 0 && promptBlocked(payload)) {
    choices.push({ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' })
  }
  return {
    id,
    object: 'chat.completion',
    created: createdAt(context.createdAt),
    model: context.model,
    choices,
    usage: chatUsage(normalizeUsage(payload)),
  }
}

function responseOutput(payload: JsonObject, id: string): JsonObject[] {
  const output: JsonObject[] = []
  for (const [candidateIndex, candidate] of candidates(payload).entries()) {
    let text = ''
    for (const part of parts(candidate)) text += partText(part)
    if (text !== '') {
      output.push({
        id: `msg_${id}_${candidateIndex}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      })
    }
    for (const [partIndex, part] of parts(candidate).entries()) {
      if (!isObject(part.functionCall)) continue
      const name =
        typeof part.functionCall.name === 'string' && part.functionCall.name.trim() !== ''
          ? part.functionCall.name.trim()
          : 'tool'
      const args = isObject(part.functionCall.args) ? part.functionCall.args : {}
      output.push({
        id: `fc_${id}_${candidateIndex}_${partIndex}`,
        type: 'function_call',
        status: 'completed',
        call_id: `call_${id}_${candidateIndex}_${partIndex}`,
        name,
        arguments: JSON.stringify(args),
      })
    }
  }
  return output
}

export function convertGeminiToResponses(input: unknown, context: GeminiResponseContext): JsonObject {
  const payload = unwrapGeminiPayload(input)
  requireGeminiResult(payload)
  const id = responseId('resp', context.id)
  const reason = promptBlocked(payload) ? 'SAFETY' : geminiFinishReason(payload)
  const terminal = responsesStatus(reason)
  return {
    id,
    object: 'response',
    created_at: createdAt(context.createdAt),
    status: terminal.status,
    model: context.model,
    output: responseOutput(payload, id),
    usage: responsesUsage(normalizeUsage(payload)),
    error: null,
    incomplete_details: terminal.incompleteDetails,
  }
}

function safeGeminiMessage(payload: unknown): string {
  if (!isObject(payload) || !isObject(payload.error) || typeof payload.error.message !== 'string') {
    return 'Gemini upstream request failed'
  }
  const message = payload.error.message.trim()
  if (message === '' || message.length > 1_024 || /<\/?(?:html|script|body)\b/i.test(message)) {
    return 'Gemini upstream request failed'
  }
  return message
}

export function mapGeminiError(status: number, payload: unknown): MappedGeminiError {
  const upstreamStatus = isObject(payload) && isObject(payload.error) ? payload.error.status : undefined
  const semantic = typeof upstreamStatus === 'string' ? upstreamStatus.toUpperCase() : ''
  let mappedStatus = status >= 400 && status < 500 ? status : 502
  let type = 'upstream_error'
  let code = 'upstream_error'

  if (status === 400 || semantic === 'INVALID_ARGUMENT' || semantic === 'FAILED_PRECONDITION') {
    mappedStatus = 400
    type = 'invalid_request_error'
    code = 'invalid_request'
  } else if (status === 401 || semantic === 'UNAUTHENTICATED') {
    mappedStatus = 401
    type = 'authentication_error'
    code = 'invalid_api_key'
  } else if (status === 403 || semantic === 'PERMISSION_DENIED') {
    mappedStatus = 403
    type = 'permission_error'
    code = 'permission_denied'
  } else if (status === 404 || semantic === 'NOT_FOUND') {
    mappedStatus = 404
    type = 'not_found_error'
    code = 'model_not_found'
  } else if (status === 409 || semantic === 'ABORTED' || semantic === 'ALREADY_EXISTS') {
    mappedStatus = 409
    type = 'conflict_error'
    code = 'conflict'
  } else if (status === 429 || semantic === 'RESOURCE_EXHAUSTED') {
    mappedStatus = 429
    type = 'rate_limit_error'
    code = 'rate_limit_exceeded'
  } else if (status === 529 || semantic === 'UNAVAILABLE') {
    mappedStatus = 503
    type = 'overloaded_error'
    code = 'upstream_overloaded'
  }

  return { status: mappedStatus, error: { message: safeGeminiMessage(payload), type, code } }
}

function cumulativeDelta(seen: string, incoming: string): { delta: string; seen: string } {
  const clean = incoming.endsWith('\0') ? incoming.slice(0, -1) : incoming
  if (clean === '') return { delta: '', seen }
  if (clean.startsWith(seen)) return { delta: clean.slice(seen.length), seen: clean }
  if (seen.startsWith(clean)) return { delta: '', seen }
  return { delta: clean, seen: seen + clean }
}

interface StreamTool {
  name: string
  arguments: string
  callId: string
  itemId: string
  index: number
  started: boolean
  done: boolean
}

export class GeminiSseConverter {
  private readonly id: string
  private readonly timestamp: number
  private ended = false
  private started = false
  private chatRoleSent = false
  private finishReason = ''
  private usage: NormalizedUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  }
  private text = ''
  private responseMessageStarted = false
  private responseMessageDone = false
  private readonly tools = new Map<string, StreamTool>()
  private sequence = 0

  constructor(private readonly options: GeminiSseOptions) {
    normalizeGeminiModelName(options.model)
    this.id = responseId(options.target === 'responses' ? 'resp' : 'chatcmpl', options.id)
    this.timestamp = createdAt(options.createdAt)
  }

  push(input: unknown): GeminiSseFrame[] {
    if (this.ended) return []
    let payload: JsonObject
    try {
      payload = unwrapGeminiPayload(input)
    } catch {
      return this.fail(502, { error: { message: 'Failed to parse Gemini stream event' } })
    }
    if (payload.error !== undefined) {
      const errorStatus =
        isObject(payload.error) && typeof payload.error.code === 'number' ? payload.error.code : 502
      return this.fail(errorStatus, payload)
    }

    const frames: GeminiSseFrame[] = []
    if (this.options.target === 'responses' && !this.started) frames.push(...this.startResponses())
    if (this.options.target === 'chat_completions' && !this.chatRoleSent) {
      frames.push(this.chatChunk({ role: 'assistant', content: '' }, null))
      this.chatRoleSent = true
    }

    if (payload.usageMetadata !== undefined) this.usage = normalizeUsage(payload)
    const reason = geminiFinishReason(payload)
    if (reason !== '') this.finishReason = reason

    const firstCandidate = candidates(payload)[0]
    if (!firstCandidate) return frames
    for (const [partIndex, part] of parts(firstCandidate).entries()) {
      if (typeof part.text === 'string') {
        const next = cumulativeDelta(this.text, part.text)
        this.text = next.seen
        if (next.delta !== '') {
          if (this.options.target === 'chat_completions') {
            frames.push(this.chatChunk({ content: next.delta }, null))
          } else {
            frames.push(...this.responseTextDelta(next.delta))
          }
        }
      }
      if (isObject(part.functionCall)) {
        const name =
          typeof part.functionCall.name === 'string' && part.functionCall.name.trim() !== ''
            ? part.functionCall.name.trim()
            : 'tool'
        const key = `${name}:${partIndex}`
        let tool = this.tools.get(key)
        if (!tool) {
          const index = this.tools.size
          tool = {
            name,
            arguments: '',
            callId: `call_${this.id}_0_${index}`,
            itemId: `fc_${this.id}_0_${index}`,
            index,
            started: false,
            done: false,
          }
          this.tools.set(key, tool)
        }
        const incoming = JSON.stringify(isObject(part.functionCall.args) ? part.functionCall.args : {})
        const next = cumulativeDelta(tool.arguments, incoming)
        tool.arguments = next.seen
        if (this.options.target === 'chat_completions') {
          if (!tool.started || next.delta !== '') frames.push(this.chatToolDelta(tool, next.delta))
          tool.started = true
        } else {
          frames.push(...this.responseToolDelta(tool, next.delta))
        }
      }
    }
    return frames
  }

  fail(status: number, payload: unknown): GeminiSseFrame[] {
    if (this.ended) return []
    this.ended = true
    const mapped = mapGeminiError(status, payload)
    if (this.options.target === 'chat_completions') {
      return [{ data: { error: mapped.error } }, { data: '[DONE]' }]
    }
    const response = this.responseSnapshot('failed', mapped.error, null)
    return [this.responseFrame('response.failed', { response })]
  }

  finish(): GeminiSseFrame[] {
    if (this.ended) return []
    this.ended = true
    if (this.options.target === 'chat_completions') {
      const reason = this.tools.size > 0 ? 'tool_calls' : chatFinishReason(this.finishReason)
      const usage = this.options.includeUsage ? chatUsage(this.usage) : undefined
      return [this.chatChunk({}, reason, usage), { data: '[DONE]' }]
    }

    const frames: GeminiSseFrame[] = []
    if (!this.started) frames.push(...this.startResponses())
    frames.push(...this.closeResponseItems())
    const terminal = responsesStatus(this.finishReason)
    const response = this.responseSnapshot(terminal.status, null, terminal.incompleteDetails)
    const event = terminal.status === 'incomplete' ? 'response.incomplete' : 'response.completed'
    frames.push(this.responseFrame(event, { response }))
    return frames
  }

  private chatChunk(delta: JsonObject, finishReason: string | null, usage?: JsonObject): GeminiSseFrame {
    return {
      data: {
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.timestamp,
        model: this.options.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      },
    }
  }

  private chatToolDelta(tool: StreamTool, delta: string): GeminiSseFrame {
    const first = !tool.started
    return this.chatChunk(
      {
        tool_calls: [
          {
            index: tool.index,
            ...(first ? { id: tool.callId, type: 'function' } : {}),
            function: {
              ...(first ? { name: tool.name } : {}),
              arguments: delta,
            },
          },
        ],
      },
      null,
    )
  }

  private startResponses(): GeminiSseFrame[] {
    this.started = true
    return [
      this.responseFrame('response.created', {
        response: this.responseSnapshot('in_progress', null, null),
      }),
      this.responseFrame('response.in_progress', {
        response: this.responseSnapshot('in_progress', null, null),
      }),
    ]
  }

  private responseTextDelta(delta: string): GeminiSseFrame[] {
    const frames: GeminiSseFrame[] = []
    const item = this.messageItem('in_progress')
    if (!this.responseMessageStarted) {
      this.responseMessageStarted = true
      frames.push(this.responseFrame('response.output_item.added', { output_index: 0, item }))
      frames.push(
        this.responseFrame('response.content_part.added', {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      )
    }
    frames.push(
      this.responseFrame('response.output_text.delta', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta,
      }),
    )
    return frames
  }

  private responseToolDelta(tool: StreamTool, delta: string): GeminiSseFrame[] {
    const frames: GeminiSseFrame[] = []
    if (!tool.started) {
      if (this.responseMessageStarted && !this.responseMessageDone) frames.push(...this.closeResponseMessage())
      tool.started = true
      frames.push(
        this.responseFrame('response.output_item.added', {
          output_index: this.toolOutputIndex(tool),
          item: this.toolItem(tool, 'in_progress'),
        }),
      )
    }
    if (delta !== '') {
      frames.push(
        this.responseFrame('response.function_call_arguments.delta', {
          item_id: tool.itemId,
          output_index: this.toolOutputIndex(tool),
          delta,
        }),
      )
    }
    return frames
  }

  private closeResponseItems(): GeminiSseFrame[] {
    const frames = this.closeResponseMessage()
    for (const tool of this.tools.values()) {
      if (!tool.started || tool.done) continue
      tool.done = true
      frames.push(
        this.responseFrame('response.function_call_arguments.done', {
          item_id: tool.itemId,
          output_index: this.toolOutputIndex(tool),
          arguments: tool.arguments,
        }),
      )
      frames.push(
        this.responseFrame('response.output_item.done', {
          output_index: this.toolOutputIndex(tool),
          item: this.toolItem(tool, 'completed'),
        }),
      )
    }
    return frames
  }

  private closeResponseMessage(): GeminiSseFrame[] {
    if (!this.responseMessageStarted || this.responseMessageDone) return []
    this.responseMessageDone = true
    const item = this.messageItem('completed')
    return [
      this.responseFrame('response.output_text.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: this.text,
      }),
      this.responseFrame('response.content_part.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: this.text, annotations: [] },
      }),
      this.responseFrame('response.output_item.done', { output_index: 0, item }),
    ]
  }

  private messageItem(status: 'in_progress' | 'completed'): JsonObject {
    return {
      id: `msg_${this.id}_0`,
      type: 'message',
      status,
      role: 'assistant',
      content:
        status === 'completed' ? [{ type: 'output_text', text: this.text, annotations: [] }] : [],
    }
  }

  private toolOutputIndex(tool: StreamTool): number {
    return (this.responseMessageStarted ? 1 : 0) + tool.index
  }

  private toolItem(tool: StreamTool, status: 'in_progress' | 'completed'): JsonObject {
    return {
      id: tool.itemId,
      type: 'function_call',
      status,
      call_id: tool.callId,
      name: tool.name,
      arguments: status === 'completed' ? tool.arguments : '',
    }
  }

  private responseSnapshot(
    status: 'in_progress' | 'completed' | 'incomplete' | 'failed',
    error: MappedGeminiError['error'] | null,
    incompleteDetails: JsonObject | null,
  ): JsonObject {
    const output: JsonObject[] = []
    if (this.responseMessageStarted) output.push(this.messageItem(status === 'in_progress' ? 'in_progress' : 'completed'))
    for (const tool of this.tools.values()) {
      if (tool.started) output.push(this.toolItem(tool, status === 'in_progress' ? 'in_progress' : 'completed'))
    }
    return {
      id: this.id,
      object: 'response',
      created_at: this.timestamp,
      status,
      model: this.options.model,
      output,
      usage: status === 'in_progress' ? null : responsesUsage(this.usage),
      error,
      incomplete_details: incompleteDetails,
    }
  }

  private responseFrame(event: string, data: JsonObject): GeminiSseFrame {
    return {
      event,
      data: { type: event, sequence_number: this.sequence++, ...data },
    }
  }
}

export function createGeminiSseConverter(options: GeminiSseOptions): GeminiSseConverter {
  return new GeminiSseConverter(options)
}

export function serializeGeminiSseFrame(frame: GeminiSseFrame): string {
  const event = frame.event ? `event: ${frame.event}\n` : ''
  const data = frame.data === '[DONE]' ? frame.data : JSON.stringify(frame.data)
  return `${event}data: ${data}\n\n`
}

function dataFromSseBlock(block: string): string | undefined {
  const lines = block.split(/\r?\n/)
  const data: string[] = []
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue
    if (line === 'data') data.push('')
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length > 0 ? data.join('\n') : undefined
}

/**
 * Parse arbitrary upstream SSE byte boundaries and emit target-protocol SSE.
 * The returned transform owns terminal emission: [DONE], EOF and flush are
 * idempotent through GeminiSseConverter.finish().
 */
export function createGeminiSseTransform(options: GeminiSseOptions): TransformStream<Uint8Array, Uint8Array> {
  const converter = new GeminiSseConverter(options)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const enqueue = (controller: TransformStreamDefaultController<Uint8Array>, frames: GeminiSseFrame[]) => {
    for (const frame of frames) controller.enqueue(encoder.encode(serializeGeminiSseFrame(frame)))
  }
  const dispatch = (controller: TransformStreamDefaultController<Uint8Array>, block: string) => {
    const data = dataFromSseBlock(block)
    if (data === undefined || data === '') return
    if (data === '[DONE]') {
      enqueue(controller, converter.finish())
      return
    }
    try {
      enqueue(controller, converter.push(JSON.parse(data) as unknown))
    } catch {
      enqueue(
        controller,
        converter.fail(502, { error: { message: 'Failed to parse Gemini stream event' } }),
      )
    }
  }
  const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer)
      if (!separator || separator.index === undefined) return
      const block = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator[0].length)
      dispatch(controller, block)
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      drain(controller)
    },
    flush(controller) {
      buffer += decoder.decode()
      drain(controller)
      if (buffer.trim() !== '') dispatch(controller, buffer)
      enqueue(controller, converter.finish())
    },
  })
}

export interface GeminiGenerateContentToResponsesOptions {
  publicModel: string
  mappedModel?: string
  stream?: boolean
}

export interface GeminiGenerateContentToResponsesConversion {
  publicModel: string
  upstreamModel: string
  stream: boolean
  body: JsonObject
}

export interface OpenAIResponsesToGeminiOptions {
  publicModel: string
}

export interface GeminiNativeCandidate extends JsonObject {
  index: number
  content?: {
    role: 'model'
    parts: GeminiPart[]
  }
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY'
}

export interface GeminiNativeSuccessResponse extends JsonObject {
  candidates: GeminiNativeCandidate[]
  usageMetadata: JsonObject
  modelVersion: string
}

export interface GeminiNativeErrorResponse extends JsonObject {
  error: {
    code: number
    message: string
    status: string
  }
}

export type GeminiNativeResponse = GeminiNativeSuccessResponse | GeminiNativeErrorResponse

const GEMINI_BODY_FIELDS = new Set(['contents', 'systemInstruction', 'tools', 'generationConfig'])
const GEMINI_CONTENT_FIELDS = new Set(['role', 'parts'])
const GEMINI_SYSTEM_FIELDS = new Set(['role', 'parts'])
const GEMINI_PART_FIELDS = new Set([
  'text',
  'functionCall',
  'functionResponse',
  'thoughtSignature',
])
const GEMINI_FUNCTION_CALL_FIELDS = new Set(['name', 'args'])
const GEMINI_FUNCTION_RESPONSE_FIELDS = new Set(['name', 'response'])
const GEMINI_TOOL_FIELDS = new Set(['functionDeclarations'])
const GEMINI_DECLARATION_FIELDS = new Set(['name', 'description', 'parameters'])
const GEMINI_GENERATION_FIELDS = new Set([
  'maxOutputTokens',
  'temperature',
  'topP',
  'stopSequences',
  'candidateCount',
  'responseMimeType',
  'responseSchema',
])

function rejectUnknownFields(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new GeminiCodecError(`${label} contains unsupported field: ${key}`)
  }
}

function cloneJsonValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > 64) throw new GeminiCodecError(`${label} exceeds the nesting limit`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GeminiCodecError(`${label} contains a non-finite number`)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJsonValue(item, `${label}[${index}]`, depth + 1))
  }
  if (isObject(value)) {
    const result: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new GeminiCodecError(`${label}.${key} is not JSON-compatible`)
      result[key] = cloneJsonValue(item, `${label}.${key}`, depth + 1)
    }
    return result
  }
  throw new GeminiCodecError(`${label} is not JSON-compatible`)
}

function requireNonEmptyArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GeminiCodecError(`${label} must be a non-empty array`)
  }
  return value
}

type ValidatedNativePart =
  | { kind: 'text'; text: string }
  | { kind: 'functionCall'; name: string; args: JsonObject }
  | { kind: 'functionResponse'; name: string; response: JsonObject }

function validateNativePart(value: unknown, role: 'user' | 'model', label: string): ValidatedNativePart {
  const part = requireObject(value, label)
  rejectUnknownFields(part, GEMINI_PART_FIELDS, label)
  const variants = [part.text !== undefined, part.functionCall !== undefined, part.functionResponse !== undefined]
  if (variants.filter(Boolean).length !== 1) {
    throw new GeminiCodecError(`${label} must contain exactly one supported part type`)
  }
  if (part.text !== undefined) {
    if (typeof part.text !== 'string') throw new GeminiCodecError(`${label}.text must be a string`)
    if (part.thoughtSignature !== undefined) {
      throw new GeminiCodecError(`${label}.thoughtSignature is only valid for functionCall`)
    }
    return { kind: 'text', text: part.text }
  }
  if (part.functionCall !== undefined) {
    if (role !== 'model') throw new GeminiCodecError(`${label}.functionCall requires model role`)
    const call = requireObject(part.functionCall, `${label}.functionCall`)
    rejectUnknownFields(call, GEMINI_FUNCTION_CALL_FIELDS, `${label}.functionCall`)
    if (!isObject(call.args)) throw new GeminiCodecError('functionCall.args must be an object')
    if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string') {
      throw new GeminiCodecError(`${label}.thoughtSignature must be a string`)
    }
    return {
      kind: 'functionCall',
      name: requireNonEmptyString(call.name, 'functionCall.name'),
      args: cloneJsonValue(call.args, 'functionCall.args') as JsonObject,
    }
  }
  if (role !== 'user') throw new GeminiCodecError(`${label}.functionResponse requires user role`)
  if (part.thoughtSignature !== undefined) {
    throw new GeminiCodecError(`${label}.thoughtSignature is only valid for functionCall`)
  }
  const response = requireObject(part.functionResponse, `${label}.functionResponse`)
  rejectUnknownFields(response, GEMINI_FUNCTION_RESPONSE_FIELDS, `${label}.functionResponse`)
  if (!isObject(response.response)) throw new GeminiCodecError('functionResponse.response must be an object')
  return {
    kind: 'functionResponse',
    name: requireNonEmptyString(response.name, 'functionResponse.name'),
    response: cloneJsonValue(response.response, 'functionResponse.response') as JsonObject,
  }
}

function nativeSystemInstruction(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const instruction = requireObject(value, 'systemInstruction')
  rejectUnknownFields(instruction, GEMINI_SYSTEM_FIELDS, 'systemInstruction')
  if (
    instruction.role !== undefined &&
    instruction.role !== 'system' &&
    instruction.role !== 'user'
  ) {
    throw new GeminiCodecError('systemInstruction.role is invalid')
  }
  const text = requireNonEmptyArray(instruction.parts, 'systemInstruction.parts').map((raw, index) => {
    const part = requireObject(raw, `systemInstruction.parts[${index}]`)
    rejectUnknownFields(part, new Set(['text']), `systemInstruction.parts[${index}]`)
    if (typeof part.text !== 'string') {
      throw new GeminiCodecError(`systemInstruction.parts[${index}].text must be a string`)
    }
    return part.text
  })
  return text.join('\n')
}

function nativeTools(value: unknown): JsonObject[] | undefined {
  if (value === undefined) return undefined
  const rawTools = requireNonEmptyArray(value, 'tools')
  const tools: JsonObject[] = []
  for (const [toolIndex, rawTool] of rawTools.entries()) {
    const tool = requireObject(rawTool, `tools[${toolIndex}]`)
    rejectUnknownFields(tool, GEMINI_TOOL_FIELDS, `tools[${toolIndex}]`)
    const declarations = requireNonEmptyArray(
      tool.functionDeclarations,
      `tools[${toolIndex}].functionDeclarations`,
    )
    for (const [declarationIndex, rawDeclaration] of declarations.entries()) {
      const label = `tools[${toolIndex}].functionDeclarations[${declarationIndex}]`
      const declaration = requireObject(rawDeclaration, label)
      rejectUnknownFields(declaration, GEMINI_DECLARATION_FIELDS, label)
      const parameters =
        declaration.parameters === undefined
          ? { type: 'object', properties: {} }
          : requireObject(declaration.parameters, `${label}.parameters`)
      if (declaration.description !== undefined && typeof declaration.description !== 'string') {
        throw new GeminiCodecError(`${label}.description must be a string`)
      }
      tools.push({
        type: 'function',
        name: requireNonEmptyString(declaration.name, `${label}.name`),
        ...(typeof declaration.description === 'string' ? { description: declaration.description } : {}),
        parameters: cloneJsonValue(parameters, `${label}.parameters`),
      })
    }
  }
  return tools
}

function nativeGenerationConfig(value: unknown): JsonObject {
  if (value === undefined) return {}
  const config = requireObject(value, 'generationConfig')
  rejectUnknownFields(config, GEMINI_GENERATION_FIELDS, 'generationConfig')
  const result: JsonObject = {}
  const maximum = positiveInteger(config.maxOutputTokens, 'generationConfig.maxOutputTokens')
  const temperature = finiteNumber(config.temperature, 'generationConfig.temperature')
  const topP = finiteNumber(config.topP, 'generationConfig.topP')
  if (maximum !== undefined) result.max_output_tokens = maximum
  if (temperature !== undefined) result.temperature = temperature
  if (topP !== undefined) result.top_p = topP

  if (config.candidateCount !== undefined) {
    if (config.candidateCount !== 1) throw new GeminiCodecError('generationConfig.candidateCount must be 1')
  }
  if (config.stopSequences !== undefined) {
    asStringArray(config.stopSequences, 'generationConfig.stopSequences')
    throw new GeminiCodecError('generationConfig.stopSequences is not supported by Responses')
  }
  if (config.responseMimeType !== undefined) {
    if (config.responseMimeType !== 'application/json' && config.responseMimeType !== 'text/plain') {
      throw new GeminiCodecError('generationConfig.responseMimeType is unsupported')
    }
    if (config.responseMimeType === 'application/json') {
      if (config.responseSchema === undefined) {
        result.text = { format: { type: 'json_object' } }
      } else {
        result.text = {
          format: {
            type: 'json_schema',
            name: 'gemini_response',
            schema: cloneJsonValue(
              requireObject(config.responseSchema, 'generationConfig.responseSchema'),
              'generationConfig.responseSchema',
            ),
            strict: false,
          },
        }
      }
    } else if (config.responseSchema !== undefined) {
      throw new GeminiCodecError('generationConfig.responseSchema requires application/json')
    }
  } else if (config.responseSchema !== undefined) {
    throw new GeminiCodecError('generationConfig.responseSchema requires responseMimeType')
  }
  return result
}

/**
 * Convert a Gemini-native generateContent body into a whitelisted Responses
 * request. Model names come from the route, never from an untrusted body.
 */
export function convertGeminiGenerateContentToResponsesRequest(
  input: unknown,
  options: GeminiGenerateContentToResponsesOptions,
): GeminiGenerateContentToResponsesConversion {
  const request = requireObject(input, 'Gemini request')
  rejectUnknownFields(request, GEMINI_BODY_FIELDS, 'Gemini request')
  const rawContents = requireNonEmptyArray(request.contents, 'contents')
  const publicModel = normalizeGeminiModelName(options.publicModel)
  const upstreamModel = normalizeGeminiModelName(options.mappedModel ?? publicModel)
  if (options.stream !== undefined && typeof options.stream !== 'boolean') {
    throw new GeminiCodecError('stream must be a boolean')
  }

  const responseInput: JsonObject[] = []
  const callsByName = new Map<string, string[]>()
  for (const [contentIndex, rawContent] of rawContents.entries()) {
    const label = `contents[${contentIndex}]`
    const content = requireObject(rawContent, label)
    rejectUnknownFields(content, GEMINI_CONTENT_FIELDS, label)
    if (content.role !== 'user' && content.role !== 'model') {
      throw new GeminiCodecError(`${label} content role must be user or model`)
    }
    const role = content.role
    const rawParts = requireNonEmptyArray(content.parts, `${label}.parts`)
    let messageParts: JsonObject[] = []
    const flushMessage = () => {
      if (messageParts.length === 0) return
      responseInput.push({ role: role === 'model' ? 'assistant' : 'user', content: messageParts })
      messageParts = []
    }
    for (const [partIndex, rawPart] of rawParts.entries()) {
      const part = validateNativePart(rawPart, role, `${label}.parts[${partIndex}]`)
      if (part.kind === 'text') {
        messageParts.push({ type: role === 'model' ? 'output_text' : 'input_text', text: part.text })
      } else if (part.kind === 'functionCall') {
        flushMessage()
        const callId = `call_gemini_${contentIndex}_${partIndex}`
        const calls = callsByName.get(part.name) ?? []
        calls.push(callId)
        callsByName.set(part.name, calls)
        responseInput.push({
          type: 'function_call',
          id: `fc_gemini_${contentIndex}_${partIndex}`,
          call_id: callId,
          name: part.name,
          arguments: JSON.stringify(part.args),
        })
      } else {
        flushMessage()
        responseInput.push({
          type: 'function_call_output',
          call_id:
            callsByName.get(part.name)?.shift() ?? `call_gemini_result_${contentIndex}_${partIndex}`,
          output: JSON.stringify(part.response),
        })
      }
    }
    flushMessage()
  }

  const stream = options.stream === true
  const body: JsonObject = {
    model: upstreamModel,
    input: responseInput,
    ...nativeGenerationConfig(request.generationConfig),
    stream,
    store: false,
  }
  const instructions = nativeSystemInstruction(request.systemInstruction)
  if (instructions !== undefined) body.instructions = instructions
  const tools = nativeTools(request.tools)
  if (tools) body.tools = tools
  return { publicModel, upstreamModel, stream, body }
}

function strictResponseToken(value: unknown, label: string, optional = false): number {
  if (value === undefined && optional) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GeminiCodecError(`${label} must be a non-negative integer`)
  }
  return value
}

function openAIUsageToGemini(value: unknown): JsonObject {
  if (value === undefined || value === null) {
    return {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: 0,
    }
  }
  const usage = requireObject(value, 'response.usage')
  const prompt = strictResponseToken(usage.input_tokens ?? usage.prompt_tokens, 'response.usage.input_tokens')
  const output = strictResponseToken(
    usage.output_tokens ?? usage.completion_tokens,
    'response.usage.output_tokens',
  )
  const inputDetails = isObject(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isObject(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : {}
  const outputDetails = isObject(usage.output_tokens_details)
    ? usage.output_tokens_details
    : isObject(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : {}
  const cached = strictResponseToken(inputDetails.cached_tokens, 'cached_tokens', true)
  const reasoning = Math.min(
    strictResponseToken(outputDetails.reasoning_tokens, 'reasoning_tokens', true),
    output,
  )
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: output - reasoning,
    totalTokenCount: prompt + output,
    cachedContentTokenCount: Math.min(cached, prompt),
    thoughtsTokenCount: reasoning,
  }
}

function openAIStatusToGeminiFinish(response: JsonObject): 'STOP' | 'MAX_TOKENS' | 'SAFETY' {
  if (response.status !== 'incomplete') return 'STOP'
  const details = isObject(response.incomplete_details) ? response.incomplete_details : {}
  return details.reason === 'max_output_tokens' ? 'MAX_TOKENS' : 'SAFETY'
}

function openAIResponseParts(response: JsonObject): GeminiPart[] {
  if (!Array.isArray(response.output)) throw new GeminiCodecError('response.output must be an array')
  const result: GeminiPart[] = []
  for (const [itemIndex, rawItem] of response.output.entries()) {
    const item = requireObject(rawItem, `response.output[${itemIndex}]`)
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw new GeminiCodecError('response message content must be an array')
      for (const rawContent of item.content) {
        if (!isObject(rawContent)) continue
        if (rawContent.type === 'output_text' && typeof rawContent.text === 'string') {
          result.push({ text: rawContent.text })
        }
      }
    } else if (item.type === 'function_call') {
      result.push({
        functionCall: {
          name: requireNonEmptyString(item.name, 'response function call name'),
          args: parseJsonObject(item.arguments, 'response function call arguments'),
        },
      })
    }
  }
  return result
}

function safeOpenAIErrorMessage(response: JsonObject, publicModel?: string): string {
  if (!isObject(response.error) || typeof response.error.message !== 'string') {
    return 'OpenAI Responses upstream request failed'
  }
  const message = response.error.message.trim()
  if (message === '' || message.length > 1_024 || /<\/?(?:html|script|body)\b/i.test(message)) {
    return 'OpenAI Responses upstream request failed'
  }
  const upstreamModel = typeof response.model === 'string' ? response.model : ''
  return upstreamModel !== '' && publicModel !== undefined
    ? message.split(upstreamModel).join(publicModel)
    : message
}

/** Convert a terminal OpenAI Responses object to a native Gemini JSON body. */
export function convertOpenAIResponsesResponseToGemini(
  input: unknown,
  options: OpenAIResponsesToGeminiOptions,
): GeminiNativeResponse {
  const response = requireObject(input, 'OpenAI Responses response')
  const publicModel = normalizeGeminiModelName(options.publicModel)
  if (response.status === 'failed') {
    return {
      error: {
        code: 502,
        message: safeOpenAIErrorMessage(response, publicModel),
        status: 'INTERNAL',
      },
    }
  }
  if (response.status !== 'completed' && response.status !== 'incomplete') {
    throw new GeminiCodecError('response.status must be completed, incomplete, or failed')
  }
  const parts = openAIResponseParts(response)
  return {
    candidates: [
      {
        index: 0,
        ...(parts.length > 0 ? { content: { role: 'model', parts } } : {}),
        finishReason: openAIStatusToGeminiFinish(response),
      },
    ],
    usageMetadata: openAIUsageToGemini(response.usage),
    modelVersion: publicModel,
  }
}

interface ReverseStreamTool {
  name: string
  arguments: string
  emitted: boolean
}

export class OpenAIResponsesToGeminiSseConverter {
  private readonly publicModel: string
  private readonly tools = new Map<string, ReverseStreamTool>()
  private ended = false
  private sawTerminal = false

  constructor(options: OpenAIResponsesToGeminiOptions) {
    this.publicModel = normalizeGeminiModelName(options.publicModel)
  }

  push(input: unknown, eventName?: string): GeminiSseFrame[] {
    if (this.ended) return []
    let event: JsonObject
    try {
      event = requireObject(input, 'Responses stream event')
    } catch {
      return this.fail('Failed to parse OpenAI Responses stream event')
    }
    const type = typeof event.type === 'string' ? event.type : eventName
    if (type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') return this.fail('Responses text delta is invalid')
      return [this.contentFrame({ text: event.delta })]
    }
    if (type === 'response.output_item.added') {
      if (!isObject(event.item) || event.item.type !== 'function_call') return []
      const itemId = requireNonEmptyString(event.item.id, 'function call item id')
      this.tools.set(itemId, {
        name: requireNonEmptyString(event.item.name, 'function call name'),
        arguments: typeof event.item.arguments === 'string' ? event.item.arguments : '',
        emitted: false,
      })
      return []
    }
    if (type === 'response.function_call_arguments.delta') {
      if (typeof event.item_id !== 'string' || typeof event.delta !== 'string') {
        return this.fail('Responses function arguments delta is invalid')
      }
      const tool = this.tools.get(event.item_id)
      if (!tool) return this.fail('Responses function arguments reference an unknown item')
      tool.arguments += event.delta
      return []
    }
    if (type === 'response.function_call_arguments.done') {
      if (typeof event.item_id !== 'string') return this.fail('Responses function call item id is invalid')
      const tool = this.tools.get(event.item_id)
      if (!tool) return this.fail('Responses function call references an unknown item')
      if (typeof event.arguments === 'string') tool.arguments = event.arguments
      return this.emitTool(tool)
    }
    if (type === 'response.output_item.done') {
      if (!isObject(event.item) || event.item.type !== 'function_call') return []
      const itemId = requireNonEmptyString(event.item.id, 'function call item id')
      let tool = this.tools.get(itemId)
      if (!tool) {
        tool = {
          name: requireNonEmptyString(event.item.name, 'function call name'),
          arguments: typeof event.item.arguments === 'string' ? event.item.arguments : '',
          emitted: false,
        }
        this.tools.set(itemId, tool)
      } else if (typeof event.item.arguments === 'string') {
        tool.arguments = event.item.arguments
      }
      return this.emitTool(tool)
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      let response = isObject(event.response) ? event.response : event
      if (type === 'response.incomplete' && response.status === undefined) response = { ...response, status: 'incomplete' }
      if (type === 'response.completed' && response.status === undefined) response = { ...response, status: 'completed' }
      return this.terminal(response)
    }
    if (type === 'response.failed' || type === 'error' || type === 'response.error') {
      const response = isObject(event.response) ? event.response : event
      return this.fail(safeOpenAIErrorMessage(response, this.publicModel))
    }
    return []
  }

  finish(): GeminiSseFrame[] {
    if (this.ended) return []
    if (this.sawTerminal) {
      this.ended = true
      return []
    }
    return this.fail('OpenAI Responses stream ended before a terminal event')
  }

  private contentFrame(part: GeminiPart): GeminiSseFrame {
    return {
      data: {
        candidates: [{ index: 0, content: { role: 'model', parts: [part] } }],
        modelVersion: this.publicModel,
      },
    }
  }

  private emitTool(tool: ReverseStreamTool): GeminiSseFrame[] {
    if (tool.emitted) return []
    let args: JsonObject
    try {
      args = parseJsonObject(tool.arguments, 'response function call arguments')
    } catch {
      return this.fail('Responses function call arguments are invalid')
    }
    tool.emitted = true
    return [this.contentFrame({ functionCall: { name: tool.name, args } })]
  }

  private terminal(response: JsonObject): GeminiSseFrame[] {
    if (this.ended || this.sawTerminal) return []
    if (response.status !== 'completed' && response.status !== 'incomplete') {
      return this.fail('Responses terminal status is invalid')
    }
    this.sawTerminal = true
    this.ended = true
    return [
      {
        data: {
          candidates: [{ index: 0, finishReason: openAIStatusToGeminiFinish(response) }],
          usageMetadata: openAIUsageToGemini(response.usage),
          modelVersion: this.publicModel,
        },
      },
    ]
  }

  private fail(message: string): GeminiSseFrame[] {
    if (this.ended) return []
    this.ended = true
    return [{ data: { error: { code: 502, message, status: 'INTERNAL' } } }]
  }
}

export function createOpenAIResponsesToGeminiSseConverter(
  options: OpenAIResponsesToGeminiOptions,
): OpenAIResponsesToGeminiSseConverter {
  return new OpenAIResponsesToGeminiSseConverter(options)
}

function responsesSseBlock(block: string): { event?: string; data?: string } {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line === 'data') data.push('')
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return { event, ...(data.length > 0 ? { data: data.join('\n') } : {}) }
}

export function createOpenAIResponsesToGeminiSseTransform(
  options: OpenAIResponsesToGeminiOptions,
): TransformStream<Uint8Array, Uint8Array> {
  const converter = new OpenAIResponsesToGeminiSseConverter(options)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const enqueue = (controller: TransformStreamDefaultController<Uint8Array>, frames: GeminiSseFrame[]) => {
    for (const frame of frames) controller.enqueue(encoder.encode(serializeGeminiSseFrame(frame)))
  }
  const dispatch = (controller: TransformStreamDefaultController<Uint8Array>, block: string) => {
    const frame = responsesSseBlock(block)
    if (frame.data === undefined || frame.data === '') return
    if (frame.data === '[DONE]') {
      enqueue(controller, converter.finish())
      return
    }
    try {
      const parsed = JSON.parse(frame.data) as unknown
      enqueue(controller, converter.push(parsed, frame.event))
    } catch {
      enqueue(
        controller,
        converter.push({ type: 'error', error: { message: 'Failed to parse OpenAI Responses stream event' } }),
      )
    }
  }
  const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer)
      if (!separator || separator.index === undefined) return
      const block = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator[0].length)
      dispatch(controller, block)
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      drain(controller)
    },
    flush(controller) {
      buffer += decoder.decode()
      drain(controller)
      if (buffer.trim() !== '') dispatch(controller, buffer)
      enqueue(controller, converter.finish())
    },
  })
}
