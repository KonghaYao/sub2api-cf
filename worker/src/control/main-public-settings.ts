import { captchaPublicDefaults, parseCaptchaSettings, type CaptchaPublicSettings } from './captcha-settings'
import { GatewayError } from '../gateway/errors'

export interface MainPublicSettings extends Partial<CaptchaPublicSettings> {
  table_default_page_size?: number
  table_page_size_options?: number[]
  password_reset_enabled?: boolean
  frontend_url?: string
  totp_enabled?: boolean
  session_binding_enabled?: boolean
  login_agreement_enabled?: boolean
  login_agreement_mode?: 'modal' | 'checkbox'
  login_agreement_updated_at?: string
  login_agreement_documents?: Array<{ id: string; title: string; content_md: string }>
  force_email_on_third_party_signup?: boolean
  registration_email_domain_quota_enabled?: boolean
  default_balance?: number
  default_concurrency?: number
  plugin_management_enabled?: boolean
  allow_user_view_error_requests?: boolean
  default_user_rpm_limit?: number
}

export const MAIN_PUBLIC_FIELDS = [
  ...Object.keys(captchaPublicDefaults) as Array<keyof CaptchaPublicSettings>,
  'table_default_page_size', 'table_page_size_options', 'password_reset_enabled',
  'frontend_url', 'totp_enabled', 'session_binding_enabled', 'login_agreement_enabled',
  'login_agreement_mode', 'login_agreement_updated_at', 'login_agreement_documents',
  'default_balance', 'default_concurrency', 'plugin_management_enabled', 'allow_user_view_error_requests',
  'default_user_rpm_limit', 'registration_email_domain_quota_enabled', 'force_email_on_third_party_signup',
] as const

export function parseMainPublicSettings(input: Record<string, unknown>): MainPublicSettings {
  const output: MainPublicSettings = parseCaptchaSettings(input)
  for (const key of ['plugin_management_enabled', 'allow_user_view_error_requests', 'force_email_on_third_party_signup', 'registration_email_domain_quota_enabled', 'password_reset_enabled', 'totp_enabled', 'session_binding_enabled', 'login_agreement_enabled'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw invalid(key)
      output[key] = input[key]
    }
  }
  for (const [key, min, max] of [['default_concurrency', 1, 1000000], ['table_default_page_size', 1, 1000], ['default_user_rpm_limit', 0, 1000000]] as const) {
    const value = input[key]
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw invalid(key)
      output[key] = Number(value)
    }
  }
  if (input.default_balance !== undefined) {
    const value = input.default_balance
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1e6)) || Math.abs(value * 1e6 - Math.round(value * 1e6)) > 1e-7) throw invalid('default_balance')
    output.default_balance = value
  }
  if (input.table_page_size_options !== undefined) {
    const options = input.table_page_size_options
    if (!Array.isArray(options) || options.length === 0 || options.length > 20 ||
        options.some(value => !Number.isSafeInteger(value) || value < 1 || value > 1000)) throw invalid('table_page_size_options')
    output.table_page_size_options = [...new Set(options)].sort((a, b) => a - b)
  }
  for (const key of ['frontend_url', 'login_agreement_updated_at'] as const) {
    const value = input[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 2048) throw invalid(key)
      output[key] = value.trim()
    }
  }
  if (output.frontend_url) {
    try {
      const url = new URL(output.frontend_url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('frontend_url')
    } catch { throw invalid('frontend_url') }
  }
  if (input.login_agreement_mode !== undefined) {
    if (input.login_agreement_mode !== 'modal' && input.login_agreement_mode !== 'checkbox') throw invalid('login_agreement_mode')
    output.login_agreement_mode = input.login_agreement_mode
  }
  if (input.login_agreement_documents !== undefined) {
    const documents = input.login_agreement_documents
    if (!Array.isArray(documents) || documents.length > 20) throw invalid('login_agreement_documents')
    output.login_agreement_documents = documents.map(document => {
      if (document === null || typeof document !== 'object' ||
          typeof document.id !== 'string' || !document.id || document.id.length > 128 ||
          typeof document.title !== 'string' || !document.title || document.title.length > 512 ||
          typeof document.content_md !== 'string' || document.content_md.length > 100000) throw invalid('login_agreement_documents')
      return { id: document.id, title: document.title, content_md: document.content_md }
    })
    if (new Set(output.login_agreement_documents.map(document => document.id)).size !== documents.length) throw invalid('login_agreement_documents')
  }
  return output
}

export function normalizeMainPublicSettings(input: Record<string, unknown>): MainPublicSettings {
  return {
    ...captchaPublicDefaults,
    table_default_page_size: 20,
    table_page_size_options: [10, 20, 50, 100],
    password_reset_enabled: input.email_verification_enabled === true,
    frontend_url: '',
    totp_enabled: true,
    session_binding_enabled: false,
    login_agreement_enabled: false,
    login_agreement_mode: 'modal',
    login_agreement_updated_at: '',
    login_agreement_documents: [],
    default_balance: 0,
    default_concurrency: 5,
    plugin_management_enabled: false,
    allow_user_view_error_requests: false,
    default_user_rpm_limit: 0,
    registration_email_domain_quota_enabled: false,
    force_email_on_third_party_signup: false,
    ...parseMainPublicSettings(input),
  }
}

function invalid(field: string): GatewayError {
  return new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
}
