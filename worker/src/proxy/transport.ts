/** The proxy handshake is plaintext; target HTTP traffic starts only after verified TLS. */
export interface ProxyConnection {
  protocol: 'http' | 'socks5'
  host: string
  port: number
  username?: string | null
  password?: string | null
}
export interface ProxySocket {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  opened?: Promise<unknown>
  closed?: Promise<unknown>
  close(): Promise<void>
  startTls(options: { expectedServerHostname: string }): ProxySocket
}
export type ProxyConnect = (address: { hostname: string; port: number }, options: { secureTransport: 'starttls'; allowHalfOpen: boolean; highWaterMark: number }) => ProxySocket
export class ProxyTransportError extends Error {
  constructor(readonly code: string) { super(code); this.name='ProxyTransportError' }
}
const encoder = new TextEncoder()
const MAX_HEADER_BYTES = 65536
const MAX_BODY_BYTES = 512 * 1024 * 1024

class WireReader {
  private buffered: Uint8Array = new Uint8Array(0)
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  constructor(stream: ReadableStream<Uint8Array>, private readonly aborted: Promise<never>) { this.reader=stream.getReader() }
  private async fill(): Promise<boolean> {
    const chunk=await Promise.race([this.reader.read(),this.aborted])
    if(chunk.done)return false
    if(this.buffered.byteLength+chunk.value.byteLength>1048576)throw new ProxyTransportError('proxy_receive_buffer_limit')
    if(this.buffered.length===0)this.buffered=chunk.value
    else { const merged=new Uint8Array(this.buffered.length+chunk.value.length);merged.set(this.buffered);merged.set(chunk.value,this.buffered.length);this.buffered=merged }
    return true
  }
  async exact(length:number):Promise<Uint8Array> {
    if(!Number.isSafeInteger(length)||length<0||length>MAX_HEADER_BYTES)throw new ProxyTransportError('proxy_invalid_frame_length')
    while(this.buffered.length<length)if(!await this.fill())throw new ProxyTransportError('proxy_unexpected_eof')
    const value=this.buffered.slice(0,length);this.buffered=this.buffered.subarray(length);return value
  }
  async some(maximum=65536):Promise<Uint8Array|null> {
    while(this.buffered.length===0)if(!await this.fill())return null
    const size=Math.min(maximum,this.buffered.length),value=this.buffered.slice(0,size);this.buffered=this.buffered.subarray(size);return value
  }
  async line(limit=8192):Promise<string> {
    while(true){
      for(let index=0;index+1<this.buffered.length;index++)if(this.buffered[index]===13&&this.buffered[index+1]===10){
        if(index>limit)throw new ProxyTransportError('proxy_header_limit')
        const value=new TextDecoder().decode(this.buffered.subarray(0,index));this.buffered=this.buffered.subarray(index+2);return value
      }
      if(this.buffered.length>limit)throw new ProxyTransportError('proxy_header_limit')
      if(!await this.fill())throw new ProxyTransportError('proxy_unexpected_eof')
    }
  }
  releaseForTls():void {
    if(this.buffered.length!==0)throw new ProxyTransportError('proxy_unexpected_handshake_data')
    this.reader.releaseLock()
  }
  async cancel():Promise<void> { try {await this.reader.cancel()} catch { /* Closing a failed socket is best effort. */ } }
}

async function readHeaders(wire:WireReader):Promise<{status:number;headers:Headers}> {
  const statusLine=await wire.line(),match=/^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(statusLine)
  if(!match)throw new ProxyTransportError('proxy_invalid_http_status')
  const headers=new Headers();let size=statusLine.length+2,count=0
  while(true){
    const line=await wire.line();size+=line.length+2
    if(size>MAX_HEADER_BYTES||++count>200)throw new ProxyTransportError('proxy_header_limit')
    if(line==='')return {status:Number(match[1]),headers}
    const colon=line.indexOf(':')
    if(colon<=0||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0,colon))||/[\x00-\x08\x0a-\x1f\x7f]/.test(line.slice(colon+1)))throw new ProxyTransportError('proxy_invalid_http_header')
    headers.append(line.slice(0,colon),line.slice(colon+1).trim())
  }
}

async function handshake(proxy:ProxyConnection,target:URL,wire:WireReader,writer:Pick<WritableStreamDefaultWriter<Uint8Array>,'write'>):Promise<void> {
  if(proxy.protocol==='http'){
    let auth=''
    if(proxy.username){const bytes=encoder.encode(`${proxy.username}:${proxy.password??''}`);auth=`Proxy-Authorization: Basic ${btoa(String.fromCharCode(...bytes))}\r\n`}
    await writer.write(encoder.encode(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${auth}\r\n`))
    const reply=await readHeaders(wire)
    if(reply.status!==200)throw new ProxyTransportError(reply.status===407?'proxy_authentication_failed':'proxy_connect_rejected')
    return
  }
  const username=encoder.encode(proxy.username??''),password=encoder.encode(proxy.password??'')
  if(username.length>255||password.length>255)throw new ProxyTransportError('proxy_credentials_too_long')
  await writer.write(new Uint8Array(username.length?[5,1,2]:[5,1,0]))
  const method=await wire.exact(2)
  if(method[0]!==5 || method[1]!== (username.length?2:0))throw new ProxyTransportError('proxy_authentication_failed')
  if(username.length){
    const auth=new Uint8Array(3+username.length+password.length);auth[0]=1;auth[1]=username.length;auth.set(username,2);auth[2+username.length]=password.length;auth.set(password,3+username.length)
    await writer.write(auth);const accepted=await wire.exact(2)
    if(accepted[0]!==1||accepted[1]!==0)throw new ProxyTransportError('proxy_authentication_failed')
  }
  const hostname=encoder.encode(target.hostname)
  if(hostname.length>255)throw new ProxyTransportError('proxy_target_hostname_too_long')
  const connect=new Uint8Array(7+hostname.length);connect.set([5,1,0,3,hostname.length]);connect.set(hostname,5);connect[5+hostname.length]=1;connect[6+hostname.length]=187
  await writer.write(connect)
  const response=await wire.exact(4)
  if(response[0]!==5||response[1]!==0||response[2]!==0)throw new ProxyTransportError('proxy_connect_rejected')
  const length=response[3]===1?4:response[3]===4?16:response[3]===3?(await wire.exact(1))[0]!:0
  if(length===0)throw new ProxyTransportError('proxy_invalid_socks_response')
  await wire.exact(length+2)
}

/** HTTP CONNECT or SOCKS5 → target TLS → bounded HTTP/1.1, with streaming and explicit socket cancellation. */
export async function proxyFetch(proxy:ProxyConnection,input:string|URL,init:RequestInit={},connector?:ProxyConnect):Promise<Response> {
  if(proxy.protocol!=='http'&&proxy.protocol!=='socks5')throw new ProxyTransportError('proxy_protocol_unsupported')
  if(!proxy.host||!Number.isInteger(proxy.port)||proxy.port<1||proxy.port>65535||(proxy.username?.length??0)>255||(proxy.password?.length??0)>255)throw new ProxyTransportError('proxy_configuration_invalid')
  const target=new URL(input)
  if(target.protocol!=='https:'||(target.port!==''&&target.port!=='443')||target.username||target.password||target.hash)throw new ProxyTransportError('proxy_target_unsupported')
  if(init.signal?.aborted)throw new ProxyTransportError('proxy_request_cancelled')
  const connect=connector??(await import('cloudflare:sockets')).connect as unknown as ProxyConnect
  let socket=connect({hostname:proxy.host,port:proxy.port},{secureTransport:'starttls',allowHalfOpen:false,highWaterMark:65536})
  void socket.closed?.catch(()=>undefined)
  let finished=false,rejectAbort:(error:Error)=>void=()=>undefined
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject});void aborted.catch(()=>undefined)
  let wire=new WireReader(socket.readable,aborted)
  let writer=socket.writable.getWriter()
  let idle:ReturnType<typeof setTimeout>|undefined
  let headersTimer:ReturnType<typeof setTimeout>|undefined
  const close=async()=>{
    if(finished)return
    finished=true
    if(idle!==undefined)clearTimeout(idle)
    if(headersTimer!==undefined)clearTimeout(headersTimer)
    init.signal?.removeEventListener('abort',onAbort)
    void wire.cancel()
    try {void socket.close().catch(()=>undefined)} catch { /* Never expose proxy or TLS diagnostic text. */ }
  }
  const fail=(code:string)=>{rejectAbort(new ProxyTransportError(code));void close()}
  const onAbort=()=>fail('proxy_request_cancelled')
  const touch=()=>{if(idle!==undefined)clearTimeout(idle);idle=setTimeout(()=>fail('proxy_idle_timeout'),120000)}
  init.signal?.addEventListener('abort',onAbort,{once:true})
  headersTimer=setTimeout(()=>fail('proxy_header_timeout'),30000)
  if(init.signal?.aborted)onAbort()
  try {
    if(socket.opened)await Promise.race([socket.opened,aborted])
    await handshake(proxy,target,wire,{write: bytes=>Promise.race([writer.write(bytes),aborted])})
    wire.releaseForTls();writer.releaseLock()
    socket=socket.startTls({expectedServerHostname:target.hostname})
    void socket.closed?.catch(()=>undefined)
    wire=new WireReader(socket.readable,aborted);writer=socket.writable.getWriter()
    if(socket.opened)await Promise.race([socket.opened,aborted])
    const request=new Request(target,init),headers=new Headers(request.headers)
    for(const field of ['host','connection','proxy-authorization','proxy-connection','transfer-encoding','content-length','expect'])headers.delete(field)
    headers.set('host',target.hostname);headers.set('connection','close');headers.set('accept-encoding','identity')
    const body=request.body?.getReader()
    let knownLength:number|null=null
    if(typeof init.body==='string')knownLength=encoder.encode(init.body).length
    else if(init.body instanceof ArrayBuffer)knownLength=init.body.byteLength
    else if(ArrayBuffer.isView(init.body))knownLength=init.body.byteLength
    else if(init.body instanceof Blob)knownLength=init.body.size
    if(body)headers.set(knownLength===null?'transfer-encoding':'content-length',knownLength===null?'chunked':String(knownLength))
    let head=`${request.method} ${target.pathname}${target.search} HTTP/1.1\r\n`
    headers.forEach((value,key)=>{head+=`${key}: ${value}\r\n`})
    if(encoder.encode(head).length>MAX_HEADER_BYTES)throw new ProxyTransportError('proxy_request_header_limit')
    await Promise.race([writer.write(encoder.encode(head+'\r\n')),aborted])
    if(body){
      let sent=0
      try {while(true){
        const part=await Promise.race([body.read(),aborted]);if(part.done)break
        if(part.value.byteLength===0)continue
        sent+=part.value.byteLength;if(sent>MAX_BODY_BYTES)throw new ProxyTransportError('proxy_request_body_limit')
        if(knownLength===null)await Promise.race([writer.write(encoder.encode(part.value.byteLength.toString(16)+'\r\n')),aborted])
        await Promise.race([writer.write(part.value),aborted])
        if(knownLength===null)await Promise.race([writer.write(encoder.encode('\r\n')),aborted])
      }} catch(error){void body.cancel().catch(()=>undefined);throw error} finally{body.releaseLock()}
      if(knownLength!==null&&sent!==knownLength)throw new ProxyTransportError('proxy_request_length_mismatch')
      if(knownLength===null)await Promise.race([writer.write(encoder.encode('0\r\n\r\n')),aborted])
    }
    let reply=await readHeaders(wire),interim=0
    while(reply.status<200){if(reply.status===101||++interim>5)throw new ProxyTransportError('proxy_upgrade_unsupported');reply=await readHeaders(wire)}
    if(headersTimer!==undefined)clearTimeout(headersTimer)
    headersTimer=undefined;touch()
    const resultHeaders=new Headers(reply.headers),transfer=reply.headers.get('transfer-encoding'),lengthHeader=reply.headers.get('content-length')
    if(transfer && (transfer.toLowerCase()!=='chunked'||lengthHeader!==null))throw new ProxyTransportError('proxy_ambiguous_body_framing')
    if(lengthHeader!==null && (!/^\d+$/.test(lengthHeader)||!Number.isSafeInteger(Number(lengthHeader))||Number(lengthHeader)>MAX_BODY_BYTES))throw new ProxyTransportError('proxy_invalid_content_length')
    for(const field of ['connection','proxy-connection','keep-alive','transfer-encoding','trailer','upgrade','proxy-authenticate'])resultHeaders.delete(field)
    if(request.method==='HEAD'||reply.status===204||reply.status===205||reply.status===304){await close();return new Response(null,{status:reply.status,headers:resultHeaders})}
    let remaining=lengthHeader===null?null:Number(lengthHeader),chunkRemaining=0,total=0,afterChunk=false,ended=false
    const bodyStream=new ReadableStream<Uint8Array>({
      async pull(controller){
        if(ended)return
        try {
          let value:Uint8Array|null
          if(transfer){
            if(chunkRemaining===0){
              if(afterChunk){const end=await wire.exact(2);if(end[0]!==13||end[1]!==10)throw new ProxyTransportError('proxy_invalid_chunk_ending')}
              const line=await wire.line(),size=line.split(';',1)[0]!
              if(!/^[0-9a-fA-F]{1,8}$/.test(size))throw new ProxyTransportError('proxy_invalid_chunk_size')
              chunkRemaining=parseInt(size,16)
              if(chunkRemaining>MAX_BODY_BYTES-total)throw new ProxyTransportError('proxy_response_body_limit')
              if(chunkRemaining===0){
                let trailers=0;while(true){const trailer=await wire.line();trailers+=trailer.length+2;if(trailers>MAX_HEADER_BYTES)throw new ProxyTransportError('proxy_trailer_limit');if(trailer==='')break}
                ended=true;await close();controller.close();return
              }
              afterChunk=true
            }
            value=await wire.some(Math.min(65536,chunkRemaining));if(value===null)throw new ProxyTransportError('proxy_unexpected_eof');chunkRemaining-=value.length
          } else {
            if(remaining===0){ended=true;await close();controller.close();return}
            value=await wire.some(remaining===null?65536:Math.min(65536,remaining))
            if(value===null){if(remaining!==null&&remaining!==0)throw new ProxyTransportError('proxy_unexpected_eof');ended=true;await close();controller.close();return}
            if(remaining!==null)remaining-=value.length
          }
          total+=value.length;if(total>MAX_BODY_BYTES)throw new ProxyTransportError('proxy_response_body_limit')
          touch();controller.enqueue(value)
        } catch(error){ended=true;await close();controller.error(error instanceof ProxyTransportError?error:new ProxyTransportError('proxy_read_failed'))}
      },
      async cancel(){ended=true;rejectAbort(new ProxyTransportError('proxy_response_cancelled'));await close()},
    })
    const encoding=resultHeaders.get('content-encoding')?.toLowerCase()
    let output:ReadableStream<Uint8Array>=bodyStream
    if(encoding&&encoding!=='identity'){
      if(encoding!=='gzip'&&encoding!=='deflate')throw new ProxyTransportError('proxy_content_encoding_unsupported')
      output=output.pipeThrough(new DecompressionStream(encoding) as unknown as ReadableWritablePair<Uint8Array,Uint8Array>);resultHeaders.delete('content-encoding');resultHeaders.delete('content-length')
      let inflated=0
      output=output.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){inflated+=chunk.length;if(inflated>MAX_BODY_BYTES)throw new ProxyTransportError('proxy_response_body_limit');controller.enqueue(chunk)}}))
    }
    return new Response(output,{status:reply.status,headers:resultHeaders})
  } catch(error){await close();throw error instanceof ProxyTransportError?error:new ProxyTransportError('proxy_connection_failed')}
}
