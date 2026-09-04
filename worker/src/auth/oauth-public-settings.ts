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
  try {
    if (typeof env.DB.prepare === 'function') {
      const rows = await env.DB.prepare(
        `SELECT provider FROM oauth_providers
          WHERE enabled = 1
            AND secret_key_version IS NOT NULL
            AND secret_nonce_b64 IS NOT NULL AND length(secret_nonce_b64) > 0
            AND secret_ciphertext_b64 IS NOT NULL AND length(secret_ciphertext_b64) > 0
         ORDER BY provider`,
      ).all<{ provider: Provider }>()
      for (const row of rows.results) {
        if (providers.includes(row.provider)) enabled.add(row.provider)
      }
    }
  } catch {
    // A settings read must never advertise a provider whose source of truth is unavailable.
  }
  return {
    github_oauth_enabled: enabled.has('github'),
    google_oauth_enabled: enabled.has('google'),
    linuxdo_oauth_enabled: enabled.has('linuxdo'),
    dingtalk_oauth_enabled: enabled.has('dingtalk'),
    wechat_oauth_enabled: enabled.has('wechat'),
    // The retained generic WeChat adapter is an Open Platform web flow. MP/mobile
    // have different identity semantics and remain disabled until separately migrated.
    wechat_oauth_open_enabled: enabled.has('wechat'),
    wechat_oauth_mp_enabled: false,
    wechat_oauth_mobile_enabled: false,
    oidc_oauth_enabled: enabled.has('oidc'),
    oidc_oauth_provider_name: 'OIDC',
  }
}
