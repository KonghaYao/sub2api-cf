import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  consumeAccountSyntheticProbe,
  isAccountSyntheticProbeEvent,
  listAdminAccountSyntheticProbeHistory,
  queueAdminAccountSyntheticProbes,
  type AccountSyntheticProbeEvent,
} from '../../src/control/account-synthetic-probes'
import type { Env, PlatformEvent } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { credentialAad } from '../../src/gateway/repository'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.UTC(2026, 8, 6, 8, 0, 0)
const TOKEN = 'synthetic-admin-session'
const PEPPER = 'p'.repeat(32)
const MASTER_KEY = 'synthetic-probe-master-key-32-bytes'

class QueueCapture {
  messages: PlatformEvent[] = []
  async send(value: PlatformEvent): Promise<void> { this.messages.push(structuredClone(value)) }
}

interface Fixture { raw: any; env: Env; queue: QueueCapture; app: Hono<{ Bindings: Env }> }

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`
    INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
    VALUES ('synthetic-admin', 'synthetic-admin@example.test', 'Admin', 'admin', 'active', ${NOW}, ${NOW});
  `)
  raw.prepare(`
    INSERT INTO admin_sessions (id, user_id, token_hash, created_at_ms, expires_at_ms)
    VALUES ('synthetic-session', 'synthetic-admin', ?, ?, ?)
  `).run(await apiKeyDigest(`admin-session:v1:${TOKEN}`, PEPPER), NOW, NOW + 60_000)
  const queue = new QueueCapture()
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ASSETS: {} as Fetcher, DB: d1, CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: queue as unknown as Queue<PlatformEvent>,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.post('/synthetic-probes', queueAdminAccountSyntheticProbes)
  app.get('/synthetic-probes/history', listAdminAccountSyntheticProbeHistory)
  return { raw, env, queue, app }
}

async function seedTarget(test: Fixture, suffix = 'one', capability = 'responses'): Promise<void> {
  const accountId = `account-${suffix}`
  const modelId = `model-${suffix}`
  const secretId = `secret-${suffix}`
  const encrypted = await encryptCredential(
    { api_key: `provider-secret-${suffix}` }, MASTER_KEY,
    credentialAad('test', accountId, secretId, 1),
  )
  test.raw.prepare(`
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
      config_version, control_version
    ) VALUES (?, 'openai', ?, ?, 1, 4, ?, ?, 'openai',
      'https://upstream.example.test/v1', 'bearer', 1, 2)
  `).run(accountId, accountId, secretId, NOW, NOW)
  test.raw.prepare(`
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run(secretId, accountId, encrypted.nonce_b64, encrypted.ciphertext_b64, NOW, NOW)
  test.raw.prepare(`
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, enabled, created_at_ms, updated_at_ms
    ) VALUES (?, 'openai', ?, ?, 'both', 1, ?, ?)
  `).run(modelId, modelId, `upstream-${suffix}`, NOW, NOW)
  test.raw.prepare(`
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(accountId, modelId, capability === 'chat_completions' ? 1 : 0,
    capability === 'responses' ? 1 : 0, NOW, NOW)
}

async function post(test: Fixture, targets: unknown[], key = 'synthetic-1'): Promise<Response> {
  return await test.app.request('/synthetic-probes', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify({ targets }),
  }, test.env)
}

function target(suffix = 'one', capability = 'responses') {
  return {
    account_id: `account-${suffix}`,
    expected_control_version: 2,
    model_id: `model-${suffix}`,
    capability,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('account model synthetic probes', () => {
  it('queues a credential-free canonical event and never calls upstream from HTTP', async () => {
    const test = await fixture()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    try {
      await seedTarget(test)
      const response = await post(test, [target()])
      expect(response.status).toBe(202)
      const payload = await response.json()
      expect(payload).toMatchObject({ data: {
        total: 1, queued: 1, failed: 0,
        results: [{ account_id: 'account-one', model_id: 'model-one', capability: 'responses' }],
      } })
      expect(fetch).not.toHaveBeenCalled()
      expect(test.queue.messages).toHaveLength(1)
      expect(isAccountSyntheticProbeEvent(test.queue.messages[0])).toBe(true)
      expect(JSON.stringify(test.queue.messages[0])).not.toContain('provider-secret')

      const replay = await post(test, [target()])
      expect(await replay.json()).toEqual(payload)
      expect(test.queue.messages).toHaveLength(1)
    } finally { test.raw.close() }
  })

  it('enforces the account/model/capability relationship and the 25-target ceiling', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      const wrong = await post(test, [{ ...target(), capability: 'chat_completions' }], 'wrong-cap')
      await expect(wrong.json()).resolves.toMatchObject({ data: {
        queued: 0, failed: 1,
        results: [{ error: { code: 'account_model_capability_not_enabled' } }],
      } })
      const tooMany = await post(test, Array.from({ length: 26 }, (_, index) => ({
        ...target(), account_id: `account-${index}`,
      })), 'too-many')
      expect(tooMany.status).toBe(400)
    } finally { test.raw.close() }
  })

  it('records firing after three failures, then resolved after recovery, without email bindings', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ output: [{ type: 'message' }] })))

      for (let generation = 1; generation <= 4; generation += 1) {
        const response = await post(test, [target()], `synthetic-run-${generation}`)
        expect(response.status).toBe(202)
        const event = test.queue.messages.at(-1) as AccountSyntheticProbeEvent
        await consumeAccountSyntheticProbe(event, test.env, NOW + generation)
      }
      expect(test.raw.prepare(`
        SELECT status FROM account_synthetic_alert_events ORDER BY occurred_at_ms, id
      `).all()).toEqual([{ status: 'firing' }, { status: 'resolved' }])
      expect(test.raw.prepare(`
        SELECT outcome, alert_transition FROM account_synthetic_probe_history
        ORDER BY checked_at_ms, id
      `).all()).toEqual([
        { outcome: 'failed', alert_transition: null },
        { outcome: 'failed', alert_transition: null },
        { outcome: 'failed', alert_transition: 'firing' },
        { outcome: 'succeeded', alert_transition: 'resolved' },
      ])
    } finally { test.raw.close() }
  })

  it('treats an empty successful upstream response as a failed probe', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
      await post(test, [target()], 'invalid-upstream-response')
      await consumeAccountSyntheticProbe(
        test.queue.messages.at(-1) as AccountSyntheticProbeEvent, test.env, NOW + 1,
      )
      expect(test.raw.prepare(`
        SELECT outcome, error_code FROM account_synthetic_probe_history
      `).get()).toEqual({ outcome: 'failed', error_code: 'upstream_invalid_response' })
    } finally { test.raw.close() }
  })

  it('ignores stale and replayed deliveries and pages history with an opaque cursor', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ output: [{ type: 'message' }] })))
      await post(test, [target()], 'stale-first')
      const stale = test.queue.messages.at(-1) as AccountSyntheticProbeEvent
      await post(test, [target()], 'stale-second')
      const current = test.queue.messages.at(-1) as AccountSyntheticProbeEvent
      await consumeAccountSyntheticProbe(stale, test.env, NOW + 1)
      await consumeAccountSyntheticProbe(current, test.env, NOW + 2)
      await consumeAccountSyntheticProbe(current, test.env, NOW + 3)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(test.raw.prepare('SELECT COUNT(*) AS total FROM account_synthetic_probe_history').get())
        .toEqual({ total: 1 })

      const first = await test.app.request(
        '/synthetic-probes/history?account_id=account-one&limit=1',
        { headers: { authorization: `Bearer ${TOKEN}` } }, test.env,
      )
      const page = await first.json() as any
      expect(page.data.items).toHaveLength(1)
      expect(page.data.items[0]).not.toHaveProperty('health_error')
      expect(page.data.next_cursor).toBeNull()
    } finally { test.raw.close() }
  })
})
