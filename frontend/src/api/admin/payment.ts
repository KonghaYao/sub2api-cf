/**
 * Admin Payment API endpoints
 * Handles payment management operations for administrators
 */

import { apiClient } from '../client'
import type { AxiosResponse } from 'axios'
import type {
  DashboardStats,
  PaymentOrder,
  PaymentChannel,
  SubscriptionPlan,
  ProviderInstance,
  PaymentResourceId,
} from '@/types/payment'
import type { BasePaginationResponse } from '@/types'

/** Admin-facing payment config returned by GET /admin/payment/config */
export interface AdminPaymentConfig {
  enabled: boolean
  min_amount: number
  max_amount: number
  daily_limit: number
  order_timeout_minutes: number
  max_pending_orders: number
  enabled_payment_types: string[]
  balance_disabled: boolean
  balance_recharge_multiplier: number
  subscription_usd_to_cny_rate: number
  recharge_fee_rate: number
  cancel_rate_limit_enabled?: boolean
  cancel_rate_limit_max?: number
  cancel_rate_limit_window?: number
  cancel_rate_limit_unit?: string
  cancel_rate_limit_window_mode?: string
  load_balance_strategy: string
  product_name_prefix: string
  product_name_suffix: string
  help_image_url: string
  help_text: string
  version?: number
  control_version?: number
}

/** Fields accepted by PUT /admin/payment/config (all optional via pointer semantics) */
export interface UpdatePaymentConfigRequest {
  enabled?: boolean
  min_amount?: number
  max_amount?: number
  daily_limit?: number
  order_timeout_minutes?: number
  max_pending_orders?: number
  enabled_payment_types?: string[]
  balance_disabled?: boolean
  balance_recharge_multiplier?: number
  subscription_usd_to_cny_rate?: number
  recharge_fee_rate?: number
  cancel_rate_limit_enabled?: boolean
  cancel_rate_limit_max?: number
  cancel_rate_limit_window?: number
  cancel_rate_limit_unit?: string
  cancel_rate_limit_window_mode?: string
  load_balance_strategy?: string
  product_name_prefix?: string
  product_name_suffix?: string
  help_image_url?: string
  help_text?: string
}

export interface RefundResult {
  success: boolean
  warning?: string
  require_force?: boolean
  balance_deducted?: number
  subscription_days_deducted?: number
}

export type PaymentReconciliationAction = 'acknowledge' | 'resolve' | 'reopen'
export type PaymentReconciliationStatus = 'open' | 'acknowledged' | 'resolved'
export type PaymentReconciliationSeverity = 'warning' | 'error' | 'critical'
export type PaymentReconciliationSourceKind = 'order' | 'webhook' | 'fulfillment' | 'refund'
export type PaymentReconciliationIssueType =
  | 'late_paid_refund_required'
  | 'webhook_pending'
  | 'webhook_failed'
  | 'fulfillment_pending'
  | 'fulfillment_failed'
  | 'refund_pending'
  | 'refund_failed'
  | 'provider_amount_mismatch'
  | 'provider_status_mismatch'

export interface PaymentReconciliationIssue {
  id: string
  type: PaymentReconciliationIssueType
  severity: PaymentReconciliationSeverity
  status: PaymentReconciliationStatus
  source: { kind: PaymentReconciliationSourceKind; id: string }
  order_id: PaymentResourceId | null
  provider_instance_id: PaymentResourceId | null
  summary: string
  evidence: {
    available: boolean
    content_sha256: string | null
    content_length: number | null
    download_url: string | null
  }
  version: number
  acknowledged: { by_user_id: string; at: string } | null
  resolution: { code: string; note: string; by_user_id: string; at: string } | null
  first_observed_at: string
  last_seen_at: string
  updated_at: string
}

export interface PaymentReconciliationIssueDetail {
  issue: PaymentReconciliationIssue
  actions: Array<{
    id: string
    action: PaymentReconciliationAction
    actor_user_id: string
    expected_version: number
    result_version: number
    occurred_at: string
  }>
  events: Array<{
    id: string
    action: string
    from_status: PaymentReconciliationStatus
    to_status: PaymentReconciliationStatus
    issue_version: number
    actor_user_id: string
    detail: unknown
    occurred_at: string
  }>
}

export interface PaymentReconciliationListResponse {
  items: PaymentReconciliationIssue[]
  total: number
  page: number
  page_size: number
  pages: number
}

type WorkerSubscriptionPlan = SubscriptionPlan & {
  control_version?: number
  price_micros?: number
  daily_quota_micros?: number | null
  weekly_quota_micros?: number | null
  monthly_quota_micros?: number | null
  enabled?: boolean
}

const planControlVersions = new Map<string, number>()
const providerControlVersions = new Map<string, number>()
let paymentConfigVersion: number | undefined

function planOperationKey(scope: string): string {
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${requestID}`
}

function rememberPlan(plan: WorkerSubscriptionPlan): void {
  if (Number.isSafeInteger(plan.control_version) && plan.control_version! >= 0) {
    planControlVersions.set(String(plan.id), plan.control_version!)
  }
}

function rememberPaymentConfig(config: AdminPaymentConfig): void {
  const version = config.control_version ?? config.version
  if (Number.isSafeInteger(version) && version! >= 0) paymentConfigVersion = version
}

function rememberProvider(provider: ProviderInstance): void {
  const version = provider.control_version ?? provider.version
  if (Number.isSafeInteger(version) && version! >= 0) {
    providerControlVersions.set(String(provider.id), version!)
  }
}

async function expectedProviderVersion(id: PaymentResourceId): Promise<number> {
  let version = providerControlVersions.get(String(id))
  if (version === undefined) {
    const response = await adminPaymentAPI.getProviders()
    const provider = response.data.find((item) => String(item.id) === String(id))
    version = provider?.control_version ?? provider?.version
  }
  if (!Number.isSafeInteger(version) || version! < 0) {
    throw Object.assign(new Error('Reload this provider before changing it'), {
      code: 'provider_version_not_loaded',
    })
  }
  return version!
}

function adaptWorkerPlan(plan: WorkerSubscriptionPlan): SubscriptionPlan {
  const adapted: SubscriptionPlan = {
    ...plan,
    price: Number.isSafeInteger(plan.price_micros) ? plan.price_micros! / 1_000_000 : plan.price,
    daily_limit_usd: Number.isSafeInteger(plan.daily_quota_micros)
      ? plan.daily_quota_micros! / 1_000_000 : plan.daily_limit_usd,
    weekly_limit_usd: Number.isSafeInteger(plan.weekly_quota_micros)
      ? plan.weekly_quota_micros! / 1_000_000 : plan.weekly_limit_usd,
    monthly_limit_usd: Number.isSafeInteger(plan.monthly_quota_micros)
      ? plan.monthly_quota_micros! / 1_000_000 : plan.monthly_limit_usd,
    for_sale: plan.enabled ?? plan.for_sale,
    features: Array.isArray(plan.features) ? plan.features : [],
  }
  rememberPlan(plan)
  return adapted
}

function expectedPlanVersion(id: string | number): number {
  const version = planControlVersions.get(String(id))
  if (version === undefined) {
    throw Object.assign(new Error('Reload this plan before changing it'), { code: 'plan_version_not_loaded' })
  }
  return version
}

export const adminPaymentAPI = {
  // ==================== Config ====================

  /** Get payment configuration (admin view) */
  async getConfig() {
    const response = await apiClient.get<AdminPaymentConfig>('/admin/payment/config')
    rememberPaymentConfig(response.data)
    return response
  },

  /** Update payment configuration */
  async updateConfig(data: UpdatePaymentConfigRequest) {
    if (paymentConfigVersion === undefined) await adminPaymentAPI.getConfig()
    const expected = paymentConfigVersion!
    const response = await apiClient.put<AdminPaymentConfig>(
      '/admin/payment/config',
      { ...data, expected_control_version: expected },
      { headers: { 'If-Match': `"${expected}"`, 'Idempotency-Key': planOperationKey('admin-payment-config-update') } },
    )
    rememberPaymentConfig(response.data)
    return response
  },

  // ==================== Dashboard ====================

  /** Get payment dashboard statistics */
  getDashboard(days?: number) {
    return apiClient.get<DashboardStats>('/admin/payment/dashboard', {
      params: days ? { days } : undefined
    })
  },

  // ==================== Orders ====================

  /** Get all orders (paginated, with filters) */
  getOrders(params?: {
    page?: number
    page_size?: number
    status?: string
    payment_type?: string
    user_id?: PaymentResourceId
    keyword?: string
    start_date?: string
    end_date?: string
    order_type?: string
  }) {
    return apiClient.get<BasePaginationResponse<PaymentOrder>>('/admin/payment/orders', { params })
  },

  /** Get a specific order by ID */
  getOrder(id: PaymentResourceId) {
    return apiClient.get<PaymentOrder>(`/admin/payment/orders/${id}`)
  },

  /** Cancel an order (admin) */
  cancelOrder(id: PaymentResourceId) {
    return apiClient.post(`/admin/payment/orders/${id}/cancel`)
  },

  /** Retry recharge for a failed order */
  retryRecharge(id: PaymentResourceId) {
    return apiClient.post(`/admin/payment/orders/${id}/retry`)
  },

  /** Process a refund */
  refundOrder(id: PaymentResourceId, data: { amount: number; reason: string; deduct_balance?: boolean; force?: boolean }) {
    return apiClient.post<RefundResult>(`/admin/payment/orders/${id}/refund`, data, {
      headers: { 'Idempotency-Key': planOperationKey('admin-payment-refund') },
    })
  },

  /** Query and finalize a pending refund */
  queryRefund(id: PaymentResourceId) {
    return apiClient.post<RefundResult>(`/admin/payment/orders/${id}/refund/query`)
  },

  // ==================== Reconciliation ====================

  getReconciliationIssues(params?: {
    page?: number
    page_size?: number
    status?: PaymentReconciliationStatus
    type?: PaymentReconciliationIssueType
    severity?: PaymentReconciliationSeverity
    source_kind?: PaymentReconciliationSourceKind
    order_id?: PaymentResourceId
  }) {
    return apiClient.get<PaymentReconciliationListResponse>('/admin/payment/reconciliation', { params })
  },

  getReconciliationIssue(id: string) {
    return apiClient.get<PaymentReconciliationIssueDetail>(`/admin/payment/reconciliation/${id}`)
  },

  actOnReconciliationIssue(
    id: string,
    action: PaymentReconciliationAction,
    expectedVersion: number,
    data: { note?: string; resolution_code?: string } = {},
  ) {
    return apiClient.post<PaymentReconciliationIssue>(
      `/admin/payment/reconciliation/${id}/${action}`,
      { ...data, expected_control_version: expectedVersion },
      {
        headers: {
          'If-Match': `"${expectedVersion}"`,
          'Idempotency-Key': planOperationKey(`admin-payment-reconciliation-${action}`),
        },
      },
    )
  },

  downloadReconciliationEvidence(id: string) {
    return apiClient.get<Blob>(`/admin/payment/reconciliation/${id}/evidence`, {
      responseType: 'blob',
    })
  },

  // ==================== Channels ====================

  /** Get all payment channels */
  getChannels() {
    return apiClient.get<PaymentChannel[]>('/admin/payment/channels')
  },

  /** Create a payment channel */
  createChannel(data: Partial<PaymentChannel>) {
    return apiClient.post<PaymentChannel>('/admin/payment/channels', data)
  },

  /** Update a payment channel */
  updateChannel(id: number, data: Partial<PaymentChannel>) {
    return apiClient.put<PaymentChannel>(`/admin/payment/channels/${id}`, data)
  },

  /** Delete a payment channel */
  deleteChannel(id: number) {
    return apiClient.delete(`/admin/payment/channels/${id}`)
  },

  // ==================== Subscription Plans ====================

  /** Get all subscription plans */
  async getPlans(): Promise<AxiosResponse<SubscriptionPlan[]>> {
    const response = await apiClient.get<WorkerSubscriptionPlan[]>('/admin/payment/plans')
    response.data = response.data.map(adaptWorkerPlan)
    return response
  },

  /** Get one subscription plan, including its version used for CAS writes. */
  async getPlan(id: string | number): Promise<AxiosResponse<SubscriptionPlan>> {
    const response = await apiClient.get<WorkerSubscriptionPlan>(`/admin/payment/plans/${id}`)
    response.data = adaptWorkerPlan(response.data)
    return response
  },

  /** Create a subscription plan */
  async createPlan(data: Record<string, unknown>): Promise<AxiosResponse<SubscriptionPlan>> {
    const response = await apiClient.post<WorkerSubscriptionPlan>('/admin/payment/plans', data, {
      headers: { 'Idempotency-Key': planOperationKey('admin-plan-create') },
    })
    response.data = adaptWorkerPlan(response.data)
    return response
  },

  /** Update a subscription plan */
  async updatePlan(id: string | number, data: Record<string, unknown>): Promise<AxiosResponse<SubscriptionPlan>> {
    const expected = expectedPlanVersion(id)
    const response = await apiClient.put<WorkerSubscriptionPlan>(
      `/admin/payment/plans/${id}`,
      { ...data, expected_control_version: expected },
      { headers: { 'If-Match': `"${expected}"`, 'Idempotency-Key': planOperationKey('admin-plan-update') } },
    )
    response.data = adaptWorkerPlan(response.data)
    return response
  },

  /** Delete a subscription plan */
  async deletePlan(id: string | number): Promise<AxiosResponse<SubscriptionPlan>> {
    const expected = expectedPlanVersion(id)
    const response = await apiClient.delete<WorkerSubscriptionPlan>(`/admin/payment/plans/${id}`, {
      headers: { 'If-Match': `"${expected}"`, 'Idempotency-Key': planOperationKey('admin-plan-disable') },
      data: { expected_control_version: expected },
    })
    response.data = adaptWorkerPlan(response.data)
    return response
  },

  // ==================== Provider Instances ====================

  /** Get all provider instances */
  async getProviders() {
    const response = await apiClient.get<ProviderInstance[]>('/admin/payment/providers')
    response.data.forEach(rememberProvider)
    return response
  },

  /** Create a provider instance */
  async createProvider(data: Partial<ProviderInstance>) {
    const response = await apiClient.post<ProviderInstance>('/admin/payment/providers', data, {
      headers: { 'Idempotency-Key': planOperationKey('admin-payment-provider-create') },
    })
    rememberProvider(response.data)
    return response
  },

  /** Update a provider instance */
  async updateProvider(id: PaymentResourceId, data: Partial<ProviderInstance>) {
    const expected = await expectedProviderVersion(id)
    const response = await apiClient.put<ProviderInstance>(
      `/admin/payment/providers/${id}`,
      { ...data, expected_control_version: expected },
      { headers: { 'If-Match': `"${expected}"`, 'Idempotency-Key': planOperationKey('admin-payment-provider-update') } },
    )
    rememberProvider(response.data)
    return response
  },

  /** Delete a provider instance */
  async deleteProvider(id: PaymentResourceId) {
    const expected = await expectedProviderVersion(id)
    const response = await apiClient.delete<ProviderInstance>(`/admin/payment/providers/${id}`, {
      headers: { 'If-Match': `"${expected}"`, 'Idempotency-Key': planOperationKey('admin-payment-provider-disable') },
      data: { expected_control_version: expected },
    })
    rememberProvider(response.data)
    return response
  }
}

export default adminPaymentAPI
