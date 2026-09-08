import { Hono } from 'hono'
import { createApp } from '../../src/app'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import {
  encryptTotpSecret,
  generateTotpCode,
} from '../../src/auth/totp'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { requestIdFor } from '../../src/request-id'
import { requireAdminMutationSecurity, requireAdminSession } from '../../src/control/admin-auth'
import {
  auditAdminRequest,
  clearAdminRequestAuditLogs,
  getAdminRequestAuditLog,
  listAdminRequestAuditLogs,
} from '../../src/control/request-audit'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)
const TOKEN = 'admin-request-audit-test-token'
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'

interface Harness {
  app: Hono<{ Bindings: Env }>
  env: Env
  raw: any
}

async function harness(): Promise<Harness> {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  const now = Date.now()
  database.raw.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
     VALUES ('admin-one', 'snapshot@example.com', 'Admin', 'admin', 'active', ?, ?)`,
  ).run(now, now)
  database.raw.prepare(
    `INSERT INTO admin_sessions (id, user_id, token_hash, created_at_ms, expires_at_ms)
     VALUES ('session-one', 'admin-one', ?, ?, ?)`,
  ).run(await apiKeyDigest(`admin-session:v1:${TOKEN}`, PEPPER), now, now + 60_000)
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    DB: database.d1, ASSETS: {} as Fetcher, CONFIG_KV: { get: async () => ({}) } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.use('*', async (context, next) => {
    const requestId = requestIdFor(context.req.raw)
    await next()
    context.header('x-request-id', requestId)
  })
  app.use(
    '/api/v1/admin/*',
    requireAdminSession,
    requireAdminMutationSecurity,
    auditAdminRequest,
  )
  app.post('/api/v1/admin/widgets', (context) => context.json({ ok: true }, 201))
  app.post('/api/v1/admin/widgets/change-actor', async (context) => {
    await context.env.DB.prepare(
      "UPDATE users SET email = 'changed@example.com' WHERE id = 'admin-one'",
    ).run()
    return context.json({ ok: true })
  })
  app.post('/api/v1/admin/widgets/rejected', (context) => context.json({ ok: false }, 422))
  app.post('/api/v1/admin/widgets/failure', () => { throw new Error('handler failure') })
  app.post('/api/v1/admin/widgets/body', async (context) => context.json({ body: await context.req.json() }))
  app.get('/api/v1/admin/settings', (context) => context.json({ ok: true }))
  app.get('/api/v1/admin/public-summary', (context) => context.json({ ok: true }))
  app.options('/api/v1/admin/public-summary', (context) => context.json({ ok: true }))
  app.get('/api/v1/admin/audit-logs', listAdminRequestAuditLogs)
  app.post('/api/v1/admin/audit-logs/clear', clearAdminRequestAuditLogs)
  app.get('/api/v1/admin/audit-logs/:id', getAdminRequestAuditLog)
  app.onError(() => new Response('failed', { status: 500 }))
  return { app, env, raw: database.raw }
}

function request(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
): Request {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    body,
  })
}

function insertAudit(raw: any, input: Partial<Record<string, unknown>> = {}): number {
  const result = raw.prepare(
    `INSERT INTO admin_request_audit_logs (
       event_key, created_at_ms, actor_user_id, actor_email, actor_role,
       auth_method, credential_masked, action, method, path, route_template,
       request_id, client_ip, user_agent, status_code, latency_ms,
       request_body, extra_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.event_key ?? crypto.randomUUID(), input.created_at_ms ?? 1_000,
    input.actor_user_id ?? 'admin-one', input.actor_email ?? 'snapshot@example.com',
    input.actor_role ?? 'admin', input.auth_method ?? 'jwt', input.credential_masked ?? 'admi…oken',
    input.action ?? 'POST /api/v1/admin/widgets', input.method ?? 'POST',
    input.path ?? '/api/v1/admin/widgets', input.route_template ?? '/api/v1/admin/widgets',
    input.request_id ?? crypto.randomUUID(), input.client_ip ?? '203.0.113.1',
    input.user_agent ?? 'test-agent', input.status_code ?? 201, input.latency_ms ?? 7,
    input.request_body ?? '[not_captured]', input.extra_json ?? '{"request_body_capture":"disabled"}',
  )
  return Number(result.lastInsertRowid)
}

async function data(response: Response): Promise<any> {
  return (await response.json() as { data: unknown }).data
}

describe('admin request audit middleware', () => {
  beforeEach(() => vi.restoreAllMocks())

  it.each([
    ['/api/v1/admin/widgets', 201],
    ['/api/v1/admin/widgets/rejected', 422],
    ['/api/v1/admin/widgets/failure', 500],
  ])('records the real response for %s', async (path, expectedStatus) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const subject = await harness()
    const response = await subject.app.request(request(path, 'POST', {
      'cf-ray': 'request-ray-123',
      'cf-connecting-ip': '198.51.100.7',
      'x-forwarded-for': '192.0.2.99',
      'user-agent': 'audit-test-agent',
      'content-type': 'application/json; charset=utf-8',
    }, JSON.stringify({ outcome: expectedStatus })), undefined, subject.env)

    expect(response.status).toBe(expectedStatus)
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(requestId).not.toBe('request-ray-123')
    const row = subject.raw.prepare('SELECT * FROM admin_request_audit_logs').get()
    expect(row).toMatchObject({
      actor_user_id: 'admin-one', actor_email: 'snapshot@example.com', actor_role: 'admin',
      auth_method: 'admin_api_key', method: 'POST', path,
      route_template: path,
      request_id: requestId, client_ip: '198.51.100.7',
      user_agent: 'audit-test-agent', status_code: expectedStatus,
      request_body: `{"outcome":${expectedStatus}}`,
    })
    expect(row.credential_masked).not.toContain(TOKEN)
    expect(row.action).toContain('POST ')
    expect(row.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('captures from a clone and leaves the original JSON body readable by the handler', async () => {
    const subject = await harness()
    const response = await subject.app.request(new Request(
      'https://worker.example/api/v1/admin/widgets/body',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ label: 'kept', password: 'must-not-appear' }),
      },
    ), undefined, subject.env)
    await expect(response.json()).resolves.toEqual({
      body: { label: 'kept', password: 'must-not-appear' },
    })
    expect(subject.raw.prepare(
      'SELECT request_body FROM admin_request_audit_logs',
    ).get()).toEqual({ request_body: '{"label":"kept","password":"[REDACTED]"}' })
  })

  it('does not clone or read the body of a route that is outside the audit allowlist', async () => {
    const subject = await harness()
    const input = new Request('https://worker.example/api/v1/admin/public-summary', {
      method: 'OPTIONS',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{"password":"not-read"}',
    })
    const clone = vi.spyOn(input, 'clone')
    const response = await subject.app.request(input, undefined, subject.env)
    expect(response.status).toBe(200)
    expect(clone).not.toHaveBeenCalled()
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get())
      .toEqual({ count: 0 })
  })

  it('audits only explicitly sensitive GET routes and skips rejected clear requests', async () => {
    const subject = await harness()
    await subject.app.request(request('/api/v1/admin/settings'), undefined, subject.env)
    await subject.app.request(request('/api/v1/admin/public-summary'), undefined, subject.env)
    const clear = await subject.app.request(request('/api/v1/admin/audit-logs/clear', 'POST'), undefined, subject.env)

    expect(clear.status).toBe(403)
    expect((await clear.json() as any).error.code).toBe('audit_log_clear_user_access_required')
    const rows = subject.raw.prepare('SELECT method, path FROM admin_request_audit_logs').all()
    expect(rows).toEqual([{ method: 'GET', path: '/api/v1/admin/settings' }])
  })

  it('does not record a request rejected by authentication', async () => {
    const subject = await harness()
    const response = await subject.app.request(
      new Request('https://worker.example/api/v1/admin/widgets', { method: 'POST' }),
      undefined,
      subject.env,
    )
    expect(response.status).toBe(401)
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get()).toEqual({ count: 0 })
  })

  it('keeps the authentication-time actor snapshot when the handler changes the user', async () => {
    const subject = await harness()
    const response = await subject.app.request(
      request('/api/v1/admin/widgets/change-actor', 'POST'), undefined, subject.env,
    )
    expect(response.status).toBe(200)
    const row = subject.raw.prepare(
      'SELECT actor_email, actor_role FROM admin_request_audit_logs',
    ).get()
    expect(row).toEqual({ actor_email: 'snapshot@example.com', actor_role: 'admin' })
  })

  it('does not rewrite a successful business response when audit persistence fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const subject = await harness()
    const base = subject.env.DB
    subject.env.DB = new Proxy(base, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => sql.includes('INSERT INTO admin_request_audit_logs')
            ? { bind() { return this }, run: async () => { throw new Error('audit unavailable') } }
            : target.prepare(sql)
        }
        const value = target[property as keyof D1Database]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const response = await subject.app.request(request('/api/v1/admin/widgets', 'POST'), undefined, subject.env)
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('does not rewrite a business response when body capture fails', async () => {
    const subject = await harness()
    const input = new Request('https://worker.example/api/v1/admin/widgets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{"label":"safe"}',
    })
    vi.spyOn(input, 'clone').mockImplementation(() => {
      throw new Error('clone unavailable')
    })

    const response = await subject.app.request(input, undefined, subject.env)
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(subject.raw.prepare(
      'SELECT request_body, extra_json FROM admin_request_audit_logs',
    ).get()).toEqual({
      request_body: '[body_capture_failed]',
      extra_json: '{"request_body_capture":"failed"}',
    })
  })
})

interface ClearHarness extends Harness {
  accessToken: string
}

async function clearHarness(enableTotp = true): Promise<ClearHarness> {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  const now = Date.now()
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  database.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
     ) VALUES ('clear-admin', 'clear@example.com', 'Clear Admin', 'admin', 'active', 1, ?, ?)`,
  ).run(now, now)
  database.raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, step_up_expires_at_ms
     ) VALUES ('clear-session', 'clear-family', 'clear-admin', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now,
    now + 60_000,
    now + 120_000,
    now + 60_000,
  )
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    DB: database.d1, ASSETS: {} as Fetcher, CONFIG_KV: { get: async () => ({}) } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  if (enableTotp) {
    const encrypted = await encryptTotpSecret(env, 'clear-admin', TOTP_SECRET)
    database.raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, secret_version, nonce_b64, ciphertext_b64,
         enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('clear-admin', ?, ?, ?, ?, ?, ?)`,
    ).run(
      encrypted.secret_version,
      encrypted.nonce_b64,
      encrypted.ciphertext_b64,
      now,
      now,
      now,
    )
  }
  const app = new Hono<{ Bindings: Env }>()
  app.use('*', async (context, next) => {
    const requestId = requestIdFor(context.req.raw)
    await next()
    context.header('x-request-id', requestId)
  })
  app.use(
    '/api/v1/admin/*',
    requireAdminSession,
    requireAdminMutationSecurity,
    auditAdminRequest,
  )
  app.post('/api/v1/admin/audit-logs/clear', clearAdminRequestAuditLogs)
  return { app, env, raw: database.raw, accessToken }
}

function clearRequest(
  token: string,
  totpCode: unknown,
  key = 'audit-clear-request-0001',
): Request {
  return new Request('https://worker.example/api/v1/admin/audit-logs/clear', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
      'cf-ray': 'clear-request-ray',
      'cf-connecting-ip': '198.51.100.88',
      'user-agent': 'clear-test-agent',
    },
    body: JSON.stringify({ totp_code: totpCode }),
  })
}

describe('admin request audit clear', () => {
  it('retains the same-origin mutation boundary', async () => {
    const subject = await clearHarness()
    insertAudit(subject.raw, { event_key: 'clear-origin-old-01' })
    const code = await generateTotpCode(TOTP_SECRET)
    const request = clearRequest(subject.accessToken, code)
    request.headers.set('origin', 'https://attacker.example')
    request.headers.set('sec-fetch-site', 'cross-site')
    const response = await subject.app.request(request, undefined, subject.env)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'admin_origin_forbidden' },
    })
    expect(subject.raw.prepare('SELECT event_key FROM admin_request_audit_logs').all()).toEqual([
      { event_key: 'clear-origin-old-01' },
    ])
  })

  it('requires an idempotency key before accepting a fresh TOTP proof', async () => {
    const subject = await clearHarness()
    const code = await generateTotpCode(TOTP_SECRET)
    const request = clearRequest(subject.accessToken, code)
    request.headers.delete('idempotency-key')
    const response = await subject.app.request(request, undefined, subject.env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_idempotency_key' },
    })
    expect(subject.raw.prepare(
      "SELECT 1 FROM user_totp_verification_budgets WHERE user_id = 'clear-admin'",
    ).get()).toBeUndefined()
  })

  it('rejects a missing TOTP field with the stable invalid-proof error', async () => {
    const subject = await clearHarness()
    const response = await subject.app.request(
      clearRequest(subject.accessToken, undefined), undefined, subject.env,
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'audit_log_clear_totp_invalid' },
    })
  })

  it('uses the same typed error for missing credentials and wrong codes', async () => {
    const missing = await clearHarness(false)
    const absent = await missing.app.request(
      clearRequest(missing.accessToken, 'invalid'), undefined, missing.env,
    )
    expect(absent.status).toBe(403)
    await expect(absent.json()).resolves.toMatchObject({
      error: { code: 'audit_log_clear_totp_invalid' },
    })

    const configured = await clearHarness()
    const wrong = await configured.app.request(
      clearRequest(configured.accessToken, 'invalid'), undefined, configured.env,
    )
    expect(wrong.status).toBe(403)
    await expect(wrong.json()).resolves.toMatchObject({
      error: { code: 'audit_log_clear_totp_invalid' },
    })
    expect(configured.raw.prepare(
      "SELECT attempt_count FROM user_totp_verification_budgets WHERE user_id = 'clear-admin'",
    ).get()).toEqual({ attempt_count: 1 })
  })

  it('rate limits failed fresh-TOTP attempts', async () => {
    const subject = await clearHarness()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await subject.app.request(
        clearRequest(subject.accessToken, 'invalid', `audit-clear-failure-${attempt}`),
        undefined,
        subject.env,
      )
      expect(response.status).toBe(403)
    }
    const limited = await subject.app.request(
      clearRequest(subject.accessToken, 'invalid', 'audit-clear-failure-5'),
      undefined,
      subject.env,
    )
    expect(limited.status).toBe(429)
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: 'TOTP_TOO_MANY_ATTEMPTS' },
    })
  })

  it('atomically deletes old rows and retains one truthful clear trace', async () => {
    const subject = await clearHarness()
    insertAudit(subject.raw, { event_key: 'clear-old-event-001' })
    insertAudit(subject.raw, { event_key: 'clear-old-event-002' })
    const code = await generateTotpCode(TOTP_SECRET)
    const response = await subject.app.request(
      clearRequest(subject.accessToken, code), undefined, subject.env,
    )

    expect(response.status).toBe(200)
    await expect(data(response)).resolves.toEqual({ deleted: 2 })
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(requestId).not.toBe('clear-request-ray')
    const rows = subject.raw.prepare('SELECT * FROM admin_request_audit_logs').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_user_id: 'clear-admin',
      actor_email: 'clear@example.com',
      actor_role: 'admin',
      auth_method: 'jwt',
      action: 'POST /api/v1/admin/audit-logs/clear',
      method: 'POST',
      path: '/api/v1/admin/audit-logs/clear',
      route_template: '/api/v1/admin/audit-logs/clear',
      request_id: requestId,
      client_ip: '198.51.100.88',
      user_agent: 'clear-test-agent',
      status_code: 200,
      request_body: '[sensitive_body_not_captured]',
    })
    expect(JSON.parse(rows[0].extra_json)).toMatchObject({
      kind: 'clear_trace', deleted_rows: 2,
    })
    expect(subject.raw.prepare(
      "SELECT 1 FROM user_totp_verification_budgets WHERE user_id = 'clear-admin'",
    ).get()).toBeUndefined()
  })

  it('replays the same key after a fresh TOTP without creating a second trace', async () => {
    const subject = await clearHarness()
    insertAudit(subject.raw, { event_key: 'clear-replay-old-01' })
    const code = await generateTotpCode(TOTP_SECRET)
    const first = await subject.app.request(
      clearRequest(subject.accessToken, code, 'audit-clear-replay-key'), undefined, subject.env,
    )
    const replay = await subject.app.request(
      clearRequest(subject.accessToken, code, 'audit-clear-replay-key'), undefined, subject.env,
    )

    await expect(data(first)).resolves.toEqual({ deleted: 1 })
    await expect(data(replay)).resolves.toEqual({ deleted: 1 })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get()).toEqual({ count: 1 })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM control_idempotency').get()).toEqual({ count: 1 })
  })

  it('linearizes eight concurrent retries to one trace and one deleted count', async () => {
    const subject = await clearHarness()
    insertAudit(subject.raw, { event_key: 'clear-race-old-0001' })
    insertAudit(subject.raw, { event_key: 'clear-race-old-0002' })
    const code = await generateTotpCode(TOTP_SECRET)
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      subject.app.request(
        clearRequest(subject.accessToken, code, 'audit-clear-race-key'), undefined, subject.env,
      )))

    for (const response of responses) {
      expect(response.status).toBe(200)
      await expect(data(response)).resolves.toEqual({ deleted: 2 })
    }
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_request_audit_logs').get()).toEqual({ count: 1 })
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM control_idempotency').get()).toEqual({ count: 1 })
  })

  it('rolls back trace, deletion, and idempotency when the batch fails', async () => {
    const subject = await clearHarness()
    insertAudit(subject.raw, { event_key: 'clear-rollback-old' })
    const base = subject.env.DB
    subject.env.DB = new Proxy(base, {
      get(target, property) {
        if (property === 'batch') {
          return (statements: D1PreparedStatement[]) => target.batch([
            ...statements,
            target.prepare(
              "INSERT INTO admin_request_audit_logs (event_key) VALUES ('forced-batch-failure')",
            ),
          ])
        }
        const value = target[property as keyof D1Database]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const code = await generateTotpCode(TOTP_SECRET)
    const response = await subject.app.request(
      clearRequest(subject.accessToken, code, 'audit-clear-rollback-key'), undefined, subject.env,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'audit_log_clear_unavailable' },
    })
    expect(subject.raw.prepare('SELECT event_key FROM admin_request_audit_logs').all()).toEqual([
      { event_key: 'clear-rollback-old' },
    ])
    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM control_idempotency').get()).toEqual({ count: 0 })
    expect(subject.raw.prepare(
      "SELECT 1 FROM user_totp_verification_budgets WHERE user_id = 'clear-admin'",
    ).get()).toBeUndefined()
  })

  it('returns the stable unavailable error when both the batch and recovery read fail', async () => {
    const subject = await clearHarness()
    insertAudit(subject.raw, { event_key: 'clear-outage-old-01' })
    const base = subject.env.DB
    let batchFailed = false
    subject.env.DB = new Proxy(base, {
      get(target, property) {
        if (property === 'batch') {
          return async () => {
            batchFailed = true
            throw new Error('injected D1 outage')
          }
        }
        if (property === 'prepare') {
          return (sql: string) => {
            if (batchFailed && sql.includes('FROM control_idempotency')) {
              return {
                bind() { return this },
                first: async () => { throw new Error('injected recovery read outage') },
              }
            }
            return target.prepare(sql)
          }
        }
        const value = target[property as keyof D1Database]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const code = await generateTotpCode(TOTP_SECRET)
    const response = await subject.app.request(
      clearRequest(subject.accessToken, code, 'audit-clear-outage-key'), undefined, subject.env,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'audit_log_clear_unavailable' },
    })
    expect(subject.raw.prepare('SELECT event_key FROM admin_request_audit_logs').all()).toEqual([
      { event_key: 'clear-outage-old-01' },
    ])
  })
})

describe('admin request audit list and detail', () => {
  it('returns stable paginated rows without bodies and exposes the body only in detail', async () => {
    const subject = await harness()
    insertAudit(subject.raw, { event_key: 'event-one-0000001', created_at_ms: 2_000, request_body: '[not_captured]' })
    const secondId = insertAudit(subject.raw, {
      event_key: 'event-two-0000002', created_at_ms: 2_000,
      actor_email: 'other@example.com', request_body: '{"token":"[REDACTED]"}',
    })
    insertAudit(subject.raw, { event_key: 'event-three-00003', created_at_ms: 1_000 })

    const list = await subject.app.request(request('/api/v1/admin/audit-logs?page=1&page_size=2'), undefined, subject.env)
    expect(list.status).toBe(200)
    const body = await data(list)
    expect(body).toMatchObject({ total: 3, page: 1, page_size: 2, pages: 2 })
    expect(body.items.map((item: any) => item.id)).toEqual([secondId, secondId - 1])
    expect(body.items[0]).not.toHaveProperty('request_body')

    const detail = await subject.app.request(request(`/api/v1/admin/audit-logs/${secondId}`), undefined, subject.env)
    expect(detail.status).toBe(200)
    await expect(data(detail)).resolves.toMatchObject({
      id: secondId, request_body: '{"token":"[REDACTED]"}',
    })
    const missing = await subject.app.request(request('/api/v1/admin/audit-logs/99999'), undefined, subject.env)
    expect(missing.status).toBe(404)
  })

  it.each([
    ['start_time=1970-01-01T00%3A00%3A02.000Z', 2],
    ['end_time=1970-01-01T00%3A00%3A01.000Z', 1],
    ['actor_user_id=admin-two', 1],
    ['actor_email=SECOND', 1],
    ['auth_method=admin_api_key', 1],
    ['action=delete', 1],
    ['method=DELETE', 1],
    ['client_ip=198.51.100.9', 1],
    ['success=true', 2],
    ['success=false', 1],
    ['q=special', 1],
  ])('supports filter %s with a consistent count', async (query, expected) => {
    const subject = await harness()
    insertAudit(subject.raw, { event_key: 'filter-one-000001', created_at_ms: 1_000 })
    insertAudit(subject.raw, {
      event_key: 'filter-two-000002', created_at_ms: 2_000, actor_user_id: 'admin-two',
      actor_email: 'second@example.com', auth_method: 'admin_api_key', action: 'DELETE special record',
      method: 'DELETE', path: '/api/v1/admin/special', route_template: '/api/v1/admin/:id',
      client_ip: '198.51.100.9', status_code: 403,
    })
    insertAudit(subject.raw, { event_key: 'filter-three-0003', created_at_ms: 3_000 })

    const response = await subject.app.request(request(`/api/v1/admin/audit-logs?${query}`), undefined, subject.env)
    expect(response.status).toBe(200)
    const body = await data(response)
    expect(body.total).toBe(expected)
    expect(body.items).toHaveLength(expected)
  })

  it('combines filters and rejects malformed filters', async () => {
    const subject = await harness()
    insertAudit(subject.raw, { event_key: 'combined-one-0001', actor_email: 'match@example.com', method: 'POST' })
    insertAudit(subject.raw, { event_key: 'combined-two-0002', actor_email: 'match@example.com', method: 'DELETE' })
    const combined = await subject.app.request(request('/api/v1/admin/audit-logs?actor_email=match&method=POST'), undefined, subject.env)
    expect((await data(combined)).total).toBe(1)

    for (const query of ['page=0', 'method=TRACE', 'success=yes', 'start_time=nope', 'start_time=2026-01-02T00%3A00%3A00Z&end_time=2026-01-01T00%3A00%3A00Z']) {
      const response = await subject.app.request(request(`/api/v1/admin/audit-logs?${query}`), undefined, subject.env)
      expect(response.status).toBe(400)
    }
  })
})

describe('original audit UI contract through the production app', () => {
  it('records real operations, filters and pages exact records, reads details, and clears with TOTP', async () => {
    const subject = await clearHarness()
    const app = createApp()
    const headers = { authorization: `Bearer ${subject.accessToken}`, 'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.18', 'idempotency-key': 'actual-audit-operation' }
    try {
      const operation = await app.request('/api/v1/admin/users/clear-admin', { method: 'PUT', headers: { ...headers, 'idempotency-key': 'actual-audit-success' }, body: JSON.stringify({ display_name: 'Audited rename' }) }, subject.env)
      expect(operation.status, await operation.clone().text()).toBe(200)
      const invalid = await app.request('/api/v1/admin/users/clear-admin', {
        method: 'PUT', headers, body: JSON.stringify({ email: 'not-an-email' }),
      }, subject.env)
      expect(invalid.status).toBe(400)
      const base = '/api/v1/admin/audit-logs?actor_email=clear%40example.com&auth_method=jwt&client_ip=203.0.113.18&q=users'
      const listed = await app.request(base + '&page_size=1', { headers }, subject.env)
      expect(listed.status, await listed.clone().text()).toBe(200)
      const first = await data(listed)
      expect(first).toMatchObject({ total: 2, page: 1, page_size: 1, pages: 2 })
      expect(first.items[0]).toMatchObject({ method: 'PUT', status_code: 400 })
      const next = await data(await app.request(base + '&page_size=1&page=2', { headers }, subject.env))
      expect(next.items).toHaveLength(1)
      expect(next.items[0]).toMatchObject({ method: 'PUT', status_code: 200 })
      const failed = await data(await app.request(base + '&success=false&method=PUT&action=users', { headers }, subject.env))
      expect(failed.total).toBe(1)
      expect(failed.items[0].id).toBe(first.items[0].id)
      const detail = await data(await app.request(`/api/v1/admin/audit-logs/${first.items[0].id}`, { headers }, subject.env))
      expect(detail).toMatchObject({ id: first.items[0].id, status_code: 400, client_ip: '203.0.113.18' })
      expect(detail.request_body).toContain('not-an-email')
      expect(detail.credential_masked).not.toContain(subject.accessToken)
      const status = await app.request('/api/v1/user/totp/status', { headers }, subject.env)
      expect((await data(status)).enabled).toBe(true)
      const before = subject.raw.prepare('SELECT COUNT(*) AS n FROM admin_request_audit_logs').get().n
      const code = await generateTotpCode(TOTP_SECRET, Date.now())
      const cleared = await app.request(clearRequest(subject.accessToken, code, 'actual-audit-clear'), undefined, subject.env)
      expect(cleared.status, await cleared.clone().text()).toBe(200)
      expect((await data(cleared)).deleted).toBe(before)
      const records = subject.raw.prepare('SELECT action,extra_json FROM admin_request_audit_logs').all()
      expect(records).toHaveLength(1)
      expect(records[0].action).toBe('POST /api/v1/admin/audit-logs/clear')
      expect(JSON.parse(records[0].extra_json).deleted_rows).toBe(before)
      const replay = await app.request(clearRequest(subject.accessToken, code, 'actual-audit-clear'), undefined, subject.env)
      expect((await data(replay)).deleted).toBe(before)
    } finally { subject.raw.close() }
  })
})
