import { sweepExpiredProxies } from '../control/proxy-expiry'
import { runDueScheduledTests } from '../control/scheduled-test-runner'
import { dispatchAccountInitializations } from '../control/account-initialization'
import { renewDueAccountTokens } from '../control/account-token-renewal'
import type { Env } from '../env'
import { recoverPendingSubscriptionState } from '../control/subscriptions'
import { scheduleAccountHealthLifecycle } from '../control/account-lifecycle'
import { recoverAccountSyntheticProbes } from '../control/account-synthetic-probes'
import { recoverPendingSettlements } from '../gateway/recovery'
import { recoverPendingPaymentFulfillments } from '../payment/fulfillment'
import { recoverExpiredPaymentOrders } from '../payment/orders'
import { recoverPendingRefundClawbacks } from '../payment/refunds'
import { cleanupExpiredOAuthState } from '../auth/oauth-identities'
import { recoverPendingAuthSourceGrantEffects } from '../auth/source-entitlements'
import { scanPaymentReconciliationIssues } from '../payment/reconciliation'
import { recoverPendingAffiliateRebates } from '../commercial/affiliate'
import { cleanupObservabilityR2Orphans, repairObservabilityPayloadMetadata } from '../observability/retention'
import { recoverPendingMediaTasks } from '../media/queue'
import { recoverPendingProviderMediaJobs } from '../media/provider-job'
import { recoverImageTasks } from '../media/image-task'
import { recoverAccountStatsRollups } from '../gateway/account-stats-rollup'
import { runAdminRequestAuditRetention } from '../control/request-audit-retention'

// These financial recovery paths perform several D1/DO operations per item.
// Keep each queue invocation independent; the original durable recovery rows
// and leases remain responsible for retries, ordering, and idempotency.
export const recoveryMaintenanceTasks = {
  proxy_expiry: (env: Env) => sweepExpiredProxies(env),
  scheduled_account_tests: (env: Env) => runDueScheduledTests(env),
  account_initialization: (env: Env) => dispatchAccountInitializations(env),
  account_token_renewal: (env: Env) => renewDueAccountTokens(env),
  settlements: (env: Env) => recoverPendingSettlements(env, 1),
  subscription_state: (env: Env) => recoverPendingSubscriptionState(env),
  auth_source_grant_effects: (env: Env) => recoverPendingAuthSourceGrantEffects(env, 1),
  payment_fulfillments: (env: Env) => recoverPendingPaymentFulfillments(env, 1),
  payment_order_expiry: (env: Env) => recoverExpiredPaymentOrders(env, 1),
  refund_clawbacks: (env: Env) => recoverPendingRefundClawbacks(env, 1),
  account_health_lifecycle: (env: Env) => scheduleAccountHealthLifecycle(env),
  account_synthetic_probes: (env: Env) => recoverAccountSyntheticProbes(env),
  oauth_state_cleanup: (env: Env) => cleanupExpiredOAuthState(env),
  payment_reconciliation: (env: Env) => scanPaymentReconciliationIssues(env, 5),
  affiliate_rebates: (env: Env) => recoverPendingAffiliateRebates(env, 1),
  // Full old pages cost 1 + 50 * (R2 read + D1 write) = 101 operations.
  observability_payload_repair: (env: Env) => repairObservabilityPayloadMetadata(env, { limit: 10 }),
  observability_r2_orphans: (env: Env) => recoverObservabilityOrphans(env),
  media_tasks: (env: Env) => recoverPendingMediaTasks(env, 1),
  // This recovery only lists and enqueues jobs (1 D1 + at most 25 sends).
  media_provider_jobs: (env: Env) => recoverPendingProviderMediaJobs(env),
  image_tasks: (env: Env) => recoverImageTasks(env, 1),
  // Rollup writes are aggregated; its existing full-page test proves 8 D1 statements.
  account_stats_rollups: (env: Env) => recoverAccountStatsRollups(env),
  admin_request_audit_retention: (env: Env) => runAdminRequestAuditRetention(env),
}


async function recoverObservabilityOrphans(env: Env) {
  const name = 'maintenance:observability-orphan-cursor'
  const state = await env.DB.prepare('SELECT value_json,control_version FROM runtime_settings WHERE name=?')
    .bind(name).first<{ value_json: string; control_version: number }>()
  const saved = state ? JSON.parse(state.value_json) as { cursor?: string } : {}
  const result = await cleanupObservabilityR2Orphans(env, {
    beforeMs: Math.max(0, Date.now() - 31 * 86_400_000), limit: 10,
    ...(typeof saved.cursor === 'string' ? { cursor: saved.cursor } : {}),
  })
  // Advance even when every object on the current page is still referenced.
  // A stale concurrent invocation cannot overwrite the newer scan cursor.
  await env.DB.prepare(`INSERT INTO runtime_settings(name,value_json,control_version,updated_at_ms)
    VALUES(?,?,1,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,
    control_version=runtime_settings.control_version+1,updated_at_ms=excluded.updated_at_ms
    WHERE runtime_settings.control_version=?`).bind(name, JSON.stringify({ cursor: result.cursor }), Date.now(), state?.control_version ?? 0).run()
  return result
}
