import type { Env } from '../env'
import { decryptCredential } from '../gateway/crypto'
import { credentialAad, validateBaseUrl } from '../gateway/repository'
import { applyAccountCredentialHeaders } from '../gateway/account-header-overrides'
import { CODEX_ORIGINATOR, CODEX_VERSION } from '../gateway/codex-original-contract'
import { GatewayError } from '../gateway/errors'
import { openAIOAuthHttp } from './openai-oauth-http'
import type { PrivacyAccount } from './account-privacy'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function responsesProbeVerdict(status: number, body: string): boolean | null {
  if (status === 404 || status === 405) return false
  if (status < 200 || status >= 300) return true
  let data: Record<string, unknown>
  try { data = object(JSON.parse(body)) } catch { data = {} }
  const state = typeof data.status === 'string' ? data.status.trim() : ''
  if (state === 'failed' || state === 'incomplete' && String(object(data.incomplete_details).reason ?? '').trim() === 'max_output_tokens') return null
  return Array.isArray(data.output) && data.output.some(item => typeof object(item).type === 'string' && String(object(item).type).trim() === 'function_call')
}
export function responsesProbeModel(credential: Record<string, unknown>): string {
  return Object.values(object(credential.model_mapping)).filter((value): value is string => typeof value === 'string')
    .map(value => value.trim()).filter(value => value && !value.includes('*')).sort()[0] ?? 'gpt-5.4'
}
export function responsesProbeUrl(baseUrl: string): string {
  const url = validateBaseUrl(baseUrl)
  let path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/responses')) {
    const segment = path.split('/').at(-1) ?? ''
    path += /^v\d+(?:\.\d+|(?:alpha|beta|preview).*|)$/i.test(segment) ? '/responses' : '/v1/responses'
  }
  url.pathname = path
  return url.toString()
}
export function responsesProbePayload(model: string) {
  return { model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Call the probe_ping function with ok=true to acknowledge readiness. You must use the tool.' }] }],
    tools: [{ type: 'function', name: 'probe_ping', description: 'Capability probe. Call to acknowledge.',
      parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }],
    tool_choice: 'required', max_output_tokens: 512, stream: false }
}
/** Original tool-capability probe; network/inconclusive results leave the existing flag untouched. */
export async function applyOpenAIResponsesProbe(env: Env, account: PrivacyAccount & { base_url: string }): Promise<boolean | null> {
  if (!env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503, 'gateway_not_configured', 'Credential secret is not configured', 'server_error')
  const credential = await decryptCredential(account.nonce_b64, account.ciphertext_b64, env.CREDENTIALS_MASTER_KEY,
    credentialAad(env.ENVIRONMENT, account.id, account.secret_id, account.key_version)) as unknown as Record<string, unknown>
  if (typeof credential.api_key !== 'string' || !credential.api_key.trim()) return null
  const ui = object(JSON.parse(account.ui_config_json))
  const headers = new Headers({ authorization: `Bearer ${credential.api_key}`, 'content-type': 'application/json', accept: 'application/json',
    'user-agent': `${CODEX_ORIGINATOR}/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`, originator: CODEX_ORIGINATOR,
    version: CODEX_VERSION, 'openai-beta': 'responses=experimental', 'x-codex-window-id': crypto.randomUUID() })
  applyAccountCredentialHeaders(headers, credential)
  let verdict: boolean | null
  try {
    const response = await openAIOAuthHttp(env, responsesProbeUrl(account.base_url), { method: 'POST', headers,
      body: JSON.stringify(responsesProbePayload(responsesProbeModel(credential))) }, typeof ui.proxy_id === 'string' ? ui.proxy_id : null, 15000, 256 * 1024)
    if (response.status >= 300 && response.status < 400) return null
    verdict = responsesProbeVerdict(response.status, response.text)
  } catch { return null }
  if (verdict === null) return null
  const saved = await env.DB.prepare(`UPDATE accounts SET ui_config_json=?,config_version=config_version+1,updated_at_ms=?
    WHERE id=? AND credential_ref=? AND config_version=? AND control_version=? AND ui_config_json=? RETURNING id`)
    .bind(JSON.stringify({ ...ui, extra: { ...object(ui.extra), openai_responses_supported: verdict } }), Date.now(), account.id, account.credential_ref,
      account.config_version, account.control_version, account.ui_config_json).first()
  if (!saved) throw new GatewayError(412, 'account_version_conflict', 'Account changed; retry the capability probe')
  return verdict
}
