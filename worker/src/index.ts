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
import { scanPaymentReconciliationIssues } from './payment/reconciliation'
import { recoverPendingAffiliateRebates } from './commercial/affiliate'

export { ApiKeyLimitDO, AuthRateLimitDO, PoolStateDO, SubscriptionStateDO, UserStateDO } from './state'

export async function runScheduledRecovery(env: Env): Promise<void> {
  const results = await Promise.allSettled([
    recoverPendingSettlements(env),
    recoverPendingSubscriptionState(env),
    recoverPendingPaymentFulfillments(env),
    recoverExpiredPaymentOrders(env),
    recoverPendingRefundClawbacks(env),
    scheduleAccountHealthLifecycle(env),
    cleanupExpiredOAuthState(env),
    scanPaymentReconciliationIssues(env),
    recoverPendingAffiliateRebates(env),
  ])
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error('scheduled recovery failed', {
        recovery: [
          'settlements',
          'subscription_state',
          'payment_fulfillments',
          'payment_order_expiry',
          'refund_clawbacks',
          'account_health_lifecycle',
          'oauth_state_cleanup',
          'payment_reconciliation',
          'affiliate_rebates',
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
