import { buildAccountProviderRequest } from '../gateway/account-provider-request'
import { applyAccountCredentialHeaders } from '../gateway/account-header-overrides'
import type { ProviderAccount } from '../gateway/providers'
import type { UpstreamCredential } from '../gateway/types'

/** Original createTestPayload and Claude API-key diagnostic client contract. */
export function claudeTextDiagnosticRequest(account: ProviderAccount, credential: UpstreamCredential, model: string, bearer = false, credentialKind: 'api_key' | 'oauth' | 'setup_token' = 'api_key') {
  const device = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  const plan = buildAccountProviderRequest({ account: { ...account, credential_kind: credentialKind, ...(bearer ? { anthropic_auth_scheme: 'authorization_bearer' as const } : {}) }, credential,
    operation: 'messages', model, body: {
      model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } }],
      metadata: { user_id: JSON.stringify({ device_id: device, account_uuid: '', session_id: crypto.randomUUID() }) },
      max_tokens: 1024, temperature: 1, stream: true,
    } })
  const url = new URL(plan.url)
  url.searchParams.set('beta', 'true')
  plan.url = url.toString()
  for (const [name, value] of Object.entries({
    'user-agent': 'claude-cli/2.1.220 (external, cli)', 'x-stainless-lang': 'js', 'x-stainless-package-version': '0.94.0',
    'x-stainless-os': 'Linux', 'x-stainless-arch': 'arm64', 'x-stainless-runtime': 'node', 'x-stainless-runtime-version': 'v24.3.0',
    'x-stainless-retry-count': '0', 'x-stainless-timeout': '600', 'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': credentialKind === 'api_key' ? 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14' : 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
  })) plan.headers.set(name, value)
  applyAccountCredentialHeaders(plan.headers, { ...credential })
  return plan
}
