import { GatewayError } from '../gateway/errors'
import { sha256Hex } from '../gateway/crypto'
import { CodexImportNumber, type CodexImportValue } from './codex-import-content'
import { parseCodexImportTime } from './codex-import-expiry'
import { codexAgentIdentityKeys,codexImportIdentityKeys } from './codex-import-identity'
import { OPENAI_OAUTH_CLIENT_ID } from './openai-oauth-http'

type ObjectValue = Record<string,unknown>
const object = (value: unknown): ObjectValue | null => value && typeof value==='object' && !Array.isArray(value) && !(value instanceof CodexImportNumber) ? value as ObjectValue : null
const string = (value: unknown) => typeof value==='string' ? value.trim() : value instanceof CodexImportNumber ? value.text : typeof value==='number' && Number.isFinite(value) ? String(value) : ''
function path(value: unknown, key: string): unknown { for (const part of key.split('.')) value=object(value)?.[part]; return value }
function first(value: unknown,...keys: string[]): string { for (const key of keys) { const result=string(path(value,key)); if (result) return result } return '' }
function time(value: unknown,...keys: string[]): number | null { for (const key of keys) { const result=parseCodexImportTime(path(value,key)); if (result!==null) return result } return null }
function fail(message: string): never { throw new GatewayError(400,'invalid_codex_import_entry',message) }
export interface NormalizedCodexImport {
  name: string; accessToken: string; refreshToken: string; idToken: string; email: string; accountId: string
  userId: string; planType: string; organization: string; tokenExpiresAt: number | null; isAgentIdentity: boolean
  agentRuntimeId: string; credentials: Record<string,unknown>; extra: Record<string,unknown>; identityKeys: string[]; warnings: string[]
}
/** Decode identity hints exactly as the original importer; this does not verify JWT signatures. */
function claims(token: string): ObjectValue | null {
  try {
    const pieces=token.split('.'); if (pieces.length!==3) return null
    const segment=pieces[1]!.replace(/\r|\n/g,'')
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(segment)) return null
    const text=atob(segment.replaceAll('-','+').replaceAll('_','/'))
    const value=object(JSON.parse(new TextDecoder().decode(Uint8Array.from(text,c=>c.charCodeAt(0)))))
    if (!value) return null
    for (const key of ['sub','email']) if (value[key]!=null && typeof value[key]!=='string') return null
    for (const key of ['exp','iat']) if (value[key]!=null && !Number.isSafeInteger(value[key])) return null
    const rawAuth=value['https://api.openai.com/auth'],auth=object(rawAuth)
    if (rawAuth!=null && !auth) return null
    if (auth) {
      for (const key of ['chatgpt_account_id','chatgpt_user_id','chatgpt_plan_type','user_id','poid']) if (auth[key]!=null && typeof auth[key]!=='string') return null
      if (auth.organizations!=null && (!Array.isArray(auth.organizations) || auth.organizations.some(org=>
        org!=null && (!object(org) || org.id!=null && typeof org.id!=='string' || org.is_default!=null && typeof org.is_default!=='boolean')))) return null
    }
    return value
  } catch { return null }
}
function enrich(item: NormalizedCodexImport,token: string,validateExpiry: boolean,now: number) {
  const jwt=claims(token)
  if (!jwt) { if (validateExpiry) item.warnings.push('accessToken 不是可解析 JWT，无法校验过期时间和账号身份'); return }
  if (validateExpiry && typeof jwt.exp==='number' && jwt.exp>0) {
    const expires=jwt.exp*1000
    if (!Number.isSafeInteger(expires) || expires>8.64e15) fail('access_token 过期时间无法表示')
    if (Math.floor(now/1000)>jwt.exp+120) fail(`access_token 已过期: ${new Date(expires).toISOString()}`)
    item.tokenExpiresAt=expires;item.credentials.expires_at=new Date(expires).toISOString()
  }
  item.email ||= string(jwt.email)
  const auth=object(jwt['https://api.openai.com/auth'])
  if (auth) {
    item.accountId ||= string(auth.chatgpt_account_id)
    item.userId ||= first(auth,'chatgpt_user_id','user_id')
    item.planType ||= string(auth.chatgpt_plan_type)
    item.organization ||= string(auth.poid)
    const organizations=Array.isArray(auth.organizations)?auth.organizations.map(object).filter(v=>v!==null):[]
    item.organization ||= string(organizations.find(org=>org.is_default===true)?.id)
    item.organization ||= string(organizations[0]?.id)
  }
  item.userId ||= string(jwt.sub)
}
export async function normalizeCodexImportEntry(entry: { index:number; value:CodexImportValue },now=Date.now()): Promise<NormalizedCodexImport> {
  const item: NormalizedCodexImport={ name:'',accessToken:'',refreshToken:'',idToken:'',email:'',accountId:'',userId:'',planType:'',organization:'',
    tokenExpiresAt:null,isAgentIdentity:false,agentRuntimeId:'',credentials:{},extra:{import_source:'codex_session',imported_at:new Date(now).toISOString()},identityKeys:[],warnings:[] }
  const raw=object(entry.value)
  if (typeof entry.value==='string') item.accessToken=entry.value.trim()
  else if (raw) {
    const nested=object(raw.agent_identity) ?? object(raw.agentIdentity)
    if (nested || ['agentidentity','agent_identity'].includes(first(raw,'auth_mode','authMode').toLowerCase())) {
      const agent=nested??raw
      item.isAgentIdentity=true;item.agentRuntimeId=first(agent,'agent_runtime_id','agentRuntimeId')
      const privateKey=first(agent,'agent_private_key','agentPrivateKey'),task=first(agent,'task_id','taskId')
      item.accountId=first(agent,'account_id','accountId');item.userId=first(agent,'chatgpt_user_id','chatgptUserId')
      item.email=first(agent,'email');item.planType=first(agent,'plan_type','planType')
      if (!item.agentRuntimeId || !privateKey || !item.accountId || !item.userId) fail('agent identity 缺少必要字段')
      try {
        if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(privateKey)) throw new Error()
        await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(privateKey),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign'])
      } catch { fail('agent identity private key 格式无效') }
      let fedramp=false
      for (const key of ['chatgpt_account_is_fedramp','chatgptAccountIsFedramp']) {
        const value=agent[key]
        if (typeof value==='boolean') { fedramp=value;break }
        if (typeof value==='string' && /^(?:1|0|t|f|T|F|TRUE|FALSE|True|False|true|false)$/.test(value.trim())) { fedramp=['1','t','T','TRUE','True','true'].includes(value.trim());break }
      }
      item.credentials={auth_mode:'agentIdentity',agent_runtime_id:item.agentRuntimeId,agent_private_key:privateKey,
        chatgpt_account_id:item.accountId,chatgpt_user_id:item.userId,chatgpt_account_is_fedramp:fedramp}
      if (task) item.credentials.task_id=task
      else item.warnings.push('未包含 task_id，首次请求会使用现有 runtime 注册新 task')
      if (item.email) item.credentials.email=item.email
      if (item.planType) item.credentials.plan_type=item.planType
      item.identityKeys=codexAgentIdentityKeys(item.accountId)
      item.name=item.email||item.accountId||item.userId||`Codex 导入账号 ${entry.index}`
      return item
    }
    item.accessToken=first(raw,'tokens.access_token','tokens.accessToken','access_token','accessToken','token')
    item.refreshToken=first(raw,'tokens.refresh_token','tokens.refreshToken','refresh_token','refreshToken')
    item.idToken=first(raw,'tokens.id_token','tokens.idToken','id_token','idToken')
    item.email=first(raw,'email','user.email')
    item.accountId=first(raw,'chatgpt_account_id','chatgptAccountId','account_id','accountId','account.id','account.account_id','account.chatgpt_account_id')
    item.userId=first(raw,'chatgpt_user_id','chatgptUserId','user_id','userId','user.id')
    item.planType=first(raw,'plan_type','planType','account.plan_type','account.planType')
    item.organization=first(raw,'organization_id','organizationId','org_id','orgId')
    item.name=first(raw,'name','user.name')
    const provider=first(raw,'auth_provider','authProvider');if(provider) item.extra.auth_provider=provider
    if(first(raw,'session_token','sessionToken')) {item.extra.session_token_present=true;item.warnings.push('sessionToken 已忽略，不会作为 OAuth refresh_token 存储')}
    const sessionExpiry=time(raw,'expires');if(sessionExpiry!==null) item.extra.session_expires_at=new Date(sessionExpiry).toISOString()
    item.tokenExpiresAt=time(raw,'tokens.expires_at','tokens.expiresAt','expires_at','expiresAt')
    if(item.tokenExpiresAt!==null) {
      if(Math.floor(item.tokenExpiresAt/1000)<=Math.floor(now/1000)-120) fail(`access_token 已过期: ${new Date(item.tokenExpiresAt).toISOString()}`)
      item.credentials.expires_at=new Date(item.tokenExpiresAt).toISOString()
    }
    for(const [key,p] of Object.entries({user_image:'user.image',user_picture:'user.picture',account_structure:'account.structure',account_residency_region:'account.residencyRegion',compute_residency:'account.computeResidency'})) {
      const value=first(raw,p);if(value) item.extra[key]=value
    }
  } else fail(`第 ${entry.index} 条格式不支持`)
  if(!item.accessToken) fail('缺少 accessToken/access_token')
  item.credentials.access_token=item.accessToken
  if(item.refreshToken) {item.credentials.refresh_token=item.refreshToken;item.credentials.client_id=OPENAI_OAUTH_CLIENT_ID}
  if(item.idToken) {item.credentials.id_token=item.idToken;enrich(item,item.idToken,false,now)}
  enrich(item,item.accessToken,true,now)
  if(!Object.hasOwn(item.credentials,'expires_at')) item.warnings.push('无法从 accessToken 解析过期时间，导入后需自行确认令牌有效性')
  if(!item.refreshToken) item.warnings.push('未包含 refresh_token，accessToken 过期后无法自动续期')
  for(const [key,value] of Object.entries({email:item.email,chatgpt_account_id:item.accountId,chatgpt_user_id:item.userId,organization_id:item.organization,plan_type:item.planType})) if(value) item.credentials[key]=value
  item.extra.access_token_sha256=await sha256Hex(item.accessToken)
  item.identityKeys=await codexImportIdentityKeys(item)
  item.name=item.name||item.email||item.accountId||item.userId||`Codex 导入账号 ${entry.index}`
  return item
}
