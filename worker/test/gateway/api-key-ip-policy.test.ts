import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { authenticateGatewayRequest } from '../../src/gateway/repository'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'api-key-policy-test-pepper-value-32-bytes'
const RAW_KEY = 'customer-policy-token-1234567890'

async function fixture(
  allowlist: string[] = [],
  denylist: string[] = [],
): Promise<{ raw: any; env: Env }> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`
    INSERT INTO users (
      id, email, status, balance_micros, created_at_ms, updated_at_ms
    ) VALUES ('user-1', 'policy@example.test', 'active', 1000000, 1, 1);
    INSERT INTO "groups" (
      id, name, platform, enabled, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'Policy', 'openai', 1, 1, 1);
  `)
  raw.prepare(`
    INSERT INTO api_keys (
      id, user_id, key_hash, name, enabled, group_id, key_prefix,
      ip_allowlist_json, ip_denylist_json, created_at_ms, updated_at_ms
    ) VALUES ('key-1', 'user-1', ?, 'Policy key', 1, 'group-1', 'customer-pol', ?, ?, 1, 1)
  `).run(await apiKeyDigest(RAW_KEY, PEPPER), JSON.stringify(allowlist), JSON.stringify(denylist))
  return {
    raw,
    env: { DB: d1, API_KEY_PEPPER: PEPPER, ENVIRONMENT: 'test' } as Env,
  }
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://gateway.test/v1/models', {
    headers: { authorization: `Bearer ${RAW_KEY}`, ...headers },
  })
}

describe('gateway API key IP policy', () => {
  it('accepts matching IPv4 and IPv6 CIDRs while an empty allowlist remains unrestricted', async () => {
    const test = await fixture(['10.0.0.0/8', '2001:db8::/32'])

    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '10.8.7.6',
    }), test.env)).resolves.toMatchObject({ api_key_id: 'key-1' })
    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '2001:db8:abcd::2',
    }), test.env)).resolves.toMatchObject({ api_key_id: 'key-1' })
    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '192.0.2.7',
    }), test.env)).rejects.toMatchObject({ status: 403, code: 'api_key_ip_restricted' })

    test.raw.prepare(`UPDATE api_keys SET ip_allowlist_json = '[]' WHERE id = 'key-1'`).run()
    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '192.0.2.7',
    }), test.env)).resolves.toMatchObject({ api_key_id: 'key-1' })
  })

  it('matches a canonical IPv4-mapped IPv6 address without treating it as IPv4', async () => {
    const test = await fixture(['::ffff:c000:201'])

    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '::ffff:192.0.2.1',
    }), test.env)).resolves.toMatchObject({ api_key_id: 'key-1' })
    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '192.0.2.1',
    }), test.env)).rejects.toMatchObject({ status: 403, code: 'api_key_ip_restricted' })
  })

  it('handles compressed IPv6 zero and exact-prefix boundaries without crossing address families', async () => {
    const test = await fixture(['::/0'], ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128'])

    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '2001:db8::1',
    }), test.env)).resolves.toMatchObject({ api_key_id: 'key-1' })
    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    }), test.env)).rejects.toMatchObject({ status: 403, code: 'api_key_ip_restricted' })
    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '0.0.0.0',
    }), test.env)).rejects.toMatchObject({ status: 403, code: 'api_key_ip_restricted' })
  })

  it('applies deny rules before allow rules and observes policy changes on the next authentication', async () => {
    const test = await fixture(['10.0.0.0/8'], ['10.2.0.0/16'])
    const source = { 'x-sub2api-test-client-ip': '10.2.3.4' }

    await expect(authenticateGatewayRequest(request(source), test.env)).rejects.toMatchObject({
      status: 403,
      code: 'api_key_ip_restricted',
    })
    test.raw.prepare(
      `UPDATE api_keys
          SET ip_denylist_json = '[]', auth_version = auth_version + 1,
              control_version = control_version + 1
        WHERE id = 'key-1'`,
    ).run()
    await expect(authenticateGatewayRequest(request(source), test.env)).resolves.toMatchObject({
      api_key_auth_version: 2,
    })
  })

  it('trusts only CF-Connecting-IP outside local tests and never accepts X-Forwarded-For as an ACL source', async () => {
    const test = await fixture(['203.0.113.8'])
    const production = { ...test.env, ENVIRONMENT: 'production' }

    await expect(authenticateGatewayRequest(request({
      'cf-connecting-ip': '203.0.113.8',
      'x-forwarded-for': '198.51.100.9',
    }), production)).resolves.toMatchObject({ api_key_id: 'key-1' })
    await expect(authenticateGatewayRequest(request({
      'x-forwarded-for': '203.0.113.8',
      'x-sub2api-test-client-ip': '203.0.113.8',
    }), production)).rejects.toMatchObject({ status: 403, code: 'api_key_ip_restricted' })
    await expect(authenticateGatewayRequest(request({
      'cf-connecting-ip': 'not-an-ip',
      'x-forwarded-for': '203.0.113.8',
    }), production)).rejects.toMatchObject({ status: 403, code: 'api_key_ip_restricted' })
  })

  it('fails closed when a persisted policy is non-canonical or corrupt', async () => {
    const test = await fixture()
    test.raw.prepare(`UPDATE api_keys SET ip_allowlist_json = '["10.2.3.4/8"]'`).run()

    await expect(authenticateGatewayRequest(request({
      'x-sub2api-test-client-ip': '10.2.3.4',
    }), test.env)).rejects.toMatchObject({ status: 500, code: 'invalid_api_key_ip_policy' })
  })
  it('applies administrator forwarded header trust changes to the next authentication',async()=>{
    const test=await fixture(['198.51.100.0/24'])
    const incoming=request({'cf-connecting-ip':'203.0.113.8','x-forwarded-for':'198.51.100.9, 203.0.113.8'})
    await expect(authenticateGatewayRequest(incoming,test.env)).rejects.toMatchObject({code:'api_key_ip_restricted'})
    test.raw.exec("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.api_key_acl_trust_forwarded_ip',json('true'),'$.forwarded_client_ip_headers',json('[\"x-forwarded-for\"]')) WHERE id='global'")
    await expect(authenticateGatewayRequest(incoming,test.env)).resolves.toMatchObject({api_key_id:'key-1'})
    test.raw.exec("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.api_key_acl_trust_forwarded_ip',json('false')) WHERE id='global'")
    await expect(authenticateGatewayRequest(incoming,test.env)).rejects.toMatchObject({code:'api_key_ip_restricted'})
    test.raw.close()
  })

})
