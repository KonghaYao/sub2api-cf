import { CAPTCHA_SECRET_KEYS } from './captcha-settings'
import { schedulerEffectiveSettings } from './advanced-scheduler-settings'
import { normalizeGatewaySettings, parseGatewaySettingsPatch, type GatewaySettings } from './gateway-settings'
import { MAIN_PUBLIC_FIELDS, normalizeMainPublicSettings, parseMainPublicSettings, type MainPublicSettings } from './main-public-settings'
import type { Context } from 'hono'
import type { Env } from '../env'
import {
  decryptCredential,
  encryptCredential,
} from '../gateway/crypto'
import { authenticateAdminSession } from './admin-auth'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  readJsonObject,
  requireIdempotencyKey,
} from './http'
import { totpFeatureAvailable } from '../auth/totp'
import { passkeyDeploymentConfiguration } from '../auth/passkey-config'
import { normalizeRegistrationEmailSuffixWhitelist } from '../auth/email-policy'

type ControlBindings = { Bindings: Env }

export const PUBLIC_SETTINGS_SCHEMA_VERSION = 1 as const

export const AUTH_SOURCES = ['email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google'] as const
export const AUTH_SOURCE_QUOTA_PLATFORMS = ['anthropic', 'openai', 'gemini', 'antigravity', 'grok'] as const
export type AuthSource = typeof AUTH_SOURCES[number]
export type AuthSourceQuotaPlatform = typeof AUTH_SOURCE_QUOTA_PLATFORMS[number]

export interface AuthSourceDefaultSettings {
  balance: number
  concurrency: number
  subscriptions: Array<{ group_id: string; validity_days: number }>
  grant_on_signup: boolean
  grant_on_first_bind: boolean
  platform_quotas: Partial<Record<AuthSourceQuotaPlatform, {
    daily: number | null
    weekly: number | null
    monthly: number | null
  }>>
}

export type AuthSourceDefaults = Record<AuthSource, AuthSourceDefaultSettings>

export interface PublicSystemSettings extends MainPublicSettings {
  site_name: string
  backend_mode_enabled: boolean
  site_subtitle: string
  api_base_url: string
  contact_info: string
  doc_url: string
  site_logo: string
  home_content: string
  compact_home_enabled: boolean
  hide_ccs_import_button: boolean
  custom_menu_items: Array<{ id: string; label: string; icon_svg: string; url: string; visibility: 'user' | 'admin'; sort_order: number }>
  custom_endpoints: Array<{ name: string; endpoint: string; description: string }>
  registration_enabled: boolean
  registration_email_suffix_whitelist: string[]
  email_verification_enabled: boolean
  turnstile_enabled: boolean
  turnstile_site_key: string
  passkey_enabled?: boolean
  available_channels_enabled: boolean
  model_plaza_enabled: boolean
  model_plaza_require_auth: boolean
  model_plaza_description: string
  promo_code_enabled: boolean
  invitation_code_enabled: boolean
  affiliate_enabled: boolean
  openai_advanced_scheduler_subscription_priority_enabled: boolean
}

export interface AdminSystemSettings {
  schema_version: typeof PUBLIC_SETTINGS_SCHEMA_VERSION
  control_version: number
  audit_log_retention_days: number
  public: PublicSystemSettings
  gateway: GatewaySettings
  security: {
    step_up_enabled: boolean
    totp_encryption_key_configured?: boolean
    passkey_configured: boolean
    passkey_rp_id: string
    passkey_rp_origins: string[]
  }
  secrets: { turnstile_secret_key_configured: boolean } & Partial<Record<`${SystemSettingSecretKey}_configured`, boolean>>
  auth_source_defaults: AuthSourceDefaults
  updated_at_ms: number
}

interface PublicSettingsPatch extends MainPublicSettings {
  site_name?: string
  backend_mode_enabled?: boolean
  site_subtitle?: string
  api_base_url?: string
  contact_info?: string
  doc_url?: string
  site_logo?: string
  home_content?: string
  compact_home_enabled?: boolean
  hide_ccs_import_button?: boolean
  custom_menu_items?: PublicSystemSettings['custom_menu_items']
  custom_endpoints?: PublicSystemSettings['custom_endpoints']
  registration_enabled?: boolean
  registration_email_suffix_whitelist?: string[]
  email_verification_enabled?: boolean
  turnstile_enabled?: boolean
  turnstile_site_key?: string
  passkey_enabled?: boolean
  available_channels_enabled?: boolean
  model_plaza_enabled?: boolean
  model_plaza_require_auth?: boolean
  model_plaza_description?: string
  promo_code_enabled?: boolean
  invitation_code_enabled?: boolean
  affiliate_enabled?: boolean
  openai_advanced_scheduler_subscription_priority_enabled?: boolean
}

type SecretSettingsPatch = Partial<Record<SystemSettingSecretKey, string | null>>

interface SecuritySettingsPatch {
  step_up_enabled?: boolean
}

interface SettingsPatch {
  audit_log_retention_days?: number
  public?: PublicSettingsPatch
  gateway?: Partial<GatewaySettings>
  security?: SecuritySettingsPatch
  secrets?: SecretSettingsPatch
  auth_source_defaults?: Partial<Record<AuthSource, AuthSourceDefaultSettings>>
}

interface AdminActor {
  session_id: string
  user_id: string
}

interface SecretRow {
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
}

interface SettingsRow {
  schema_version: number
  control_version: number
  audit_log_retention_days: number
  public_json: string
  gateway_json: string
  step_up_enabled: number
  updated_at_ms: number
  turnstile_secret_key_configured: number
  turnstile_secret_key_version: number | null
}

interface AuthSourceDefaultRow {
  source: AuthSource
  balance_micros: number
  concurrency: number
  grant_on_signup: number
  grant_on_first_bind: number
}

interface AuthSourceSubscriptionRow {
  source: AuthSource
  group_id: string
  validity_days: number
}

interface AuthSourceQuotaRow {
  source: AuthSource
  platform: AuthSourceQuotaPlatform
  daily_limit_micros: number | null
  weekly_limit_micros: number | null
  monthly_limit_micros: number | null
}

type AdminSettingsCore = Omit<AdminSystemSettings, 'auth_source_defaults'>

const SETTINGS_SECRET_KEYS = ['turnstile_secret_key', ...CAPTCHA_SECRET_KEYS] as const
export type SystemSettingSecretKey = typeof SETTINGS_SECRET_KEYS[number]

export function publicSettingsKey(environment: string): string {
  return `${environment}:public-settings:v1`
}

export async function getAdminSettings(context: Context<ControlBindings>): Promise<Response> {
  try {
    const settings = await adminSettings(await requireSettingsRow(context.env), context.env)
    return settingsResponse(settings)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminSettings(context: Context<ControlBindings>): Promise<Response> {
  try {
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const expectedVersion = requireSettingsVersion(context.req.raw)
    const patch = parseSettingsPatch(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency(
      'admin.system-settings.update.v1',
      idempotencyKey,
      { expected_control_version: expectedVersion, ...patch },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = validIdempotentSettings(previous)
      await publishLatestPublicSettings(context.env)
      return settingsResponse(replay)
    }

    const currentRow = await requireSettingsRow(context.env)
    const current = await adminSettings(currentRow, context.env)
    if (current.control_version !== expectedVersion) {
      throw settingsVersionConflict()
    }
    if (current.control_version >= Number.MAX_SAFE_INTEGER) {
      throw new GatewayError(409, 'settings_version_exhausted', 'System settings version is exhausted')
    }
    await validateAuthSourceSubscriptionGroups(context.env, patch.auth_source_defaults)
    const actor = await requireAdminActor(context)
    const nextVersion = current.control_version + 1
    const nextPublic = applyPublicPatch(current.public, patch.public)
    if ([nextPublic.turnstile_enabled, nextPublic.tencent_captcha_enabled, nextPublic.aliyun_captcha_enabled].filter(value => value === true).length > 1) throw new GatewayError(400, 'CAPTCHA_PROVIDER_CONFLICT', 'Only one CAPTCHA provider can be enabled')
    for (const [enabled, publicKeys, secretKeys] of [
      [nextPublic.tencent_captcha_enabled, ['tencent_captcha_app_id'], ['tencent_captcha_app_secret_key', 'tencent_captcha_cloud_secret_id', 'tencent_captcha_cloud_secret_key']],
      [nextPublic.aliyun_captcha_enabled, ['aliyun_captcha_access_key_id', 'aliyun_captcha_scene_id', 'aliyun_captcha_prefix'], ['aliyun_captcha_access_key_secret']],
    ] as const) {
      if (!enabled) continue
      if (publicKeys.some(key => !nextPublic[key])) throw new GatewayError(400, 'captcha_not_configured', 'Complete CAPTCHA public settings before enabling')
      for (const key of secretKeys) {
        if (!(patch.secrets?.[key] === undefined ? current.secrets[`${key}_configured`] : patch.secrets[key])) throw new GatewayError(400, 'captcha_not_configured', 'Complete CAPTCHA credentials before enabling')
      }
    }
    if (nextPublic.login_agreement_enabled && !nextPublic.login_agreement_documents?.length) {
      throw new GatewayError(400, 'login_agreement_documents_required', 'Add a login agreement before enabling it')
    }
    const nextStepUpEnabled = patch.security?.step_up_enabled ?? current.security.step_up_enabled
    const requiresTotpForEnable = !current.security.step_up_enabled && nextStepUpEnabled
    const now = Date.now()
    if (!current.security.step_up_enabled && nextStepUpEnabled) {
      const totp = await context.env.DB.prepare(
        'SELECT 1 AS enabled FROM user_totp_credentials WHERE user_id = ? LIMIT 1',
      ).bind(actor.user_id).first<{ enabled: number }>()
      if (totp === null) {
        throw new GatewayError(
          403,
          'STEP_UP_TOTP_NOT_ENABLED',
          'Enable TOTP before enabling privileged-operation step-up',
          'permission_error',
        )
      }
    }
    const next: AdminSystemSettings = {
      schema_version: PUBLIC_SETTINGS_SCHEMA_VERSION,
      control_version: nextVersion,
      audit_log_retention_days:
        patch.audit_log_retention_days ?? current.audit_log_retention_days,
      public: nextPublic,
      gateway: normalizeGatewaySettings({ ...current.gateway, ...patch.gateway }),
      security: {
        step_up_enabled: nextStepUpEnabled,
        totp_encryption_key_configured: totpFeatureAvailable(context.env),
        passkey_configured: current.security.passkey_configured,
        passkey_rp_id: current.security.passkey_rp_id,
        passkey_rp_origins: current.security.passkey_rp_origins,
      },
      secrets: {
        ...current.secrets,
        turnstile_secret_key_configured:
          patch.secrets?.turnstile_secret_key === undefined
            ? current.secrets.turnstile_secret_key_configured
            : patch.secrets.turnstile_secret_key !== null,
      },
      auth_source_defaults: {
        ...current.auth_source_defaults,
        ...patch.auth_source_defaults,
      },
      updated_at_ms: now,
    }
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `UPDATE system_settings
            SET control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                public_json = ?, gateway_json = ?,
                audit_log_retention_days = ?,
                step_up_enabled = CASE
                  WHEN ? = 1 AND NOT EXISTS (
                    SELECT 1 FROM user_totp_credentials WHERE user_id = ?
                  ) THEN -1
                  ELSE ?
                END,
                updated_at_ms = ?
          WHERE id = 'global'`,
      ).bind(
        current.control_version,
        nextVersion,
        JSON.stringify(nextPublic),
        JSON.stringify(next.gateway),
        next.audit_log_retention_days,
        requiresTotpForEnable ? 1 : 0,
        actor.user_id,
        nextStepUpEnabled ? 1 : 0,
        now,
      ),
    ]
    statements.push(...authSourceDefaultWriteStatements(context.env, patch.auth_source_defaults, now))
    for (const key of SETTINGS_SECRET_KEYS) {
      const secretPatch = patch.secrets?.[key]
      if (secretPatch === undefined) continue
      if (secretPatch === null) {
        statements.push(context.env.DB.prepare("DELETE FROM system_setting_secrets WHERE settings_id = 'global' AND key = ?").bind(key))
      } else {
        const previous = await context.env.DB.prepare("SELECT key_version FROM system_setting_secrets WHERE settings_id = 'global' AND key = ?").bind(key).first<{ key_version: number }>()
        const version = (previous?.key_version ?? 0) + 1
        const encrypted = await encryptCredential({ api_key: secretPatch }, requireSettingsMasterKey(context.env), settingSecretAad(context.env.ENVIRONMENT, key, version))
        statements.push(context.env.DB.prepare(`INSERT INTO system_setting_secrets (settings_id, key, schema_version, key_version, nonce_b64, ciphertext_b64, updated_at_ms)
          VALUES ('global', ?, 1, ?, ?, ?, ?) ON CONFLICT(settings_id,key) DO UPDATE SET key_version=excluded.key_version,nonce_b64=excluded.nonce_b64,ciphertext_b64=excluded.ciphertext_b64,updated_at_ms=excluded.updated_at_ms`).bind(key, version, encrypted.nonce_b64, encrypted.ciphertext_b64, now))
      }
      next.secrets[`${key}_configured`] = secretPatch !== null
    }
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO admin_settings_audit_events (
           id, actor_user_id, actor_session_id, action, resource_id,
           resource_version, idempotency_key_hash, request_hash,
           changed_fields_json, occurred_at_ms
         ) VALUES (?, ?, ?, 'system_settings.update', 'global', ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        actor.user_id,
        actor.session_id,
        nextVersion,
        idempotency.key_hash,
        idempotency.request_hash,
        JSON.stringify(changedFields(patch)),
        now,
      ),
      controlIdempotencyInsert(context.env, idempotency, 'system_settings', 'global', next, now),
    )
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        const replay = validIdempotentSettings(recovered)
        await publishLatestPublicSettings(context.env)
        return settingsResponse(replay)
      }
      if (isStepUpEnablementError(error)) {
        throw new GatewayError(
          403,
          'STEP_UP_TOTP_NOT_ENABLED',
          'Enable TOTP before enabling privileged-operation step-up',
          'permission_error',
        )
      }
      if (isSettingsVersionError(error)) throw settingsVersionConflict()
      throw error
    }

    await publishLatestPublicSettings(context.env)
    return settingsResponse(next)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function readSystemSettingSecret(
  env: Env,
  key: SystemSettingSecretKey,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT key_version, nonce_b64, ciphertext_b64
       FROM system_setting_secrets
      WHERE settings_id = 'global' AND key = ?`,
  ).bind(key).first<SecretRow>()
  if (row === null) return null
  if (!Number.isSafeInteger(row.key_version) || row.key_version <= 0) {
    throw new GatewayError(503, 'settings_secret_unavailable', 'System setting secret is unavailable', 'server_error')
  }
  const credential = await decryptCredential(
    row.nonce_b64,
    row.ciphertext_b64,
    requireSettingsMasterKey(env),
    settingSecretAad(env.ENVIRONMENT, key, row.key_version),
  )
  return credential.api_key
}

async function requireSettingsRow(env: Env): Promise<SettingsRow> {
  const row = await env.DB.prepare(
    `SELECT s.schema_version, s.control_version, s.audit_log_retention_days,
            s.public_json, s.gateway_json, s.step_up_enabled, s.updated_at_ms,
            CASE WHEN secret.key IS NULL THEN 0 ELSE 1 END AS turnstile_secret_key_configured,
            secret.key_version AS turnstile_secret_key_version
       FROM system_settings s
       LEFT JOIN system_setting_secrets secret
         ON secret.settings_id = s.id AND secret.key = 'turnstile_secret_key'
      WHERE s.id = 'global'`,
  ).first<SettingsRow>()
  if (row === null) {
    throw new GatewayError(503, 'settings_unavailable', 'System settings are unavailable', 'server_error')
  }
  return row
}

async function publicAdminSettings(row: SettingsRow, env: Env): Promise<AdminSettingsCore> {
  if (
    row.schema_version !== PUBLIC_SETTINGS_SCHEMA_VERSION ||
    !Number.isSafeInteger(row.control_version) ||
    row.control_version < 0 ||
    !Number.isSafeInteger(row.audit_log_retention_days) ||
    row.audit_log_retention_days < 0 ||
    row.audit_log_retention_days > 3650 ||
    ![0, 1].includes(row.step_up_enabled) ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0
  ) {
    throw new GatewayError(503, 'invalid_settings_record', 'System settings record is invalid', 'server_error')
  }
  let publicSettings: unknown
  try {
    publicSettings = JSON.parse(row.public_json)
  } catch {
    throw new GatewayError(503, 'invalid_settings_record', 'System settings record is invalid', 'server_error')
  }
  const normalizedPublicSettings = normalizePublicSystemSettings(publicSettings)
  if (normalizedPublicSettings === null) {
    throw new GatewayError(503, 'invalid_settings_record', 'System settings record is invalid', 'server_error')
  }
  const passkey = passkeyDeploymentConfiguration(env)
  return {
    schema_version: PUBLIC_SETTINGS_SCHEMA_VERSION,
    control_version: row.control_version,
    audit_log_retention_days: row.audit_log_retention_days,
    public: normalizedPublicSettings,
    gateway: normalizeGatewaySettings(JSON.parse(row.gateway_json ?? '{}')),
    security: {
      step_up_enabled: row.step_up_enabled === 1,
      totp_encryption_key_configured: totpFeatureAvailable(env),
      passkey_configured: passkey.configured,
      passkey_rp_id: passkey.rpId,
      passkey_rp_origins: passkey.rpOrigins,
    },
    secrets: { turnstile_secret_key_configured: row.turnstile_secret_key_configured === 1,
      ...Object.fromEntries((await env.DB.prepare("SELECT key FROM system_setting_secrets WHERE settings_id = 'global'").all<{ key: string }>()).results.map(secret => [`${secret.key}_configured`, true])),
    },
    updated_at_ms: row.updated_at_ms,
  }
}

async function adminSettings(row: SettingsRow, env: Env): Promise<AdminSystemSettings> {
  return {
    ...await publicAdminSettings(row, env),
    auth_source_defaults: await readAuthSourceDefaults(env),
  }
}

export async function readAuthSourceDefaults(env: Env): Promise<AuthSourceDefaults> {
  const defaults = await env.DB.prepare(
    `SELECT source, balance_micros, concurrency, grant_on_signup, grant_on_first_bind
       FROM auth_source_defaults ORDER BY source`,
  ).all<AuthSourceDefaultRow>()
  const subscriptions = await env.DB.prepare(
    `SELECT source, group_id, validity_days
       FROM auth_source_default_subscriptions ORDER BY source, group_id`,
  ).all<AuthSourceSubscriptionRow>()
  const quotas = await env.DB.prepare(
    `SELECT source, platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
       FROM auth_source_default_platform_quotas ORDER BY source, platform`,
  ).all<AuthSourceQuotaRow>()
  if (defaults.results.length !== AUTH_SOURCES.length) {
    throw new GatewayError(503, 'invalid_auth_source_defaults', 'Authentication source defaults are unavailable', 'server_error')
  }
  const result = {} as AuthSourceDefaults
  for (const source of AUTH_SOURCES) {
    const row = defaults.results.find((candidate) => candidate.source === source)
    if (
      row === undefined || !Number.isSafeInteger(row.balance_micros) || row.balance_micros < 0 ||
      !Number.isSafeInteger(row.concurrency) || row.concurrency <= 0 ||
      ![0, 1].includes(row.grant_on_signup) || ![0, 1].includes(row.grant_on_first_bind)
    ) {
      throw new GatewayError(503, 'invalid_auth_source_defaults', 'Authentication source defaults are invalid', 'server_error')
    }
    const sourceSubscriptions = subscriptions.results
      .filter((item) => item.source === source)
      .map((item) => ({ group_id: item.group_id, validity_days: item.validity_days }))
    const platform_quotas: AuthSourceDefaultSettings['platform_quotas'] = {}
    for (const quota of quotas.results.filter((item) => item.source === source)) {
      platform_quotas[quota.platform] = {
        daily: fromMicros(quota.daily_limit_micros),
        weekly: fromMicros(quota.weekly_limit_micros),
        monthly: fromMicros(quota.monthly_limit_micros),
      }
    }
    result[source] = {
      balance: row.balance_micros / 1_000_000,
      concurrency: row.concurrency,
      subscriptions: sourceSubscriptions,
      grant_on_signup: row.grant_on_signup === 1,
      grant_on_first_bind: row.grant_on_first_bind === 1,
      platform_quotas,
    }
  }
  return result
}

function parseCustomMenuItems(value: unknown): PublicSystemSettings['custom_menu_items'] {
  if (!Array.isArray(value) || value.length > 20) throw new GatewayError(400, 'invalid_custom_menu_items', 'custom_menu_items is invalid')
  return value.map((raw, index) => {
    const row = requireObject(raw, `custom_menu_items.${index}`)
    const id = settingString(row.id, `custom_menu_items.${index}.id`, 64, false)
    if (!/^[a-z0-9-]+$/.test(id)) throw new GatewayError(400, 'invalid_custom_menu_items', 'custom menu id is invalid')
    const visibility = row.visibility === 'user' || row.visibility === 'admin' ? row.visibility : null
    if (visibility === null) throw new GatewayError(400, 'invalid_custom_menu_items', 'custom menu visibility is invalid')
    return {
      id, visibility, sort_order: index,
      label: settingString(row.label, `custom_menu_items.${index}.label`, 128, false),
      icon_svg: settingString(row.icon_svg ?? '', `custom_menu_items.${index}.icon_svg`, 65_536, true),
      url: settingPublicUrl(row.url, `custom_menu_items.${index}.url`),
    }
  })
}

function parseCustomEndpoints(value: unknown): PublicSystemSettings['custom_endpoints'] {
  if (!Array.isArray(value) || value.length > 20) throw new GatewayError(400, 'invalid_custom_endpoints', 'custom_endpoints is invalid')
  return value.map((raw, index) => {
    const row = requireObject(raw, `custom_endpoints.${index}`)
    return {
      name: settingString(row.name, `custom_endpoints.${index}.name`, 128, false),
      endpoint: settingPublicUrl(row.endpoint, `custom_endpoints.${index}.endpoint`),
      description: settingString(row.description ?? '', `custom_endpoints.${index}.description`, 512, true),
    }
  })
}

function settingPublicUrl(value: unknown, field: string): string {
  const url = settingString(value, field, 2_048, false)
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
    return url
  } catch {
    throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  }
}

function safeCustomMenuItems(value: unknown): PublicSystemSettings['custom_menu_items'] {
  try { return value === undefined ? [] : parseCustomMenuItems(value) } catch { return [] }
}

function safeCustomEndpoints(value: unknown): PublicSystemSettings['custom_endpoints'] {
  try { return value === undefined ? [] : parseCustomEndpoints(value) } catch { return [] }
}

function normalizePublicSystemSettings(value: unknown): PublicSystemSettings | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const settings = value as Record<string, unknown>
  if (
    typeof settings.site_name !== 'string' ||
    typeof settings.registration_enabled !== 'boolean' ||
    (settings.registration_email_suffix_whitelist !== undefined &&
      !Array.isArray(settings.registration_email_suffix_whitelist)) ||
    typeof settings.email_verification_enabled !== 'boolean' ||
    typeof settings.turnstile_enabled !== 'boolean' ||
    typeof settings.turnstile_site_key !== 'string' ||
    (settings.passkey_enabled !== undefined && typeof settings.passkey_enabled !== 'boolean') ||
    (settings.model_plaza_enabled !== undefined && typeof settings.model_plaza_enabled !== 'boolean') ||
    (settings.model_plaza_require_auth !== undefined && typeof settings.model_plaza_require_auth !== 'boolean') ||
    (settings.model_plaza_description !== undefined && typeof settings.model_plaza_description !== 'string') ||
    (settings.promo_code_enabled !== undefined && typeof settings.promo_code_enabled !== 'boolean') ||
    (settings.invitation_code_enabled !== undefined && typeof settings.invitation_code_enabled !== 'boolean') ||
    (settings.affiliate_enabled !== undefined && typeof settings.affiliate_enabled !== 'boolean') ||
    (settings.openai_advanced_scheduler_subscription_priority_enabled !== undefined &&
      typeof settings.openai_advanced_scheduler_subscription_priority_enabled !== 'boolean')
  ) return null
  let registrationEmailSuffixWhitelist: string[]
  try {
    registrationEmailSuffixWhitelist = settings.registration_email_suffix_whitelist === undefined
      ? []
      : normalizeRegistrationEmailSuffixWhitelist(settings.registration_email_suffix_whitelist)
  } catch {
    return null
  }
  return {
    ...normalizeMainPublicSettings(settings),
    site_name: settings.site_name,
    backend_mode_enabled: settings.backend_mode_enabled === true,
    site_subtitle: typeof settings.site_subtitle === 'string' ? settings.site_subtitle : '',
    api_base_url: typeof settings.api_base_url === 'string' ? settings.api_base_url : '',
    contact_info: typeof settings.contact_info === 'string' ? settings.contact_info : '',
    doc_url: typeof settings.doc_url === 'string' ? settings.doc_url : '',
    site_logo: typeof settings.site_logo === 'string' ? settings.site_logo : '',
    home_content: typeof settings.home_content === 'string' ? settings.home_content : '',
    compact_home_enabled: settings.compact_home_enabled === true,
    hide_ccs_import_button: settings.hide_ccs_import_button === true,
    custom_menu_items: safeCustomMenuItems(settings.custom_menu_items),
    custom_endpoints: safeCustomEndpoints(settings.custom_endpoints),
    registration_enabled: settings.registration_enabled,
    registration_email_suffix_whitelist: registrationEmailSuffixWhitelist,
    email_verification_enabled: settings.email_verification_enabled,
    turnstile_enabled: settings.turnstile_enabled,
    turnstile_site_key: settings.turnstile_site_key,
    passkey_enabled: settings.passkey_enabled === true,
    available_channels_enabled: settings.available_channels_enabled === true,
    model_plaza_enabled: settings.model_plaza_enabled === true,
    model_plaza_require_auth: settings.model_plaza_require_auth === true,
    model_plaza_description:
      typeof settings.model_plaza_description === 'string' ? settings.model_plaza_description : '',
    promo_code_enabled: settings.promo_code_enabled === true,
    invitation_code_enabled: settings.invitation_code_enabled === true,
    affiliate_enabled: settings.affiliate_enabled === true,
    openai_advanced_scheduler_subscription_priority_enabled:
      settings.openai_advanced_scheduler_subscription_priority_enabled === true,
  }
}

function isPublicSystemSettings(value: unknown): value is PublicSystemSettings {
  return normalizePublicSystemSettings(value) !== null
}

function settingsResponse(settings: AdminSystemSettings): Response {
  const response = controlSuccess({ ...settings, gateway: { ...settings.gateway, ...schedulerEffectiveSettings(settings.gateway) } })
  response.headers.set('etag', `"${settings.control_version}"`)
  return response
}

function requireSettingsVersion(request: Request): number {
  const raw = request.headers.get('if-match')?.trim() ?? ''
  if (raw === '') {
    throw new GatewayError(428, 'settings_version_required', 'If-Match is required')
  }
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(raw)
  if (match === null) {
    throw new GatewayError(400, 'invalid_if_match', 'If-Match must contain a settings version')
  }
  const version = Number(match[1])
  if (!Number.isSafeInteger(version)) {
    throw new GatewayError(400, 'invalid_if_match', 'If-Match must contain a settings version')
  }
  return version
}

function parseSettingsPatch(body: Record<string, unknown>): SettingsPatch {
  rejectUnknownKeys(body, [
    'audit_log_retention_days', 'public', 'gateway', 'security', 'secrets', 'auth_source_defaults',
  ])
  const patch: SettingsPatch = {}
  if (body.gateway !== undefined) patch.gateway = parseGatewaySettingsPatch(body.gateway)
  if (body.audit_log_retention_days !== undefined) {
    const value = body.audit_log_retention_days
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 3650) {
      throw new GatewayError(
        400,
        'invalid_audit_log_retention_days',
        'audit_log_retention_days must be an integer between 0 and 3650',
      )
    }
    patch.audit_log_retention_days = value as number
  }
  if (body.public !== undefined) {
    const value = requireObject(body.public, 'public')
    rejectUnknownKeys(value, [
      ...MAIN_PUBLIC_FIELDS,
      'site_name',
      'backend_mode_enabled', 'site_subtitle', 'api_base_url', 'contact_info', 'doc_url',
      'site_logo', 'home_content', 'compact_home_enabled', 'hide_ccs_import_button',
      'custom_menu_items', 'custom_endpoints',
      'registration_enabled',
      'registration_email_suffix_whitelist',
      'email_verification_enabled',
      'turnstile_enabled',
      'turnstile_site_key',
      'passkey_enabled',
      'available_channels_enabled',
      'model_plaza_enabled',
      'model_plaza_require_auth',
      'model_plaza_description',
      'promo_code_enabled',
      'invitation_code_enabled',
      'affiliate_enabled',
      'openai_advanced_scheduler_subscription_priority_enabled',
    ])
    const publicPatch: PublicSettingsPatch = parseMainPublicSettings(value)
    if (value.site_name !== undefined) {
      publicPatch.site_name = settingString(value.site_name, 'site_name', 128, false)
    }
    for (const field of ['site_subtitle', 'api_base_url', 'contact_info', 'doc_url', 'site_logo', 'home_content'] as const) {
      if (value[field] !== undefined) publicPatch[field] = settingString(value[field], field, 20_000, true)
    }
    for (const field of ['backend_mode_enabled', 'compact_home_enabled', 'hide_ccs_import_button'] as const) {
      if (value[field] !== undefined) publicPatch[field] = settingBoolean(value[field], field)
    }
    if (value.custom_menu_items !== undefined) publicPatch.custom_menu_items = parseCustomMenuItems(value.custom_menu_items)
    if (value.custom_endpoints !== undefined) publicPatch.custom_endpoints = parseCustomEndpoints(value.custom_endpoints)
    if (value.registration_enabled !== undefined) {
      publicPatch.registration_enabled = settingBoolean(value.registration_enabled, 'registration_enabled')
    }
    if (value.registration_email_suffix_whitelist !== undefined) {
      publicPatch.registration_email_suffix_whitelist = normalizeRegistrationEmailSuffixWhitelist(
        value.registration_email_suffix_whitelist,
      )
    }
    if (value.email_verification_enabled !== undefined) {
      publicPatch.email_verification_enabled = settingBoolean(
        value.email_verification_enabled,
        'email_verification_enabled',
      )
    }
    if (value.turnstile_enabled !== undefined) {
      publicPatch.turnstile_enabled = settingBoolean(value.turnstile_enabled, 'turnstile_enabled')
    }
    if (value.turnstile_site_key !== undefined) {
      publicPatch.turnstile_site_key = settingString(value.turnstile_site_key, 'turnstile_site_key', 2_048, true)
    }
    if (value.passkey_enabled !== undefined) {
      publicPatch.passkey_enabled = settingBoolean(value.passkey_enabled, 'passkey_enabled')
    }
    if (value.available_channels_enabled !== undefined) {
      publicPatch.available_channels_enabled = settingBoolean(
        value.available_channels_enabled,
        'available_channels_enabled',
      )
    }
    if (value.model_plaza_enabled !== undefined) {
      publicPatch.model_plaza_enabled = settingBoolean(value.model_plaza_enabled, 'model_plaza_enabled')
    }
    if (value.model_plaza_require_auth !== undefined) {
      publicPatch.model_plaza_require_auth = settingBoolean(
        value.model_plaza_require_auth,
        'model_plaza_require_auth',
      )
    }
    if (value.model_plaza_description !== undefined) {
      publicPatch.model_plaza_description = settingString(
        value.model_plaza_description,
        'model_plaza_description',
        20_000,
        true,
      )
    }
    if (value.promo_code_enabled !== undefined) {
      publicPatch.promo_code_enabled = settingBoolean(value.promo_code_enabled, 'promo_code_enabled')
    }
    if (value.invitation_code_enabled !== undefined) {
      publicPatch.invitation_code_enabled = settingBoolean(
        value.invitation_code_enabled,
        'invitation_code_enabled',
      )
    }
    if (value.affiliate_enabled !== undefined) {
      publicPatch.affiliate_enabled = settingBoolean(value.affiliate_enabled, 'affiliate_enabled')
    }
    if (value.openai_advanced_scheduler_subscription_priority_enabled !== undefined) {
      publicPatch.openai_advanced_scheduler_subscription_priority_enabled = settingBoolean(
        value.openai_advanced_scheduler_subscription_priority_enabled,
        'openai_advanced_scheduler_subscription_priority_enabled',
      )
    }
    if (Object.keys(publicPatch).length > 0) patch.public = publicPatch
  }
  if (body.security !== undefined) {
    const value = requireObject(body.security, 'security')
    rejectUnknownKeys(value, ['step_up_enabled'])
    const securityPatch: SecuritySettingsPatch = {}
    if (value.step_up_enabled !== undefined) {
      securityPatch.step_up_enabled = settingBoolean(value.step_up_enabled, 'step_up_enabled')
    }
    if (Object.keys(securityPatch).length > 0) patch.security = securityPatch
  }
  if (body.secrets !== undefined) {
    const value = requireObject(body.secrets, 'secrets')
    rejectUnknownKeys(value, SETTINGS_SECRET_KEYS)
    const secretsPatch: SecretSettingsPatch = {}
    for (const key of SETTINGS_SECRET_KEYS) {
      if (value[key] === null) secretsPatch[key] = null
      else if (value[key] !== undefined) secretsPatch[key] = settingString(value[key], key, 4096, false)
    }
    if (Object.keys(secretsPatch).length > 0) patch.secrets = secretsPatch
  }
  if (body.auth_source_defaults !== undefined) {
    const value = requireObject(body.auth_source_defaults, 'auth_source_defaults')
    rejectUnknownKeys(value, AUTH_SOURCES)
    const authDefaults: Partial<Record<AuthSource, AuthSourceDefaultSettings>> = {}
    for (const source of AUTH_SOURCES) {
      if (value[source] === undefined) continue
      authDefaults[source] = parseAuthSourceDefault(value[source], source)
    }
    if (Object.keys(authDefaults).length > 0) patch.auth_source_defaults = authDefaults
  }
  if (
    patch.audit_log_retention_days === undefined && patch.public === undefined &&
    patch.security === undefined && patch.secrets === undefined &&
    patch.auth_source_defaults === undefined
  ) {
    throw new GatewayError(400, 'settings_patch_required', 'At least one system setting is required')
  }
  return patch
}

function parseAuthSourceDefault(value: unknown, source: AuthSource): AuthSourceDefaultSettings {
  const settings = requireObject(value, `auth_source_defaults.${source}`)
  rejectUnknownKeys(settings, [
    'balance', 'concurrency', 'subscriptions', 'grant_on_signup', 'grant_on_first_bind', 'platform_quotas',
  ])
  for (const required of [
    'balance', 'concurrency', 'subscriptions', 'grant_on_signup', 'grant_on_first_bind', 'platform_quotas',
  ]) {
    if (settings[required] === undefined) {
      throw new GatewayError(400, 'invalid_auth_source_defaults', `${source}.${required} is required`)
    }
  }
  const balanceMicros = settingMicros(settings.balance, `${source}.balance`)
  if (!Number.isSafeInteger(settings.concurrency) || (settings.concurrency as number) <= 0) {
    throw new GatewayError(400, 'invalid_auth_source_defaults', `${source}.concurrency must be a positive integer`)
  }
  if (!Array.isArray(settings.subscriptions)) {
    throw new GatewayError(400, 'invalid_auth_source_defaults', `${source}.subscriptions must be an array`)
  }
  if (settings.subscriptions.length > 100) {
    throw new GatewayError(400, 'invalid_auth_source_defaults', `${source}.subscriptions is too large`)
  }
  const seenGroups = new Set<string>()
  const subscriptions = settings.subscriptions.map((item, index) => {
    const subscription = requireObject(item, `${source}.subscriptions[${index}]`)
    rejectUnknownKeys(subscription, ['group_id', 'validity_days'])
    const groupId = settingString(subscription.group_id, `${source}.subscriptions[${index}].group_id`, 128, false)
    if (seenGroups.has(groupId)) {
      throw new GatewayError(400, 'invalid_auth_source_defaults', `${source}.subscriptions contains a duplicate group`)
    }
    seenGroups.add(groupId)
    if (!Number.isSafeInteger(subscription.validity_days) || (subscription.validity_days as number) < 1 ||
      (subscription.validity_days as number) > 36_500) {
      throw new GatewayError(400, 'invalid_auth_source_defaults', `${source}.subscriptions validity_days is invalid`)
    }
    return { group_id: groupId, validity_days: subscription.validity_days as number }
  })
  const rawQuotas = requireObject(settings.platform_quotas, `${source}.platform_quotas`)
  rejectUnknownKeys(rawQuotas, AUTH_SOURCE_QUOTA_PLATFORMS)
  const platform_quotas: AuthSourceDefaultSettings['platform_quotas'] = {}
  for (const platform of AUTH_SOURCE_QUOTA_PLATFORMS) {
    if (rawQuotas[platform] === undefined) continue
    const quota = requireObject(rawQuotas[platform], `${source}.platform_quotas.${platform}`)
    rejectUnknownKeys(quota, ['daily', 'weekly', 'monthly'])
    for (const window of ['daily', 'weekly', 'monthly'] as const) {
      if (!(window in quota)) {
        throw new GatewayError(400, 'invalid_auth_source_defaults', `${source}.${platform}.${window} is required`)
      }
    }
    platform_quotas[platform] = {
      daily: quotaMicrosValue(quota.daily, `${source}.${platform}.daily`),
      weekly: quotaMicrosValue(quota.weekly, `${source}.${platform}.weekly`),
      monthly: quotaMicrosValue(quota.monthly, `${source}.${platform}.monthly`),
    }
  }
  return {
    balance: balanceMicros / 1_000_000,
    concurrency: settings.concurrency as number,
    subscriptions,
    grant_on_signup: settingBoolean(settings.grant_on_signup, `${source}.grant_on_signup`),
    grant_on_first_bind: settingBoolean(settings.grant_on_first_bind, `${source}.grant_on_first_bind`),
    platform_quotas,
  }
}

function quotaMicrosValue(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return settingMicros(value, field) / 1_000_000
}

function settingMicros(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GatewayError(400, 'invalid_auth_source_defaults', `${field} must be a non-negative number`)
  }
  const micros = value * 1_000_000
  if (!Number.isSafeInteger(micros)) {
    throw new GatewayError(400, 'invalid_auth_source_defaults', `${field} must have at most six decimal places`)
  }
  return micros
}

function fromMicros(value: number | null): number | null {
  return value === null ? null : value / 1_000_000
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) {
    throw new GatewayError(400, 'unknown_setting', `Unknown system setting: ${unknown}`)
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function settingBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a boolean`)
  }
  return value
}

function settingString(value: unknown, field: string, maximum: number, allowEmpty: boolean): string {
  if (typeof value !== 'string') {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a string`)
  }
  const normalized = value.trim()
  if ((!allowEmpty && normalized === '') || normalized.length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  }
  return normalized
}

function applyPublicPatch(
  current: PublicSystemSettings,
  patch: PublicSettingsPatch | undefined,
): PublicSystemSettings {
  return patch === undefined ? { ...current } : { ...current, ...patch }
}

async function validateAuthSourceSubscriptionGroups(
  env: Env,
  patch: SettingsPatch['auth_source_defaults'],
): Promise<void> {
  const groupIds = [...new Set(
    Object.values(patch ?? {}).flatMap((settings) => settings?.subscriptions.map((item) => item.group_id) ?? []),
  )]
  for (const groupId of groupIds) {
    const row = await env.DB.prepare(
      `SELECT group_type FROM "groups" WHERE id = ? LIMIT 1`,
    ).bind(groupId).first<{ group_type: string }>()
    if (row?.group_type !== 'subscription') {
      throw new GatewayError(
        400,
        'invalid_auth_source_subscription_group',
        `Authentication source subscription group ${groupId} does not exist or is not a subscription group`,
      )
    }
  }
}

function authSourceDefaultWriteStatements(
  env: Env,
  patch: SettingsPatch['auth_source_defaults'],
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (const source of AUTH_SOURCES) {
    const settings = patch?.[source]
    if (settings === undefined) continue
    statements.push(
      env.DB.prepare(
        `UPDATE auth_source_defaults
            SET balance_micros = ?, concurrency = ?, grant_on_signup = ?,
                grant_on_first_bind = ?, updated_at_ms = ?
          WHERE source = ?`,
      ).bind(
        settingMicros(settings.balance, `${source}.balance`),
        settings.concurrency,
        settings.grant_on_signup ? 1 : 0,
        settings.grant_on_first_bind ? 1 : 0,
        now,
        source,
      ),
      env.DB.prepare('DELETE FROM auth_source_default_subscriptions WHERE source = ?').bind(source),
      env.DB.prepare('DELETE FROM auth_source_default_platform_quotas WHERE source = ?').bind(source),
    )
    for (const subscription of settings.subscriptions) {
      statements.push(env.DB.prepare(
        `INSERT INTO auth_source_default_subscriptions (source, group_id, validity_days)
         VALUES (?, ?, ?)`,
      ).bind(source, subscription.group_id, subscription.validity_days))
    }
    for (const platform of AUTH_SOURCE_QUOTA_PLATFORMS) {
      const quota = settings.platform_quotas[platform]
      if (quota === undefined) continue
      statements.push(env.DB.prepare(
        `INSERT INTO auth_source_default_platform_quotas (
           source, platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
         ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        source,
        platform,
        quota.daily === null ? null : settingMicros(quota.daily, `${source}.${platform}.daily`),
        quota.weekly === null ? null : settingMicros(quota.weekly, `${source}.${platform}.weekly`),
        quota.monthly === null ? null : settingMicros(quota.monthly, `${source}.${platform}.monthly`),
      ))
    }
  }
  return statements
}

function changedFields(patch: SettingsPatch): string[] {
  const fields = Object.keys(patch.public ?? {}).map((key) => `public.${key}`).sort()
  if (patch.audit_log_retention_days !== undefined) fields.push('audit_log_retention_days')
  fields.push(...Object.keys(patch.gateway ?? {}).map(key => `gateway.${key}`))
  fields.push(...Object.keys(patch.security ?? {}).map((key) => `security.${key}`).sort())
  for (const key of SETTINGS_SECRET_KEYS) {
    if (patch.secrets?.[key] !== undefined) fields.push(`secrets.${key}:${patch.secrets[key] === null ? 'clear' : 'set'}`)
  }
  for (const source of AUTH_SOURCES) {
    const settings = patch.auth_source_defaults?.[source]
    if (settings === undefined) continue
    fields.push(...Object.keys(settings).sort().map((key) => `auth_source_defaults.${source}.${key}`))
  }
  return fields
}

async function requireAdminActor(context: Context<ControlBindings>): Promise<AdminActor> {
  const actor = await authenticateAdminSession(context.req.raw, context.env)
  return { session_id: actor.session_id, user_id: actor.user_id }
}

async function publishLatestPublicSettings(env: Env): Promise<void> {
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = await publicAdminSettings(await requireSettingsRow(env), env)
      await env.CONFIG_KV.put(publicSettingsKey(env.ENVIRONMENT), JSON.stringify(publicProjection(candidate)))
      const after = await requireSettingsRow(env)
      if (after.control_version === candidate.control_version) return
    }
    throw new Error('settings changed continuously during projection')
  } catch {
    throw new GatewayError(
      503,
      'public_settings_projection_failed',
      'System settings were saved but the public settings projection failed; retry with the same Idempotency-Key',
      'server_error',
    )
  }
}

function publicProjection(settings: Pick<AdminSystemSettings, 'control_version' | 'public'>): PublicSystemSettings & {
  schema_version: typeof PUBLIC_SETTINGS_SCHEMA_VERSION
  control_version: number
} {
  return {
    schema_version: PUBLIC_SETTINGS_SCHEMA_VERSION,
    control_version: settings.control_version,
    ...settings.public,
  }
}

function validIdempotentSettings(row: Parameters<typeof parseIdempotentResponse>[0]): AdminSystemSettings {
  const value = parseIdempotentResponse<AdminSystemSettings>(row, 'system_settings')
  const normalizedPublic = normalizePublicSystemSettings(value.public)
  const auditLogRetentionDays = value.audit_log_retention_days ?? 180
  if (
    row.resource_id !== 'global' ||
    value.schema_version !== PUBLIC_SETTINGS_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.control_version) ||
    value.control_version < 0 ||
    !Number.isSafeInteger(auditLogRetentionDays) ||
    auditLogRetentionDays < 0 ||
    auditLogRetentionDays > 3650 ||
    !Number.isSafeInteger(value.updated_at_ms) ||
    value.updated_at_ms < 0 ||
    normalizedPublic === null ||
    typeof value.secrets?.turnstile_secret_key_configured !== 'boolean' ||
    (value.security !== undefined && typeof value.security.step_up_enabled !== 'boolean') ||
    !isAuthSourceDefaults(value.auth_source_defaults)
  ) {
    throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
  }
  return {
    ...value,
    audit_log_retention_days: auditLogRetentionDays,
    public: normalizedPublic,
    gateway: normalizeGatewaySettings(value.gateway ?? {}),
    security: value.security ?? { step_up_enabled: false },
  }
}

function isAuthSourceDefaults(value: unknown): value is AuthSourceDefaults {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const defaults = value as Partial<Record<AuthSource, AuthSourceDefaultSettings>>
  return AUTH_SOURCES.every((source) => {
    const setting = defaults[source]
    return setting !== undefined && Number.isFinite(setting.balance) && setting.balance >= 0 &&
      Number.isSafeInteger(setting.concurrency) && setting.concurrency > 0 &&
      Array.isArray(setting.subscriptions) && typeof setting.grant_on_signup === 'boolean' &&
      typeof setting.grant_on_first_bind === 'boolean' && setting.platform_quotas !== null &&
      typeof setting.platform_quotas === 'object'
  })
}

function requireSettingsMasterKey(env: Env): string {
  const value = env.CREDENTIALS_MASTER_KEY
  if (!value || value.length < 32) {
    throw new GatewayError(503, 'settings_encryption_not_configured', 'System settings encryption is not configured', 'server_error')
  }
  return value
}

function settingSecretAad(environment: string, key: SystemSettingSecretKey, keyVersion: number): string {
  return `system-setting-secret:v1:${environment}:global:${key}:${keyVersion}`
}

function settingsVersionConflict(): GatewayError {
  return new GatewayError(409, 'settings_version_conflict', 'System settings changed; reload and retry')
}

function isSettingsVersionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /CHECK constraint failed:.*control_version/i.test(message)
}

function isStepUpEnablementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /CHECK constraint failed:.*step_up_enabled/i.test(message)
}
