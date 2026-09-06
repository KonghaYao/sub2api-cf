import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)
const TOKEN = 'financial-backfill-admin-session-0001'

interface ExportEntry {
  ledger_sequence: number
  schema_version: 1
  mutation_key: string
  mutation_id: string
  entry_type: 'opening_balance' | 'balance_adjustment' | 'enabled_change' | 'settlement'
  user_id: string
  request_id: string | null
  amount_delta_micros: number
  balance_after_micros: number
  enabled_after: boolean | null
  created_at_ms: number
}

class LedgerExportNamespace {
  calls = 0
  failAtCall: number | null = null

  constructor(
    readonly entries: ExportEntry[],
    readonly stateVersion: number,
    readonly balanceMicros: number,
    readonly spendDebtMicros = 0,
  ) {}

  idFromName(name: string): DurableObjectId {
    return name as unknown as DurableObjectId
  }

  get(id: DurableObjectId): DurableObjectStub {
    const userId = id as unknown as string
    return {
      fetch: async (request: Request) => {
        this.calls += 1
        if (this.calls === this.failAtCall) {
          return Response.json({ error: { code: 'export_unavailable' } }, { status: 503 })
        }
        const url = new URL(request.url)
        if (url.pathname !== '/ledger/export') return new Response(null, { status: 404 })
        const cursor = url.searchParams.get('cursor')
        const offset = cursor === null ? 0 : Number(cursor.slice('page:'.length))
        const page = this.entries.slice(offset, offset + 100)
        const nextOffset = offset + page.length
        const complete = nextOffset >= this.entries.length
        return Response.json({
          schema_version: 1,
          snapshot: {
            user_id: userId,
            state_version: this.stateVersion,
            balance_micros: this.balanceMicros,
            spend_debt_micros: this.spendDebtMicros,
            ledger_count: this.entries.length,
            high_water_sequence: this.entries.length,
          },
          entries: page.map((entry) => ({ ...entry, state_version: entry.ledger_sequence + 6 })),
          complete,
          next_cursor: complete ? null : `page:${nextOffset}`,
        })
      },
    } as unknown as DurableObjectStub
  }
}

describe('admin financial-history backfill', () => {
  let raw: any
  let env: Env
  let ledger: LedgerExportNamespace

  beforeEach(async () => {
    const database = createSqliteD1()
    raw = database.raw
    applyMigrations(raw)
    const now = Date.now()
    raw.exec(`
      INSERT INTO users (
        id, email, display_name, role, status, balance_micros,
        created_at_ms, updated_at_ms, financial_history_complete
      ) VALUES
        ('root-admin', 'root@example.test', 'Root', 'admin', 'active', 0, 1, 1, 1),
        ('backfill-admin', 'admin@example.test', 'Admin', 'admin', 'active', 0, 1, 1, 1),
        ('legacy-user', 'legacy@example.test', 'Legacy', 'user', 'active', 1250, 1, 1, 0);

      INSERT INTO admin_roles (
        id, name, description, active, control_version, created_at_ms, updated_at_ms
      ) VALUES ('history-writer', 'History writer', '', 1, 0, 1, 1);
      INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
      VALUES ('history-writer', 'admin.users.write', 1),
             ('history-writer', 'admin.audit.read', 1);
      INSERT INTO admin_user_roles (
        user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
      ) VALUES ('backfill-admin', 'history-writer', 1, 1, NULL, 1);
    `)
    raw.prepare(`
      INSERT INTO admin_sessions (
        id, user_id, token_hash, created_at_ms, expires_at_ms
      ) VALUES ('backfill-session', 'backfill-admin', ?, ?, ?)
    `).run(
      await apiKeyDigest(`admin-session:v1:${TOKEN}`, PEPPER),
      now,
      now + 60_000,
    )

    ledger = new LedgerExportNamespace(buildLedger(), 211, 1_250)
    env = {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      DB: database.d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      USER_STATE: ledger as unknown as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    }
  })

  it('fully traverses more than 100 rows, projects exact micros, and replays safely', async () => {
    const first = await backfill()

    expect(first.status).toBe(200)
    const firstBody = await first.json() as any
    expect(firstBody).toMatchObject({
      code: 0,
      data: {
        user_id: 'legacy-user',
        ledger_entries_scanned: 100,
        financial_events_verified: 100,
        pages_scanned: 1,
        history_complete: false,
        idempotent: false,
        next_cursor: expect.any(String),
      },
    })
    expect(ledger.calls).toBe(1)
    expect(raw.prepare(
      `SELECT financial_history_complete FROM users WHERE id = 'legacy-user'`,
    ).get()).toEqual({ financial_history_complete: 0 })

    const second = await backfill(firstBody.data.next_cursor)
    expect(second.status).toBe(200)
    const secondBody = await second.json() as any
    expect(secondBody).toMatchObject({
      data: {
        ledger_entries_scanned: 200,
        financial_events_verified: 200,
        pages_scanned: 2,
        history_complete: false,
        next_cursor: expect.any(String),
      },
    })
    expect(ledger.calls).toBe(2)

    const third = await backfill(secondBody.data.next_cursor)
    expect(third.status).toBe(200)
    await expect(third.json()).resolves.toMatchObject({
      data: {
        ledger_entries_scanned: 205,
        financial_events_verified: 203,
        pages_scanned: 3,
        history_complete: true,
        next_cursor: null,
      },
    })
    expect(ledger.calls).toBe(3)
    expect(raw.prepare(
      `SELECT financial_history_complete FROM users WHERE id = 'legacy-user'`,
    ).get()).toEqual({ financial_history_complete: 1 })
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM user_financial_events WHERE user_id = 'legacy-user'`,
    ).get()).toEqual({ count: 203 })
    expect(raw.prepare(`
      SELECT actor_user_id, actor_session_id, target_user_id, action, outcome,
             snapshot_state_version, snapshot_high_water_sequence,
             ledger_entries_scanned, financial_events_verified, pages_scanned,
             length(snapshot_digest) AS digest_length
        FROM admin_financial_history_backfill_audit_events
       ORDER BY pages_scanned DESC LIMIT 1
    `).get()).toEqual({
      actor_user_id: 'backfill-admin',
      actor_session_id: 'backfill-session',
      target_user_id: 'legacy-user',
      action: 'financial_history.backfill.completed',
      outcome: 'succeeded',
      snapshot_state_version: 211,
      snapshot_high_water_sequence: 205,
      ledger_entries_scanned: 205,
      financial_events_verified: 203,
      pages_scanned: 3,
      digest_length: 64,
    })
    expect(() => raw.exec(
      `UPDATE admin_financial_history_backfill_audit_events SET outcome = 'recorded'`,
    )).toThrow(/immutable/)
    expect(() => raw.exec(
      `DELETE FROM admin_financial_history_backfill_audit_events`,
    )).toThrow(/immutable/)

    const audit = await createApp().request(
      '/api/v1/admin/audit/events?category=financial_history',
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    )
    expect(audit.status).toBe(200)
    const auditBody = await audit.json() as any
    expect(auditBody.data.items).toHaveLength(3)
    expect(auditBody.data.items[0]).toMatchObject({
      category: 'financial_history',
      action: 'financial_history.backfill.completed',
      outcome: 'succeeded',
      resource_id: 'legacy-user',
      resource_version: 211,
    })
    expect(raw.prepare(`
      SELECT state_version, event_type, amount_delta_micros, gross_amount_micros,
             balance_after_micros, spend_debt_after_micros
        FROM user_financial_events
       WHERE event_id = 'user-state:legacy-user:7'
    `).get()).toEqual({
      state_version: 7,
      event_type: 'opening_balance',
      amount_delta_micros: 1_000,
      gross_amount_micros: 1_000,
      balance_after_micros: 1_000,
      spend_debt_after_micros: 0,
    })
    expect(raw.prepare(`
      SELECT state_version, event_type, amount_delta_micros, gross_amount_micros,
             balance_after_micros, spend_debt_after_micros
        FROM user_financial_events
       WHERE event_id = 'user-state:legacy-user:209'
    `).get()).toEqual({
      state_version: 209,
      event_type: 'settlement',
      amount_delta_micros: -50,
      gross_amount_micros: 100,
      balance_after_micros: 1_150,
      spend_debt_after_micros: 50,
    })

    const replay = await backfill()
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      data: { history_complete: true, idempotent: true },
    })
    expect(ledger.calls).toBe(3)
  })

  it('keeps the completeness watermark at zero after a partial export failure and resumes safely', async () => {
    const first = await backfill()
    const firstBody = await first.json() as any
    expect(first.status).toBe(200)
    expect(firstBody.data.history_complete).toBe(false)
    ledger.failAtCall = 2

    const partial = await backfill(firstBody.data.next_cursor)

    expect(partial.status).toBe(503)
    expect(raw.prepare(
      `SELECT financial_history_complete FROM users WHERE id = 'legacy-user'`,
    ).get()).toEqual({ financial_history_complete: 0 })
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM user_financial_events WHERE user_id = 'legacy-user'`,
    ).get()).toEqual({ count: 100 })
    expect(raw.prepare(`
      SELECT action, outcome, actor_user_id, actor_session_id,
             snapshot_high_water_sequence, ledger_entries_scanned, pages_scanned
        FROM admin_financial_history_backfill_audit_events
       WHERE action = 'financial_history.backfill.failed'
       ORDER BY occurred_at_ms DESC LIMIT 1
    `).get()).toEqual({
      action: 'financial_history.backfill.failed',
      outcome: 'failed',
      actor_user_id: 'backfill-admin',
      actor_session_id: 'backfill-session',
      snapshot_high_water_sequence: 205,
      ledger_entries_scanned: 100,
      pages_scanned: 1,
    })

    ledger.failAtCall = null
    const resumed = await backfill(firstBody.data.next_cursor)
    expect(resumed.status).toBe(200)
    const resumedBody = await resumed.json() as any
    expect(resumedBody).toMatchObject({
      data: { financial_events_verified: 200, history_complete: false },
    })
    const completed = await backfill(resumedBody.data.next_cursor)
    expect(completed.status).toBe(200)
    await expect(completed.json()).resolves.toMatchObject({
      data: { financial_events_verified: 203, history_complete: true },
    })
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM user_financial_events WHERE user_id = 'legacy-user'`,
    ).get()).toEqual({ count: 203 })
  })

  it('lets only one concurrent final page record completion', async () => {
    const firstBody = await (await backfill()).json() as any
    const secondBody = await (await backfill(firstBody.data.next_cursor)).json() as any

    const responses = await Promise.all([
      backfill(secondBody.data.next_cursor),
      backfill(secondBody.data.next_cursor),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<any>))
    expect(bodies.map((body) => body.data.idempotent).sort()).toEqual([false, true])
    expect(raw.prepare(`
      SELECT COUNT(*) AS count
        FROM admin_financial_history_backfill_audit_events
       WHERE action = 'financial_history.backfill.completed'
    `).get()).toEqual({ count: 1 })
  })

  it('fails closed on an immutable projection conflict', async () => {
    raw.exec(`
      INSERT INTO user_financial_events (
        event_id, user_id, state_version, event_type, source_type, source_id,
        request_id, amount_delta_micros, gross_amount_micros,
        spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
        occurred_at_ms, projected_at_ms
      ) VALUES (
        'conflicting-opening', 'legacy-user', 7, 'opening_balance', 'opening_balance',
        'wrong-source', NULL, 999, 999, 0, 999, 0, 1, 1
      )
    `)

    const response = await backfill()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'financial_history_backfill_conflict' },
    })
    expect(raw.prepare(
      `SELECT financial_history_complete FROM users WHERE id = 'legacy-user'`,
    ).get()).toEqual({ financial_history_complete: 0 })
    expect(raw.prepare(
      `SELECT source_id, balance_after_micros FROM user_financial_events WHERE event_id = 'conflicting-opening'`,
    ).get()).toEqual({ source_id: 'wrong-source', balance_after_micros: 999 })
    expect(raw.prepare(`
      SELECT action, outcome, actor_user_id, actor_session_id,
             snapshot_high_water_sequence, ledger_entries_scanned, pages_scanned
        FROM admin_financial_history_backfill_audit_events
       WHERE action = 'financial_history.backfill.blocked'
       ORDER BY occurred_at_ms DESC LIMIT 1
    `).get()).toEqual({
      action: 'financial_history.backfill.blocked',
      outcome: 'blocked',
      actor_user_id: 'backfill-admin',
      actor_session_id: 'backfill-session',
      snapshot_high_water_sequence: 205,
      ledger_entries_scanned: 100,
      pages_scanned: 1,
    })
  })

  it('does not mark history complete when the ledger cannot explain the DO state version', async () => {
    ledger = new LedgerExportNamespace(buildLedger(), 212, 1_250)
    env.USER_STATE = ledger as unknown as DurableObjectNamespace

    const first = await backfill()
    const firstBody = await first.json() as any
    const second = await backfill(firstBody.data.next_cursor)
    const secondBody = await second.json() as any
    const response = await backfill(secondBody.data.next_cursor)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'financial_history_backfill_conflict' },
    })
    expect(raw.prepare(
      `SELECT financial_history_complete FROM users WHERE id = 'legacy-user'`,
    ).get()).toEqual({ financial_history_complete: 0 })
  })

  it('rejects a tampered continuation cursor before reading another page', async () => {
    const first = await backfill()
    const firstBody = await first.json() as any
    const cursor = firstBody.data.next_cursor as string
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`

    const response = await backfill(tampered)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_financial_history_backfill_cursor' },
    })
    expect(ledger.calls).toBe(1)
    expect(raw.prepare(
      `SELECT financial_history_complete FROM users WHERE id = 'legacy-user'`,
    ).get()).toEqual({ financial_history_complete: 0 })
  })

  it('requires user-write permission before contacting the Durable Object', async () => {
    raw.exec(`
      DELETE FROM admin_role_permissions WHERE role_id = 'history-writer';
      INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
      VALUES ('history-writer', 'admin.users.read', 1);
    `)

    const response = await backfill()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.users.write'),
      },
    })
    expect(ledger.calls).toBe(0)
  })

  function backfill(cursor?: string): Promise<Response> {
    return Promise.resolve(createApp().request(
      '/api/v1/admin/users/legacy-user/balance-history/backfill',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(cursor === undefined ? {} : { cursor }),
      },
      env,
    ))
  }
})

function buildLedger(): ExportEntry[] {
  const entries: ExportEntry[] = [{
    ledger_sequence: 1,
    schema_version: 1,
    mutation_key: 'balance:d1-user:7',
    mutation_id: 'd1-user:7',
    entry_type: 'opening_balance',
    user_id: 'legacy-user',
    request_id: null,
    amount_delta_micros: 1_000,
    balance_after_micros: 1_000,
    enabled_after: true,
    created_at_ms: 1,
  }]
  for (let sequence = 2; sequence <= 201; sequence += 1) {
    entries.push({
      ledger_sequence: sequence,
      schema_version: 1,
      mutation_key: `balance:redeem:${sequence}`,
      mutation_id: `redeem:${sequence}`,
      entry_type: 'balance_adjustment',
      user_id: 'legacy-user',
      request_id: null,
      amount_delta_micros: 1,
      balance_after_micros: 999 + sequence,
      enabled_after: null,
      created_at_ms: sequence,
    })
  }
  entries.push({
    ledger_sequence: 202,
    schema_version: 1,
    mutation_key: 'enabled:disable-legacy',
    mutation_id: 'disable-legacy',
    entry_type: 'enabled_change',
    user_id: 'legacy-user',
    request_id: null,
    amount_delta_micros: 0,
    balance_after_micros: 1_200,
    enabled_after: false,
    created_at_ms: 202,
  })
  entries.push({
    ledger_sequence: 203,
    schema_version: 1,
    mutation_key: 'settlement:request-legacy',
    mutation_id: 'request-legacy',
    entry_type: 'settlement',
    user_id: 'legacy-user',
    request_id: 'request-legacy',
    amount_delta_micros: -100,
    balance_after_micros: 1_150,
    enabled_after: null,
    created_at_ms: 203,
  })
  entries.push({
    ledger_sequence: 204,
    schema_version: 1,
    mutation_key: 'balance:admin-balance:last',
    mutation_id: 'admin-balance:last',
    entry_type: 'balance_adjustment',
    user_id: 'legacy-user',
    request_id: null,
    amount_delta_micros: 150,
    balance_after_micros: 1_250,
    enabled_after: null,
    created_at_ms: 204,
  })
  entries.push({
    ledger_sequence: 205,
    schema_version: 1,
    mutation_key: 'enabled:enable-legacy',
    mutation_id: 'enable-legacy',
    entry_type: 'enabled_change',
    user_id: 'legacy-user',
    request_id: null,
    amount_delta_micros: 0,
    balance_after_micros: 1_250,
    enabled_after: true,
    created_at_ms: 205,
  })
  return entries
}
