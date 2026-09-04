/// <reference types="@cloudflare/vitest-plugin/types" />

import type { D1Migration } from '@cloudflare/vitest-plugin'
import type { Env as WorkerEnv } from '../../src/env'

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
    }

    interface GlobalProps {
      mainModule: typeof import('../../src/index')
      durableNamespaces:
        | 'ApiKeyLimitDO'
        | 'AuthRateLimitDO'
        | 'PoolStateDO'
        | 'SubscriptionStateDO'
        | 'UserStateDO'
    }
  }
}

export {}
