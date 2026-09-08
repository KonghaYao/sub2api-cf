import type { Env } from '../env'
import type { AccountCredential,UpstreamCredential } from '../gateway/types'
import { decryptCredentialPayload } from '../gateway/crypto'
import { credentialAad } from '../gateway/repository'
import { GatewayError } from '../gateway/errors'
import { buildAgentAssertion } from '../gateway/openai-agent-assertion'
import { ensureAccountAgentTask } from './account-agent-task'

export async function resolveAccountRequestAuthentication(env:Env,account:Pick<AccountCredential,'account_id'|'platform'|'credential_kind'|'nonce_b64'|'ciphertext_b64'|'secret_id'|'key_version'>,expectedTaskId=''):Promise<{
  credential:UpstreamCredential; authorization?:string
}> {
  if(!env.CREDENTIALS_MASTER_KEY) throw new GatewayError(503,'credential_unavailable','Credential storage is not configured')
  const payload=await decryptCredentialPayload(account.nonce_b64,account.ciphertext_b64,env.CREDENTIALS_MASTER_KEY,
    credentialAad(env.ENVIRONMENT,account.account_id,account.secret_id,account.key_version))
  if(account.platform==='openai' && account.credential_kind==='oauth' && String(payload.auth_mode).trim().toLowerCase()==='agentidentity') {
    const current=await ensureAccountAgentTask(env,account.account_id,expectedTaskId)
    const authorization=await buildAgentAssertion({agent_runtime_id:current.agent_runtime_id as string,
      agent_private_key:current.agent_private_key as string,task_id:current.task_id as string})
    // Provider planners consume a generic auth string. This is request-local;
    // no API-key alias is added to the persisted Agent Identity payload.
    return {credential:{...current,api_key:authorization},authorization}
  }
  if(typeof payload.api_key!=='string' || !payload.api_key) throw new GatewayError(503,'credential_unavailable','Upstream account credential is unavailable')
  return {credential:payload as unknown as UpstreamCredential}
}
