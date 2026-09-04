import { beforeEach, describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { redeemCodeDigest } from '../../src/user/redeem'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'admin-redeem-test-pepper-value-at-least-32-bytes'
const DAY_MS = 86_400_000

interface Fixture {
  raw: any
  env: Env
  adminHeaders: Record<string, string>
}

let now = Date.now()

beforeEach(() => {
  now = Date.now()
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', 'active', ?, ?)`,
  ).run(now, now)
  for (const [id, type] of [['subscription-pro', 'subscription'], ['standard', 'standard']] as const) {
    raw.prepare(
      `INSERT INTO "groups" (id, name, platform, enabled, group_type, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'openai', 1, ?, ?, ?)`,
    ).run(id, id, type, now, now)
  }
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('admin-session', 'admin-family', 'admin', 1, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    now,
    now + DAY_MS,
    now + 30 * DAY_MS,
  )
  return {
    raw,
    adminHeaders: { authorization: `Bearer ${access}` },
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

async function adminRequest(test: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return await createApp().request(path, {
    ...init,
    headers: { ...test.adminHeaders, ...init.headers },
  }, test.env)
}

function mutationHeaders(key: string, version?: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': key,
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
  }
}

async function body(response: Response): Promise<any> {
  return response.json()
}

describe('admin redeem code HTTP contract', () => {
  it('generates balance codes in integer micros, stores only hashes, and hides plaintext on replay', async () => {
    const test = await fixture()
    const request = {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-balance-1'),
      body: JSON.stringify({ count: 2, type: 'balance', value_micros: 12_345_678 }),
    } as const

    const generatedResponse = await adminRequest(test, '/api/v1/admin/redeem-codes/generate', request)
    expect(generatedResponse.status).toBe(201)
    const generated = (await body(generatedResponse)).data
    expect(generated).toHaveLength(2)
    expect(generated[0]).toMatchObject({
      type: 'balance', value: 12.345678, value_micros: 12_345_678,
      status: 'unused', control_version: 0,
    })
    expect(generated[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(generated[0].code).toMatch(/^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/)

    const stored = test.raw.prepare(
      `SELECT id, code_hash, code_prefix, value_micros FROM redeem_codes ORDER BY id`,
    ).all()
    expect(stored).toHaveLength(2)
    expect(stored[0].code_hash).toHaveLength(64)
    expect(stored.map((row: any) => row.code_hash)).toContain(
      await redeemCodeDigest(generated[0].code, PEPPER),
    )
    expect(JSON.stringify(stored)).not.toContain(generated[0].code)
    expect(test.raw.prepare(
      `SELECT response_json FROM control_idempotency WHERE scope = 'admin.redeem-codes.generate.v1'`,
    ).get().response_json).not.toContain(generated[0].code)

    const replayResponse = await adminRequest(test, '/api/v1/admin/redeem-codes/generate', request)
    expect(replayResponse.status).toBe(200)
    const replay = (await body(replayResponse)).data
    expect(replay).toHaveLength(2)
    expect(replay[0].code).toMatch(/^[A-F0-9]{8}…$/)
    expect(replay[0].warning).toMatch(/not shown again/i)
    expect(replay[0].code).not.toBe(generated[0].code)
  })

  it('lists masked detail, supports exact-code search, and validates subscription groups', async () => {
    const test = await fixture()
    expect((await createApp().request('/api/v1/admin/redeem-codes', {}, test.env)).status).toBe(401)

    const invalidType = await adminRequest(test, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-unsupported'),
      body: JSON.stringify({ count: 1, type: 'invitation', value_micros: 1 }),
    })
    expect(invalidType.status).toBe(400)
    expect((await body(invalidType)).code).toBe('unsupported_redeem_code_type')

    const invalidGroup = await adminRequest(test, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-standard-group'),
      body: JSON.stringify({
        count: 1, type: 'subscription', group_id: 'standard', validity_days: 30,
      }),
    })
    expect(invalidGroup.status).toBe(409)

    const balanceResponse = await adminRequest(test, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-list-balance'),
      body: JSON.stringify({ count: 1, type: 'balance', value_micros: 2_500_000 }),
    })
    const balance = (await body(balanceResponse)).data[0]
    const subscriptionResponse = await adminRequest(test, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-list-subscription'),
      body: JSON.stringify({
        count: 1, type: 'subscription', group_id: 'subscription-pro', validity_days: 45,
      }),
    })
    const subscription = (await body(subscriptionResponse)).data[0]

    const searched = await adminRequest(
      test,
      `/api/v1/admin/redeem-codes?page=1&page_size=20&search=${encodeURIComponent(balance.code)}`,
    )
    expect(searched.status).toBe(200)
    const page = (await body(searched)).data
    expect(page).toMatchObject({ total: 1, page: 1, page_size: 20, pages: 1 })
    expect(page.items[0]).toMatchObject({ id: balance.id, code: `${balance.code.slice(0, 8)}…` })
    expect(JSON.stringify(page)).not.toContain(balance.code)

    const detail = await adminRequest(test, `/api/v1/admin/redeem-codes/${subscription.id}`)
    expect(detail.status).toBe(200)
    expect((await body(detail)).data).toMatchObject({
      id: subscription.id,
      type: 'subscription',
      value_micros: 0,
      group_id: 'subscription-pro',
      validity_days: 45,
      group: { id: 'subscription-pro', name: 'subscription-pro' },
    })

    test.raw.prepare(
      `UPDATE redeem_codes SET expires_at_ms = ? WHERE id = ?`,
    ).run(now - 1, balance.id)
    const expired = await adminRequest(test, '/api/v1/admin/redeem-codes?status=expired')
    expect((await body(expired)).data.items).toMatchObject([{ id: balance.id, status: 'expired' }])
    const stats = (await body(await adminRequest(test, '/api/v1/admin/redeem-codes/stats'))).data
    expect(stats).toMatchObject({
      total_codes: 2,
      active_codes: 1,
      used_codes: 0,
      expired_codes: 1,
      total_value_distributed: 0,
      by_type: { balance: 1, subscription: 1 },
    })
  })

  it('expires and deletes idempotently with optimistic versions and safe state transitions', async () => {
    const test = await fixture()
    const generated = (await body(await adminRequest(test, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-mutations'),
      body: JSON.stringify({ count: 3, type: 'balance', value_micros: 1_000_000 }),
    }))).data

    const missingKey = await adminRequest(test, `/api/v1/admin/redeem-codes/${generated[0].id}/expire`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '"0"' }, body: '{}',
    })
    expect(missingKey.status).toBe(400)

    const stale = await adminRequest(test, `/api/v1/admin/redeem-codes/${generated[0].id}/expire`, {
      method: 'POST', headers: mutationHeaders('redeem-expire-stale', 9), body: '{}',
    })
    expect(stale.status).toBe(412)

    const expireRequest = {
      method: 'POST', headers: mutationHeaders('redeem-expire-once', 0), body: '{}',
    } as const
    const expired = await adminRequest(
      test, `/api/v1/admin/redeem-codes/${generated[0].id}/expire`, expireRequest,
    )
    expect(expired.status).toBe(200)
    expect((await body(expired)).data).toMatchObject({ status: 'expired', control_version: 1 })
    const expireReplay = await adminRequest(
      test, `/api/v1/admin/redeem-codes/${generated[0].id}/expire`, expireRequest,
    )
    expect(expireReplay.status).toBe(200)
    expect((await body(expireReplay)).data).toMatchObject({ status: 'expired', control_version: 1 })

    test.raw.prepare(`UPDATE redeem_codes SET status = 'processing' WHERE id = ?`).run(generated[1].id)
    test.raw.prepare(`UPDATE redeem_codes SET status = 'used' WHERE id = ?`).run(generated[2].id)
    for (const [index, state] of [[1, 'processing'], [2, 'used']] as const) {
      const rejected = await adminRequest(test, `/api/v1/admin/redeem-codes/${generated[index].id}`, {
        method: 'DELETE', headers: mutationHeaders(`redeem-delete-${state}`, 0), body: '{}',
      })
      expect(rejected.status).toBe(409)
      expect((await body(rejected)).code).toBe('redeem_code_not_mutable')
    }

    const deleteRequest = {
      method: 'DELETE', headers: mutationHeaders('redeem-delete-expired', 1), body: '{}',
    } as const
    const deleted = await adminRequest(
      test, `/api/v1/admin/redeem-codes/${generated[0].id}`, deleteRequest,
    )
    expect(deleted.status).toBe(200)
    expect((await body(deleted)).data).toMatchObject({ deleted: 1, id: generated[0].id })
    expect(test.raw.prepare(`SELECT id FROM redeem_codes WHERE id = ?`).get(generated[0].id)).toBeUndefined()
    expect((await adminRequest(
      test, `/api/v1/admin/redeem-codes/${generated[0].id}`, deleteRequest,
    )).status).toBe(200)
  })

  it('batch updates and deletes atomically without touching processing or used codes', async () => {
    const test = await fixture()
    const generated = (await body(await adminRequest(test, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-batch'),
      body: JSON.stringify({ count: 2, type: 'balance', value_micros: 3_000_000 }),
    }))).data
    const ids = generated.map((code: any) => code.id)
    const expected = Object.fromEntries(ids.map((id: string) => [id, 0]))
    const expiresAt = new Date(now + DAY_MS).toISOString()
    const updateRequest = {
      method: 'POST',
      headers: mutationHeaders('redeem-batch-update-1'),
      body: JSON.stringify({
        ids,
        expected_control_versions: expected,
        fields: { notes: 'campaign-a', expires_at: expiresAt },
      }),
    } as const
    const updated = await adminRequest(test, '/api/v1/admin/redeem-codes/batch-update', updateRequest)
    expect(updated.status).toBe(200)
    expect((await body(updated)).data).toMatchObject({ updated: 2 })
    expect(test.raw.prepare(
      `SELECT notes, control_version FROM redeem_codes ORDER BY id`,
    ).all()).toEqual([
      { notes: 'campaign-a', control_version: 1 },
      { notes: 'campaign-a', control_version: 1 },
    ])
    expect((await body(await adminRequest(
      test, '/api/v1/admin/redeem-codes/batch-update', updateRequest,
    ))).data.updated).toBe(2)

    test.raw.prepare(`UPDATE redeem_codes SET status = 'processing' WHERE id = ?`).run(ids[1])
    const unsafe = await adminRequest(test, '/api/v1/admin/redeem-codes/batch-update', {
      method: 'POST',
      headers: mutationHeaders('redeem-batch-update-processing'),
      body: JSON.stringify({
        ids,
        expected_control_versions: Object.fromEntries(ids.map((id: string) => [id, 1])),
        fields: { notes: 'must-not-apply' },
      }),
    })
    expect(unsafe.status).toBe(409)
    expect(test.raw.prepare(`SELECT notes FROM redeem_codes WHERE id = ?`).get(ids[0])).toEqual({
      notes: 'campaign-a',
    })

    const unsafeDelete = await adminRequest(test, '/api/v1/admin/redeem-codes/batch-delete', {
      method: 'POST',
      headers: mutationHeaders('redeem-batch-delete-processing'),
      body: JSON.stringify({
        ids,
        expected_control_versions: Object.fromEntries(ids.map((id: string) => [id, 1])),
      }),
    })
    expect(unsafeDelete.status).toBe(409)
    expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM redeem_codes`).get()).toEqual({ total: 2 })

    test.raw.prepare(`UPDATE redeem_codes SET status = 'unused' WHERE id = ?`).run(ids[1])
    const deleteRequest = {
      method: 'POST',
      headers: mutationHeaders('redeem-batch-delete-safe'),
      body: JSON.stringify({
        ids,
        expected_control_versions: Object.fromEntries(ids.map((id: string) => [id, 1])),
      }),
    } as const
    const deleted = await adminRequest(test, '/api/v1/admin/redeem-codes/batch-delete', deleteRequest)
    expect(deleted.status).toBe(200)
    expect((await body(deleted)).data).toMatchObject({ deleted: 2 })
    expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM redeem_codes`).get()).toEqual({ total: 0 })
    expect((await adminRequest(test, '/api/v1/admin/redeem-codes/batch-delete', deleteRequest)).status).toBe(200)
  })

  it('rolls back idempotent writes when a code disappears after the pre-read', async () => {
    const single = await fixture()
    const generated = (await body(await adminRequest(single, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-single-race'),
      body: JSON.stringify({ count: 1, type: 'balance', value_micros: 1_000_000 }),
    }))).data[0]
    const originalSingleBatch = single.env.DB.batch.bind(single.env.DB)
    let singleRaceInjected = false
    single.env.DB.batch = async (statements) => {
      if (!singleRaceInjected) {
        singleRaceInjected = true
        single.raw.prepare(`DELETE FROM redeem_codes WHERE id = ?`).run(generated.id)
      }
      return originalSingleBatch(statements)
    }
    const expired = await adminRequest(single, `/api/v1/admin/redeem-codes/${generated.id}/expire`, {
      method: 'POST', headers: mutationHeaders('redeem-expire-race', 0), body: '{}',
    })
    expect(expired.status).toBe(412)
    expect(single.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'admin.redeem-codes.expire.v1'`,
    ).get()).toEqual({ total: 0 })

    const batch = await fixture()
    const codes = (await body(await adminRequest(batch, '/api/v1/admin/redeem-codes/generate', {
      method: 'POST',
      headers: mutationHeaders('redeem-generate-batch-race'),
      body: JSON.stringify({ count: 2, type: 'balance', value_micros: 1_000_000 }),
    }))).data
    const originalBatch = batch.env.DB.batch.bind(batch.env.DB)
    let batchRaceInjected = false
    batch.env.DB.batch = async (statements) => {
      if (!batchRaceInjected) {
        batchRaceInjected = true
        batch.raw.prepare(`DELETE FROM redeem_codes WHERE id = ?`).run(codes[1].id)
      }
      return originalBatch(statements)
    }
    const ids = codes.map((code: any) => code.id)
    const response = await adminRequest(batch, '/api/v1/admin/redeem-codes/batch-update', {
      method: 'POST',
      headers: mutationHeaders('redeem-batch-update-race'),
      body: JSON.stringify({
        ids,
        expected_control_versions: Object.fromEntries(ids.map((id: string) => [id, 0])),
        fields: { notes: 'must-roll-back' },
      }),
    })
    expect(response.status).toBe(412)
    expect(batch.raw.prepare(`SELECT notes FROM redeem_codes WHERE id = ?`).get(codes[0].id)).toEqual({
      notes: '',
    })
    expect(batch.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'admin.redeem-codes.batch-update.v1'`,
    ).get()).toEqual({ total: 0 })
  })
})
