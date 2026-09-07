import type { Env } from '../env'
import type { ProviderAccount } from '../gateway/providers'
import { antigravityDefaults, parseAntigravitySettings } from '../gateway/providers/antigravity'
import { effectiveGrokAccount } from './grok-runtime'
export async function effectiveProviderAccount<T extends ProviderAccount>(env:Env,account:T):Promise<T>{
 if(account.platform!=='antigravity')return effectiveGrokAccount(env,account)
 const row=await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<{gateway_json:string}>(), raw=row?JSON.parse(row.gateway_json):{}
 return {...account,antigravity_settings:{...antigravityDefaults,...parseAntigravitySettings(Object.fromEntries(Object.entries(raw).filter(([key])=>key in antigravityDefaults)))}}
}
