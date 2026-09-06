import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { requestIdFor } from '../../src/request-id'
import { requireAdminSession } from '../../src/control/admin-auth'
import {
  auditAdminRequest,
  clearAdminRequestAuditLogs,
  getAdminRequestAuditLog,
  listAdminRequestAuditLogs,
} from '../../src/control/request-audit'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)
const TOKEN = 'admin-request-audit-test-token'

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
    DB: database.d1, ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.use('*', async (context, next) => {
    const requestId = requestIdFor(context.req.raw)
    await next()
    context.header('x-request-id', requestId)
  })
  app.use('/api/v1/admin/*', requireAdminSession, auditAdminRequest)
  app.post('/api/v1/admin/widgets', (context) => context.json({ ok: true }, 201))
  app.post('/api/v1/admin/widgets/change-actor', async (context) => {
    await context.env.DB.prepare(
      "UPDATE users SET email = 'changed@example.com' WHERE id = 'admin-one'",
    ).run()
    return context.json({ ok: true })
  })
  app.post('/api/v1/admin/widgets/rejected', (context) => context.json({ ok: false }, 422))
  app.post('/api/v1/admin/widgets/failure', () => { throw new Error('handler failure') })
  app.get('/api/v1/admin/settings', (context) => context.json({ ok: true }))
  app.get('/api/v1/admin/public-summary', (context) => context.json({ ok: true }))
  app.get('/api/v1/admin/audit-logs', listAdminRequestAuditLogs)
  app.post('/api/v1/admin/audit-logs/clear', clearAdminRequestAuditLogs)
  app.get('/api/v1/admin/audit-logs/:id', getAdminRequestAuditLog)
  app.onError(() => new Response('failed', { status: 500 }))
  return { app, env, raw: database.raw }
}

function request(path: string, method = 'GET', headers: Record<string, string> = {}): Request {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
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
    }), undefined, subject.env)

    expect(response.status).toBe(expectedStatus)
    expect(response.headers.get('x-request-id')).toBe('request-ray-123')
    const row = subject.raw.prepare('SELECT * FROM admin_request_audit_logs').get()
    expect(row).toMatchObject({
      actor_user_id: 'admin-one', actor_email: 'snapshot@example.com', actor_role: 'admin',
      auth_method: 'admin_api_key', method: 'POST', path,
      route_template: path,
      request_id: 'request-ray-123', client_ip: '198.51.100.7',
      user_agent: 'audit-test-agent', status_code: expectedStatus,
      request_body: '[not_captured]',
    })
    expect(row.credential_masked).not.toContain(TOKEN)
    expect(row.action).toContain('POST ')
    expect(row.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('audits only explicitly sensitive GET routes and skips clear', async () => {
    const subject = await harness()
    await subject.app.request(request('/api/v1/admin/settings'), undefined, subject.env)
    await subject.app.request(request('/api/v1/admin/public-summary'), undefined, subject.env)
    const clear = await subject.app.request(request('/api/v1/admin/audit-logs/clear', 'POST'), undefined, subject.env)

    expect(clear.status).toBe(501)
    expect((await clear.json() as any).error.code).toBe('audit_log_clear_not_migrated')
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
})

describe('admin request audit list and detail', () => {
  it('returns stable paginated rows without bodies and exposes the body only in detail', async () => {
    const subject = await harness()
    insertAudit(subject.raw, { event_key: 'event-one-0000001', created_at_ms: 2_000, request_body: '[not_captured]' })
    const secondId = insertAudit(subject.raw, { event_key: 'event-two-0000002', created_at_ms: 2_000, actor_email: 'other@example.com' })
    insertAudit(subject.raw, { event_key: 'event-three-00003', created_at_ms: 1_000 })

    const list = await subject.app.request(request('/api/v1/admin/audit-logs?page=1&page_size=2'), undefined, subject.env)
    expect(list.status).toBe(200)
    const body = await data(list)
    expect(body).toMatchObject({ total: 3, page: 1, page_size: 2, pages: 2 })
    expect(body.items.map((item: any) => item.id)).toEqual([secondId, secondId - 1])
    expect(body.items[0]).not.toHaveProperty('request_body')

    const detail = await subject.app.request(request(`/api/v1/admin/audit-logs/${secondId}`), undefined, subject.env)
    expect(detail.status).toBe(200)
    await expect(data(detail)).resolves.toMatchObject({ id: secondId, request_body: '[not_captured]' })
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
