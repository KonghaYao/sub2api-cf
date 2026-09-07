import { readWechatVariants } from './wechat-variants'
import type { Env } from '../env'

const providers = ['github', 'google', 'linuxdo', 'dingtalk', 'wechat', 'oidc'] as const
type Provider = typeof providers[number]

export interface OAuthPublicSettings {
  github_oauth_enabled: boolean
  google_oauth_enabled: boolean
  linuxdo_oauth_enabled: boolean
  dingtalk_oauth_enabled: boolean
  wechat_oauth_enabled: boolean
  wechat_oauth_open_enabled: boolean
  wechat_oauth_mp_enabled: boolean
  wechat_oauth_mobile_enabled: boolean
  oidc_oauth_enabled: boolean
  oidc_oauth_provider_name: string
}

/** Project only enablement metadata; client IDs, endpoints and secrets stay server-side. */
export async function oauthPublicSettings(env: Env): Promise<OAuthPublicSettings> {
  const enabled = new Set<Provider>()
  let oidcName = 'OIDC'
  try {
    if (typeof env.DB.prepare === 'function') {
      const rows = await env.DB.prepare(
        `SELECT provider, advanced_json FROM oauth_providers
          WHERE enabled = 1
            AND ((secret_key_version IS NOT NULL
            AND secret_nonce_b64 IS NOT NULL AND length(secret_nonce_b64) > 0
            AND secret_ciphertext_b64 IS NOT NULL AND length(secret_ciphertext_b64) > 0)
            OR (provider = 'oidc' AND json_extract(advanced_json, '$.oidc_connect_token_auth_method') = 'none'))
         ORDER BY provider`,
      ).all<{ provider: Provider; advanced_json?: string }>()
      for (const row of rows.results) {
        if (providers.includes(row.provider)) enabled.add(row.provider)
        if (row.provider === 'oidc' && row.advanced_json) { try { const value = JSON.parse(row.advanced_json); if (typeof value.oidc_connect_provider_name === 'string' && value.oidc_connect_provider_name.trim()) oidcName = value.oidc_connect_provider_name.trim() } catch {} }
      }
    }
  } catch {
    // A settings read must never advertise a provider whose source of truth is unavailable.
  }
  let variants: Awaited<ReturnType<typeof readWechatVariants>> = {}
  if (enabled.has('wechat')) { try { variants = await readWechatVariants(env) } catch { enabled.delete('wechat') } }
  const variantEnabled = (mode: 'open' | 'mp' | 'mobile') => enabled.has('wechat') && (Object.keys(variants).length ? variants[mode]?.enabled === true : mode === 'open')
  return {
    github_oauth_enabled: enabled.has('github'),
    google_oauth_enabled: enabled.has('google'),
    linuxdo_oauth_enabled: enabled.has('linuxdo'),
    dingtalk_oauth_enabled: enabled.has('dingtalk'),
    wechat_oauth_enabled: variantEnabled('open') || variantEnabled('mp') || variantEnabled('mobile'),
    // Advertise only enabled apps whose configuration can actually be loaded.
    wechat_oauth_open_enabled: variantEnabled('open'),
    wechat_oauth_mp_enabled: variantEnabled('mp'),
    wechat_oauth_mobile_enabled: variantEnabled('mobile'),
    oidc_oauth_enabled: enabled.has('oidc'),
    oidc_oauth_provider_name: oidcName,
  }
}
