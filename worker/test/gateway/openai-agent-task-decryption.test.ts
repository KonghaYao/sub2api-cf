import { expect,it,vi,afterEach } from 'vitest'
import { decryptAgentTaskId } from '../../src/gateway/openai-agent-task-decryption'
import { registerAgentIdentityTask } from '../../src/control/openai-agent-task-registration'
import type { Env } from '../../src/env'
// Go nacl/box.SealAnonymous fixture; public deterministic test seed 00..1f.
const fixture={"ciphertext": "hpplap3QclxBVicKdVDbDljZFLiRCTa3UAZSKfqUMCTQUZXdxpSI3kLlogeM6cHIDGP9vw0t8IBkVPnXPQbM3OtT", "private_key": "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"}

afterEach(()=>vi.unstubAllGlobals())
it('decrypts the original Go sealed-box format and trims the returned task',async()=>{
  expect(await decryptAgentTaskId(fixture.private_key,fixture.ciphertext)).toBe('task-go-sealed')
})
it('registers an encrypted task and returns only its authenticated plaintext',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({encryptedTaskId:fixture.ciphertext})))
  expect(await registerAgentIdentityTask({} as Env,{agent_runtime_id:'runtime-test',agent_private_key:fixture.private_key},null)).toBe('task-go-sealed')
})
it.each([0,31,32,48])('rejects corruption at ciphertext byte %i',async index=>{
  const bytes=Uint8Array.from(atob(fixture.ciphertext),c=>c.charCodeAt(0));bytes[index]^=1
  await expect(decryptAgentTaskId(fixture.private_key,btoa(String.fromCharCode(...bytes)))).rejects.toMatchObject({code:'AGENT_TASK_DECRYPTION_FAILED'})
})
it('rejects a different Ed25519 key and malformed ciphertext without disclosing material',async()=>{
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair
  const key=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey))))
  await expect(decryptAgentTaskId(key,fixture.ciphertext)).rejects.toThrow('Could not decrypt agent task id')
  for(const value of ['','PRIVATE_CIPHERTEXT',btoa('short')]) {
    await expect(decryptAgentTaskId(fixture.private_key,value)).rejects.toThrow('Could not decrypt agent task id')
  }
})
