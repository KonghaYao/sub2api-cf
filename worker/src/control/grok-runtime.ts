import type { Env } from '../env'
import type { ProviderAccount } from '../gateway/providers'
import { grokDefaults, grokBaseURL, parseGrokSettings } from './grok-settings'
export async function readGrokSettings(env:Env){const row=await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<{gateway_json:string}>();const value=row?JSON.parse(row.gateway_json):{};return {...grokDefaults,...parseGrokSettings(Object.fromEntries(Object.entries(value).filter(([key])=>key in grokDefaults)))}}
/** Explicit endpoints remain stable; only opted-in defaults follow global mode changes. */
export async function effectiveGrokAccount<T extends ProviderAccount>(env:Env,account:T):Promise<T>{if(account.platform!=='grok'||!account.provider_config.use_default_base_url)return account;return {...account,base_url:grokBaseURL(await readGrokSettings(env))}}
