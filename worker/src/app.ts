import { getAdminGroupUsageSummary } from './control/group-usage'
import { getAdminGroupCapacitySummary } from './control/group-capacity'
import { Hono } from 'hono'
import {
  currentUser,
  loginWithTotp,
  loginWithPassword,
  logoutUserSession,
  refreshUserSession,
  registerWithPassword,
  requirePublicAuthStartCaptcha,
} from './auth/handler'
import {
  bindEmailIdentity,
  confirmEmailVerification,
  requestEmailIdentityBindingCode,
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
import { isPasskeyDeploymentConfigured, resolvePasskeyConfiguration } from './auth/passkey-config'
import { createPasskeyHandlers } from './auth/passkeys'
import { registerOAuthIdentityRoutes } from './auth/oauth-identities'
import { oauthPublicSettings } from './auth/oauth-public-settings'
import {
  createAdminApiKey,
  listAdminApiKeys,
  revokeAdminApiKey,
  updateAdminApiKey,
} from './control/api-keys'
import {
  createAdminAccount,
  duplicateAdminAccount,
  batchDeleteAdminAccounts,
  batchRefreshAdminAccountCredentials,
  refreshAdminAccountCredentials,
  deleteAdminAccount,
  deleteAdminAccountGroupLink,
  deleteAdminAccountModelCapability,
  getAdminAccount,
  getAdminAccountStats,
  listAdminAccounts,
  putAdminAccountGroupLink,
  putAdminAccountModelCapability,
  testAdminAccount,
  updateAdminAccount,
} from './control/accounts'
import {
  bulkUpdateAdminAccounts,
  queueAdminAccountHealthProbes,
  resetAdminAccountStatuses,
} from './control/account-operations'
import {
  listAdminAccountSyntheticProbeHistory,
  queueAdminAccountSyntheticProbes,
} from './control/account-synthetic-probes'
import { getAdminAuditEvent, listAdminAuditEvents } from './control/audit'
import {
  auditAdminRequest,
  clearAdminRequestAuditLogs,
  getAdminRequestAuditLog,
  listAdminRequestAuditLogs,
} from './control/request-audit'
import {
  recoverAdminSession,
  requireAdminMutationSecurity,
  requireAdminSession,
  requireAdminToken,
} from './control/admin-auth'
import { acceptAdminCompliance, getAdminComplianceStatus } from './control/admin-compliance'
import {
  batchGetAdminUserAttributes,
  createUserAttributeDefinition,
  deleteUserAttributeDefinition,
  getAdminUserAttributes,
  listUserAttributeDefinitions,
  reorderUserAttributeDefinitions,
  updateAdminUserAttributes,
  updateUserAttributeDefinition,
} from './control/user-attributes'
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
  batchUpdateAdminUserLimits,
  getAdminUser,
  listAdminUserBalanceHistory,
  listAdminUsers,
  updateAdminUser,
} from './control/users'
import { backfillAdminUserFinancialHistory } from './control/financial-history-backfill'
import {
  continueAdminFinancialHistoryBackfillBatch,
  createAdminFinancialHistoryBackfillBatch,
  getAdminFinancialHistoryBackfillBatch,
} from './control/financial-history-backfill-batches'
import {
  allAdminGroups,
  createAdminGroup,
  duplicateAdminGroup,
  updateAdminGroupSortOrder,
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
import {
  createAdminChannel,
  deleteAdminChannel,
  getAdminChannel,
  listAdminChannels,
  updateAdminChannel,
} from './control/channels'
import {
  getAdminChannelModelPricing,
  listAdminChannelPricingModels,
} from './control/channel-pricing-catalog'
import { getAdminSettings, updateAdminSettings } from './control/settings'
import {
  disableAdminOAuthProvider,
  getAdminOAuthProvider,
  listAdminOAuthProviders,
  upsertAdminOAuthProvider,
} from './control/oauth-providers'
import {
  clearAdminGroupRpmOverrides,
  listAdminGroupRpmOverrides,
  putAdminGroupRpmOverrides,
} from './control/group-rpm'
import {
  clearAdminGroupRateMultipliers,
  listAdminGroupRateMultipliers,
  putAdminGroupRateMultipliers,
} from './control/group-rate'
import {
  createCompositeRoute,
  deleteCompositeRoute,
  listCompositeRoutes,
  previewCompositeRoute,
  updateCompositeRoute,
} from './control/composite-routes'
import {
  createAdminInvitationCode,
  createAdminPromotionCode,
  deleteAdminInvitationCode,
  deleteAdminPromotionCode,
  getAdminCommercialConfig,
  getAdminInvitationCode,
  getAdminPromotionCode,
  listAdminInvitationCodes,
  listAdminInvitationUsages,
  listAdminPromotionCodes,
  listAdminPromotionUsages,
  updateAdminCommercialConfig,
  updateAdminInvitationCode,
  updateAdminPromotionCode,
} from './control/promotions'
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
import { requestIdFor } from './request-id'
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
import { getModelPlaza } from './gateway/model-plaza'
import {
  cancelGatewayMediaTask,
  cancelUserMediaTask,
  deleteGatewayMediaTask,
  deleteGatewayMediaTaskOutputs,
  deleteUserMediaTask,
  deleteUserMediaTaskOutputs,
  downloadGatewayMediaTask,
  downloadUserMediaTask,
  getGatewayMediaTask,
  getGatewayMediaTaskItemContent,
  getUserMediaTask,
  getUserMediaTaskItemContent,
  listGatewayMediaModels,
  listGatewayMediaTaskItems,
  listGatewayMediaTasks,
  listUserMediaModels,
  listUserMediaTaskItems,
  listUserMediaTasks,
  submitGatewayMediaTask,
  submitUserMediaTask,
} from './media/handlers'
import { handleSyncImages } from './media/sync-handler'
import { unsupportedVideoGeneration } from './media/video-unsupported'
import {
  getAsyncImageTask,
  getAsyncImageTaskContent,
  submitAsyncImageTask,
} from './media/image-task'
import { validateInvitationCode, validatePromotionCode } from './commercial/registration'
import {
  accrueAdminAffiliateRebate,
  batchUpdateAdminAffiliateRates,
  clearAdminAffiliateUser,
  getAdminAffiliateUserOverview,
  getUserAffiliate,
  listAdminAffiliateInvites,
  listAdminAffiliateRebates,
  listAdminAffiliateTransfers,
  listAdminAffiliateUsers,
  lookupAdminAffiliateUsers,
  transferUserAffiliateQuota,
  updateAdminAffiliateUser,
} from './commercial/affiliate'
import {
  createUserApiKey,
  getUserApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  updateUserApiKey,
} from './user/api-keys'
import { getUserGroupRates, listAvailableUserGroups } from './user/groups'
import { listAvailableUserChannels } from './user/channels'
import {
  getAdminPlatformQuotaDefaults,
  getAdminUserPlatformQuotas,
  getMyPlatformQuotas,
  replaceAdminPlatformQuotaDefaults,
  replaceAdminUserPlatformQuotas,
  resetAdminUserPlatformQuotaWindow,
} from './user/platform-quotas'
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
  createAdminAnnouncement,
  deleteAdminAnnouncement,
  getAdminAnnouncement,
  listAdminAnnouncementReadStatus,
  listAdminAnnouncements,
  listMyAnnouncements,
  markMyAnnouncementRead,
  updateAdminAnnouncement,
} from './user/announcements'
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
  regenerateTotpRecoveryCodes,
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
  usageStats,
} from './user/usage'
import {
  actOnAdminRequestError,
  actOnAdminUpstreamError,
  getAdminErrorAggregation,
  getAdminUsageStats,
  getAdminUsageModels,
  getAdminRequestErrorDetail,
  getAdminUpstreamErrorDetail,
  getOwnerErrorDetail,
  listAdminRequestErrors,
  listAdminRequests,
  listAdminUpstreamErrors,
  listAdminUsage,
  listOwnerErrors,
  listRelatedUpstreamErrors,
  searchAdminUsageApiKeys,
  searchAdminUsageUsers,
  unsupportedAdminUsageCleanup,
  unsupportedAdminUsageAnalytics,
  unsupportedAdminOps,
} from './observability'
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
import { downloadMyPaymentReceipt, getMyPaymentReceipt } from './payment/receipts'
import {
  actOnAdminPaymentReconciliationIssue,
  downloadAdminPaymentReconciliationEvidence,
  getAdminPaymentReconciliationIssue,
  listAdminPaymentReconciliationIssues,
} from './payment/reconciliation'
import { handleDurableObjectBackup } from './backup/routes'

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
    backend_mode_enabled: false,
    site_subtitle: '', api_base_url: '', contact_info: '', doc_url: '', site_logo: '', home_content: '',
    compact_home_enabled: false, hide_ccs_import_button: false,
    custom_menu_items: [], custom_endpoints: [],
    registration_enabled: false,
    registration_email_suffix_whitelist: [],
    email_verification_enabled: false,
    email_verify_enabled: false,
    turnstile_enabled: false,
    turnstile_site_key: '',
    passkey_enabled: false,
    available_channels_enabled: false,
    model_plaza_enabled: false,
    model_plaza_require_auth: false,
    model_plaza_description: '',
    promo_code_enabled: false,
    invitation_code_enabled: false,
    affiliate_enabled: false,
    openai_advanced_scheduler_subscription_priority_enabled: false,
    payment_enabled: false,
  }
}

export function createApp() {
  const app = new Hono<AppBindings>()
  const passkeys = createPasskeyHandlers(resolvePasskeyConfiguration)

  app.use('*', async (context, next) => {
    const requestId = requestIdFor(context.req.raw)
    await next()
    context.header('x-request-id', requestId)
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

  app.all(
    '/internal/backup/durable-objects/:namespace/:objectId/:action',
    handleDurableObjectBackup,
  )

  app.get('/api/v1/settings/public', async (context) => {
    const key = `${context.env.ENVIRONMENT}:public-settings:v1`
    const settings = await context.env.CONFIG_KV.get<Record<string, unknown>>(key, 'json')
    const resolved = { ...defaultPublicSettings(), ...(settings ?? {}) }
    const paymentEnabled = typeof context.env.DB.prepare === 'function'
      ? await isPaymentEnabled(context.env)
      : Boolean(resolved.payment_enabled)
    const oauth = await oauthPublicSettings(context.env)
    return context.json({
      code: 0,
      data: {
        ...resolved,
        email_verify_enabled:
          resolved.email_verify_enabled ?? resolved.email_verification_enabled ?? false,
        passkey_enabled:
          resolved.passkey_enabled === true && isPasskeyDeploymentConfigured(context.env),
        available_channels_enabled: resolved.available_channels_enabled === true,
        ...oauth,
        payment_enabled: paymentEnabled,
      },
    })
  })

  app.post('/api/v1/auth/register', registerWithPassword)
  app.post('/api/v1/auth/send-verify-code', requestRegistrationEmailVerification)
  app.post('/api/v1/auth/forgot-password', requestPasswordReset)
  app.post('/api/v1/auth/reset-password', resetPasswordWithChallenge)
  app.post('/api/v1/auth/validate-promo-code', validatePromotionCode)
  app.post('/api/v1/auth/validate-invitation-code', validateInvitationCode)
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
  app.post('/api/v1/auth/passkey/login/begin', requirePublicAuthStartCaptcha, passkeys.beginLogin)
  app.post('/api/v1/auth/passkey/login/finish', passkeys.finishLogin)
  app.post('/api/v1/user/passkeys/register/begin', passkeys.beginRegistration)
  app.post('/api/v1/user/passkeys/register/finish', passkeys.finishRegistration)
  app.get('/api/v1/user/passkeys', passkeys.list)
  app.patch('/api/v1/user/passkeys/:id', passkeys.rename)
  app.delete('/api/v1/user/passkeys/:id', passkeys.remove)
  app.use('/api/v1/auth/oauth/:provider/start', requirePublicAuthStartCaptcha)
  registerOAuthIdentityRoutes(app)

  app.get('/api/v1/user/profile', getUserProfile)
  app.get('/api/v1/announcements', listMyAnnouncements)
  app.post('/api/v1/announcements/:id/read', markMyAnnouncementRead)
  app.get('/api/v1/user/platform-quotas', getMyPlatformQuotas)
  app.put('/api/v1/user', updateCurrentUser)
  app.put('/api/v1/user/password', changeUserPassword)
  app.post('/api/v1/user/account-bindings/email/send-code', requestEmailIdentityBindingCode)
  app.post('/api/v1/user/account-bindings/email', bindEmailIdentity)
  app.get('/api/v1/user/avatar/:id', getUserAvatar)
  app.post('/api/v1/user/notify-email/send-code', sendNotificationEmailVerificationCode)
  app.post('/api/v1/user/notify-email/verify', verifyNotificationEmail)
  app.delete('/api/v1/user/notify-email', removeNotificationEmail)
  app.put('/api/v1/user/notify-email/toggle', toggleNotificationEmail)
  app.get('/api/v1/user/aff', getUserAffiliate)
  app.post('/api/v1/user/aff/transfer', transferUserAffiliateQuota)
  app.get('/api/v1/user/totp/status', getTotpStatus)
  app.get('/api/v1/user/totp/verification-method', getTotpVerificationMethod)
  app.post('/api/v1/user/totp/send-code', sendTotpVerificationCode)
  app.post('/api/v1/user/totp/setup', initiateTotpSetup)
  app.post('/api/v1/user/totp/enable', enableTotp)
  app.post('/api/v1/user/totp/disable', disableTotp)
  app.post('/api/v1/user/totp/step-up', grantTotpStepUp)
  app.post('/api/v1/user/totp/recovery-codes/regenerate', regenerateTotpRecoveryCodes)
  app.get('/api/v1/user/api-keys/:id/usage/daily', getUserApiKeyDailyUsage)
  app.get('/api/v1/usage/stats', usageStats)
  app.get('/api/v1/usage/dashboard/stats', dashboardStats)
  app.get('/api/v1/usage/dashboard/trend', dashboardTrend)
  app.get('/api/v1/usage/dashboard/models', dashboardModels)
  app.get('/api/v1/usage/dashboard/snapshot-v2', dashboardSnapshot)
  app.post('/api/v1/usage/dashboard/api-keys-usage', dashboardApiKeysUsage)
  app.get('/api/v1/usage/errors', listOwnerErrors)
  app.get('/api/v1/usage/errors/:id', getOwnerErrorDetail)
  app.get('/api/v1/usage', listUsage)
  app.get('/api/v1/usage/:id', getUsageDetail)

  app.post('/api/v1/admin/bootstrap', requireAdminToken, handleBootstrap)
  app.post('/api/v1/admin/session/recover', requireAdminToken, recoverAdminSession)
  app.use(
    '/api/v1/admin/*',
    requireAdminSession,
    requireAdminRoutePermission,
    requireAdminMutationSecurity,
    auditAdminRequest,
  )
  // These must precede /admin/users/:id: Hono's parameter route also matches
  // a longer path prefix in some adapters.
  app.get('/api/v1/admin/user-attributes', listUserAttributeDefinitions)
  app.post('/api/v1/admin/user-attributes', createUserAttributeDefinition)
  app.post('/api/v1/admin/user-attributes/batch', batchGetAdminUserAttributes)
  app.put('/api/v1/admin/user-attributes/reorder', reorderUserAttributeDefinitions)
  app.put('/api/v1/admin/user-attributes/:id', updateUserAttributeDefinition)
  app.delete('/api/v1/admin/user-attributes/:id', deleteUserAttributeDefinition)
  app.get('/api/v1/admin/users/:id/attributes', getAdminUserAttributes)
  app.put('/api/v1/admin/users/:id/attributes', updateAdminUserAttributes)
  app.get('/api/v1/admin/settings', getAdminSettings)
  app.put('/api/v1/admin/settings', updateAdminSettings)
  app.get('/api/v1/admin/compliance', getAdminComplianceStatus)
  app.post('/api/v1/admin/compliance/accept', acceptAdminCompliance)
  app.get('/api/v1/admin/usage', listAdminUsage)
  app.get('/api/v1/admin/usage/stats', getAdminUsageStats)
  app.get('/api/v1/admin/usage/search-users', searchAdminUsageUsers)
  app.get('/api/v1/admin/usage/search-api-keys', searchAdminUsageApiKeys)
  app.get('/api/v1/admin/usage/cleanup-tasks', unsupportedAdminUsageCleanup)
  app.post('/api/v1/admin/usage/cleanup-tasks', unsupportedAdminUsageCleanup)
  app.post('/api/v1/admin/usage/cleanup-tasks/:id/cancel', unsupportedAdminUsageCleanup)
  app.get('/api/v1/admin/dashboard/models', getAdminUsageModels)
  app.get('/api/v1/admin/dashboard/snapshot-v2', unsupportedAdminUsageAnalytics)
  app.get('/api/v1/admin/dashboard/user-breakdown', unsupportedAdminUsageAnalytics)
  app.get('/api/v1/admin/ops/requests', listAdminRequests)
  app.get('/api/v1/admin/ops/request-errors', listAdminRequestErrors)
  app.get('/api/v1/admin/ops/upstream-errors', listAdminUpstreamErrors)
  app.get('/api/v1/admin/ops/error-aggregation', getAdminErrorAggregation)
  app.get(
    '/api/v1/admin/ops/request-errors/:id/upstream-errors',
    listRelatedUpstreamErrors,
  )
  app.post('/api/v1/admin/ops/request-errors/:id/:action', actOnAdminRequestError)
  app.post('/api/v1/admin/ops/upstream-errors/:id/:action', actOnAdminUpstreamError)
  app.get('/api/v1/admin/ops/request-errors/:id', getAdminRequestErrorDetail)
  app.get('/api/v1/admin/ops/upstream-errors/:id', getAdminUpstreamErrorDetail)
  app.all('/api/v1/admin/ops/*', unsupportedAdminOps)
  app.get('/api/v1/admin/announcements', listAdminAnnouncements)
  app.post('/api/v1/admin/announcements', createAdminAnnouncement)
  app.get('/api/v1/admin/announcements/:id', getAdminAnnouncement)
  app.put('/api/v1/admin/announcements/:id', updateAdminAnnouncement)
  app.delete('/api/v1/admin/announcements/:id', deleteAdminAnnouncement)
  app.get('/api/v1/admin/announcements/:id/read-status', listAdminAnnouncementReadStatus)
  app.get('/api/v1/admin/commercial/config', getAdminCommercialConfig)
  app.put('/api/v1/admin/commercial/config', updateAdminCommercialConfig)
  app.get('/api/v1/admin/oauth-providers', listAdminOAuthProviders)
  app.get('/api/v1/admin/oauth-providers/:provider', getAdminOAuthProvider)
  app.put('/api/v1/admin/oauth-providers/:provider', upsertAdminOAuthProvider)
  app.post('/api/v1/admin/oauth-providers/:provider/disable', disableAdminOAuthProvider)
  app.get('/api/v1/admin/users', listAdminUsers)
  app.post('/api/v1/admin/users', createAdminUser)
  app.post('/api/v1/admin/users/batch-limits', batchUpdateAdminUserLimits)
  app.get('/api/v1/admin/users/:id', getAdminUser)
  app.get('/api/v1/admin/users/:id/balance-history', listAdminUserBalanceHistory)
  app.post('/api/v1/admin/users/:id/balance-history/backfill', backfillAdminUserFinancialHistory)
  app.post(
    '/api/v1/admin/financial-history/backfill-batches',
    createAdminFinancialHistoryBackfillBatch,
  )
  app.get(
    '/api/v1/admin/financial-history/backfill-batches/:id',
    getAdminFinancialHistoryBackfillBatch,
  )
  app.post(
    '/api/v1/admin/financial-history/backfill-batches/:id/continue',
    continueAdminFinancialHistoryBackfillBatch,
  )
  app.put('/api/v1/admin/users/:id', updateAdminUser)
  app.post('/api/v1/admin/users/:id/balance', adjustAdminUserBalance)
  app.get('/api/v1/admin/users/:id/platform-quotas', getAdminUserPlatformQuotas)
  app.put('/api/v1/admin/users/:id/platform-quotas', replaceAdminUserPlatformQuotas)
  app.post('/api/v1/admin/users/:id/platform-quotas/reset', resetAdminUserPlatformQuotaWindow)
  app.get('/api/v1/admin/platform-quota-defaults', getAdminPlatformQuotaDefaults)
  app.put('/api/v1/admin/platform-quota-defaults', replaceAdminPlatformQuotaDefaults)
  app.get('/api/v1/admin/users/:id/api-keys', listAdminApiKeys)
  app.post('/api/v1/admin/users/:id/api-keys', createAdminApiKey)
  app.put('/api/v1/admin/api-keys/:id', updateAdminApiKey)
  app.delete('/api/v1/admin/api-keys/:id', revokeAdminApiKey)
  app.get('/api/v1/admin/groups', listAdminGroups)
  app.get('/api/v1/admin/groups/all', allAdminGroups)
  app.get('/api/v1/admin/groups/usage-summary', getAdminGroupUsageSummary)
  app.get('/api/v1/admin/groups/capacity-summary', getAdminGroupCapacitySummary)
  app.post('/api/v1/admin/groups', createAdminGroup)
  app.post('/api/v1/admin/groups/:id/duplicate', duplicateAdminGroup)
  app.put('/api/v1/admin/groups/sort-order', updateAdminGroupSortOrder)
  app.get('/api/v1/admin/groups/:id/rate-multipliers', listAdminGroupRateMultipliers)
  app.put('/api/v1/admin/groups/:id/rate-multipliers', putAdminGroupRateMultipliers)
  app.delete('/api/v1/admin/groups/:id/rate-multipliers', clearAdminGroupRateMultipliers)
  app.get('/api/v1/admin/groups/:id/composite-routes', listCompositeRoutes)
  app.post('/api/v1/admin/groups/:id/composite-routes', createCompositeRoute)
  app.put('/api/v1/admin/groups/:id/composite-routes/:route_id', updateCompositeRoute)
  app.delete('/api/v1/admin/groups/:id/composite-routes/:route_id', deleteCompositeRoute)
  app.post('/api/v1/admin/groups/:id/composite-routes/preview', previewCompositeRoute)
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
  app.get('/api/v1/admin/channels', listAdminChannels)
  app.post('/api/v1/admin/channels', createAdminChannel)
  app.get('/api/v1/admin/channels/model-pricing', getAdminChannelModelPricing)
  app.get('/api/v1/admin/channels/pricing/sync-models', listAdminChannelPricingModels)
  app.get('/api/v1/admin/channels/:id', getAdminChannel)
  app.put('/api/v1/admin/channels/:id', updateAdminChannel)
  app.delete('/api/v1/admin/channels/:id', deleteAdminChannel)
  app.get('/api/v1/admin/accounts', listAdminAccounts)
  app.post('/api/v1/admin/accounts', createAdminAccount)
  app.post('/api/v1/admin/accounts/:id/duplicate', duplicateAdminAccount)
  app.post('/api/v1/admin/accounts/:id/refresh', refreshAdminAccountCredentials)
  app.post('/api/v1/admin/accounts/batch-refresh', batchRefreshAdminAccountCredentials)
  app.post('/api/v1/admin/accounts/batch-delete', batchDeleteAdminAccounts)
  app.post('/api/v1/admin/accounts/batch-clear-error', resetAdminAccountStatuses)
  app.post('/api/v1/admin/accounts/bulk-update', bulkUpdateAdminAccounts)
  app.post('/api/v1/admin/accounts/health-probes', queueAdminAccountHealthProbes)
  app.post('/api/v1/admin/accounts/synthetic-probes', queueAdminAccountSyntheticProbes)
  app.get('/api/v1/admin/accounts/synthetic-probes/history', listAdminAccountSyntheticProbeHistory)
  app.get('/api/v1/admin/accounts/:id/stats', getAdminAccountStats)
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
  app.get('/api/v1/admin/payment/reconciliation', listAdminPaymentReconciliationIssues)
  app.get('/api/v1/admin/payment/reconciliation/:id', getAdminPaymentReconciliationIssue)
  app.get(
    '/api/v1/admin/payment/reconciliation/:id/evidence',
    downloadAdminPaymentReconciliationEvidence,
  )
  app.post('/api/v1/admin/payment/reconciliation/:id/:action', actOnAdminPaymentReconciliationIssue)
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
  app.get('/api/v1/admin/promo-codes', listAdminPromotionCodes)
  app.post('/api/v1/admin/promo-codes', createAdminPromotionCode)
  app.get('/api/v1/admin/promo-codes/:id/usages', listAdminPromotionUsages)
  app.get('/api/v1/admin/promo-codes/:id', getAdminPromotionCode)
  app.put('/api/v1/admin/promo-codes/:id', updateAdminPromotionCode)
  app.delete('/api/v1/admin/promo-codes/:id', deleteAdminPromotionCode)
  app.get('/api/v1/admin/invitation-codes', listAdminInvitationCodes)
  app.post('/api/v1/admin/invitation-codes', createAdminInvitationCode)
  app.get('/api/v1/admin/invitation-codes/:id/usages', listAdminInvitationUsages)
  app.get('/api/v1/admin/invitation-codes/:id', getAdminInvitationCode)
  app.put('/api/v1/admin/invitation-codes/:id', updateAdminInvitationCode)
  app.delete('/api/v1/admin/invitation-codes/:id', deleteAdminInvitationCode)
  app.get('/api/v1/admin/affiliates/users', listAdminAffiliateUsers)
  app.get('/api/v1/admin/affiliates/users/lookup', lookupAdminAffiliateUsers)
  app.post('/api/v1/admin/affiliates/users/batch-rate', batchUpdateAdminAffiliateRates)
  app.get('/api/v1/admin/affiliates/users/:user_id/overview', getAdminAffiliateUserOverview)
  app.put('/api/v1/admin/affiliates/users/:user_id', updateAdminAffiliateUser)
  app.delete('/api/v1/admin/affiliates/users/:user_id', clearAdminAffiliateUser)
  app.get('/api/v1/admin/affiliates/invites', listAdminAffiliateInvites)
  app.get('/api/v1/admin/affiliates/rebates', listAdminAffiliateRebates)
  app.get('/api/v1/admin/affiliates/transfers', listAdminAffiliateTransfers)
  app.post('/api/v1/admin/affiliates/rebates/accrue', accrueAdminAffiliateRebate)
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
  app.get(
    '/api/v1/admin/audit-logs',
    requireAdminPermission('admin.audit.read'),
    listAdminRequestAuditLogs,
  )
  app.post('/api/v1/admin/audit-logs/clear', clearAdminRequestAuditLogs)
  app.get(
    '/api/v1/admin/audit-logs/:id',
    requireAdminPermission('admin.audit.read'),
    getAdminRequestAuditLog,
  )

  app.get('/api/v1/keys', listUserApiKeys)
  app.post('/api/v1/keys', createUserApiKey)
  app.get('/api/v1/keys/:id', getUserApiKey)
  app.put('/api/v1/keys/:id', updateUserApiKey)
  app.delete('/api/v1/keys/:id', revokeUserApiKey)
  app.get('/api/v1/groups/available', listAvailableUserGroups)
  app.get('/api/v1/groups/rates', getUserGroupRates)
  app.get('/api/v1/channels/available', listAvailableUserChannels)
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
  app.get('/api/v1/payment/orders/:id/receipt', getMyPaymentReceipt)
  app.get('/api/v1/payment/orders/:id/receipt/download', downloadMyPaymentReceipt)
  app.get('/api/v1/payment/orders/:id', getMyPaymentOrder)
  app.post('/api/v1/payment/orders/:id/cancel', cancelMyPaymentOrder)
  app.post('/api/v1/payment/orders/:id/refund-request', requestPaymentRefund)
  app.post('/api/v1/payment/public/orders/verify', verifyPaymentOrderPublic)
  app.post('/api/v1/payment/public/orders/resolve', resolvePaymentOrderPublic)
  app.post('/api/v1/payment/webhook/stripe', handleStripeWebhook)
  app.get('/api/v1/model-plaza', getModelPlaza)

  app.post('/api/v1/user/image-batches', submitUserMediaTask)
  app.get('/api/v1/user/image-batches', listUserMediaTasks)
  app.get('/api/v1/user/image-batches/models', listUserMediaModels)
  app.get('/api/v1/user/image-batches/:id', getUserMediaTask)
  app.get('/api/v1/user/image-batches/:id/items', listUserMediaTaskItems)
  app.get('/api/v1/user/image-batches/:id/items/:customId/content', getUserMediaTaskItemContent)
  app.get('/api/v1/user/image-batches/:id/download', downloadUserMediaTask)
  app.post('/api/v1/user/image-batches/:id/cancel', cancelUserMediaTask)
  app.delete('/api/v1/user/image-batches/:id/outputs', deleteUserMediaTaskOutputs)
  app.delete('/api/v1/user/image-batches/:id', deleteUserMediaTask)

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
  app.post('/v1/images/generations', (context) => handleSyncImages(context, 'generations'))
  app.post('/images/generations', (context) => handleSyncImages(context, 'generations'))
  app.post('/v1/images/edits', (context) => handleSyncImages(context, 'edits'))
  app.post('/images/edits', (context) => handleSyncImages(context, 'edits'))
  app.post('/v1/images/generations/async', (context) => submitAsyncImageTask(context, 'generations'))
  app.post('/images/generations/async', (context) => submitAsyncImageTask(context, 'generations'))
  app.post('/v1/images/edits/async', (context) => submitAsyncImageTask(context, 'edits'))
  app.post('/images/edits/async', (context) => submitAsyncImageTask(context, 'edits'))
  app.get('/v1/images/tasks/:id/content/:index', getAsyncImageTaskContent)
  app.get('/images/tasks/:id/content/:index', getAsyncImageTaskContent)
  app.get('/v1/images/tasks/:id', getAsyncImageTask)
  app.get('/images/tasks/:id', getAsyncImageTask)
  app.post('/v1/images/batches', submitGatewayMediaTask)
  app.get('/v1/images/batches', listGatewayMediaTasks)
  app.get('/v1/images/batches/models', listGatewayMediaModels)
  app.get('/v1/images/batches/:id', getGatewayMediaTask)
  app.get('/v1/images/batches/:id/items', listGatewayMediaTaskItems)
  app.get('/v1/images/batches/:id/items/:customId/content', getGatewayMediaTaskItemContent)
  app.get('/v1/images/batches/:id/download', downloadGatewayMediaTask)
  app.post('/v1/images/batches/:id/cancel', cancelGatewayMediaTask)
  app.delete('/v1/images/batches/:id/outputs', deleteGatewayMediaTaskOutputs)
  app.delete('/v1/images/batches/:id', deleteGatewayMediaTask)
  app.all('/v1/videos', unsupportedVideoGeneration)
  app.all('/v1/videos/*', unsupportedVideoGeneration)

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
