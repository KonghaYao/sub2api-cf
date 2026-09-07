import type { Context } from 'hono'
import type { Env } from '../env'
import { apiKeyDigest, randomToken } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { getAuthenticatedAdminActor } from './admin-auth'
import { controlError, controlSuccess } from './http'

type Bindings = { Bindings: Env }

export async function getAdminAutomationKey(context: Context<Bindings>): Promise<Response> {
  try {
    const row = await context.env.DB.prepare("SELECT masked_key FROM admin_automation_keys WHERE id = 'global'")
      .first<{ masked_key: string }>()
    return controlSuccess({ exists: row !== null, masked_key: row?.masked_key ?? '' })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function regenerateAdminAutomationKey(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await getAuthenticatedAdminActor(context.req.raw)
    if (actor.session_type === 'admin_api_key') {
      throw new GatewayError(403, 'admin_user_session_required', 'Sign in to manage the administrator API key')
    }
    const pepper = context.env.API_KEY_PEPPER
    if (!pepper || pepper.length < 32) throw new GatewayError(503, 'admin_auth_not_configured', 'Admin authentication is not configured')
    const key = `admin-api-${randomToken(36)}`
    const hash = await apiKeyDigest(`admin-api-key:v1:${key}`, pepper)
    await context.env.DB.prepare(`INSERT INTO admin_automation_keys(id,user_id,key_hash,masked_key,created_at_ms)
      VALUES ('global',?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,
      key_hash=excluded.key_hash,masked_key=excluded.masked_key,created_at_ms=excluded.created_at_ms`)
      .bind(actor.user_id, hash, `${key.slice(0, 10)}…${key.slice(-4)}`, Date.now()).run()
    return controlSuccess({ key })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function deleteAdminAutomationKey(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await getAuthenticatedAdminActor(context.req.raw)
    if (actor.session_type === 'admin_api_key') {
      throw new GatewayError(403, 'admin_user_session_required', 'Sign in to manage the administrator API key')
    }
    await context.env.DB.prepare("DELETE FROM admin_automation_keys WHERE id = 'global'").run()
    return controlSuccess({ message: 'Admin API key deleted' })
  } catch (error) { return controlError(asGatewayError(error)) }
}
