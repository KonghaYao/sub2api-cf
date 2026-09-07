import { getPlatformQuotaDefaults, updatePlatformQuotaDefaults, type PlatformQuotaDefaultsMap, type PlatformQuotaPlatform } from './platformQuotas'
import { apiClient } from '../client'
import * as oauth from './oauthProviders'
import type { AdminOAuthProvider, AdminOAuthProviderConfig, UpsertAdminOAuthProviderInput } from './oauthProviders'
import type { SystemSettings } from './settings'

const prefixes: Record<AdminOAuthProvider, string> = {
  github: 'github_oauth', google: 'google_oauth', linuxdo: 'linuxdo_connect',
  dingtalk: 'dingtalk_connect', wechat: 'wechat_connect', oidc: 'oidc_connect',
}
const loadedProviders = new Map<AdminOAuthProvider, AdminOAuthProviderConfig>()
let smtpVersion: number | null = null
let quotaVersion: number | null = null
let loadedFlat: Record<string, unknown> = {}
const auxiliarySettings = [
  { path: '/admin/settings/notifications', fields: ['balance_low_notify_enabled', 'balance_low_notify_threshold', 'balance_low_notify_recharge_url', 'subscription_expiry_notify_enabled', 'account_quota_notify_enabled', 'account_quota_notify_emails'] },
  { path: '/admin/settings/channel-monitor', fields: ['channel_monitor_enabled', 'channel_monitor_mode', 'channel_monitor_default_interval_seconds', 'channel_monitor_hide_throughput', 'channel_monitor_show_quota'] },
]
const auxiliaryVersions = new Map<string, number>()
const smtpFields = ['smtp_host', 'smtp_port', 'smtp_username', 'smtp_from_email', 'smtp_from_name', 'smtp_use_tls'] as const

export async function getWorkerProviderSettings(): Promise<Partial<SystemSettings>> {
  const [providers, smtp, quotas, auxiliary] = await Promise.all([
    oauth.list(),
    apiClient.get<Record<string, unknown>>('/admin/settings/email-delivery'),
    getPlatformQuotaDefaults(),
    Promise.all(auxiliarySettings.map(async config => ({ config, data: (await apiClient.get<Record<string, unknown>>(config.path)).data }))),
  ])
  loadedProviders.clear()
  const result: Record<string, unknown> = Object.fromEntries([...smtpFields, 'smtp_password_configured'].map(field => [field, smtp.data[field]]))
  for (const { config, data } of auxiliary) {
    auxiliaryVersions.set(config.path, Number(data.control_version))
    for (const field of config.fields) result[field] = data[field]
  }
  quotaVersion = quotas.control_version
  result.default_platform_quotas = Object.fromEntries(Object.entries(quotas.platform_quotas).map(([platform, quota]) => [platform, { daily: quota.daily_limit_usd, weekly: quota.weekly_limit_usd, monthly: quota.monthly_limit_usd }]))
  smtpVersion = Number(smtp.data.control_version)
  for (const provider of oauth.ADMIN_OAUTH_PROVIDERS) {
    const prefix = prefixes[provider]
    result[`${prefix}_enabled`] = false
    result[`${prefix}_client_secret_configured`] = false
  }
  for (const config of providers.items) {
    loadedProviders.set(config.provider, config)
    Object.assign(result, config.advanced ?? {})
    const prefix = prefixes[config.provider]
    Object.assign(result, {
      [`${prefix}_enabled`]: config.enabled,
      [`${prefix}_redirect_url`]: config.redirect_uri ?? `${window.location.origin}/api/v1/auth/oauth/${config.provider}/callback`,
      [`${prefix}_client_id`]: config.client_id,
      [`${prefix}_client_secret_configured`]: config.client_secret_configured,
      [`${prefix}_frontend_redirect_url`]: config.frontend_callback_path,
      [`${prefix}_scopes`]: config.scopes.join(' '),
    })
    if (config.provider === 'wechat') Object.assign(result, {
      wechat_connect_app_id: config.client_id,
      wechat_connect_app_secret_configured: config.client_secret_configured,
      wechat_connect_open_app_id: config.client_id,
      wechat_connect_open_app_secret_configured: config.client_secret_configured,
      wechat_connect_open_enabled: config.enabled,
      wechat_connect_mode: 'open',
    })
    if (config.provider === 'wechat' && config.wechat_variants && Object.keys(config.wechat_variants).length) {
      for (const mode of ['open','mp','mobile'] as const) {
        const value = config.wechat_variants[mode]
        result[`wechat_connect_${mode}_enabled`] = value?.enabled === true
        result[`wechat_connect_${mode}_app_id`] = value?.client_id ?? ''
        result[`wechat_connect_${mode}_app_secret_configured`] = value?.client_secret_configured === true
      }
      result.wechat_connect_mode = config.wechat_variants.open?.enabled ? 'open' : config.wechat_variants.mp?.enabled ? 'mp' : 'mobile'
    }
    if (config.provider === 'oidc') Object.assign(result, {
      oidc_connect_issuer_url: config.issuer,
      oidc_connect_authorize_url: config.authorization_endpoint,
      oidc_connect_token_url: config.token_endpoint,
      oidc_connect_userinfo_url: config.userinfo_endpoint,
      oidc_connect_jwks_url: config.jwks_endpoint ?? '',
      oidc_connect_use_pkce: config.pkce_enabled,
    })
  }
  loadedFlat = JSON.parse(JSON.stringify(result))
  return result as Partial<SystemSettings>
}

export async function saveWorkerProviderSettings(form: Record<string, unknown>): Promise<void> {
  for (const config of auxiliarySettings) {
    if (!config.fields.some(field => JSON.stringify(form[field]) !== JSON.stringify(loadedFlat[field]))) continue
    const version = auxiliaryVersions.get(config.path)
    if (!Number.isSafeInteger(version)) throw new Error('Reload notification and monitor settings before saving')
    const payload = Object.fromEntries(config.fields.map(field => [field, form[field]]))
    const { data } = await apiClient.put<Record<string, unknown>>(config.path, payload, { headers: { 'If-Match': `"${version}"` } })
    auxiliaryVersions.set(config.path, Number(data.control_version))
    for (const field of config.fields) loadedFlat[field] = structuredClone(data[field])
  }
  const smtpPatch = Object.fromEntries(smtpFields.map(field => [field, form[field]]))
  const password = String(form.smtp_password ?? '')
  if (smtpFields.some(field => form[field] !== loadedFlat[field]) || password) {
    if (smtpVersion === null || !Number.isSafeInteger(smtpVersion)) throw new Error('Reload email settings before saving')
    const response = await apiClient.put<Record<string, unknown>>('/admin/settings/email-delivery', {
      ...smtpPatch, ...(password ? { smtp_password: password } : {}),
    }, { headers: { 'If-Match': `"${smtpVersion}"` } })
    smtpVersion = Number(response.data.control_version)
    Object.assign(loadedFlat, response.data)
  }
  if (form.default_platform_quotas !== undefined && JSON.stringify(form.default_platform_quotas) !== JSON.stringify(loadedFlat.default_platform_quotas)) {
    if (quotaVersion === null) throw new Error('Reload platform quotas before saving')
    const source = form.default_platform_quotas as Record<string, Record<string, unknown>>
    const clean = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    const quotas = Object.fromEntries((['anthropic', 'openai', 'gemini', 'antigravity', 'grok'] as PlatformQuotaPlatform[]).map(platform => [platform, {
      daily_limit_usd: clean(source[platform]?.daily), weekly_limit_usd: clean(source[platform]?.weekly), monthly_limit_usd: clean(source[platform]?.monthly),
    }])) as PlatformQuotaDefaultsMap
    const updated = await updatePlatformQuotaDefaults(quotas, quotaVersion)
    quotaVersion = updated.control_version
    loadedFlat.default_platform_quotas = JSON.parse(JSON.stringify(form.default_platform_quotas))
  }
  for (const provider of oauth.ADMIN_OAUTH_PROVIDERS) {
    const prefix = prefixes[provider]
    const stored = loadedProviders.get(provider)
    const enabled = form[`${prefix}_enabled`] === true
    const wechatMode = form.wechat_connect_open_app_id ? 'open' : form.wechat_connect_mp_app_id ? 'mp' : form.wechat_connect_mobile_app_id ? 'mobile' : 'open'
    const clientID = String(form[provider === 'wechat' ? `wechat_connect_${wechatMode}_app_id` : `${prefix}_client_id`] ||
      (provider === 'wechat' ? form.wechat_connect_app_id : '') || '')
    const secret = String(form[provider === 'wechat' ? `wechat_connect_${wechatMode}_app_secret` : `${prefix}_client_secret`] ||
      (provider === 'wechat' ? form.wechat_connect_app_secret : '') || '')
    if (!stored && !enabled && !clientID && !secret) continue
    const input = providerInput(provider, form, stored)
    input.enabled = enabled
    input.client_id = clientID
    if (provider === 'wechat') input.wechat_variants = Object.fromEntries((['open','mp','mobile'] as const).map(mode => [mode, {
      enabled: form[`wechat_connect_${mode}_enabled`] === true,
      client_id: String(form[`wechat_connect_${mode}_app_id`] || (mode === 'open' ? form.wechat_connect_app_id : '') || ''),
      ...(form[`wechat_connect_${mode}_app_secret`] ? { client_secret: String(form[`wechat_connect_${mode}_app_secret`]) } : mode === 'open' && form.wechat_connect_app_secret ? { client_secret: String(form.wechat_connect_app_secret) } : {}),
    }]))
    if (secret) input.client_secret = secret
    if (provider === 'wechat' && stored?.wechat_variants && !Object.values(input.wechat_variants ?? {}).some(value => value.client_secret)) {
      const equal = (['open', 'mp', 'mobile'] as const).every(mode => {
        const next = input.wechat_variants?.[mode], old = stored.wechat_variants?.[mode]
        return next?.enabled === (old?.enabled ?? false) && next?.client_id === (old?.client_id ?? '')
      })
      if (equal) input.wechat_variants = stored.wechat_variants
    }
    const { control_version: _version, schema_version: _schema, provider: _provider,
      client_secret_configured: _secret, created_at_ms: _created, updated_at_ms: _updated, ...storedInput } = stored ?? {} as AdminOAuthProviderConfig
    if (!secret && stored && Object.entries(input).every(([key, value]) => JSON.stringify(value) === JSON.stringify((storedInput as unknown as Record<string, unknown>)[key]))) continue
    const saved = await oauth.upsert(provider, input, { expectedControlVersion: stored?.control_version ?? 0 })
    loadedProviders.set(provider, saved)
    form[`${prefix}_client_secret`] = ''
    if (provider === 'wechat') form.wechat_connect_app_secret = ''
    if (provider === 'wechat') for (const mode of ['open','mp','mobile']) form[`wechat_connect_${mode}_app_secret`] = ''
  }
}

function providerInput(provider: AdminOAuthProvider, form: Record<string, unknown>, stored?: AdminOAuthProviderConfig): UpsertAdminOAuthProviderInput<AdminOAuthProvider> {
  const definitions: Record<Exclude<AdminOAuthProvider, 'oidc'>, [string, string, string, string[], string | null]> = {
    github: ['https://github.com/login/oauth/authorize', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user', ['read:user', 'user:email'], 'https://api.github.com/user/emails'],
    google: ['https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', ['openid', 'email', 'profile'], null],
    linuxdo: ['https://connect.linux.do/oauth2/authorize', 'https://connect.linux.do/oauth2/token', 'https://connect.linux.do/api/user', ['read'], null],
    dingtalk: ['https://login.dingtalk.com/oauth2/auth', 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken', 'https://api.dingtalk.com/v1.0/contact/users/me', ['openid'], null],
    wechat: ['https://open.weixin.qq.com/connect/qrconnect', 'https://api.weixin.qq.com/sns/oauth2/access_token', 'https://api.weixin.qq.com/sns/userinfo', ['snsapi_login'], null],
  }
  const defaults = provider === 'oidc' ? undefined : definitions[provider]
  const input: UpsertAdminOAuthProviderInput<AdminOAuthProvider> = {
    ...(provider === 'dingtalk' ? { advanced: Object.fromEntries(Object.keys(form).filter(key => key.startsWith('dingtalk_connect_') && !['dingtalk_connect_enabled','dingtalk_connect_client_id','dingtalk_connect_client_secret','dingtalk_connect_client_secret_configured','dingtalk_connect_redirect_url','dingtalk_connect_frontend_redirect_url','dingtalk_connect_scopes'].includes(key)).map(key => [key, form[key]])) } : stored?.advanced ? { advanced: stored.advanced } : {}),
    adapter: provider === 'github' || provider === 'dingtalk' || provider === 'wechat' || provider === 'oidc' ? provider : 'standard',
    enabled: false, client_id: '',
    issuer: stored?.issuer ?? (provider === 'google' ? 'https://accounts.google.com' : provider),
    authorization_endpoint: stored?.authorization_endpoint ?? defaults?.[0] ?? '',
    token_endpoint: stored?.token_endpoint ?? defaults?.[1] ?? '',
    userinfo_endpoint: stored?.userinfo_endpoint ?? defaults?.[2] ?? '',
    emails_endpoint: stored?.emails_endpoint ?? defaults?.[4] ?? null,
    jwks_endpoint: stored?.jwks_endpoint ?? null,
    scopes: stored?.scopes ?? defaults?.[3] ?? ['openid', 'email', 'profile'],
    allowed_hosts: [],
    frontend_callback_path: stored?.frontend_callback_path ?? `/auth/${provider}/callback`,
    pkce_enabled: stored?.pkce_enabled ?? !['wechat', 'dingtalk'].includes(provider),
  }
  const prefix = prefixes[provider]
  const callback = form[`${prefix}_frontend_redirect_url`]
  if (typeof callback === 'string' && callback.trim()) {
    const url = new URL(callback, window.location.origin)
    if (url.origin !== window.location.origin || url.search || url.hash) throw new Error('The OAuth completion page must be an /auth/ path on this site')
    input.frontend_callback_path = url.pathname
  }
  if (provider === 'oidc') {
    input.advanced = Object.fromEntries(['provider_name', 'discovery_url', 'token_auth_method', 'validate_id_token', 'allowed_signing_algs', 'clock_skew_seconds', 'require_email_verified', 'userinfo_email_path', 'userinfo_id_path', 'userinfo_username_path'].map(key => `oidc_connect_${key}`).filter(key => form[key] !== undefined).map(key => [key, form[key]]))
    input.issuer = String(form.oidc_connect_issuer_url ?? '')
    input.authorization_endpoint = String(form.oidc_connect_authorize_url ?? '')
    input.token_endpoint = String(form.oidc_connect_token_url ?? '')
    input.userinfo_endpoint = String(form.oidc_connect_userinfo_url ?? '')
    input.jwks_endpoint = String(form.oidc_connect_jwks_url ?? '') || null
    input.pkce_enabled = form.oidc_connect_use_pkce !== false
    input.scopes = String(form.oidc_connect_scopes || 'openid email profile').split(/[\s,]+/).filter(Boolean)
  }
  input.allowed_hosts = [...new Set([...(stored?.allowed_hosts ?? []), ...[input.authorization_endpoint, input.token_endpoint, input.userinfo_endpoint, input.emails_endpoint, input.jwks_endpoint, ...(provider === 'oidc' ? [input.issuer, String(form.oidc_connect_discovery_url || '')] : [])].filter(Boolean).map(url => new URL(url!).hostname)])]
  return input
}
