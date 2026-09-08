import type { Env } from '../env'
import type { PrivacyAccount } from './account-privacy'
import { decryptCredential } from '../gateway/crypto'
import { credentialAad } from '../gateway/repository'
import { GatewayError } from '../gateway/errors'
import { buildAccountProviderRequest } from '../gateway/account-provider-request'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { codexUsageHeaderUpdates } from '../gateway/codex-usage-headers'

/** Probe only headers, close the stream immediately, and preserve the selected credential snapshot. */
export async function probeOpenAIAccountUsage(env: Env, account: PrivacyAccount, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const ui = JSON.parse(account.ui_config_json) as Record<string, unknown>
  if (account.platform !== 'openai' || account.credential_kind !== 'oauth' || ui.parent_account_id != null) {
    throw new GatewayError(400, 'usage_probe_not_supported', 'This usage probe requires an OpenAI OAuth parent account')
  }
  if (!env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503, 'gateway_not_configured', 'Credential secret is not configured')
  const credential = await decryptCredential(account.nonce_b64, account.ciphertext_b64, env.CREDENTIALS_MASTER_KEY,
    credentialAad(env.ENVIRONMENT, account.id, account.secret_id, account.key_version))
  const plan = buildAccountProviderRequest({ account: { platform: 'openai', credential_kind: 'oauth', protocol: 'openai', auth_scheme: 'bearer', base_url: 'https://api.openai.com', provider_config: {} },
    credential, operation: 'responses', model: 'codex-auto-review', body: {
      model: 'codex-auto-review', stream: true, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    } })
  plan.headers.set('accept', 'text/event-stream')
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
  const init: RequestInit = { method: plan.method, headers: plan.headers, body: JSON.stringify(plan.body), signal: boundedSignal, redirect: 'manual' }
  const response = typeof ui.proxy_id === 'string' && ui.proxy_id
    ? await fetchAccountProxy(env, ui.proxy_id, new URL(plan.url), init, boundedSignal) : await fetch(plan.url, init)
  let updates: Record<string, unknown> | null
  try {
    updates = codexUsageHeaderUpdates(response.headers)
    if (!updates && !response.ok) throw new GatewayError(502, 'usage_probe_failed', `OpenAI usage probe returned HTTP ${response.status}`)
  } finally { try { await response.body?.cancel() } catch { /* Closing an already-failed stream must not discard valid headers. */ } }
  if (!updates) return null
  const extra = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? ui.extra : {}
  const saved = await env.DB.prepare(`UPDATE accounts SET ui_config_json=?,config_version=config_version+1,updated_at_ms=?
    WHERE id=? AND credential_ref=? AND config_version=? AND control_version=? AND ui_config_json=? RETURNING id`)
    .bind(JSON.stringify({ ...ui, extra: { ...extra, ...updates } }), Date.now(), account.id, account.credential_ref,
      account.config_version, account.control_version, account.ui_config_json).first()
  if (!saved) throw new GatewayError(412, 'account_version_conflict', 'Account changed while reading usage; retry with current credentials')
  return updates
}
