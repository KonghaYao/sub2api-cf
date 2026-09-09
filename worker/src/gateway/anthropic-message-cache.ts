import { capAnthropicCacheBreakpoints, type AnthropicSystem, type AnthropicMessage, type AnthropicTool } from './protocols/anthropic'

/** The caller owns this prepared body. Run after OAuth system migration so the
 * policy sees the messages and breakpoints that will actually reach upstream. */
export function finalizeAnthropicMessageCache(body: Record<string, unknown>, rewriteMessages: boolean): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (rewriteMessages) {
    for (const message of messages) if (Array.isArray(message.content)) {
      for (const block of message.content) if (block && typeof block === 'object') delete block.cache_control
    }
    const inject = (message: Record<string, unknown> | undefined): void => {
      if (!message) return
      if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }]
      if (!Array.isArray(message.content) || message.content.length === 0) return
      const block = message.content.at(-1)
      // Thinking blocks cannot carry cache_control, including when they end a message.
      if (block && typeof block === 'object' && block.type !== 'thinking' && block.type !== 'redacted_thinking') {
        block.cache_control = { type: 'ephemeral', ttl: '5m' }
      }
    }
    inject(messages.at(-1))
    if (messages.length >= 4) inject(messages.filter(message => message.role === 'user').at(-2))
  }
  capAnthropicCacheBreakpoints(body.system as AnthropicSystem | undefined, messages as AnthropicMessage[], body.tools as AnthropicTool[] | undefined)
  return body
}
