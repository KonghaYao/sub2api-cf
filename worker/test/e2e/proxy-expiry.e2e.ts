import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { sweepExpiredProxies } from '../../src/control/proxy-expiry'
import type { Env } from '../../src/env'

it('atomically rebinds an expired proxy through real D1 batch and reports the changed account count', async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO proxies (id,name,protocol,host,port,status,expires_at,fallback_mode,
      nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES
      ('expiry-binding','Expiry','http','proxy.test',8080,'active',10,'direct','unused','unused',1,1)`),
    env.DB.prepare(`INSERT INTO accounts (id,platform,name,credential_ref,created_at_ms,updated_at_ms,ui_config_json)
      VALUES ('expiry-binding-account','openai','Expiry binding account','unused',1,1,'{"proxy_id":"expiry-binding"}')`),
  ])
  expect(await sweepExpiredProxies(env as unknown as Env, 10000)).toBe(1)
  const account = await env.DB.prepare("SELECT ui_config_json,control_version FROM accounts WHERE id='expiry-binding-account'").first<{ ui_config_json: string; control_version: number }>()
  expect(JSON.parse(account!.ui_config_json)).toEqual({ proxy_id: null, proxy_fallback_origin_id: 'expiry-binding' })
  expect(account!.control_version).toBe(1)
  expect(await sweepExpiredProxies(env as unknown as Env, 10000)).toBe(0)
})
