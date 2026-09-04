import { Hono } from 'hono'
import {
  currentUser,
  loginWithTotp,
  loginWithPassword,
  logoutUserSession,
  refreshUserSession,
  registerWithPassword,
} from './auth/handler'
import {
  confirmEmailVerification,
  requestEmailVerification,
  requestPasswordReset,
  requestRegistrationEmailVerification,
  resetPasswordWithChallenge,
} from './auth/email-challenges'
import {
  listUserSessions,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
} from './auth/sessions'
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
import { getAdminAuditEvent, listAdminAuditEvents } from './control/audit'
import {
  recoverAdminSession,
  requireAdminMutationSecurity,
  requireAdminSession,
  requireAdminToken,
} from './control/admin-auth'
import {
  assignAdminUserRole,
  createAdminRole,
  deleteAdminRole,
  getAdminRole,
  listAdminPermissions,
  listAdminRbacAuditEvents,
  listAdminRoles,
  listAdminUserRoles,
  requireAdminPermission,
  requireAdminRoutePermission,
  revokeAdminUserRole,
  updateAdminRole,
} from './control/rbac'
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
import {
  clearAdminGroupRpmOverrides,
  listAdminGroupRpmOverrides,
  putAdminGroupRpmOverrides,
} from './control/group-rpm'
import {
  batchDeleteAdminRedeemCodes,
  batchUpdateAdminRedeemCodes,
  deleteAdminRedeemCode,
  expireAdminRedeemCode,
  generateAdminRedeemCodes,
  getAdminRedeemCode,
  getAdminRedeemCodeStats,
  listAdminRedeemCodes,
} from './control/redeem-codes'
import {
  createAdminSubscriptionPlan,
  disableAdminSubscriptionPlan,
  getAdminSubscriptionPlan,
  getPublicSubscriptionPlan,
  listAdminSubscriptionPlans,
  listPublicSubscriptionPlans,
  updateAdminSubscriptionPlan,
} from './control/subscription-plans'
import {
  assignAdminSubscription,
  bulkAssignAdminSubscriptions,
  extendAdminSubscription,
  getAdminSubscription,
  getAdminSubscriptionProgress,
  listAdminGroupSubscriptions,
  listAdminSubscriptions,
  listAdminUserSubscriptions,
  resetAdminSubscriptionQuota,
  restoreAdminSubscription,
  revokeAdminSubscription,
} from './control/subscriptions'
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
import { getUserGroupRates, listAvailableUserGroups } from './user/groups'
import { listUserRedemptions, redeemCode } from './user/redeem'
import {
  getUserSubscriptionProgress,
  getUserSubscriptionSummary,
  listActiveUserSubscriptions,
  listUserSubscriptionProgress,
  listUserSubscriptions,
} from './user/subscriptions'
import {
  changeUserPassword,
  getUserAvatar,
  getUserProfile,
  updateCurrentUser,
} from './user/profile'
import {
  removeNotificationEmail,
  sendNotificationEmailVerificationCode,
  toggleNotificationEmail,
  verifyNotificationEmail,
} from './user/notification-preferences'
import {
  disableTotp,
  enableTotp,
  getTotpStatus,
  getTotpVerificationMethod,
  grantTotpStepUp,
  initiateTotpSetup,
  sendTotpVerificationCode,
} from './user/totp'
import {
  dashboardApiKeysUsage,
  dashboardModels,
  dashboardSnapshot,
  dashboardStats,
  dashboardTrend,
  getUserApiKeyDailyUsage,
  getUsageDetail,
  listUsage,
  listUsageErrors,
  usageErrorDetail,
  usageStats,
} from './user/usage'
import {
  createPaymentProvider,
  deletePaymentProvider,
  getAdminPaymentConfig,
  getPaymentCheckoutInfo,
  getPaymentConfig,
  getPaymentLimits,
  isPaymentEnabled,
  listPaymentProviders,
  updateAdminPaymentConfig,
  updatePaymentProvider,
} from './payment/config'
import {
  cancelMyPaymentOrder,
  createPaymentOrder,
  getMyPaymentOrder,
  handleStripeWebhook,
  listMyPaymentOrders,
  resolvePaymentOrderPublic,
  verifyMyPaymentOrder,
  verifyPaymentOrderPublic,
} from './payment/orders'
import {
  cancelAdminPaymentOrder,
  getAdminPaymentDashboard,
  getAdminPaymentOrder,
  listAdminPaymentOrders,
  retryAdminPaymentFulfillment,
} from './payment/admin'
import {
  getRefundEligibleProviders,
  processAdminRefund,
  queryAdminRefund,
  requestPaymentRefund,
} from './payment/refunds'

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
    payment_enabled: false,
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
    if (isApiPath(new URL(context.req.url).pathname) && !context.res.headers.has('cache-control')) {
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
    const paymentEnabled = typeof context.env.DB.prepare === 'function'
      ? await isPaymentEnabled(context.env)
      : Boolean(resolved.payment_enabled)
    return context.json({
      code: 0,
      data: {
        ...resolved,
        email_verify_enabled:
          resolved.email_verify_enabled ?? resolved.email_verification_enabled ?? false,
        payment_enabled: paymentEnabled,
      },
    })
  })

  app.post('/api/v1/auth/register', registerWithPassword)
  app.post('/api/v1/auth/send-verify-code', requestRegistrationEmailVerification)
  app.post('/api/v1/auth/forgot-password', requestPasswordReset)
  app.post('/api/v1/auth/reset-password', resetPasswordWithChallenge)
  app.post('/api/v1/auth/email-verification/request', requestEmailVerification)
  app.post('/api/v1/auth/email-verification/confirm', confirmEmailVerification)
  app.post('/api/v1/auth/login', loginWithPassword)
  app.post('/api/v1/auth/login/2fa', loginWithTotp)
  app.post('/api/v1/auth/refresh', refreshUserSession)
  app.post('/api/v1/auth/logout', logoutUserSession)
  app.get('/api/v1/auth/me', currentUser)
  app.get('/api/v1/auth/sessions', listUserSessions)
  app.post('/api/v1/auth/sessions/revoke-others', revokeOtherUserSessions)
  app.post('/api/v1/auth/sessions/revoke-all', revokeAllUserSessions)
  app.post('/api/v1/auth/revoke-all-sessions', revokeAllUserSessions)
  app.delete('/api/v1/auth/sessions/:id', revokeUserSession)

  app.get('/api/v1/user/profile', getUserProfile)
  app.put('/api/v1/user', updateCurrentUser)
  app.put('/api/v1/user/password', changeUserPassword)
  app.get('/api/v1/user/avatar/:id', getUserAvatar)
  app.post('/api/v1/user/notify-email/send-code', sendNotificationEmailVerificationCode)
  app.post('/api/v1/user/notify-email/verify', verifyNotificationEmail)
  app.delete('/api/v1/user/notify-email', removeNotificationEmail)
  app.put('/api/v1/user/notify-email/toggle', toggleNotificationEmail)
  app.get('/api/v1/user/totp/status', getTotpStatus)
  app.get('/api/v1/user/totp/verification-method', getTotpVerificationMethod)
  app.post('/api/v1/user/totp/send-code', sendTotpVerificationCode)
  app.post('/api/v1/user/totp/setup', initiateTotpSetup)
  app.post('/api/v1/user/totp/enable', enableTotp)
  app.post('/api/v1/user/totp/disable', disableTotp)
  app.post('/api/v1/user/totp/step-up', grantTotpStepUp)
  app.get('/api/v1/user/api-keys/:id/usage/daily', getUserApiKeyDailyUsage)
  app.get('/api/v1/usage/stats', usageStats)
  app.get('/api/v1/usage/dashboard/stats', dashboardStats)
  app.get('/api/v1/usage/dashboard/trend', dashboardTrend)
  app.get('/api/v1/usage/dashboard/models', dashboardModels)
  app.get('/api/v1/usage/dashboard/snapshot-v2', dashboardSnapshot)
  app.post('/api/v1/usage/dashboard/api-keys-usage', dashboardApiKeysUsage)
  app.get('/api/v1/usage/errors', listUsageErrors)
  app.get('/api/v1/usage/errors/:id', usageErrorDetail)
  app.get('/api/v1/usage', listUsage)
  app.get('/api/v1/usage/:id', getUsageDetail)

  app.post('/api/v1/admin/bootstrap', requireAdminToken, handleBootstrap)
  app.post('/api/v1/admin/session/recover', requireAdminToken, recoverAdminSession)
  app.use(
    '/api/v1/admin/*',
    requireAdminSession,
    requireAdminRoutePermission,
    requireAdminMutationSecurity,
  )
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
  app.get('/api/v1/admin/groups/:id/rpm-overrides', listAdminGroupRpmOverrides)
  app.put('/api/v1/admin/groups/:id/rpm-overrides', putAdminGroupRpmOverrides)
  app.delete('/api/v1/admin/groups/:id/rpm-overrides', clearAdminGroupRpmOverrides)
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
  app.get('/api/v1/admin/payment/plans', listAdminSubscriptionPlans)
  app.post('/api/v1/admin/payment/plans', createAdminSubscriptionPlan)
  app.get('/api/v1/admin/payment/plans/:id', getAdminSubscriptionPlan)
  app.put('/api/v1/admin/payment/plans/:id', updateAdminSubscriptionPlan)
  app.delete('/api/v1/admin/payment/plans/:id', disableAdminSubscriptionPlan)
  app.get('/api/v1/admin/payment/config', getAdminPaymentConfig)
  app.put('/api/v1/admin/payment/config', updateAdminPaymentConfig)
  app.get('/api/v1/admin/payment/providers', listPaymentProviders)
  app.post('/api/v1/admin/payment/providers', createPaymentProvider)
  app.put('/api/v1/admin/payment/providers/:id', updatePaymentProvider)
  app.delete('/api/v1/admin/payment/providers/:id', deletePaymentProvider)
  app.get('/api/v1/admin/payment/dashboard', getAdminPaymentDashboard)
  app.get('/api/v1/admin/payment/orders', listAdminPaymentOrders)
  app.get('/api/v1/admin/payment/orders/:id', getAdminPaymentOrder)
  app.post('/api/v1/admin/payment/orders/:id/cancel', cancelAdminPaymentOrder)
  app.post('/api/v1/admin/payment/orders/:id/retry', retryAdminPaymentFulfillment)
  app.post('/api/v1/admin/payment/orders/:id/refund', processAdminRefund)
  app.post('/api/v1/admin/payment/orders/:id/refund/query', queryAdminRefund)
  app.get('/api/v1/admin/subscriptions', listAdminSubscriptions)
  app.post('/api/v1/admin/subscriptions/assign', assignAdminSubscription)
  app.post('/api/v1/admin/subscriptions/bulk-assign', bulkAssignAdminSubscriptions)
  app.get('/api/v1/admin/subscriptions/:id', getAdminSubscription)
  app.get('/api/v1/admin/subscriptions/:id/progress', getAdminSubscriptionProgress)
  app.post('/api/v1/admin/subscriptions/:id/extend', extendAdminSubscription)
  app.post('/api/v1/admin/subscriptions/:id/reset-quota', resetAdminSubscriptionQuota)
  app.post('/api/v1/admin/subscriptions/:id/revoke', revokeAdminSubscription)
  app.post('/api/v1/admin/subscriptions/:id/restore', restoreAdminSubscription)
  app.get('/api/v1/admin/groups/:id/subscriptions', listAdminGroupSubscriptions)
  app.get('/api/v1/admin/users/:id/subscriptions', listAdminUserSubscriptions)
  app.get('/api/v1/admin/redeem-codes', listAdminRedeemCodes)
  app.post('/api/v1/admin/redeem-codes/generate', generateAdminRedeemCodes)
  app.get('/api/v1/admin/redeem-codes/stats', getAdminRedeemCodeStats)
  app.post('/api/v1/admin/redeem-codes/batch-delete', batchDeleteAdminRedeemCodes)
  app.post('/api/v1/admin/redeem-codes/batch-update', batchUpdateAdminRedeemCodes)
  app.post('/api/v1/admin/redeem-codes/:id/expire', expireAdminRedeemCode)
  app.get('/api/v1/admin/redeem-codes/:id', getAdminRedeemCode)
  app.delete('/api/v1/admin/redeem-codes/:id', deleteAdminRedeemCode)
  app.get('/api/v1/admin/rbac/permissions', requireAdminPermission('admin.rbac.read'), listAdminPermissions)
  app.get('/api/v1/admin/rbac/roles', requireAdminPermission('admin.rbac.read'), listAdminRoles)
  app.post('/api/v1/admin/rbac/roles', requireAdminPermission('admin.rbac.write'), createAdminRole)
  app.get('/api/v1/admin/rbac/roles/:id', requireAdminPermission('admin.rbac.read'), getAdminRole)
  app.put('/api/v1/admin/rbac/roles/:id', requireAdminPermission('admin.rbac.write'), updateAdminRole)
  app.delete('/api/v1/admin/rbac/roles/:id', requireAdminPermission('admin.rbac.write'), deleteAdminRole)
  app.get(
    '/api/v1/admin/rbac/users/:user_id/roles',
    requireAdminPermission('admin.rbac.read'),
    listAdminUserRoles,
  )
  app.put(
    '/api/v1/admin/rbac/users/:user_id/roles/:role_id',
    requireAdminPermission('admin.rbac.write'),
    assignAdminUserRole,
  )
  app.delete(
    '/api/v1/admin/rbac/users/:user_id/roles/:role_id',
    requireAdminPermission('admin.rbac.write'),
    revokeAdminUserRole,
  )
  app.get(
    '/api/v1/admin/rbac/audit',
    requireAdminPermission('admin.audit.read'),
    listAdminRbacAuditEvents,
  )
  app.get('/api/v1/admin/audit/events', listAdminAuditEvents)
  app.get('/api/v1/admin/audit/events/:category/:id', getAdminAuditEvent)

  app.get('/api/v1/keys', listUserApiKeys)
  app.post('/api/v1/keys', createUserApiKey)
  app.get('/api/v1/keys/:id', getUserApiKey)
  app.put('/api/v1/keys/:id', updateUserApiKey)
  app.delete('/api/v1/keys/:id', revokeUserApiKey)
  app.get('/api/v1/groups/available', listAvailableUserGroups)
  app.get('/api/v1/groups/rates', getUserGroupRates)
  app.get('/api/v1/subscriptions', listUserSubscriptions)
  app.get('/api/v1/subscriptions/active', listActiveUserSubscriptions)
  app.get('/api/v1/subscriptions/progress', listUserSubscriptionProgress)
  app.get('/api/v1/subscriptions/summary', getUserSubscriptionSummary)
  app.get('/api/v1/subscriptions/:id/progress', getUserSubscriptionProgress)
  app.post('/api/v1/redeem', redeemCode)
  app.get('/api/v1/redeem/history', listUserRedemptions)
  app.get('/api/v1/payment/plans', listPublicSubscriptionPlans)
  app.get('/api/v1/payment/plans/:id', getPublicSubscriptionPlan)
  app.get('/api/v1/payment/config', getPaymentConfig)
  app.get('/api/v1/payment/checkout-info', getPaymentCheckoutInfo)
  app.get('/api/v1/payment/limits', getPaymentLimits)
  app.post('/api/v1/payment/orders', createPaymentOrder)
  app.post('/api/v1/payment/orders/verify', verifyMyPaymentOrder)
  app.get('/api/v1/payment/orders/my', listMyPaymentOrders)
  app.get('/api/v1/payment/orders/refund-eligible-providers', getRefundEligibleProviders)
  app.get('/api/v1/payment/orders/:id', getMyPaymentOrder)
  app.post('/api/v1/payment/orders/:id/cancel', cancelMyPaymentOrder)
  app.post('/api/v1/payment/orders/:id/refund-request', requestPaymentRefund)
  app.post('/api/v1/payment/public/orders/verify', verifyPaymentOrderPublic)
  app.post('/api/v1/payment/public/orders/resolve', resolvePaymentOrderPublic)
  app.post('/api/v1/payment/webhook/stripe', handleStripeWebhook)

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
