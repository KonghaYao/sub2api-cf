/**
 * Dependency-free Chat Completions -> Responses request bridge.
 *
 * The legacy gateway always consumed a Responses SSE stream for this bridge,
 * even when the Chat caller requested a buffered response. Keeping that
 * invariant lets the caller-facing adapter choose buffering independently.
 */

type JsonObject = Record<string, unknown>

const MAX_MESSAGES = 2_000
const MAX_CONTENT_PARTS = 1_000
const MAX_TOOLS = 256
const MAX_TEXT_CHARS = 4_000_000
const MAX_JSON_CHARS = 4_000_000
const MIN_MAX_OUTPUT_TOKENS = 128
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/

export class ChatToResponsesError extends Error {
  readonly code = 'invalid_request_error'

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'ChatToResponsesError'
  }
}

export interface ChatToResponsesRequest extends JsonObject {
  model: string
  instructions?: string
  input: Array<Record<string, unknown>>
  stream: true
  store: false
  include: ['reasoning.encrypted_content']
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  service_tier?: string
  parallel_tool_calls?: boolean
  reasoning?: { effort: string; summary: 'auto' }
  text?: { format: JsonObject }
  tools?: Array<Record<string, unknown>>
  tool_choice?: string | { type: 'function'; name: string }
}

/** Convert a public Chat Completions body to an allow-listed Responses body. */
export function chatCompletionsToResponsesRequest(
  value: unknown,
  upstreamModel?: string,
): ChatToResponsesRequest {
  const root = objectAt(value, '$')
  const clientModel = nonEmptyString(root.model, '$.model', 256)
  const model = upstreamModel === undefined
    ? clientModel
    : nonEmptyString(upstreamModel, 'upstreamModel', 256)
  const rawMessages = arrayAt(root.messages, '$.messages', MAX_MESSAGES)
  const input = rawMessages.flatMap((message, index) =>
    messageToResponsesItems(message, `$.messages[${index}]`),
  )

  if (root.stream !== undefined && typeof root.stream !== 'boolean') {
    fail('$.stream', 'must be a boolean')
  }

  const result: ChatToResponsesRequest = {
    model,
    input,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  }

  if (root.instructions !== undefined) {
    result.instructions = stringAt(root.instructions, '$.instructions', MAX_TEXT_CHARS)
  }

  const requestedMaximum = root.max_completion_tokens ?? root.max_tokens
  if (requestedMaximum !== undefined && requestedMaximum !== null) {
    const maximum = positiveInteger(requestedMaximum, root.max_completion_tokens !== undefined
      ? '$.max_completion_tokens'
      : '$.max_tokens')
    result.max_output_tokens = Math.max(MIN_MAX_OUTPUT_TOKENS, maximum)
  }

  // The Responses API rejects sampling controls for all gpt-5.x models.
  if (!canonicalModel(model).startsWith('gpt-5')) {
    if (root.temperature !== undefined) {
      result.temperature = finiteNumber(root.temperature, '$.temperature')
    }
    if (root.top_p !== undefined) result.top_p = finiteNumber(root.top_p, '$.top_p')
  }

  const serviceTier = parseServiceTier(root.service_tier, '$.service_tier')
  if (serviceTier !== undefined) result.service_tier = serviceTier
  if (root.parallel_tool_calls !== undefined) {
    if (typeof root.parallel_tool_calls !== 'boolean') {
      fail('$.parallel_tool_calls', 'must be a boolean')
    }
    result.parallel_tool_calls = root.parallel_tool_calls
  }
  if (root.reasoning_effort !== undefined) {
    result.reasoning = {
      effort: nonEmptyString(root.reasoning_effort, '$.reasoning_effort', 64),
      summary: 'auto',
    }
  }

  if (root.response_format !== undefined && root.response_format !== null) {
    result.text = { format: responseFormat(root.response_format, '$.response_format') }
  }

  const tools = convertTools(root.tools, root.functions)
  if (tools.length > 0) result.tools = tools

  const choiceSource = root.tool_choice ?? root.function_call
  if (choiceSource !== undefined && choiceSource !== null) {
    result.tool_choice = convertToolChoice(
      choiceSource,
      root.tool_choice !== undefined ? '$.tool_choice' : '$.function_call',
    )
  }
  return result
}

function messageToResponsesItems(value: unknown, path: string): Array<Record<string, unknown>> {
  const message = objectAt(value, path)
  const rawRole = nonEmptyString(message.role, `${path}.role`, 32)
  const role = rawRole === 'system' || rawRole === 'developer' || rawRole === 'user' ||
    rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'function'
    ? rawRole
    : 'user'

  if (role === 'tool' || role === 'function') {
    const callId = role === 'tool'
      ? stringAt(message.tool_call_id, `${path}.tool_call_id`, 256)
      : stringAt(message.name, `${path}.name`, 128)
    const output = flatTextContent(message.content, `${path}.content`) || '(empty)'
    return [{ type: 'function_call_output', call_id: callId, output }]
  }

  if (role === 'assistant') return assistantItems(message, path)
  return [{ role, content: inputContent(message.content, `${path}.content`) }]
}

function assistantItems(message: JsonObject, path: string): Array<Record<string, unknown>> {
  let text = ''
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
    const reasoning = stringAt(message.reasoning_content, `${path}.reasoning_content`, MAX_TEXT_CHARS)
    if (reasoning !== '') text = `<thinking>${reasoning}</thinking>`
  }
  const visible = assistantText(message.content, `${path}.content`)
  if (visible !== '') text += `${text === '' ? '' : '\n'}${visible}`

  const items: Array<Record<string, unknown>> = []
  if (text !== '') {
    items.push({
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    })
  }

  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    const calls = arrayAt(message.tool_calls, `${path}.tool_calls`, MAX_TOOLS)
    for (let index = 0; index < calls.length; index += 1) {
      const callPath = `${path}.tool_calls[${index}]`
      const call = objectAt(calls[index], callPath)
      if (call.type !== undefined && call.type !== 'function') continue
      const fn = objectAt(call.function, `${callPath}.function`)
      items.push({
        type: 'function_call',
        call_id: nonEmptyString(call.id, `${callPath}.id`, 256),
        name: nameAt(fn.name, `${callPath}.function.name`),
        arguments: fn.arguments === undefined || fn.arguments === ''
          ? '{}'
          : stringAt(fn.arguments, `${callPath}.function.arguments`, MAX_JSON_CHARS),
      })
    }
  }
  return items
}

function inputContent(value: unknown, path: string): string | Array<Record<string, unknown>> {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return boundedString(value, path, MAX_TEXT_CHARS)
  const rawParts = arrayAt(value, path, MAX_CONTENT_PARTS)
  const parts: Array<Record<string, unknown>> = []
  for (let index = 0; index < rawParts.length; index += 1) {
    const partPath = `${path}[${index}]`
    const part = objectAt(rawParts[index], partPath)
    if (part.type === 'text') {
      const text = stringAt(part.text, `${partPath}.text`, MAX_TEXT_CHARS)
      if (text !== '') parts.push({ type: 'input_text', text })
      continue
    }
    if (part.type === 'image_url') {
      const rawImage = part.image_url
      const url = typeof rawImage === 'string'
        ? rawImage
        : stringAt(objectAt(rawImage, `${partPath}.image_url`).url, `${partPath}.image_url.url`, MAX_TEXT_CHARS)
      if (url !== '' && !isEmptyBase64DataUri(url)) {
        parts.push({ type: 'input_image', image_url: url })
      }
      continue
    }
    if (part.type === 'file') {
      const file = objectAt(part.file, `${partPath}.file`)
      const filename = optionalString(file.filename, `${partPath}.file.filename`, 1_024)
      const fileData = optionalString(file.file_data, `${partPath}.file.file_data`, MAX_TEXT_CHARS)
      const fileId = optionalString(file.file_id, `${partPath}.file.file_id`, 256)
      if (fileData !== undefined && fileData !== '') {
        parts.push({
          type: 'input_file',
          ...(filename === undefined || filename === '' ? {} : { filename }),
          file_data: fileData,
        })
      } else if (fileId !== undefined && fileId !== '') {
        parts.push({ type: 'input_file', file_id: fileId })
      }
    }
  }
  return parts.length === 0 ? '' : parts
}

function assistantText(value: unknown, path: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return boundedString(value, path, MAX_TEXT_CHARS)
  const rawParts = arrayAt(value, path, MAX_CONTENT_PARTS)
  let result = ''
  for (let index = 0; index < rawParts.length; index += 1) {
    const partPath = `${path}[${index}]`
    const part = objectAt(rawParts[index], partPath)
    if (part.type === 'thinking' || part.type === 'reasoning') {
      const raw = part.thinking ?? part.text
      if (raw !== undefined && raw !== null) {
        const thinking = stringAt(raw, `${partPath}.${part.thinking === undefined ? 'text' : 'thinking'}`, MAX_TEXT_CHARS)
        if (thinking !== '') result += `<thinking>${thinking}</thinking>`
      }
    } else if (typeof part.text === 'string') {
      result += boundedString(part.text, `${partPath}.text`, MAX_TEXT_CHARS)
    }
  }
  return result
}

function flatTextContent(value: unknown, path: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return boundedString(value, path, MAX_TEXT_CHARS)
  const rawParts = arrayAt(value, path, MAX_CONTENT_PARTS)
  let result = ''
  for (let index = 0; index < rawParts.length; index += 1) {
    const part = objectAt(rawParts[index], `${path}[${index}]`)
    if (part.type === 'text' && typeof part.text === 'string') {
      result += boundedString(part.text, `${path}[${index}].text`, MAX_TEXT_CHARS)
    }
  }
  return result
}

function convertTools(rawTools: unknown, rawFunctions: unknown): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = []
  if (rawTools !== undefined && rawTools !== null) {
    const source = arrayAt(rawTools, '$.tools', MAX_TOOLS)
    for (let index = 0; index < source.length; index += 1) {
      const path = `$.tools[${index}]`
      const tool = objectAt(source[index], path)
      const type = nonEmptyString(tool.type, `${path}.type`, 64).trim().toLowerCase()
      if (type === 'x_search') {
        tools.push(copyXSearchTool(tool, path))
      } else if (type === 'web_search' || type === 'code_execution') {
        tools.push({ type })
      } else if (type === 'function') {
        tools.push(functionTool(objectAt(tool.function, `${path}.function`), `${path}.function`))
      }
    }
  }
  if (rawFunctions !== undefined && rawFunctions !== null) {
    const source = arrayAt(rawFunctions, '$.functions', MAX_TOOLS)
    for (let index = 0; index < source.length; index += 1) {
      tools.push(functionTool(objectAt(source[index], `$.functions[${index}]`), `$.functions[${index}]`))
    }
  }
  if (tools.length > MAX_TOOLS) fail('$.tools', `must contain at most ${MAX_TOOLS} tools`)
  return tools
}

function functionTool(fn: JsonObject, path: string): Record<string, unknown> {
  const description = optionalString(fn.description, `${path}.description`, MAX_TEXT_CHARS)
  const parameters = fn.parameters === undefined || fn.parameters === null
    ? {}
    : cloneJsonObject(fn.parameters, `${path}.parameters`)
  if (fn.strict !== undefined && typeof fn.strict !== 'boolean') {
    fail(`${path}.strict`, 'must be a boolean')
  }
  return {
    type: 'function',
    name: nameAt(fn.name, `${path}.name`),
    ...(description === undefined ? {} : { description }),
    parameters,
    strict: fn.strict === true,
  }
}

function copyXSearchTool(tool: JsonObject, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'x_search' }
  const stringArrays = ['allowed_x_handles', 'excluded_x_handles']
  for (const key of stringArrays) {
    if (tool[key] === undefined) continue
    const source = arrayAt(tool[key], `${path}.${key}`, 1_000)
    result[key] = source.map((value, index) =>
      stringAt(value, `${path}.${key}[${index}]`, 256),
    )
  }
  for (const key of ['from_date', 'to_date']) {
    if (tool[key] !== undefined) result[key] = stringAt(tool[key], `${path}.${key}`, 64)
  }
  for (const key of ['enable_image_understanding', 'enable_video_understanding']) {
    if (tool[key] === undefined) continue
    if (typeof tool[key] !== 'boolean') fail(`${path}.${key}`, 'must be a boolean')
    result[key] = tool[key]
  }
  return result
}

function convertToolChoice(value: unknown, path: string): string | { type: 'function'; name: string } {
  if (typeof value === 'string') return nonEmptyString(value, path, 64)
  const choice = objectAt(value, path)
  const fn = choice.function === undefined ? choice : objectAt(choice.function, `${path}.function`)
  return { type: 'function', name: nameAt(fn.name, `${path}${choice.function === undefined ? '' : '.function'}.name`) }
}

function responseFormat(value: unknown, path: string): JsonObject {
  const format = objectAt(value, path)
  if (format.type === 'json_object') return { type: 'json_object' }
  if (format.type !== 'json_schema') fail(`${path}.type`, 'must be "json_object" or "json_schema"')
  const schema = objectAt(format.json_schema, `${path}.json_schema`)
  const name = nameAt(schema.name, `${path}.json_schema.name`)
  if (schema.schema === undefined) fail(`${path}.json_schema.schema`, 'is required')
  const strict = schema.strict === undefined ? undefined : schema.strict
  if (strict !== undefined && typeof strict !== 'boolean') {
    fail(`${path}.json_schema.strict`, 'must be a boolean')
  }
  return {
    type: 'json_schema',
    name,
    schema: cloneJsonObject(schema.schema, `${path}.json_schema.schema`),
    ...(strict === undefined ? {} : { strict }),
  }
}

function canonicalModel(model: string): string {
  const withoutPrefix = model.trim().replace(/^models\//, '')
  return withoutPrefix.slice(withoutPrefix.lastIndexOf('/') + 1).toLowerCase()
}

function isEmptyBase64DataUri(value: string): boolean {
  if (!value.startsWith('data:')) return false
  const marker = value.indexOf(';base64,')
  return marker >= 0 && value.slice(marker + ';base64,'.length).trim() === ''
}

function cloneJsonObject(value: unknown, path: string): JsonObject {
  const object = objectAt(value, path)
  let encoded: string
  try {
    encoded = JSON.stringify(object)
  } catch {
    fail(path, 'must be JSON serializable')
  }
  if (encoded.length > MAX_JSON_CHARS) fail(path, `must be at most ${MAX_JSON_CHARS} characters`)
  return JSON.parse(encoded) as JsonObject
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value as JsonObject
}

function arrayAt(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > maximum) fail(path, `must contain at most ${maximum} items`)
  return value
}

function optionalString(value: unknown, path: string, maximum: number): string | undefined {
  return value === undefined || value === null ? undefined : stringAt(value, path, maximum)
}

function nameAt(value: unknown, path: string): string {
  const name = nonEmptyString(value, path, 128)
  if (!NAME_PATTERN.test(name)) fail(path, 'contains invalid characters')
  return name
}

function nonEmptyString(value: unknown, path: string, maximum: number): string {
  const result = stringAt(value, path, maximum)
  if (result.trim() === '') fail(path, 'must not be empty')
  return result
}

function stringAt(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  return boundedString(value, path, maximum)
}

function boundedString(value: string, path: string, maximum: number): string {
  if (value.length > maximum) fail(path, `must be at most ${maximum} characters`)
  return value
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(path, 'must be a positive integer')
  }
  return value
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number')
  return value
}

function fail(path: string, message: string): never {
  throw new ChatToResponsesError(path, message)
}

function parseServiceTier(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(path, 'must be a supported string')
  const tier = value.trim().toLowerCase()
  if (!['auto', 'default', 'flex', 'priority', 'fast', 'scale'].includes(tier)) {
    fail(path, 'must be one of auto, default, flex, priority, fast, or scale')
  }
  return tier === 'fast' ? 'priority' : tier
}
