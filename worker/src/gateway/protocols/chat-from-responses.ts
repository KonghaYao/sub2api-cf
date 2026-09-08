type JsonObject = Record<string, unknown>

export class ResponsesToChatError extends Error {
  constructor(
    message: string,
    readonly upstreamCode = 'upstream_error',
  ) {
    super(message)
    this.name = 'ResponsesToChatError'
  }
}

export interface ResponsesFailureDetails {
  code: string
  message: string
  cyberPolicy: boolean
}

/**
 * A normal `response.incomplete` terminal carries partial success (for
 * example max_output_tokens/content_filter). It is a failure only when the
 * provider attached an actual error. The compact `response.done` alias uses
 * the same distinction.
 */
export function isResponsesFailedTerminal(value: unknown): boolean {
  const event = objectValue(value)
  const type = optionalString(event?.type)
  const response = objectValue(event?.response)
  const hasError = objectValue(response?.error) !== null || objectValue(event?.error) !== null
  if (
    type === 'response.failed' || type === 'response.canceled' ||
    type === 'response.cancelled' || type === 'error'
  ) return true
  if (type === 'response.incomplete') return hasError
  if (type !== 'response.done') return false
  const status = optionalString(response?.status)
  return hasError || (status !== 'completed' && status !== 'incomplete')
}

export function responsesFailureDetails(value: unknown): ResponsesFailureDetails {
  const event = objectValue(value)
  const response = objectValue(event?.response) ?? event
  const error = objectValue(response?.error) ?? objectValue(event?.error)
  const incompleteReason = optionalString(objectValue(response?.incomplete_details)?.reason) ??
    optionalString(objectValue(event?.incomplete_details)?.reason)
  const code = (
    optionalString(error?.code) ?? optionalString(error?.type) ?? incompleteReason ?? 'upstream_error'
  )
    .slice(0, 128)
  const message = (
    optionalString(error?.message) ??
    (incompleteReason === undefined
      ? 'Upstream Responses request failed'
      : `Upstream Responses request incomplete: ${incompleteReason}`)
  )
    .slice(0, 4_096)
  return { code, message, cyberPolicy: code === 'cyber_policy' }
}

export interface ChatUsage extends JsonObject {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: JsonObject
  completion_tokens_details?: JsonObject
}

export interface ChatCompletionResponse extends JsonObject {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  service_tier?: string
  choices: Array<{
    index: 0
    message: {
      role: 'assistant'
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  }>
  usage?: ChatUsage
}

export interface ChatCompletionChunk extends JsonObject {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  service_tier?: string
  choices: Array<{
    index: 0
    delta: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function: { name?: string; arguments: string }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: ChatUsage
}

interface StreamTool {
  index: number
  callId: string
  name: string
  arguments: string
}

/** Convert one buffered Responses API document to the public Chat Completions shape. */
export function responsesToChatCompletionsResponse(
  value: unknown,
  publicModel: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ChatCompletionResponse {
  const root = objectAt(value, 'response')
  if (root.status !== 'completed' && root.status !== 'incomplete') {
    const failure = responsesFailureDetails(root)
    throw new ResponsesToChatError(failure.message, failure.code)
  }
  const output = optionalArray(root.output, 'response.output')
  let content = ''
  let reasoning = ''
  const toolCalls: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }> = []

  for (let index = 0; index < output.length; index += 1) {
    const item = objectAt(output[index], `response.output[${index}]`)
    if (item.type === 'message') {
      const parts = optionalArray(item.content, `response.output[${index}].content`)
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = objectAt(parts[partIndex], `response.output[${index}].content[${partIndex}]`)
        if (part.type === 'output_text' && typeof part.text === 'string') content += part.text
      }
      continue
    }
    if (item.type === 'reasoning') {
      const summary = optionalArray(item.summary, `response.output[${index}].summary`)
      for (let summaryIndex = 0; summaryIndex < summary.length; summaryIndex += 1) {
        const part = objectAt(summary[summaryIndex], `response.output[${index}].summary[${summaryIndex}]`)
        if (part.type === 'summary_text' && typeof part.text === 'string') reasoning += part.text
      }
      continue
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const id = requiredString(item.call_id, `response.output[${index}].call_id`)
      const name = requiredString(item.name, `response.output[${index}].name`)
      const args = typeof item.arguments === 'string'
        ? item.arguments
        : typeof item.input === 'string'
          ? item.input
          : ''
      toolCalls.push({
        id,
        type: 'function',
        function: { name, arguments: args },
      })
    }
  }

  const message: ChatCompletionResponse['choices'][number]['message'] = { role: 'assistant' }
  if (content !== '') message.content = content
  if (reasoning !== '') message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const serviceTier = optionalString(root.service_tier)
  const usage = chatUsage(root.usage)
  return {
    id: optionalString(root.id) ?? generatedId(),
    object: 'chat.completion',
    created: nonNegativeInteger(nowSeconds, 'nowSeconds'),
    model: requiredString(publicModel, 'publicModel'),
    ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason(root, toolCalls.length > 0),
    }],
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Stateful Responses event to Chat Completions chunk bridge. It preserves the
 * upstream response ID and tier, but always publishes the caller-visible model.
 */
export class ResponsesToChatCompletionsEventCodec {
  private id = generatedId()
  private readonly created: number
  private readonly model: string
  private serviceTier: string | undefined
  private sentRole = false
  private sentText = false
  private sentReasoning = false
  private sawToolCall = false
  private finalized = false
  private nextToolIndex = 0
  private usageValue: ChatUsage | undefined
  private readonly tools = new Map<number, StreamTool>()

  constructor(
    publicModel: string,
    private readonly includeUsage = false,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ) {
    this.model = requiredString(publicModel, 'publicModel')
    this.created = nonNegativeInteger(nowSeconds, 'nowSeconds')
  }

  push(value: unknown): ChatCompletionChunk[] {
    if (this.finalized) return []
    const event = objectAt(value, 'event')
    const type = requiredString(event.type, 'event.type')
    if (type === 'response.created') {
      this.observeResponse(event.response)
      return this.ensureRole()
    }
    if (type === 'response.output_text.delta') {
      const delta = optionalString(event.delta)
      if (delta) this.sentText = true
      return delta === undefined || delta === ''
        ? []
        : [...this.ensureRole(), this.delta({ content: delta })]
    }
    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      const delta = optionalString(event.delta)
      if (delta) this.sentReasoning = true
      return delta === undefined || delta === ''
        ? []
        : [...this.ensureRole(), this.delta({ reasoning_content: delta })]
    }
    if (type === 'response.output_item.added') {
      const item = objectAt(event.item, 'event.item')
      if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return []
      const outputIndex = nonNegativeInteger(event.output_index, 'event.output_index')
      const tool: StreamTool = {
        index: this.nextToolIndex,
        callId: requiredString(item.call_id, 'event.item.call_id'),
        name: requiredString(item.name, 'event.item.name'),
        arguments: '',
      }
      this.nextToolIndex += 1
      this.sawToolCall = true
      this.tools.set(outputIndex, tool)
      return [
        ...this.ensureRole(),
        this.delta({
          tool_calls: [{
            index: tool.index,
            id: tool.callId,
            type: 'function',
            function: { name: tool.name, arguments: '' },
          }],
        }),
      ]
    }
    if (
      type === 'response.function_call_arguments.delta' ||
      type === 'response.custom_tool_call_input.delta'
    ) {
      const outputIndex = nonNegativeInteger(event.output_index, 'event.output_index')
      const tool = this.tools.get(outputIndex)
      const delta = optionalString(event.delta)
      if (tool === undefined || delta === undefined || delta === '') return []
      tool.arguments += delta
      return [this.delta({
        tool_calls: [{ index: tool.index, function: { arguments: delta } }],
      })]
    }
    if (isResponsesFailedTerminal(event)) {
      const failure = responsesFailureDetails(event)
      throw new ResponsesToChatError(failure.message, failure.code)
    }
    if (type === 'response.done') {
      const status = objectValue(event.response)?.status
      if (status !== 'completed' && status !== 'incomplete') return []
      return this.complete(event)
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      return this.complete(event)
    }
    return []
  }

  finish(): ChatCompletionChunk[] {
    if (this.finalized) return []
    this.finalized = true
    const chunks = [...this.ensureRole(), this.finishChunk(this.sawToolCall ? 'tool_calls' : 'stop')]
    if (this.includeUsage && this.usageValue !== undefined) chunks.push(this.usageChunk(this.usageValue))
    return chunks
  }

  private complete(event: JsonObject): ChatCompletionChunk[] {
    this.observeResponse(event.response)
    const response = objectValue(event.response)
    this.usageValue = chatUsage(response?.usage ?? event.usage) ?? this.usageValue
    const chunks = [...this.ensureRole()]
    if (response && Array.isArray(response.output)) {
      const message = responsesToChatCompletionsResponse(response, this.model, this.created).choices[0].message
      if (!this.sentText && message.content) chunks.push(this.delta({ content: message.content }))
      if (!this.sentReasoning && message.reasoning_content) chunks.push(this.delta({ reasoning_content: message.reasoning_content }))
      if (!this.sawToolCall && message.tool_calls?.length) {
        this.sawToolCall = true
        chunks.push(this.delta({ tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index })) }))
      }
    }
    const reason = response === null
      ? (this.sawToolCall ? 'tool_calls' : 'stop')
      : finishReason(response, this.sawToolCall)
    this.finalized = true
    chunks.push(this.finishChunk(reason))
    if (this.includeUsage && this.usageValue !== undefined) chunks.push(this.usageChunk(this.usageValue))
    return chunks
  }

  private observeResponse(value: unknown): void {
    const response = objectValue(value)
    if (response === null) return
    this.id = optionalString(response.id) ?? this.id
    this.serviceTier = optionalString(response.service_tier) ?? this.serviceTier
    this.usageValue = chatUsage(response.usage) ?? this.usageValue
  }

  private ensureRole(): ChatCompletionChunk[] {
    if (this.sentRole) return []
    this.sentRole = true
    return [this.delta({ role: 'assistant' })]
  }

  private delta(delta: ChatCompletionChunk['choices'][number]['delta']): ChatCompletionChunk {
    return this.chunk([{ index: 0, delta, finish_reason: null }])
  }

  private finishChunk(
    reason: 'stop' | 'length' | 'tool_calls' | 'content_filter',
  ): ChatCompletionChunk {
    return this.chunk([{ index: 0, delta: { content: '' }, finish_reason: reason }])
  }

  private usageChunk(usage: ChatUsage): ChatCompletionChunk {
    return { ...this.chunk([]), usage }
  }

  private chunk(choices: ChatCompletionChunk['choices']): ChatCompletionChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      ...(this.serviceTier === undefined ? {} : { service_tier: this.serviceTier }),
      choices,
    }
  }
}

const MAX_SSE_EVENT_CHARS = 256 * 1024

/**
 * Incrementally assembles a forced Responses stream for a buffered Chat client.
 * Only one SSE frame and the final semantic output are retained in memory.
 */
export class BufferedResponsesToChatCompletions {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private terminalResponse: JsonObject | null = null
  private terminalValue: 'completed' | 'failed' | null = null
  private responseId: string | undefined
  private serviceTier: string | undefined
  private text = ''
  private reasoning = ''
  private readonly tools = new Map<number, { callId: string; name: string; arguments: string }>()

  constructor(
    private readonly publicModel: string,
    private readonly nowSeconds = Math.floor(Date.now() / 1_000),
  ) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.drain(false)
    this.assertFrameLimit()
  }

  finish(): void {
    this.buffer += this.decoder.decode()
    this.drain(false)
    this.assertFrameLimit()
    this.drain(true)
  }

  terminal(): 'completed' | 'failed' | 'missing' {
    return this.terminalValue ?? 'missing'
  }

  response(): ChatCompletionResponse {
    return responsesToChatCompletionsResponse(this.responsesDocument(), this.publicModel, this.nowSeconds)
  }

  responsesDocument(): JsonObject {
    if (this.terminalResponse === null || this.terminalValue === null) {
      throw new ResponsesToChatError('Upstream stream ended before a terminal response event')
    }
    if (this.terminalValue === 'failed') {
      const failure = responsesFailureDetails(this.terminalResponse)
      throw new ResponsesToChatError(failure.message, failure.code)
    }
    const response = { ...this.terminalResponse }
    const output = optionalArray(response.output, 'response.output')
    if (output.length === 0) response.output = this.accumulatedOutput()
    response.id = optionalString(response.id) ?? this.responseId ?? generatedId()
    if (response.service_tier === undefined && this.serviceTier !== undefined) {
      response.service_tier = this.serviceTier
    }
    return response
  }

  private drain(flush: boolean): void {
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match === null) break
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.processFrame(frame)
    }
    if (flush && this.buffer.length > 0) {
      this.processFrame(this.buffer)
      this.buffer = ''
    }
  }

  private processFrame(frame: string): void {
    if (this.terminalValue !== null) return
    let eventName: string | undefined
    const data: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    const serialized = data.join('\n')
    if (serialized === '' || serialized === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch {
      throw new ResponsesToChatError('Upstream returned an invalid Responses SSE event')
    }
    const event = objectAt(parsed, 'event')
    if (typeof event.type !== 'string' && eventName !== undefined) event.type = eventName
    this.processEvent(event)
  }

  private processEvent(event: JsonObject): void {
    const type = optionalString(event.type)
    const observed = objectValue(event.response)
    if (observed !== null) {
      this.responseId = optionalString(observed.id) ?? this.responseId
      this.serviceTier = optionalString(observed.service_tier) ?? this.serviceTier
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      this.text += event.delta
    } else if (
      (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
      typeof event.delta === 'string'
    ) {
      this.reasoning += event.delta
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      this.observeOutputItem(event)
    } else if (
      type === 'response.function_call_arguments.delta' ||
      type === 'response.custom_tool_call_input.delta'
    ) {
      const outputIndex = nonNegativeInteger(event.output_index, 'event.output_index')
      const tool = this.tools.get(outputIndex)
      if (tool !== undefined && typeof event.delta === 'string') tool.arguments += event.delta
    }
    if (type === 'response.completed' || (type === 'response.incomplete' && !isResponsesFailedTerminal(event))) {
      this.terminalResponse = {
        ...(observed ?? {}),
        status: type === 'response.incomplete' ? 'incomplete' : 'completed',
      }
      if (this.terminalResponse.usage === undefined && event.usage !== undefined) {
        this.terminalResponse.usage = event.usage
      }
      this.terminalValue = 'completed'
    } else if (type === 'response.done') {
      const status = observed?.status
      this.terminalResponse = observed ?? {
        status: 'failed',
        ...(event.error === undefined ? {} : { error: event.error }),
      }
      if (this.terminalResponse.usage === undefined && event.usage !== undefined) {
        this.terminalResponse.usage = event.usage
      }
      this.terminalValue = (status === 'completed' || status === 'incomplete') &&
        !isResponsesFailedTerminal(event)
        ? 'completed'
        : 'failed'
    } else if (isResponsesFailedTerminal(event)) {
      this.terminalResponse = observed ?? {
        status: 'failed',
        ...(event.error === undefined ? {} : { error: event.error }),
      }
      if (this.terminalResponse.usage === undefined && event.usage !== undefined) {
        this.terminalResponse.usage = event.usage
      }
      this.terminalValue = 'failed'
    }
  }

  private observeOutputItem(event: JsonObject): void {
    const item = objectValue(event.item)
    if (item === null) return
    const outputIndex = nonNegativeInteger(event.output_index, 'event.output_index')
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const existing = this.tools.get(outputIndex)
      const args = typeof item.arguments === 'string'
        ? item.arguments
        : typeof item.input === 'string'
          ? item.input
          : undefined
      this.tools.set(outputIndex, {
        callId: optionalString(item.call_id) ?? existing?.callId ?? requiredString(item.call_id, 'event.item.call_id'),
        name: optionalString(item.name) ?? existing?.name ?? requiredString(item.name, 'event.item.name'),
        arguments: args ?? existing?.arguments ?? '',
      })
      return
    }
    if (item.type === 'message' && this.text === '') {
      for (const partValue of optionalArray(item.content, 'event.item.content')) {
        const part = objectAt(partValue, 'event.item.content[]')
        if (part.type === 'output_text' && typeof part.text === 'string') this.text += part.text
      }
    } else if (item.type === 'reasoning' && this.reasoning === '') {
      for (const summaryValue of optionalArray(item.summary, 'event.item.summary')) {
        const summary = objectAt(summaryValue, 'event.item.summary[]')
        if (summary.type === 'summary_text' && typeof summary.text === 'string') {
          this.reasoning += summary.text
        }
      }
    }
  }

  private accumulatedOutput(): JsonObject[] {
    const output: JsonObject[] = []
    if (this.reasoning !== '') output.push({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: this.reasoning }],
    })
    if (this.text !== '') output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: this.text }],
    })
    for (const tool of this.tools.values()) output.push({
      type: 'function_call',
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.arguments,
    })
    return output
  }

  private assertFrameLimit(): void {
    if (this.buffer.length > MAX_SSE_EVENT_CHARS) {
      throw new ResponsesToChatError('Upstream Responses SSE event exceeded the size limit')
    }
  }
}

/** Assemble a forced Responses SSE stream for a non-streaming Chat client. */
export function responsesSseToChatCompletionsResponse(
  source: string,
  publicModel: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ChatCompletionResponse {
  const accumulator = new BufferedResponsesToChatCompletions(publicModel, nowSeconds)
  accumulator.push(new TextEncoder().encode(source))
  accumulator.finish()
  return accumulator.response()
}

function finishReason(
  response: JsonObject,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (response.status === 'incomplete') {
    const reason = objectValue(response.incomplete_details)?.reason
    if (reason === 'max_output_tokens') return 'length'
    if (reason === 'content_filter') return 'content_filter'
    return 'stop'
  }
  return response.status === 'completed' && hasToolCalls ? 'tool_calls' : 'stop'
}

function chatUsage(value: unknown): ChatUsage | undefined {
  const usage = objectValue(value)
  if (usage === null) return undefined
  const input = optionalNonNegativeInteger(usage.input_tokens)
  const output = optionalNonNegativeInteger(usage.output_tokens)
  if (input === undefined || output === undefined) return undefined
  const promptDetails = usageDetails(usage.input_tokens_details, [
    'cached_tokens',
    'audio_tokens',
    'cache_creation_tokens',
    'cache_write_tokens',
  ])
  const cacheCreation = optionalNonNegativeInteger(usage.cache_creation_input_tokens)
  if (
    cacheCreation !== undefined && cacheCreation > 0 &&
    promptDetails.cache_creation_tokens === undefined && promptDetails.cache_write_tokens === undefined
  ) promptDetails.cache_creation_tokens = cacheCreation
  const completionDetails = usageDetails(usage.output_tokens_details, [
    'reasoning_tokens',
    'audio_tokens',
    'accepted_prediction_tokens',
    'rejected_prediction_tokens',
  ])
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(Object.keys(promptDetails).length === 0 ? {} : { prompt_tokens_details: promptDetails }),
    ...(Object.keys(completionDetails).length === 0
      ? {}
      : { completion_tokens_details: completionDetails }),
  }
}

function usageDetails(value: unknown, keys: string[]): JsonObject {
  const source = objectValue(value)
  if (source === null) return {}
  const result: JsonObject = {}
  for (const key of keys) {
    const count = optionalNonNegativeInteger(source[key])
    if (count !== undefined && count > 0) result[key] = count
  }
  return result
}

function generatedId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`
}

function objectAt(value: unknown, path: string): JsonObject {
  const result = objectValue(value)
  if (result === null) throw new ResponsesToChatError(`${path} must be an object`)
  return result
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function optionalArray(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ResponsesToChatError(`${path} must be an array`)
  return value
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResponsesToChatError(`${path} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function nonNegativeInteger(value: unknown, path: string): number {
  const result = optionalNonNegativeInteger(value)
  if (result === undefined) throw new ResponsesToChatError(`${path} must be a non-negative integer`)
  return result
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}
