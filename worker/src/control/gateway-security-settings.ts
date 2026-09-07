import { GatewayError } from '../gateway/errors'
export const securityDefaults={risk_control_enabled:false,cyber_session_block_enabled:false,cyber_session_block_ttl_seconds:3600,api_key_acl_trust_forwarded_ip:false,forwarded_client_ip_headers:['x-forwarded-for','x-real-ip']}
export function parseSecuritySettings(value:unknown):Partial<typeof securityDefaults>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new GatewayError(400,'invalid_gateway_security','Invalid gateway security configuration')
 const out:Record<string,unknown>={}
 for(const [key,item]of Object.entries(value)){
  if(!Object.hasOwn(securityDefaults,key))throw new GatewayError(400,'invalid_gateway_security','Unknown gateway security setting')
  if(key==='cyber_session_block_ttl_seconds'){
   if(!Number.isSafeInteger(item)||Number(item)<60||Number(item)>2592000)throw new GatewayError(400,'invalid_gateway_security','Session block TTL must be 60–2592000 seconds')
  }else if(key==='forwarded_client_ip_headers'){
   if(!Array.isArray(item)||item.length>16||item.some(header=>typeof header!=='string'||!['x-forwarded-for','x-real-ip','true-client-ip','cf-connecting-ip','fastly-client-ip','x-client-ip','x-cluster-client-ip','forwarded'].includes(header.toLowerCase())))throw new GatewayError(400,'invalid_gateway_security','Invalid forwarded client IP header list')
   out[key]=[...new Set(item.map(header=>header.toLowerCase()))];continue
  }else if(typeof item!=='boolean')throw new GatewayError(400,'invalid_gateway_security','Security switches must be boolean')
  out[key]=item
 }
 return out
}
export function normalizeSecuritySettings(value:unknown){return {...securityDefaults,...parseSecuritySettings(value??{})}}
