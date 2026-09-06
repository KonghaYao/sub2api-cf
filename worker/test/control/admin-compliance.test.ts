import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)
const ZH_PHRASE = '我已阅读、理解并同意 Sub2API 部署与运营合规承诺'
const EN_PHRASE = 'I have read, understood, and agree to the Sub2API Deployment and Operation Compliance Commitment'

describe('administrator compliance acknowledgement', () => {
  let raw: any
  let env: Env
  let authorization: string

  beforeEach(async () => {
    const database = createSqliteD1()
    raw = database.raw
    applyMigrations(raw)
    const now = Date.now()
    const accessToken = createOpaqueToken('access')
    const refreshToken = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
       ) VALUES ('admin-1', 'admin@example.test', 'Admin', 'admin', 'active', 1, ?, ?)`,
    ).run(now, now)
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES ('admin-session-1', 'admin-family-1', 'admin-1', 1, ?, ?, ?, ?, ?)`,
    ).run(
      await tokenDigest(accessToken, PEPPER, 'access'),
      await tokenDigest(refreshToken, PEPPER, 'refresh'),
      now,
      now + 60_000,
      now + 120_000,
    )
    authorization = `Bearer ${accessToken}`
    env = {
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
      CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: database.d1, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue, USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
    }
  })

  it('reports the current version as required until this administrator accepts the exact Chinese phrase', async () => {
    const initial = await request('/api/v1/admin/compliance')
    expect(initial.status).toBe(200)
    await expect(initial.json()).resolves.toMatchObject({
      code: 0,
      data: {
        required: true,
        version: 'v2026.06.10',
        ack_phrase_zh: ZH_PHRASE,
        ack_phrase_en: EN_PHRASE,
      },
    })

    const accepted = await request('/api/v1/admin/compliance/accept', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.24',
        'user-agent': `compliance-test/${'x'.repeat(600)}`,
        'x-forwarded-for': '198.51.100.6',
      },
      body: JSON.stringify({ phrase: ZH_PHRASE, language: 'zh-CN' }),
    })
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({
      code: 0,
      data: {
        required: false,
        acknowledgement: {
          version: 'v2026.06.10',
          document_zh: 'docs/legal/admin-compliance.zh.md',
          document_en: 'docs/legal/admin-compliance.en.md',
          admin_user_id: 'admin-1',
          ip_address: '203.0.113.24',
        },
      },
    })
    const stored = raw.prepare(
      `SELECT ip_address, user_agent FROM admin_compliance_acknowledgements
        WHERE admin_user_id = 'admin-1' AND version = 'v2026.06.10'`,
    ).get()
    expect(stored).toEqual({ ip_address: '203.0.113.24', user_agent: `compliance-test/${'x'.repeat(496)}` })
  })

  it('rejects a phrase for the wrong language and old acknowledgements require the current version again', async () => {
    const wrongPhrase = await request('/api/v1/admin/compliance/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phrase: EN_PHRASE, language: 'zh' }),
    })
    expect(wrongPhrase.status).toBe(400)
    await expect(wrongPhrase.json()).resolves.toMatchObject({ error: { code: 'ADMIN_COMPLIANCE_INVALID_PHRASE' } })

    raw.prepare(
      `INSERT INTO admin_compliance_acknowledgements (
         admin_user_id, version, document_zh, document_en, language, ip_address, user_agent, accepted_at_ms
       ) VALUES ('admin-1', 'v2025.01.01', 'old-zh', 'old-en', 'en', NULL, NULL, ?)`,
    ).run(Date.now())
    const status = await request('/api/v1/admin/compliance')
    const body = await status.json() as { code: number; data: Record<string, unknown> }
    expect(body).toMatchObject({ code: 0, data: { required: true } })
    expect(body.data).not.toHaveProperty('acknowledgement')
  })

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return createApp().request(path, {
      ...init,
      headers: { authorization, ...init.headers },
    }, env)
  }
})
