import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { sweepExpiredProxies } from '../../src/control/proxy-expiry'
import type { Env } from '../../src/env'

it('atomically rebinds an expired proxy through real D1 batch and reports the changed account count', async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO proxies (id,name,config_json,nonce_b64,ciphertext_b64,creation_key,created_at_ms,updated_at_ms)
      VALUES (10001,'Expiry','{"protocol":"http","host":"proxy.test","port":8080,"status":"active","expires_at":10,"fallback_mode":"direct"}',
      'unused','unused','expiry-binding',1,1)`),
    env.DB.prepare(`INSERT INTO accounts (id,platform,name,credential_ref,created_at_ms,updated_at_ms,ui_config_json)
      VALUES ('expiry-binding-account','openai','Expiry binding account','unused',1,1,'{"proxy_id":10001}')`),
  ])
  expect(await sweepExpiredProxies(env as unknown as Env, 10000)).toBe(1)
  const account = await env.DB.prepare("SELECT ui_config_json,control_version FROM accounts WHERE id='expiry-binding-account'").first<{ ui_config_json: string; control_version: number }>()
  expect(JSON.parse(account!.ui_config_json)).toEqual({ proxy_id: null, proxy_fallback_origin_id: 10001 })
  expect(account!.control_version).toBe(1)
  expect(await sweepExpiredProxies(env as unknown as Env, 10000)).toBe(0)
})
