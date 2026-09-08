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
import { runScheduledRecovery } from '../../src/index'
import { consumeSettingsMaintenance } from '../../src/maintenance/queue'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.UTC(2026, 8, 6, 8, 0, 0)
const TOKEN = 'synthetic-admin-session'
const PEPPER = 'p'.repeat(32)
const MASTER_KEY = 'synthetic-probe-master-key-32-bytes'

class QueueCapture {
  messages: PlatformEvent[] = []
  failuresRemaining = 0
  async send(value: PlatformEvent): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('queue unavailable')
    }
    this.messages.push(structuredClone(value))
  }
}

interface Fixture { raw: any; env: Env; queue: QueueCapture; app: Hono<{ Bindings: Env }> }

async function runCronProbeRecovery(test: Fixture): Promise<void> {
  const previousMessages = test.queue.messages.length
  const previousProbeEvents = test.queue.messages.filter(isAccountSyntheticProbeEvent).length
  await runScheduledRecovery(test.env)
  const dispatched = test.queue.messages.slice(previousMessages)
  expect(dispatched).toHaveLength(36)
  expect(dispatched.every(event => event.event_type === 'settings.maintenance.v1')).toBe(true)
  expect(test.queue.messages.filter(isAccountSyntheticProbeEvent)).toHaveLength(previousProbeEvents)
  const maintenance = dispatched.find(event =>
    (event.payload as { task?: string }).task === 'account_synthetic_probes')
  expect(maintenance).toBeDefined()
  expect(await consumeSettingsMaintenance(maintenance, test.env)).toBe(true)
}


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

async function seedTarget(
  test: Fixture,
  suffix = 'one',
  capability = 'responses',
  platform: 'openai' | 'anthropic' | 'gemini' | 'codex' = 'openai',
): Promise<void> {
  const accountId = `account-${suffix}`
  const modelId = `model-${suffix}`
  const secretId = `secret-${suffix}`
  const provider = {
    openai: { protocol: 'openai', authScheme: 'bearer', baseUrl: 'https://openai.example.test/v1' },
    anthropic: { protocol: 'anthropic', authScheme: 'x-api-key', baseUrl: 'https://anthropic.example.test' },
    gemini: { protocol: 'gemini', authScheme: 'x-goog-api-key', baseUrl: 'https://gemini.example.test' },
    codex: { protocol: 'codex', authScheme: 'bearer', baseUrl: 'https://chatgpt.example.test' },
  }[platform]
  const encrypted = await encryptCredential(
    { api_key: `provider-secret-${suffix}` }, MASTER_KEY,
    credentialAad('test', accountId, secretId, 1),
  )
  test.raw.prepare(`
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
      config_version, control_version
    ) VALUES (?, ?, ?, ?, 1, 4, ?, ?, ?, ?, ?, 1, 2)
  `).run(
    accountId, platform, accountId, secretId, NOW, NOW,
    provider.protocol, provider.baseUrl, provider.authScheme,
  )
  test.raw.prepare(`
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run(secretId, accountId, encrypted.nonce_b64, encrypted.ciphertext_b64, NOW, NOW)
  test.raw.prepare(`
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, enabled, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'both', 1, ?, ?)
  `).run(modelId, platform, modelId, `upstream-${suffix}`, NOW, NOW)
  test.raw.prepare(`
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(accountId, modelId, capability === 'chat_completions' ? 1 : 0,
    capability === 'responses' ? 1 : 0, capability === 'embeddings' ? 1 : 0, NOW, NOW)
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
  it('records failure without direct fallback when the bound proxy is unavailable', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      test.raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(10001,'Probe',json_object('protocol','https','host','proxy.test','port',443,'status','active'),'probe-proxy','','',1,1)")
      test.raw.exec("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id',10001)")
      const direct = vi.fn().mockResolvedValue(Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }))
      vi.stubGlobal('fetch', direct)
      expect((await post(test, [target()], 'bound-proxy')).status).toBe(202)
      await consumeAccountSyntheticProbe(test.queue.messages.at(-1) as AccountSyntheticProbeEvent, test.env, NOW + 1)
      expect(test.raw.prepare('SELECT outcome, error_code FROM account_synthetic_probe_history').get()).toEqual({ outcome: 'failed', error_code: 'upstream_transport_failed' })
      expect(direct).not.toHaveBeenCalled()
    } finally { test.raw.close() }
  })

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
        .mockResolvedValueOnce(Response.json({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
        })))

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

  it.each([null, { error: { message: 'private error' }, choices: [{ message: { content: 'partial' } }] },
    { status: 'failed', choices: [{ message: { content: 'partial' } }] }])('rejects empty or failed HTTP 200 probe bodies: %j', async body => {
    const test = await fixture()
    try {
      await seedTarget(test, 'one', 'chat_completions')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body === null ? new Response(null, { status: 200 }) : Response.json(body)))
      await post(test, [target('one', 'chat_completions')], 'invalid-upstream-response')
      await consumeAccountSyntheticProbe(
        test.queue.messages.at(-1) as AccountSyntheticProbeEvent, test.env, NOW + 1,
      )
      expect(test.raw.prepare(`
        SELECT outcome, error_code FROM account_synthetic_probe_history
      `).get()).toEqual({ outcome: 'failed', error_code: 'upstream_invalid_response' })
    } finally { test.raw.close() }
  })

  it.each([
    ['openai', 'chat_completions', '/v1/chat/completions', 'messages', { choices: [{ message: { content: 'OK' } }] }],
    ['openai', 'responses', '/v1/responses', 'input', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }],
    ['openai', 'embeddings', '/v1/embeddings', 'input', { data: [{ embedding: [0.25] }] }],
    ['anthropic', 'chat_completions', '/v1/messages', 'messages', { content: [{ type: 'text', text: 'OK' }] }],
    ['anthropic', 'responses', '/v1/messages', 'messages', { content: [{ type: 'text', text: 'OK' }] }],
    ['gemini', 'chat_completions', ':generateContent', 'contents', { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }],
    ['gemini', 'responses', ':generateContent', 'contents', { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }],
    ['gemini', 'embeddings', ':embedContent', 'content', { embedding: { values: [0.25] } }],
    ['codex', 'chat_completions', '/backend-api/codex/responses', 'input', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }],
    ['codex', 'responses', '/backend-api/codex/responses', 'input', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }],
  ] as const)(
    'uses the provider-native request plan for %s %s',
    async (platform, capability, expectedPath, expectedBodyField, providerBody) => {
      const test = await fixture()
      try {
        const suffix = `${platform}-${capability}`
        await seedTarget(test, suffix, capability, platform)
        const fetch = vi.fn().mockResolvedValue(Response.json(providerBody))
        vi.stubGlobal('fetch', fetch)

        await post(test, [target(suffix, capability)], `native-${suffix}`)
        await consumeAccountSyntheticProbe(
          test.queue.messages.at(-1) as AccountSyntheticProbeEvent, test.env, NOW + 1,
        )

        expect(fetch).toHaveBeenCalledTimes(1)
        expect(new URL(fetch.mock.calls[0]![0] as string).pathname).toContain(expectedPath)
        const init = fetch.mock.calls[0]![1] as RequestInit
        expect(JSON.parse(init.body as string)).toHaveProperty(expectedBodyField)
        expect(test.raw.prepare(`
          SELECT outcome, error_code FROM account_synthetic_probe_history
        `).get()).toEqual({ outcome: 'succeeded', error_code: null })
      } finally { test.raw.close() }
    },
  )

  it.each([
    ['openai', 'chat_completions', { choices: [{ message: { content: '' } }] }],
    ['openai', 'responses', { output: [{ type: 'reasoning', summary: [] }] }],
    ['anthropic', 'responses', { content: [{ type: 'thinking', thinking: 'internal' }] }],
    ['gemini', 'responses', { candidates: [{ content: { parts: [{}] } }] }],
  ] as const)('rejects an empty %s %s success envelope', async (platform, capability, providerBody) => {
    const test = await fixture()
    try {
      const suffix = `empty-${platform}-${capability}`
      await seedTarget(test, suffix, capability, platform)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(providerBody)))
      await post(test, [target(suffix, capability)], `empty-${suffix}`)
      await consumeAccountSyntheticProbe(
        test.queue.messages.at(-1) as AccountSyntheticProbeEvent, test.env, NOW + 1,
      )
      expect(test.raw.prepare(`
        SELECT outcome, error_code FROM account_synthetic_probe_history
      `).get()).toEqual({ outcome: 'failed', error_code: 'upstream_invalid_response' })
    } finally { test.raw.close() }
  })

  it.each([
    ['openai', '{"data":[{"embedding":[1e400]}]}'],
    ['gemini', '{"embedding":{"values":[1e400]}}'],
  ] as const)('rejects non-finite %s embeddings', async (platform, rawBody) => {
    const test = await fixture()
    try {
      const suffix = `nonfinite-${platform}`
      await seedTarget(test, suffix, 'embeddings', platform)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(rawBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })))
      await post(test, [target(suffix, 'embeddings')], `nonfinite-${suffix}`)
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
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
      })))
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

  it('treats a concurrent duplicate delivery as an idempotent no-op while a live probe owns the lease', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      let releaseUpstream!: (response: Response) => void
      const upstream = new Promise<Response>((resolve) => { releaseUpstream = resolve })
      const fetch = vi.fn().mockReturnValue(upstream)
      vi.stubGlobal('fetch', fetch)
      await post(test, [target()], 'concurrent-delivery')
      const event = test.queue.messages.at(-1) as AccountSyntheticProbeEvent

      const winner = consumeAccountSyntheticProbe(event, test.env, NOW + 1)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      await consumeAccountSyntheticProbe(event, test.env, NOW + 2)
      releaseUpstream(Response.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
      }))
      await winner

      const history = await test.app.request(
        '/synthetic-probes/history?account_id=account-one',
        { headers: { authorization: `Bearer ${TOKEN}` } }, test.env,
      )
      await expect(history.json()).resolves.toMatchObject({ data: {
        items: [{ outcome: 'succeeded', account_id: 'account-one' }],
      } })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { test.raw.close() }
  })

  it('does not let an expired old consumer stale the Cron-redelivered winner', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      let releaseOld!: (response: Response) => void
      let releaseWinner!: (response: Response) => void
      const oldUpstream = new Promise<Response>((resolve) => { releaseOld = resolve })
      const winnerUpstream = new Promise<Response>((resolve) => { releaseWinner = resolve })
      const fetch = vi.fn()
        .mockReturnValueOnce(oldUpstream)
        .mockReturnValueOnce(winnerUpstream)
      vi.stubGlobal('fetch', fetch)
      await post(test, [target()], 'expired-consumer')
      const original = test.queue.messages.at(-1) as AccountSyntheticProbeEvent
      test.queue.messages = []

      const expiredConsumer = consumeAccountSyntheticProbe(original, test.env, NOW + 1)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      vi.setSystemTime(NOW + 60_000)
      await runCronProbeRecovery(test)
      const redelivered = test.queue.messages.find(isAccountSyntheticProbeEvent)
      expect(redelivered).toBeDefined()
      const winner = consumeAccountSyntheticProbe(redelivered!, test.env, NOW + 60_001)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

      releaseOld(Response.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'old' }] }],
      }))
      await expiredConsumer
      releaseWinner(Response.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'new' }] }],
      }))
      await winner

      expect(test.raw.prepare(`
        SELECT outcome, alert_transition FROM account_synthetic_probe_history
      `).all()).toEqual([{ outcome: 'succeeded', alert_transition: null }])
      expect(test.raw.prepare(`
        SELECT status FROM account_synthetic_probe_jobs
      `).get()).toEqual({ status: 'completed' })
    } finally { test.raw.close() }
  })

  it('recovers a failed Queue send from Cron and records one history and alert transition', async () => {
    const test = await fixture()
    try {
      await seedTarget(test)
      test.queue.failuresRemaining = 1
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

      const response = await post(test, [target()], 'cron-redelivery')
      expect(response.status).toBe(202)
      expect(test.queue.messages.filter(isAccountSyntheticProbeEvent)).toHaveLength(0)
      test.raw.prepare(`
        UPDATE account_synthetic_probe_monitors SET consecutive_failures = 2
         WHERE account_id = 'account-one' AND model_id = 'model-one' AND capability = 'responses'
      `).run()

      vi.setSystemTime(NOW + 60_000)
      await runCronProbeRecovery(test)
      const recovered = test.queue.messages.filter(isAccountSyntheticProbeEvent)
      expect(recovered).toHaveLength(1)
      expect(JSON.stringify(recovered[0])).not.toContain('provider-secret')
      await consumeAccountSyntheticProbe(
        recovered[0], test.env, NOW + 60_001,
      )

      expect(test.raw.prepare(`
        SELECT outcome, alert_transition FROM account_synthetic_probe_history
      `).all()).toEqual([{ outcome: 'failed', alert_transition: 'firing' }])
      expect(test.raw.prepare(`SELECT status FROM account_synthetic_alert_events`).all())
        .toEqual([{ status: 'firing' }])
    } finally { test.raw.close() }
  })

  it('requeues an expired probe lease and stops at processing and dispatch attempt bounds', async () => {
    const test = await fixture()
    try {
      await seedTarget(test, 'retryable')
      await seedTarget(test, 'processing-exhausted')
      await seedTarget(test, 'dispatch-exhausted')
      await post(test, [
        target('retryable'), target('processing-exhausted'), target('dispatch-exhausted'),
      ], 'cron-attempt-bounds')
      test.queue.messages = []
      test.raw.prepare(`
        UPDATE account_synthetic_probe_jobs
           SET status = 'probing', processing_attempts = 1,
               run_token = 'abandoned', run_lease_until_ms = ?
         WHERE account_id = 'account-retryable'
      `).run(NOW - 1)
      test.raw.prepare(`
        UPDATE account_synthetic_probe_jobs
           SET status = 'probing', processing_attempts = 5,
               run_token = 'exhausted', run_lease_until_ms = ?
         WHERE account_id = 'account-processing-exhausted'
      `).run(NOW - 1)
      test.raw.prepare(`
        UPDATE account_synthetic_probe_jobs
           SET status = 'queued', dispatch_attempts = 8, next_dispatch_at_ms = ?
         WHERE account_id = 'account-dispatch-exhausted'
      `).run(NOW - 1)

      await runCronProbeRecovery(test)
      const recovered = test.queue.messages.filter(isAccountSyntheticProbeEvent)
      expect(recovered.map((event) => event.payload.account_id))
        .toEqual(['account-retryable'])
      expect(test.raw.prepare(`
        SELECT account_id, status, processing_attempts, dispatch_attempts
          FROM account_synthetic_probe_jobs ORDER BY account_id
      `).all()).toEqual([
        { account_id: 'account-dispatch-exhausted', status: 'failed', processing_attempts: 0, dispatch_attempts: 8 },
        { account_id: 'account-processing-exhausted', status: 'failed', processing_attempts: 5, dispatch_attempts: 1 },
        { account_id: 'account-retryable', status: 'queued', processing_attempts: 1, dispatch_attempts: 2 },
      ])
    } finally { test.raw.close() }
  })
})
