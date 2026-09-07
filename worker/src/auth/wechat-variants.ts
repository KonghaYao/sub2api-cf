import type { Env } from '../env'
import { decryptCredential, encryptCredential } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'
export const WECHAT_MODES = ['open', 'mp', 'mobile'] as const
export type WechatMode = typeof WECHAT_MODES[number]
export interface WechatVariant { enabled: boolean; client_id: string; client_secret?: string; client_secret_configured?: boolean }
export type WechatVariants = Partial<Record<WechatMode, WechatVariant>>
interface Row { mode: WechatMode; enabled: number; client_id: string; nonce_b64: string; ciphertext_b64: string }
const aad = (env: Env, mode: string) => `wechat-variant:v1:${env.ENVIRONMENT}:${mode}`
export async function readWechatVariants(env: Env, secrets = false): Promise<WechatVariants> {
  const rows = await env.DB.prepare('SELECT mode,enabled,client_id,nonce_b64,ciphertext_b64 FROM oauth_wechat_variants ORDER BY mode').all<Row>()
  const result: WechatVariants = {}
  for (const row of rows.results) result[row.mode] = { enabled: row.enabled === 1, client_id: row.client_id, client_secret_configured: !!row.ciphertext_b64,
    ...(secrets ? { client_secret: (await decryptCredential(row.nonce_b64,row.ciphertext_b64,env.CREDENTIALS_MASTER_KEY!,aad(env,row.mode))).api_key } : {}) }
  return result
}
export function parseWechatVariants(input: unknown): WechatVariants | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  const result: WechatVariants = {}
  for (const [mode,raw] of Object.entries(input)) {
    if (!WECHAT_MODES.includes(mode as WechatMode) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid()
    const value = raw as Record<string, unknown>
    if (Object.keys(value).some(key => !['enabled','client_id','client_secret','client_secret_configured'].includes(key)) || typeof value.enabled !== 'boolean' || typeof value.client_id !== 'string' || value.client_id.length > 512 || (value.client_secret !== undefined && (typeof value.client_secret !== 'string' || value.client_secret.length > 4096))) throw invalid()
    result[mode as WechatMode] = { enabled: value.enabled, client_id: value.client_id.trim(), ...(value.client_secret ? { client_secret: value.client_secret as string } : {}) }
  }
  return result
}
export async function prepareWechatVariants(env: Env, patch: WechatVariants | undefined): Promise<{ statements: D1PreparedStatement[]; public: WechatVariants }> {
  const current = await readWechatVariants(env, true), statements: D1PreparedStatement[] = []
  for (const mode of WECHAT_MODES) {
    if (patch?.[mode] === undefined) continue
    const variant = { ...current[mode], ...patch[mode] } as WechatVariant
    if (variant.enabled && (!variant.client_id || !variant.client_secret)) throw invalid()
    if (!variant.client_id || !variant.client_secret) { statements.push(env.DB.prepare('DELETE FROM oauth_wechat_variants WHERE mode=?').bind(mode)); delete current[mode]; continue }
    const encrypted = await encryptCredential({api_key:variant.client_secret},env.CREDENTIALS_MASTER_KEY!,aad(env,mode))
    statements.push(env.DB.prepare(`INSERT INTO oauth_wechat_variants(mode,enabled,client_id,nonce_b64,ciphertext_b64) VALUES(?,?,?,?,?) ON CONFLICT(mode) DO UPDATE SET enabled=excluded.enabled,client_id=excluded.client_id,nonce_b64=excluded.nonce_b64,ciphertext_b64=excluded.ciphertext_b64`).bind(mode,variant.enabled?1:0,variant.client_id,encrypted.nonce_b64,encrypted.ciphertext_b64))
    current[mode] = variant
  }
  return { statements, public: Object.fromEntries(Object.entries(current).map(([mode, {client_secret,...value}]) => [mode,{...value,client_secret_configured:!!client_secret}])) }
}
function invalid(): GatewayError { return new GatewayError(400,'invalid_wechat_variants','WeChat app settings are invalid; enabled apps require ID and secret') }
