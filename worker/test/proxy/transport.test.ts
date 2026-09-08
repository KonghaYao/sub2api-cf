import { describe, it, expect, vi } from 'vitest'
import { proxyFetch, type ProxySocket, type ProxyConnect } from '../../src/proxy/transport'
const enc=new TextEncoder(),dec=new TextDecoder()
function fixture(response:string, protocol:'http'|'socks5'='http', options:{reject?:boolean;auth?:boolean;hang?:boolean;fragment?:boolean}={}) {
 const plaintext:Uint8Array[]=[],tlsWrites:Uint8Array[]=[];let upgrades=0,closes=0,hostname='',step=0
 let plainController!:ReadableStreamDefaultController<Uint8Array>,tlsController!:ReadableStreamDefaultController<Uint8Array>
 const push=(controller:ReadableStreamDefaultController<Uint8Array>,value:string|number[])=>{
  const bytes=typeof value==='string'?enc.encode(value):new Uint8Array(value)
  if(options.fragment)for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));else controller.enqueue(bytes)
 }
 const tls:ProxySocket={
  readable:new ReadableStream({start(c){tlsController=c}}),
  writable:new WritableStream({write(bytes){tlsWrites.push(bytes.slice());if(tlsWrites.length===1&&!options.hang)push(tlsController,response)}}),
  opened:Promise.resolve(),close:async()=>{closes++},startTls(){throw Error('second TLS forbidden')},
 }
 const plain:ProxySocket={
  readable:new ReadableStream({start(c){plainController=c}}),
  writable:new WritableStream({write(bytes){
   plaintext.push(bytes.slice());if(options.hang)return
   if(protocol==='http')push(plainController,options.reject?'HTTP/1.1 407 Auth Required\r\n\r\n':'HTTP/1.1 200 Connected\r\n\r\n')
   else if(step++===0)push(plainController,[5,options.reject?255:options.auth?2:0])
   else if(options.auth&&step===2)push(plainController,[1,0])
   else push(plainController,[5,0,0,1,127,0,0,1,1,187])
  }}),opened:Promise.resolve(),close:async()=>{closes++},startTls(opts){upgrades++;hostname=opts.expectedServerHostname;return tls},
 }
 const connect:ProxyConnect=vi.fn(()=>plain)
 return {connect,plaintext,tlsWrites,get upgrades(){return upgrades},get closes(){return closes},get hostname(){return hostname}}
}
const proxy={protocol:'http' as const,host:'proxy.example',port:8080,username:'proxy-user',password:'proxy-secret'}
describe('proxy byte transport',()=>{
 it('CONNECT separates proxy credentials from verified target TLS and parses fragmented chunked SSE',async()=>{
  const f=fixture('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: x\n\n\r\n0\r\nX-Final: yes\r\n\r\n','http',{fragment:true})
  const response=await proxyFetch(proxy,'https://upstream.example/v1/chat',{method:'POST',headers:{authorization:'Bearer upstream-secret'},body:'{}'},f.connect)
  expect(await response.text()).toBe('data: x\n\n');expect(f.hostname).toBe('upstream.example');expect(f.upgrades).toBe(1)
  const clear=dec.decode(f.plaintext[0]),encrypted=f.tlsWrites.map(x=>dec.decode(x)).join('')
  expect(clear).toContain('CONNECT upstream.example:443 HTTP/1.1');expect(clear).not.toContain('upstream-secret')
  expect(encrypted).toContain('authorization: Bearer upstream-secret');expect(encrypted).not.toContain('proxy-secret');expect(encrypted).not.toContain('proxy-authorization');expect(f.closes).toBe(1)
 })
 it('SOCKS5 exchanges authenticated domain CONNECT before target TLS',async()=>{
  const f=fixture('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK','socks5',{auth:true,fragment:true})
  expect(await (await proxyFetch({...proxy,protocol:'socks5'},'https://upstream.example/',{},f.connect)).text()).toBe('OK')
  expect([...f.plaintext[0]!]).toEqual([5,1,2]);expect(f.plaintext[1]![0]).toBe(1)
  expect([...f.plaintext[2]!.slice(0,5)]).toEqual([5,1,0,3,16]);expect(f.hostname).toBe('upstream.example')
 })
 it('authentication failure never opens target TLS',async()=>{
  const f=fixture('','http',{reject:true})
  await expect(proxyFetch(proxy,'https://upstream.example/',{},f.connect)).rejects.toThrow('proxy_authentication_failed');expect(f.upgrades).toBe(0);expect(f.closes).toBe(1)
 })
 it('cancels an in-flight handshake and closes its socket',async()=>{
  const f=fixture('','http',{hang:true}),controller=new AbortController()
  const response=proxyFetch(proxy,'https://upstream.example/',{signal:controller.signal},f.connect)
  controller.abort();await expect(response).rejects.toThrow('proxy_request_cancelled');expect(f.upgrades).toBe(0);expect(f.closes).toBe(1)
 })
 it('response cancellation closes the tunnel without buffering the rest',async()=>{
  const f=fixture('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n')
  const response=await proxyFetch(proxy,'https://upstream.example/',{},f.connect)
  const reader=response.body!.getReader();expect(dec.decode((await reader.read()).value)).toBe('x');await reader.cancel();expect(f.closes).toBe(1)
 })
 it.each([
  ['Content-Length: 1\r\nTransfer-Encoding: chunked','x','proxy_ambiguous_body_framing'],
  ['Content-Length: 999999999999','x','proxy_invalid_content_length'],
  ['X-Header: '+ 'x'.repeat(9000),'','proxy_header_limit'],
 ])('rejects unsafe framing %s',async(headers,body,error)=>{
  const f=fixture(`HTTP/1.1 200 OK\r\n${headers}\r\n\r\n${body}`)
  await expect(proxyFetch(proxy,'https://upstream.example/',{},f.connect)).rejects.toThrow(error);expect(f.closes).toBe(1)
 })
 it('malformed body framing fails the returned stream',async()=>{
  const f=fixture('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nNOPE\r\n')
  const response=await proxyFetch(proxy,'https://upstream.example/',{},f.connect)
  await expect(response.text()).rejects.toThrow('proxy_invalid_chunk_size');expect(f.closes).toBe(1)
 })
 it('header deadline aborts a silent proxy',async()=>{
  vi.useFakeTimers()
  try{const f=fixture('','http',{hang:true});const response=proxyFetch(proxy,'https://upstream.example/',{},f.connect);const rejected=expect(response).rejects.toThrow('proxy_header_timeout');await vi.advanceTimersByTimeAsync(30001);await rejected;expect(f.closes).toBe(1)}finally{vi.useRealTimers()}
 })
})
