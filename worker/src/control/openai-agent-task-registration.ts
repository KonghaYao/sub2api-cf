import { decryptAgentTaskId } from '../gateway/openai-agent-task-decryption'
import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import { signAgentTaskRegistration,type AgentIdentitySigningCredentials } from '../gateway/openai-agent-assertion'
import { openAIOAuthHttp } from './openai-oauth-http'

export type AgentTaskRegistrationResult = {taskId:string} | {encryptedTaskId:string}
function invalid(message='Agent task registration response is invalid'):GatewayError {
  return new GatewayError(502,'AGENT_TASK_REGISTRATION_FAILED',message)
}
/** Fetches the original registration response. Encrypted results must be decrypted
 * before a caller can persist a task or build an AgentAssertion. */
export async function requestAgentTaskRegistration(env:Env,credentials:AgentIdentitySigningCredentials,proxyId:string|null):Promise<AgentTaskRegistrationResult> {
  const signed=await signAgentTaskRegistration(credentials)
  const runtime=credentials.agent_runtime_id.trim()
  // A runtime identifier is a single path component, never a caller-supplied URL.
  const url=`https://auth.openai.com/api/accounts/v1/agent/${encodeURIComponent(runtime)}/task/register`
  let response:{status:number;text:string}
  try {
    response=await openAIOAuthHttp(env,url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(signed)},proxyId,30000,64*1024)
  } catch(error) {
    if(error instanceof GatewayError && error.status===504) throw new GatewayError(504,'AGENT_TASK_REGISTRATION_TIMEOUT','Agent task registration timed out')
    throw invalid('Agent task registration request failed')
  }
  if(response.status<200 || response.status>=300) throw invalid(`Agent task registration returned status ${response.status}`)
  let result:Record<string,unknown>
  try {
    const value:unknown=JSON.parse(response.text)
    if(value===null || typeof value!=='object' || Array.isArray(value)) throw new Error()
    result=value as Record<string,unknown>
    for(const key of ['task_id','taskId','encrypted_task_id','encryptedTaskId']) {
      if(result[key]!=null && typeof result[key]!=='string') throw new Error()
    }
  } catch {throw invalid()}
  const text=(key:string)=>typeof result[key]==='string'?(result[key] as string).trim():''
  const taskId=text('task_id')||text('taskId')
  if(taskId) return {taskId}
  const encryptedTaskId=text('encrypted_task_id')||text('encryptedTaskId')
  if(encryptedTaskId) return {encryptedTaskId}
  throw invalid('Agent task registration response omitted task id')
}

/** A usable task is returned only after authenticated decryption succeeds. */
export async function registerAgentIdentityTask(env:Env,credentials:AgentIdentitySigningCredentials,proxyId:string|null):Promise<string> {
  const result=await requestAgentTaskRegistration(env,credentials,proxyId)
  return 'taskId' in result ? result.taskId : decryptAgentTaskId(credentials.agent_private_key,result.encryptedTaskId)
}
