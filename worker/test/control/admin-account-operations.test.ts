import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import {
  bulkUpdateAdminAccounts,
  queueAdminAccountHealthProbes,
  resetAdminAccountStatuses,
} from '../../src/control/account-operations'
import { consumeAccountHealthProbe, type AccountHealthProbeEvent } from '../../src/control/account-lifecycle'
import type { Env, PlatformEvent } from '../../src/env'
import { credentialAad } from '../../src/gateway/repository'
import { apiKeyDigest, encryptCredential, decryptCredential } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.UTC(2026, 8, 6, 6, 0, 0)
const TOKEN = 'account-operations-admin-session'
const PEPPER = 'p'.repeat(32)

class QueueCapture {
  messages: PlatformEvent[] = []
  async send(value: PlatformEvent): Promise<void> { this.messages.push(structuredClone(value)) }
}

interface Fixture { raw: any; env: Env; queue: QueueCapture; app: Hono<{ Bindings: Env }> }

function countD1Queries(test: Fixture): { readonly count: number } {
  const original = test.env.DB
  const originals = new WeakMap<object, D1PreparedStatement>()
  let count = 0
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: async <T>(columnName?: string) => {
        count += 1
        return columnName === undefined
          ? await statement.first<T>()
          : await statement.first<T>(columnName)
      },
      all: async <T>() => {
        count += 1
        return await statement.all<T>()
      },
      run: async () => {
        count += 1
        return await statement.run()
      },
      raw: async <T>(options?: { columnNames?: boolean }) => {
        count += 1
        return await (statement.raw as (value?: unknown) => Promise<T>)(options)
      },
    } as D1PreparedStatement
    ;(wrapped as unknown as { sql: string }).sql = (statement as unknown as { sql: string }).sql
    originals.set(wrapped, statement)
    return wrapped
  }
  test.env.DB = {
    prepare: (sql: string) => wrap(original.prepare(sql)),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      count += statements.length
      return await original.batch<T>(statements.map((statement) => originals.get(statement) ?? statement))
    },
  } as D1Database
  return { get count() { return count } }
}

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`
    INSERT INTO users (id, email, display_name, role, status, created_at_ms, updated_at_ms)
    VALUES ('account-admin', 'account-admin@example.test', 'Admin', 'admin', 'active', ${NOW}, ${NOW});
  `)
  raw.prepare(`
    INSERT INTO admin_sessions (id, user_id, token_hash, created_at_ms, expires_at_ms)
    VALUES ('account-session', 'account-admin', ?, ?, ?)
  `).run(await apiKeyDigest(`admin-session:v1:${TOKEN}`, PEPPER), NOW, NOW + 60_000)
  const queue = new QueueCapture()
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    ASSETS: {} as Fetcher, DB: d1, CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: queue as unknown as Queue<PlatformEvent>,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.post('/accounts/bulk-update', bulkUpdateAdminAccounts)
  app.post('/accounts/health-probes', queueAdminAccountHealthProbes)
  app.post('/accounts/batch-clear-error', resetAdminAccountStatuses)
  return { raw, env, queue, app }
}

function seedAccount(test: Fixture, id: string, controlVersion: number, enabled = true): void {
  test.raw.prepare(`
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
      config_version, control_version
    ) VALUES (?, 'openai', ?, ?, ?, 4, ?, ?, 'openai',
      'https://upstream.example.test/v1', 'bearer', 1, ?)
  `).run(id, id, `secret-${id}`, enabled ? 1 : 0, NOW, NOW, controlVersion)
}

async function request(test: Fixture, path: string, body: unknown, key: string): Promise<Response> {
  return await test.app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  }, test.env)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

describe('admin account operations', () => {
  it('bulk edits original fields with per-account CAS, encrypted credential merges and atomic replay receipts', async () => {
    const test = await fixture()
    try {
      test.env.CREDENTIALS_MASTER_KEY = 'm'.repeat(32)
      for (const id of ['edit-a', 'edit-b']) {
        seedAccount(test, id, 2)
        const storedCredential = { api_key: 'keep-private', old_field: 'keep' }
        const secret = await encryptCredential(storedCredential, test.env.CREDENTIALS_MASTER_KEY, credentialAad('test', id, `secret-${id}`, 1))
        test.raw.prepare(`INSERT INTO account_secrets (id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms) VALUES (?, ?, 1, ?, ?, ?, ?)`)
          .run(`secret-${id}`, id, secret.nonce_b64, secret.ciphertext_b64, NOW, NOW)
      }
      test.raw.exec(`UPDATE accounts SET ui_config_json = '{"extra":{"retained":true,"replace":"old"}}'`)
      const groupIds = Array.from({ length: 100 }, (_, index) => `bulk-group-${index}`)
      for (const id of groupIds) test.raw.prepare(`INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, 'openai', 1, ?, ?)`).run(id, id, NOW, NOW)
      const queries = countD1Queries(test)
      const body = { accounts: [{ id: 'edit-a', expected_control_version: 2 }, { id: 'edit-b', expected_control_version: 1 }],
        updates: { group_ids: groupIds, concurrency: 7, priority: 80, rate_multiplier: 1.25, credentials: { model_mapping: { alias: 'target' } }, extra: { replace: 'new' } } }
      const response = await request(test, '/accounts/bulk-update', body, 'general-edit-one')
      expect(response.status).toBe(200)
      const value = await response.json() as any
      expect(value.data).toMatchObject({ success: 1, failed: 1, success_ids: ['edit-a'], failed_ids: ['edit-b'] })
      expect(value.data.results[1].code).toBe('account_version_conflict')
      expect(queries.count).toBeLessThan(50)
      expect(test.raw.prepare("SELECT count(*) total FROM account_groups WHERE account_id='edit-a'").get().total).toBe(100)

      const state = test.raw.prepare("SELECT * FROM accounts WHERE id='edit-a'").get()
      expect(state).toMatchObject({ max_concurrency: 7, control_version: 3, billing_rate_multiplier_ppm: 1250000 })
      expect(JSON.parse(state.ui_config_json)).toMatchObject({ priority: 80, extra: { retained: true, replace: 'new' } })
      const secret = test.raw.prepare("SELECT * FROM account_secrets WHERE account_id='edit-a'").get()
      expect(await decryptCredential(secret.nonce_b64, secret.ciphertext_b64, test.env.CREDENTIALS_MASTER_KEY, credentialAad('test', 'edit-a', secret.id, secret.key_version)))
        .toMatchObject({ api_key: 'keep-private', old_field: 'keep', model_mapping: { alias: 'target' } })
      expect(await (await request(test, '/accounts/bulk-update', body, 'general-edit-one')).json()).toEqual(value)
      expect(test.raw.prepare("SELECT key_version FROM account_secrets WHERE account_id='edit-a'").get().key_version).toBe(2)
      const conflict = await (await request(test, '/accounts/bulk-update', { ...body, updates: { concurrency: 9 } }, 'general-edit-one')).json() as any
      expect(conflict.data.results[0]).toMatchObject({ success: false, code: 'idempotency_conflict' })
      expect(JSON.stringify(value)).not.toContain('keep-private')
      const priorityOnly = await request(test, '/accounts/bulk-update', {
        accounts: [{ id: 'edit-a', expected_control_version: 3 }], updates: { priority: 12 },
      }, 'general-edit-priority-only')
      expect(await priorityOnly.json()).toMatchObject({ data: { success: 1, failed: 0 } })
      expect(test.raw.prepare("SELECT min(priority) low, max(priority) high, min(control_version) version FROM account_groups WHERE account_id='edit-a'").get())
        .toEqual({ low: 12, high: 12, version: 1 })

    } finally { test.raw.close() }
  })

  it('bulk scheduling preserves disabled state and health, audits once, and rejects stale targets', async () => {
    const test = await fixture()
    try {
      seedAccount(test, 'account-a', 2, false)
      seedAccount(test, 'account-b', 4)
      test.raw.exec("UPDATE accounts SET health_status = 'unhealthy', last_health_error = 'preserve me'")
      const body = { accounts: [
        { id: 'account-a', expected_control_version: 2 },
        { id: 'account-b', expected_control_version: 3 },
      ], schedulable: false }
      const response = await request(test, '/accounts/bulk-update', body, 'bulk-scheduling-1')
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload).toMatchObject({ data: { success: 1, failed: 1, results: [
        { account_id: 'account-a', success: true, schedulable: false, control_version: 3 },
        { account_id: 'account-b', success: false, error: { code: 'account_version_conflict' } },
      ] } })
      expect(test.raw.prepare(`SELECT enabled, health_status, last_health_error,
        json_extract(ui_config_json, '$.schedulable') schedulable, control_version FROM accounts WHERE id = 'account-a'`).get())
        .toEqual({ enabled: 0, health_status: 'unhealthy', last_health_error: 'preserve me', schedulable: 0, control_version: 3 })
      expect(await (await request(test, '/accounts/bulk-update', body, 'bulk-scheduling-1')).json()).toEqual(payload)
      expect(test.raw.prepare('SELECT action, metadata_json FROM admin_account_audit_events').all())
        .toEqual([{ action: 'account.schedulable', metadata_json: '{"schedulable":false}' }])
      expect((await request(test, '/accounts/bulk-update', { ...body, enabled: true }, 'ambiguous-scheduling')).status).toBe(400)
    } finally { test.raw.close() }
  })

  it('pauses and resumes batch scheduling without changing enabled or health', async () => {
    const test = await fixture()
    try {
      seedAccount(test,'schedule-only',2)
      for (const [schedulable,version] of [[false,2],[true,3]] as const) {
        const body = { accounts:[{id:'schedule-only',expected_control_version:version}],schedulable }
        const response = await request(test,'/accounts/bulk-update',body,`schedule-${version}`)
        expect(response.status).toBe(200)
        const payload = await response.json()
        expect(payload).toMatchObject({data:{success:1,failed:0,results:[{account_id:'schedule-only',success:true,schedulable,control_version:version+1}]}})
        expect(test.raw.prepare("SELECT enabled,control_version,json_extract(ui_config_json,'$.schedulable') AS schedulable FROM accounts WHERE id='schedule-only'").get()).toEqual({enabled:1,control_version:version+1,schedulable:schedulable?1:0})
        expect(await (await request(test,'/accounts/bulk-update',body,`schedule-${version}`)).json()).toEqual(payload)
      }
    } finally {test.raw.close();vi.useRealTimers()}
  })

  it('keeps the real max-25 health route within budget through user auth, RBAC, and step-up', async () => {
    const test = await fixture()
    try {
      const accessToken = createOpaqueToken('access')
      const refreshToken = createOpaqueToken('refresh')
      test.raw.prepare(
        `INSERT INTO user_sessions (
           id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
           created_at_ms, access_expires_at_ms, refresh_expires_at_ms, step_up_expires_at_ms
         ) VALUES ('budget-user-session', 'budget-family', 'account-admin', 1, ?, ?, ?, ?, ?, ?)`,
      ).run(
        await tokenDigest(accessToken, PEPPER, 'access'),
        await tokenDigest(refreshToken, PEPPER, 'refresh'),
        NOW,
        NOW + 60_000,
        NOW + 120_000,
        NOW + 60_000,
      )
      test.raw.prepare(
        `INSERT INTO user_totp_credentials (
           user_id, nonce_b64, ciphertext_b64, enabled_at_ms, created_at_ms, updated_at_ms
         ) VALUES ('account-admin', ?, ?, ?, ?, ?)`,
      ).run('A'.repeat(16), 'B'.repeat(24), NOW, NOW, NOW)
      test.raw.prepare(
        `UPDATE system_settings SET step_up_enabled = 1 WHERE id = 'global'`,
      ).run()
      const accounts = Array.from({ length: 25 }, (_, index) => {
        const id = `production-budget-${index}`
        seedAccount(test, id, 0)
        return { id, expected_control_version: 0 }
      })
      const queries = countD1Queries(test)

      const response = await createApp().request('/api/v1/admin/accounts/health-probes', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          origin: 'http://localhost',
          'content-type': 'application/json',
          'idempotency-key': 'production-max-health-budget',
        },
        body: JSON.stringify({ accounts }),
      }, test.env)

      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toMatchObject({ data: {
        total: 25, queued: 25, failed: 0,
      } })
      expect(test.queue.messages).toHaveLength(25)
      expect(queries.count).toBeLessThanOrEqual(50)
      // Exact count includes the one-statement request-audit snapshot and keeps
      // this boundary sensitive while the platform ceiling remains 50.
      expect(queries.count).toBe(24)
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })

  it.each([
    ['/accounts/bulk-update', { enabled: false }, 'status'],
    ['/accounts/health-probes', {}, 'probe'],
  ] as const)('keeps a 25-account %s invocation within the Free D1 query budget', async (
    path, extraBody, operation,
  ) => {
    const test = await fixture()
    try {
      const accounts = Array.from({ length: 25 }, (_, index) => {
        const id = `budget-${operation}-${index}`
        seedAccount(test, id, 0)
        return { id, expected_control_version: 0 }
      })
      const queries = countD1Queries(test)
      const counted = test.env.DB
      let guardAttempts = 0
      test.env.DB = {
        prepare: counted.prepare.bind(counted),
        batch: async <T>(statements: D1PreparedStatement[]) => {
          const firstSql = (statements[0] as unknown as { sql?: string })?.sql ?? ''
          if (firstSql.includes('admin_account_operation_guards')) {
            guardAttempts += 1
            const racedAccount = guardAttempts <= 3 ? accounts[0] : accounts[13]
            if ([1, 2, 4, 5].includes(guardAttempts)) {
              test.raw.prepare(
                `UPDATE accounts SET config_version = config_version + 1 WHERE id = ?`,
              ).run(racedAccount.id)
            }
          }
          return await counted.batch<T>(statements)
        },
      } as D1Database

      const response = await request(test, path, { accounts, ...extraBody }, `budget-${operation}`)

      expect(response.status).toBe(path.endsWith('health-probes') ? 202 : 200)
      await expect(response.json()).resolves.toMatchObject({ data: {
        total: 25,
        failed: 0,
        [path.endsWith('health-probes') ? 'queued' : 'success']: 25,
      } })
      expect(guardAttempts).toBe(6)
      expect(queries.count).toBeLessThanOrEqual(50)
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })

  it('returns stable per-account CAS results and replays status changes idempotently', async () => {
    const test = await fixture()
    try {
      seedAccount(test, 'account-a', 2)
      seedAccount(test, 'account-b', 4)
      const body = {
        accounts: [
          { id: 'account-a', expected_control_version: 2 },
          { id: 'account-b', expected_control_version: 3 },
        ],
        enabled: false,
      }

      const response = await request(test, '/accounts/bulk-update', body, 'account-bulk-disable-1')
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload).toMatchObject({ data: {
        total: 2, success: 1, failed: 1,
        success_ids: ['account-a'], failed_ids: ['account-b'],
        results: [
          { account_id: 'account-a', success: true, control_version: 3, enabled: false },
          { account_id: 'account-b', success: false, error: { code: 'account_version_conflict' } },
        ],
      } })
      expect(test.raw.prepare(
        `SELECT enabled, config_version, control_version FROM accounts WHERE id = 'account-a'`,
      ).get()).toEqual({ enabled: 0, config_version: 2, control_version: 3 })
      expect(test.raw.prepare(
        `SELECT enabled, config_version, control_version FROM accounts WHERE id = 'account-b'`,
      ).get()).toEqual({ enabled: 1, config_version: 1, control_version: 4 })

      const replay = await request(test, '/accounts/bulk-update', body, 'account-bulk-disable-1')
      expect(await replay.json()).toEqual(payload)
      expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM admin_account_audit_events`).get())
        .toEqual({ total: 1 })
      expect(test.raw.prepare(
        `SELECT enabled, config_version, control_version FROM accounts WHERE id = 'account-a'`,
      ).get()).toEqual({ enabled: 0, config_version: 2, control_version: 3 })
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })

  it('atomically resets recoverable state while preserving a manual disable', async () => {
    const test = await fixture()
    try {
      seedAccount(test, 'account-enabled', 2)
      seedAccount(test, 'account-disabled', 3, false)
      test.raw.exec(`
        UPDATE accounts SET health_status = 'unhealthy', last_checked_at_ms = ${NOW - 1_000},
          last_latency_ms = 42, last_health_error = 'rate limited', consecutive_health_failures = 4,
          health_probe_generation = 8, health_probe_lease_until_ms = ${NOW + 60_000},
          next_health_probe_at_ms = ${NOW + 60_000}, recovery_revision = 2,
          ui_config_json = json_set(ui_config_json, '$.rate_limit_reset_at', '2099-01-01T00:00:00Z', '$.extra.keep', 'value')
        WHERE id IN ('account-enabled', 'account-disabled');
        INSERT INTO account_health_probes (
          id, account_id, generation, config_version, credential_ref, status,
          next_dispatch_at_ms, created_at_ms, updated_at_ms
        ) VALUES ('account-enabled:health:8', 'account-enabled', 8, 1,
          'secret-account-enabled', 'queued', ${NOW}, ${NOW}, ${NOW});
      `)
      const beforeGateway = test.raw.prepare(
        `SELECT revision FROM gateway_config_revision WHERE singleton = 1`,
      ).get() as { revision: number }
      const body = { accounts: [
        { id: 'account-enabled', expected_control_version: 2 },
        { id: 'account-disabled', expected_control_version: 3 },
      ] }
      const response = await request(test, '/accounts/batch-clear-error', body, 'account-status-reset-1')
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload).toMatchObject({ data: {
        total: 2, success: 2, failed: 0,
        success_ids: ['account-enabled', 'account-disabled'],
      } })
      expect(test.raw.prepare(`
        SELECT enabled, config_version, control_version, health_status, last_checked_at_ms,
               last_latency_ms, last_health_error, consecutive_health_failures,
               health_probe_generation, health_probe_lease_until_ms, next_health_probe_at_ms,
               recovery_revision
          FROM accounts WHERE id = 'account-disabled'
      `).get()).toEqual({
        enabled: 0, config_version: 2, control_version: 4, health_status: 'unknown',
        last_checked_at_ms: null, last_latency_ms: null, last_health_error: null,
        consecutive_health_failures: 0, health_probe_generation: 9,
        health_probe_lease_until_ms: null, next_health_probe_at_ms: NOW, recovery_revision: 3,
      })
      expect(JSON.parse((test.raw.prepare(`SELECT ui_config_json FROM accounts WHERE id = 'account-disabled'`).get() as any).ui_config_json)).toMatchObject({ extra: { keep: 'value' } })
      expect(JSON.parse((test.raw.prepare(`SELECT ui_config_json FROM accounts WHERE id = 'account-disabled'`).get() as any).ui_config_json)).not.toHaveProperty('rate_limit_reset_at')
      expect(test.raw.prepare(`SELECT status FROM account_health_probes WHERE id = 'account-enabled:health:8'`).get())
        .toEqual({ status: 'stale' })
      expect((test.raw.prepare(`SELECT revision FROM gateway_config_revision WHERE singleton = 1`).get() as { revision: number }).revision)
        .toBeGreaterThan(beforeGateway.revision)

      const replay = await request(test, '/accounts/batch-clear-error', body, 'account-status-reset-1')
      expect(await replay.json()).toEqual(payload)
      expect(test.raw.prepare(`SELECT recovery_revision FROM accounts WHERE id = 'account-disabled'`).get())
        .toEqual({ recovery_revision: 3 })
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })

  it('prevalidates every reset target and rolls all account writes back on failure', async () => {
    const test = await fixture()
    try {
      seedAccount(test, 'account-a', 1)
      seedAccount(test, 'account-b', 2)
      const original = test.raw.prepare(
        `SELECT config_version, control_version, recovery_revision FROM accounts WHERE id = 'account-a'`,
      ).get()
      const missing = await request(test, '/accounts/batch-clear-error', { accounts: [
        { id: 'account-a', expected_control_version: 1 },
        { id: 'absent', expected_control_version: 0 },
      ] }, 'account-status-reset-missing')
      expect(missing.status).toBe(404)
      expect(test.raw.prepare(`SELECT config_version, control_version, recovery_revision FROM accounts WHERE id = 'account-a'`).get())
        .toEqual(original)

      const stale = await request(test, '/accounts/batch-clear-error', { accounts: [
        { id: 'account-a', expected_control_version: 0 },
        { id: 'account-b', expected_control_version: 2 },
      ] }, 'account-status-reset-stale')
      expect(stale.status).toBe(409)
      expect(test.raw.prepare(`SELECT config_version, control_version, recovery_revision FROM accounts WHERE id = 'account-b'`).get())
        .toEqual({ config_version: 1, control_version: 2, recovery_revision: 0 })

      test.raw.exec(`CREATE TRIGGER abort_account_status_reset BEFORE UPDATE ON accounts
        WHEN NEW.id = 'account-b' BEGIN SELECT RAISE(ABORT, 'forced reset rollback'); END;`)
      const failed = await request(test, '/accounts/batch-clear-error', { accounts: [
        { id: 'account-a', expected_control_version: 1 },
        { id: 'account-b', expected_control_version: 2 },
      ] }, 'account-status-reset-rollback')
      expect(failed.status).toBe(500)
      expect(test.raw.prepare(`SELECT config_version, control_version, recovery_revision FROM accounts WHERE id = 'account-a'`).get())
        .toEqual(original)
      expect(test.raw.prepare(`SELECT COUNT(*) AS total FROM admin_account_audit_events`).get()).toEqual({ total: 0 })
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })

  it('does not partially reset when a selected account wins the CAS race', async () => {
    const test = await fixture()
    try {
      seedAccount(test, 'account-a', 1)
      seedAccount(test, 'account-b', 2)
      const original = test.env.DB
      let injected = false
      test.env.DB = {
        prepare: original.prepare.bind(original),
        batch: async <T>(statements: D1PreparedStatement[]) => {
          if (!injected && (statements[0] as unknown as { sql?: string }).sql?.includes('admin_account_operation_guards')) {
            injected = true
            test.raw.prepare(`UPDATE accounts SET control_version = 3 WHERE id = 'account-b'`).run()
          }
          return await original.batch<T>(statements)
        },
      } as D1Database
      const response = await request(test, '/accounts/batch-clear-error', { accounts: [
        { id: 'account-a', expected_control_version: 1 },
        { id: 'account-b', expected_control_version: 2 },
      ] }, 'account-status-reset-race')
      expect(response.status).toBe(409)
      expect(test.raw.prepare(`SELECT control_version, recovery_revision FROM accounts WHERE id = 'account-a'`).get())
        .toEqual({ control_version: 1, recovery_revision: 0 })
      expect(test.raw.prepare(`SELECT control_version, recovery_revision FROM accounts WHERE id = 'account-b'`).get())
        .toEqual({ control_version: 3, recovery_revision: 0 })
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })

  it('rolls the first attempt back when an account wins the race before the transaction guard', async () => {
    const test = await fixture()
    try {
      seedAccount(test, 'account-a', 2)
      seedAccount(test, 'account-b', 4)
      const original = test.env.DB
      let injected = false
      test.env.DB = {
        prepare: original.prepare.bind(original),
        batch: async (statements: Array<{ sql?: string }>) => {
          if (!injected && statements[0]?.sql?.includes('admin_account_operation_guards')) {
            injected = true
            test.raw.prepare(
              `UPDATE accounts SET control_version = 5, config_version = 2 WHERE id = 'account-b'`,
            ).run()
          }
          return original.batch(statements as unknown as D1PreparedStatement[])
        },
      } as unknown as D1Database

      const response = await request(test, '/accounts/bulk-update', {
        accounts: [
          { id: 'account-a', expected_control_version: 2 },
          { id: 'account-b', expected_control_version: 4 },
        ],
        enabled: false,
      }, 'account-bulk-race-1')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ data: {
        success_ids: ['account-a'], failed_ids: ['account-b'],
        results: [
          { account_id: 'account-a', success: true, control_version: 3 },
          { account_id: 'account-b', success: false, error: { code: 'account_version_conflict' } },
        ],
      } })
      expect(test.raw.prepare(
        `SELECT enabled, config_version, control_version FROM accounts WHERE id = 'account-a'`,
      ).get()).toEqual({ enabled: 0, config_version: 2, control_version: 3 })
      expect(test.raw.prepare(
        `SELECT COUNT(*) AS total FROM admin_account_audit_events`,
      ).get()).toEqual({ total: 1 })
      expect(test.raw.prepare(
        `SELECT target_count FROM admin_account_operation_guards`,
      ).get()).toEqual({ target_count: 1 })
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })

  it.each(['enabled', 'later-accounts'] as const)(
    'rejects a changed %s request after the first shard committed but the parent did not',
    async (change) => {
      const test = await fixture()
      try {
        const originalAccounts = Array.from({ length: 14 }, (_, index) => {
          const id = `partial-parent-${index}`
          seedAccount(test, id, 0)
          return { id, expected_control_version: 0 }
        })
        seedAccount(test, 'partial-parent-replacement', 0)
        const original = test.env.DB
        let guardBatches = 0
        test.env.DB = {
          prepare: original.prepare.bind(original),
          batch: async <T>(statements: D1PreparedStatement[]) => {
            const firstSql = (statements[0] as unknown as { sql?: string })?.sql ?? ''
            if (firstSql.includes('admin_account_operation_guards')) {
              guardBatches += 1
              if (guardBatches === 2) throw new Error('second shard unavailable')
            }
            return await original.batch<T>(statements)
          },
        } as D1Database
        const key = `partial-parent-${change}`

        const interrupted = await request(test, '/accounts/bulk-update', {
          accounts: originalAccounts,
          enabled: false,
        }, key)
        expect(interrupted.status).toBe(500)
        expect(test.raw.prepare(
          `SELECT COUNT(*) AS total FROM accounts WHERE id LIKE 'partial-parent-%' AND enabled = 0`,
        ).get()).toEqual({ total: 13 })

        test.env.DB = original
        const changedAccounts = change === 'later-accounts'
          ? [...originalAccounts.slice(0, 13), {
              id: 'partial-parent-replacement', expected_control_version: 0,
            }]
          : originalAccounts
        const changed = await request(test, '/accounts/bulk-update', {
          accounts: changedAccounts,
          enabled: change === 'enabled',
        }, key)

        expect(changed.status).toBe(409)
        await expect(changed.json()).resolves.toMatchObject({
          error: { code: 'idempotency_conflict' },
        })
        expect(test.raw.prepare(
          `SELECT COUNT(*) AS total FROM admin_account_audit_events`,
        ).get()).toEqual({ total: 13 })
      } finally {
        vi.useRealTimers()
        test.raw.close()
      }
    },
  )

  it('queues credential-free versioned probe jobs without fetching upstream', async () => {
    const test = await fixture()
    try {
      seedAccount(test, 'account-a', 2)
      seedAccount(test, 'account-disabled', 1, false)
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const body = { accounts: [
        { id: 'account-a', expected_control_version: 2 },
        { id: 'account-disabled', expected_control_version: 1 },
      ] }

      const response = await request(test, '/accounts/health-probes', body, 'account-health-batch-1')
      expect(response.status).toBe(202)
      const payload = await response.json()
      expect(payload).toMatchObject({ data: {
        total: 2, queued: 1, failed: 1,
        queued_ids: ['account-a'], failed_ids: ['account-disabled'],
        results: [
          { account_id: 'account-a', success: true, job_id: 'account-a:health:1', generation: 1 },
          { account_id: 'account-disabled', success: false, error: { code: 'account_disabled' } },
        ],
      } })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(test.raw.prepare(`
        SELECT account_id, generation, config_version, credential_ref, status
        FROM account_health_probes WHERE id = 'account-a:health:1'
      `).get()).toEqual({
        account_id: 'account-a', generation: 1, config_version: 1,
        credential_ref: 'secret-account-a', status: 'queued',
      })
      expect(JSON.stringify(test.queue.messages)).not.toContain('secret-account-a')
      expect(test.queue.messages).toHaveLength(1)

      const replay = await request(test, '/accounts/health-probes', body, 'account-health-batch-1')
      expect(await replay.json()).toEqual(payload)
      expect(test.queue.messages).toHaveLength(1)

      test.raw.prepare(
        `UPDATE accounts SET config_version = 2, control_version = 3 WHERE id = 'account-a'`,
      ).run()
      await consumeAccountHealthProbe(
        test.queue.messages[0] as AccountHealthProbeEvent, test.env, NOW,
      )
      expect(fetchMock).not.toHaveBeenCalled()
      expect(test.raw.prepare(
        `SELECT status FROM account_health_probes WHERE id = 'account-a:health:1'`,
      ).get()).toEqual({ status: 'stale' })
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      test.raw.close()
    }
  })

  it('rejects oversized bodies, oversized batches, duplicates, and unversioned entries', async () => {
    const test = await fixture()
    try {
      const tooMany = Array.from({ length: 51 }, (_, index) => ({
        id: `account-${index}`, expected_control_version: 0,
      }))
      const cases = [
        { body: { accounts: tooMany, enabled: true }, code: 'invalid_accounts' },
        { body: { accounts: [{ id: 'same', expected_control_version: 0 }, { id: 'same', expected_control_version: 0 }], enabled: true }, code: 'duplicate_account_id' },
        { body: { accounts: [{ id: 'account-a' }], enabled: true }, code: 'invalid_expected_control_version' },
      ]
      for (const [index, item] of cases.entries()) {
        const response = await request(test, '/accounts/bulk-update', item.body, `invalid-account-op-${index}`)
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({ error: { code: item.code } })
      }

      const huge = await request(test, '/accounts/bulk-update', {
        accounts: [{ id: 'account-a', expected_control_version: 0 }],
        enabled: true,
        padding: 'x'.repeat(40_000),
      }, 'oversized-account-operation')
      expect(huge.status).toBe(413)
      await expect(huge.json()).resolves.toMatchObject({ error: { code: 'request_too_large' } })
    } finally {
      vi.useRealTimers()
      test.raw.close()
    }
  })
})
