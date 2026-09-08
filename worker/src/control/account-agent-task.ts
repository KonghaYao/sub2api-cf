import type { Env } from '../env'
import { decryptCredentialPayload,encryptCredential } from '../gateway/crypto'
import { credentialAad } from '../gateway/repository'
import { GatewayError } from '../gateway/errors'
import { agentTaskNeedsRegistration } from '../gateway/openai-agent-task-policy'
import { registerAgentIdentityTask } from './openai-agent-task-registration'
import { claimAgentTaskRegistration,agentTaskRegistrationGuard,releaseAgentTaskRegistration } from './account-agent-task-lock'

async function read(env:Env,id:string) {
  const row=await env.DB.prepare(`SELECT a.control_version,a.credential_ref,a.platform,a.credential_kind,a.ui_config_json,
    s.key_version,s.nonce_b64,s.ciphertext_b64 FROM accounts a JOIN account_secrets s
    ON s.id=a.credential_ref AND s.account_id=a.id WHERE a.id=?`).bind(id)
    .first<{control_version:number;credential_ref:string;platform:string;credential_kind:string;ui_config_json:string;key_version:number;nonce_b64:string;ciphertext_b64:string}>()
  if(!row) throw new GatewayError(404,'account_not_found','Account not found')
  if(!env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503,'credentials_not_configured','Credential storage is not configured')
  const credentials=await decryptCredentialPayload(row.nonce_b64,row.ciphertext_b64,env.CREDENTIALS_MASTER_KEY,credentialAad(env.ENVIRONMENT,id,row.credential_ref,row.key_version))
  const values=credentials as unknown as Record<string,unknown>
  if(row.platform!=='openai' || row.credential_kind!=='oauth' || String(values.auth_mode).trim().toLowerCase()!=='agentidentity') {
    throw new GatewayError(409,'agent_identity_changed','Agent Identity credentials are no longer available')
  }
  if(typeof values.agent_runtime_id!=='string' || typeof values.agent_private_key!=='string') throw new GatewayError(409,'invalid_agent_identity','Agent Identity credentials are incomplete')
  return {row,credentials,values}
}
/** Fresh reads inside the account-wide lease prevent independent request
 * snapshots from sequentially registering replacements for the same failed task. */
export async function ensureAccountAgentTask(env:Env,id:string,expectedTaskId=''):Promise<Record<string,unknown>> {
  const deadline=Date.now()+35000
  let owner:string|null=null
  while(!owner) {
    const current=await read(env,id)
    const task=typeof current.values.task_id==='string'?current.values.task_id:''
    if(!agentTaskNeedsRegistration(task,expectedTaskId)) return current.credentials
    owner=await claimAgentTaskRegistration(env,id)
    if(!owner) {
      if(Date.now()>=deadline) throw new GatewayError(503,'agent_task_registration_busy','Agent task registration is still in progress')
      await new Promise(resolve=>setTimeout(resolve,100))
    }
  }
  try {
    const current=await read(env,id)
    const task=typeof current.values.task_id==='string'?current.values.task_id:''
    if(!agentTaskNeedsRegistration(task,expectedTaskId)) return current.credentials
    const ui=JSON.parse(current.row.ui_config_json)
    const proxy=ui.proxy_id==null || String(ui.proxy_id)==='0'?null:String(ui.proxy_id)
    const newTask=await registerAgentIdentityTask(env,{agent_runtime_id:current.values.agent_runtime_id as string,
      agent_private_key:current.values.agent_private_key as string,task_id:task},proxy)
    const next={...current.credentials,task_id:newTask},version=current.row.key_version+1
    if(!Number.isSafeInteger(version)) throw new GatewayError(409,'credential_version_exhausted','Credential version limit reached')
    const encrypted=await encryptCredential(next,env.CREDENTIALS_MASTER_KEY!,credentialAad(env.ENVIRONMENT,id,current.row.credential_ref,version))
    try {
      await env.DB.batch([
        agentTaskRegistrationGuard(env,id,owner),
        env.DB.prepare(`UPDATE accounts SET config_version=CASE WHEN control_version=? AND credential_ref=? THEN config_version+1 ELSE 0 END,
          ui_config_json=json_set(ui_config_json,'$.credentials.task_id',?),
          updated_at_ms=? WHERE id=?`).bind(current.row.control_version,current.row.credential_ref,newTask,Date.now(),id),
        env.DB.prepare(`UPDATE account_secrets SET key_version=CASE WHEN key_version=? THEN ? ELSE 0 END,
          nonce_b64=?,ciphertext_b64=?,updated_at_ms=? WHERE id=? AND account_id=?`)
          .bind(current.row.key_version,version,encrypted.nonce_b64,encrypted.ciphertext_b64,Date.now(),current.row.credential_ref,id),
      ])
    } catch {throw new GatewayError(409,'agent_task_persistence_conflict','Account or registration changed; retry with current credentials')}
    return next
  } finally {
    try {await releaseAgentTaskRegistration(env,id,owner)} catch { /* Expiry permits recovery; do not invalidate a committed result. */ }
  }
}
