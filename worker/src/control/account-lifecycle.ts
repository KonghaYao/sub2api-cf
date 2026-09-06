import type { Env, PlatformEvent } from '../env'
import { decryptCredential, sha256Hex } from '../gateway/crypto'
import {
  buildProviderHealthRequest,
  type ProviderAuthScheme,
  type ProviderConfig,
  type ProviderPlatform,
  type ProviderProtocol,
} from '../gateway/providers'
import { credentialAad } from '../gateway/repository'
import { poolStateName } from '../gateway/state-client'
import type { GatewayEndpoint } from '../gateway/types'

const PROBE_INTERVAL_MS = 5 * 60_000
const FAILURE_BACKOFF_BASE_MS = 60_000
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000
const ACCOUNT_CLAIM_LEASE_MS = 2 * 60_000
const CONSUMER_LEASE_MS = 30_000
const TERMINAL_RETRY_MS = 5 * 60_000
const MAX_PROCESSING_ATTEMPTS = 5
const MAX_DISPATCH_ATTEMPTS = 8
// Five pending deliveries plus five new claims keep the minute Cron comfortably
// below the Workers Free subrequest ceiling even when every claim needs all four
// D1/outbox operations. Operators can raise the bounded options in tests or a
// future paid-plan configuration without changing the state machine.
const DEFAULT_PAGE_SIZE = 5
const DEFAULT_MAX_PAGES = 1
const POOL_TARGET_PAGE_SIZE = 10

export interface AccountHealthProbePayload {
  job_id: string
  account_id: string
  generation: number
}

export type AccountHealthProbeEvent = PlatformEvent<AccountHealthProbePayload>

export interface AccountHealthScheduleOptions {
  pageSize?: number
  maxPages?: number
}

export interface AccountHealthScheduleResult {
  recovered: number
  claimed: number
  dispatched: number
}

interface DueAccountRow {
  id: string
  config_version: number
  credential_ref: string
  health_probe_generation: number
}

interface DispatchJobRow {
  id: string
  account_id: string
  generation: number
  status: 'queued' | 'probed'
  dispatch_attempts: number
  created_at_ms: number
}

interface ProbeJobRow {
  id: string
  account_id: string
  generation: number
  config_version: number
  credential_ref: string
  status: 'queued' | 'probing' | 'probed' | 'completed' | 'stale' | 'failed'
  processing_attempts: number
  dispatch_attempts: number
  next_dispatch_at_ms: number
  run_token: string | null
  run_lease_until_ms: number | null
  health_status: 'healthy' | 'unhealthy' | null
  account_health_revision: number | null
  pool_revision: number | null
  pool_sync_cursor_json: string | null
}

interface ProbeAccountRow {
  id: string
  platform: ProviderPlatform
  protocol: ProviderProtocol
  auth_scheme: ProviderAuthScheme
  base_url: string
  provider_config_json: string
  config_version: number
  credential_ref: string
  health_probe_generation: number
  consecutive_health_failures: number
  secret_id: string
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
}

interface PoolTargetRow {
  group_id: string
  model_id: string
  endpoint: GatewayEndpoint
}

interface PoolMemberRow {
  account_id: string
  max_concurrency: number
  priority: number
  weight: number
}

interface RevisionRow {
  revision: number
}

interface ProbeResult {
  healthStatus: 'healthy' | 'unhealthy'
  healthError: string | null
  checkedAtMs: number
  latencyMs: number
}

/**
 * Claims due accounts and dispatches durable, credential-free Queue messages.
 * Repeated Cron invocations are safe: claims use account generation CAS and the
 * outbox has one row per account/generation.
 */
export async function scheduleAccountHealthLifecycle(
  env: Env,
  nowMs = Date.now(),
  options: AccountHealthScheduleOptions = {},
): Promise<AccountHealthScheduleResult> {
  assertTimestamp(nowMs)
  const pageSize = boundedOption(options.pageSize, DEFAULT_PAGE_SIZE, 1, 100)
  const maxPages = boundedOption(options.maxPages, DEFAULT_MAX_PAGES, 1, 20)
  const recovered = await recoverAbandonedJobs(env, nowMs)
  let dispatched = await dispatchPendingJobs(env, nowMs, pageSize, maxPages)
  let claimed = 0

  for (let page = 0; page < maxPages; page += 1) {
    const due = await env.DB.prepare(
      `SELECT a.id, a.config_version, a.credential_ref, a.health_probe_generation
         FROM accounts a
        WHERE a.enabled = 1
          AND a.next_health_probe_at_ms <= ?
          AND (a.health_probe_lease_until_ms IS NULL OR a.health_probe_lease_until_ms <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM account_health_probes probe
             WHERE probe.account_id = a.id
               AND probe.status IN ('queued', 'probing', 'probed')
          )
        ORDER BY a.next_health_probe_at_ms ASC, a.id ASC
        LIMIT ?`,
    ).bind(nowMs, nowMs, pageSize).all<DueAccountRow>()
    if (due.results.length === 0) break

    for (const account of due.results) {
      validateDueAccount(account)
      const generation = incrementSafe(account.health_probe_generation, 'health probe generation')
      const jobId = healthJobId(account.id, generation)
      const leaseUntilMs = addTimestamp(nowMs, ACCOUNT_CLAIM_LEASE_MS)
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE accounts
              SET health_probe_generation = ?, health_probe_lease_until_ms = ?,
                  next_health_probe_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
            WHERE id = ? AND enabled = 1 AND config_version = ?
              AND credential_ref = ? AND health_probe_generation = ?
              AND next_health_probe_at_ms <= ?
              AND (health_probe_lease_until_ms IS NULL OR health_probe_lease_until_ms <= ?)
              AND NOT EXISTS (
                SELECT 1 FROM account_health_probes probe
                 WHERE probe.account_id = accounts.id
                   AND probe.status IN ('queued', 'probing', 'probed')
              )`,
        ).bind(
          generation,
          leaseUntilMs,
          leaseUntilMs,
          nowMs,
          account.id,
          account.config_version,
          account.credential_ref,
          account.health_probe_generation,
          nowMs,
          nowMs,
        ),
        env.DB.prepare(
          `INSERT OR IGNORE INTO account_health_probes (
             id, account_id, generation, config_version, credential_ref,
             status, next_dispatch_at_ms, created_at_ms, updated_at_ms
           )
           SELECT ?, id, ?, config_version, credential_ref, 'queued', ?, ?, ?
             FROM accounts
            WHERE id = ? AND enabled = 1 AND config_version = ?
              AND credential_ref = ? AND health_probe_generation = ?`,
        ).bind(
          jobId,
          generation,
          nowMs,
          nowMs,
          nowMs,
          account.id,
          account.config_version,
          account.credential_ref,
          generation,
        ),
      ])
      const job = await findJob(env, jobId)
      if (job === null || job.status !== 'queued' || job.generation !== generation) continue
      claimed += 1
      if (await dispatchJob(env, job, nowMs)) dispatched += 1
    }
    if (due.results.length < pageSize) break
  }

  return { recovered, claimed, dispatched }
}

/** Queue consumer entry. Provider failures are probe results, not Queue errors. */
export async function consumeAccountHealthProbe(
  event: AccountHealthProbeEvent,
  env: Env,
  nowMs = Date.now(),
): Promise<void> {
  assertTimestamp(nowMs)
  if (event.payload.job_id !== healthJobId(event.payload.account_id, event.payload.generation)) return
  let job = await findJob(env, event.payload.job_id)
  if (job === null || terminalStatus(job.status)) return
  if (
    job.account_id !== event.payload.account_id ||
    job.generation !== event.payload.generation
  ) {
    await markJobStale(env, job.id, null, nowMs)
    return
  }
  if (job.status === 'probed') {
    await finishPoolSyncOrReschedule(env, job, nowMs)
    return
  }
  if (job.status === 'probing' && (job.run_lease_until_ms ?? 0) > nowMs) {
    // Another at-least-once delivery owns the short consumer lease.
    return
  }
  if (job.processing_attempts >= MAX_PROCESSING_ATTEMPTS) {
    await failJob(env, job, nowMs, 'Probe processing attempts exhausted')
    return
  }

  const runToken = crypto.randomUUID()
  const claimed = await env.DB.prepare(
    `UPDATE account_health_probes
        SET status = 'probing', processing_attempts = processing_attempts + 1,
            run_token = ?, run_lease_until_ms = ?, updated_at_ms = ?,
            last_internal_error = NULL
      WHERE id = ? AND processing_attempts < ?
        AND (
          status = 'queued'
          OR (status = 'probing' AND run_lease_until_ms <= ?)
        )`,
  ).bind(
    runToken,
    addTimestamp(nowMs, CONSUMER_LEASE_MS),
    nowMs,
    job.id,
    MAX_PROCESSING_ATTEMPTS,
    nowMs,
  ).run()
  if (claimed.meta.changes !== 1) return

  try {
    const account = await loadProbeAccount(env, job.id, runToken)
    if (account === null) {
      await markJobStale(env, job.id, runToken, nowMs)
      return
    }
    const probe = await runProviderProbe(env, account, nowMs)
    job = await persistProbeResult(env, job, account, runToken, probe)
    if (job.status !== 'probed') return
    await finishPoolSyncOrReschedule(env, job, probe.checkedAtMs)
  } catch (error) {
    const released = await env.DB.prepare(
      `UPDATE account_health_probes
          SET status = CASE WHEN processing_attempts >= ? THEN 'failed' ELSE 'queued' END,
              run_token = NULL, run_lease_until_ms = NULL,
              next_dispatch_at_ms = ?, updated_at_ms = ?,
              last_internal_error = ?
        WHERE id = ? AND status = 'probing' AND run_token = ?`,
    ).bind(
      MAX_PROCESSING_ATTEMPTS,
      addTimestamp(nowMs, processingBackoffMs(job.processing_attempts + 1)),
      nowMs,
      internalFailureLabel(error),
      job.id,
      runToken,
    ).run()
    if (released.meta.changes !== 1) throw error
    if (job.processing_attempts + 1 >= MAX_PROCESSING_ATTEMPTS) {
      await env.DB.prepare(
        `UPDATE accounts SET health_probe_lease_until_ms = NULL,
            next_health_probe_at_ms = ?
          WHERE id = ? AND health_probe_generation = ?`,
      ).bind(
        addTimestamp(nowMs, TERMINAL_RETRY_MS),
        job.account_id,
        job.generation,
      ).run()
    }
  }
}

export function isAccountHealthProbeEvent(value: unknown): value is AccountHealthProbeEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<PlatformEvent<Partial<AccountHealthProbePayload>>>
  const payload = event.payload
  if (
    event.schema_version !== 1 ||
    event.event_type !== 'account.health.probe.v1' ||
    event.aggregate_type !== 'account' ||
    typeof event.aggregate_id !== 'string' ||
    typeof event.event_id !== 'string' ||
    !Number.isSafeInteger(event.occurred_at_ms) ||
    (event.occurred_at_ms as number) < 0 ||
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).some((key) => !['job_id', 'account_id', 'generation'].includes(key)) ||
    typeof payload.job_id !== 'string' || payload.job_id.length === 0 || payload.job_id.length > 512 ||
    typeof payload.account_id !== 'string' || payload.account_id.length === 0 || payload.account_id.length > 256 ||
    !Number.isSafeInteger(payload.generation) || (payload.generation as number) <= 0
  ) return false
  return event.aggregate_id === payload.account_id &&
    payload.job_id === healthJobId(payload.account_id, payload.generation as number) &&
    event.event_id === `account-health:${payload.job_id}`
}

function createHealthEvent(job: DispatchJobRow, nowMs: number): AccountHealthProbeEvent {
  return {
    schema_version: 1,
    event_id: `account-health:${job.id}`,
    event_type: 'account.health.probe.v1',
    occurred_at_ms: nowMs,
    aggregate_type: 'account',
    aggregate_id: job.account_id,
    payload: {
      job_id: job.id,
      account_id: job.account_id,
      generation: job.generation,
    },
  }
}

/**
 * Best-effort immediate delivery for a probe job already committed to the D1
 * outbox. A failed send remains recoverable by the normal Cron dispatcher.
 */
export async function dispatchAccountHealthProbeJobs(
  env: Env,
  jobs: Array<{ job_id: string; account_id: string; generation: number }>,
  nowMs = Date.now(),
): Promise<number> {
  assertTimestamp(nowMs)
  if (jobs.length === 0) return 0
  if (jobs.length > 25) throw new Error('Account health dispatch batch is too large')
  const outcomes: Array<{ id: string; error: string | null }> = []
  let sent = 0
  for (const job of jobs) {
    if (
      !positiveSafeInteger(job.generation) ||
      job.job_id !== healthJobId(job.account_id, job.generation)
    ) throw new Error('Account health job identity is invalid')
    let error: string | null = null
    try {
      await env.EVENTS_QUEUE.send(createHealthEvent({
        id: job.job_id,
        account_id: job.account_id,
        generation: job.generation,
        status: 'queued',
        dispatch_attempts: 0,
        created_at_ms: nowMs,
      }, nowMs))
      sent += 1
    } catch {
      error = 'Queue dispatch failed'
    }
    outcomes.push({ id: job.job_id, error })
  }
  const errorCases = outcomes.map(() => 'WHEN ? THEN ?').join(' ')
  const ids = outcomes.map(() => '?').join(', ')
  await env.DB.prepare(
    `UPDATE account_health_probes
        SET dispatch_attempts = dispatch_attempts + 1,
            next_dispatch_at_ms = ?, updated_at_ms = ?,
            last_internal_error = CASE id ${errorCases} ELSE last_internal_error END
      WHERE id IN (${ids}) AND status = 'queued'
        AND dispatch_attempts = 0 AND dispatch_attempts < ?`,
  ).bind(
    addTimestamp(nowMs, dispatchBackoffMs(1)), nowMs,
    ...outcomes.flatMap((outcome) => [outcome.id, outcome.error]),
    ...outcomes.map((outcome) => outcome.id),
    MAX_DISPATCH_ATTEMPTS,
  ).run()
  return sent
}

async function recoverAbandonedJobs(env: Env, nowMs: number): Promise<number> {
  const requeued = await env.DB.prepare(
      `UPDATE account_health_probes
          SET status = 'queued', run_token = NULL, run_lease_until_ms = NULL,
              next_dispatch_at_ms = ?, updated_at_ms = ?,
              last_internal_error = 'Expired consumer lease recovered'
        WHERE status = 'probing' AND run_lease_until_ms <= ?
          AND processing_attempts < ?`,
    ).bind(nowMs, nowMs, nowMs, MAX_PROCESSING_ATTEMPTS).run()
  const processingFailed = await env.DB.prepare(
      `UPDATE account_health_probes
          SET status = 'failed', run_token = NULL, run_lease_until_ms = NULL,
              updated_at_ms = ?, last_internal_error = 'Probe processing attempts exhausted'
        WHERE status = 'probing' AND run_lease_until_ms <= ?
          AND processing_attempts >= ?`,
    ).bind(nowMs, nowMs, MAX_PROCESSING_ATTEMPTS).run()
  const dispatchFailed = await env.DB.prepare(
      `UPDATE account_health_probes
          SET status = 'failed', updated_at_ms = ?,
              last_internal_error = 'Queue dispatch attempts exhausted'
        WHERE status IN ('queued', 'probed') AND next_dispatch_at_ms <= ?
          AND dispatch_attempts >= ?`,
    ).bind(nowMs, nowMs, MAX_DISPATCH_ATTEMPTS).run()
  await env.DB.prepare(
    `UPDATE accounts
        SET health_probe_lease_until_ms = NULL,
            next_health_probe_at_ms = CASE
              WHEN EXISTS (
                SELECT 1 FROM account_health_probes failed
                 WHERE failed.account_id = accounts.id
                   AND failed.generation = accounts.health_probe_generation
                   AND failed.status = 'failed' AND failed.health_status IS NULL
              ) THEN ? ELSE next_health_probe_at_ms END
      WHERE EXISTS (
        SELECT 1 FROM account_health_probes failed
         WHERE failed.account_id = accounts.id
           AND failed.generation = accounts.health_probe_generation
           AND failed.status = 'failed'
      )`,
  ).bind(addTimestamp(nowMs, TERMINAL_RETRY_MS)).run()
  return changes(requeued) + changes(processingFailed) + changes(dispatchFailed)
}

async function dispatchPendingJobs(
  env: Env,
  nowMs: number,
  pageSize: number,
  maxPages: number,
): Promise<number> {
  let dispatched = 0
  for (let page = 0; page < maxPages; page += 1) {
    const result = await env.DB.prepare(
      `SELECT id, account_id, generation, status, dispatch_attempts, created_at_ms
         FROM account_health_probes
        WHERE status IN ('queued', 'probed') AND next_dispatch_at_ms <= ?
          AND dispatch_attempts < ?
        ORDER BY next_dispatch_at_ms ASC, created_at_ms ASC, id ASC
        LIMIT ?`,
    ).bind(nowMs, MAX_DISPATCH_ATTEMPTS, pageSize).all<DispatchJobRow>()
    if (result.results.length === 0) break
    for (const job of result.results) {
      validateDispatchJob(job)
      if (await dispatchJob(env, job, nowMs)) dispatched += 1
    }
    if (result.results.length < pageSize) break
  }
  return dispatched
}

async function dispatchJob(env: Env, job: DispatchJobRow | ProbeJobRow, nowMs: number): Promise<boolean> {
  const attempts = job.dispatch_attempts + 1
  let sent = false
  try {
    await env.EVENTS_QUEUE.send(createHealthEvent({
      id: job.id,
      account_id: job.account_id,
      generation: job.generation,
      status: job.status === 'probed' ? 'probed' : 'queued',
      dispatch_attempts: job.dispatch_attempts,
      created_at_ms: 'created_at_ms' in job ? job.created_at_ms : nowMs,
    }, nowMs))
    sent = true
  } catch {
    // The outbox row remains dispatchable; no Queue or provider error text is persisted.
  }
  await env.DB.prepare(
    `UPDATE account_health_probes
        SET dispatch_attempts = dispatch_attempts + 1, next_dispatch_at_ms = ?,
            updated_at_ms = ?, last_internal_error = ?
      WHERE id = ? AND status = ? AND dispatch_attempts = ? AND dispatch_attempts < ?`,
  ).bind(
    addTimestamp(nowMs, dispatchBackoffMs(attempts)),
    nowMs,
    sent ? null : 'Queue dispatch failed',
    job.id,
    job.status,
    job.dispatch_attempts,
    MAX_DISPATCH_ATTEMPTS,
  ).run()
  return sent
}

async function loadProbeAccount(env: Env, jobId: string, runToken: string): Promise<ProbeAccountRow | null> {
  return env.DB.prepare(
    `SELECT a.id, a.platform, a.protocol, a.auth_scheme, a.base_url,
            a.provider_config_json, a.config_version, a.credential_ref,
            a.health_probe_generation, a.consecutive_health_failures,
            secret.id AS secret_id, secret.key_version,
            secret.nonce_b64, secret.ciphertext_b64
       FROM account_health_probes probe
       JOIN accounts a ON a.id = probe.account_id
       JOIN account_secrets secret
         ON secret.id = a.credential_ref AND secret.account_id = a.id
      WHERE probe.id = ? AND probe.status = 'probing' AND probe.run_token = ?
        AND a.enabled = 1 AND a.config_version = probe.config_version
        AND a.credential_ref = probe.credential_ref
        AND a.health_probe_generation = probe.generation`,
  ).bind(jobId, runToken).first<ProbeAccountRow>()
}

async function runProviderProbe(env: Env, account: ProbeAccountRow, startedAtMs: number): Promise<ProbeResult> {
  let plan: ReturnType<typeof buildProviderHealthRequest>
  try {
    const config = parseProviderConfig(account.provider_config_json)
    const credential = await decryptCredential(
      account.nonce_b64,
      account.ciphertext_b64,
      requireCredentialsMasterKey(env),
      credentialAad(env.ENVIRONMENT, account.id, account.secret_id, account.key_version),
    )
    plan = buildProviderHealthRequest({
      account: {
        platform: account.platform,
        protocol: account.protocol,
        auth_scheme: account.auth_scheme,
        base_url: account.base_url,
        provider_config: config,
      },
      credential,
    })
  } catch {
    const checkedAtMs = Math.max(startedAtMs, Date.now())
    return {
      healthStatus: 'unhealthy',
      healthError: 'Upstream credential or provider configuration is unavailable',
      checkedAtMs,
      latencyMs: Math.max(0, checkedAtMs - startedAtMs),
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), plan.timeout_ms)
  let healthStatus: ProbeResult['healthStatus'] = 'unhealthy'
  let healthError: string | null = null
  try {
    const response = await fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (response.ok) healthStatus = 'healthy'
    else healthError = `Upstream returned HTTP ${response.status}`
    try {
      await response.body?.cancel()
    } catch {
      // Body cleanup must never replace the already observed health result.
    }
  } catch (error) {
    healthError = error instanceof DOMException && error.name === 'AbortError'
      ? 'Upstream probe timed out'
      : 'Upstream probe failed'
  } finally {
    clearTimeout(timer)
  }
  const checkedAtMs = Math.max(startedAtMs, Date.now())
  return {
    healthStatus,
    healthError,
    checkedAtMs,
    latencyMs: Math.max(0, checkedAtMs - startedAtMs),
  }
}

async function persistProbeResult(
  env: Env,
  job: ProbeJobRow,
  account: ProbeAccountRow,
  runToken: string,
  result: ProbeResult,
): Promise<ProbeJobRow> {
  const failureCount = result.healthStatus === 'healthy'
    ? 0
    : incrementSafe(account.consecutive_health_failures, 'consecutive health failures')
  const nextProbeAtMs = addTimestamp(
    result.checkedAtMs,
    result.healthStatus === 'healthy' ? PROBE_INTERVAL_MS : healthFailureBackoffMs(failureCount),
  )
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts
          SET health_status = ?, last_checked_at_ms = ?, last_latency_ms = ?,
              last_health_error = ?, consecutive_health_failures = ?,
              next_health_probe_at_ms = ?, health_probe_lease_until_ms = NULL,
              health_revision = health_revision + 1,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND enabled = 1 AND config_version = ? AND credential_ref = ?
          AND health_probe_generation = ?
          AND EXISTS (
            SELECT 1 FROM account_health_probes probe
             WHERE probe.id = ? AND probe.status = 'probing' AND probe.run_token = ?
          )`,
    ).bind(
      result.healthStatus,
      result.checkedAtMs,
      result.latencyMs,
      result.healthError,
      failureCount,
      nextProbeAtMs,
      result.checkedAtMs,
      account.id,
      job.config_version,
      job.credential_ref,
      job.generation,
      job.id,
      runToken,
    ),
    env.DB.prepare(
      `UPDATE account_health_probes
          SET status = 'probed', run_token = NULL, run_lease_until_ms = NULL,
              health_status = ?, checked_at_ms = ?, latency_ms = ?, health_error = ?,
              account_health_revision = (
                SELECT health_revision FROM accounts WHERE id = account_health_probes.account_id
              ),
              pool_revision = (
                SELECT revision FROM gateway_config_revision WHERE singleton = 1
              ),
              next_dispatch_at_ms = ?, updated_at_ms = ?, last_internal_error = NULL
        WHERE id = ? AND status = 'probing' AND run_token = ?
          AND EXISTS (
            SELECT 1 FROM accounts a
             WHERE a.id = account_health_probes.account_id AND a.enabled = 1
               AND a.config_version = account_health_probes.config_version
               AND a.credential_ref = account_health_probes.credential_ref
               AND a.health_probe_generation = account_health_probes.generation
               AND a.last_checked_at_ms = ?
          )`,
    ).bind(
      result.healthStatus,
      result.checkedAtMs,
      result.latencyMs,
      result.healthError,
      result.checkedAtMs,
      result.checkedAtMs,
      job.id,
      runToken,
      result.checkedAtMs,
    ),
  ])
  const persisted = await findJob(env, job.id)
  if (persisted?.status === 'probing') {
    await markJobStale(env, job.id, runToken, result.checkedAtMs)
    return (await findJob(env, job.id)) ?? persisted
  }
  if (persisted === null) throw new Error('Account health probe job disappeared')
  return persisted
}

async function finishPoolSyncOrReschedule(env: Env, job: ProbeJobRow, nowMs: number): Promise<void> {
  try {
    await syncAffectedPools(env, job)
  } catch {
    await env.DB.prepare(
      `UPDATE account_health_probes
          SET next_dispatch_at_ms = ?, updated_at_ms = ?,
              last_internal_error = 'Pool state synchronization failed'
        WHERE id = ? AND status = 'probed'`,
    ).bind(
      addTimestamp(nowMs, dispatchBackoffMs(job.dispatch_attempts + 1)),
      nowMs,
      job.id,
    ).run()
  }
}

async function syncAffectedPools(env: Env, job: ProbeJobRow): Promise<void> {
  if (job.account_health_revision === null || job.pool_revision === null) {
    throw new Error('Account health probe result is incomplete')
  }
  const nowMs = Date.now()
  const cursor = parsePoolSyncCursor(job.pool_sync_cursor_json)
  const page = await loadPoolTargetPage(env, job, cursor)
  if (page === null) {
    await markJobStale(env, job.id, null, nowMs)
    return
  }
  const statements = [
    env.DB.prepare('SELECT revision FROM gateway_config_revision WHERE singleton = 1'),
    ...page.targets.map((target) => poolMembersStatement(env, target)),
  ]
  const snapshot = await env.DB.batch(statements)
  const revision = snapshot[0]?.results[0] as RevisionRow | undefined
  if (!positiveSafeInteger(revision?.revision)) throw new Error('Gateway config revision is invalid')
  const poolRevision = revision.revision

  // A prior page belongs to an older routing snapshot. Restart from the first
  // target in a later Queue invocation rather than multiplying work here.
  if (cursor !== null && job.pool_revision !== poolRevision) {
    if (await persistPoolProgress(env, job.id, poolRevision, null, nowMs)) {
      await dispatchPoolContinuation(env, job, nowMs)
    }
    return
  }

  for (const [index, target] of page.targets.entries()) {
    const members = snapshot[index + 1]?.results as unknown as PoolMemberRow[]
    validatePoolMembers(members)
    await syncPoolSnapshot(env, target, poolRevision, members)
  }
  const after = await env.DB.prepare(
    `SELECT revision FROM gateway_config_revision WHERE singleton = 1`,
  ).first<RevisionRow>()
  if (!positiveSafeInteger(after?.revision)) throw new Error('Gateway config revision is invalid')
  if (after.revision !== poolRevision) {
    if (await persistPoolProgress(env, job.id, after.revision, null, nowMs)) {
      await dispatchPoolContinuation(env, job, nowMs)
    }
    return
  }
  if (page.hasMore) {
    const nextCursor = page.targets.at(-1)
    if (nextCursor === undefined) throw new Error('Pool target page is empty')
    if (await persistPoolProgress(env, job.id, poolRevision, nextCursor, nowMs)) {
      await dispatchPoolContinuation(env, job, nowMs)
    }
    return
  }

  const completed = await env.DB.prepare(
    `UPDATE account_health_probes
        SET status = 'completed', pool_revision = ?, pool_sync_cursor_json = NULL,
            next_dispatch_at_ms = ?, updated_at_ms = ?, last_internal_error = NULL
      WHERE id = ? AND status = 'probed'
        AND ? = (SELECT revision FROM gateway_config_revision WHERE singleton = 1)
        AND EXISTS (
          SELECT 1 FROM accounts a
           WHERE a.id = account_health_probes.account_id AND a.enabled = 1
             AND a.config_version = account_health_probes.config_version
             AND a.credential_ref = account_health_probes.credential_ref
             AND a.health_probe_generation = account_health_probes.generation
             AND a.health_revision = account_health_probes.account_health_revision
        )`,
  ).bind(poolRevision, nowMs, nowMs, job.id, poolRevision).run()
  if (completed.meta.changes === 1) return
  const restarted = await env.DB.prepare(
    `UPDATE account_health_probes
        SET pool_revision = (
              SELECT revision FROM gateway_config_revision WHERE singleton = 1
            ),
            pool_sync_cursor_json = NULL, next_dispatch_at_ms = ?,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ? AND status = 'probed'
        AND EXISTS (
          SELECT 1 FROM accounts a
           WHERE a.id = account_health_probes.account_id AND a.enabled = 1
             AND a.config_version = account_health_probes.config_version
             AND a.credential_ref = account_health_probes.credential_ref
             AND a.health_probe_generation = account_health_probes.generation
             AND a.health_revision = account_health_probes.account_health_revision
        )`,
  ).bind(nowMs, nowMs, job.id).run()
  if (restarted.meta.changes === 1) {
    await dispatchPoolContinuation(env, job, nowMs)
    return
  }
  await markJobStale(env, job.id, null, nowMs)
}

async function loadPoolTargetPage(
  env: Env,
  job: ProbeJobRow,
  cursor: PoolTargetRow | null,
): Promise<{ targets: PoolTargetRow[]; hasMore: boolean } | null> {
  const current = await env.DB.prepare(
    `SELECT 1 AS current
       FROM accounts a
      WHERE a.id = ? AND a.enabled = 1 AND a.config_version = ?
        AND a.credential_ref = ? AND a.health_probe_generation = ?
        AND a.health_revision = ?`,
  ).bind(
    job.account_id,
    job.config_version,
    job.credential_ref,
    job.generation,
    job.account_health_revision,
  ).first<{ current: number }>()
  if (current === null) return null
  const result = await env.DB.prepare(
    `SELECT DISTINCT ag.group_id, am.model_id, am.endpoint
       FROM (
         SELECT account_id, model_id, 'chat_completions' AS endpoint
           FROM account_models WHERE chat_completions = 1
         UNION ALL
         SELECT account_id, model_id, 'responses' AS endpoint
           FROM account_models WHERE responses = 1
         UNION ALL
         SELECT account_id, model_id, 'embeddings' AS endpoint
           FROM account_models WHERE embeddings = 1
         UNION ALL
         SELECT account_id, model_id, 'images' AS endpoint
           FROM account_models WHERE image_generation = 1
       ) am
       JOIN account_groups ag ON ag.account_id = am.account_id
       JOIN accounts a ON a.id = am.account_id
       JOIN "groups" g ON g.id = ag.group_id
       JOIN models m ON m.id = am.model_id AND m.platform = a.platform
       JOIN group_models gm ON gm.group_id = ag.group_id AND gm.model_id = am.model_id
      WHERE a.id = ? AND a.enabled = 1 AND g.enabled = 1 AND m.enabled = 1 AND gm.enabled = 1
        AND (g.platform = a.platform OR g.platform = 'composite')
        AND (am.endpoint <> 'images' OR m.image_generation = 1)
        AND (? IS NULL OR (ag.group_id, am.model_id, am.endpoint) > (?, ?, ?))
      ORDER BY ag.group_id ASC, am.model_id ASC, am.endpoint ASC
      LIMIT ?`,
  ).bind(
    job.account_id,
    cursor?.group_id ?? null,
    cursor?.group_id ?? '',
    cursor?.model_id ?? '',
    cursor?.endpoint ?? '',
    POOL_TARGET_PAGE_SIZE + 1,
  ).all<PoolTargetRow>()
  for (const target of result.results) validatePoolTarget(target)
  return {
    targets: result.results.slice(0, POOL_TARGET_PAGE_SIZE),
    hasMore: result.results.length > POOL_TARGET_PAGE_SIZE,
  }
}

async function persistPoolProgress(
  env: Env,
  jobId: string,
  revision: number,
  cursor: PoolTargetRow | null,
  nowMs: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE account_health_probes
        SET pool_revision = ?, pool_sync_cursor_json = ?, next_dispatch_at_ms = ?,
            updated_at_ms = MAX(updated_at_ms, ?), last_internal_error = NULL
      WHERE id = ? AND status = 'probed'`,
  ).bind(
    revision, cursor === null ? null : JSON.stringify(cursor), nowMs, nowMs, jobId,
  ).run()
  return result.meta.changes === 1
}

async function dispatchPoolContinuation(env: Env, job: ProbeJobRow, nowMs: number): Promise<void> {
  let sent = false
  try {
    await env.EVENTS_QUEUE.send(createHealthEvent({
      id: job.id,
      account_id: job.account_id,
      generation: job.generation,
      status: 'probed',
      dispatch_attempts: 0,
      created_at_ms: nowMs,
    }, nowMs))
    sent = true
  } catch {
    // The probed job remains a due outbox row for the normal Cron dispatcher.
  }
  await env.DB.prepare(
    `UPDATE account_health_probes
        SET dispatch_attempts = CASE WHEN ? = 1 THEN 0 ELSE MIN(dispatch_attempts + 1, ?) END,
            next_dispatch_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?),
            last_internal_error = CASE WHEN ? = 1 THEN NULL ELSE 'Queue dispatch failed' END
      WHERE id = ? AND status = 'probed'`,
  ).bind(
    sent ? 1 : 0,
    MAX_DISPATCH_ATTEMPTS,
    addTimestamp(nowMs, dispatchBackoffMs(sent ? 1 : job.dispatch_attempts + 1)),
    nowMs,
    sent ? 1 : 0,
    job.id,
  ).run()
}

function poolMembersStatement(env: Env, target: PoolTargetRow): D1PreparedStatement {
  const capability = target.endpoint === 'chat_completions'
    ? 'am.chat_completions'
    : target.endpoint === 'responses'
      ? 'am.responses'
      : target.endpoint === 'embeddings'
        ? 'am.embeddings'
        : 'am.image_generation'
  return env.DB.prepare(
    `SELECT a.id AS account_id, a.max_concurrency, ag.priority, ag.weight
       FROM account_groups ag
       JOIN accounts a ON a.id = ag.account_id
       JOIN account_models am ON am.account_id = a.id AND am.model_id = ?
       JOIN "groups" g ON g.id = ag.group_id
       JOIN models m ON m.id = am.model_id AND m.platform = a.platform
       JOIN group_models gm ON gm.group_id = ag.group_id AND gm.model_id = am.model_id
      WHERE ag.group_id = ? AND a.enabled = 1 AND a.health_status <> 'unhealthy'
        AND (g.platform = a.platform OR g.platform = 'composite')
        AND g.enabled = 1 AND m.enabled = 1 AND gm.enabled = 1 AND ${capability} = 1
      ORDER BY ag.priority ASC, a.id ASC`,
  ).bind(target.model_id, target.group_id)
}

async function syncPoolSnapshot(
  env: Env,
  target: PoolTargetRow,
  revision: number,
  members: PoolMemberRow[],
): Promise<void> {
  const configured = members.map((member) => ({
    account_id: member.account_id,
    max_concurrency: member.max_concurrency,
    priority: member.priority,
    weight: member.weight,
  }))
  const fingerprint = await sha256Hex(JSON.stringify(configured))
  const stub = env.POOL_STATE.get(env.POOL_STATE.idFromName(
    poolStateName(target.group_id, target.model_id, target.endpoint),
  ))
  const response = await stub.fetch(new Request('https://state.internal/accounts/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 1,
      config_revision: revision,
      config_fingerprint: fingerprint,
      accounts: configured,
    }),
  }))
  if (!response.ok) {
    try {
      await response.body?.cancel()
    } catch {
      // The status is sufficient and response text may contain untrusted data.
    }
    throw new Error('Pool state synchronization failed')
  }
}

async function markJobStale(
  env: Env,
  jobId: string,
  runToken: string | null,
  nowMs: number,
): Promise<void> {
  const tokenClause = runToken === null ? '' : ' AND run_token = ?'
  const values: unknown[] = [nowMs, jobId]
  if (runToken !== null) values.push(runToken)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_health_probes
          SET status = 'stale', run_token = NULL, run_lease_until_ms = NULL,
              updated_at_ms = ?, last_internal_error = NULL
        WHERE id = ? AND status IN ('queued', 'probing', 'probed')${tokenClause}`,
    ).bind(...values),
    env.DB.prepare(
      `UPDATE accounts SET health_probe_lease_until_ms = NULL
        WHERE id = (SELECT account_id FROM account_health_probes WHERE id = ?)
          AND health_probe_generation = (
            SELECT generation FROM account_health_probes WHERE id = ?
          )`,
    ).bind(jobId, jobId),
  ])
}

async function failJob(env: Env, job: ProbeJobRow, nowMs: number, reason: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_health_probes
          SET status = 'failed', run_token = NULL, run_lease_until_ms = NULL,
              updated_at_ms = ?, last_internal_error = ?
        WHERE id = ? AND status IN ('queued', 'probing', 'probed')`,
    ).bind(nowMs, reason, job.id),
    env.DB.prepare(
      `UPDATE accounts SET health_probe_lease_until_ms = NULL,
          next_health_probe_at_ms = ?
        WHERE id = ? AND health_probe_generation = ?`,
    ).bind(addTimestamp(nowMs, TERMINAL_RETRY_MS), job.account_id, job.generation),
  ])
}

async function findJob(env: Env, jobId: string): Promise<ProbeJobRow | null> {
  return env.DB.prepare(
    `SELECT id, account_id, generation, config_version, credential_ref, status,
            processing_attempts, dispatch_attempts, next_dispatch_at_ms,
            run_token, run_lease_until_ms, health_status,
            account_health_revision, pool_revision, pool_sync_cursor_json
       FROM account_health_probes WHERE id = ?`,
  ).bind(jobId).first<ProbeJobRow>()
}

function healthJobId(accountId: string, generation: number): string {
  return `${accountId}:health:${generation}`
}

function healthFailureBackoffMs(failureCount: number): number {
  const exponent = Math.min(10, Math.max(0, failureCount - 1))
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * (2 ** exponent))
}

function processingBackoffMs(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * (2 ** Math.min(6, Math.max(0, attempt - 1))))
}

function dispatchBackoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 15_000 * (2 ** Math.min(6, Math.max(0, attempt - 1))))
}

function internalFailureLabel(error: unknown): string {
  if (error instanceof Error && error.message === 'Account health probe job disappeared') {
    return 'Probe persistence failed'
  }
  return 'Probe processing failed'
}

function parseProviderConfig(value: string): ProviderConfig {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid provider config')
  }
  return parsed as ProviderConfig
}

function requireCredentialsMasterKey(env: Env): string {
  if (typeof env.CREDENTIALS_MASTER_KEY !== 'string' || env.CREDENTIALS_MASTER_KEY.length < 32) {
    throw new Error('Credentials master key is unavailable')
  }
  return env.CREDENTIALS_MASTER_KEY
}

function validateDueAccount(row: DueAccountRow): void {
  if (
    typeof row.id !== 'string' || row.id.length === 0 ||
    !positiveSafeInteger(row.config_version) ||
    typeof row.credential_ref !== 'string' || row.credential_ref.length === 0 ||
    !nonNegativeSafeInteger(row.health_probe_generation)
  ) throw new Error('Due account projection is invalid')
}

function validateDispatchJob(row: DispatchJobRow): void {
  if (
    typeof row.id !== 'string' || typeof row.account_id !== 'string' ||
    !positiveSafeInteger(row.generation) ||
    !nonNegativeSafeInteger(row.dispatch_attempts) ||
    !nonNegativeSafeInteger(row.created_at_ms) ||
    !['queued', 'probed'].includes(row.status)
  ) throw new Error('Account health dispatch projection is invalid')
}

function validatePoolTarget(row: PoolTargetRow): void {
  if (
    typeof row.group_id !== 'string' || row.group_id.length === 0 ||
    typeof row.model_id !== 'string' || row.model_id.length === 0 ||
    !['chat_completions', 'responses', 'embeddings', 'images'].includes(row.endpoint)
  ) throw new Error('Pool target projection is invalid')
}

function parsePoolSyncCursor(value: string | null): PoolTargetRow | null {
  if (value === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Pool synchronization cursor is invalid')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pool synchronization cursor is invalid')
  }
  const cursor = parsed as Record<string, unknown>
  if (
    Object.keys(cursor).some((key) => !['group_id', 'model_id', 'endpoint'].includes(key)) ||
    typeof cursor.group_id !== 'string' ||
    typeof cursor.model_id !== 'string' ||
    typeof cursor.endpoint !== 'string'
  ) throw new Error('Pool synchronization cursor is invalid')
  const target = cursor as unknown as PoolTargetRow
  validatePoolTarget(target)
  return target
}

function validatePoolMembers(rows: PoolMemberRow[]): void {
  if (rows.length > 10_000) throw new Error('Pool membership projection is too large')
  for (const row of rows) {
    if (
      typeof row.account_id !== 'string' || row.account_id.length === 0 ||
      !positiveSafeInteger(row.max_concurrency) ||
      !nonNegativeSafeInteger(row.priority) ||
      !positiveSafeInteger(row.weight)
    ) throw new Error('Pool membership projection is invalid')
  }
}

function terminalStatus(status: ProbeJobRow['status']): boolean {
  return status === 'completed' || status === 'stale' || status === 'failed'
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error('Account health scheduler option is invalid')
  }
  return normalized
}

function addTimestamp(value: number, delta: number): number {
  if (!nonNegativeSafeInteger(value) || !positiveSafeInteger(delta) || value > Number.MAX_SAFE_INTEGER - delta) {
    throw new Error('Account health timestamp exceeds the safe integer range')
  }
  return value + delta
}

function incrementSafe(value: number, field: string): number {
  if (!nonNegativeSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${field} exceeds the safe integer range`)
  }
  return value + 1
}

function assertTimestamp(value: number): void {
  if (!nonNegativeSafeInteger(value)) throw new Error('Account health timestamp is invalid')
}

function changes(result: D1Result<unknown> | undefined): number {
  return nonNegativeSafeInteger(result?.meta.changes) ? result!.meta.changes : 0
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
