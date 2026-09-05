/**
 * User Payment API endpoints
 * Handles payment operations for regular users
 */

import { apiClient } from './client'
import type {
  PaymentConfig,
  SubscriptionPlan,
  MethodLimitsResponse,
  CheckoutInfoResponse,
  CreateOrderRequest,
  CreateOrderResult,
  PaymentOrder,
  PaymentReceiptMetadata,
  PaymentResourceId,
} from '@/types/payment'
import type { BasePaginationResponse } from '@/types'

export interface PublicOrderVerifyResult {
  out_trade_no: string
  status: string
  paid: boolean
  created_at: string
  expires_at: string
}

function orderOperationKey(scope: string): string {
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${requestID}`
}

export const paymentAPI = {
  /** Get payment configuration (enabled types, limits, etc.) */
  getConfig() {
    return apiClient.get<PaymentConfig>('/payment/config')
  },

  /** Get available subscription plans */
  getPlans() {
    return apiClient.get<SubscriptionPlan[]>('/payment/plans')
  },

  /** Get one enabled subscription plan by its opaque Worker or legacy ID. */
  getPlan(id: string | number) {
    return apiClient.get<SubscriptionPlan>(`/payment/plans/${id}`)
  },

  /** Get all checkout page data in a single call */
  getCheckoutInfo() {
    return apiClient.get<CheckoutInfoResponse>('/payment/checkout-info')
  },

  /** Get payment method limits and fee rates */
  getLimits() {
    return apiClient.get<MethodLimitsResponse>('/payment/limits')
  },

  /** Create a new payment order */
  createOrder(data: CreateOrderRequest) {
    return apiClient.post<CreateOrderResult>('/payment/orders', data, {
      headers: { 'Idempotency-Key': orderOperationKey('payment-order-create') },
    })
  },

  /** Get current user's orders */
  getMyOrders(params?: { page?: number; page_size?: number; status?: string }) {
    return apiClient.get<BasePaginationResponse<PaymentOrder>>('/payment/orders/my', { params })
  },

  /** Get a specific order by ID */
  getOrder(id: PaymentResourceId) {
    return apiClient.get<PaymentOrder>(`/payment/orders/${id}`)
  },

  /** Cancel a pending order */
  cancelOrder(id: PaymentResourceId) {
    return apiClient.post(`/payment/orders/${id}/cancel`)
  },

  /** Verify order payment status with upstream provider */
  verifyOrder(outTradeNo: string) {
    return apiClient.post<PaymentOrder>('/payment/orders/verify', { out_trade_no: outTradeNo })
  },

  /** Legacy-compatible public order lookup by out_trade_no */
  verifyOrderPublic(outTradeNo: string) {
    return apiClient.post<PublicOrderVerifyResult>('/payment/public/orders/verify', { out_trade_no: outTradeNo })
  },

  /** Resolve an order from a signed resume token without auth */
  resolveOrderPublicByResumeToken(resumeToken: string) {
    return apiClient.post<PublicOrderVerifyResult>('/payment/public/orders/resolve', { resume_token: resumeToken })
  },

  /** Request a refund for a completed order */
  requestRefund(id: PaymentResourceId, data: { reason: string }) {
    return apiClient.post(`/payment/orders/${id}/refund-request`, data)
  },

  /** Get provider instance IDs that allow user refund */
  getRefundEligibleProviders() {
    return apiClient.get<{ provider_instance_ids: string[] }>('/payment/orders/refund-eligible-providers')
  },

  /** Materialize and return immutable receipt metadata for an owned completed order. */
  getReceipt(id: PaymentResourceId) {
    return apiClient.get<PaymentReceiptMetadata>(`/payment/orders/${id}/receipt`)
  },

  /** Download receipt content through the authenticated API client. */
  downloadReceipt(id: PaymentResourceId) {
    return apiClient.get<Blob>(`/payment/orders/${id}/receipt/download`, {
      responseType: 'blob',
    })
  }
}
