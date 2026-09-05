import { app } from './app'
import { recoverPendingSubscriptionState } from './control/subscriptions'
import { scheduleAccountHealthLifecycle } from './control/account-lifecycle'
import type { Env } from './env'
import { consumeEvents } from './gateway/queue'
import { recoverPendingSettlements } from './gateway/recovery'
import { recoverPendingPaymentFulfillments } from './payment/fulfillment'
import { recoverExpiredPaymentOrders } from './payment/orders'
import { recoverPendingRefundClawbacks } from './payment/refunds'
import { cleanupExpiredOAuthState } from './auth/oauth-identities'
import { recoverPendingAuthSourceGrantEffects } from './auth/source-entitlements'
import { scanPaymentReconciliationIssues } from './payment/reconciliation'
import { recoverPendingAffiliateRebates } from './commercial/affiliate'
import {
  cleanupObservabilityR2Orphans,
  repairObservabilityPayloadMetadata,
  runObservabilityRetention,
} from './observability/retention'

export { ApiKeyLimitDO, AuthRateLimitDO, PoolStateDO, SubscriptionStateDO, UserStateDO } from './state'

export async function runScheduledRecovery(env: Env): Promise<void> {
  const now = Date.now()
  const results = await Promise.allSettled([
    recoverPendingSettlements(env),
    recoverPendingSubscriptionState(env),
    recoverPendingAuthSourceGrantEffects(env),
    recoverPendingPaymentFulfillments(env),
    recoverExpiredPaymentOrders(env),
    recoverPendingRefundClawbacks(env),
    scheduleAccountHealthLifecycle(env),
    cleanupExpiredOAuthState(env),
    scanPaymentReconciliationIssues(env),
    recoverPendingAffiliateRebates(env),
    runObservabilityRetention(env, { beforeMs: now - 30 * 86_400_000, limit: 100 }),
    repairObservabilityPayloadMetadata(env, { nowMs: now, limit: 50 }),
    cleanupObservabilityR2Orphans(env, { beforeMs: now - 31 * 86_400_000, limit: 50 }),
  ])
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error('scheduled recovery failed', {
        recovery: [
          'settlements',
          'subscription_state',
          'auth_source_grant_effects',
          'payment_fulfillments',
          'payment_order_expiry',
          'refund_clawbacks',
          'account_health_lifecycle',
          'oauth_state_cleanup',
          'payment_reconciliation',
          'affiliate_rebates',
          'observability_retention',
          'observability_payload_repair',
          'observability_r2_orphans',
        ][index],
        name: result.reason instanceof Error ? result.reason.name : 'unknown',
      })
    }
  }
}

export default {
  fetch: app.fetch,
  queue: consumeEvents,
  scheduled(_controller, env, context) {
    context.waitUntil(runScheduledRecovery(env))
  },
} satisfies ExportedHandler<Env>
