import { Hono } from 'hono'
import {
  createAdminApiKey,
  listAdminApiKeys,
  revokeAdminApiKey,
  updateAdminApiKey,
} from './control/api-keys'
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
import type { Env } from './env'
import { handleBootstrap, handleGateway, handleModels } from './gateway/handler'

type AppBindings = {
  Bindings: Env
}

const apiRoots = ['/api', '/v1', '/backend-api']

function isApiPath(pathname: string): boolean {
  return (
    pathname === '/responses' ||
    apiRoots.some((root) => pathname === root || pathname.startsWith(`${root}/`))
  )
}

function defaultPublicSettings() {
  return {
    site_name: 'Sub2API',
    registration_enabled: false,
    email_verification_enabled: false,
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
    const settings = await context.env.CONFIG_KV.get(key, 'json')
    return context.json({
      code: 0,
      data: settings ?? defaultPublicSettings(),
    })
  })

  app.post('/api/v1/admin/bootstrap', requireAdminToken, handleBootstrap)
  app.post('/api/v1/admin/session/recover', requireAdminToken, recoverAdminSession)
  app.use('/api/v1/admin/*', requireAdminSession)
  app.get('/api/v1/admin/users', listAdminUsers)
  app.post('/api/v1/admin/users', createAdminUser)
  app.get('/api/v1/admin/users/:id', getAdminUser)
  app.put('/api/v1/admin/users/:id', updateAdminUser)
  app.post('/api/v1/admin/users/:id/balance', adjustAdminUserBalance)
  app.get('/api/v1/admin/users/:id/api-keys', listAdminApiKeys)
  app.post('/api/v1/admin/users/:id/api-keys', createAdminApiKey)
  app.put('/api/v1/admin/api-keys/:id', updateAdminApiKey)
  app.delete('/api/v1/admin/api-keys/:id', revokeAdminApiKey)

  app.get('/v1/models', handleModels)
  app.post('/v1/chat/completions', (context) => handleGateway(context, 'chat_completions'))
  app.post('/v1/responses', (context) => handleGateway(context, 'responses'))
  app.post('/responses', (context) => handleGateway(context, 'responses'))

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
