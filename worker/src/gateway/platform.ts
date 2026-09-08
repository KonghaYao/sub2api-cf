import type { ProviderPlatform } from './providers'

/** Runtime guard shared by ingress and Durable Object re-authorization. */
export function isProviderPlatform(value: string): value is ProviderPlatform {
  return value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'codex' || value === 'grok' || value === 'antigravity'
}
