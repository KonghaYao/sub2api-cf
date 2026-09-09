import { sha256Hex } from './crypto'
import type { AccountCredential } from './types'
import type { ProviderRequestPlan } from './providers'

type Account = Pick<AccountCredential, 'platform' | 'credential_kind' | 'runtime_snapshot' | 'provider_config'>
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const fields: Record<string, string> = {installation_id:'installation','x-codex-installation-id':'installation',session_id:'session','session-id':'session',thread_id:'thread','thread-id':'thread',turn_id:'turn','turn-id':'turn',window_id:'window','x-codex-window-id':'window','x-client-request-id':'request'}

/** Original credential namespace: duplicate local rows and token refreshes must
 * not create new upstream cache identities. Never use a local account row ID. */
export async function openAIOAuthCredentialNamespace(account: Account, credential: Record<string, unknown>): Promise<string | null> {
  if (account.platform !== 'codex' && !(account.platform === 'openai' && ['oauth','setup_token'].includes(account.credential_kind))) return null
  const upstream = text(credential.chatgpt_account_id) || text(account.provider_config?.account_id)
  if (upstream) return 'chatgpt:' + upstream + (text(credential.chatgpt_user_id) ? ':user:' + text(credential.chatgpt_user_id) : '')
  let seed = ''
  try { seed = text(JSON.parse(account.runtime_snapshot?.ui_config_json ?? '{}')?.extra?.codex_fingerprint_seed) } catch { /* No stored seed. */ }
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(seed) && seed !== '00000000-0000-0000-0000-000000000000') return 'seed:' + seed
  if (account.credential_kind === 'setup_token' && text(credential.access_token)) return 'setup-token:' + (await sha256Hex('openai-setup-token:' + text(credential.access_token))).slice(0,32)
  return ''
}

export async function applyOpenAIOAuthCacheIdentity(plan: ProviderRequestPlan, account: Account, credential: Record<string, unknown>, apiKeyId: string, mode: 'native' | 'chat' = 'native'): Promise<void> {
  const namespace = await openAIOAuthCredentialNamespace(account, credential)
  const source = record(plan.body)
  if (namespace === null || !source) return
  const key = text(source.prompt_cache_key)
  plan.headers.delete('session_id')
  plan.headers.delete('conversation_id')
  if (key) {
    // Worker API-key identifiers are strings; encode the namespace unambiguously.
    const isolated = (await sha256Hex(JSON.stringify(['worker-openai-native-session-v1',apiKeyId,namespace,key]))).slice(0,16)
    const hash = mode === 'chat' ? await sha256Hex(isolated) : ''
    const session = mode === 'chat' ? `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${((parseInt(hash[16]!,16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}` : isolated
    plan.headers.set('session_id',session)
    plan.headers.set('conversation_id',isolated)
  }
  if (!namespace) return
  const body = { ...source }
  const scope = async (kind: string, raw: string) => {
    const hash = await sha256Hex(JSON.stringify(['sub2api:codex-account-identity:v1',apiKeyId,namespace,kind,raw.trim()]))
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${((parseInt(hash[16]!,16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`
  }
  const scopeFields = async (values: Record<string, unknown>) => {
    let changed = false
    for (const [name,kind] of Object.entries(fields)) if (text(values[name])) { values[name] = await scope(kind,values[name] as string); changed = true }
    return changed
  }
  const originalMetadata = record(source.client_metadata)
  const metadata = originalMetadata ? { ...originalMetadata } : undefined
  if (metadata) body.client_metadata = metadata
  const originalSession = metadata?.session_id
  if (metadata) {
    await scopeFields(metadata)
    if (typeof metadata['x-codex-turn-metadata'] === 'string') {
      try { const embedded = record(JSON.parse(metadata['x-codex-turn-metadata'])); if (embedded && await scopeFields(embedded)) metadata['x-codex-turn-metadata'] = JSON.stringify(embedded) } catch { /* Preserve unparseable metadata. */ }
    }
  }
  if (key) body.prompt_cache_key = await scope(text(originalSession) && source.prompt_cache_key === originalSession ? 'session' : 'prompt-cache',key)
  plan.body = body
}
