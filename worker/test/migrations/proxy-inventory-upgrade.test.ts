import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('deployed proxy inventory upgrade', () => {
  it('preserves encrypted identities and account/backup references while exposing live configuration fields', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw, 97)
      const insert = raw.prepare(`INSERT INTO proxies(name,config_json,nonce_b64,ciphertext_b64,
        creation_key,control_version,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,4,1,2)`)
      insert.run('backup', JSON.stringify({ protocol: 'socks5', host: 'backup.test', port: 1080,
        status: 'active', expires_at: null, fallback_mode: 'none', backup_proxy_id: null }),
      'backup-nonce', 'backup-ciphertext', 'backup-aad-key')
      insert.run('primary', JSON.stringify({ protocol: 'http', host: 'primary.test', port: 8080,
        status: 'active', expires_at: 2000000000, fallback_mode: 'proxy', backup_proxy_id: 1, expiry_warn_days: 7 }),
      'primary-nonce', 'primary-ciphertext', 'primary-aad-key')
      raw.prepare(`INSERT INTO accounts(id,platform,name,credential_ref,enabled,max_concurrency,
        protocol,base_url,auth_scheme,ui_config_json,created_at_ms,updated_at_ms)
        VALUES('linked','openai','Linked','vault',1,1,'openai','https://api.example.test','bearer',?,1,2)`)
        .run(JSON.stringify({ proxy_id: 2 }))
      raw.exec("INSERT INTO proxy_creation_requests(key_hash,fingerprint,proxy_id,created_at_ms) VALUES('preserved-replay','preserved-fingerprint',2,1)")
      const columns = 'id,name,config_json,nonce_b64,ciphertext_b64,creation_key,control_version,created_at_ms,updated_at_ms'
      const before = raw.prepare(`SELECT ${columns} FROM proxies ORDER BY id`).all()
      applyMigrations(raw)
      expect(raw.prepare(`SELECT ${columns} FROM proxies ORDER BY id`).all()).toEqual(before)
      expect(raw.prepare('SELECT identity_digest FROM proxies ORDER BY id').all()).toEqual([{identity_digest:null},{identity_digest:null}])
      expect(raw.prepare("SELECT * FROM proxy_creation_requests WHERE key_hash='preserved-replay'").get()).toEqual({key_hash:'preserved-replay',fingerprint:'preserved-fingerprint',proxy_id:2,created_at_ms:1,created:1})
      expect(raw.prepare('SELECT protocol,host,port,status,expires_at,fallback_mode,backup_proxy_id,expiry_warn_days FROM proxies WHERE id=2').get())
        .toEqual({ protocol: 'http', host: 'primary.test', port: 8080, status: 'active', expires_at: 2000000000,
          fallback_mode: 'proxy', backup_proxy_id: 1, expiry_warn_days: 7 })
      expect(() => raw.exec('DELETE FROM proxies WHERE id=1')).toThrow('proxy_in_use')
      expect(() => raw.exec('DELETE FROM proxies WHERE id=2')).toThrow('proxy_in_use')
      raw.exec(`UPDATE proxies SET config_json=json_set(config_json,'$.host','edited.test','$.status','inactive'),
        control_version=control_version+1 WHERE id=2 AND control_version=4`)
      expect(raw.prepare('SELECT host,status,control_version FROM proxies WHERE id=2').get())
        .toEqual({ host: 'edited.test', status: 'inactive', control_version: 5 })
      expect(raw.prepare("SELECT json_extract(ui_config_json,'$.proxy_id') AS proxy_id FROM accounts WHERE id='linked'").get())
        .toEqual({ proxy_id: 2 })
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { raw.close() }
  })
})
