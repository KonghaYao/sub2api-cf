import nacl from 'tweetnacl'
import { blake2b } from 'blakejs'
import { GatewayError } from './errors'

/** Go nacl/box.OpenAnonymous: ephemeral public key followed by authenticated
 * XSalsa20-Poly1305 ciphertext, with a BLAKE2b-24 public-key-derived nonce. */
export async function decryptAgentTaskId(privateKey:string,encoded:string):Promise<string> {
  let seed:Uint8Array|undefined,curvePrivate:Uint8Array|undefined
  try {
    const parse=(value:string)=>{
      const text=value.trim()
      if(!text || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(text)) throw new Error()
      return Uint8Array.from(atob(text),c=>c.charCodeAt(0))
    }
    const ciphertext=parse(encoded)
    if(ciphertext.length<48 || ciphertext.length>65536) throw new Error()
    const key=await crypto.subtle.importKey('pkcs8',parse(privateKey),{name:'Ed25519'},true,['sign'])
    const jwk=await crypto.subtle.exportKey('jwk',key)
    if(!jwk.d) throw new Error()
    seed=Uint8Array.from(atob(jwk.d.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-512',new Uint8Array(seed)))
    curvePrivate=digest.slice(0,32);digest.fill(0)
    curvePrivate[0]&=248;curvePrivate[31]&=127;curvePrivate[31]|=64
    const publicKey=nacl.scalarMult.base(curvePrivate)
    const ephemeral=ciphertext.subarray(0,32)
    const nonceInput=new Uint8Array(64);nonceInput.set(ephemeral);nonceInput.set(publicKey,32)
    const nonce=blake2b(nonceInput,undefined,24)
    const plaintext=nacl.box.open(ciphertext.subarray(32),nonce,ephemeral,curvePrivate)
    if(!plaintext) throw new Error()
    const taskId=new TextDecoder().decode(plaintext).trim();plaintext.fill(0)
    if(!taskId) throw new Error()
    return taskId
  } catch {
    throw new GatewayError(502,'AGENT_TASK_DECRYPTION_FAILED','Could not decrypt agent task id')
  } finally {seed?.fill(0);curvePrivate?.fill(0)}
}
