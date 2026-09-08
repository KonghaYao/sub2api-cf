import { expect,it } from 'vitest'
import { buildAgentAssertion,signAgentTaskRegistration } from '../../src/gateway/openai-agent-assertion'
const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0))
async function keys() {
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair
  const encoded=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey))))
  return {pair,credentials:{agent_runtime_id:' runtime-test ',task_id:' task-test ',agent_private_key:encoded}}
}
it('matches the original UTC envelope and verifies the Ed25519 signature against the public key',async()=>{
  const {pair,credentials}=await keys()
  const assertion=await buildAgentAssertion(credentials,Date.parse('2026-07-14T08:09:10.987+08:00'))
  expect(assertion).toMatch(/^AgentAssertion [A-Za-z0-9_-]+$/)
  const encoded=assertion.slice('AgentAssertion '.length).replace(/-/g,'+').replace(/_/g,'/')
  const envelope=JSON.parse(new TextDecoder().decode(decode(encoded)))
  expect(envelope).toEqual({agent_runtime_id:'runtime-test',task_id:'task-test',timestamp:'2026-07-14T00:09:10Z',signature:expect.any(String)})
  expect(await crypto.subtle.verify('Ed25519',pair.publicKey,decode(envelope.signature),new TextEncoder().encode('runtime-test:task-test:2026-07-14T00:09:10Z'))).toBe(true)
  expect(await crypto.subtle.verify('Ed25519',pair.publicKey,decode(envelope.signature),new TextEncoder().encode('runtime-test:other-task:2026-07-14T00:09:10Z'))).toBe(false)
})
it('signs registration without requiring a task and binds the signature to the runtime',async()=>{
  const {pair,credentials}=await keys()
  const signed=await signAgentTaskRegistration({...credentials,task_id:undefined},Date.parse('2026-07-14T00:09:10Z'))
  expect(signed.timestamp).toBe('2026-07-14T00:09:10Z')
  expect(await crypto.subtle.verify('Ed25519',pair.publicKey,decode(signed.signature),new TextEncoder().encode(`runtime-test:${signed.timestamp}`))).toBe(true)
})
it('rejects missing identifiers and invalid keys without exposing supplied material',async()=>{
  const {credentials}=await keys()
  await expect(buildAgentAssertion({...credentials,task_id:''})).rejects.toThrow('runtime or task id is missing')
  await expect(signAgentTaskRegistration({...credentials,agent_runtime_id:''})).rejects.toThrow('runtime id is missing')
  await expect(buildAgentAssertion({...credentials,agent_private_key:'SECRET_INVALID_KEY'})).rejects.toThrow('base64 PKCS#8 Ed25519')
  const rsa=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']) as CryptoKeyPair
  const wrong=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8',rsa.privateKey))))
  await expect(buildAgentAssertion({...credentials,agent_private_key:wrong})).rejects.toThrow('base64 PKCS#8 Ed25519')
  await expect(buildAgentAssertion(credentials,NaN)).rejects.toThrow('signing time')
})

// Generated with Go crypto/ed25519, encoding/json and a public test seed 00..1f.
it('matches a deterministic Go reference envelope and registration signature exactly',async()=>{
  const fixture={"assertion": "AgentAssertion eyJhZ2VudF9ydW50aW1lX2lkIjoicnVudGltZS10ZXN0Iiwic2lnbmF0dXJlIjoiZGd5U0xST201YU83QXFQQlYxR2FRcHprTDBDeHAzTDFNenBUa0pjbjRTaTBTZXg4dmN2TUJGdWNnZ0p1UzhrSFI2SkI4NXoxUFZNUC9jQW8yMkRqQ1E9PSIsInRhc2tfaWQiOiJ0YXNrLXRlc3QiLCJ0aW1lc3RhbXAiOiIyMDI2LTA3LTE0VDAwOjA5OjEwWiJ9", "private_key": "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f", "registration_signature": "9Pm4LY2md+H82mTC/DXpRK2voERVc+KxQNWHCUzoSNIhjt9YBp3T9k4YZ2qkhufCMC03Bui+yOdP6pAMb3kKAA=="}
  const credentials={agent_runtime_id:'runtime-test',task_id:'task-test',agent_private_key:fixture.private_key}
  const now=Date.parse('2026-07-14T00:09:10Z')
  expect(await buildAgentAssertion(credentials,now)).toBe(fixture.assertion)
  expect((await signAgentTaskRegistration(credentials,now)).signature).toBe(fixture.registration_signature)
})
