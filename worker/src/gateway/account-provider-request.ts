import { buildProviderRequest, type BuildProviderRequestInput, type ProviderAccount, type ProviderRequestPlan } from './providers'
import { GatewayError } from './errors'
import { CODEX_DEFAULT_INSTRUCTIONS, CODEX_ORIGINATOR, CODEX_VERSION } from './codex-original-contract'
import { normalizeCodexModel } from './codex-model-normalization'
import { accountHeaderOverridesEligible, applyAccountCredentialHeaders } from './account-header-overrides'

/** Account-level OAuth materialization shared by diagnostics and forwarding. */
export function buildAccountProviderRequest(input: BuildProviderRequestInput & {
  authorization?: string
  account: ProviderAccount & { credential_kind?: string; anthropic_auth_scheme?: 'authorization_bearer' }
}): ProviderRequestPlan {
  if (input.account.platform === 'anthropic' && ['oauth', 'setup_token'].includes(input.account.credential_kind ?? '')) {
    const access = (input.credential as unknown as Record<string, unknown>).access_token
    if (typeof access !== 'string' || !access.trim()) throw new GatewayError(400, 'invalid_request_error', 'Claude token account requires access_token')
    const plan = buildProviderRequest({ ...input, credential: { ...input.credential, api_key: access } })
    plan.headers.delete('x-api-key')
    plan.headers.set('authorization', `Bearer ${access}`)
    const clientBeta = plan.headers.get('anthropic-beta') ?? new Headers(input.client_headers).get('anthropic-beta') ?? ''
    const oauthBeta = 'oauth-2025-04-20'
    const defaults = input.operation === 'count_tokens'
      ? 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,token-counting-2024-11-01'
      : (input.model ?? '').toLowerCase().includes('haiku') ? 'oauth-2025-04-20,interleaved-thinking-2025-05-14'
      : 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
    let beta = clientBeta || defaults
    if (!beta.includes(oauthBeta)) {
      const parts = beta.split(',').map(value => value.trim()), index = parts.indexOf('claude-code-20250219')
      if (index >= 0) { parts.splice(index+1,0,oauthBeta); beta = parts.join(',') } else beta = `${oauthBeta},${beta}`
    }
    plan.headers.set('anthropic-beta', beta)
    const url = new URL(plan.url); url.searchParams.set('beta','true'); plan.url = url.toString()
    return plan
  }
  const oauth = input.account.platform === 'codex' ||
    (input.account.platform === 'openai' && input.account.credential_kind === 'oauth')
  if(input.authorization && (!oauth || input.operation!=='responses')) throw new GatewayError(400,'agent_identity_operation_unsupported','Agent Identity authentication requires a Codex Responses request')
  if (!oauth || input.operation !== 'responses') {
    const plan = buildProviderRequest(input)
    if (input.account.platform === 'anthropic' && input.account.anthropic_auth_scheme === 'authorization_bearer') {
      plan.headers.delete('x-api-key')
      plan.headers.set('authorization', `Bearer ${input.credential.api_key}`)
    }
    if (accountHeaderOverridesEligible(input.account.platform, input.account.credential_kind ?? 'api_key')) {
      applyAccountCredentialHeaders(plan.headers, { ...input.credential })
    }
    return plan
  }
  const secrets = input.credential as unknown as Record<string, unknown>
  const token = input.authorization ?? (typeof secrets.access_token === 'string' && secrets.access_token.trim()
    ? secrets.access_token : input.account.platform === 'codex' ? input.credential.api_key : '')
  const account: ProviderAccount = input.account.platform === 'openai' ? {
    platform: 'codex', protocol: 'codex', auth_scheme: 'bearer', base_url: 'https://chatgpt.com',
    provider_config: typeof secrets.chatgpt_account_id === 'string' && secrets.chatgpt_account_id.trim()
      ? { account_id: secrets.chatgpt_account_id } : {},
  } : input.account
  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
    ? { ...input.body } as Record<string, unknown> : {}
  const model = normalizeCodexModel(input.model ?? (typeof body.model === 'string' ? body.model : ''))
  body.model = model
  body.stream = true
  body.store = false
  if (typeof body.input === 'string') body.input = [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }]
  const plan = buildProviderRequest({ ...input, account, credential: { api_key: token }, model, body })
  const normalized = plan.body as Record<string, unknown>
  if (typeof normalized.instructions !== 'string' || !normalized.instructions.trim()) normalized.instructions = CODEX_DEFAULT_INSTRUCTIONS
  if(input.authorization) plan.headers.set('authorization',input.authorization)
  plan.headers.set('openai-beta', 'responses=experimental')
  plan.headers.set('originator', CODEX_ORIGINATOR)
  plan.headers.set('user-agent', `${CODEX_ORIGINATOR}/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`)
  plan.headers.set('version', CODEX_VERSION)
  return plan
}
