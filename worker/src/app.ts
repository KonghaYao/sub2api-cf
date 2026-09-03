import { Hono } from 'hono'
import {
  currentUser,
  loginWithPassword,
  logoutUserSession,
  refreshUserSession,
  registerWithPassword,
} from './auth/handler'
import {
  createAdminApiKey,
  listAdminApiKeys,
  revokeAdminApiKey,
  updateAdminApiKey,
} from './control/api-keys'
import {
  createAdminAccount,
  deleteAdminAccount,
  deleteAdminAccountGroupLink,
  deleteAdminAccountModelCapability,
  getAdminAccount,
  listAdminAccounts,
  putAdminAccountGroupLink,
  putAdminAccountModelCapability,
  testAdminAccount,
  updateAdminAccount,
} from './control/accounts'
import {
  recoverAdminSession,
  requireAdminSession,
  requireAdminToken,
} from './control/admin-auth'
import {
  adjustAdminUserBalance,
  createAdminUser,
  getAdminUser,
  listAdminUsers,
  updateAdminUser,
} from './control/users'
import {
  allAdminGroups,
  createAdminGroup,
  createAdminModel,
  deleteAdminGroup,
  deleteAdminGroupModel,
  deleteAdminModel,
  getAdminGroup,
  getAdminModel,
  getAdminModelCandidates,
  listAdminGroupModels,
  listAdminGroups,
  listAdminModelPrices,
  listAdminModels,
  publishAdminModelPrice,
  putAdminGroupModel,
  updateAdminGroup,
  updateAdminModel,
} from './control/catalog'
import { getAdminSettings, updateAdminSettings } from './control/settings'
import type { Env } from './env'
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
  handleBootstrap,
  handleCodexModels,
  handleEmbeddings,
  handleGateway,
  handleGeminiModel,
  handleGeminiModelOperation,
  handleGeminiModels,
  handleModels,
  handleResponsesCompact,
  handleResponsesInputTokens,
} from './gateway/handler'
import { handleGatewayUsage, handleKeyBillingInfo } from './gateway/info'
import {
  createUserApiKey,
  getUserApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  updateUserApiKey,
} from './user/api-keys'

type AppBindings = {
  Bindings: Env
}

const apiRoots = ['/api', '/v1', '/backend-api']

function isApiPath(pathname: string): boolean {
  return (
    pathname === '/responses' ||
    pathname.startsWith('/responses/') ||
    pathname === '/models' ||
    pathname === '/chat/completions' ||
    pathname === '/messages/count_tokens' ||
    pathname === '/embeddings' ||
    pathname === '/v1beta' ||
    pathname.startsWith('/v1beta/') ||
    apiRoots.some((root) => pathname === root || pathname.startsWith(`${root}/`))
  )
}

function defaultPublicSettings() {
  return {
    site_name: 'Sub2API',
    registration_enabled: false,
    email_verification_enabled: false,
    email_verify_enabled: false,
    turnstile_enabled: false,
    turnstile_site_key: '',
  }
}

export function createApp() {
  const app = new Hono<AppBindings>()

  app.use('*', async (context, next) => {
    await next()
    context.header('x-request-id', context.req.header('cf-ray') ?? crypto.randomUUID())
    context.header('x-content-type-options', 'nosniff')
    context.header('x-frame-options', 'DENY')
    context.header('referrer-policy', 'strict-origin-when-cross-origin')
    context.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    if (isApiPath(new URL(context.req.url).pathname)) {
      context.header('cache-control', 'no-store')
    }
  })

  app.get('/health', (context) =>
    context.json({
      status: 'ok',
      runtime: 'cloudflare-workers',
      environment: context.env.ENVIRONMENT,
      version: context.env.APP_VERSION,
    }),
  )

  app.get('/ready', async (context) => {
    try {
      await context.env.DB.prepare('SELECT 1 AS ready').first()
      return context.json({ status: 'ready' })
    } catch (error) {
      console.error('readiness check failed', error)
      return context.json({ status: 'not_ready' }, 503)
    }
  })

  app.get('/api/v1/settings/public', async (context) => {
    const key = `${context.env.ENVIRONMENT}:public-settings:v1`
    const settings = await context.env.CONFIG_KV.get<Record<string, unknown>>(key, 'json')
    const resolved = settings ?? defaultPublicSettings()
    return context.json({
      code: 0,
      data: {
        ...resolved,
        email_verify_enabled:
          resolved.email_verify_enabled ?? resolved.email_verification_enabled ?? false,
      },
    })
  })

  app.post('/api/v1/auth/register', registerWithPassword)
  app.post('/api/v1/auth/login', loginWithPassword)
  app.post('/api/v1/auth/refresh', refreshUserSession)
  app.post('/api/v1/auth/logout', logoutUserSession)
  app.get('/api/v1/auth/me', currentUser)

  app.post('/api/v1/admin/bootstrap', requireAdminToken, handleBootstrap)
  app.post('/api/v1/admin/session/recover', requireAdminToken, recoverAdminSession)
  app.use('/api/v1/admin/*', requireAdminSession)
  app.get('/api/v1/admin/settings', getAdminSettings)
  app.put('/api/v1/admin/settings', updateAdminSettings)
  app.get('/api/v1/admin/users', listAdminUsers)
  app.post('/api/v1/admin/users', createAdminUser)
  app.get('/api/v1/admin/users/:id', getAdminUser)
  app.put('/api/v1/admin/users/:id', updateAdminUser)
  app.post('/api/v1/admin/users/:id/balance', adjustAdminUserBalance)
  app.get('/api/v1/admin/users/:id/api-keys', listAdminApiKeys)
  app.post('/api/v1/admin/users/:id/api-keys', createAdminApiKey)
  app.put('/api/v1/admin/api-keys/:id', updateAdminApiKey)
  app.delete('/api/v1/admin/api-keys/:id', revokeAdminApiKey)
  app.get('/api/v1/admin/groups', listAdminGroups)
  app.get('/api/v1/admin/groups/all', allAdminGroups)
  app.post('/api/v1/admin/groups', createAdminGroup)
  app.get('/api/v1/admin/groups/:id/models-list-candidates', getAdminModelCandidates)
  app.get('/api/v1/admin/groups/:id/models', listAdminGroupModels)
  app.put('/api/v1/admin/groups/:id/models/:model_id', putAdminGroupModel)
  app.delete('/api/v1/admin/groups/:id/models/:model_id', deleteAdminGroupModel)
  app.get('/api/v1/admin/groups/:id/models/:model_id/prices', listAdminModelPrices)
  app.post('/api/v1/admin/groups/:id/models/:model_id/prices', publishAdminModelPrice)
  app.get('/api/v1/admin/groups/:id', getAdminGroup)
  app.put('/api/v1/admin/groups/:id', updateAdminGroup)
  app.delete('/api/v1/admin/groups/:id', deleteAdminGroup)
  app.get('/api/v1/admin/models', listAdminModels)
  app.post('/api/v1/admin/models', createAdminModel)
  app.get('/api/v1/admin/models/:id', getAdminModel)
  app.put('/api/v1/admin/models/:id', updateAdminModel)
  app.delete('/api/v1/admin/models/:id', deleteAdminModel)
  app.get('/api/v1/admin/accounts', listAdminAccounts)
  app.post('/api/v1/admin/accounts', createAdminAccount)
  app.get('/api/v1/admin/accounts/:id', getAdminAccount)
  app.put('/api/v1/admin/accounts/:id', updateAdminAccount)
  app.delete('/api/v1/admin/accounts/:id', deleteAdminAccount)
  app.put('/api/v1/admin/accounts/:id/groups/:group_id', putAdminAccountGroupLink)
  app.delete('/api/v1/admin/accounts/:id/groups/:group_id', deleteAdminAccountGroupLink)
  app.put('/api/v1/admin/accounts/:id/models/:model_id', putAdminAccountModelCapability)
  app.delete('/api/v1/admin/accounts/:id/models/:model_id', deleteAdminAccountModelCapability)
  app.post('/api/v1/admin/accounts/:id/test', testAdminAccount)

  app.get('/api/v1/keys', listUserApiKeys)
  app.post('/api/v1/keys', createUserApiKey)
  app.get('/api/v1/keys/:id', getUserApiKey)
  app.put('/api/v1/keys/:id', updateUserApiKey)
  app.delete('/api/v1/keys/:id', revokeUserApiKey)

  app.get('/v1/models', handleModels)
  app.get('/models', handleModels)
  app.get('/backend-api/codex/models', handleCodexModels)
  app.get('/v1/sub2api/billing', handleKeyBillingInfo)
  app.get('/v1/usage', handleGatewayUsage)
  app.get('/v1beta/models', handleGeminiModels)
  app.get('/v1beta/models/:model', handleGeminiModel)
  app.post('/v1beta/models/:operation', handleGeminiModelOperation)
  app.post('/v1/chat/completions', (context) => handleGateway(context, 'chat_completions'))
  app.post('/chat/completions', (context) => handleGateway(context, 'chat_completions'))
  app.post('/v1/responses', (context) => handleGateway(context, 'responses'))
  app.post('/responses', (context) => handleGateway(context, 'responses'))
  app.post('/v1/responses/compact', handleResponsesCompact)
  app.post('/responses/compact', handleResponsesCompact)
  app.post('/v1/responses/input_tokens', handleResponsesInputTokens)
  app.post('/responses/input_tokens', handleResponsesInputTokens)
  app.post('/backend-api/codex/responses', (context) => handleGateway(context, 'responses'))
  app.post('/backend-api/codex/responses/compact', handleResponsesCompact)
  app.post('/backend-api/codex/responses/input_tokens', handleResponsesInputTokens)
  app.post('/v1/messages', handleAnthropicMessages)
  app.post('/v1/messages/count_tokens', handleAnthropicCountTokens)
  app.post('/messages/count_tokens', handleAnthropicCountTokens)
  app.post('/v1/embeddings', handleEmbeddings)
  app.post('/embeddings', handleEmbeddings)

  app.notFound(async (context) => {
    const pathname = new URL(context.req.url).pathname
    if (isApiPath(pathname)) {
      return context.json(
        {
          code: -1,
          message: 'Route not migrated to Cloudflare Workers yet',
        },
        404,
      )
    }
    return context.env.ASSETS.fetch(context.req.raw)
  })

  app.onError((error, context) => {
    console.error('unhandled worker error', error)
    return context.json(
      {
        code: -1,
        message: 'Internal server error',
      },
      500,
    )
  })

  return app
}

export const app = createApp()
