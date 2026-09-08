import { expect,it,vi } from 'vitest'
import { inspectAgentTaskResponse } from '../../src/gateway/agent-task-response'
it('detects invalid tasks before redaction and returns a sanitized error body',async()=>{
  const response=new Response('{"code":"task_expired","message":"secret-task AgentAssertion abcdef"}',{status:401,headers:{'content-length':'999'}})
  const result=await inspectAgentTaskResponse(response,{task_id:'secret-task'})
  expect(result.taskInvalid).toBe(true);expect(result.response.status).toBe(401)
  expect(await result.response.text()).toBe('{"code":"task_expired","message":"[redacted] AgentAssertion [redacted]"}')
  expect(result.response.headers.has('content-length')).toBe(false)
})
it('does not consume successful streams or recover unrelated errors',async()=>{
  const success=new Response('stream',{status:200})
  expect((await inspectAgentTaskResponse(success,{})).response).toBe(success)
  expect(success.bodyUsed).toBe(false)
  expect((await inspectAgentTaskResponse(new Response('invalid task id',{status:403}),{})).taskInvalid).toBe(false)
})
it('rejects oversized bodies and stalled error streams',async()=>{
  await expect(inspectAgentTaskResponse(new Response('a'.repeat(65537),{status:401}),{})).rejects.toMatchObject({code:'agent_response_too_large'})
  vi.useFakeTimers()
  try {
    const cancel=vi.fn()
    const response=new Response(new ReadableStream({cancel}),{status:401})
    const operation=expect(inspectAgentTaskResponse(response,{})).rejects.toMatchObject({code:'agent_response_timeout'})
    await vi.advanceTimersByTimeAsync(10001);await operation
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally {vi.useRealTimers()}
})
