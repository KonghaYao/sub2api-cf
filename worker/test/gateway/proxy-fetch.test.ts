import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { fetchAccountProxy, type ProxySocket } from '../../src/gateway/proxy-fetch'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function socket(reply: string): ProxySocket & { writes: string[] } {
  const writes: string[] = []
  return {
    writes, opened: Promise.resolve(), closed: new Promise(() => undefined), close: vi.fn(async () => undefined),
    readable: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(reply)); c.close() } }),
    writable: new WritableStream({ write(chunk) { writes.push(new TextDecoder().decode(chunk)) } }),
    startTls: vi.fn(() => { throw new Error('Unexpected TLS upgrade') }),
  }
}
async function fixture() {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  const env = { DB: d1, ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: 'proxy-master-key'.repeat(3) } as Env
  const encrypted = await encryptCredential({ api_key: JSON.stringify({ username: 'proxy-user', password: 'proxy-secret' }) }, env.CREDENTIALS_MASTER_KEY!, 'test/proxy/proxy-id/1')
  raw.prepare(`INSERT INTO proxies (id,name,protocol,host,port,status,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms)
    VALUES ('proxy-id','Proxy','http','proxy.example.test',8080,'active',?,?,1,1)`).run(encrypted.nonce_b64, encrypted.ciphertext_b64)
  return { raw, env }
}

describe('account proxy socket orchestration', () => {
  it('serializes multipart images with matching runtime-generated boundaries inside TLS', async () => {
    const t = await fixture()
    try {
      const plain = socket('HTTP/1.1 200 Connection established\r\n\r\n')
      const tls = socket('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
      plain.startTls = () => tls
      const form = new FormData()
      form.set('model', 'image-upstream')
      form.set('image', new Blob(['image-content'], { type: 'image/png' }), 'source.png')
      const response = await fetchAccountProxy(t.env, 'proxy-id', new URL('https://api.test/images/edits'),
        { method: 'POST', body: form }, new AbortController().signal, async () => plain)
      expect(await response.json()).toEqual({})
      const wire = tls.writes.join('')
      const boundary = /content-type: multipart\/form-data; boundary=([^\r]+)/.exec(wire)![1]
      expect(wire).toContain(`--${boundary}`)
      expect(wire).toContain('filename="source.png"')
      expect(wire).toContain('image-content')
      expect(wire).toContain('image-upstream')
      expect(plain.writes.join('')).not.toContain('image-content')
    } finally { t.raw.close() }
  })

  it.each(['proxy', 'upstream TLS'])('does not write after cancellation while waiting for %s to open', async stage => {
    const t = await fixture()
    try {
      const plain = socket('HTTP/1.1 200 Connection established\r\n\r\n')
      const tls = socket('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
      const waiting = stage === 'proxy' ? plain : tls
      let opened!: () => void
      waiting.opened = new Promise<void>(resolve => { opened = resolve })
      plain.startTls = vi.fn(() => tls)
      const controller = new AbortController()
      const dial = vi.fn(async () => plain)
      const pending = fetchAccountProxy(t.env, 'proxy-id', new URL('https://api.test'), {
        headers: { authorization: 'Bearer private-provider-key' },
      }, controller.signal, dial)
      await vi.waitFor(() => {
        if (stage === 'proxy') expect(dial).toHaveBeenCalledOnce()
        else expect(plain.startTls).toHaveBeenCalledOnce()
      })
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' })
      opened()
      // Drain continuations from opened, handshake and stream writes.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(waiting.writes).toEqual([])
      expect(waiting.close).toHaveBeenCalledOnce()
      if (stage === 'proxy') expect(plain.startTls).not.toHaveBeenCalled()
    } finally { t.raw.close() }
  })

  it('dials only the configured proxy, upgrades for the upstream hostname and separates credentials', async () => {
    const t = await fixture()
    try {
      const plain = socket('HTTP/1.1 200 Connection established\r\n\r\n')
      const tls = socket('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
      plain.startTls = vi.fn(() => tls)
      const dial = vi.fn(async () => plain)
      const result = await fetchAccountProxy(t.env, 'proxy-id', new URL('https://api.example.test/v1/chat'), {
        method: 'POST', headers: { authorization: 'Bearer provider-secret' }, body: '{}',
      }, new AbortController().signal, dial)
      expect(await result.json()).toEqual({})
      expect(dial).toHaveBeenCalledExactlyOnceWith('proxy.example.test', 8080)
      expect(plain.startTls).toHaveBeenCalledWith({ expectedServerHostname: 'api.example.test' })
      expect(plain.writes.join('')).not.toContain('provider-secret')
      expect(tls.writes.join('')).toContain('Bearer provider-secret')
      expect(tls.writes.join('')).not.toContain(btoa('proxy-user:proxy-secret'))
      expect(tls.close).toHaveBeenCalledOnce()
    } finally { t.raw.close() }
  })
  it('closes failed tunnels without attempting a second direct connection', async () => {
    const t = await fixture()
    try {
      const plain = socket('HTTP/1.1 407 Denied\r\n\r\n')
      const dial = vi.fn(async () => plain)
      await expect(fetchAccountProxy(t.env, 'proxy-id', new URL('https://api.test'), {}, new AbortController().signal, dial))
        .rejects.toMatchObject({ code: 'proxy_authentication_failed' })
      expect(dial).toHaveBeenCalledOnce(); expect(plain.close).toHaveBeenCalledOnce()
      expect(plain.startTls).not.toHaveBeenCalled()
    } finally { t.raw.close() }
  })
  it('closes a socket that finishes dialing after the client has aborted', async () => {
    const t = await fixture()
    try {
      const plain = socket('')
      let complete!: (value: ProxySocket) => void
      let started!: () => void
      const reached = new Promise<void>(resolve => { started = resolve })
      const dial = async () => { started(); return new Promise<ProxySocket>(resolve => { complete = resolve }) }
      const controller = new AbortController()
      const pending = fetchAccountProxy(t.env, 'proxy-id', new URL('https://api.test'), {}, controller.signal, dial)
      await reached; controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' })
      complete(plain)
      await vi.waitFor(() => expect(plain.close).toHaveBeenCalledOnce())
    } finally { t.raw.close() }
  })
})
