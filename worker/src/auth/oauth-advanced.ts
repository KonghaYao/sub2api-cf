import { GatewayError } from '../gateway/errors'
export const dingtalkAdvancedDefaults = {
  dingtalk_connect_corp_restriction_policy: 'none', dingtalk_connect_internal_corp_id: '',
  dingtalk_connect_bypass_registration: false, dingtalk_connect_sync_corp_email: false,
  dingtalk_connect_sync_display_name: false, dingtalk_connect_sync_dept: false,
  dingtalk_connect_sync_corp_email_attr_key: 'dingtalk_email', dingtalk_connect_sync_display_name_attr_key: 'dingtalk_name', dingtalk_connect_sync_dept_attr_key: 'dingtalk_dept',
  dingtalk_connect_sync_corp_email_attr_name: 'DingTalk Corporate Email', dingtalk_connect_sync_display_name_attr_name: 'DingTalk Name', dingtalk_connect_sync_dept_attr_name: 'DingTalk Department',
}
export const oidcAdvancedDefaults = {
  oidc_connect_provider_name: 'OIDC', oidc_connect_discovery_url: '', oidc_connect_token_auth_method: 'client_secret_post',
  oidc_connect_validate_id_token: true, oidc_connect_allowed_signing_algs: 'RS256,ES256,PS256',
  oidc_connect_clock_skew_seconds: 120, oidc_connect_require_email_verified: false,
  oidc_connect_userinfo_email_path: '', oidc_connect_userinfo_id_path: '', oidc_connect_userinfo_username_path: '',
}
export type DingTalkAdvancedSettings = typeof dingtalkAdvancedDefaults
export function normalizeOAuthAdvanced(provider: string, value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) value = {}
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const defaults: Record<string, unknown> = provider === 'dingtalk' ? dingtalkAdvancedDefaults : provider === 'oidc' ? oidcAdvancedDefaults : {}
  const result = { ...defaults }
  for (const [key, item] of Object.entries(value!)) {
    if (!(key in defaults) || typeof item !== typeof defaults[key] || (typeof item === 'string' && item.length > 512)) throw invalid()
    if (key.endsWith('_attr_name') && (typeof item !== 'string' || !item.trim() || item.length > 128)) throw invalid()
    result[key] = typeof item === 'string' ? item.trim() : item
  }
  if (provider === 'dingtalk') {
    if (!['none', 'internal_only'].includes(String(result.dingtalk_connect_corp_restriction_policy))) throw invalid()
    if (result.dingtalk_connect_bypass_registration && result.dingtalk_connect_corp_restriction_policy !== 'internal_only') throw invalid()
    for (const key of Object.keys(result).filter(key => key.endsWith('_attr_key'))) if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(String(result[key]))) throw invalid()
  }
  if (provider === 'oidc') {
    if (!['client_secret_post', 'client_secret_basic', 'none'].includes(String(result.oidc_connect_token_auth_method))) throw invalid()
    const skew = result.oidc_connect_clock_skew_seconds
    if (typeof skew !== 'number' || !Number.isSafeInteger(skew) || skew < 0 || skew > 600) throw invalid()
    const algorithms = String(result.oidc_connect_allowed_signing_algs).split(/[\s,]+/).filter(Boolean)
    if (!algorithms.length || algorithms.some(alg => !['RS256', 'ES256', 'PS256', 'RS384', 'RS512', 'ES384', 'ES512', 'PS384', 'PS512'].includes(alg))) throw invalid()
    result.oidc_connect_allowed_signing_algs = [...new Set(algorithms)].join(',')
    for (const key of Object.keys(result).filter(key => key.endsWith('_path'))) if (result[key] && !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(String(result[key]))) throw invalid()
    if (!String(result.oidc_connect_provider_name)) throw invalid()
  }
  return result
}
function invalid(): GatewayError { return new GatewayError(400, 'invalid_oauth_advanced_settings', 'OAuth provider advanced settings are invalid') }
