/** Original ensureAgentIdentityTaskForAccount: a changed task means another
 * request has already recovered it. Re-evaluate after acquiring the shared lock. */
export function agentTaskNeedsRegistration(currentTaskId:string|undefined,expectedTaskId=''):boolean {
  const current=currentTaskId?.trim()??''
  return !current || (!!expectedTaskId && current===expectedTaskId)
}
export function isAgentIdentityTaskInvalidResponse(status:number,body:string):boolean {
  if(status!==401) return false
  const lower=body.toLowerCase(),compact=lower.replace(/[ \t\r\n]/g,'')
  if(['"code":"invalid_task_id"','"code":"task_not_found"','"code":"task_expired"','"error":"invalid_task_id"']
    .some(marker=>compact.includes(marker))) return true
  return ['invalid task_id','invalid task id','task_id is invalid','task id is invalid','task not found','task expired','unknown task_id','unknown task id']
    .some(marker=>lower.includes(marker))
}
/** Apply before an Agent Identity upstream body reaches logs or user errors. */
export function redactAgentIdentityBody(body:string,credentials:Record<string,unknown>):string {
  let result=body
  for(const key of ['agent_private_key','agent_runtime_id','task_id','access_token','refresh_token','id_token','api_key','session_key','cookie']) {
    const value=typeof credentials[key]==='string'?(credentials[key] as string).trim():''
    if(value) result=result.split(value).join('[redacted]')
  }
  return result.replace(/(AgentAssertion )[^ \t\r\n"',}]*/g,'$1[redacted]')
}
