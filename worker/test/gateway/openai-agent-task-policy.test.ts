import { expect,it } from 'vitest'
import { agentTaskNeedsRegistration,isAgentIdentityTaskInvalidResponse,redactAgentIdentityBody } from '../../src/gateway/openai-agent-task-policy'
it.each([
  [undefined,'',true],[' ','old',true],['current','',false],['old','old',true],[' new ','old',false],[' old ','old',true],
])('checks the latest task %j against the failed task %j', (current,expected,required)=>{
  expect(agentTaskNeedsRegistration(current as string|undefined,expected as string)).toBe(required)
})
it.each(['{"code": "INVALID_TASK_ID"}','{"error":"invalid_task_id"}','{"code":"task_not_found"}','{"code":"task_expired"}',
  'Invalid task_id','TASK ID IS INVALID','task not found','Task expired','unknown task_id','unknown task id'])('recognizes only a 401 task invalidation: %s',body=>{
  expect(isAgentIdentityTaskInvalidResponse(401,body)).toBe(true)
  for(const status of [200,400,403,429,500]) expect(isAgentIdentityTaskInvalidResponse(status,body)).toBe(false)
})
it.each(['invalid API key','token expired','{"code":"invalid_task_id_extra"}','{"code":"account_deactivated"}'])('does not register a task for unrelated auth failure %s',body=>{
  expect(isAgentIdentityTaskInvalidResponse(401,body)).toBe(false)
})
it('redacts credential values and multiple assertion envelopes while preserving error context',()=>{
  const body='{"error":"task expired runtime-secret task-secret private-secret","auth":"AgentAssertion first-assertion","other":"AgentAssertion second-assertion"}'
  expect(redactAgentIdentityBody(body,{agent_runtime_id:' runtime-secret ',task_id:'task-secret',agent_private_key:'private-secret'}))
    .toBe('{"error":"task expired [redacted] [redacted] [redacted]","auth":"AgentAssertion [redacted]","other":"AgentAssertion [redacted]"}')
})
