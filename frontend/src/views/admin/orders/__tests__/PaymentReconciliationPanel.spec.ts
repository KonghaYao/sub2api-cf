import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PaymentReconciliationIssue } from '@/api/admin/payment'

const getReconciliationIssues = vi.hoisted(() => vi.fn())
const getReconciliationIssue = vi.hoisted(() => vi.fn())
const actOnReconciliationIssue = vi.hoisted(() => vi.fn())
const downloadReconciliationEvidence = vi.hoisted(() => vi.fn())
const showSuccess = vi.hoisted(() => vi.fn())
const showError = vi.hoisted(() => vi.fn())
const createObjectURL = vi.hoisted(() => vi.fn(() => 'blob:reconciliation-evidence'))
const revokeObjectURL = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showSuccess, showError }),
}))

vi.mock('@/api/admin/payment', () => ({
  adminPaymentAPI: {
    getReconciliationIssues,
    getReconciliationIssue,
    actOnReconciliationIssue,
    downloadReconciliationEvidence,
  },
}))

import PaymentReconciliationPanel from '../PaymentReconciliationPanel.vue'

let currentIssue: PaymentReconciliationIssue

beforeEach(() => {
  currentIssue = issue({ status: 'open', version: 0 })
  getReconciliationIssues.mockReset().mockImplementation(async () => ({
    data: { items: [currentIssue], total: 1, page: 1, page_size: 20, pages: 1 },
  }))
  getReconciliationIssue.mockReset().mockImplementation(async () => ({
    data: { issue: currentIssue, actions: [], events: [] },
  }))
  actOnReconciliationIssue.mockReset().mockImplementation(async (
    _id: string,
    action: 'acknowledge' | 'resolve' | 'reopen',
  ) => {
    currentIssue = issue({
      status: action === 'acknowledge'
        ? 'acknowledged'
        : action === 'resolve' ? 'resolved' : 'open',
      version: currentIssue.version + 1,
      resolution: action === 'resolve'
        ? {
            code: 'provider_refunded',
            note: 'Provider refund confirmed',
            by_user_id: 'admin-1',
            at: '2026-09-05T09:05:00.000Z',
          }
        : null,
    })
    return { data: currentIssue }
  })
  downloadReconciliationEvidence.mockReset().mockResolvedValue({
    data: new Blob(['{"safe":true}'], { type: 'application/json' }),
  })
  showSuccess.mockReset()
  showError.mockReset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURL,
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PaymentReconciliationPanel', () => {
  it('loads, filters, opens detail, and downloads guarded evidence', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(getReconciliationIssues).toHaveBeenLastCalledWith({
      page: 1,
      page_size: 20,
      status: undefined,
      type: undefined,
      severity: undefined,
      source_kind: undefined,
      order_id: undefined,
    })

    await wrapper.get('[data-testid="reconciliation-status-filter"]').setValue('open')
    await flushPromises()
    expect(getReconciliationIssues).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      status: 'open',
    }))

    await wrapper.get('[data-testid="reconciliation-view-issue-1"]').trigger('click')
    await flushPromises()
    expect(getReconciliationIssue).toHaveBeenCalledWith('issue-1')
    expect(wrapper.get('[data-testid="reconciliation-detail"]').text()).toContain(
      'Payment arrived after expiry',
    )

    await wrapper.get('[data-testid="reconciliation-download-evidence"]').trigger('click')
    await flushPromises()
    expect(downloadReconciliationEvidence).toHaveBeenCalledWith('issue-1')
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:reconciliation-evidence')
  })

  it('uses the displayed issue version for acknowledge, resolve, and reopen actions', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="reconciliation-view-issue-1"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="reconciliation-action-note"]').setValue('Investigating')
    await wrapper.get('[data-testid="reconciliation-acknowledge"]').trigger('click')
    await flushPromises()
    expect(actOnReconciliationIssue).toHaveBeenNthCalledWith(
      1,
      'issue-1',
      'acknowledge',
      0,
      { note: 'Investigating' },
    )

    await wrapper.get('[data-testid="reconciliation-resolution-code"]').setValue(
      'provider_refunded',
    )
    await wrapper.get('[data-testid="reconciliation-action-note"]').setValue(
      'Provider refund confirmed',
    )
    await wrapper.get('[data-testid="reconciliation-resolve"]').trigger('click')
    await flushPromises()
    expect(actOnReconciliationIssue).toHaveBeenNthCalledWith(
      2,
      'issue-1',
      'resolve',
      1,
      { note: 'Provider refund confirmed', resolution_code: 'provider_refunded' },
    )

    await wrapper.get('[data-testid="reconciliation-action-note"]').setValue('Reopened')
    await wrapper.get('[data-testid="reconciliation-reopen"]').trigger('click')
    await flushPromises()
    expect(actOnReconciliationIssue).toHaveBeenNthCalledWith(
      3,
      'issue-1',
      'reopen',
      2,
      { note: 'Reopened' },
    )
    expect(showSuccess).toHaveBeenCalledTimes(3)
  })

  it('reloads current state after an ETag conflict instead of reporting success', async () => {
    actOnReconciliationIssue.mockRejectedValueOnce({
      status: 409,
      code: 'payment_reconciliation_issue_changed',
      message: 'reload and retry',
    })
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="reconciliation-view-issue-1"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="reconciliation-acknowledge"]').trigger('click')
    await flushPromises()

    expect(showSuccess).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalled()
    expect(getReconciliationIssue).toHaveBeenCalledTimes(2)
    expect(getReconciliationIssues).toHaveBeenCalledTimes(2)
  })
})

function mountPanel() {
  return mount(PaymentReconciliationPanel, {
    global: { stubs: { Icon: true } },
  })
}

function issue(
  overrides: Partial<PaymentReconciliationIssue> = {},
): PaymentReconciliationIssue {
  return {
    id: 'issue-1',
    type: 'late_paid_refund_required',
    severity: 'critical',
    status: 'open',
    source: { kind: 'order', id: 'order-1' },
    order_id: 'order-1',
    provider_instance_id: 'provider-1',
    summary: 'Payment arrived after expiry',
    evidence: {
      available: true,
      content_sha256: 'a'.repeat(64),
      content_length: 256,
      download_url: '/api/v1/admin/payment/reconciliation/issue-1/evidence',
    },
    version: 0,
    acknowledged: null,
    resolution: null,
    first_observed_at: '2026-09-05T09:00:00.000Z',
    last_seen_at: '2026-09-05T09:00:00.000Z',
    updated_at: '2026-09-05T09:00:00.000Z',
    ...overrides,
  }
}
