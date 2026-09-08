import { GatewayError } from '../gateway/errors'
import { parseCodexImportEntries } from './codex-import-content'
import { normalizeCodexImportEntry } from './codex-import-normalize'
import { resolveCodexImportExpiry } from './codex-import-expiry'
import { CodexImportAccountIndex,codexIdentityConflicts,mergeCodexImportCredentials,type CodexImportIdentity } from './codex-import-identity'

export interface CodexImportStoredAccount {
  receiptAction?: 'created' | 'updated'
  id: string; identity: CodexImportIdentity; agentRuntimeId?: string
  credentials: Record<string,unknown>; extra: Record<string,unknown>
}
export interface CodexImportBatchRequest {
  content?: string; contents?: string[]; name?: string; update_existing?: boolean
  expires_at?: number; auto_pause_on_expired?: boolean; credential_extras?: Record<string,unknown>; extra?: Record<string,unknown>
}
export interface CodexImportWrite {
  index: number; action: 'created' | 'updated'; existing: CodexImportStoredAccount | null
  name: string; credentials: Record<string,unknown>; extra: Record<string,unknown>
  accountExpiresAt: number | null; autoPauseOnExpired: boolean | undefined; isAgentIdentity: boolean
}
const protectedFields=new Set(['access_token','refresh_token','id_token','expires_at','email','chatgpt_account_id','chatgpt_user_id',
  'organization_id','plan_type','client_id','auth_mode','openai_auth_mode','token_type','chatgpt_account_is_fedramp','agent_runtime_id','agent_private_key','task_id',
  // The Worker execution credential alias must follow the normalized access token.
  'api_key'])
export function sanitizeCodexCredentialExtras(input: Record<string,unknown> = {}): Record<string,unknown> {
  const result: Record<string,unknown>=Object.create(null)
  for(const [key,value] of Object.entries(input)) {
    const normalized=key.trim()
    if(normalized && !protectedFields.has(normalized.toLowerCase())) result[normalized]=value
  }
  return result
}

/** Sequential original import semantics. The persistence adapter must atomically
 * save each write with an operation receipt before this engine is exposed by HTTP. */
export async function executeCodexImportBatch(request: CodexImportBatchRequest, existing: CodexImportStoredAccount[],
  persist: (write: CodexImportWrite) => Promise<CodexImportStoredAccount>,now=Date.now()) {
  const entries=parseCodexImportEntries(request)
  if(!entries.length) throw new GatewayError(400,'empty_codex_import','请输入 accessToken 或 Codex session JSON')
  const index=new CodexImportAccountIndex<CodexImportStoredAccount>()
  for(const account of existing) await index.add(account)
  const seen=new Map<string,{index:number;userId:string}>(), extras=sanitizeCodexCredentialExtras(request.credential_extras)
  const result={total:entries.length,created:0,updated:0,skipped:0,failed:0,
    items:[] as Array<{index:number;name?:string;action:string;account_id?:string;message?:string}>,
    warnings:[] as Array<{index:number;name?:string;message:string}>,errors:[] as Array<{index:number;name?:string;message:string}>}
  for(const entry of entries) {
    let name: string | undefined
    try {
      const item=await normalizeCodexImportEntry(entry,now)
      name=request.name?.trim() ? request.name.trim()+(entries.length>1?` #${entry.index}`:'') : item.name
      const expiry=resolveCodexImportExpiry({expiresAt:request.expires_at,autoPauseOnExpired:request.auto_pause_on_expired},item,now)
      if(expiry.credentialExpiresAt!==null) item.credentials.expires_at=new Date(expiry.credentialExpiresAt).toISOString()
      for(const message of [...item.warnings,...expiry.warnings]) result.warnings.push({index:entry.index,name,message})
      let duplicate: number | undefined
      for(const key of item.identityKeys) {
        const previous=seen.get(key)
        if(previous && !codexIdentityConflicts(key,item.userId,previous.userId)) {duplicate=previous.index;break}
      }
      if(duplicate!==undefined) {
        const message=`与第 ${duplicate} 条导入项重复，已跳过`
        result.skipped++;result.items.push({index:entry.index,name,action:'skipped',message});result.warnings.push({index:entry.index,name,message});continue
      }
      // Mark before persistence, like the original: a failed first occurrence
      // does not cause later copies in the same batch to perform another write.
      for(const key of item.identityKeys) seen.set(key,{index:entry.index,userId:item.userId})
      const match=index.find(item.identityKeys,item.userId)
      const current=request.update_existing!==false ? match?.account??null : null
      let credentials={...item.credentials,...extras}, extra={...request.extra,...item.extra}
      if(current) {
        if(match!.key.startsWith('account:') && item.userId && !current.identity.userId?.trim()) result.warnings.push({index:entry.index,name,
          message:'已有账号未记录 chatgpt_user_id，已按共享的 chatgpt_account_id 匹配并回填，请确认两者属于同一用户'})
        if(!item.refreshToken && typeof current.credentials.refresh_token==='string' && current.credentials.refresh_token.trim()) {
          result.warnings.push({index:entry.index,name,message:'已有账号包含 refresh_token，本次 accessToken-only 导入已保留自动续期凭据'})
          expiry.accountExpiresAt=null;expiry.autoPauseOnExpired=undefined
        }
        credentials=mergeCodexImportCredentials(current.credentials,credentials,item)
        extra={...current.extra,...extra}
      }
      if(item.accessToken) credentials.api_key=item.accessToken
      const action=current?'updated':'created'
      const saved=await persist({index:entry.index,action,existing:current,name,credentials,extra,
        accountExpiresAt:expiry.accountExpiresAt,autoPauseOnExpired:expiry.autoPauseOnExpired,isAgentIdentity:item.isAgentIdentity})
      await index.add(saved)
      const recordedAction=saved.receiptAction??action
      result[recordedAction]++;result.items.push({index:entry.index,name,action:recordedAction,account_id:saved.id})
    } catch(error) {
      // Unexpected persistence exceptions can contain SQL or request material.
      const message=error instanceof GatewayError ? error.message : 'Codex account import write failed'
      result.failed++;result.items.push({index:entry.index,...(name?{name}:{}),action:'failed',message})
      result.errors.push({index:entry.index,...(name?{name}:{}),message})
    }
  }
  return result
}
