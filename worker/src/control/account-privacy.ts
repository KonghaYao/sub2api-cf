import type { Env } from '../env'
import { decryptCredentialPayload } from '../gateway/crypto'
import { credentialAad } from '../gateway/repository'
import { GatewayError } from '../gateway/errors'
import { setOpenAIPrivacy } from './openai-oauth-profile'

export interface PrivacyAccount {
  id: string; platform: string; credential_kind: string; credential_ref: string; secret_id: string; key_version: number
  nonce_b64: string; ciphertext_b64: string; config_version: number; control_version: number; ui_config_json: string
}

/** Shared manual/background action, guarded by the exact account/token snapshot. */
export async function applyOpenAIAccountPrivacy(env: Env, account: PrivacyAccount, advanceControlVersion = true, skipWithoutToken = false): Promise<string> {
  if (account.platform !== 'openai' || account.credential_kind !== 'oauth') throw new GatewayError(400, 'privacy_not_supported', 'Privacy setting is currently supported only for OpenAI OAuth accounts')
  const ui = JSON.parse(account.ui_config_json) as Record<string, unknown>
  if (ui.parent_account_id != null) throw new GatewayError(400, 'privacy_shadow_not_supported', 'Set privacy on the parent account instead')
  if (!env.CREDENTIALS_MASTER_KEY || env.CREDENTIALS_MASTER_KEY.length < 32) throw new GatewayError(503, 'gateway_not_configured', 'Credential secret is not configured', 'server_error')
  const credential = await decryptCredentialPayload(account.nonce_b64, account.ciphertext_b64, env.CREDENTIALS_MASTER_KEY,
    credentialAad(env.ENVIRONMENT, account.id, account.secret_id, account.key_version)) as unknown as Record<string, unknown>
  const token = typeof credential.access_token === 'string' ? credential.access_token.trim() : ''
  if (!token && skipWithoutToken) return ''
  if (!token) throw new GatewayError(400, 'privacy_access_token_missing', 'Cannot set privacy: missing access_token')
  const mode = await setOpenAIPrivacy(env, token, typeof ui.proxy_id === 'string' ? ui.proxy_id : null, 15000)
  const extra = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? ui.extra : {}
  const saved = await env.DB.prepare(`UPDATE accounts SET ui_config_json = ?,
    config_version = config_version + 1, control_version = control_version + ?, updated_at_ms = ?
    WHERE id = ? AND credential_ref = ? AND config_version = ? AND control_version = ? AND ui_config_json = ? RETURNING id`)
    .bind(JSON.stringify({ ...ui, extra: { ...extra, privacy_mode: mode } }), advanceControlVersion ? 1 : 0, Date.now(), account.id, account.credential_ref,
      account.config_version, account.control_version, account.ui_config_json).first()
  if (!saved) throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
  return mode
}
