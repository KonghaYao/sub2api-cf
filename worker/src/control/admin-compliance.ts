import type { Context } from 'hono'

import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateAdminSession } from './admin-auth'
import { controlError, controlSuccess, readJsonObject } from './http'

type ControlBindings = { Bindings: Env }

const VERSION = 'v2026.06.10'
const DOCUMENT_PATH_ZH = 'docs/legal/admin-compliance.zh.md'
const DOCUMENT_PATH_EN = 'docs/legal/admin-compliance.en.md'
const DOCUMENT_URL_ZH = 'https://github.com/Wei-Shaw/sub2api/blob/main/docs/legal/admin-compliance.zh.md'
const DOCUMENT_URL_EN = 'https://github.com/Wei-Shaw/sub2api/blob/main/docs/legal/admin-compliance.en.md'
const ACK_PHRASE_ZH = '我已阅读、理解并同意 Sub2API 部署与运营合规承诺'
const ACK_PHRASE_EN = 'I have read, understood, and agree to the Sub2API Deployment and Operation Compliance Commitment'
const MAX_USER_AGENT_LENGTH = 512
const MAX_IP_ADDRESS_LENGTH = 128

interface AcknowledgementRow {
  admin_user_id: string
  version: string
  document_zh: string
  document_en: string
  ip_address: string | null
  user_agent: string | null
  accepted_at_ms: number
}

export async function getAdminComplianceStatus(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    return controlSuccess(await statusFor(context.env, actor.user_id))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function acceptAdminCompliance(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, 8 * 1024)
    const language = normalizeLanguage(body.language)
    const phrase = requirePhrase(body.phrase)
    if (phrase !== expectedPhrase(language)) {
      throw new GatewayError(400, 'ADMIN_COMPLIANCE_INVALID_PHRASE', 'confirmation phrase does not match')
    }
    const now = Date.now()
    await context.env.DB.prepare(
      `INSERT INTO admin_compliance_acknowledgements (
         admin_user_id, version, document_zh, document_en, language,
         ip_address, user_agent, accepted_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(admin_user_id, version) DO UPDATE SET
         document_zh = excluded.document_zh,
         document_en = excluded.document_en,
         language = excluded.language,
         ip_address = excluded.ip_address,
         user_agent = excluded.user_agent,
         accepted_at_ms = excluded.accepted_at_ms`,
    ).bind(
      actor.user_id, VERSION, DOCUMENT_PATH_ZH, DOCUMENT_PATH_EN, language,
      trustedCfConnectingIp(context.req.raw), boundedUserAgent(context.req.raw), now,
    ).run()
    return controlSuccess(await statusFor(context.env, actor.user_id))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function statusFor(env: Env, adminUserId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    `SELECT admin_user_id, version, document_zh, document_en, ip_address, user_agent, accepted_at_ms
       FROM admin_compliance_acknowledgements
      WHERE admin_user_id = ? AND version = ?`,
  ).bind(adminUserId, VERSION).first<AcknowledgementRow>()
  return {
    required: row === null,
    version: VERSION,
    document_path_zh: DOCUMENT_PATH_ZH,
    document_path_en: DOCUMENT_PATH_EN,
    document_url_zh: DOCUMENT_URL_ZH,
    document_url_en: DOCUMENT_URL_EN,
    ack_phrase_zh: ACK_PHRASE_ZH,
    ack_phrase_en: ACK_PHRASE_EN,
    ...(row === null ? {} : { acknowledgement: acknowledgement(row) }),
  }
}

function acknowledgement(row: AcknowledgementRow): Record<string, unknown> {
  return {
    version: row.version,
    document_zh: row.document_zh,
    document_en: row.document_en,
    admin_user_id: row.admin_user_id,
    ...(row.ip_address === null ? {} : { ip_address: row.ip_address }),
    ...(row.user_agent === null ? {} : { user_agent: row.user_agent }),
    accepted_at: new Date(row.accepted_at_ms).toISOString(),
  }
}

function normalizeLanguage(value: unknown): 'zh' | 'en' {
  if (typeof value !== 'string') return 'en'
  return value.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function expectedPhrase(language: 'zh' | 'en'): string {
  return language === 'zh' ? ACK_PHRASE_ZH : ACK_PHRASE_EN
}

function requirePhrase(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 1_024) {
    throw new GatewayError(400, 'invalid_phrase', 'phrase must be a non-empty string')
  }
  return value.trim()
}

/** Cloudflare owns this header; no client-provided forwarding header is consulted. */
function trustedCfConnectingIp(request: Request): string | null {
  const value = request.headers.get('cf-connecting-ip')?.trim() ?? ''
  return value.length > 0 && value.length <= MAX_IP_ADDRESS_LENGTH ? value : null
}

function boundedUserAgent(request: Request): string | null {
  const value = request.headers.get('user-agent')?.trim() ?? ''
  return value.length > 0 ? value.slice(0, MAX_USER_AGENT_LENGTH) : null
}
