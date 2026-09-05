import type { Context } from 'hono'
import type { Env } from '../env'
import {
  apiKeyDigest,
  decryptCredential,
  encryptCredential,
} from '../gateway/crypto'
import { isOpaqueToken, tokenDigest } from '../auth/tokens'
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
import { passkeyDeploymentConfiguration } from '../auth/passkey-config'

type ControlBindings = { Bindings: Env }

export const PUBLIC_SETTINGS_SCHEMA_VERSION = 1 as const

export interface PublicSystemSettings {
  site_name: string
  registration_enabled: boolean
  email_verification_enabled: boolean
  turnstile_enabled: boolean
  turnstile_site_key: string
  passkey_enabled?: boolean
  model_plaza_enabled: boolean
  model_plaza_require_auth: boolean
  model_plaza_description: string
  promo_code_enabled: boolean
  invitation_code_enabled: boolean
  affiliate_enabled: boolean
}

export interface AdminSystemSettings {
  schema_version: typeof PUBLIC_SETTINGS_SCHEMA_VERSION
  control_version: number
  public: PublicSystemSettings
  security: {
    step_up_enabled: boolean
    passkey_configured: boolean
    passkey_rp_id: string
    passkey_rp_origins: string[]
  }
  secrets: { turnstile_secret_key_configured: boolean }
  updated_at_ms: number
}

interface PublicSettingsPatch {
  site_name?: string
  registration_enabled?: boolean
  email_verification_enabled?: boolean
  turnstile_enabled?: boolean
  turnstile_site_key?: string
  passkey_enabled?: boolean
  model_plaza_enabled?: boolean
  model_plaza_require_auth?: boolean
  model_plaza_description?: string
  promo_code_enabled?: boolean
  invitation_code_enabled?: boolean
  affiliate_enabled?: boolean
}

interface SecretSettingsPatch {
  turnstile_secret_key?: string | null
}

interface SecuritySettingsPatch {
  step_up_enabled?: boolean
}

interface SettingsPatch {
  public?: PublicSettingsPatch
  security?: SecuritySettingsPatch
  secrets?: SecretSettingsPatch
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
  public_json: string
  step_up_enabled: number
  updated_at_ms: number
  turnstile_secret_key_configured: number
  turnstile_secret_key_version: number | null
}

export type SystemSettingSecretKey = 'turnstile_secret_key'

export function publicSettingsKey(environment: string): string {
  return `${environment}:public-settings:v1`
}

export async function getAdminSettings(context: Context<ControlBindings>): Promise<Response> {
  try {
    const settings = publicAdminSettings(await requireSettingsRow(context.env), context.env)
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
    const current = publicAdminSettings(currentRow, context.env)
    if (current.control_version !== expectedVersion) {
      throw settingsVersionConflict()
    }
    if (current.control_version >= Number.MAX_SAFE_INTEGER) {
      throw new GatewayError(409, 'settings_version_exhausted', 'System settings version is exhausted')
    }
    const actor = await requireAdminActor(context)
    const nextVersion = current.control_version + 1
    const nextPublic = applyPublicPatch(current.public, patch.public)
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
      public: nextPublic,
      security: {
        step_up_enabled: nextStepUpEnabled,
        passkey_configured: current.security.passkey_configured,
        passkey_rp_id: current.security.passkey_rp_id,
        passkey_rp_origins: current.security.passkey_rp_origins,
      },
      secrets: {
        turnstile_secret_key_configured:
          patch.secrets?.turnstile_secret_key === undefined
            ? current.secrets.turnstile_secret_key_configured
            : patch.secrets.turnstile_secret_key !== null,
      },
      updated_at_ms: now,
    }
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `UPDATE system_settings
            SET control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                public_json = ?,
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
        requiresTotpForEnable ? 1 : 0,
        actor.user_id,
        nextStepUpEnabled ? 1 : 0,
        now,
      ),
    ]
    const secretPatch = patch.secrets?.turnstile_secret_key
    if (secretPatch === null) {
      statements.push(context.env.DB.prepare(
        `DELETE FROM system_setting_secrets
          WHERE settings_id = 'global' AND key = 'turnstile_secret_key'`,
      ))
    } else if (secretPatch !== undefined) {
      const keyVersion = (currentRow.turnstile_secret_key_version ?? 0) + 1
      const encrypted = await encryptCredential(
        { api_key: secretPatch },
        requireSettingsMasterKey(context.env),
        settingSecretAad(context.env.ENVIRONMENT, 'turnstile_secret_key', keyVersion),
      )
      statements.push(context.env.DB.prepare(
        `INSERT INTO system_setting_secrets (
           settings_id, key, schema_version, key_version,
           nonce_b64, ciphertext_b64, updated_at_ms
         ) VALUES ('global', 'turnstile_secret_key', 1, ?, ?, ?, ?)
         ON CONFLICT(settings_id, key) DO UPDATE SET
           key_version = excluded.key_version,
           nonce_b64 = excluded.nonce_b64,
           ciphertext_b64 = excluded.ciphertext_b64,
           updated_at_ms = excluded.updated_at_ms`,
      ).bind(keyVersion, encrypted.nonce_b64, encrypted.ciphertext_b64, now))
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
    `SELECT s.schema_version, s.control_version, s.public_json, s.step_up_enabled, s.updated_at_ms,
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

function publicAdminSettings(row: SettingsRow, env: Env): AdminSystemSettings {
  if (
    row.schema_version !== PUBLIC_SETTINGS_SCHEMA_VERSION ||
    !Number.isSafeInteger(row.control_version) ||
    row.control_version < 0 ||
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
    public: normalizedPublicSettings,
    security: {
      step_up_enabled: row.step_up_enabled === 1,
      passkey_configured: passkey.configured,
      passkey_rp_id: passkey.rpId,
      passkey_rp_origins: passkey.rpOrigins,
    },
    secrets: { turnstile_secret_key_configured: row.turnstile_secret_key_configured === 1 },
    updated_at_ms: row.updated_at_ms,
  }
}

function normalizePublicSystemSettings(value: unknown): PublicSystemSettings | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const settings = value as Record<string, unknown>
  if (
    typeof settings.site_name !== 'string' ||
    typeof settings.registration_enabled !== 'boolean' ||
    typeof settings.email_verification_enabled !== 'boolean' ||
    typeof settings.turnstile_enabled !== 'boolean' ||
    typeof settings.turnstile_site_key !== 'string' ||
    (settings.passkey_enabled !== undefined && typeof settings.passkey_enabled !== 'boolean') ||
    (settings.model_plaza_enabled !== undefined && typeof settings.model_plaza_enabled !== 'boolean') ||
    (settings.model_plaza_require_auth !== undefined && typeof settings.model_plaza_require_auth !== 'boolean') ||
    (settings.model_plaza_description !== undefined && typeof settings.model_plaza_description !== 'string') ||
    (settings.promo_code_enabled !== undefined && typeof settings.promo_code_enabled !== 'boolean') ||
    (settings.invitation_code_enabled !== undefined && typeof settings.invitation_code_enabled !== 'boolean') ||
    (settings.affiliate_enabled !== undefined && typeof settings.affiliate_enabled !== 'boolean')
  ) return null
  return {
    site_name: settings.site_name,
    registration_enabled: settings.registration_enabled,
    email_verification_enabled: settings.email_verification_enabled,
    turnstile_enabled: settings.turnstile_enabled,
    turnstile_site_key: settings.turnstile_site_key,
    passkey_enabled: settings.passkey_enabled === true,
    model_plaza_enabled: settings.model_plaza_enabled === true,
    model_plaza_require_auth: settings.model_plaza_require_auth === true,
    model_plaza_description:
      typeof settings.model_plaza_description === 'string' ? settings.model_plaza_description : '',
    promo_code_enabled: settings.promo_code_enabled === true,
    invitation_code_enabled: settings.invitation_code_enabled === true,
    affiliate_enabled: settings.affiliate_enabled === true,
  }
}

function isPublicSystemSettings(value: unknown): value is PublicSystemSettings {
  return normalizePublicSystemSettings(value) !== null
}

function settingsResponse(settings: AdminSystemSettings): Response {
  const response = controlSuccess(settings)
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
  rejectUnknownKeys(body, ['public', 'security', 'secrets'])
  const patch: SettingsPatch = {}
  if (body.public !== undefined) {
    const value = requireObject(body.public, 'public')
    rejectUnknownKeys(value, [
      'site_name',
      'registration_enabled',
      'email_verification_enabled',
      'turnstile_enabled',
      'turnstile_site_key',
      'passkey_enabled',
      'model_plaza_enabled',
      'model_plaza_require_auth',
      'model_plaza_description',
      'promo_code_enabled',
      'invitation_code_enabled',
      'affiliate_enabled',
    ])
    const publicPatch: PublicSettingsPatch = {}
    if (value.site_name !== undefined) {
      publicPatch.site_name = settingString(value.site_name, 'site_name', 128, false)
    }
    if (value.registration_enabled !== undefined) {
      publicPatch.registration_enabled = settingBoolean(value.registration_enabled, 'registration_enabled')
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
    rejectUnknownKeys(value, ['turnstile_secret_key'])
    const secretsPatch: SecretSettingsPatch = {}
    if (value.turnstile_secret_key === null) {
      secretsPatch.turnstile_secret_key = null
    } else if (value.turnstile_secret_key !== undefined) {
      secretsPatch.turnstile_secret_key = settingString(
        value.turnstile_secret_key,
        'turnstile_secret_key',
        4_096,
        false,
      )
    }
    if (Object.keys(secretsPatch).length > 0) patch.secrets = secretsPatch
  }
  if (patch.public === undefined && patch.security === undefined && patch.secrets === undefined) {
    throw new GatewayError(400, 'settings_patch_required', 'At least one system setting is required')
  }
  return patch
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

function changedFields(patch: SettingsPatch): string[] {
  const fields = Object.keys(patch.public ?? {}).map((key) => `public.${key}`).sort()
  fields.push(...Object.keys(patch.security ?? {}).map((key) => `security.${key}`).sort())
  if (patch.secrets?.turnstile_secret_key !== undefined) {
    fields.push(`secrets.turnstile_secret_key:${patch.secrets.turnstile_secret_key === null ? 'clear' : 'set'}`)
  }
  return fields
}

async function requireAdminActor(context: Context<ControlBindings>): Promise<AdminActor> {
  const authorization = context.req.header('authorization')?.trim() ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  const pepper = context.env.API_KEY_PEPPER
  if (match === null || !pepper || pepper.length < 32) {
    throw new GatewayError(401, 'admin_session_context_required', 'Admin session context is required', 'authentication_error')
  }
  if (isOpaqueToken(match[1], 'access')) {
    const digest = await tokenDigest(match[1], pepper, 'access')
    const actor = await context.env.DB.prepare(
      `SELECT s.id AS session_id, s.user_id
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.access_token_hash = ? AND s.revoked_at_ms IS NULL
          AND s.access_expires_at_ms > ? AND s.auth_version = u.auth_version
          AND u.status = 'active' AND u.role = 'admin'
        LIMIT 1`,
    ).bind(digest, Date.now()).first<AdminActor>()
    if (actor === null) {
      throw new GatewayError(401, 'admin_session_context_required', 'Admin session context is required', 'authentication_error')
    }
    return actor
  }
  const digest = await apiKeyDigest(`admin-session:v1:${match[1]}`, pepper)
  const actor = await context.env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id
       FROM admin_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
        AND u.status = 'active' AND u.role = 'admin'
      LIMIT 1`,
  ).bind(digest, Date.now()).first<AdminActor>()
  if (actor === null) {
    throw new GatewayError(401, 'admin_session_context_required', 'Admin session context is required', 'authentication_error')
  }
  return actor
}

async function publishLatestPublicSettings(env: Env): Promise<void> {
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = publicAdminSettings(await requireSettingsRow(env), env)
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

function publicProjection(settings: AdminSystemSettings): PublicSystemSettings & {
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
  if (
    row.resource_id !== 'global' ||
    value.schema_version !== PUBLIC_SETTINGS_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.control_version) ||
    value.control_version < 0 ||
    !Number.isSafeInteger(value.updated_at_ms) ||
    value.updated_at_ms < 0 ||
    normalizedPublic === null ||
    typeof value.secrets?.turnstile_secret_key_configured !== 'boolean' ||
    (value.security !== undefined && typeof value.security.step_up_enabled !== 'boolean')
  ) {
    throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
  }
  return {
    ...value,
    public: normalizedPublic,
    security: value.security ?? { step_up_enabled: false },
  }
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
