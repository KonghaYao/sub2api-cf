import { GatewayError } from './errors'

export interface AgentIdentitySigningCredentials {
  agent_runtime_id: string
  agent_private_key: string
  task_id?: string
}
const encoder=new TextEncoder()
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes))
function invalid(message:string):never {
  throw new GatewayError(400,'invalid_agent_identity',message)
}
export async function importAgentIdentitySigningKey(encoded:string):Promise<CryptoKey> {
  try {
    const value=encoded.trim()
    if(!value || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(value)) throw new Error()
    return await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(value),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign'])
  } catch {return invalid('Agent identity private key must be base64 PKCS#8 Ed25519')}
}
function timestamp(now:number):string {
  if(!Number.isFinite(now)) return invalid('Invalid agent identity signing time')
  try {return new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z')}
  catch {return invalid('Invalid agent identity signing time')}
}
async function signature(credentials:AgentIdentitySigningCredentials,payload:string):Promise<string> {
  const key=await importAgentIdentitySigningKey(credentials.agent_private_key)
  try {return base64(new Uint8Array(await crypto.subtle.sign('Ed25519',key,encoder.encode(payload))))}
  catch {return invalid('Failed to sign agent identity request')}
}
/** Original openai_agent_identity.go signs UTF-8 runtime:task:UTC-seconds,
 * with a standard-base64 signature inside a base64url JSON envelope. */
export async function buildAgentAssertion(credentials:AgentIdentitySigningCredentials,now=Date.now()):Promise<string> {
  const runtime=credentials.agent_runtime_id.trim(),task=credentials.task_id?.trim()
  if(!runtime || !task) return invalid('Agent identity runtime or task id is missing')
  const time=timestamp(now)
  const signed=await signature(credentials,`${runtime}:${task}:${time}`)
  // Go's JSON map encoder sorts keys; match that envelope order as well.
  const envelope={agent_runtime_id:runtime,signature:signed,task_id:task,timestamp:time}
  const encoded=base64(encoder.encode(JSON.stringify(envelope))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  return `AgentAssertion ${encoded}`
}
export async function signAgentTaskRegistration(credentials:AgentIdentitySigningCredentials,now=Date.now()):Promise<{timestamp:string;signature:string}> {
  const runtime=credentials.agent_runtime_id.trim()
  if(!runtime) return invalid('Agent identity runtime id is missing')
  const time=timestamp(now)
  return {timestamp:time,signature:await signature(credentials,`${runtime}:${time}`)}
}
