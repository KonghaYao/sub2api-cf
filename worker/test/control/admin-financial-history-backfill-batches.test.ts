import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { controlIdempotency } from '../../src/control/idempotency'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'b'.repeat(32)
const TOKEN = 'financial-batch-admin-session-0001'

class BatchLedgerNamespace {
  calls: string[] = []
  failOnce = new Set<string>()
  rollbackGap = new Set<string>()
  onFetch: ((userId: string) => void | Promise<void>) | null = null

  idFromName(name: string): DurableObjectId {
    return name as unknown as DurableObjectId
  }

  get(id: DurableObjectId): DurableObjectStub {
    const userId = id as unknown as string
    return {
      fetch: async (request: Request) => {
        this.calls.push(userId)
        await this.onFetch?.(userId)
        if (this.failOnce.delete(userId)) {
          return Response.json({ error: { code: 'unavailable' } }, { status: 503 })
        }
        if (this.rollbackGap.has(userId)) {
          return Response.json({
            error: { code: 'ledger_state_version_unrecoverable' },
          }, { status: 409 })
        }
        const url = new URL(request.url)
        const offset = url.searchParams.get('cursor') === null ? 0 : 100
        const total = 101
        const entries = Array.from(
          { length: Math.min(100, total - offset) },
          (_, index) => {
            const sequence = offset + index + 1
            return {
              ledger_sequence: sequence,
              state_version: sequence + 6,
              schema_version: 1,
              mutation_key: sequence === 1 ? 'balance:d1-user:7' : `balance:redeem:${sequence}`,
              mutation_id: sequence === 1 ? 'd1-user:7' : `redeem:${sequence}`,
              entry_type: sequence === 1 ? 'opening_balance' : 'balance_adjustment',
              user_id: userId,
              request_id: null,
              amount_delta_micros: sequence === 1 ? 100 : 1,
              balance_after_micros: 99 + sequence,
              enabled_after: sequence === 1 ? true : null,
              created_at_ms: sequence,
            }
          },
        )
        const complete = offset + entries.length >= total
        return Response.json({
          schema_version: 1,
          snapshot: {
            user_id: userId,
            state_version: 107,
            balance_micros: 99 + total,
            spend_debt_micros: 0,
            ledger_count: total,
            high_water_sequence: total,
          },
          entries,
          complete,
          next_cursor: complete ? null : 'page:100',
        })
      },
    } as unknown as DurableObjectStub
  }
}

describe('admin financial-history backfill batches', () => {
  let raw: any
  let env: Env
  let ledger: BatchLedgerNamespace

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
        ('batch-admin', 'admin@example.test', 'Admin', 'admin', 'active', 0, 1, 1, 1),
        ('legacy-a', 'a@example.test', 'A', 'user', 'active', 200, 1, 1, 0),
        ('legacy-b', 'b@example.test', 'B', 'user', 'active', 200, 1, 1, 0),
        ('legacy-gap', 'gap@example.test', 'Gap', 'user', 'active', 100, 1, 1, 0);
      INSERT INTO admin_roles (
        id, name, description, active, control_version, created_at_ms, updated_at_ms
      ) VALUES ('history-writer', 'History writer', '', 1, 0, 1, 1);
      INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
      VALUES ('history-writer', 'admin.users.read', 1),
             ('history-writer', 'admin.users.write', 1),
             ('history-writer', 'admin.audit.read', 1);
      INSERT INTO admin_user_roles (
        user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
      ) VALUES ('batch-admin', 'history-writer', 1, 1, NULL, 1);
    `)
    raw.prepare(`
      INSERT INTO admin_sessions (id, user_id, token_hash, created_at_ms, expires_at_ms)
      VALUES ('batch-session', 'batch-admin', ?, ?, ?)
    `).run(await apiKeyDigest(`admin-session:v1:${TOKEN}`, PEPPER), now, now + 60_000)
    ledger = new BatchLedgerNamespace()
    env = {
      APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
      DB: database.d1, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      USER_STATE: ledger as unknown as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    }
  })

  it('creates idempotently and advances only the requested user/page budget', async () => {
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a', 'legacy-b'],
    }, 'create-batch-0001')
    expect(created.status).toBe(201)
    const createdBody = await created.json() as any
    expect(createdBody.data).toMatchObject({
      status: 'queued', control_version: 0, total_users: 2,
      items: [
        { user_id: 'legacy-a', status: 'queued', continuation_cursor: null },
        { user_id: 'legacy-b', status: 'queued', continuation_cursor: null },
      ],
    })

    const replay = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a', 'legacy-b'],
    }, 'create-batch-0001')
    expect(replay.status).toBe(200)
    expect((await replay.json() as any).data.id).toBe(createdBody.data.id)

    const advanced = await post(
      `/api/v1/admin/financial-history/backfill-batches/${createdBody.data.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-batch-0001',
    )
    expect(advanced.status, JSON.stringify(await advanced.clone().json())).toBe(200)
    const advancedBody = await advanced.json() as any
    expect(advancedBody.data).toMatchObject({
      status: 'queued', control_version: 1,
      run: { users_attempted: 1, pages_attempted: 1 },
      items: [
        { user_id: 'legacy-a', status: 'queued', pages_processed: 1,
          continuation_cursor: expect.any(String) },
        { user_id: 'legacy-b', status: 'queued', pages_processed: 0,
          continuation_cursor: null },
      ],
    })
    expect(ledger.calls).toEqual(['legacy-a'])

    const singlePageCreated = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-b'],
    }, 'create-single-page')
    const singlePageBatch = (await singlePageCreated.json() as any).data
    const singlePageRun = await post(
      `/api/v1/admin/financial-history/backfill-batches/${singlePageBatch.id}/continue`,
      { expected_control_version: 0, user_budget: 10, page_budget: 1 },
      'continue-single-page',
    )
    expect(singlePageRun.status).toBe(200)
    expect((await singlePageRun.json() as any).data).toMatchObject({
      status: 'queued',
      run: { users_attempted: 1, pages_attempted: 1 },
      items: [{ user_id: 'legacy-b', status: 'queued', pages_processed: 1 }],
    })
    expect(ledger.calls).toEqual(['legacy-a', 'legacy-b'])

    const runReplay = await post(
      `/api/v1/admin/financial-history/backfill-batches/${createdBody.data.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-batch-0001',
    )
    expect(runReplay.status).toBe(200)
    expect((await runReplay.json() as any).data).toEqual(advancedBody.data)
    expect(ledger.calls).toEqual(['legacy-a', 'legacy-b'])

    const viewed = await get(
      `/api/v1/admin/financial-history/backfill-batches/${createdBody.data.id}`,
    )
    expect(viewed.status).toBe(200)
    expect((await viewed.json() as any).data.items[0].continuation_cursor)
      .toBe(advancedBody.data.items[0].continuation_cursor)
    expect(raw.prepare(`
      SELECT actor_user_id, actor_session_id, action
        FROM admin_financial_history_backfill_batch_audit_events
       WHERE batch_id = ? ORDER BY occurred_at_ms, action
    `).all(createdBody.data.id)).toEqual([
      { actor_user_id: 'batch-admin', actor_session_id: 'batch-session',
        action: 'financial_history.backfill_batch.created' },
      { actor_user_id: 'batch-admin', actor_session_id: 'batch-session',
        action: 'financial_history.backfill_batch.continued' },
    ])

    const audit = await get(
      `/api/v1/admin/audit/events?category=financial_history` +
      `&resource_type=financial_history_backfill_batch&resource_id=${createdBody.data.id}&limit=1`,
    )
    expect(audit.status).toBe(200)
    const auditBody = await audit.json() as any
    expect(auditBody.data.items).toHaveLength(1)
    expect(auditBody.data.has_more).toBe(true)
    expect(auditBody.data.next_cursor).toEqual(expect.any(String))
    expect(auditBody.data.items[0]).toMatchObject({
      category: 'financial_history',
      action: 'financial_history.backfill_batch.continued',
      resource_type: 'financial_history_backfill_batch',
      resource_id: createdBody.data.id,
      resource_version: 1,
    })
    const detail = await get(
      `/api/v1/admin/audit/events/financial_history/${auditBody.data.items[0].event_id}`,
    )
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      data: { metadata: { from_status: 'queued', to_status: 'queued' } },
    })
    const auditNext = await get(
      `/api/v1/admin/audit/events?category=financial_history` +
      `&resource_type=financial_history_backfill_batch&resource_id=${createdBody.data.id}` +
      `&limit=1&cursor=${encodeURIComponent(auditBody.data.next_cursor)}`,
    )
    expect((await auditNext.json() as any).data.items[0]).toMatchObject({
      action: 'financial_history.backfill_batch.created',
      resource_version: 0,
    })
  })

  it('uses batch CAS, recovers transient failures, and never retries manual reconciliation', async () => {
    ledger.failOnce.add('legacy-a')
    ledger.rollbackGap.add('legacy-gap')
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a', 'legacy-gap'],
    }, 'create-batch-0002')
    const batch = (await created.json() as any).data

    const [winner, loser] = await Promise.all([
      post(`/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`, {
        expected_control_version: 0, user_budget: 1, page_budget: 1,
      }, 'continue-batch-a'),
      post(`/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`, {
        expected_control_version: 0, user_budget: 1, page_budget: 1,
      }, 'continue-batch-b'),
    ])
    expect([winner.status, loser.status].sort()).toEqual([200, 409])
    const failedRun = winner.status === 200 ? winner : loser
    expect((await failedRun.json() as any).data.items[0]).toMatchObject({
      user_id: 'legacy-a', status: 'failed', error_code: 'financial_history_export_failed',
    })
    expect(ledger.calls).toEqual(['legacy-a'])

    const resumed = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 1, user_budget: 2, page_budget: 1 },
      'continue-batch-resume',
    )
    expect(resumed.status).toBe(200)
    const resumedBody = await resumed.json() as any
    expect(resumedBody.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: 'legacy-a', status: 'queued', pages_processed: 1 }),
      expect.objectContaining({ user_id: 'legacy-gap', status: 'queued' }),
    ]))

    const next = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 2, user_budget: 2, page_budget: 1 },
      'continue-batch-complete-a',
    )
    expect(next.status).toBe(200)
    const gap = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 3, user_budget: 2, page_budget: 1 },
      'continue-batch-gap',
    )
    expect(gap.status).toBe(200)
    const callsBefore = ledger.calls.filter((id) => id === 'legacy-gap').length
    const afterGap = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 4, user_budget: 2, page_budget: 1 },
      'continue-batch-after-gap',
    )
    expect(afterGap.status).toBe(200)
    expect(ledger.calls.filter((id) => id === 'legacy-gap')).toHaveLength(callsBefore)
  })

  it('reclaims an expired user lease and rejects every over-budget request', async () => {
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a'],
    }, 'create-batch-lease')
    const batch = (await created.json() as any).data
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batch_users
         SET status = 'running', lease_token = 'abandoned', lease_expires_at_ms = 1,
             version = version + 1
       WHERE batch_id = ? AND user_id = 'legacy-a'
    `).run(batch.id)

    const recovered = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-expired-lease',
    )
    expect(recovered.status).toBe(200)
    expect((await recovered.json() as any).data.items[0]).toMatchObject({
      status: 'queued', pages_processed: 1, attempts: 1,
    })
    expect(ledger.calls).toEqual(['legacy-a'])

    const tooManyUsers = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: Array.from({ length: 26 }, (_, index) => `user-${index}`),
    }, 'create-over-budget')
    expect(tooManyUsers.status).toBe(400)

    const tooManyPages = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 1, user_budget: 1, page_budget: 2 },
      'continue-over-budget',
    )
    expect(tooManyPages.status).toBe(400)
    expect(ledger.calls).toEqual(['legacy-a'])
  })

  it('blocks immutable conflicts without misclassifying them as rollback gaps', async () => {
    raw.exec(`
      INSERT INTO user_financial_events (
        event_id, user_id, state_version, event_type, source_type, source_id,
        request_id, amount_delta_micros, gross_amount_micros,
        spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
        occurred_at_ms, projected_at_ms
      ) VALUES (
        'wrong-opening', 'legacy-a', 7, 'opening_balance', 'opening_balance', 'wrong',
        NULL, 99, 99, 0, 99, 0, 1, 1
      )
    `)
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a'],
    }, 'create-blocked-conflict')
    const batch = (await created.json() as any).data
    const run = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-blocked-conflict',
    )
    expect(run.status).toBe(200)
    expect((await run.json() as any).data).toMatchObject({
      status: 'blocked',
      items: [{ user_id: 'legacy-a', status: 'blocked',
        error_code: 'financial_history_backfill_conflict' }],
    })
  })

  it('lets the same key resume only after lease expiry and fences the old Worker', async () => {
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a'],
    }, 'create-operation-recovery')
    const batch = (await created.json() as any).data
    let releaseFirst!: () => void
    let reportStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { reportStarted = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let fetches = 0
    ledger.onFetch = async () => {
      fetches += 1
      if (fetches === 1) {
        reportStarted()
        await firstGate
      }
    }
    const first = post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-operation-recovery',
    )
    await firstStarted

    const activeReplay = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-operation-recovery',
    )
    expect(activeReplay.status).toBe(409)
    await expect(activeReplay.json()).resolves.toMatchObject({
      error: { code: 'financial_history_backfill_operation_in_progress' },
    })
    const newKey = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 1, user_budget: 1, page_budget: 1 },
      'continue-operation-new-key',
    )
    expect(newKey.status).toBe(409)
    expect(fetches).toBe(1)

    const operationRow = raw.prepare(`
      SELECT response_json FROM control_idempotency
       WHERE resource_type = 'financial_history_backfill_batch_operation'
         AND resource_id = ?
    `).get(batch.id) as { response_json: string }
    const replacementOperation = {
      ...JSON.parse(operationRow.response_json),
      lease_token: 'replacement-owner',
      lease_expires_at_ms: Date.now() + 60_000,
    }
    raw.prepare(`
      UPDATE control_idempotency SET response_json = ?
       WHERE resource_type = 'financial_history_backfill_batch_operation'
         AND resource_id = ?
    `).run(JSON.stringify(replacementOperation), batch.id)
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batches
         SET runner_lease_token = 'replacement-owner', runner_lease_expires_at_ms = ?
       WHERE id = ?
    `).run(replacementOperation.lease_expires_at_ms, batch.id)
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batch_users
         SET lease_expires_at_ms = 1
       WHERE batch_id = ? AND status = 'running'
    `).run(batch.id)
    releaseFirst()
    expect((await first).status).toBe(409)
    expect(raw.prepare(`
      SELECT status, pages_processed, continuation_cursor
        FROM admin_financial_history_backfill_batch_users
       WHERE batch_id = ? AND user_id = 'legacy-a'
    `).get(batch.id)).toEqual({
      status: 'running', pages_processed: 0, continuation_cursor: null,
    })

    raw.prepare(`
      UPDATE admin_financial_history_backfill_batches
         SET runner_lease_expires_at_ms = 1
       WHERE id = ?
    `).run(batch.id)
    raw.prepare(`
      UPDATE control_idempotency
         SET response_json = json_set(response_json, '$.lease_expires_at_ms', 1)
       WHERE resource_type = 'financial_history_backfill_batch_operation'
         AND resource_id = ?
    `).run(batch.id)

    const resumed = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-operation-recovery',
    )
    expect(resumed.status).toBe(200)
    const resumedBody = await resumed.json() as any
    expect(resumedBody.data).toMatchObject({
      control_version: 1,
      run: { users_attempted: 1, pages_attempted: 1 },
      items: [{ user_id: 'legacy-a', status: 'queued', pages_processed: 1 }],
    })
    expect(fetches).toBe(2)

    const replay = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      'continue-operation-recovery',
    )
    expect(replay.status).toBe(200)
    expect((await replay.json() as any).data).toEqual(resumedBody.data)
    expect(fetches).toBe(2)
  })

  it('does not partially claim an item after ownership changes following selection', async () => {
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a'],
    }, 'create-pre-claim-fence')
    const batch = (await created.json() as any).data
    let reportClaimReady!: () => void
    let releaseClaim!: () => void
    const claimReady = new Promise<void>((resolve) => { reportClaimReady = resolve })
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve })
    const originalBatch = env.DB.batch.bind(env.DB)
    let intercepted = false
    ;(env.DB as any).batch = async (statements: D1PreparedStatement[]) => {
      if (
        !intercepted && statements.length === 3 &&
        String((statements[0] as any).sql).includes('UPDATE control_idempotency SET response_json')
      ) {
        intercepted = true
        reportClaimReady()
        await claimGate
      }
      return originalBatch(statements)
    }

    const key = 'continue-pre-claim-fence'
    const first = post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      key,
    )
    await claimReady

    const operationRow = raw.prepare(`
      SELECT response_json FROM control_idempotency
       WHERE resource_type = 'financial_history_backfill_batch_operation'
         AND resource_id = ?
    `).get(batch.id) as { response_json: string }
    const replacementOperation = {
      ...JSON.parse(operationRow.response_json),
      lease_token: 'pre-claim-replacement',
      lease_expires_at_ms: Date.now() + 60_000,
    }
    raw.prepare(`
      UPDATE control_idempotency SET response_json = ?
       WHERE resource_type = 'financial_history_backfill_batch_operation'
         AND resource_id = ?
    `).run(JSON.stringify(replacementOperation), batch.id)
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batches
         SET runner_lease_token = ?, runner_lease_expires_at_ms = ?
       WHERE id = ?
    `).run(
      replacementOperation.lease_token, replacementOperation.lease_expires_at_ms, batch.id,
    )
    releaseClaim()

    expect((await first).status).toBe(409)
    expect(raw.prepare(`
      SELECT status, attempts, lease_token
        FROM admin_financial_history_backfill_batch_users
       WHERE batch_id = ? AND user_id = 'legacy-a'
    `).get(batch.id)).toEqual({ status: 'queued', attempts: 0, lease_token: null })
    expect(ledger.calls).toEqual([])

    raw.prepare(`
      UPDATE admin_financial_history_backfill_batches
         SET runner_lease_expires_at_ms = 1
       WHERE id = ?
    `).run(batch.id)
    raw.prepare(`
      UPDATE control_idempotency
         SET response_json = json_set(response_json, '$.lease_expires_at_ms', 1)
       WHERE resource_type = 'financial_history_backfill_batch_operation'
         AND resource_id = ?
    `).run(batch.id)
    const resumed = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      key,
    )
    expect(resumed.status).toBe(200)
    expect((await resumed.json() as any).data).toMatchObject({
      control_version: 1,
      items: [{ user_id: 'legacy-a', status: 'queued', attempts: 1, pages_processed: 1 }],
    })
    expect(ledger.calls).toEqual(['legacy-a'])
  })

  it('resumes a page-finished operation without reading the ledger page again', async () => {
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-b'],
    }, 'create-page-finished-recovery')
    const batch = (await created.json() as any).data
    const key = 'continue-page-finished-recovery'
    const idempotency = await controlIdempotency(
      `admin.financial_history.backfill_batches.continue.v1:${batch.id}`,
      key,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
    )
    const operation = {
      state: 'in_progress', batch_id: batch.id, expected_control_version: 0,
      from_status: 'queued', lease_token: 'finished-page-owner',
      lease_expires_at_ms: 1, selected_user_id: 'legacy-b', page_finished: true,
    }
    raw.prepare(`
      INSERT INTO control_idempotency (
        scope, key_hash, request_hash, resource_type, resource_id,
        response_json, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, 'financial_history_backfill_batch_operation', ?, ?, 1, ?)
    `).run(
      idempotency.scope, idempotency.key_hash, idempotency.request_hash,
      batch.id, JSON.stringify(operation), Date.now() + 60_000,
    )
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batches
         SET status = 'running', control_version = 1,
             runner_lease_token = ?, runner_lease_expires_at_ms = 1
       WHERE id = ?
    `).run(operation.lease_token, batch.id)
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batch_users
         SET continuation_cursor = 'persisted-signed-cursor', pages_processed = 1,
             attempts = 1, version = 2
       WHERE batch_id = ? AND user_id = 'legacy-b'
    `).run(batch.id)
    const resumed = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      key,
    )
    expect(resumed.status).toBe(200)
    expect((await resumed.json() as any).data).toMatchObject({
      control_version: 1,
      run: { users_attempted: 1, pages_attempted: 1 },
      items: [{ user_id: 'legacy-b', status: 'queued', pages_processed: 1 }],
    })
    expect(ledger.calls).toEqual([])
  })

  it('does not split ownership when the old Worker finishes after takeover reads', async () => {
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-b'],
    }, 'create-takeover-read-race')
    const batch = (await created.json() as any).data
    const key = 'continue-takeover-read-race'
    const idempotency = await controlIdempotency(
      `admin.financial_history.backfill_batches.continue.v1:${batch.id}`,
      key,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
    )
    const oldOperation = {
      state: 'in_progress', batch_id: batch.id, expected_control_version: 0,
      from_status: 'queued', lease_token: 'old-page-owner',
      lease_expires_at_ms: 1, selected_user_id: 'legacy-b', page_finished: false,
    }
    raw.prepare(`
      INSERT INTO control_idempotency (
        scope, key_hash, request_hash, resource_type, resource_id,
        response_json, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, 'financial_history_backfill_batch_operation', ?, ?, 1, ?)
    `).run(
      idempotency.scope, idempotency.key_hash, idempotency.request_hash,
      batch.id, JSON.stringify(oldOperation), Date.now() + 60_000,
    )
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batches
         SET status = 'running', control_version = 1,
             runner_lease_token = ?, runner_lease_expires_at_ms = 1
       WHERE id = ?
    `).run(oldOperation.lease_token, batch.id)
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batch_users
         SET status = 'running', attempts = 1, version = 1,
             lease_token = ?, lease_expires_at_ms = 1
       WHERE batch_id = ? AND user_id = 'legacy-b'
    `).run(oldOperation.lease_token, batch.id)

    let reportTakeoverReady!: () => void
    let releaseTakeover!: () => void
    const takeoverReady = new Promise<void>((resolve) => { reportTakeoverReady = resolve })
    const takeoverGate = new Promise<void>((resolve) => { releaseTakeover = resolve })
    const originalBatch = env.DB.batch.bind(env.DB)
    let intercepted = false
    ;(env.DB as any).batch = async (statements: D1PreparedStatement[]) => {
      if (
        !intercepted && statements.length === 2 &&
        String((statements[0] as any).sql).includes('UPDATE control_idempotency SET response_json') &&
        String((statements[1] as any).sql).includes('SET runner_lease_token = ?')
      ) {
        intercepted = true
        reportTakeoverReady()
        await takeoverGate
      }
      return originalBatch(statements)
    }

    const takeover = post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      key,
    )
    await takeoverReady

    const pageFinished = { ...oldOperation, page_finished: true }
    raw.exec('BEGIN')
    raw.prepare(`
      UPDATE control_idempotency SET response_json = ?
       WHERE scope = ? AND key_hash = ? AND response_json = ?
    `).run(
      JSON.stringify(pageFinished), idempotency.scope, idempotency.key_hash,
      JSON.stringify(oldOperation),
    )
    raw.prepare(`
      UPDATE admin_financial_history_backfill_batch_users
         SET status = 'queued', continuation_cursor = 'persisted-signed-cursor',
             pages_processed = 1, lease_token = NULL, lease_expires_at_ms = NULL,
             version = 2
       WHERE batch_id = ? AND user_id = 'legacy-b'
         AND status = 'running' AND lease_token = ?
    `).run(batch.id, oldOperation.lease_token)
    raw.exec('COMMIT')
    releaseTakeover()

    expect((await takeover).status).toBe(409)
    expect(raw.prepare(`
      SELECT runner_lease_token FROM admin_financial_history_backfill_batches WHERE id = ?
    `).get(batch.id)).toEqual({ runner_lease_token: oldOperation.lease_token })
    expect(JSON.parse((raw.prepare(`
      SELECT response_json FROM control_idempotency WHERE scope = ? AND key_hash = ?
    `).get(idempotency.scope, idempotency.key_hash) as { response_json: string }).response_json))
      .toEqual(pageFinished)

    const resumed = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 1 },
      key,
    )
    expect(resumed.status).toBe(200)
    expect((await resumed.json() as any).data).toMatchObject({
      control_version: 1,
      run: { users_attempted: 1, pages_attempted: 1 },
      items: [{ user_id: 'legacy-b', status: 'queued', attempts: 1, pages_processed: 1 }],
    })
    expect(ledger.calls).toEqual([])
  })

  it('rejects a second page in one Worker step', async () => {
    const created = await post('/api/v1/admin/financial-history/backfill-batches', {
      user_ids: ['legacy-a'],
    }, 'create-lease-renewal')
    const batch = (await created.json() as any).data
    const run = await post(
      `/api/v1/admin/financial-history/backfill-batches/${batch.id}/continue`,
      { expected_control_version: 0, user_budget: 1, page_budget: 2 },
      'continue-two-pages',
    )
    expect(run.status).toBe(400)
    expect(ledger.calls).toEqual([])
  })

  function post(path: string, body: unknown, idempotencyKey: string): Promise<Response> {
    return Promise.resolve(createApp().request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    }, env))
  }

  function get(path: string): Promise<Response> {
    return Promise.resolve(createApp().request(path, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }, env))
  }
})
