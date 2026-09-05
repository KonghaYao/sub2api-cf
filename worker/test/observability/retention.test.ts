import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { recordRequestOutcome, recordRequestStart } from '../../src/observability/recorder'
import {
  cleanupObservabilityR2Orphans,
  repairObservabilityPayloadMetadata,
  runObservabilityRetention,
} from '../../src/observability/retention'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const objects = new Map<string, { body: string; uploaded: Date }>()
  const bucket = {
    put: vi.fn(async (key: string, body: string) => { objects.set(key, { body, uploaded: new Date(1) }) }),
    delete: vi.fn(async (key: string) => { objects.delete(key) }),
    head: vi.fn(async (key: string) => objects.has(key) ? { customMetadata: {} } : null),
    list: vi.fn(async () => ({
      objects: [...objects].map(([key, value]) => ({ key, uploaded: value.uploaded })),
      truncated: false,
    })),
  }
  return {
    raw,
    objects,
    bucket,
    env: { DB: d1, OBJECTS: bucket, EVENTS_QUEUE: { send: vi.fn() } } as unknown as Env,
  }
}

describe('observability retention', () => {
  it('deletes only the bounded old metadata and referenced R2 payload', async () => {
    const test = fixture()
    const old = Date.now() - 10_000
    const recent = Date.now()
    for (const [requestId, at] of [['old-request', old], ['recent-request', recent]] as const) {
      const handle = await recordRequestStart(test.env, {
        requestId, method: 'POST', requestPath: '/v1/responses', occurredAtMs: at,
      })
      await recordRequestOutcome(test.env, handle!, {
        lifecycle: 'completed', statusCode: 200, completedAtMs: at + 1,
        payload: { response: { body: { ok: true } } },
      })
    }
    expect(await runObservabilityRetention(test.env, { beforeMs: old + 100, limit: 1 })).toMatchObject({
      scanned: 1, deleted: 1, r2_failures: 0,
    })
    expect(test.raw.prepare('SELECT request_id FROM request_observations').all()).toEqual([{ request_id: 'recent-request' }])
    expect(test.objects.size).toBe(1)
    test.raw.close()
  })

  it('removes immutable resolution audit rows only after their retained observation expires', async () => {
    const test = fixture()
    const old = Date.now() - 10_000
    const handle = await recordRequestStart(test.env, {
      requestId: 'resolved-old-request', method: 'POST', requestPath: '/v1/responses',
      occurredAtMs: old,
    })
    await recordRequestOutcome(test.env, handle!, {
      lifecycle: 'failed', statusCode: 502, completedAtMs: old + 1,
    })
    test.raw.prepare(`
      INSERT INTO request_observation_resolution_audit (
        id, observation_id, actor_user_id, resolved, occurred_at_ms
      ) VALUES ('resolution-old', ?, 'admin', 1, ?)
    `).run(handle!.id, old + 2)
    expect(() => test.raw.prepare(
      `DELETE FROM request_observation_resolution_audit WHERE id = 'resolution-old'`,
    ).run()).toThrow(/request_observation_resolution_audit_immutable/)

    await expect(runObservabilityRetention(test.env, { beforeMs: old + 100, limit: 1 }))
      .resolves.toMatchObject({ deleted: 1, resolution_audit_deleted: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM request_observation_resolution_audit`,
    ).get()).toEqual({ count: 0 })
    test.raw.close()
  })

  it('removes only old R2 objects that have no D1 authority row', async () => {
    const test = fixture()
    test.objects.set('observability/v1/orphan.json', { body: '{}', uploaded: new Date(1) })
    const result = await cleanupObservabilityR2Orphans(test.env, { beforeMs: Date.now() - 1, limit: 10 })
    expect(result).toMatchObject({ scanned: 1, deleted: 1, truncated: false })
    expect(test.objects.size).toBe(0)
    test.raw.close()
  })

  it('defers poisoned repair rows so later recoverable payloads cannot starve', async () => {
    const test = fixture()
    const now = Date.now()
    for (let index = 0; index < 3; index += 1) {
      const handle = await recordRequestStart(test.env, {
        requestId: `repair-${index}`, method: 'POST', requestPath: '/v1/responses',
        occurredAtMs: now - 10_000 + index,
      })
      await recordRequestOutcome(test.env, handle!, {
        lifecycle: 'failed', statusCode: 502, completedAtMs: now - 5_000 + index,
        payload: { error: { body: { code: `failure-${index}` } } },
      })
    }
    test.raw.prepare(
      `UPDATE request_observations
          SET payload_state = 'retry', payload_retry_after_ms = ?, payload_attempts = 1`,
    ).run(now - 1)
    const rows = test.raw.prepare(
      `SELECT request_id, payload_object_key, payload_sha256
         FROM request_observations ORDER BY occurred_at_ms, id`,
    ).all() as Array<{ request_id: string; payload_object_key: string; payload_sha256: string }>
    test.bucket.head.mockImplementation(async (key: string) => {
      const recoverable = rows[2]!
      return key === recoverable.payload_object_key
        ? { customMetadata: { sha256: recoverable.payload_sha256 } }
        : null
    })

    await expect(repairObservabilityPayloadMetadata(test.env, { nowMs: now, limit: 2 }))
      .resolves.toEqual({ scanned: 2, repaired: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM request_observations
        WHERE request_id IN ('repair-0', 'repair-1') AND payload_retry_after_ms > ?`,
    ).get(now)).toEqual({ count: 2 })
    await expect(repairObservabilityPayloadMetadata(test.env, { nowMs: now, limit: 2 }))
      .resolves.toEqual({ scanned: 1, repaired: 1 })
    expect(test.raw.prepare(
      `SELECT payload_state FROM request_observations WHERE request_id = 'repair-2'`,
    ).get()).toEqual({ payload_state: 'stored' })
    test.raw.close()
  })
})
