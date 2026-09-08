import type { Env } from '../env'
import { decryptCredential, encryptCredential } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'

export interface SmtpConfig {
  smtp_host: string; smtp_port: number; smtp_username: string; smtp_password: string
  smtp_from_email: string; smtp_from_name: string; smtp_use_tls: boolean
}
const EMPTY: SmtpConfig = { smtp_host: '', smtp_port: 587, smtp_username: '', smtp_password: '', smtp_from_email: '', smtp_from_name: 'Sub2API', smtp_use_tls: true }
const AAD = 'email-delivery-settings:v1'
interface Row { config_json: string; password_nonce_b64: string | null; password_ciphertext_b64: string | null; control_version: number }

export async function readSmtpConfig(env: Pick<Env, 'DB' | 'CREDENTIALS_MASTER_KEY'>, decrypt = true): Promise<SmtpConfig & { control_version: number; smtp_password_configured: boolean }> {
  const row = await env.DB.prepare("SELECT config_json,password_nonce_b64,password_ciphertext_b64,control_version FROM email_delivery_settings WHERE id='global'").first<Row>()
  if (!row) return { ...EMPTY, control_version: 0, smtp_password_configured: false }
  let password = ''
  if (decrypt && row.password_nonce_b64 && row.password_ciphertext_b64) {
    password = (await decryptCredential(row.password_nonce_b64, row.password_ciphertext_b64, masterKey(env), AAD)).api_key
  }
  return { ...EMPTY, ...JSON.parse(row.config_json), smtp_password: password, control_version: row.control_version, smtp_password_configured: !!row.password_ciphertext_b64 }
}

export function mergeSmtpConfig(current: SmtpConfig, body: Record<string, unknown>): SmtpConfig {
  const config: SmtpConfig = { smtp_host: current.smtp_host, smtp_port: current.smtp_port, smtp_username: current.smtp_username, smtp_password: current.smtp_password, smtp_from_email: current.smtp_from_email, smtp_from_name: current.smtp_from_name, smtp_use_tls: current.smtp_use_tls }
  for (const field of ['smtp_host', 'smtp_username', 'smtp_password', 'smtp_from_email', 'smtp_from_name'] as const) {
    if (body[field] === undefined) continue
    const value = body[field]
    if (typeof value !== 'string' || value.length > (field === 'smtp_password' ? 4096 : 320) || /[\r\n\0]/.test(value)) {
      throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
    }
    // Blank password means keep the currently configured secret, as in the original form.
    if (field === 'smtp_password' && value === '') continue
    config[field] = field === 'smtp_password' ? value : value.trim()
  }
  if (body.smtp_port !== undefined) {
    if (!Number.isInteger(body.smtp_port) || (body.smtp_port as number) < 1 || (body.smtp_port as number) > 65535) throw new GatewayError(400, 'invalid_smtp_port', 'SMTP port is invalid')
    config.smtp_port = body.smtp_port as number
  }
  if (body.smtp_use_tls !== undefined) {
    if (typeof body.smtp_use_tls !== 'boolean') throw new GatewayError(400, 'invalid_smtp_use_tls', 'SMTP TLS option is invalid')
    config.smtp_use_tls = body.smtp_use_tls
  }
  if (config.smtp_host && (!/^[A-Za-z0-9.-]+$/.test(config.smtp_host) || config.smtp_host.length > 253)) throw new GatewayError(400, 'invalid_smtp_host', 'SMTP host must be a hostname')
  if (config.smtp_from_email && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.smtp_from_email)) throw new GatewayError(400, 'invalid_smtp_from_email', 'SMTP sender email is invalid')
  return config
}

export async function saveSmtpConfig(env: Env, config: SmtpConfig, expected: number): Promise<void> {
  const { smtp_password, ...publicConfig } = config
  const encrypted = smtp_password ? await encryptCredential({ api_key: smtp_password }, masterKey(env), AAD) : null
  const result = await env.DB.prepare(`INSERT INTO email_delivery_settings(id,config_json,password_nonce_b64,password_ciphertext_b64,control_version,updated_at_ms)
    SELECT 'global',?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM email_delivery_settings WHERE id='global')
    ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,password_nonce_b64=excluded.password_nonce_b64,
      password_ciphertext_b64=excluded.password_ciphertext_b64,control_version=email_delivery_settings.control_version+1,updated_at_ms=excluded.updated_at_ms
    WHERE email_delivery_settings.control_version=?`)
    .bind(JSON.stringify(publicConfig), encrypted?.nonce_b64 ?? null, encrypted?.ciphertext_b64 ?? null, 1, Date.now(), expected, expected).run()
  if (!result.meta.changes) throw new GatewayError(412, 'control_version_conflict', 'Email settings changed; reload before saving')
}
function masterKey(env: Pick<Env, 'CREDENTIALS_MASTER_KEY'>): string {
  if (!env.CREDENTIALS_MASTER_KEY || env.CREDENTIALS_MASTER_KEY.length < 32) throw new GatewayError(503, 'email_encryption_not_configured', 'Email credential encryption is not configured')
  return env.CREDENTIALS_MASTER_KEY
}
