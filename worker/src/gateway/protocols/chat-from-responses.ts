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
      refusal?: string
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
      refusal?: string
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

class ContentParts {
  constructor(private readonly label = 'content') {}
  private readonly parts = new Map<string, string>()
  append(event: JsonObject): string {
    const delta = typeof event.delta === 'string' ? event.delta : ''
    const key = this.key(event.output_index, event.content_index)
    this.parts.set(key, (this.parts.get(key) ?? '') + delta)
    return delta
  }
  complete(outputIndex: unknown, contentIndex: unknown, value: unknown): string {
    if (typeof value !== 'string') return ''
    const key = this.key(outputIndex, contentIndex), prefix = this.parts.get(key) ?? ''
    if (!value.startsWith(prefix)) throw new ResponsesToChatError(`Upstream ${this.label} differs from its streamed prefix`)
    this.parts.set(key, value)
    return value.slice(prefix.length)
  }
  text(): string { return [...this.parts.values()].join('') }
  entries(): Array<{ outputIndex: number; contentIndex: number; text: string }> {
    return [...this.parts].map(([key, text]) => {
      const [outputIndex, contentIndex] = key.split(':').map(Number)
      return { outputIndex: outputIndex!, contentIndex: contentIndex!, text }
    })
  }
  private key(outputIndex: unknown, contentIndex: unknown): string {
    return `${outputIndex ?? 0}:${contentIndex ?? 0}`
  }
}

class TextCompletion {
  readonly text = new ContentParts('text')
  readonly reasoning = new ContentParts('reasoning')
  observe(event: JsonObject): Array<{ content?: string; reasoning_content?: string }> {
    const type = event.type
    let delta = '', reasoning = false
    if (type === 'response.output_text.delta') delta = this.text.append(event)
    else if (type === 'response.output_text.done') delta = this.text.complete(event.output_index, event.content_index, event.text)
    else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      reasoning = true
      delta = this.reasoning.append({ ...event, content_index: event.summary_index ?? event.content_index })
    } else if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
      reasoning = true
      delta = this.reasoning.complete(event.output_index, event.summary_index ?? event.content_index, event.text)
    } else if (type === 'response.content_part.done' && objectValue(event.part)?.type === 'output_text') {
      delta = this.text.complete(event.output_index, event.content_index, objectValue(event.part)?.text)
    } else if (type === 'response.reasoning_summary_part.done') {
      reasoning = true
      delta = this.reasoning.complete(event.output_index, event.summary_index, objectValue(event.part)?.text)
    } else if (type === 'response.output_item.done') return this.item(event.item, event.output_index)
    return delta ? [reasoning ? { reasoning_content: delta } : { content: delta }] : []
  }
  item(value: unknown, outputIndex: unknown): Array<{ content?: string; reasoning_content?: string }> {
    const item = objectValue(value)
    if (!item) return []
    const reasoning = item.type === 'reasoning'
    const parts = reasoning ? item.summary : item.type === 'message' ? item.content : undefined
    if (!Array.isArray(parts)) return []
    return parts.flatMap((value, index) => {
      const part = objectValue(value)
      if (part?.type !== (reasoning ? 'summary_text' : 'output_text')) return []
      const delta = (reasoning ? this.reasoning : this.text).complete(outputIndex, index, part.text)
      return delta ? [reasoning ? { reasoning_content: delta } : { content: delta }] : []
    })
  }
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
  let refusal = ''
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
        if (part.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal
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
  if (refusal !== '') message.refusal = refusal
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
  private readonly content = new TextCompletion()
  private readonly refusals = new ContentParts('refusal')
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
    if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
      const refusal = type.endsWith('.delta') ? this.refusals.append(event)
        : this.refusals.complete(event.output_index, event.content_index, event.refusal)
      return refusal ? [...this.ensureRole(), this.delta({ refusal })] : []
    }
    if (type === 'response.content_part.done' && objectValue(event.part)?.type === 'refusal') {
      const refusal = this.refusals.complete(event.output_index, event.content_index, objectValue(event.part)?.refusal)
      return refusal ? [...this.ensureRole(), this.delta({ refusal })] : []
    }
    const content = this.content.observe(event)
    if (content.length && type !== 'response.output_item.done') return [...this.ensureRole(), ...content.map(delta => this.delta(delta))]
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
    if (type === 'response.output_item.done') {
      return [...(content.length ? this.ensureRole() : []), ...content.map(delta => this.delta(delta)),
        ...this.completeRefusalItem(event.item, event.output_index),
        ...this.completeTool(event.item, nonNegativeInteger(event.output_index, 'event.output_index'))]
    }
    if (type === 'response.function_call_arguments.done' || type === 'response.custom_tool_call_input.done') {
      // Some compatible providers omit output_index on argument completion.
      // Recover by call_id when available; output_item.done/terminal remains
      // authoritative when this optional event cannot be associated safely.
      const outputIndex = typeof event.output_index === 'number' && Number.isSafeInteger(event.output_index) && event.output_index >= 0
        ? event.output_index : [...this.tools].find(([, tool]) => tool.callId === event.call_id)?.[0]
      if (outputIndex === undefined) return []
      const tool = this.tools.get(outputIndex)
      if (!tool) return []
      return this.completeTool({ type: 'function_call', call_id: tool.callId, name: tool.name,
        arguments: event.arguments ?? event.input }, outputIndex)
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

  private completeRefusalItem(value: unknown, outputIndex: unknown): ChatCompletionChunk[] {
    const item = objectValue(value)
    if (item?.type !== 'message' || !Array.isArray(item.content)) return []
    const chunks: ChatCompletionChunk[] = []
    item.content.forEach((value, index) => {
      const part = objectValue(value)
      if (part?.type !== 'refusal') return
      const refusal = this.refusals.complete(outputIndex, index, part.refusal)
      if (refusal) chunks.push(...this.ensureRole(), this.delta({ refusal }))
    })
    return chunks
  }

  private completeTool(value: unknown, outputIndex: number): ChatCompletionChunk[] {
    const item = objectValue(value)
    if (!item || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) return []
    const callId = requiredString(item.call_id, 'event.item.call_id')
    const name = requiredString(item.name, 'event.item.name')
    let tool = [...this.tools.values()].find(candidate => candidate.callId === callId) ?? this.tools.get(outputIndex)
    const chunks: ChatCompletionChunk[] = []
    if (!tool) {
      tool = { index: this.nextToolIndex++, callId, name, arguments: '' }
      this.tools.set(outputIndex, tool)
      this.sawToolCall = true
      chunks.push(...this.ensureRole(), this.delta({ tool_calls: [{ index: tool.index, id: callId,
        type: 'function', function: { name, arguments: '' } }] }))
    } else if (tool.callId !== callId || tool.name !== name) {
      throw new ResponsesToChatError('Upstream changed the identity of a streamed tool call')
    }
    const argumentsValue = item.arguments ?? item.input
    if (typeof argumentsValue !== 'string') return chunks
    if (!argumentsValue.startsWith(tool.arguments)) {
      throw new ResponsesToChatError('Upstream completed tool arguments differ from the streamed prefix')
    }
    const suffix = argumentsValue.slice(tool.arguments.length)
    tool.arguments = argumentsValue
    if (suffix) chunks.push(this.delta({ tool_calls: [{ index: tool.index, function: { arguments: suffix } }] }))
    return chunks
  }

  private complete(event: JsonObject): ChatCompletionChunk[] {
    this.observeResponse(event.response)
    const response = objectValue(event.response)
    this.usageValue = chatUsage(response?.usage ?? event.usage) ?? this.usageValue
    const chunks = [...this.ensureRole()]
    if (response && Array.isArray(response.output)) {
      for (let outputIndex = 0; outputIndex < response.output.length; outputIndex++) {
        chunks.push(...this.content.item(response.output[outputIndex], outputIndex).map(delta => this.delta(delta)),
          ...this.completeRefusalItem(response.output[outputIndex], outputIndex),
          ...this.completeTool(response.output[outputIndex], outputIndex))
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
  private readonly content = new TextCompletion()
  private readonly refusals = new ContentParts('refusal')
  private readonly tools = new Map<number, { callId: string; name: string; arguments: string }>()
  private readonly outputItems = new Map<number, JsonObject>()
  private readonly completedItems = new Set<number>()

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
    return responsesToChatCompletionsResponse(this.nativeResponse(), this.publicModel, this.nowSeconds)
  }

  hasOutput(): boolean {
    return this.completedItems.size > 0 || this.content.text.text().length > 0 || this.refusals.text().length > 0 || this.content.reasoning.text().length > 0 || [...this.tools.values()].some(tool => tool.arguments.length > 0) || (Array.isArray(this.terminalResponse?.output) && this.terminalResponse.output.length > 0)
  }

  /** Return the authoritative Responses document, filling omitted output from streamed deltas. */
  responsesDocument(): JsonObject {
    return this.nativeResponse()
  }

  nativeResponse(): JsonObject {
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
    response.object ??= 'response'
    response.model = this.publicModel
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
    this.content.observe(event)
    const observed = objectValue(event.response)
    if (observed !== null) {
      this.responseId = optionalString(observed.id) ?? this.responseId
      this.serviceTier = optionalString(observed.service_tier) ?? this.serviceTier
    }
    if (type === 'response.refusal.delta') {
      this.refusals.append(event)
    } else if (type === 'response.refusal.done') {
      this.refusals.complete(event.output_index, event.content_index, event.refusal)
    } else if (type === 'response.content_part.done' && objectValue(event.part)?.type === 'refusal') {
      this.refusals.complete(event.output_index, event.content_index, objectValue(event.part)?.refusal)
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
    if (type === 'response.function_call_arguments.done' || type === 'response.custom_tool_call_input.done') {
      const outputIndex = typeof event.output_index === 'number' && Number.isSafeInteger(event.output_index) && event.output_index >= 0
        ? event.output_index : [...this.tools].find(([, tool]) => tool.callId === event.call_id)?.[0]
      const tool = outputIndex === undefined ? undefined : this.tools.get(outputIndex)
      if (tool && outputIndex !== undefined) {
        if (typeof event.call_id === 'string' && event.call_id !== tool.callId) {
          throw new ResponsesToChatError('Upstream changed the identity of a streamed tool call')
        }
        const item = this.outputItems.get(outputIndex)
        if (typeof event.item_id === 'string' && typeof item?.id === 'string' && event.item_id !== item.id) {
          throw new ResponsesToChatError('Upstream changed the identity of a streamed tool call')
        }
        const args = type === 'response.custom_tool_call_input.done' ? event.input : event.arguments
        if (typeof args === 'string') {
          tool.arguments = args
          this.completedItems.add(outputIndex)
        }
      }
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
    this.outputItems.set(outputIndex, { ...this.outputItems.get(outputIndex), ...item })
    if (event.type === 'response.output_item.done') this.completedItems.add(outputIndex)
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
    if (item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach((value, index) => {
        const part = objectValue(value)
        if (part?.type === 'refusal') this.refusals.complete(outputIndex, index, part.refusal)
      })
    }
    if (event.type === 'response.output_item.added') this.content.item(item, outputIndex)
  }

  private accumulatedOutput(): JsonObject[] {
    const items = new Map<string, { index: number; item: JsonObject }>()
    for (const [index, value] of this.outputItems) {
      items.set(`${index}:${value.type}`, { index, item: structuredClone(value) })
    }
    const ensure = (index: number, type: string): JsonObject => {
      const key = `${index}:${type}`
      let value = items.get(key)
      if (!value) {
        value = { index, item: { type, ...(type === 'message' ? { role: 'assistant' } : {}) } }
        items.set(key, value)
      }
      return value.item
    }
    const indexedParts = new Map<string, Map<number, JsonObject>>()
    const parts = (state: ContentParts, type: 'message' | 'reasoning', partType: string, field: 'text' | 'refusal') => {
      for (const { outputIndex, contentIndex, text } of state.entries()) {
        if (!text) continue
        const item = ensure(outputIndex, type), listName = type === 'reasoning' ? 'summary' : 'content'
        const key = `${outputIndex}:${type}`
        let indexed = indexedParts.get(key)
        if (!indexed) {
          const existing = Array.isArray(item[listName]) ? item[listName] as unknown[] : []
          indexed = new Map(existing.map((part, index) => [index, objectValue(part) ?? {}]))
          indexedParts.set(key, indexed)
        }
        // Preserve sparse upstream indices without allocating a large holey array.
        indexed.set(contentIndex, { ...indexed.get(contentIndex), type: partType, [field]: text })
        item[listName] = [...indexed].sort(([a], [b]) => a - b).map(([, part]) => part)
      }
    }
    parts(this.content.reasoning, 'reasoning', 'summary_text', 'text')
    parts(this.content.text, 'message', 'output_text', 'text')
    parts(this.refusals, 'message', 'refusal', 'refusal')
    for (const [index, tool] of this.tools) {
      const original = this.outputItems.get(index)
      const custom = original?.type === 'custom_tool_call'
      Object.assign(ensure(index, custom ? 'custom_tool_call' : 'function_call'), {
        call_id: tool.callId, name: tool.name, [custom ? 'input' : 'arguments']: tool.arguments,
      })
    }
    return [...items.values()].sort((a, b) => a.index - b.index).map(value => value.item)
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
