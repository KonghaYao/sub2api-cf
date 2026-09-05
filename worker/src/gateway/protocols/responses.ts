/**
 * Strict, dependency-free codec for routing an OpenAI Responses request to a
 * Chat Completions-only upstream. It deliberately projects an allow-listed
 * wire shape: caller-owned objects are never spread into an upstream request.
 */

type JsonObject = Record<string, unknown>

const MAX_INPUT_ITEMS = 2_000
const MAX_CONTENT_PARTS = 1_000
const MAX_TOOLS = 256
const MAX_TEXT_CHARS = 4_000_000
const MAX_JSON_CHARS = 4_000_000
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/

export class ResponsesBridgeError extends Error {
  readonly code = 'invalid_request_error'

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'ResponsesBridgeError'
  }
}

export interface ResponsesMessageItem {
  type: 'message'
  role: 'developer' | 'system' | 'user' | 'assistant'
  content: string | ResponsesTextPart[]
}

export interface ResponsesTextPart {
  type: 'input_text' | 'output_text'
  text: string
}

export interface ResponsesReasoningItem {
  type: 'reasoning'
  id?: string
  summary: Array<{ type: 'summary_text'; text: string }>
  encrypted_content?: string
}

export interface ResponsesFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

export interface ResponsesIgnoredServerItem {
  type: 'web_search_call' | 'file_search_call' | 'computer_call' | 'image_generation_call'
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesReasoningItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesIgnoredServerItem

export interface ResponsesFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: JsonObject
  strict: boolean
  source_type?: 'custom' | 'namespace'
  namespace?: string
  source_name?: string
}

export interface ResponsesNamespaceToolName {
  namespace: string
  name: string
}

export interface ResponsesToolMapping {
  custom_tools: Record<string, true>
  function_tools: Record<string, true>
  namespace_tools: Record<string, ResponsesNamespaceToolName>
}

export interface ParsedResponsesRequest {
  model: string
  instructions?: string
  input: string | ResponsesInputItem[]
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream: boolean
  tools?: ResponsesFunctionTool[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string }
  parallel_tool_calls?: boolean
  reasoning?: { effort: string; summary?: string }
  text?: { format?: JsonObject }
  service_tier?: string
  tool_mapping?: ResponsesToolMapping
}

export interface ChatCompletionsRequest {
  model: string
  messages: Array<Record<string, unknown>>
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stream: boolean
  stream_options?: { include_usage: true }
  tools?: Array<Record<string, unknown>>
  tool_choice?: string | Record<string, unknown>
  parallel_tool_calls?: boolean
  reasoning_effort?: string
  response_format?: JsonObject
  service_tier?: string
}

export interface ResponsesOutputItem extends JsonObject {
  type: 'reasoning' | 'message' | 'function_call' | 'custom_tool_call'
  id: string
  status: 'completed'
  role?: 'assistant'
  content?: Array<
    | { type: 'output_text'; text: string }
    | { type: 'refusal'; refusal: string }
  >
  summary?: Array<{ type: 'summary_text'; text: string }>
  call_id?: string
  name?: string
  arguments?: string
  input?: string
  namespace?: string
}

export interface ConvertedResponsesResponse extends JsonObject {
  id: string
  object: 'response'
  created_at: number
  model: string
  status: 'completed' | 'incomplete'
  output: ResponsesOutputItem[]
  incomplete_details?: { reason: 'max_output_tokens' | 'content_filter' }
  service_tier?: string
  usage?: JsonObject
}

export interface ResponsesSseEvent extends JsonObject {
  type: string
  sequence_number: number
  response?: JsonObject
  item?: JsonObject
  output_index?: number
  content_index?: number
  summary_index?: number
  item_id?: string
  delta?: string
  text?: string
  refusal?: string
  arguments?: string
  call_id?: string
  name?: string
  part?: JsonObject
}

interface ParsedChatChunk {
  id?: string
  created?: number
  serviceTier?: string
  choices: Array<{
    delta: {
      content?: string | null
      refusal?: string | null
      reasoning?: string | null
      toolCalls: Array<{
        index: number
        id?: string
        name?: string
        arguments?: string
      }>
    }
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: JsonObject
}

interface StreamTool {
  id?: string
  itemId?: string
  upstreamName?: string
  name?: string
  namespace?: string
  kind?: 'function' | 'custom' | 'namespace'
  arguments: string
  announced: boolean
  outputIndex: number
}

interface ChatMessage extends JsonObject {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  reasoning_content?: string
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export function parseResponsesRequest(value: unknown): ParsedResponsesRequest {
  const root = objectAt(value, '$')
  exactKeys(root, [
    'model',
    'instructions',
    'input',
    'max_output_tokens',
    'temperature',
    'top_p',
    'stream',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'text',
    'service_tier',
    'store',
    'include',
    'previous_response_id',
  ], '$')

  if (root.previous_response_id !== undefined && root.previous_response_id !== null) {
    fail('$.previous_response_id', 'cannot be represented by a Chat Completions upstream')
  }
  if (root.store !== undefined && root.store !== false) {
    fail('$.store', 'must be false for a Chat Completions upstream')
  }
  if (root.include !== undefined) {
    const include = arrayAt(root.include, '$.include', 16)
      .map((item, index) => stringAt(item, `$.include[${index}]`, 128))
    if (include.some((item) => item !== 'reasoning.encrypted_content')) {
      fail('$.include', 'contains an unsupported include value')
    }
  }

  const model = nonEmptyString(root.model, '$.model', 256)
  const input = parseResponsesInput(root.input, '$.input')
  const instructions = root.instructions === undefined
    ? undefined
    : stringAt(root.instructions, '$.instructions', MAX_TEXT_CHARS)
  const maxOutputTokens = root.max_output_tokens === undefined
    ? undefined
    : positiveInteger(root.max_output_tokens, '$.max_output_tokens')
  const temperature = root.temperature === undefined
    ? undefined
    : finiteNumberInRange(root.temperature, '$.temperature', -2, 2)
  const topP = root.top_p === undefined
    ? undefined
    : finiteNumberInRange(root.top_p, '$.top_p', 0, 1)
  const stream = root.stream === undefined ? false : booleanAt(root.stream, '$.stream')
  const declaredTools = root.tools === undefined
    ? []
    : arrayAt(root.tools, '$.tools', MAX_TOOLS)
  const effectiveTools = [...declaredTools, ...additionalResponsesTools(root.input, '$.input')]
  const tools = effectiveTools.length === 0 ? undefined : parseTools(effectiveTools, '$.tools')
  const toolMapping = tools === undefined ? undefined : responsesToolMapping(tools)
  const toolChoice = root.tool_choice === undefined
    ? undefined
    : parseToolChoice(root.tool_choice, '$.tool_choice')
  const parallelToolCalls = root.parallel_tool_calls === undefined
    ? undefined
    : booleanAt(root.parallel_tool_calls, '$.parallel_tool_calls')
  const reasoning = root.reasoning === undefined
    ? undefined
    : parseReasoning(root.reasoning, '$.reasoning')
  const text = root.text === undefined ? undefined : parseTextConfig(root.text, '$.text')
  const serviceTier = root.service_tier === undefined
    ? undefined
    : parseServiceTier(root.service_tier, '$.service_tier')

  if (typeof toolChoice === 'object') {
    if (tools === undefined || !tools.some((tool) => tool.name === toolChoice.name)) {
      fail('$.tool_choice.name', 'must name a declared function tool')
    }
  }
  if (toolChoice === 'required' && (tools === undefined || tools.length === 0)) {
    fail('$.tool_choice', 'requires at least one function tool')
  }

  return {
    model,
    ...(instructions === undefined ? {} : { instructions }),
    input,
    ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    stream,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(text === undefined ? {} : { text }),
    ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    ...(toolMapping === undefined ? {} : { tool_mapping: toolMapping }),
  }
}

export function responsesToChatCompletionsRequest(
  request: ParsedResponsesRequest,
  upstreamModel: string,
): ChatCompletionsRequest {
  const messages = responsesInputToChatMessages(request.instructions, request.input)

  const result: ChatCompletionsRequest = {
    model: nonEmptyString(upstreamModel, 'upstreamModel', 256),
    messages,
    ...(request.max_output_tokens === undefined
      ? {}
      : { max_completion_tokens: request.max_output_tokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true as const } } : {}),
    ...(request.service_tier === undefined ? {} : { service_tier: request.service_tier }),
    ...(request.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: request.parallel_tool_calls }),
    ...(request.reasoning === undefined ? {} : { reasoning_effort: request.reasoning.effort }),
  }
  if (request.text?.format !== undefined) {
    result.response_format = responsesFormatToChat(request.text.format)
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    result.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.parameters,
        strict: tool.strict,
      },
    }))
  }
  if (request.tool_choice !== undefined && result.tools !== undefined) {
    result.tool_choice = typeof request.tool_choice === 'string'
      ? request.tool_choice
      : { type: 'function', function: { name: request.tool_choice.name } }
  }
  return result
}

export function chatCompletionsResponseToResponses(
  value: unknown,
  publicModel: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
  toolMapping?: ResponsesToolMapping,
): ConvertedResponsesResponse {
  const response = objectAt(value, '$')
  exactKeys(response, [
    'id', 'object', 'created', 'model', 'choices', 'usage', 'service_tier', 'system_fingerprint',
  ], '$')
  const responseId = response.id === undefined || response.id === ''
    ? generatedId('resp')
    : nonEmptyString(response.id, '$.id', 256)
  const created = response.created === undefined || response.created === 0
    ? nowSeconds
    : nonNegativeInteger(response.created, '$.created')
  const model = nonEmptyString(publicModel, 'publicModel', 256)
  const choices = arrayAt(response.choices, '$.choices', 16)
  if (choices.length > 1) fail('$.choices', 'multiple choices cannot be represented by one Responses output')

  let status: ConvertedResponsesResponse['status'] = 'completed'
  let incompleteReason: 'max_output_tokens' | 'content_filter' | undefined
  const output: ResponsesOutputItem[] = []
  if (choices.length === 1) {
    const choice = objectAt(choices[0], '$.choices[0]')
    exactKeys(choice, ['index', 'message', 'finish_reason', 'logprobs'], '$.choices[0]')
    nonNegativeInteger(choice.index, '$.choices[0].index')
    const finishReason = enumString(choice.finish_reason, '$.choices[0].finish_reason', [
      'stop', 'length', 'tool_calls', 'content_filter',
    ])
    if (finishReason === 'length' || finishReason === 'content_filter') {
      status = 'incomplete'
      incompleteReason = finishReason === 'length' ? 'max_output_tokens' : 'content_filter'
    }
    output.push(...chatMessageToResponsesOutput(choice.message, '$.choices[0].message', toolMapping))
  }
  if (output.length === 0) output.push(responsesMessageOutput(''))

  const serviceTier = response.service_tier === undefined
    ? undefined
    : nonEmptyString(response.service_tier, '$.service_tier', 64)
  const usage = response.usage === undefined || response.usage === null
    ? undefined
    : chatUsageToResponsesUsage(response.usage, '$.usage')
  return {
    id: responseId,
    object: 'response',
    created_at: created,
    model,
    status,
    ...(incompleteReason === undefined
      ? {}
      : { incomplete_details: { reason: incompleteReason } }),
    ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    output,
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Stateful Chat Completions chunk → Responses event adapter. Call push for
 * every decoded `data:` JSON payload, then finish when `[DONE]` or EOF arrives.
 */
export class ChatCompletionsToResponsesEventCodec {
  private responseId = generatedId('resp')
  private readonly model: string
  private createdAt: number
  private serviceTier: string | undefined
  private sequence = 0
  private nextOutputIndex = 0
  private createdSent = false
  private terminalSent = false
  private finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | undefined
  private usageValue: JsonObject | undefined

  private reasoningItemId: string | undefined
  private reasoningIndex: number | undefined
  private reasoningOpen = false
  private reasoningDone = false
  private reasoning = ''

  private messageItemId: string | undefined
  private messageIndex: number | undefined
  private textPartOpen = false
  private textContentIndex: number | undefined
  private text = ''
  private refusalPartOpen = false
  private refusalContentIndex: number | undefined
  private refusal = ''
  private nextContentIndex = 0

  private readonly tools = new Map<number, StreamTool>()

  constructor(
    publicModel: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
    private readonly toolMapping?: ResponsesToolMapping,
  ) {
    this.model = nonEmptyString(publicModel, 'publicModel', 256)
    this.createdAt = nonNegativeInteger(nowSeconds, 'nowSeconds')
  }

  push(value: unknown): ResponsesSseEvent[] {
    if (this.terminalSent) return []
    const root = objectAt(value, '$')
    if (root.error !== undefined) return this.pushError(root)

    const chunk = parseChatChunk(root)
    if (chunk.id !== undefined) this.responseId = chunk.id
    if (chunk.created !== undefined && chunk.created > 0) this.createdAt = chunk.created
    if (chunk.serviceTier !== undefined) this.serviceTier = chunk.serviceTier
    if (chunk.usage !== undefined) this.usageValue = chunk.usage

    const events = this.ensureCreated()
    for (const choice of chunk.choices) {
      const reasoning = choice.delta.reasoning
      if (reasoning !== undefined && reasoning !== null && reasoning !== '') {
        events.push(...this.ensureReasoningItem())
        this.reasoning += reasoning
        events.push(this.event('response.reasoning_summary_text.delta', {
          output_index: this.reasoningIndex!,
          summary_index: 0,
          item_id: this.reasoningItemId!,
          delta: reasoning,
        }))
      }
      const content = choice.delta.content
      if (content !== undefined && content !== null && content !== '') {
        events.push(...this.closeReasoningItem())
        events.push(...this.ensureMessageItem(), ...this.ensureTextPart())
        this.text += content
        events.push(this.event('response.output_text.delta', {
          output_index: this.messageIndex!,
          content_index: this.textContentIndex!,
          item_id: this.messageItemId!,
          delta: content,
        }))
      }
      const refusal = choice.delta.refusal
      if (refusal !== undefined && refusal !== null && refusal !== '') {
        events.push(...this.closeReasoningItem())
        events.push(...this.ensureMessageItem(), ...this.ensureRefusalPart())
        this.refusal += refusal
        events.push(this.event('response.refusal.delta', {
          output_index: this.messageIndex!,
          content_index: this.refusalContentIndex!,
          item_id: this.messageItemId!,
          delta: refusal,
        }))
      }
      for (const delta of choice.delta.toolCalls) {
        events.push(...this.closeReasoningItem())
        let tool = this.tools.get(delta.index)
        if (tool === undefined) {
          tool = {
            id: delta.id,
            upstreamName: delta.name,
            arguments: '',
            announced: false,
            outputIndex: this.allocateOutputIndex(),
          }
          this.tools.set(delta.index, tool)
        } else {
          if (delta.id !== undefined && tool.id !== undefined && delta.id !== tool.id) {
            fail('$.choices[].delta.tool_calls[].id', `changed from '${tool.id}' to '${delta.id}'`)
          }
          if (
            delta.name !== undefined &&
            tool.upstreamName !== undefined &&
            delta.name !== tool.upstreamName
          ) {
            fail(
              '$.choices[].delta.tool_calls[].function.name',
              `changed from '${tool.upstreamName}' to '${delta.name}'`,
            )
          }
          if (delta.id !== undefined) tool.id = delta.id
          if (delta.name !== undefined) tool.upstreamName = delta.name
        }
        if (delta.arguments !== undefined && delta.arguments !== '') {
          tool.arguments += delta.arguments
        }
        if (!tool.announced && tool.id !== undefined && tool.upstreamName !== undefined) {
          events.push(...this.announceTool(tool))
        } else if (
          tool.announced &&
          tool.kind !== 'custom' &&
          delta.arguments !== undefined &&
          delta.arguments !== ''
        ) {
          events.push(this.functionArgumentsDelta(tool, delta.arguments))
        }
      }
      if (choice.finishReason !== undefined && choice.finishReason !== null) {
        this.finishReason = choice.finishReason
      }
    }
    return events
  }

  finish(): ResponsesSseEvent[] {
    if (this.terminalSent) return []
    for (const tool of this.tools.values()) {
      if (!tool.announced || tool.id === undefined || tool.upstreamName === undefined) {
        fail('stream.tool_calls', 'tool call ended before its id and name were received')
      }
      const args = tool.arguments.trim() === '' ? '{}' : tool.arguments
      if (tool.kind !== 'custom' && !isJsonObjectString(args)) {
        fail('stream.tool_calls', `tool call '${tool.id}' arguments contain invalid JSON`)
      }
    }

    const events = this.ensureCreated()
    events.push(...this.closeReasoningItem())
    if (
      this.messageItemId === undefined &&
      this.tools.size === 0 &&
      this.reasoning.trim() !== ''
    ) {
      events.push(...this.ensureMessageItem(), ...this.ensureTextPart())
      this.text = this.reasoning
      events.push(this.event('response.output_text.delta', {
        output_index: this.messageIndex!,
        content_index: 0,
        item_id: this.messageItemId!,
        delta: this.text,
      }))
    } else if (this.messageItemId === undefined && this.tools.size === 0) {
      events.push(...this.ensureMessageItem(), ...this.ensureTextPart())
    }
    events.push(...this.closeMessageItem(), ...this.closeToolItems())

    const incompleteReason = this.finishReason === 'length'
      ? 'max_output_tokens'
      : this.finishReason === 'content_filter'
        ? 'content_filter'
        : undefined
    const status = incompleteReason === undefined ? 'completed' : 'incomplete'
    this.terminalSent = true
    events.push(this.event(status === 'incomplete' ? 'response.incomplete' : 'response.completed', {
      response: this.responseShape(status, this.outputShape(), incompleteReason),
    }))
    return events
  }

  private pushError(root: JsonObject): ResponsesSseEvent[] {
    exactKeys(root, ['error'], '$')
    const error = objectAt(root.error, '$.error')
    exactKeys(error, ['type', 'code', 'message', 'param'], '$.error')
    const code = typeof error.code === 'string' && error.code.trim() !== ''
      ? nonEmptyString(error.code, '$.error.code', 128)
      : typeof error.type === 'string' && error.type.trim() !== ''
        ? nonEmptyString(error.type, '$.error.type', 128)
        : 'upstream_error'
    const message = nonEmptyString(error.message, '$.error.message', 16_384)
    const events = this.ensureCreated()
    this.terminalSent = true
    events.push(this.event('response.failed', {
      response: {
        ...this.responseShape('failed', this.outputShape()),
        error: { code, message },
      },
    }))
    return events
  }

  private ensureCreated(): ResponsesSseEvent[] {
    if (this.createdSent) return []
    this.createdSent = true
    return [this.event('response.created', {
      response: this.responseShape('in_progress', []),
    })]
  }

  private ensureReasoningItem(): ResponsesSseEvent[] {
    if (this.reasoningOpen || this.reasoningDone) return []
    this.reasoningOpen = true
    this.reasoningItemId = generatedId('rs')
    this.reasoningIndex = this.allocateOutputIndex()
    return [
      this.event('response.output_item.added', {
        output_index: this.reasoningIndex,
        item: {
          type: 'reasoning',
          id: this.reasoningItemId,
          status: 'in_progress',
          summary: [],
        },
      }),
      this.event('response.reasoning_summary_part.added', {
        output_index: this.reasoningIndex,
        summary_index: 0,
        item_id: this.reasoningItemId,
        part: { type: 'summary_text', text: '' },
      }),
    ]
  }

  private closeReasoningItem(): ResponsesSseEvent[] {
    if (!this.reasoningOpen) return []
    this.reasoningOpen = false
    this.reasoningDone = true
    return [
      this.event('response.reasoning_summary_text.done', {
        output_index: this.reasoningIndex!,
        summary_index: 0,
        item_id: this.reasoningItemId!,
        text: this.reasoning,
      }),
      this.event('response.reasoning_summary_part.done', {
        output_index: this.reasoningIndex!,
        summary_index: 0,
        item_id: this.reasoningItemId!,
        part: { type: 'summary_text', text: this.reasoning },
      }),
      this.event('response.output_item.done', {
        output_index: this.reasoningIndex!,
        item: this.reasoningOutput(),
      }),
    ]
  }

  private ensureMessageItem(): ResponsesSseEvent[] {
    if (this.messageItemId !== undefined) return []
    this.messageItemId = generatedId('msg')
    this.messageIndex = this.allocateOutputIndex()
    return [this.event('response.output_item.added', {
      output_index: this.messageIndex,
      item: {
        type: 'message',
        id: this.messageItemId,
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    })]
  }

  private ensureTextPart(): ResponsesSseEvent[] {
    if (this.textPartOpen) return []
    this.textPartOpen = true
    this.textContentIndex = this.nextContentIndex
    this.nextContentIndex += 1
    return [this.event('response.content_part.added', {
      output_index: this.messageIndex!,
      content_index: this.textContentIndex,
      item_id: this.messageItemId!,
      part: { type: 'output_text', text: '' },
    })]
  }

  private ensureRefusalPart(): ResponsesSseEvent[] {
    if (this.refusalPartOpen) return []
    this.refusalPartOpen = true
    this.refusalContentIndex = this.nextContentIndex
    this.nextContentIndex += 1
    return [this.event('response.content_part.added', {
      output_index: this.messageIndex!,
      content_index: this.refusalContentIndex,
      item_id: this.messageItemId!,
      part: { type: 'refusal', refusal: '' },
    })]
  }

  private closeMessageItem(): ResponsesSseEvent[] {
    if (this.messageItemId === undefined) return []
    const events: ResponsesSseEvent[] = []
    const completedParts: Array<{ index: number; type: 'text' | 'refusal' }> = []
    if (this.textPartOpen && this.textContentIndex !== undefined) {
      completedParts.push({ index: this.textContentIndex, type: 'text' })
    }
    if (this.refusalPartOpen && this.refusalContentIndex !== undefined) {
      completedParts.push({ index: this.refusalContentIndex, type: 'refusal' })
    }
    for (const part of completedParts.sort((left, right) => left.index - right.index)) {
      if (part.type === 'text') {
        events.push(
          this.event('response.output_text.done', {
            output_index: this.messageIndex!,
            content_index: part.index,
            item_id: this.messageItemId,
            text: this.text,
          }),
          this.event('response.content_part.done', {
            output_index: this.messageIndex!,
            content_index: part.index,
            item_id: this.messageItemId,
            part: { type: 'output_text', text: this.text },
          }),
        )
      } else {
        events.push(
          this.event('response.refusal.done', {
            output_index: this.messageIndex!,
            content_index: part.index,
            item_id: this.messageItemId,
            refusal: this.refusal,
          }),
          this.event('response.content_part.done', {
            output_index: this.messageIndex!,
            content_index: part.index,
            item_id: this.messageItemId,
            part: { type: 'refusal', refusal: this.refusal },
          }),
        )
      }
    }
    events.push(this.event('response.output_item.done', {
      output_index: this.messageIndex!,
      item: this.messageOutput(),
    }))
    return events
  }

  private closeToolItems(): ResponsesSseEvent[] {
    const events: ResponsesSseEvent[] = []
    for (const [, tool] of [...this.tools.entries()].sort(([left], [right]) => left - right)) {
      const args = tool.arguments.trim() === '' ? '{}' : tool.arguments
      if (tool.kind === 'custom') {
        const input = customToolInput(tool.arguments)
        if (input !== '') {
          events.push(this.event('response.custom_tool_call_input.delta', {
            output_index: tool.outputIndex,
            item_id: tool.itemId!,
            call_id: tool.id!,
            name: tool.name!,
            delta: input,
          }))
        }
        events.push(
          this.event('response.custom_tool_call_input.done', {
            output_index: tool.outputIndex,
            item_id: tool.itemId!,
            call_id: tool.id!,
            name: tool.name!,
            input,
          }),
          this.event('response.output_item.done', {
            output_index: tool.outputIndex,
            item: this.toolOutput(tool),
          }),
        )
        continue
      }
      events.push(
        this.event('response.function_call_arguments.done', {
          output_index: tool.outputIndex,
          item_id: tool.itemId!,
          call_id: tool.id!,
          name: tool.name!,
          arguments: args,
        }),
        this.event('response.output_item.done', {
          output_index: tool.outputIndex,
          item: this.toolOutput(tool),
        }),
      )
    }
    return events
  }

  private outputShape(): JsonObject[] {
    const indexed: Array<[number, JsonObject]> = []
    if (this.reasoningItemId !== undefined) indexed.push([this.reasoningIndex!, this.reasoningOutput()])
    if (this.messageItemId !== undefined) indexed.push([this.messageIndex!, this.messageOutput()])
    for (const tool of this.tools.values()) indexed.push([tool.outputIndex, this.toolOutput(tool)])
    return indexed.sort(([left], [right]) => left - right).map(([, item]) => item)
  }

  private reasoningOutput(): JsonObject {
    return {
      type: 'reasoning',
      id: this.reasoningItemId!,
      status: 'completed',
      summary: [{ type: 'summary_text', text: this.reasoning }],
    }
  }

  private messageOutput(): JsonObject {
    const content: Array<[number, JsonObject]> = []
    if (this.textContentIndex !== undefined) {
      content.push([this.textContentIndex, { type: 'output_text', text: this.text }])
    }
    if (this.refusalContentIndex !== undefined) {
      content.push([this.refusalContentIndex, { type: 'refusal', refusal: this.refusal }])
    }
    return {
      type: 'message',
      id: this.messageItemId!,
      role: 'assistant',
      status: 'completed',
      content: content.sort(([left], [right]) => left - right).map(([, part]) => part),
    }
  }

  private toolOutput(tool: StreamTool): JsonObject {
    if (tool.kind === 'custom') {
      return {
        type: 'custom_tool_call',
        id: tool.itemId!,
        call_id: tool.id!,
        name: tool.name!,
        input: customToolInput(tool.arguments),
        status: 'completed',
      }
    }
    return {
      type: 'function_call',
      id: tool.itemId!,
      call_id: tool.id!,
      name: tool.name!,
      ...(tool.kind === 'namespace' ? { namespace: tool.namespace! } : {}),
      arguments: tool.arguments.trim() === '' ? '{}' : tool.arguments,
      status: 'completed',
    }
  }

  private announceTool(tool: StreamTool): ResponsesSseEvent[] {
    const identity = restoredToolIdentity(tool.upstreamName!, this.toolMapping)
    tool.kind = identity.type
    tool.name = identity.name
    if (identity.type === 'namespace') tool.namespace = identity.namespace
    tool.itemId = generatedId(identity.type === 'custom' ? 'ctc' : 'fc')
    tool.announced = true
    const item = identity.type === 'custom'
      ? {
          type: 'custom_tool_call',
          id: tool.itemId,
          call_id: tool.id,
          name: tool.name,
          input: '',
          status: 'in_progress',
        }
      : {
          type: 'function_call',
          id: tool.itemId,
          call_id: tool.id,
          name: tool.name,
          ...(identity.type === 'namespace' ? { namespace: identity.namespace } : {}),
          arguments: '',
          status: 'in_progress',
        }
    const events = [this.event('response.output_item.added', {
      output_index: tool.outputIndex,
      item,
    })]
    if (identity.type !== 'custom' && tool.arguments !== '') {
      events.push(this.functionArgumentsDelta(tool, tool.arguments))
    }
    return events
  }

  private functionArgumentsDelta(tool: StreamTool, delta: string): ResponsesSseEvent {
    return this.event('response.function_call_arguments.delta', {
      output_index: tool.outputIndex,
      item_id: tool.itemId!,
      call_id: tool.id!,
      name: tool.name!,
      delta,
    })
  }

  private responseShape(
    status: 'in_progress' | 'completed' | 'incomplete' | 'failed',
    output: JsonObject[],
    incompleteReason?: string,
  ): JsonObject {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      model: this.model,
      status,
      ...(this.serviceTier === undefined ? {} : { service_tier: this.serviceTier }),
      output,
      ...(incompleteReason === undefined
        ? {}
        : { incomplete_details: { reason: incompleteReason } }),
      ...(this.usageValue === undefined ? {} : { usage: this.usageValue }),
    }
  }

  private allocateOutputIndex(): number {
    const value = this.nextOutputIndex
    this.nextOutputIndex += 1
    return value
  }

  private event(type: string, fields: JsonObject): ResponsesSseEvent {
    const event: ResponsesSseEvent = { type, sequence_number: this.sequence, ...fields }
    this.sequence += 1
    return event
  }
}

export function formatResponsesSseEvent(event: ResponsesSseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function chatMessageToResponsesOutput(
  value: unknown,
  path: string,
  toolMapping?: ResponsesToolMapping,
): ResponsesOutputItem[] {
  const message = objectAt(value, path)
  exactKeys(message, [
    'role', 'content', 'reasoning_content', 'reasoning', 'tool_calls', 'refusal', 'annotations',
  ], path)
  if (message.role !== 'assistant') fail(`${path}.role`, 'must be assistant')
  const content = chatMessageText(message.content, `${path}.content`)
  const refusal = message.refusal === undefined || message.refusal === null
    ? ''
    : stringAt(message.refusal, `${path}.refusal`, MAX_TEXT_CHARS)
  const reasoning = message.reasoning_content !== undefined
    ? stringAt(message.reasoning_content, `${path}.reasoning_content`, MAX_TEXT_CHARS)
    : message.reasoning === undefined
      ? ''
      : stringAt(message.reasoning, `${path}.reasoning`, MAX_TEXT_CHARS)
  const toolCalls = message.tool_calls === undefined
    ? []
    : parseChatToolCalls(message.tool_calls, `${path}.tool_calls`, toolMapping)

  const output: ResponsesOutputItem[] = []
  if (reasoning !== '') {
    output.push({
      type: 'reasoning',
      id: generatedId('rs'),
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoning }],
    })
  }
  const visibleText = content === '' && refusal === '' && reasoning.trim() !== '' && toolCalls.length === 0
    ? reasoning
    : content
  if (visibleText !== '' || refusal !== '' || toolCalls.length === 0) {
    output.push(responsesMessageOutput(visibleText, refusal))
  }
  output.push(...toolCalls)
  return output
}

function parseChatToolCalls(
  value: unknown,
  path: string,
  toolMapping?: ResponsesToolMapping,
): ResponsesOutputItem[] {
  const output: ResponsesOutputItem[] = []
  for (const [index, raw] of arrayAt(value, path, MAX_TOOLS).entries()) {
    const itemPath = `${path}[${index}]`
    const call = objectAt(raw, itemPath)
    exactKeys(call, ['index', 'id', 'type', 'function'], itemPath)
    if (call.type !== 'function') continue
    const fn = objectAt(call.function, `${itemPath}.function`)
    exactKeys(fn, ['name', 'arguments'], `${itemPath}.function`)
    const callId = nonEmptyString(call.id, `${itemPath}.id`, 256)
    const name = validName(fn.name, `${itemPath}.function.name`)
    const argumentsValue = stringAt(fn.arguments, `${itemPath}.function.arguments`, MAX_JSON_CHARS)
    const identity = restoredToolIdentity(name, toolMapping)
    if (identity.type === 'custom') {
      output.push({
        type: 'custom_tool_call',
        id: generatedId('ctc'),
        call_id: callId,
        name: identity.name,
        input: customToolInput(argumentsValue),
        status: 'completed',
      })
      continue
    }
    if (!isJsonObjectString(argumentsValue)) continue
    output.push({
      type: 'function_call',
      id: generatedId('fc'),
      call_id: callId,
      name: identity.name,
      ...(identity.type === 'namespace' ? { namespace: identity.namespace } : {}),
      arguments: argumentsValue,
      status: 'completed',
    })
  }
  return output
}

function parseChatChunk(root: JsonObject): ParsedChatChunk {
  exactKeys(root, [
    'id', 'object', 'created', 'model', 'choices', 'usage', 'service_tier', 'system_fingerprint',
  ], '$')
  const id = root.id === undefined || root.id === ''
    ? undefined
    : nonEmptyString(root.id, '$.id', 256)
  const created = root.created === undefined
    ? undefined
    : nonNegativeInteger(root.created, '$.created')
  const serviceTier = root.service_tier === undefined
    ? undefined
    : nonEmptyString(root.service_tier, '$.service_tier', 64)
  const usage = root.usage === undefined || root.usage === null
    ? undefined
    : chatUsageToResponsesUsage(root.usage, '$.usage')
  const choices = arrayAt(root.choices ?? [], '$.choices', 16).map((raw, choiceIndex) => {
    const path = `$.choices[${choiceIndex}]`
    const choice = objectAt(raw, path)
    exactKeys(choice, ['index', 'delta', 'finish_reason', 'logprobs'], path)
    nonNegativeInteger(choice.index, `${path}.index`)
    const delta = objectAt(choice.delta, `${path}.delta`)
    exactKeys(delta, [
      'role', 'content', 'reasoning_content', 'reasoning', 'tool_calls', 'refusal',
    ], `${path}.delta`)
    if (delta.role !== undefined && delta.role !== 'assistant') {
      fail(`${path}.delta.role`, 'must be assistant')
    }
    const content = delta.content === undefined || delta.content === null
      ? delta.content as undefined | null
      : stringAt(delta.content, `${path}.delta.content`, MAX_TEXT_CHARS)
    const refusal = delta.refusal === undefined || delta.refusal === null
      ? delta.refusal as undefined | null
      : stringAt(delta.refusal, `${path}.delta.refusal`, MAX_TEXT_CHARS)
    const reasoningValue = delta.reasoning_content ?? delta.reasoning
    const reasoning = reasoningValue === undefined || reasoningValue === null
      ? reasoningValue as undefined | null
      : stringAt(reasoningValue, `${path}.delta.reasoning_content`, MAX_TEXT_CHARS)
    const toolCalls = delta.tool_calls === undefined
      ? []
      : arrayAt(delta.tool_calls, `${path}.delta.tool_calls`, MAX_TOOLS).map((toolRaw, toolIndex) => {
          const toolPath = `${path}.delta.tool_calls[${toolIndex}]`
          const call = objectAt(toolRaw, toolPath)
          exactKeys(call, ['index', 'id', 'type', 'function'], toolPath)
          const index = call.index === undefined
            ? toolIndex
            : nonNegativeInteger(call.index, `${toolPath}.index`)
          if (call.type !== undefined && call.type !== 'function') {
            fail(`${toolPath}.type`, 'must be function')
          }
          const fn = objectAt(call.function, `${toolPath}.function`)
          exactKeys(fn, ['name', 'arguments'], `${toolPath}.function`)
          return {
            index,
            ...(call.id === undefined || call.id === ''
              ? {}
              : { id: nonEmptyString(call.id, `${toolPath}.id`, 256) }),
            ...(fn.name === undefined || fn.name === ''
              ? {}
              : { name: validName(fn.name, `${toolPath}.function.name`) }),
            ...(fn.arguments === undefined
              ? {}
              : { arguments: stringAt(fn.arguments, `${toolPath}.function.arguments`, MAX_JSON_CHARS) }),
          }
        })
    const finishReason = choice.finish_reason === undefined || choice.finish_reason === null
      ? choice.finish_reason as undefined | null
      : enumString(choice.finish_reason, `${path}.finish_reason`, [
          'stop', 'length', 'tool_calls', 'content_filter',
        ])
    return { delta: { content, refusal, reasoning, toolCalls }, finishReason }
  })
  return {
    ...(id === undefined ? {} : { id }),
    ...(created === undefined ? {} : { created }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    choices,
    ...(usage === undefined ? {} : { usage }),
  }
}

function responsesMessageOutput(text: string, refusal = ''): ResponsesOutputItem {
  const content: NonNullable<ResponsesOutputItem['content']> = []
  if (text !== '' || refusal === '') content.push({ type: 'output_text', text })
  if (refusal !== '') content.push({ type: 'refusal', refusal })
  return {
    type: 'message',
    id: generatedId('msg'),
    role: 'assistant',
    status: 'completed',
    content,
  }
}

function chatMessageText(value: unknown, path: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return stringAt(value, path, MAX_TEXT_CHARS)
  const texts: string[] = []
  for (const [index, raw] of arrayAt(value, path, MAX_CONTENT_PARTS).entries()) {
    const part = objectAt(raw, `${path}[${index}]`)
    exactKeys(part, ['type', 'text'], `${path}[${index}]`)
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
  }
  return texts.join('\n\n')
}

function chatUsageToResponsesUsage(value: unknown, path: string): JsonObject {
  const usage = objectAt(value, path)
  exactKeys(usage, [
    'prompt_tokens', 'completion_tokens', 'total_tokens',
    'prompt_tokens_details', 'completion_tokens_details',
  ], path)
  const inputTokens = nonNegativeInteger(usage.prompt_tokens, `${path}.prompt_tokens`)
  const outputTokens = nonNegativeInteger(usage.completion_tokens, `${path}.completion_tokens`)
  const totalTokens = usage.total_tokens === undefined
    ? inputTokens + outputTokens
    : nonNegativeInteger(usage.total_tokens, `${path}.total_tokens`)
  const inputDetails = usage.prompt_tokens_details === undefined
    ? undefined
    : parseTokenDetails(usage.prompt_tokens_details, `${path}.prompt_tokens_details`, 'input')
  const outputDetails = usage.completion_tokens_details === undefined
    ? undefined
    : parseTokenDetails(usage.completion_tokens_details, `${path}.completion_tokens_details`, 'output')
  const cacheWriteTokens = inputDetails?.cache_write_tokens
  const cacheCreationTokens = cacheWriteTokens ?? inputDetails?.cache_creation_tokens
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(cacheCreationTokens === undefined || cacheCreationTokens === 0
      ? {}
      : { cache_creation_input_tokens: cacheCreationTokens }),
    ...(inputDetails === undefined || Object.keys(inputDetails).length === 0
      ? {}
      : { input_tokens_details: inputDetails }),
    ...(outputDetails === undefined || Object.keys(outputDetails).length === 0
      ? {}
      : { output_tokens_details: outputDetails }),
  }
}

function parseTokenDetails(
  value: unknown,
  path: string,
  side: 'input' | 'output',
): JsonObject {
  const details = objectAt(value, path)
  const allowed = side === 'input'
    ? ['cached_tokens', 'audio_tokens', 'cache_creation_tokens', 'cache_write_tokens']
    : [
        'reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens',
        'rejected_prediction_tokens',
      ]
  exactKeys(details, allowed, path)
  const result: JsonObject = {}
  for (const key of allowed) {
    if (details[key] !== undefined) result[key] = nonNegativeInteger(details[key], `${path}.${key}`)
  }
  return result
}

function generatedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

export function flattenNamespaceToolName(namespace: string, name: string): string {
  const joined = `${namespace}__${name}`
  if (joined.length <= 64) return joined
  let hash = 0x811c9dc5
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${joined.slice(0, 54)}__${hash.toString(16).padStart(8, '0')}`
}

function responsesInputToChatMessages(
  instructions: string | undefined,
  input: string | ResponsesInputItem[],
): ChatMessage[] {
  const built: ChatMessage[] = []
  if (instructions !== undefined && instructions.trim() !== '') {
    built.push({ role: 'system', content: instructions })
  }
  if (typeof input === 'string') {
    built.push({ role: 'user', content: input })
    return built
  }

  let pendingReasoning = ''
  let lastTurnReasoning = ''
  const reasoningForAssistant = (): string | undefined => {
    const value = pendingReasoning || lastTurnReasoning
    return value === '' ? undefined : value
  }

  for (const item of input) {
    if (item.type === 'reasoning') {
      const text = item.summary.map((part) => part.text).filter(Boolean).join('\n')
      pendingReasoning = text
      if (text !== '') lastTurnReasoning = text
      continue
    }
    if (item.type === 'function_call') {
      const call: ChatToolCall = {
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      }
      const previous = built.at(-1)
      if (previous?.role === 'assistant') {
        previous.tool_calls = [...(previous.tool_calls ?? []), call]
        previous.reasoning_content ??= reasoningForAssistant()
      } else {
        built.push({
          role: 'assistant',
          ...(reasoningForAssistant() === undefined
            ? {}
            : { reasoning_content: reasoningForAssistant() }),
          tool_calls: [call],
        })
      }
      pendingReasoning = ''
      continue
    }
    if (item.type === 'function_call_output') {
      built.push({ role: 'tool', tool_call_id: item.call_id, content: item.output })
      pendingReasoning = ''
      continue
    }
    if (item.type !== 'message') {
      pendingReasoning = ''
      continue
    }

    const role = item.role === 'developer' ? 'system' : item.role
    const message: ChatMessage = {
      role,
      content: responsesTextContent(item.content),
    }
    if (role === 'assistant') {
      const reasoning = reasoningForAssistant()
      if (reasoning !== undefined) message.reasoning_content = reasoning
    } else {
      lastTurnReasoning = ''
    }
    pendingReasoning = ''
    built.push(message)
  }

  return normalizeChatToolHistory(built)
}

function normalizeChatToolHistory(messages: ChatMessage[]): ChatMessage[] {
  const replies = new Map<string, ChatMessage>()
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id !== undefined) {
      replies.set(message.tool_call_id, message)
    }
  }

  const normalized: ChatMessage[] = []
  for (const original of messages) {
    if (original.role === 'tool') continue
    if (original.tool_calls === undefined || original.tool_calls.length === 0) {
      normalized.push(original)
      continue
    }
    const answered = original.tool_calls.filter((call) => replies.has(call.id))
    if (answered.length === 0) {
      if ((original.content ?? '').trim() !== '') {
        const { tool_calls: _discarded, ...plain } = original
        normalized.push(plain as ChatMessage)
      }
      continue
    }
    normalized.push({ ...original, tool_calls: answered })
    for (const call of answered) normalized.push(replies.get(call.id)!)
  }
  return normalized
}

function parseResponsesInput(value: unknown, path: string): string | ResponsesInputItem[] {
  if (typeof value === 'string') return stringAt(value, path, MAX_TEXT_CHARS)
  return arrayAt(value, path, MAX_INPUT_ITEMS)
    .flatMap((item, index) => {
      if (typeof item === 'string') {
        return [{
          type: 'message' as const,
          role: 'user' as const,
          content: stringAt(item, `${path}[${index}]`, MAX_TEXT_CHARS),
        }]
      }
      const parsed = parseInputItem(item, `${path}[${index}]`)
      return parsed === null ? [] : [parsed]
    })
}

function parseInputItem(value: unknown, path: string): ResponsesInputItem | null {
  const item = objectAt(value, path)
  const type = item.type === undefined && item.role !== undefined
    ? 'message'
    : nonEmptyString(item.type, `${path}.type`, 64)

  if (type === 'additional_tools') return null

  if (type === 'message') {
    exactKeys(item, ['type', 'role', 'content'], path)
    const role = enumString(item.role, `${path}.role`, ['developer', 'system', 'user', 'assistant'])
    return { type, role, content: parseMessageContent(item.content, `${path}.content`) }
  }
  if (type === 'reasoning') {
    exactKeys(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status'], path)
    const summarySource = item.summary ?? item.content ?? []
    const summary = arrayAt(summarySource, `${path}.summary`, MAX_CONTENT_PARTS)
      .map((part, index) => {
        const parsed = objectAt(part, `${path}.summary[${index}]`)
        exactKeys(parsed, ['type', 'text'], `${path}.summary[${index}]`)
        if (parsed.type !== 'summary_text') fail(`${path}.summary[${index}].type`, 'must be summary_text')
        return {
          type: 'summary_text' as const,
          text: stringAt(parsed.text, `${path}.summary[${index}].text`, MAX_TEXT_CHARS),
        }
      })
    return {
      type,
      ...(item.id === undefined ? {} : { id: nonEmptyString(item.id, `${path}.id`, 256) }),
      summary,
      ...(item.encrypted_content === undefined
        ? {}
        : { encrypted_content: stringAt(item.encrypted_content, `${path}.encrypted_content`, MAX_JSON_CHARS) }),
    }
  }
  if (type === 'function_call') {
    exactKeys(item, ['type', 'id', 'call_id', 'name', 'namespace', 'arguments', 'status'], path)
    const argumentsValue = stringAt(item.arguments, `${path}.arguments`, MAX_JSON_CHARS)
    requireJsonObjectString(argumentsValue, `${path}.arguments`)
    const namespace = item.namespace === undefined
      ? undefined
      : validName(item.namespace, `${path}.namespace`)
    const name = validName(item.name, `${path}.name`)
    return {
      type,
      call_id: nonEmptyString(item.call_id, `${path}.call_id`, 256),
      name: namespace === undefined ? name : flattenNamespaceToolName(namespace, name),
      arguments: argumentsValue,
    }
  }
  if (type === 'function_call_output') {
    exactKeys(item, ['type', 'id', 'call_id', 'output', 'status'], path)
    return {
      type,
      call_id: nonEmptyString(item.call_id, `${path}.call_id`, 256),
      output: toolOutputText(item.output, `${path}.output`),
    }
  }
  if (type === 'custom_tool_call') {
    const input = stringAt(item.input, `${path}.input`, MAX_TEXT_CHARS)
    return {
      type: 'function_call',
      call_id: nonEmptyString(item.call_id, `${path}.call_id`, 256),
      name: validName(item.name, `${path}.name`),
      arguments: JSON.stringify({ input }),
    }
  }
  if (type === 'custom_tool_call_output') {
    return {
      type: 'function_call_output',
      call_id: nonEmptyString(item.call_id, `${path}.call_id`, 256),
      output: toolOutputText(item.output, `${path}.output`),
    }
  }
  if (
    type === 'web_search_call' ||
    type === 'file_search_call' ||
    type === 'computer_call' ||
    type === 'image_generation_call'
  ) {
    // These are server-side history artifacts with no Chat equivalent. They
    // are consumed locally rather than forwarded as a fabricated message.
    return { type }
  }
  fail(`${path}.type`, `unsupported input item type '${type}'`)
}

function additionalResponsesTools(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return []
  const tools: unknown[] = []
  for (const [index, raw] of value.entries()) {
    if (!isObject(raw) || raw.type !== 'additional_tools') continue
    const itemPath = `${path}[${index}]`
    const additional = arrayAt(raw.tools, `${itemPath}.tools`, MAX_TOOLS)
    tools.push(...additional)
    if (tools.length > MAX_TOOLS) {
      fail(`${itemPath}.tools`, `effective tools must contain at most ${MAX_TOOLS} items`)
    }
  }
  return tools
}

function parseMessageContent(value: unknown, path: string): string | ResponsesTextPart[] {
  if (typeof value === 'string') return stringAt(value, path, MAX_TEXT_CHARS)
  return arrayAt(value, path, MAX_CONTENT_PARTS).map((part, index) => {
    const parsed = objectAt(part, `${path}[${index}]`)
    exactKeys(parsed, ['type', 'text'], `${path}[${index}]`)
    const type = enumString(parsed.type, `${path}[${index}].type`, ['input_text', 'output_text'])
    return { type, text: stringAt(parsed.text, `${path}[${index}].text`, MAX_TEXT_CHARS) }
  })
}

function parseTools(value: unknown, path: string): ResponsesFunctionTool[] {
  const parsed: ResponsesFunctionTool[] = []
  const owners = new Map<string, string>()
  const append = (tool: ResponsesFunctionTool, owner: string, itemPath: string): void => {
    const existing = owners.get(tool.name)
    if (existing !== undefined) {
      if (existing === owner && owner.startsWith('namespace:')) return
      fail(itemPath, `executable tool name '${tool.name}' cannot be disambiguated`)
    }
    owners.set(tool.name, owner)
    parsed.push(tool)
  }
  for (const [index, raw] of arrayAt(value, path, MAX_TOOLS).entries()) {
    const itemPath = `${path}[${index}]`
    if (typeof raw === 'string') {
      const tool = customTool(raw, undefined, itemPath)
      append(tool, `custom:${tool.name}:${index}`, itemPath)
      continue
    }
    const tool = objectAt(raw, itemPath)
    if (tool.type === 'custom') {
      const parsedTool = customTool(tool.name, tool.description, itemPath)
      append(parsedTool, `custom:${parsedTool.name}:${index}`, itemPath)
      continue
    }
    if (tool.type === 'namespace') {
      const namespace = validName(tool.name, `${itemPath}.name`)
      const children = arrayAt(tool.tools ?? tool.children, `${itemPath}.tools`, MAX_TOOLS)
      for (const [childIndex, rawChild] of children.entries()) {
        const childPath = `${itemPath}.tools[${childIndex}]`
        const child = objectAt(rawChild, childPath)
        if (child.type !== 'function') continue
        const parsedChild = parseFunctionTool(child, childPath)
        const flattened = {
          ...parsedChild,
          name: flattenNamespaceToolName(namespace, parsedChild.name),
          source_type: 'namespace',
          namespace,
          source_name: parsedChild.name,
        } satisfies ResponsesFunctionTool
        append(flattened, `namespace:${namespace}/${parsedChild.name}`, childPath)
      }
      continue
    }
    if (tool.type !== 'function') {
      fail(`${itemPath}.type`, 'only function, custom, and namespace tools are supported by this bridge')
    }
    const parsedTool = parseFunctionTool(tool, itemPath)
    append(parsedTool, `function:${parsedTool.name}:${index}`, itemPath)
  }
  if (parsed.length > MAX_TOOLS) fail(path, `must contain at most ${MAX_TOOLS} executable tools`)
  return parsed
}

function responsesToolMapping(tools: ResponsesFunctionTool[]): ResponsesToolMapping | undefined {
  const mapping: ResponsesToolMapping = {
    custom_tools: {},
    function_tools: {},
    namespace_tools: {},
  }
  for (const tool of tools) {
    if (tool.source_type === 'custom') {
      mapping.custom_tools[tool.name] = true
    } else if (tool.source_type === 'namespace' && tool.namespace !== undefined) {
      if (tool.source_name === undefined) fail('$.tools', `namespace mapping for '${tool.name}' is invalid`)
      mapping.namespace_tools[tool.name] = {
        namespace: tool.namespace,
        name: tool.source_name,
      }
    } else {
      mapping.function_tools[tool.name] = true
    }
  }
  return Object.keys(mapping.custom_tools).length === 0 &&
    Object.keys(mapping.function_tools).length === 0 &&
    Object.keys(mapping.namespace_tools).length === 0
    ? undefined
    : mapping
}

function restoredToolIdentity(
  name: string,
  mapping: ResponsesToolMapping | undefined,
):
  | { type: 'function'; name: string }
  | { type: 'custom'; name: string }
  | { type: 'namespace'; namespace: string; name: string } {
  if (mapping === undefined || mapping.function_tools[name]) return { type: 'function', name }
  const namespaced = mapping.namespace_tools[name]
  if (namespaced !== undefined) return { type: 'namespace', ...namespaced }
  if (mapping.custom_tools[name]) return { type: 'custom', name }

  let customAlias: string | undefined
  const namespaces = new Set(Object.values(mapping.namespace_tools).map((tool) => tool.namespace))
  for (const customName of Object.keys(mapping.custom_tools)) {
    for (const namespace of namespaces) {
      if (flattenNamespaceToolName(namespace, customName) !== name) continue
      if (customAlias !== undefined && customAlias !== customName) return { type: 'function', name }
      customAlias = customName
    }
  }
  return customAlias === undefined
    ? { type: 'function', name }
    : { type: 'custom', name: customAlias }
}

function customToolInput(argumentsValue: string): string {
  if (argumentsValue === '') return ''
  try {
    const decoded = JSON.parse(argumentsValue) as unknown
    if (isObject(decoded)) {
      if (typeof decoded.input === 'string') return decoded.input
      if (Object.keys(decoded).length === 0) return ''
    }
  } catch {
    // A freeform custom tool input need not be valid JSON.
  }
  return argumentsValue
}

function parseFunctionTool(tool: JsonObject, path: string): ResponsesFunctionTool {
  const parameters = objectAt(tool.parameters ?? {}, `${path}.parameters`)
  assertJsonSize(parameters, `${path}.parameters`)
  return {
    type: 'function',
    name: validName(tool.name, `${path}.name`),
    ...(tool.description === undefined
      ? {}
      : { description: stringAt(tool.description, `${path}.description`, 16_384) }),
    parameters,
    strict: tool.strict === undefined ? false : booleanAt(tool.strict, `${path}.strict`),
  }
}

function customTool(nameValue: unknown, descriptionValue: unknown, path: string): ResponsesFunctionTool {
  const description = descriptionValue === undefined
    ? undefined
    : stringAt(descriptionValue, `${path}.description`, 16_384)
  return {
    type: 'function',
    name: validName(nameValue, `${path}.name`),
    ...(description === undefined ? {} : { description }),
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'The raw input for this tool, passed through verbatim.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    strict: false,
    source_type: 'custom',
  }
}

function parseToolChoice(
  value: unknown,
  path: string,
): ParsedResponsesRequest['tool_choice'] {
  if (typeof value === 'string') return enumString(value, path, ['auto', 'none', 'required'])
  const choice = objectAt(value, path)
  exactKeys(choice, ['type', 'name', 'namespace'], path)
  if (choice.type === 'namespace') {
    validName(choice.name, `${path}.name`)
    return 'auto'
  }
  if (choice.type !== 'function' && choice.type !== 'custom') {
    fail(`${path}.type`, 'must be function, custom, or namespace')
  }
  const name = validName(choice.name, `${path}.name`)
  const namespace = choice.namespace === undefined
    ? undefined
    : validName(choice.namespace, `${path}.namespace`)
  return {
    type: 'function',
    name: namespace === undefined ? name : flattenNamespaceToolName(namespace, name),
  }
}

function parseReasoning(value: unknown, path: string): { effort: string; summary?: string } {
  const reasoning = objectAt(value, path)
  exactKeys(reasoning, ['effort', 'summary'], path)
  const effort = enumString(reasoning.effort, `${path}.effort`, [
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
  ])
  const summary = reasoning.summary === undefined
    ? undefined
    : enumString(reasoning.summary, `${path}.summary`, ['auto', 'concise', 'detailed'])
  return { effort, ...(summary === undefined ? {} : { summary }) }
}

function parseTextConfig(value: unknown, path: string): { format?: JsonObject } {
  const text = objectAt(value, path)
  exactKeys(text, ['format', 'verbosity'], path)
  if (text.verbosity !== undefined) {
    // Chat Completions has no equivalent. Reject rather than silently changing
    // an explicit client generation control.
    fail(`${path}.verbosity`, 'cannot be represented by a Chat Completions upstream')
  }
  if (text.format === undefined) return {}
  const format = objectAt(text.format, `${path}.format`)
  exactKeys(format, ['type', 'name', 'description', 'schema', 'strict'], `${path}.format`)
  const type = enumString(format.type, `${path}.format.type`, ['text', 'json_object', 'json_schema'])
  if (type !== 'json_schema') return { format: { type } }
  const name = validName(format.name, `${path}.format.name`)
  const schema = objectAt(format.schema, `${path}.format.schema`)
  assertJsonSize(schema, `${path}.format.schema`)
  const strict = format.strict === undefined ? false : booleanAt(format.strict, `${path}.format.strict`)
  return {
    format: {
      type,
      name,
      ...(format.description === undefined
        ? {}
        : { description: stringAt(format.description, `${path}.format.description`, 16_384) }),
      schema,
      strict,
    },
  }
}

function responsesFormatToChat(format: JsonObject): JsonObject {
  if (format.type !== 'json_schema') return { type: format.type }
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      ...(format.description === undefined ? {} : { description: format.description }),
      schema: format.schema,
      strict: format.strict,
    },
  }
}

function responsesTextContent(content: string | ResponsesTextPart[]): string {
  if (typeof content === 'string') return content
  return content.map((part) => part.text).join('')
}

function toolOutputText(value: unknown, path: string): string {
  if (typeof value === 'string') return stringAt(value, path, MAX_JSON_CHARS)
  if (value === undefined) fail(path, 'is required')
  assertJsonSize(value, path)
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) fail(path, 'must be JSON serializable')
    return serialized
  } catch {
    fail(path, 'must be JSON serializable')
  }
}

function requireJsonObjectString(value: string, path: string): void {
  if (!isJsonObjectString(value)) fail(path, 'must encode a valid JSON object')
}

function isJsonObjectString(value: string): boolean {
  try {
    return isObject(JSON.parse(value))
  } catch {
    return false
  }
}

function assertJsonSize(value: unknown, path: string): void {
  let serialized: string
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) fail(path, 'must be JSON serializable')
    serialized = encoded
  } catch {
    fail(path, 'must be JSON serializable')
  }
  if (serialized.length > MAX_JSON_CHARS) fail(path, `must be at most ${MAX_JSON_CHARS} characters`)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!isObject(value)) fail(path, 'must be an object')
  return value
}

function arrayAt(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > maximum) fail(path, `must contain at most ${maximum} items`)
  return value
}

function stringAt(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.length > maximum) fail(path, `must be at most ${maximum} characters`)
  return value
}

function nonEmptyString(value: unknown, path: string, maximum: number): string {
  const parsed = stringAt(value, path, maximum).trim()
  if (parsed === '') fail(path, 'must not be empty')
  return parsed
}

function validName(value: unknown, path: string): string {
  const parsed = nonEmptyString(value, path, 128)
  if (!NAME_PATTERN.test(parsed)) fail(path, 'contains invalid characters')
  return parsed
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
    fail(path, 'must be a positive integer no greater than 1000000')
  }
  return value
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, 'must be a non-negative integer')
  }
  return value
}

function finiteNumberInRange(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `must be a finite number from ${minimum} through ${maximum}`)
  }
  return value
}

function enumString<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const parsed = nonEmptyString(value, path, 64)
  if (!allowed.includes(parsed as T)) fail(path, `must be one of: ${allowed.join(', ')}`)
  return parsed as T
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not supported')
  }
}

function fail(path: string, message: string): never {
  throw new ResponsesBridgeError(path, message)
}

function parseServiceTier(value: unknown, path: string): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string') fail(path, 'must be a supported string')
  const tier = value.trim().toLowerCase()
  if (!['auto', 'default', 'flex', 'priority', 'fast', 'scale'].includes(tier)) {
    fail(path, 'must be one of auto, default, flex, priority, fast, or scale')
  }
  return tier === 'fast' ? 'priority' : tier
}
