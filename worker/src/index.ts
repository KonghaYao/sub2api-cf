import { app } from './app'
import type { Env } from './env'
import { consumeEvents } from './gateway/queue'
import { recoverPendingSettlements } from './gateway/recovery'

export { PoolStateDO, UserStateDO } from './state'

export default {
  fetch: app.fetch,
  queue: consumeEvents,
  scheduled(_controller, env, context) {
    context.waitUntil(recoverPendingSettlements(env))
  },
} satisfies ExportedHandler<Env>
