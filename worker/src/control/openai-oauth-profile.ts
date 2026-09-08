import type { Env } from '../env'
import { openAIOAuthHttp, type OpenAITokens } from './openai-oauth-http'

type ObjectValue = Record<string, unknown>
export interface OpenAITokenInfo extends OpenAITokens {
  expires_in: number; expires_at: number; client_id: string
  email?: string; chatgpt_account_id?: string; chatgpt_user_id?: string; organization_id?: string
  plan_type?: string; subscription_expires_at?: string; privacy_mode?: string
}
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

export function openAITokenInfo(tokens: OpenAITokens, clientId: string, now = Date.now()): OpenAITokenInfo {
  const info: OpenAITokenInfo = { ...tokens, refresh_token: tokens.refresh_token ?? '', expires_in: tokens.expires_in ?? 0,
    expires_at: Math.floor(now / 1000) + (tokens.expires_in ?? 0), client_id: clientId }
  const claims = decodeClaims(tokens.id_token)
  // Original ID-token profile parsing permits two minutes of clock skew.
  if (typeof claims.exp === 'number' && claims.exp > 0 && Math.floor(now / 1000) > claims.exp + 120) return info
  const auth = object(claims['https://api.openai.com/auth'])
  const organizations = Array.isArray(auth.organizations) ? auth.organizations.map(object) : []
  const organization = organizations.find(org => org.is_default === true) ?? organizations[0]
  const values = { email: claims.email, chatgpt_account_id: auth.chatgpt_account_id, chatgpt_user_id: auth.chatgpt_user_id,
    plan_type: auth.chatgpt_plan_type, organization_id: organization?.id }
  for (const [key, value] of Object.entries(values)) if (string(value)) Object.assign(info, { [key]: string(value) })
  return info
}
function decodeClaims(token: string | undefined): ObjectValue {
  try {
    const parts = token?.split('.')
    if (parts?.length !== 3) return {}
    const encoded = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), c => c.charCodeAt(0))
    return object(JSON.parse(new TextDecoder().decode(bytes)))
  } catch { return {} }
}

/** Return the upstream observation, including failures; never infer success from a completed request. */
export async function setOpenAIPrivacy(env: Env, accessToken: string, proxyId: string | null, timeoutMs = 5000): Promise<string> {
  try {
    const response = await openAIOAuthHttp(env, 'https://chatgpt.com/backend-api/settings/account_user_setting?feature=training_allowed&value=false', {
      method: 'PATCH', headers: { authorization: `Bearer ${accessToken}`, origin: 'https://chatgpt.com', referer: 'https://chatgpt.com/',
        accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' },
    }, proxyId, timeoutMs)
    return response.status >= 200 && response.status < 300 ? 'training_off'
      : [403, 503].includes(response.status) && /cloudflare|cf-|Just a moment/.test(response.text) ? 'training_set_cf_blocked' : 'training_set_failed'
  } catch { return 'training_set_failed' }
}

/** Profile and privacy requests are best effort, as in the Go OAuth service. */
export async function enrichOpenAITokenInfo(env: Env, info: OpenAITokenInfo, proxyId: string | null): Promise<void> {
  const headers = { authorization: `Bearer ${info.access_token}`, origin: 'https://chatgpt.com', referer: 'https://chatgpt.com/', accept: 'application/json' }
  const get = async (url: string) => {
    try {
      const response = await openAIOAuthHttp(env, url, { headers }, proxyId, 5000)
      return response.status >= 200 && response.status < 300 ? object(JSON.parse(response.text)) : {}
    } catch { return {} }
  }
  const orgId = info.organization_id || string(object(decodeClaims(info.access_token)['https://api.openai.com/auth']).poid)
  const privacy = setOpenAIPrivacy(env, info.access_token, proxyId).then(mode => { info.privacy_mode = mode })
  const profile = (async () => {
    const result = await get('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27')
    const selected = selectChatGPTAccount(result, orgId)
    let forcePersonal = false
    if (selected) {
      const applyPlan = !info.plan_type?.trim()
      if (applyPlan) info.plan_type = selected.plan
      if (selected.expires) {
        if (applyPlan || !info.chatgpt_account_id || !selected.id || info.chatgpt_account_id.toLowerCase() === selected.id.toLowerCase()) {
          info.subscription_expires_at = selected.expires
        } else forcePersonal = true
      }
    }
    const personalId = info.chatgpt_account_id || info.organization_id || orgId
    if ((forcePersonal || !info.subscription_expires_at) && personalId) {
      const result = await get(`https://chatgpt.com/backend-api/subscriptions?account_id=${encodeURIComponent(personalId)}`)
      const expiry = string(result.active_until)
      if (rfc3339(expiry)) info.subscription_expires_at = expiry
    }
  })()
  await Promise.all([privacy, profile])
}
function rfc3339(value: string) { return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) }
function deactivated(value: ObjectValue): boolean {
  return ['deactivated', 'is_deactivated', 'disabled', 'is_disabled'].some(key => value[key] === true)
    || ['deactivated_at', 'disabled_at', 'deleted_at'].some(key => string(value[key]) !== '')
    || ['status', 'state'].some(key => ['deactivated', 'disabled', 'deleted', 'inactive', 'suspended'].includes(string(value[key]).toLowerCase()))
}
export function selectChatGPTAccount(result: ObjectValue, orgId: string, now = Date.now()): { id: string; plan: string; expires: string } | undefined {
  const candidates = Object.entries(object(result.accounts)).flatMap(([key, raw]) => {
    const item = object(raw); const account = object(item.account); const entitlement = object(item.entitlement)
    const expires = string(entitlement.expires_at)
    if (deactivated(item) || deactivated(account) || (rfc3339(expires) && Date.parse(expires) <= now)) return []
    const plan = string(account.plan_type) || string(entitlement.subscription_plan)
    return plan ? [{ key, id: string(account.account_id) || key, plan, expires, isDefault: account.is_default === true }] : []
  })
  return candidates.find(row => row.key === orgId) ?? candidates.filter(row => row.isDefault).at(-1)
    ?? candidates.find(row => row.plan.toLowerCase() !== 'free') ?? candidates[0]
}
