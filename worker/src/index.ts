import { app } from './app'
import type { Env } from './env'

export { PoolStateDO, UserStateDO } from './state'

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
