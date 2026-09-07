import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { authenticateAdminSession } from './admin-auth'
import { authenticateUserRequest } from '../auth/handler'
import { apiKeyDigest } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError } from './http'
import { isSourceIpAllowed, parseStoredIpPolicy } from '../gateway/ip-policy'
import { loadRuntimeSetting } from './runtime-settings'

const privateRanges = parseStoredIpPolicy(JSON.stringify(['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','224.0.0.0/4','240.0.0.0/4','::/128','::1/128','fc00::/7','fe80::/10','ff00::/8']), 'ip_denylist_json')
export const enforcePanelRateLimit: MiddlewareHandler<{ Bindings: Env }> = async (context,next) => {
  const path = new URL(context.req.url).pathname
  if (!path.startsWith('/api/v1/') || context.req.method === 'OPTIONS') return next()
  const isPublic = /^\/api\/v1\/(settings\/public|auth\/(login|register|forgot-password|send-verify-code)|announcements\/public)(\/|$)/.test(path)
  if (!isPublic && !context.req.header('authorization') && !context.req.header('x-api-key')) return next()
  const publicIp = isPublic ? context.req.header('cf-connecting-ip') ?? null : null
  if (isPublic && !isSourceIpAllowed(publicIp,[],privateRanges)) return next()
  // Bootstrap and recovery have their own break-glass authorization and budgets.
  if (/^\/api\/v1\/admin\/(bootstrap|session\/recover)$/.test(path)) return next()
  try {
    const settings = await loadRuntimeSetting(context.env,'panel-rate-limit')
    if (!settings.enabled) return next()
    let subject: string, limits: Array<[string,number]>
    if (isPublic) {
      const ip = context.req.header('cf-connecting-ip') ?? null
      if (!isSourceIpAllowed(ip,[],privateRanges) || settings.public_ip_rpm === 0) return next()
      subject = `panel:ip:${ip}`; limits = [['public',settings.public_ip_rpm]]
    } else {
      let id: string, admin: boolean
      try {
        if (path.startsWith('/api/v1/admin/')) { const actor = await authenticateAdminSession(context.req.raw,context.env); id=actor.user_id;admin=true }
        else { const user=await authenticateUserRequest(context.req.raw,context.env);id=user.id;admin=user.role==='admin' }
      } catch (error) {
        // The endpoint's existing authentication owns its unauthenticated response.
        if (error instanceof GatewayError && [401,403].includes(error.status)) return next()
        throw error
      }
      if (admin && settings.exempt_admin) return next()
      subject=`panel:user:${id}`;limits=[['user',settings.user_rpm]]
      if (/\/(usage|dashboard|stats|trends|export)(\/|$)/.test(path)) limits.push(['heavy',settings.heavy_rpm])
    }
    const active=limits.filter(([,limit])=>limit>0)
    if (active.length === 0) return next()
    const now=Date.now(), window=Math.floor(now/60000)*60000
    const pepper=context.env.API_KEY_PEPPER
    if (!pepper) throw new GatewayError(503,'panel_rate_limit_unavailable','Panel rate limiting is not configured','server_error')
    const digest=await apiKeyDigest(subject,pepper)
    const results=await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM panel_rate_windows WHERE expires_at_ms<?').bind(now),
      ...active.map(([kind])=>context.env.DB.prepare(`INSERT INTO panel_rate_windows(subject_digest,window_ms,kind,attempts,expires_at_ms) VALUES(?,?,?,1,?) ON CONFLICT(subject_digest,window_ms,kind) DO UPDATE SET attempts=panel_rate_windows.attempts+1 RETURNING attempts`).bind(digest,window,kind,window+120000)),
    ])
    if (active.some(([,limit],index)=>(results[index+1].results[0] as {attempts:number}).attempts>limit)) {
      const response=controlError(new GatewayError(429,'panel_rate_limit_exceeded','Panel request rate limit exceeded','rate_limit_error'))
      response.headers.set('retry-after',String(Math.max(1,Math.ceil((window+60000-now)/1000))))
      return response
    }
    return next()
  } catch (error) { return controlError(asGatewayError(error)) }
}
