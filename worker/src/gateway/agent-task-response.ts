import { GatewayError } from './errors'
import { isAgentIdentityTaskInvalidResponse,redactAgentIdentityBody } from './openai-agent-task-policy'

/** Consume an unsuccessful Agent response once, before logs, observations or
 * user-facing error handling. Keep a bounded, redacted replayable response. */
export async function inspectAgentTaskResponse(response:Response,credentials:Record<string,unknown>):Promise<{response:Response;taskInvalid:boolean}> {
  if(response.ok) return {response,taskInvalid:false}
  const reader=response.body?.getReader()
  let timer:ReturnType<typeof setTimeout>|undefined
  const operation=(async()=>{
    const decoder=new TextDecoder();let text='',size=0
    while(reader) {
      const part=await reader.read();if(part.done) break
      size+=part.value.byteLength
      if(size>65536) throw new GatewayError(502,'agent_response_too_large','Agent Identity upstream error response is too large')
      text+=decoder.decode(part.value,{stream:true})
    }
    text+=decoder.decode()
    const taskInvalid=isAgentIdentityTaskInvalidResponse(response.status,text)
    const headers=new Headers(response.headers)
    headers.delete('content-length');headers.delete('content-encoding')
    return {taskInvalid,response:new Response(redactAgentIdentityBody(text,credentials),{status:response.status,statusText:response.statusText,headers})}
  })()
  try {
    return await Promise.race([operation,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new GatewayError(504,'agent_response_timeout','Agent Identity upstream error response timed out')),10000)
    })])
  } catch(error) {
    if(error instanceof GatewayError) throw error
    throw new GatewayError(502,'agent_response_unavailable','Could not read Agent Identity upstream error response')
  } finally {
    clearTimeout(timer)
    void reader?.cancel().catch(()=>{})
  }
}
