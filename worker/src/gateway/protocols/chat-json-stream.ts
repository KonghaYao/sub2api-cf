import { GatewayError } from '../errors'

/** A JSON-only compatible upstream can still satisfy the Chat SSE contract.
 * This preserves the completed answer; it cannot restore upstream token timing.
 */
export function chatJsonStream(value: unknown): Uint8Array {
  const root = value as Record<string, any> | null
  if (!root || !Array.isArray(root.choices) || root.choices.length === 0 ||
      root.choices.some((choice: any) => !choice?.message || typeof choice.message !== 'object')) {
    throw new GatewayError(502, 'invalid_upstream_response', 'Upstream returned an invalid Chat completion', 'server_error')
  }
  const { choices, usage, ...metadata } = root
  const common = { ...metadata, object: 'chat.completion.chunk' }
  const frame = (choices: unknown[], extra = {}) => `data: ${JSON.stringify({ ...common, choices, ...extra })}\n\n`
  let output = ''
  for (const [position, choice] of choices.entries()) {
    const { message, finish_reason, ...details } = choice
    const index = Number.isInteger(choice.index) ? choice.index : position
    const { role, ...delta } = message
    if (Array.isArray(delta.tool_calls)) delta.tool_calls = delta.tool_calls.map((tool: any, index: number) => ({ ...tool, index }))
    output += frame([{ index, delta: { role: role ?? 'assistant' }, finish_reason: null }])
    output += frame([{ ...details, index, delta, finish_reason: null }])
    output += frame([{ index, delta: {}, finish_reason: finish_reason ?? 'stop' }])
  }
  if (usage) output += frame([], { usage })
  return new TextEncoder().encode(output + 'data: [DONE]\n\n')
}
