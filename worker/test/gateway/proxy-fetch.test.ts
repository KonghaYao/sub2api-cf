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
async function fixture(rawPassword = false) {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  const env = { DB: d1, ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: 'proxy-master-key'.repeat(3) } as Env
  const encrypted = await encryptCredential({ api_key: rawPassword ? 'proxy-secret' : JSON.stringify({ schema_version: 1, password: 'proxy-secret' }) }, env.CREDENTIALS_MASTER_KEY!, 'proxy:v1:preserved-creation-key')
  raw.prepare(`INSERT INTO proxies (id,name,config_json,nonce_b64,ciphertext_b64,creation_key,created_at_ms,updated_at_ms)
    VALUES (1,'Proxy',?,?,?,'preserved-creation-key',1,1)`).run(JSON.stringify({
      protocol: 'http', host: 'proxy.example.test', port: 8080, status: 'active', username: 'proxy-user',
    }), encrypted.nonce_b64, encrypted.ciphertext_b64)
  return { raw, env }
}

describe('account proxy socket orchestration', () => {
  it.each(['inactive', 'expired'])('rejects an unavailable proxy without a configured fallback (%s)', async status => {
    const t = await fixture()
    const dial = vi.fn()
    try {
      t.raw.prepare("UPDATE proxies SET config_json=json_set(config_json,'$.status',?) WHERE id=1").run(status)
      await expect(fetchAccountProxy(t.env, 1, new URL('https://api.test'), {}, new AbortController().signal, dial))
        .rejects.toMatchObject({ code: 'proxy_unavailable' })
      expect(dial).not.toHaveBeenCalled()
    } finally { t.raw.close() }
  })

  it('uses the backup identity and rejects a cyclic fallback chain before dialing', async () => {
    const t = await fixture()
    try {
      const backupSecret = await encryptCredential({ api_key: 'proxy-secret' }, t.env.CREDENTIALS_MASTER_KEY!, 'proxy:v1:backup-key')
      t.raw.prepare(`INSERT INTO proxies(id,name,config_json,nonce_b64,ciphertext_b64,creation_key,created_at_ms,updated_at_ms)
        SELECT 2,'Backup',json_set(config_json,'$.host','backup.test'),?,?,'backup-key',1,1 FROM proxies WHERE id=1`)
        .run(backupSecret.nonce_b64, backupSecret.ciphertext_b64)
      t.raw.exec("UPDATE proxies SET config_json=json_set(config_json,'$.status','inactive','$.fallback_mode','proxy','$.backup_proxy_id',2) WHERE id=1")
      const plain = socket('HTTP/1.1 200 Connection established\r\n\r\n')
      const tls = socket('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
      plain.startTls = () => tls
      const dial = vi.fn(async () => plain)
      const response = await fetchAccountProxy(t.env, 1, new URL('https://api.test'), {}, new AbortController().signal, dial)
      expect(await response.json()).toEqual({})
      expect(dial).toHaveBeenCalledWith('backup.test', 8080)
      expect(plain.writes.join('')).toContain(btoa('proxy-user:proxy-secret'))
      t.raw.exec("UPDATE proxies SET config_json=json_set(config_json,'$.status','inactive','$.fallback_mode','proxy','$.backup_proxy_id',1) WHERE id=2")
      dial.mockClear()
      await expect(fetchAccountProxy(t.env, 1, new URL('https://api.test'), {}, new AbortController().signal, dial))
        .rejects.toMatchObject({ code: 'proxy_fallback_cycle' })
      expect(dial).not.toHaveBeenCalled()
    } finally { t.raw.close() }
  })

  it('uses direct access only when the unavailable proxy explicitly permits it', async () => {
    const t = await fixture()
    const direct = vi.fn(async () => new Response('direct-ok'))
    const dial = vi.fn()
    vi.stubGlobal('fetch', direct)
    try {
      t.raw.exec("UPDATE proxies SET config_json=json_set(config_json,'$.expires_at',1,'$.fallback_mode','direct') WHERE id=1")
      const response = await fetchAccountProxy(t.env, 1, new URL('https://api.test'), {}, new AbortController().signal, dial)
      expect(await response.text()).toBe('direct-ok')
      expect(direct).toHaveBeenCalledOnce()
      expect(dial).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals(); t.raw.close() }
  })

  it('serializes multipart images with matching runtime-generated boundaries inside TLS', async () => {
    const t = await fixture()
    try {
      const plain = socket('HTTP/1.1 200 Connection established\r\n\r\n')
      const tls = socket('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
      plain.startTls = () => tls
      const form = new FormData()
      form.set('model', 'image-upstream')
      form.set('image', new Blob(['image-content'], { type: 'image/png' }), 'source.png')
      const response = await fetchAccountProxy(t.env, '1', new URL('https://api.test/images/edits'),
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
      const pending = fetchAccountProxy(t.env, '1', new URL('https://api.test'), {
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

  it.each([false, true])('dials only the configured proxy and separates credentials (legacy password=%s)', async rawPassword => {
    const t = await fixture(rawPassword)
    try {
      const plain = socket('HTTP/1.1 200 Connection established\r\n\r\n')
      const tls = socket('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
      plain.startTls = vi.fn(() => tls)
      const dial = vi.fn(async () => plain)
      const result = await fetchAccountProxy(t.env, '1', new URL('https://api.example.test/v1/chat'), {
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
      await expect(fetchAccountProxy(t.env, '1', new URL('https://api.test'), {}, new AbortController().signal, dial))
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
      const pending = fetchAccountProxy(t.env, '1', new URL('https://api.test'), {}, controller.signal, dial)
      await reached; controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' })
      complete(plain)
      await vi.waitFor(() => expect(plain.close).toHaveBeenCalledOnce())
    } finally { t.raw.close() }
  })
})
