import { afterEach,expect,it,vi } from 'vitest'
import type { Env } from '../../src/env'
import * as proxyTransport from '../../src/gateway/proxy-fetch'
import { requestAgentTaskRegistration } from '../../src/control/openai-agent-task-registration'
const credentials={agent_runtime_id:' runtime-test ',agent_private_key:'MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f'}
const env={} as Env
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
it('uses the original registration endpoint, selected proxy and signed JSON without sending the private key',async()=>{
  const direct=vi.fn();vi.stubGlobal('fetch',direct)
  const fetcher=vi.spyOn(proxyTransport,'fetchAccountProxy').mockResolvedValue(Response.json({task_id:' task-one '}))
  expect(await requestAgentTaskRegistration(env,credentials,'opaque-proxy')).toEqual({taskId:'task-one'})
  expect(direct).not.toHaveBeenCalled()
  const [bindings,proxy,url,init]=fetcher.mock.calls[0]!
  expect(bindings).toBe(env);expect(proxy).toBe('opaque-proxy')
  expect(String(url)).toBe('https://auth.openai.com/api/accounts/v1/agent/runtime-test/task/register')
  expect(init.method).toBe('POST');expect(init.redirect).toBe('manual')
  expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  const body=JSON.parse(String(init.body));expect(Object.keys(body).sort()).toEqual(['signature','timestamp'])
  expect(body.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  expect(String(init.body)).not.toContain(credentials.agent_private_key)
})
it.each([
  [{task_id:'first',taskId:'second',encrypted_task_id:'cipher'},{taskId:'first'}],
  [{task_id:' ',taskId:' camel '},{taskId:'camel'}],
  [{encrypted_task_id:' snake ',encryptedTaskId:'camel'},{encryptedTaskId:'snake'}],
  [{task_id:null,encryptedTaskId:' cipher '},{encryptedTaskId:'cipher'}],
])('preserves original alias precedence for %j',async(body,result)=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(body)))
  expect(await requestAgentTaskRegistration(env,credentials,null)).toEqual(result)
})
it.each([{},[],null,{task_id:3},{encrypted_task_id:false}])('rejects malformed task response %j',async body=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(body)))
  await expect(requestAgentTaskRegistration(env,credentials,null)).rejects.toMatchObject({status:502,code:'AGENT_TASK_REGISTRATION_FAILED'})
})
it('does not disclose upstream error material or follow redirects',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response('PRIVATE_TASK_AND_SIGNATURE',{status:302,headers:{location:'https://outside.test'}}))
  vi.stubGlobal('fetch',fetcher)
  await expect(requestAgentTaskRegistration(env,credentials,null)).rejects.toThrow('returned status 302')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('enforces the original 64 KiB response bound',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({task_id:'a'.repeat(65536)})))
  await expect(requestAgentTaskRegistration(env,credentials,null)).rejects.toThrow('registration request failed')
})
it('bounds a transport that ignores abort and sanitizes its timeout',async()=>{
  vi.useFakeTimers()
  try {
    let reached!:()=>void
    const fetching=new Promise<void>(resolve=>{reached=resolve})
    vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>{reached();return new Promise(()=>{})}))
    const operation=requestAgentTaskRegistration(env,credentials,null)
    const assertion=expect(operation).rejects.toMatchObject({status:504,code:'AGENT_TASK_REGISTRATION_TIMEOUT',message:'Agent task registration timed out'})
    await fetching
    await vi.advanceTimersByTimeAsync(30001)
    await assertion
  } finally {vi.useRealTimers()}
})
