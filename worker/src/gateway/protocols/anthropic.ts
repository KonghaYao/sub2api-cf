/**
 * A dependency-free codec at the Anthropic Messages/OpenAI protocol boundary.
 * Every decoder projects an allow-listed wire shape; caller-owned objects are
 * never spread into an upstream request or a downstream response.
 */

import { flattenNamespaceToolName } from './responses'

const MAX_MESSAGES = 1_000
const MAX_CONTENT_BLOCKS = 1_000
const MAX_TOOLS = 256
const MAX_TEXT_CHARS = 4_000_000
const MAX_JSON_CHARS = 4_000_000
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header: '

type JsonObject = Record<string, unknown>

export class ProtocolValidationError extends Error {
  readonly code = 'invalid_request_error'

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'ProtocolValidationError'
  }
}

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export type AnthropicSystem = string | AnthropicTextBlock[]

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: JsonObject
}

export interface AnthropicImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error: boolean
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: JsonObject
}

export type AnthropicToolChoice =
  | { type: 'auto' | 'any' | 'none' }
  | { type: 'tool'; name: string }

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'max'

export type AnthropicThinking =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive'; budget_tokens?: number }
  | { type: 'disabled' }

export interface AnthropicOutputConfig {
  effort?: AnthropicEffort
}

export interface AnthropicMetadata {
  user_id?: string
}

export interface AnthropicMessagesRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: AnthropicSystem
  stream: boolean
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  metadata?: AnthropicMetadata
  thinking?: AnthropicThinking
  output_config?: AnthropicOutputConfig
}

export interface AnthropicCountTokensRequest {
  model: string
  messages: AnthropicMessage[]
  system?: AnthropicSystem
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
}

export interface OpenAIResponsesRequest {
  model: string
  input: Array<Record<string, unknown>>
  max_output_tokens: number
  stream: boolean
  store: false
  parallel_tool_calls: true
  include: ['reasoning.encrypted_content']
  reasoning: { effort: 'low' | 'medium' | 'high' | 'xhigh'; summary: 'auto' }
  text: { verbosity: 'medium' }
  temperature?: number
  top_p?: number
  tools?: Array<Record<string, unknown>>
  tool_choice?: string | Record<string, unknown>
}

export interface OpenAIResponsesInputTokensRequest {
  model: string
  input: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  tool_choice?: string | Record<string, unknown>
}

export interface OpenAIChatCompletionsRequest {
  model: string
  messages: Array<Record<string, unknown>>
  max_completion_tokens: number
  stream: boolean
  parallel_tool_calls: true
  reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh'
  temperature?: number
  top_p?: number
  tools?: Array<Record<string, unknown>>
  tool_choice?: string | Record<string, unknown>
}

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface AnthropicMessageResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  stop_sequence: null
  usage: AnthropicUsage
}

export interface AnthropicErrorResponse {
  type: 'error'
  error: {
    type:
      | 'invalid_request_error'
      | 'authentication_error'
      | 'permission_error'
      | 'not_found_error'
      | 'request_too_large'
      | 'rate_limit_error'
      | 'overloaded_error'
      | 'api_error'
    message: string
  }
}

export interface AnthropicSseEvent {
  type: string
  [key: string]: unknown
}

export function parseAnthropicMessagesRequest(value: unknown): AnthropicMessagesRequest {
  const root = objectAt(value, '$')
  exactKeys(root, [
    'model',
    'max_tokens',
    'messages',
    'system',
    'stream',
    'tools',
    'tool_choice',
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'metadata',
    'thinking',
    'output_config',
  ], '$')
  const model = nonEmptyString(root.model, '$.model', 256)
  const maxTokens = integerInRange(root.max_tokens, '$.max_tokens', 1, 1_000_000)
  const rawMessages = arrayAt(root.messages, '$.messages', MAX_MESSAGES)
  if (rawMessages.length === 0) fail('$.messages', 'must contain at least one message')

  const messages = rawMessages.map((message, index) => parseMessage(message, `$.messages[${index}]`))
  const system = root.system === undefined ? undefined : parseSystem(root.system, '$.system')
  const stream = root.stream === undefined ? false : booleanAt(root.stream, '$.stream')
  const tools = root.tools === undefined
    ? undefined
    : arrayAt(root.tools, '$.tools', MAX_TOOLS).map((tool, index) => parseTool(tool, `$.tools[${index}]`))
  const toolChoice = root.tool_choice === undefined
    ? undefined
    : parseToolChoice(root.tool_choice, '$.tool_choice')
  const temperature = root.temperature === undefined
    ? undefined
    : numberInRange(root.temperature, '$.temperature', 0, 1)
  const topP = root.top_p === undefined
    ? undefined
    : numberInRange(root.top_p, '$.top_p', 0, 1)
  const topK = root.top_k === undefined
    ? undefined
    : integerInRange(root.top_k, '$.top_k', 0, 1_000_000)
  const stopSequences = root.stop_sequences === undefined
    ? undefined
    : arrayAt(root.stop_sequences, '$.stop_sequences', 256)
        .map((sequence, index) => nonEmptyString(sequence, `$.stop_sequences[${index}]`, 16_384))
  const metadata = root.metadata === undefined ? undefined : parseMetadata(root.metadata, '$.metadata')
  const thinking = root.thinking === undefined ? undefined : parseThinking(root.thinking, '$.thinking')
  const outputConfig = root.output_config === undefined
    ? undefined
    : parseOutputConfig(root.output_config, '$.output_config')
  return {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system === undefined ? {} : { system }),
    stream,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(topK === undefined ? {} : { top_k: topK }),
    ...(stopSequences === undefined ? {} : { stop_sequences: stopSequences }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
  }
}

export function parseAnthropicCountTokensRequest(value: unknown): AnthropicCountTokensRequest {
  const root = objectAt(value, '$')
  exactKeys(root, [
    'model',
    'messages',
    'system',
    'tools',
    'tool_choice',
    // Claude clients sometimes reuse their generation body for preflight
    // counting. These fields are accepted but deliberately not forwarded.
    'max_tokens',
    'stream',
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'metadata',
    'thinking',
    'output_config',
  ], '$')
  const model = nonEmptyString(root.model, '$.model', 256)
  const messages = arrayAt(root.messages, '$.messages', MAX_MESSAGES)
    .map((message, index) => parseMessage(message, `$.messages[${index}]`))
  const system = root.system === undefined ? undefined : parseSystem(root.system, '$.system')
  const tools = root.tools === undefined
    ? undefined
    : arrayAt(root.tools, '$.tools', MAX_TOOLS)
        .map((tool, index) => parseTool(tool, `$.tools[${index}]`))
  const toolChoice = root.tool_choice === undefined
    ? undefined
    : parseToolChoice(root.tool_choice, '$.tool_choice')
  return {
    model,
    messages,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  }
}

export function toOpenAIResponsesRequest(
  request: AnthropicMessagesRequest,
  upstreamModel: string,
): OpenAIResponsesRequest {
  const input: Array<Record<string, unknown>> = []
  const system = systemParts(request.system)
  if (system.length > 0) {
    input.push({ type: 'message', role: 'developer', content: system })
  }
  for (const message of request.messages) input.push(...messageToResponsesItems(message))

  const tools = request.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: tool.input_schema,
    strict: false,
  }))
  const result: OpenAIResponsesRequest = {
    model: nonEmptyString(upstreamModel, 'upstreamModel', 256),
    input,
    max_output_tokens: request.max_tokens,
    stream: request.stream,
    store: false,
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: responsesEffort(request.output_config?.effort), summary: 'auto' },
    text: { verbosity: 'medium' },
  }
  if (!canonicalModel(result.model).startsWith('gpt-5')) {
    if (request.temperature !== undefined) result.temperature = request.temperature
    if (request.top_p !== undefined) result.top_p = request.top_p
  }
  if (tools !== undefined && tools.length > 0) result.tools = tools
  if (request.tool_choice !== undefined && tools !== undefined && tools.length > 0) {
    result.tool_choice = responsesToolChoice(request.tool_choice, new Set(request.tools?.map((tool) => tool.name)))
  }
  return result
}

export function toOpenAIResponsesInputTokensRequest(
  request: AnthropicCountTokensRequest,
  upstreamModel: string,
): OpenAIResponsesInputTokensRequest {
  const converted = toOpenAIResponsesRequest(
    {
      ...request,
      max_tokens: 1,
      stream: false,
    },
    upstreamModel,
  )
  return {
    model: converted.model,
    input: converted.input,
    ...(converted.tools === undefined ? {} : { tools: converted.tools }),
    ...(converted.tool_choice === undefined ? {} : { tool_choice: converted.tool_choice }),
  }
}

export function toOpenAIChatCompletionsRequest(
  request: AnthropicMessagesRequest,
  upstreamModel: string,
): OpenAIChatCompletionsRequest {
  const messages: Array<Record<string, unknown>> = []
  const system = systemParts(request.system)
  if (system.length > 0) {
    messages.push({ role: 'system', content: system.map((part) => part.text).join('\n\n') })
  }
  for (const message of request.messages) messages.push(...messageToChatMessages(message))

  const tools = request.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.input_schema,
      strict: false,
    },
  }))
  const result: OpenAIChatCompletionsRequest = {
    model: nonEmptyString(upstreamModel, 'upstreamModel', 256),
    messages,
    max_completion_tokens: request.max_tokens,
    stream: request.stream,
    parallel_tool_calls: true,
    reasoning_effort: responsesEffort(request.output_config?.effort),
  }
  if (!canonicalModel(result.model).startsWith('gpt-5')) {
    if (request.temperature !== undefined) result.temperature = request.temperature
    if (request.top_p !== undefined) result.top_p = request.top_p
  }
  if (tools !== undefined && tools.length > 0) result.tools = tools
  if (request.tool_choice !== undefined && tools !== undefined && tools.length > 0) {
    result.tool_choice = chatToolChoice(request.tool_choice, new Set(request.tools?.map((tool) => tool.name)))
  }
  return result
}

/** Convert a non-streaming OpenAI Responses envelope to Anthropic Messages. */
export function responsesToAnthropicMessage(
  value: unknown,
  clientModel: string,
): AnthropicMessageResponse {
  const response = objectAt(value, 'response')
  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = []
  let hasToolUse = false
  const output = response.output === undefined ? [] : arrayAt(response.output, 'response.output', MAX_CONTENT_BLOCKS)
  for (let index = 0; index < output.length; index += 1) {
    const item = objectAt(output[index], `response.output[${index}]`)
    if (item.type === 'message') {
      const parts = item.content === undefined
        ? []
        : arrayAt(item.content, `response.output[${index}].content`, MAX_CONTENT_BLOCKS)
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = objectAt(parts[partIndex], `response.output[${index}].content[${partIndex}]`)
        if (part.type === 'output_text' && typeof part.text === 'string' && part.text !== '') {
          content.push({ type: 'text', text: boundedString(part.text, `response.output[${index}].content[${partIndex}].text`, MAX_TEXT_CHARS) })
        }
      }
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      hasToolUse = true
      content.push({
        type: 'tool_use',
        id: safeIdentifier(item.call_id, `response.output[${index}].call_id`, 'toolu'),
        name: responsesToolName(item, `response.output[${index}]`),
        input: item.type === 'custom_tool_call'
          ? customToolInputObject(item.input, `response.output[${index}].input`)
          : parseArgumentsObject(item.arguments),
      })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })

  const status = typeof response.status === 'string' ? response.status : 'completed'
  const details = response.incomplete_details === undefined
    ? undefined
    : objectAt(response.incomplete_details, 'response.incomplete_details')
  const stopReason = status === 'incomplete' && details?.reason === 'max_output_tokens'
    ? 'max_tokens'
    : hasToolUse
      ? 'tool_use'
      : 'end_turn'

  return {
    id: safeIdentifier(response.id, 'response.id', 'msg'),
    type: 'message',
    role: 'assistant',
    model: nonEmptyString(clientModel, 'clientModel', 256),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: responsesUsage(response.usage),
  }
}

/** Convert a non-streaming Chat Completions envelope to Anthropic Messages. */
export function chatCompletionsToAnthropicMessage(
  value: unknown,
  clientModel: string,
): AnthropicMessageResponse {
  const response = objectAt(value, 'response')
  const choices = response.choices === undefined ? [] : arrayAt(response.choices, 'response.choices', 32)
  const first = choices.length === 0 ? undefined : objectAt(choices[0], 'response.choices[0]')
  const message = first?.message === undefined ? undefined : objectAt(first.message, 'response.choices[0].message')
  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = []
  if (message !== undefined && typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: boundedString(message.content, 'response.choices[0].message.content', MAX_TEXT_CHARS) })
  }
  const toolCalls = message?.tool_calls === undefined
    ? []
    : arrayAt(message.tool_calls, 'response.choices[0].message.tool_calls', MAX_TOOLS)
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = objectAt(toolCalls[index], `response.choices[0].message.tool_calls[${index}]`)
    const fn = objectAt(call.function, `response.choices[0].message.tool_calls[${index}].function`)
    content.push({
      type: 'tool_use',
      id: safeIdentifier(call.id, `response.choices[0].message.tool_calls[${index}].id`, 'toolu'),
      name: safeIdentifier(fn.name, `response.choices[0].message.tool_calls[${index}].function.name`, 'tool'),
      input: parseArgumentsObject(fn.arguments),
    })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })

  const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : ''
  const stopReason = finishReason === 'length'
    ? 'max_tokens'
    : finishReason === 'tool_calls' || toolCalls.length > 0
      ? 'tool_use'
      : 'end_turn'
  return {
    id: safeIdentifier(response.id, 'response.id', 'msg'),
    type: 'message',
    role: 'assistant',
    model: nonEmptyString(clientModel, 'clientModel', 256),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: chatUsage(response.usage),
  }
}

/**
 * Map an OpenAI-family HTTP error to a deliberately generic Anthropic error.
 * The upstream payload is intentionally not reflected: it can contain account
 * identifiers, upstream model names, request URLs, or credentials.
 */
export function mapOpenAIErrorToAnthropic(status: number, _payload?: unknown): AnthropicErrorResponse {
  let type: AnthropicErrorResponse['error']['type']
  let message: string
  switch (status) {
    case 400:
    case 409:
    case 422:
      type = 'invalid_request_error'
      message = 'The request was rejected by the model provider.'
      break
    case 401:
      type = 'authentication_error'
      message = 'Authentication failed.'
      break
    case 403:
      type = 'permission_error'
      message = 'Permission denied.'
      break
    case 404:
      type = 'not_found_error'
      message = 'The requested resource was not found.'
      break
    case 413:
      type = 'request_too_large'
      message = 'The request is too large.'
      break
    case 429:
      type = 'rate_limit_error'
      message = 'The service is rate limited. Please retry later.'
      break
    case 529:
      type = 'overloaded_error'
      message = 'The service is temporarily overloaded.'
      break
    default:
      type = status >= 500 ? 'api_error' : 'invalid_request_error'
      message = status >= 500
        ? 'The model provider returned an error.'
        : 'The request could not be completed.'
  }
  return { type: 'error', error: { type, message } }
}

/** Stateful event-level adapter for an OpenAI Responses SSE stream. */
export class ResponsesToAnthropicEventCodec {
  private messageStarted = false
  private messageStopped = false
  private responseId = ''
  private blockIndex = 0
  private currentBlock: 'text' | 'tool_use' | null = null
  private readonly outputBlocks = new Map<number, number>()
  private readonly outputKinds = new Map<number, 'function' | 'custom'>()
  private readonly outputBlocksWithArgumentDeltas = new Set<number>()
  private readonly customInputDeltas = new Map<number, string>()
  private readonly customInputsDone = new Set<number>()
  private hasToolUse = false
  private usage: AnthropicUsage = emptyUsage()

  constructor(private readonly clientModel: string) {
    nonEmptyString(clientModel, 'clientModel', 256)
  }

  push(value: unknown): AnthropicSseEvent[] {
    if (this.messageStopped) return []
    const event = objectAt(value, 'event')
    const type = nonEmptyString(event.type, 'event.type', 128)
    switch (type) {
      case 'response.created':
        return this.start(event.response)
      case 'response.output_item.added':
        return this.outputItemAdded(event)
      case 'response.output_text.delta':
        return this.textDelta(event)
      case 'response.output_text.done':
        return this.closeBlock()
      case 'response.function_call_arguments.delta':
        return this.toolArgumentsDelta(event)
      case 'response.custom_tool_call_input.delta':
        return this.customToolInputDelta(event)
      case 'response.function_call_arguments.done':
        return this.toolArgumentsDone(event)
      case 'response.custom_tool_call_input.done':
        return this.customToolInputDone(event)
      case 'response.output_item.done':
        return this.outputItemDone(event)
      case 'response.completed':
      case 'response.done':
      case 'response.incomplete':
        return this.complete(event)
      case 'response.failed':
        return this.failed(event)
      case 'error':
        this.messageStopped = true
        return [{ ...mapOpenAIErrorToAnthropic(502), type: 'error' }]
      default:
        return []
    }
  }

  finish(): AnthropicSseEvent[] {
    if (!this.messageStarted || this.messageStopped) return []
    return this.terminal(this.hasToolUse ? 'tool_use' : 'end_turn')
  }

  private start(value: unknown): AnthropicSseEvent[] {
    if (value !== undefined && value !== null) {
      const response = objectAt(value, 'event.response')
      if (typeof response.id === 'string' && response.id.length <= 256) this.responseId = response.id
    }
    if (this.messageStarted) return []
    this.messageStarted = true
    if (this.responseId === '') this.responseId = `msg_${crypto.randomUUID()}`
    return [{
      type: 'message_start',
      message: {
        id: this.responseId,
        type: 'message',
        role: 'assistant',
        model: this.clientModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: emptyUsage(),
      },
    }]
  }

  private outputItemAdded(event: JsonObject): AnthropicSseEvent[] {
    const item = event.item === undefined ? undefined : objectAt(event.item, 'event.item')
    if (item?.type !== 'function_call' && item?.type !== 'custom_tool_call') return []
    const events = this.ensureStarted()
    events.push(...this.closeBlock())
    const outputIndex = nonNegativeIntegerOrZero(event.output_index)
    const index = this.blockIndex
    this.outputBlocks.set(outputIndex, index)
    this.outputKinds.set(outputIndex, item.type === 'custom_tool_call' ? 'custom' : 'function')
    this.currentBlock = 'tool_use'
    this.hasToolUse = true
    events.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: safeIdentifier(item.call_id, 'event.item.call_id', 'toolu'),
        name: responsesToolName(item, 'event.item'),
        input: {},
      },
    })
    return events
  }

  private textDelta(event: JsonObject): AnthropicSseEvent[] {
    if (typeof event.delta !== 'string' || event.delta === '') return []
    const delta = boundedString(event.delta, 'event.delta', MAX_TEXT_CHARS)
    const events = this.ensureStarted()
    if (this.currentBlock !== 'text') {
      events.push(...this.closeBlock())
      this.currentBlock = 'text'
      events.push({
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: { type: 'text', text: '' },
      })
    }
    events.push({
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'text_delta', text: delta },
    })
    return events
  }

  private toolArgumentsDelta(event: JsonObject): AnthropicSseEvent[] {
    if (typeof event.delta !== 'string' || event.delta === '') return []
    const outputIndex = nonNegativeIntegerOrZero(event.output_index)
    const index = this.outputBlocks.get(outputIndex)
    if (index === undefined) return []
    this.outputBlocksWithArgumentDeltas.add(outputIndex)
    return [{
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: boundedString(event.delta, 'event.delta', MAX_JSON_CHARS),
      },
    }]
  }

  private customToolInputDelta(event: JsonObject): AnthropicSseEvent[] {
    if (typeof event.delta !== 'string' || event.delta === '') return []
    const outputIndex = nonNegativeIntegerOrZero(event.output_index)
    if (this.outputKinds.get(outputIndex) !== 'custom') return []
    const delta = boundedString(event.delta, 'event.delta', MAX_JSON_CHARS)
    const input = (this.customInputDeltas.get(outputIndex) ?? '') + delta
    if (input.length > MAX_JSON_CHARS) fail('event.delta', `accumulated input exceeds ${MAX_JSON_CHARS} characters`)
    this.customInputDeltas.set(outputIndex, input)
    return []
  }

  private customToolInputDone(event: JsonObject): AnthropicSseEvent[] {
    const outputIndex = nonNegativeIntegerOrZero(event.output_index)
    if (this.outputKinds.get(outputIndex) !== 'custom' || this.customInputsDone.has(outputIndex)) return []
    const accumulated = this.customInputDeltas.get(outputIndex) ?? ''
    const input = event.input === undefined
      ? accumulated
      : boundedString(event.input, 'event.input', MAX_JSON_CHARS)
    if (accumulated !== '' && input !== accumulated) {
      fail('event.input', 'does not match accumulated custom tool input deltas')
    }
    this.customInputsDone.add(outputIndex)
    const index = this.outputBlocks.get(outputIndex)
    if (index === undefined) fail('event.output_index', 'has no matching custom tool item')
    return [
      {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ input }),
        },
      },
      ...this.closeBlock(),
    ]
  }

  private toolArgumentsDone(event: JsonObject): AnthropicSseEvent[] {
    if (this.currentBlock !== 'tool_use') return []
    if (typeof event.arguments === 'string' && event.arguments !== '') {
      const outputIndex = nonNegativeIntegerOrZero(event.output_index)
      if (this.outputBlocksWithArgumentDeltas.has(outputIndex)) return this.closeBlock()
      const index = this.outputBlocks.get(outputIndex) ?? this.blockIndex
      return [
        {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: boundedString(event.arguments, 'event.arguments', MAX_JSON_CHARS),
          },
        },
        ...this.closeBlock(),
      ]
    }
    return this.closeBlock()
  }

  private outputItemDone(event: JsonObject): AnthropicSseEvent[] {
    const item = event.item === undefined ? undefined : objectAt(event.item, 'event.item')
    if (
      (item?.type === 'function_call' || item?.type === 'custom_tool_call') &&
      this.currentBlock === 'tool_use'
    ) return this.closeBlock()
    return []
  }

  private complete(event: JsonObject): AnthropicSseEvent[] {
    const response = event.response === undefined ? undefined : objectAt(event.response, 'event.response')
    const rawUsage = response?.usage ?? event.usage
    if (rawUsage !== undefined) this.usage = responsesUsage(rawUsage)
    const details = response?.incomplete_details === undefined
      ? undefined
      : objectAt(response.incomplete_details, 'event.response.incomplete_details')
    const stopReason = response?.status === 'incomplete' && details?.reason === 'max_output_tokens'
      ? 'max_tokens'
      : this.hasToolUse
        ? 'tool_use'
        : 'end_turn'
    const events = this.ensureStarted()
    events.push(...this.terminal(stopReason))
    return events
  }

  private failed(event: JsonObject): AnthropicSseEvent[] {
    const response = event.response === undefined ? undefined : objectAt(event.response, 'event.response')
    const rawUsage = response?.usage ?? event.usage
    if (rawUsage !== undefined) this.usage = responsesUsage(rawUsage)
    const events = this.ensureStarted()
    // Once an Anthropic message_start has been emitted, changing wire shape to
    // a standalone error event leaves the client with an unbalanced message.
    // Match the legacy bridge: close any open block and end the partial message.
    events.push(...this.terminal('end_turn'))
    return events
  }

  private ensureStarted(): AnthropicSseEvent[] {
    return this.messageStarted ? [] : this.start(undefined)
  }

  private closeBlock(): AnthropicSseEvent[] {
    if (this.currentBlock === null) return []
    const index = this.blockIndex
    this.currentBlock = null
    this.blockIndex += 1
    return [{ type: 'content_block_stop', index }]
  }

  private terminal(stopReason: AnthropicMessageResponse['stop_reason']): AnthropicSseEvent[] {
    if (this.messageStopped) return []
    const events = this.closeBlock()
    events.push(
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: this.usage,
      },
      { type: 'message_stop' },
    )
    this.messageStopped = true
    return events
  }
}

interface ChatToolStreamState {
  id: string
  name: string
  blockIndex?: number
}

/** Stateful event-level adapter for an OpenAI Chat Completions SSE stream. */
export class ChatCompletionsToAnthropicEventCodec {
  private messageStarted = false
  private messageStopped = false
  private responseId = ''
  private blockIndex = 0
  private currentBlock: 'text' | `tool:${number}` | null = null
  private finishReason = ''
  private usage: AnthropicUsage = emptyUsage()
  private readonly tools = new Map<number, ChatToolStreamState>()

  constructor(private readonly clientModel: string) {
    nonEmptyString(clientModel, 'clientModel', 256)
  }

  push(value: unknown): AnthropicSseEvent[] {
    if (this.messageStopped) return []
    const chunk = objectAt(value, 'chunk')
    if (typeof chunk.id === 'string' && chunk.id.length > 0 && chunk.id.length <= 256) {
      this.responseId = chunk.id
    }
    if (chunk.usage !== undefined && chunk.usage !== null) this.usage = chatUsage(chunk.usage)

    const events = this.ensureStarted()
    const choices = chunk.choices === undefined ? [] : arrayAt(chunk.choices, 'chunk.choices', 32)
    for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
      const choice = objectAt(choices[choiceIndex], `chunk.choices[${choiceIndex}]`)
      const delta = choice.delta === undefined ? {} : objectAt(choice.delta, `chunk.choices[${choiceIndex}].delta`)
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        // Anthropic thinking signatures cannot be synthesized safely. Expose
        // Chat-only reasoning as regular text so the result is not dropped.
        events.push(...this.appendText(delta.reasoning_content, `chunk.choices[${choiceIndex}].delta.reasoning_content`))
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        events.push(...this.appendText(delta.content, `chunk.choices[${choiceIndex}].delta.content`))
      }
      const calls = delta.tool_calls === undefined
        ? []
        : arrayAt(delta.tool_calls, `chunk.choices[${choiceIndex}].delta.tool_calls`, MAX_TOOLS)
      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        events.push(...this.appendToolCall(calls[callIndex], `chunk.choices[${choiceIndex}].delta.tool_calls[${callIndex}]`))
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        this.finishReason = choice.finish_reason
      }
    }
    return events
  }

  finish(): AnthropicSseEvent[] {
    if (this.messageStopped) return []
    const events = this.ensureStarted()
    events.push(...this.closeBlock())
    const stopReason: AnthropicMessageResponse['stop_reason'] = this.finishReason === 'length'
      ? 'max_tokens'
      : this.finishReason === 'tool_calls' || this.tools.size > 0
        ? 'tool_use'
        : 'end_turn'
    events.push(
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: this.usage,
      },
      { type: 'message_stop' },
    )
    this.messageStopped = true
    return events
  }

  private ensureStarted(): AnthropicSseEvent[] {
    if (this.messageStarted) return []
    this.messageStarted = true
    if (this.responseId === '') this.responseId = `msg_${crypto.randomUUID()}`
    return [{
      type: 'message_start',
      message: {
        id: this.responseId,
        type: 'message',
        role: 'assistant',
        model: this.clientModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: emptyUsage(),
      },
    }]
  }

  private appendText(text: string, path: string): AnthropicSseEvent[] {
    const delta = boundedString(text, path, MAX_TEXT_CHARS)
    const events: AnthropicSseEvent[] = []
    if (this.currentBlock !== 'text') {
      events.push(...this.closeBlock())
      this.currentBlock = 'text'
      events.push({
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: { type: 'text', text: '' },
      })
    }
    events.push({
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'text_delta', text: delta },
    })
    return events
  }

  private appendToolCall(value: unknown, path: string): AnthropicSseEvent[] {
    const call = objectAt(value, path)
    const index = nonNegativeIntegerOrZero(call.index)
    const current = this.tools.get(index) ?? { id: '', name: '' }
    if (typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 256) current.id = call.id
    const fn = call.function === undefined ? undefined : objectAt(call.function, `${path}.function`)
    if (typeof fn?.name === 'string' && fn.name.length > 0 && fn.name.length <= 256) current.name = fn.name
    this.tools.set(index, current)

    const events: AnthropicSseEvent[] = []
    if (current.blockIndex === undefined && current.name !== '') {
      events.push(...this.closeBlock())
      current.blockIndex = this.blockIndex
      this.currentBlock = `tool:${index}`
      events.push({
        type: 'content_block_start',
        index: current.blockIndex,
        content_block: {
          type: 'tool_use',
          id: safeIdentifier(current.id, `${path}.id`, 'toolu'),
          name: current.name,
          input: {},
        },
      })
    }
    if (current.blockIndex !== undefined && typeof fn?.arguments === 'string' && fn.arguments !== '') {
      events.push({
        type: 'content_block_delta',
        index: current.blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: boundedString(fn.arguments, `${path}.function.arguments`, MAX_JSON_CHARS),
        },
      })
    }
    return events
  }

  private closeBlock(): AnthropicSseEvent[] {
    if (this.currentBlock === null) return []
    const index = this.blockIndex
    this.currentBlock = null
    this.blockIndex += 1
    return [{ type: 'content_block_stop', index }]
  }
}

export function formatAnthropicSseEvent(event: AnthropicSseEvent): string {
  const type = nonEmptyString(event.type, 'event.type', 128)
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`
}

function parseMetadata(value: unknown, path: string): AnthropicMetadata {
  const metadata = objectAt(value, path)
  exactKeys(metadata, ['user_id'], path)
  if (metadata.user_id === undefined) return {}
  return { user_id: nonEmptyString(metadata.user_id, `${path}.user_id`, 256) }
}

function parseThinking(value: unknown, path: string): AnthropicThinking {
  const thinking = objectAt(value, path)
  if (thinking.type === 'enabled') {
    exactKeys(thinking, ['type', 'budget_tokens'], path)
    if (thinking.budget_tokens === undefined) fail(`${path}.budget_tokens`, 'is required when thinking is enabled')
    return {
      type: 'enabled',
      budget_tokens: integerInRange(thinking.budget_tokens, `${path}.budget_tokens`, 1, 1_000_000),
    }
  }
  if (thinking.type === 'adaptive') {
    exactKeys(thinking, ['type', 'budget_tokens'], path)
    return {
      type: 'adaptive',
      ...(thinking.budget_tokens === undefined
        ? {}
        : { budget_tokens: integerInRange(thinking.budget_tokens, `${path}.budget_tokens`, 1, 1_000_000) }),
    }
  }
  exactKeys(thinking, ['type'], path)
  if (thinking.type !== 'disabled') {
    fail(`${path}.type`, 'must be "enabled", "adaptive", or "disabled"')
  }
  return { type: 'disabled' }
}

function parseOutputConfig(value: unknown, path: string): AnthropicOutputConfig {
  const outputConfig = objectAt(value, path)
  exactKeys(outputConfig, ['effort'], path)
  if (outputConfig.effort === undefined) return {}
  if (
    outputConfig.effort !== 'low' &&
    outputConfig.effort !== 'medium' &&
    outputConfig.effort !== 'high' &&
    outputConfig.effort !== 'max'
  ) {
    fail(`${path}.effort`, 'must be "low", "medium", "high", or "max"')
  }
  return { effort: outputConfig.effort }
}

function responsesEffort(effort: AnthropicEffort | undefined): 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'max') return 'xhigh'
  return effort ?? 'medium'
}

function canonicalModel(model: string): string {
  const value = model.trim().toLowerCase()
  return value.slice(value.lastIndexOf('/') + 1)
}

function parseMessage(value: unknown, path: string): AnthropicMessage {
  const message = objectAt(value, path)
  exactKeys(message, ['role', 'content'], path)
  if (message.role !== 'user' && message.role !== 'assistant') {
    fail(`${path}.role`, 'must be "user" or "assistant"')
  }
  return {
    role: message.role,
    content: parseTextContent(message.content, `${path}.content`),
  }
}

function parseSystem(value: unknown, path: string): AnthropicSystem {
  if (typeof value === 'string') return boundedString(value, path, MAX_TEXT_CHARS)
  return arrayAt(value, path, MAX_CONTENT_BLOCKS).map((block, index) =>
    parseTextBlock(block, `${path}[${index}]`),
  )
}

function parseTextContent(value: unknown, path: string): string | AnthropicContentBlock[] {
  if (typeof value === 'string') return boundedString(value, path, MAX_TEXT_CHARS)
  const blocks = arrayAt(value, path, MAX_CONTENT_BLOCKS)
  if (blocks.length === 0) fail(path, 'must not be empty')
  return blocks.map((block, index) => parseContentBlock(block, `${path}[${index}]`))
}

function parseTextBlock(value: unknown, path: string): AnthropicTextBlock {
  const block = objectAt(value, path)
  exactKeys(block, ['type', 'text'], path)
  if (block.type !== 'text') fail(`${path}.type`, 'unsupported content block type')
  return { type: 'text', text: boundedString(block.text, `${path}.text`, MAX_TEXT_CHARS) }
}

function parseContentBlock(value: unknown, path: string): AnthropicContentBlock {
  const block = objectAt(value, path)
  switch (block.type) {
    case 'text':
      return parseTextBlock(block, path)
    case 'image':
      return parseImageBlock(block, path)
    case 'tool_use': {
      exactKeys(block, ['type', 'id', 'name', 'input'], path)
      return {
        type: 'tool_use',
        id: nonEmptyString(block.id, `${path}.id`, 256),
        name: nonEmptyString(block.name, `${path}.name`, 256),
        input: jsonObjectAt(block.input, `${path}.input`),
      }
    }
    case 'tool_result': {
      exactKeys(block, ['type', 'tool_use_id', 'content', 'is_error'], path)
      const content = block.content === undefined ? '(empty)' : parseToolResultContent(block.content, `${path}.content`)
      return {
        type: 'tool_result',
        tool_use_id: nonEmptyString(block.tool_use_id, `${path}.tool_use_id`, 256),
        content,
        is_error: block.is_error === undefined ? false : booleanAt(block.is_error, `${path}.is_error`),
      }
    }
    default:
      fail(`${path}.type`, 'unsupported content block type')
  }
}

function parseToolResultContent(
  value: unknown,
  path: string,
): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof value === 'string') return boundedString(value, path, MAX_TEXT_CHARS)
  return arrayAt(value, path, MAX_CONTENT_BLOCKS).map((block, index) => {
    const blockPath = `${path}[${index}]`
    const object = objectAt(block, blockPath)
    if (object.type === 'text') return parseTextBlock(object, blockPath)
    if (object.type === 'image') return parseImageBlock(object, blockPath)
    fail(`${blockPath}.type`, 'unsupported tool result content block type')
  })
}

function parseImageBlock(value: unknown, path: string): AnthropicImageBlock {
  const block = objectAt(value, path)
  exactKeys(block, ['type', 'source'], path)
  const source = objectAt(block.source, `${path}.source`)
  exactKeys(source, ['type', 'media_type', 'data'], `${path}.source`)
  if (source.type !== 'base64') fail(`${path}.source.type`, 'must be "base64"')
  const mediaType = boundedString(source.media_type, `${path}.source.media_type`, 256)
  if (mediaType !== '' && !/^image\/[A-Za-z0-9.+-]+$/.test(mediaType)) {
    fail(`${path}.source.media_type`, 'must be an image media type')
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: boundedString(source.data, `${path}.source.data`, MAX_TEXT_CHARS),
    },
  }
}

function parseTool(value: unknown, path: string): AnthropicTool {
  const tool = objectAt(value, path)
  exactKeys(tool, ['name', 'description', 'input_schema'], path)
  return {
    name: nonEmptyString(tool.name, `${path}.name`, 256),
    ...(tool.description === undefined
      ? {}
      : { description: boundedString(tool.description, `${path}.description`, 16_384) }),
    input_schema: jsonObjectAt(tool.input_schema, `${path}.input_schema`),
  }
}

function parseToolChoice(value: unknown, path: string): AnthropicToolChoice {
  const choice = objectAt(value, path)
  if (choice.type === 'tool') {
    exactKeys(choice, ['type', 'name'], path)
    return { type: 'tool', name: nonEmptyString(choice.name, `${path}.name`, 256) }
  }
  exactKeys(choice, ['type'], path)
  if (choice.type !== 'auto' && choice.type !== 'any' && choice.type !== 'none') {
    fail(`${path}.type`, 'must be "auto", "any", "none", or "tool"')
  }
  return { type: choice.type }
}

function messageToResponsesItems(message: AnthropicMessage): Array<Record<string, unknown>> {
  if (typeof message.content === 'string') {
    return [{
      type: 'message',
      role: message.role,
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }],
    }]
  }
  if (message.role === 'assistant') {
    const result: Array<Record<string, unknown>> = []
    const text = message.content
      .filter((block): block is AnthropicTextBlock => block.type === 'text')
      .map((block) => block.text)
      .filter(Boolean)
      .join('\n\n')
    if (text !== '') {
      result.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
    }
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        result.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
      }
    }
    return result
  }

  const result: Array<Record<string, unknown>> = []
  const liftedImages: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      result.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: toolResultText(block.content),
      })
      liftedImages.push(...toolResultImages(block.content).map((imageUrl) => ({
        type: 'input_image',
        image_url: imageUrl,
      })))
    }
  }
  const userParts: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') {
      userParts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      const imageUrl = anthropicImageDataUrl(block)
      if (imageUrl !== undefined) userParts.push({ type: 'input_image', image_url: imageUrl })
    }
  }
  userParts.push(...liftedImages)
  if (userParts.length > 0) {
    result.push({
      type: 'message',
      role: 'user',
      content: userParts,
    })
  }
  return result
}

function messageToChatMessages(message: AnthropicMessage): Array<Record<string, unknown>> {
  if (typeof message.content === 'string') return [{ role: message.role, content: message.content }]
  if (message.role === 'assistant') {
    const text = message.content
      .filter((block): block is AnthropicTextBlock => block.type === 'text')
      .map((block) => block.text)
      .filter(Boolean)
      .join('\n\n')
    const toolCalls = message.content
      .filter((block): block is AnthropicToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }))
    return [{
      role: 'assistant',
      ...(text === '' ? {} : { content: text }),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    }]
  }
  const result: Array<Record<string, unknown>> = []
  const liftedImages: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      result.push({ role: 'tool', content: toolResultText(block.content), tool_call_id: block.tool_use_id })
      liftedImages.push(...toolResultImages(block.content).map((url) => ({
        type: 'image_url',
        image_url: { url },
      })))
    }
  }
  const userParts: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') {
      userParts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const url = anthropicImageDataUrl(block)
      if (url !== undefined) userParts.push({ type: 'image_url', image_url: { url } })
    }
  }
  userParts.push(...liftedImages)
  if (userParts.some((part) => part.type === 'image_url')) {
    result.push({ role: 'user', content: userParts })
  } else {
    const text = userParts
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n\n')
    if (text !== '') result.push({ role: 'user', content: text })
  }
  return result
}

function toolResultText(content: string | Array<AnthropicTextBlock | AnthropicImageBlock>): string {
  if (typeof content === 'string') return content === '' ? '(empty)' : content
  const text = content
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n\n')
  return text === '' ? '(empty)' : text
}

function toolResultImages(
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>,
): string[] {
  if (typeof content === 'string') return []
  return content
    .filter((block): block is AnthropicImageBlock => block.type === 'image')
    .map(anthropicImageDataUrl)
    .filter((value): value is string => value !== undefined)
}

function anthropicImageDataUrl(block: AnthropicImageBlock): string | undefined {
  if (block.source.data === '') return undefined
  const mediaType = block.source.media_type === '' ? 'image/png' : block.source.media_type
  return `data:${mediaType};base64,${block.source.data}`
}

function responsesToolChoice(
  choice: AnthropicToolChoice,
  declared: Set<string>,
): string | Record<string, unknown> {
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (!('name' in choice) || !declared.has(choice.name)) fail('$.tool_choice.name', 'must name a declared tool')
  return { type: 'function', name: choice.name }
}

function chatToolChoice(
  choice: AnthropicToolChoice,
  declared: Set<string>,
): string | Record<string, unknown> {
  if (choice.type !== 'tool') return responsesToolChoice(choice, declared)
  if (!('name' in choice) || !declared.has(choice.name)) fail('$.tool_choice.name', 'must name a declared tool')
  return { type: 'function', function: { name: choice.name } }
}

function responsesUsage(value: unknown): AnthropicUsage {
  if (value === undefined || value === null) return emptyUsage()
  const usage = objectAt(value, 'response.usage')
  const input = nonNegativeIntegerOrZero(usage.input_tokens)
  const output = nonNegativeIntegerOrZero(usage.output_tokens)
  const details = usage.input_tokens_details === undefined
    ? undefined
    : objectAt(usage.input_tokens_details, 'response.usage.input_tokens_details')
  const cached = nonNegativeIntegerOrZero(details?.cached_tokens)
  const cacheCreation = Math.max(
    nonNegativeIntegerOrZero(usage.cache_creation_input_tokens),
    nonNegativeIntegerOrZero(details?.cache_write_tokens),
    nonNegativeIntegerOrZero(details?.cache_creation_tokens),
  )
  return {
    input_tokens: Math.max(0, input - cached - cacheCreation),
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cached,
  }
}

function chatUsage(value: unknown): AnthropicUsage {
  if (value === undefined || value === null) return emptyUsage()
  const usage = objectAt(value, 'response.usage')
  const details = usage.prompt_tokens_details === undefined
    ? undefined
    : objectAt(usage.prompt_tokens_details, 'response.usage.prompt_tokens_details')
  const cached = nonNegativeIntegerOrZero(details?.cached_tokens)
  const cacheCreation = Math.max(
    nonNegativeIntegerOrZero(details?.cache_write_tokens),
    nonNegativeIntegerOrZero(details?.cache_creation_tokens),
  )
  return {
    input_tokens: Math.max(0, nonNegativeIntegerOrZero(usage.prompt_tokens) - cached - cacheCreation),
    output_tokens: nonNegativeIntegerOrZero(usage.completion_tokens),
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cached,
  }
}

function emptyUsage(): AnthropicUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function nonNegativeIntegerOrZero(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

function parseArgumentsObject(value: unknown): JsonObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return jsonObjectAt(value, 'arguments')
  }
  if (typeof value !== 'string' || value.length > MAX_JSON_CHARS) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {}
  } catch {
    return {}
  }
}

function customToolInputObject(value: unknown, path: string): JsonObject {
  if (value === undefined || value === null) return { input: '' }
  return { input: boundedString(value, path, MAX_JSON_CHARS) }
}

function responsesToolName(item: JsonObject, path: string): string {
  const name = safeIdentifier(item.name, `${path}.name`, 'tool')
  if (item.namespace === undefined) return name
  const namespace = safeIdentifier(item.namespace, `${path}.namespace`, 'namespace')
  return flattenNamespaceToolName(namespace, name)
}

function safeIdentifier(value: unknown, path: string, prefix: string): string {
  if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value
  return `${prefix}_${crypto.randomUUID()}`
}

function systemParts(system: AnthropicSystem | undefined): Array<{ type: 'input_text'; text: string }> {
  if (system === undefined) return []
  const blocks = typeof system === 'string' ? [{ type: 'text' as const, text: system }] : system
  return blocks
    .filter((block) => block.text.length > 0 && !block.text.startsWith(BILLING_HEADER_PREFIX))
    .map((block) => ({ type: 'input_text' as const, text: block.text }))
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unknown !== undefined) fail(`${path}.${unknown}`, 'unknown field')
}

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  return value as JsonObject
}

function jsonObjectAt(value: unknown, path: string): JsonObject {
  const object = objectAt(value, path)
  let serialized: string
  try {
    serialized = JSON.stringify(object)
  } catch {
    fail(path, 'must be JSON serializable')
  }
  if (serialized.length > MAX_JSON_CHARS) fail(path, `must contain at most ${MAX_JSON_CHARS} JSON characters`)
  const projected = JSON.parse(serialized) as unknown
  return objectAt(projected, path)
}

function arrayAt(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > maximum) fail(path, `must contain at most ${maximum} items`)
  return value
}

function nonEmptyString(value: unknown, path: string, maximum: number): string {
  const result = boundedString(value, path, maximum)
  if (result.trim().length === 0) fail(path, 'must not be empty')
  return result
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.length > maximum) fail(path, `must contain at most ${maximum} characters`)
  return value
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function integerInRange(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function numberInRange(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `must be a finite number between ${minimum} and ${maximum}`)
  }
  return value
}

function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message)
}
