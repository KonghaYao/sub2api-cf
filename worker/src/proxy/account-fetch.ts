import { loadGatewaySettings } from '../control/gateway-settings'
import { applyProviderBodySettings, applyProviderIdentity } from '../gateway/provider-forwarding'
import type { Env } from '../env'
import { loadProxyForRequest } from '../control/proxies'
import { proxyFetch } from './transport'

export type AccountFetcher = (url: string | URL, init?: RequestInit) => Promise<Response>
export function accountProxyId(uiJson: string | null | undefined): unknown {
  if (!uiJson) return undefined
  return (JSON.parse(uiJson) as Record<string,unknown>).proxy_id
}
/** Missing binding costs no database read. An assigned proxy never silently falls back to direct. */
export function accountFetcher(env: Env, proxyId: unknown, identity?: {platform:string;credential_kind?:string;id?:string;account_id?:string}): AccountFetcher {
  return async (url, init = {}) => {
    if(identity && (identity.platform==='codex' || ['openai','anthropic'].includes(identity.platform)&&['oauth','setup_token'].includes(identity.credential_kind??''))){
      const settings=await loadGatewaySettings(env),headers=new Headers(init.headers)
      await applyProviderIdentity(env,settings,identity,headers)
      const target=new URL(url)
      if(target.hostname==='auth.openai.com')headers.delete('version')
      let body=init.body
      if(typeof body==='string'&&headers.get('content-type')?.includes('application/json'))body=JSON.stringify(await applyProviderBodySettings(settings,identity.platform,identity.credential_kind??'',JSON.parse(body)))
      init={...init,headers,body}
    }
    const proxy = await loadProxyForRequest(env, proxyId)
    return proxy === null ? fetch(url, init) : proxyFetch(proxy, url, init)
  }
}
