import { enqueueSettingsMaintenance } from './maintenance/queue'
import { app } from './app'
import type { Env } from './env'
import { consumeEvents } from './gateway/queue'

export { ApiKeyLimitDO, AuthRateLimitDO, PoolStateDO, SubscriptionStateDO, UserStateDO } from './state'

export async function runScheduledRecovery(env: Env): Promise<void> {
  // Every maintenance/recovery task runs in its own Queue invocation budget.
  await enqueueSettingsMaintenance(env)
}

export default {
  fetch: app.fetch,
  queue: consumeEvents,
  scheduled(_controller, env, context) {
    context.waitUntil(runScheduledRecovery(env))
  },
} satisfies ExportedHandler<Env>
