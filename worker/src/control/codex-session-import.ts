import type { Context } from 'hono'
import type { Env } from '../env'
import { GatewayError,asGatewayError } from '../gateway/errors'
import { decryptCredentialPayload,sha256Hex } from '../gateway/crypto'
import { credentialAad } from '../gateway/repository'
import { controlError,controlSuccess,readJsonObject,requireResourceId } from './http'
import { executeAccountCreate,executeAccountUpdate } from './accounts'
import { executeCodexImportBatch,type CodexImportBatchRequest,type CodexImportStoredAccount } from './codex-import-batch'
import { parseCodexImportEntries } from './codex-import-content'

interface Stored extends CodexImportStoredAccount { controlVersion:number }
async function load(env: Env,id: string): Promise<Stored> {
  const row=await env.DB.prepare(`SELECT a.id,a.control_version,a.ui_config_json,s.id AS secret_id,s.key_version,s.nonce_b64,s.ciphertext_b64
    FROM accounts a JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id WHERE a.id=?`).bind(id)
    .first<{id:string;control_version:number;ui_config_json:string;secret_id:string;key_version:number;nonce_b64:string;ciphertext_b64:string}>()
  if(!row) throw new GatewayError(409,'import_account_changed','Imported account was removed; start a new import to create another account')
  if(!env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503,'credentials_not_configured','Credential storage is not configured')
  const credentials=await decryptCredentialPayload(row.nonce_b64,row.ciphertext_b64,env.CREDENTIALS_MASTER_KEY,
    credentialAad(env.ENVIRONMENT,row.id,row.secret_id,row.key_version)) as unknown as Record<string,unknown>
  const ui=JSON.parse(row.ui_config_json)
  const text=(key:string)=>typeof credentials[key]==='string'?credentials[key] as string:''
  return {id,controlVersion:row.control_version,credentials,extra:ui.extra??{},agentRuntimeId:text('agent_runtime_id'),identity:{
    accountId:text('chatgpt_account_id'),userId:text('chatgpt_user_id'),email:text('email'),accessToken:text('access_token'),refreshToken:text('refresh_token')}}
}
function validate(body: Record<string,unknown>) {
  for(const field of ['extra','credential_extras']) if(body[field]===null) delete body[field]
  for(const field of ['name','notes']) if(body[field]!=null && typeof body[field]!=='string') throw new GatewayError(400,'invalid_codex_import_request',`${field} must be a string`)
  for(const field of ['update_existing','auto_pause_on_expired','skip_default_group_bind','confirm_mixed_channel_risk']) if(body[field]!=null && typeof body[field]!=='boolean') throw new GatewayError(400,'invalid_codex_import_request',`${field} must be boolean`)
  for(const field of ['concurrency','priority','load_factor','expires_at']) if(body[field]!=null && !Number.isSafeInteger(body[field])) throw new GatewayError(400,'invalid_codex_import_request',`${field} must be an integer`)
  if(typeof body.concurrency==='number' && body.concurrency<0 || typeof body.priority==='number' && body.priority<0 || typeof body.load_factor==='number' && body.load_factor>10000) throw new GatewayError(400,'invalid_codex_import_request','Invalid account scheduling settings')
  if(body.rate_multiplier!=null && (typeof body.rate_multiplier!=='number' || !Number.isFinite(body.rate_multiplier) || body.rate_multiplier<0)) throw new GatewayError(400,'invalid_codex_import_request','Invalid rate multiplier')
  for(const field of ['extra','credential_extras']) if(body[field]!=null && (typeof body[field]!=='object' || Array.isArray(body[field]))) throw new GatewayError(400,'invalid_codex_import_request',`${field} must be an object`)
  const extra=body.extra as Record<string,unknown>|undefined
  if(extra?.openai_long_context_billing_enabled!==undefined && typeof extra.openai_long_context_billing_enabled!=='boolean') throw new GatewayError(400,'OPENAI_LONG_CONTEXT_BILLING_INVALID','openai_long_context_billing_enabled must be a boolean')
  if(body.group_ids!==undefined && !Array.isArray(body.group_ids)) throw new GatewayError(400,'invalid_codex_import_request','group_ids must be an array')
  const identifier=(value:unknown)=>requireResourceId(typeof value==='string'?value:Number.isSafeInteger(value)&&Number(value)>0?String(value):undefined,'group')
  if(Array.isArray(body.group_ids)) body.group_ids=body.group_ids.map(identifier)
  if(body.proxy_id!=null && body.proxy_id!==0) body.proxy_id=identifier(body.proxy_id)
  if(!parseCodexImportEntries(body as CodexImportBatchRequest).length) throw new GatewayError(400,'empty_codex_import','请输入 accessToken 或 Codex session JSON')
}
export async function importAdminCodexSession(c: Context<{Bindings:Env}>) {
  let owner: string|undefined,operationId: string|undefined
  try {
    const body=await readJsonObject(c.req.raw);validate(body)
    const key=c.req.header('idempotency-key')?.trim()||crypto.randomUUID()
    if(key.length>200) throw new GatewayError(400,'invalid_idempotency_key','Idempotency key is too long')
    operationId=await sha256Hex(`codex-import:${key}`)
    const requestHash=await sha256Hex(JSON.stringify(body)),now=Date.now()
    await c.env.DB.prepare('INSERT OR IGNORE INTO codex_import_operations(id,request_hash,created_at_ms) VALUES (?,?,?)').bind(operationId,requestHash,now).run()
    const operation=await c.env.DB.prepare('SELECT request_hash,created_at_ms,result_json FROM codex_import_operations WHERE id=?').bind(operationId)
      .first<{request_hash:string;created_at_ms:number;result_json:string|null}>()
    if(!operation || operation.request_hash!==requestHash) throw new GatewayError(409,'idempotency_conflict','Import key was already used for different data')
    if(operation.result_json!==null) return controlSuccess(JSON.parse(operation.result_json))
    owner=crypto.randomUUID()
    const claimed=await c.env.DB.prepare(`UPDATE codex_import_operations SET lease_token=?,lease_until_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)+300000
      WHERE id=? AND result_json IS NULL AND lease_until_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) RETURNING id`).bind(owner,operationId).first()
    if(!claimed) throw new GatewayError(409,'codex_import_in_progress','This import is already running')
    const ids=await c.env.DB.prepare("SELECT id FROM accounts WHERE platform='openai' AND credential_kind='oauth' ORDER BY created_at_ms DESC,id DESC").all<{id:string}>()
    const accounts: Stored[]=[]
    for(const row of ids.results) accounts.push(await load(c.env,row.id))
    let needsRecovery=false
    const result=await executeCodexImportBatch(body as CodexImportBatchRequest,accounts,async write=>{
      try {
      const receipt=await c.env.DB.prepare('SELECT action,account_id FROM codex_import_items WHERE operation_id=? AND item_index=?')
        .bind(operationId,write.index).first<{action:'created'|'updated';account_id:string}>()
      if(receipt) return {...await load(c.env,receipt.account_id),receiptAction:receipt.action}
      const commitReceipt=(id:string)=>c.env.DB.prepare(`INSERT INTO codex_import_items(operation_id,item_index,action,account_id)
        VALUES (?,?,?,CASE WHEN EXISTS(SELECT 1 FROM codex_import_operations WHERE id=? AND lease_token=? AND lease_until_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)) THEN ? ELSE NULL END)`)
        .bind(operationId,write.index,write.action,operationId,owner,id)
      const patch:Record<string,unknown>={credentials:write.credentials,extra:write.extra}
      for(const field of ['concurrency','priority','rate_multiplier','load_factor','proxy_id']) if(body[field]!=null) patch[field]=body[field]
      if(write.accountExpiresAt!==null) patch.expires_at=write.accountExpiresAt
      if(write.autoPauseOnExpired!==undefined) patch.auto_pause_on_expired=write.autoPauseOnExpired
      if(Array.isArray(body.group_ids) && body.group_ids.length) patch.group_ids=body.group_ids
      let id:string
      if(write.existing) {
        const current=write.existing as Stored
        // The import merger returns a complete credential map. Translate its
        // deletions to the account editor's patch protocol as well as additions.
        const credentialPatch:Record<string,unknown>={...write.credentials}
        for(const field of Object.keys(current.credentials)) {
          if(!Object.hasOwn(write.credentials,field)) credentialPatch[field]=null
        }
        patch.credentials=credentialPatch
        await executeAccountUpdate(c.env,current.id,patch,current.controlVersion,undefined,{receipt:commitReceipt})
        id=current.id
      } else {
        if(!patch.group_ids && body.skip_default_group_bind!==true) {
          const group=await c.env.DB.prepare(`SELECT id FROM "groups" WHERE platform='openai' AND enabled=1 AND name='openai-default' ORDER BY created_at_ms,id LIMIT 1`).first<{id:string}>()
          if(group) patch.group_ids=[group.id]
        }
        const created=await executeAccountCreate(c.env,{...patch,name:write.name,notes:body.notes,platform:'openai',type:'oauth',
          concurrency:body.concurrency??3,priority:body.priority??50},`codex-import-${operationId}-${write.index}`,true,commitReceipt)
        id=created.account.id
      }
      return await load(c.env,id)
      } catch(error) {
        // A successful transaction can be followed by a failed read or response.
        // Keep the whole operation resumable instead of caching a false failure.
        try {
          const committed=await c.env.DB.prepare('SELECT account_id FROM codex_import_items WHERE operation_id=? AND item_index=?')
            .bind(operationId,write.index).first()
          if(committed) needsRecovery=true
        } catch { needsRecovery=true }
        throw error
      }
    },operation.created_at_ms)
    if(needsRecovery) throw new GatewayError(409,'codex_import_recovery_required','Import has committed entries; retry with the same operation key')
    const saved=await c.env.DB.prepare(`UPDATE codex_import_operations SET result_json=?,lease_token=NULL,lease_until_ms=0 WHERE id=? AND lease_token=? AND lease_until_ms>CAST(unixepoch('subsec')*1000 AS INTEGER) RETURNING id`)
      .bind(JSON.stringify(result),operationId,owner).first()
    if(!saved) throw new GatewayError(409,'codex_import_lease_lost','Import changed; retry with the same operation key')
    return controlSuccess(result)
  } catch(error) {return controlError(asGatewayError(error))}
  finally {
    if(owner && operationId) try {await c.env.DB.prepare('UPDATE codex_import_operations SET lease_token=NULL,lease_until_ms=0 WHERE id=? AND lease_token=?').bind(operationId,owner).run()} catch { /* Lease expiry permits crash recovery. */ }
  }
}
