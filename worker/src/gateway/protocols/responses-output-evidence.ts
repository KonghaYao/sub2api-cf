import { ChatSilentRefusalDetector } from './chat-silent-refusal'
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
const text = (value: unknown) => typeof value === 'string' && value !== ''
const has = (value: JsonObject | null, key: string) => value !== null && Object.hasOwn(value, key)

// Port of openAIStreamAddedEventStartsClientOutput: empty placeholders cannot
// commit an attempt, but unknown native tool/content types must be preserved.
export function responsesEventCommitsOutput(type: string | undefined, event: JsonObject): boolean {
  if (['response.created', 'response.in_progress', 'response.failed', 'error'].includes(type ?? '')) return false
  if (type === 'response.output_item.added') {
    const item = object(event.item)
    if (!item) return true
    const kind = typeof item.type === 'string' ? item.type.trim() : ''
    if (kind === 'function_call') return text(item.arguments)
    if (kind === 'custom_tool_call') return text(item.input)
    if (kind === 'compaction') return text(item.encrypted_content)
    if (kind === 'reasoning') {
      if (text(item.encrypted_content)) return true
      return Array.isArray(item.summary) && item.summary.some(part => {
        const p = object(part)
        return p?.type !== 'summary_text' || text(p?.text)
      })
    }
    if (kind === 'message') return Array.isArray(item.content) && item.content.some(part => {
      const p = object(part)
      return p?.type === 'output_text' ? text(p.text) : p?.type === 'refusal' ? text(p.refusal) : true
    })
    return true
  }
  if (type === 'response.content_part.added' || type === 'response.reasoning_summary_part.added') {
    const part = object(event.part)
    if (!part) return true
    if (type === 'response.reasoning_summary_part.added') return part.type !== 'summary_text' || text(part.text)
    return part.type === 'output_text' ? text(part.text) : part.type === 'refusal' ? text(part.refusal) : true
  }
  return true
}

export class ResponsesOutputEvidence {
  private semanticOutput = false
  private positiveUsage = false
  private error = false

  observe(type: string | undefined, event: JsonObject): void {
    const response = object(event.response)
    this.error ||= event.error != null || response?.error != null || type === 'error' || type === 'response.failed'
    for (const usage of [object(event.usage), object(response?.usage)]) {
      if (!usage) continue
      const values = ['input_tokens', 'prompt_tokens', 'output_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens', 'cache_creation_input_tokens', 'cache_write_tokens', 'cache_creation_tokens', 'cache_write_input_tokens'].map(key => usage[key])
      for (const key of ['input_tokens_details', 'prompt_tokens_details', 'output_tokens_details', 'completion_tokens_details']) {
        const details = object(usage[key])
        values.push(details?.cached_tokens, details?.cache_write_tokens, details?.cache_creation_tokens, details?.image_tokens)
      }
      this.positiveUsage ||= values.some(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    }
    if (!['response.completed', 'response.done', 'response.incomplete', 'response.failed', 'response.canceled', 'response.cancelled'].includes(type ?? '') && responsesEventCommitsOutput(type, event)) this.semanticOutput = true
  }

  canRelease(): undefined { return undefined }

  isEmptyCompleted(event: JsonObject): boolean {
    const response = object(event.response)
    return !this.semanticOutput && !this.positiveUsage && !this.error &&
      !has(event, 'usage') && !has(response, 'usage') && !has(event, 'error') && !has(response, 'error') &&
      !(Array.isArray(response?.output) && response.output.length > 0)
  }
}

// Original Chat bridge uses its request-size gated detector, whose reasoning
// and tool evidence differs from native Responses empty-completed protection.
export class ChatResponsesOutputEvidence {
  private readonly detector = new ChatSilentRefusalDetector()
  observe(type: string | undefined, event: JsonObject): void {
    this.detector.observe('data: ' + JSON.stringify({ ...event, ...(type === undefined ? {} : { type }) }))
  }
  canRelease(): boolean { return this.detector.canRelease() }
  isEmptyCompleted(_event: JsonObject): boolean { return this.detector.isSilent() }
}
export type ResponsesPreludeEvidence = ResponsesOutputEvidence | ChatResponsesOutputEvidence
