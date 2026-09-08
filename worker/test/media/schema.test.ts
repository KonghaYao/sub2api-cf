import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function seedMediaDependencies(raw: any): void {
  raw.exec(`
    INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
    VALUES ('user-schema', 'media-schema@example.test', 'Schema User', 1, 1);
    INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
    VALUES ('group-schema', 'Media schema', 'gemini', 1, 1);
    INSERT INTO api_keys (
      id, user_id, key_hash, name, created_at_ms, updated_at_ms
    ) VALUES (
      'key-schema', 'user-schema',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'Schema key', 1, 1
    );
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint,
      created_at_ms, updated_at_ms
    ) VALUES (
      'model-schema', 'gemini', 'gemini-image',
      'gemini-2.5-flash-image', 'responses', 1, 1
    );
    INSERT INTO group_models (
      group_id, model_id, created_at_ms, updated_at_ms
    ) VALUES ('group-schema', 'model-schema', 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, input_micros_per_million,
      output_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES (
      'price-schema', 'group-schema', 'model-schema', 1, 0, 0, 0, 1, 1, 1
    );
    INSERT INTO accounts (
      id, platform, name, credential_ref, protocol, auth_scheme,
      created_at_ms, updated_at_ms
    ) VALUES (
      'account-schema', 'gemini', 'Schema account', 'secret-schema',
      'gemini', 'x-goog-api-key', 1, 1
    );
  `)
}

function insertLegacyMediaTask(raw: any, suffix: string): string {
  const id = `imgbatch_${suffix.padStart(32, '0')}`
  raw.prepare(
    `INSERT INTO media_tasks (
       id, user_id, api_key_id, group_id, provider, model, upstream_model,
       image_size, response_mime_type, status, item_count, expected_output_count,
       base_unit_price_micros, price_id, effective_rate_multiplier_ppm,
       batch_discount_multiplier_ppm, hold_multiplier_ppm,
       billable_unit_price_micros, hold_unit_price_micros,
       estimated_cost_micros, hold_amount_micros, billing_type,
       idempotency_key_hash, request_hash, input_object_key,
       created_at_ms, updated_at_ms
     ) VALUES (
       ?, 'user-schema', 'key-schema', 'group-schema', 'gemini_api',
       'gemini-image', 'gemini-2.5-flash-image', '1K', 'image/png', 'created',
       1, 1, 1, 'price-schema', 1000000, 500000, 600000, 1, 1, 1, 1,
       'balance', ?, ?, ?, 1, 1
     )`,
  ).run(
    id,
    suffix.padStart(64, 'a'),
    suffix.padStart(64, 'b'),
    `media/schema/${suffix.padStart(16, '0')}/input.json`,
  )
  return id
}

function insertProviderJob(
  raw: any,
  taskId: string,
  submissionKey: string,
  providerJobId: string | null = null,
): void {
  raw.prepare(
    `INSERT INTO media_provider_jobs (
       task_id, provider_account_id, submission_key, provider_job_id,
       phase, next_action_at_ms, deadline_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, 'account-schema', ?, ?, 'submit_pending', 1, 1000, 1, 1)`,
  ).run(taskId, submissionKey, providerJobId)
}

describe('media task migration', () => {
  it('keeps legacy task inserts on inline execution while allowing provider jobs', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    seedMediaDependencies(raw)

    const taskId = insertLegacyMediaTask(raw, '1')
    const tables = raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND (name LIKE 'media_task%' OR name = 'media_provider_jobs')
        ORDER BY name`,
    ).all().map((row: { name: string }) => row.name)
    expect(tables).toEqual([
      'media_provider_jobs',
      'media_task_events',
      'media_task_items',
      'media_task_outputs',
      'media_tasks',
    ])
    expect(raw.prepare(
      'SELECT execution_mode FROM media_tasks WHERE id = ?',
    ).get(taskId)).toEqual({ execution_mode: 'inline_v1' })

    expect(() => raw.prepare(
      `UPDATE media_tasks SET status = 'not-a-status' WHERE id = ?`,
    ).run(taskId)).toThrow()
    expect(() => raw.prepare(
      `UPDATE media_tasks SET execution_mode = 'not-a-mode' WHERE id = ?`,
    ).run(taskId)).toThrow()

    expect(raw.prepare(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    ).get('table', 'media_provider_jobs')).toEqual({ name: 'media_provider_jobs' })
    expect(raw.prepare(
      'SELECT name FROM schema_migrations WHERE version = 49',
    ).get()).toEqual({ name: 'media_provider_jobs' })
  })

  it('backfills the exact model for old jobs and prevents later snapshot changes', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw, 99)
      seedMediaDependencies(raw)
      const id = insertLegacyMediaTask(raw, 'snapshot')
      insertProviderJob(raw, id, 'submission-snapshot', 'jobs/snapshot')
      const task = raw.prepare('SELECT upstream_model FROM media_tasks WHERE id=?').get(id) as any
      applyMigrations(raw, 100)
      expect(raw.prepare('SELECT provider_model FROM media_provider_jobs WHERE task_id=?').get(id)).toEqual({ provider_model: task.upstream_model })
      expect(() => raw.prepare('UPDATE media_provider_jobs SET provider_model=? WHERE task_id=?').run('changed', id)).toThrow('media_provider_model_immutable')
    } finally { raw.close() }
  })

  it('rejects invalid phases and duplicate provider identities', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    seedMediaDependencies(raw)
    const firstTaskId = insertLegacyMediaTask(raw, '1')
    const secondTaskId = insertLegacyMediaTask(raw, '2')
    const thirdTaskId = insertLegacyMediaTask(raw, '3')

    expect(() => raw.prepare(
      `INSERT INTO media_provider_jobs (
         task_id, provider_account_id, submission_key, phase,
         next_action_at_ms, deadline_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, 'account-schema', 'submission-invalid', 'invalid', 1, 1000, 1, 1)`,
    ).run(firstTaskId)).toThrow()

    insertProviderJob(raw, firstTaskId, 'submission-0001', 'jobs/provider-0001')
    expect(() => insertProviderJob(
      raw,
      secondTaskId,
      'submission-0001',
      'jobs/provider-0002',
    )).toThrow()
    expect(() => insertProviderJob(
      raw,
      thirdTaskId,
      'submission-0003',
      'jobs/provider-0001',
    )).toThrow()
  })

  it('enforces bounded recovery state and provider item record metadata', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    seedMediaDependencies(raw)
    const taskId = insertLegacyMediaTask(raw, '1')
    insertProviderJob(raw, taskId, 'submission-0001')

    expect(() => raw.prepare(
      'UPDATE media_provider_jobs SET result_complete = 2 WHERE task_id = ?',
    ).run(taskId)).toThrow()
    expect(() => raw.prepare(
      'UPDATE media_provider_jobs SET provider_raw_state = ? WHERE task_id = ?',
    ).run('x'.repeat(257), taskId)).toThrow()
    expect(() => raw.prepare(
      `UPDATE media_provider_jobs
          SET lease_token = 'short', lease_expires_at_ms = 10
        WHERE task_id = ?`,
    ).run(taskId)).toThrow()

    raw.prepare(
      `INSERT INTO media_task_items (
         task_id, custom_id, ordinal, status, output_count, request_hash,
         created_at_ms, provider_record_object_key, provider_record_sha256,
         provider_record_ordinal
       ) VALUES (?, 'item-1', 0, 'queued', 1, ?, 1, ?, ?, 0)`,
    ).run(
      taskId,
      'c'.repeat(64),
      'media/provider-records/record-0001.json',
      'd'.repeat(64),
    )
    expect(() => raw.prepare(
      `UPDATE media_task_items SET provider_record_ordinal = 200
        WHERE task_id = ? AND custom_id = 'item-1'`,
    ).run(taskId)).toThrow()
  })

  it('indexes due recovery and leases and cascades provider jobs with tasks', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    seedMediaDependencies(raw)
    const taskId = insertLegacyMediaTask(raw, '1')
    insertProviderJob(raw, taskId, 'submission-0001')

    const indexes = raw.prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'media_provider_jobs'
        ORDER BY name`,
    ).all() as Array<{ name: string; sql: string | null }>
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'idx_media_provider_jobs_lease',
      'idx_media_provider_jobs_provider_identity',
      'idx_media_provider_jobs_recovery',
    ]))
    expect(indexes.find(({ name }) => name === 'idx_media_provider_jobs_recovery')?.sql)
      .toContain('next_action_at_ms, phase, task_id')
    expect(indexes.find(({ name }) => name === 'idx_media_provider_jobs_recovery')?.sql)
      .toContain("WHERE phase <> 'done'")

    raw.prepare('DELETE FROM media_tasks WHERE id = ?').run(taskId)
    expect(raw.prepare(
      'SELECT task_id FROM media_provider_jobs WHERE task_id = ?',
    ).get(taskId)).toBeUndefined()
  })
})
