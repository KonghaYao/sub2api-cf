<template>
  <section class="space-y-4" data-testid="payment-reconciliation-panel">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold text-gray-900 dark:text-white">Payment reconciliation</h2>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          Review payment exceptions without changing financial state directly.
        </p>
      </div>
      <button class="btn btn-secondary" type="button" :disabled="loading" @click="loadIssues">
        <Icon name="refresh" size="sm" :class="loading ? 'animate-spin' : ''" />
        Refresh
      </button>
    </div>

    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      <select
        v-model="filters.status"
        class="input"
        data-testid="reconciliation-status-filter"
        @change="filtersChanged"
      >
        <option value="">All statuses</option>
        <option v-for="value in STATUS_OPTIONS" :key="value" :value="value">
          {{ humanize(value) }}
        </option>
      </select>
      <select v-model="filters.type" class="input" @change="filtersChanged">
        <option value="">All issue types</option>
        <option v-for="value in TYPE_OPTIONS" :key="value" :value="value">
          {{ humanize(value) }}
        </option>
      </select>
      <select v-model="filters.severity" class="input" @change="filtersChanged">
        <option value="">All severities</option>
        <option v-for="value in SEVERITY_OPTIONS" :key="value" :value="value">
          {{ humanize(value) }}
        </option>
      </select>
      <select v-model="filters.sourceKind" class="input" @change="filtersChanged">
        <option value="">All sources</option>
        <option v-for="value in SOURCE_OPTIONS" :key="value" :value="value">
          {{ humanize(value) }}
        </option>
      </select>
      <div class="flex gap-2">
        <input
          v-model.trim="filters.orderId"
          class="input min-w-0 flex-1"
          type="text"
          placeholder="Order ID"
          @keyup.enter="filtersChanged"
        />
        <button class="btn btn-secondary" type="button" @click="filtersChanged">Apply</button>
      </div>
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-dark-600">
      <table class="min-w-full divide-y divide-gray-200 text-sm dark:divide-dark-600">
        <thead class="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-dark-700 dark:text-gray-400">
          <tr>
            <th class="px-3 py-2">Issue</th>
            <th class="px-3 py-2">Status</th>
            <th class="px-3 py-2">Source</th>
            <th class="px-3 py-2">Order</th>
            <th class="px-3 py-2">Last seen</th>
            <th class="px-3 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 bg-white dark:divide-dark-700 dark:bg-dark-800">
          <tr v-if="loading">
            <td colspan="6" class="px-3 py-8 text-center text-gray-500">Loading reconciliation issues…</td>
          </tr>
          <tr v-else-if="issues.length === 0">
            <td colspan="6" class="px-3 py-8 text-center text-gray-500">No reconciliation issues found.</td>
          </tr>
          <tr v-for="issue in issues" v-else :key="issue.id" class="align-top">
            <td class="max-w-md px-3 py-3">
              <div class="flex items-center gap-2">
                <span :class="severityClass(issue.severity)">{{ humanize(issue.severity) }}</span>
                <span class="font-medium text-gray-900 dark:text-white">{{ humanize(issue.type) }}</span>
              </div>
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ issue.summary }}</p>
            </td>
            <td class="px-3 py-3">
              <span :class="statusClass(issue.status)">{{ humanize(issue.status) }}</span>
              <div class="mt-1 font-mono text-[11px] text-gray-400">v{{ issue.version }}</div>
            </td>
            <td class="px-3 py-3 text-xs text-gray-600 dark:text-gray-300">
              <div>{{ humanize(issue.source.kind) }}</div>
              <div class="max-w-44 truncate font-mono text-gray-400" :title="issue.source.id">
                {{ issue.source.id }}
              </div>
            </td>
            <td class="px-3 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
              {{ issue.order_id || '—' }}
            </td>
            <td class="whitespace-nowrap px-3 py-3 text-xs text-gray-500">
              {{ formatTime(issue.last_seen_at) }}
            </td>
            <td class="px-3 py-3 text-right">
              <button
                class="btn btn-secondary btn-sm"
                type="button"
                :data-testid="`reconciliation-view-${issue.id}`"
                @click="loadDetail(issue.id)"
              >
                View
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="pagination.total > 0" class="flex items-center justify-between text-xs text-gray-500">
      <span>Page {{ pagination.page }} of {{ Math.max(1, pagination.pages) }} · {{ pagination.total }} issues</span>
      <div class="flex gap-2">
        <button
          class="btn btn-secondary btn-sm"
          type="button"
          :disabled="pagination.page <= 1 || loading"
          @click="changePage(pagination.page - 1)"
        >
          Previous
        </button>
        <button
          class="btn btn-secondary btn-sm"
          type="button"
          :disabled="pagination.page >= pagination.pages || loading"
          @click="changePage(pagination.page + 1)"
        >
          Next
        </button>
      </div>
    </div>

    <aside
      v-if="detail"
      class="space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-dark-600 dark:bg-dark-700"
      data-testid="reconciliation-detail"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <h3 class="font-semibold text-gray-900 dark:text-white">{{ humanize(detail.issue.type) }}</h3>
            <span :class="statusClass(detail.issue.status)">{{ humanize(detail.issue.status) }}</span>
          </div>
          <p class="mt-1 text-sm text-gray-600 dark:text-gray-300">{{ detail.issue.summary }}</p>
          <p class="mt-1 font-mono text-xs text-gray-400">{{ detail.issue.id }} · v{{ detail.issue.version }}</p>
        </div>
        <div class="flex gap-2">
          <button
            v-if="detail.issue.evidence.available"
            class="btn btn-secondary btn-sm"
            type="button"
            data-testid="reconciliation-download-evidence"
            :disabled="downloadingEvidence"
            @click="downloadEvidence"
          >
            Download evidence
          </button>
          <button class="btn btn-secondary btn-sm" type="button" @click="detail = null">Close</button>
        </div>
      </div>

      <dl class="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div><dt class="text-gray-400">Source</dt><dd class="mt-1 font-mono">{{ detail.issue.source.kind }} / {{ detail.issue.source.id }}</dd></div>
        <div><dt class="text-gray-400">Order</dt><dd class="mt-1 font-mono">{{ detail.issue.order_id || '—' }}</dd></div>
        <div><dt class="text-gray-400">First observed</dt><dd class="mt-1">{{ formatTime(detail.issue.first_observed_at) }}</dd></div>
        <div><dt class="text-gray-400">Last seen</dt><dd class="mt-1">{{ formatTime(detail.issue.last_seen_at) }}</dd></div>
      </dl>

      <div v-if="detail.issue.resolution" class="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-300">
        <strong>{{ detail.issue.resolution.code }}</strong>
        <p class="mt-1">{{ detail.issue.resolution.note }}</p>
      </div>

      <div class="space-y-3 border-t border-gray-200 pt-4 dark:border-dark-600">
        <div v-if="detail.issue.status !== 'resolved'">
          <label class="input-label">Resolution code</label>
          <input
            v-model.trim="resolutionCode"
            class="input"
            type="text"
            maxlength="100"
            placeholder="Required only when resolving"
            data-testid="reconciliation-resolution-code"
          />
        </div>
        <div>
          <label class="input-label">Operator note</label>
          <textarea
            v-model="actionNote"
            class="input min-h-20"
            maxlength="2000"
            placeholder="Record what was checked or changed in the provider workflow"
            data-testid="reconciliation-action-note"
          />
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="detail.issue.status === 'open'"
            class="btn btn-secondary"
            type="button"
            data-testid="reconciliation-acknowledge"
            :disabled="acting"
            @click="performAction('acknowledge')"
          >
            Acknowledge
          </button>
          <button
            v-if="detail.issue.status !== 'resolved'"
            class="btn btn-primary"
            type="button"
            data-testid="reconciliation-resolve"
            :disabled="acting || !resolutionCode || !actionNote.trim()"
            @click="performAction('resolve')"
          >
            Resolve
          </button>
          <button
            v-if="detail.issue.status === 'resolved'"
            class="btn btn-secondary"
            type="button"
            data-testid="reconciliation-reopen"
            :disabled="acting"
            @click="performAction('reopen')"
          >
            Reopen
          </button>
        </div>
      </div>

      <div v-if="detail.events.length > 0" class="border-t border-gray-200 pt-4 dark:border-dark-600">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">Audit history</h4>
        <ol class="mt-2 space-y-2">
          <li v-for="event in detail.events" :key="event.id" class="rounded-md bg-white p-2 text-xs dark:bg-dark-800">
            <span class="font-medium">{{ humanize(event.action) }}</span>
            <span class="text-gray-500"> · {{ event.from_status }} → {{ event.to_status }} · {{ formatTime(event.occurred_at) }}</span>
          </li>
        </ol>
      </div>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  adminPaymentAPI,
  type PaymentReconciliationAction,
  type PaymentReconciliationIssue,
  type PaymentReconciliationIssueDetail,
  type PaymentReconciliationIssueType,
  type PaymentReconciliationSeverity,
  type PaymentReconciliationSourceKind,
  type PaymentReconciliationStatus,
} from '@/api/admin/payment'
import Icon from '@/components/icons/Icon.vue'
import { useAppStore } from '@/stores/app'
import { extractI18nErrorMessage } from '@/utils/apiError'

const STATUS_OPTIONS: PaymentReconciliationStatus[] = ['open', 'acknowledged', 'resolved']
const SEVERITY_OPTIONS: PaymentReconciliationSeverity[] = ['warning', 'error', 'critical']
const SOURCE_OPTIONS: PaymentReconciliationSourceKind[] = ['order', 'webhook', 'fulfillment', 'refund']
const TYPE_OPTIONS: PaymentReconciliationIssueType[] = [
  'late_paid_refund_required',
  'webhook_pending',
  'webhook_failed',
  'fulfillment_pending',
  'fulfillment_failed',
  'refund_pending',
  'refund_failed',
  'provider_amount_mismatch',
  'provider_status_mismatch',
]

const { t } = useI18n()
const appStore = useAppStore()
const loading = ref(false)
const acting = ref(false)
const downloadingEvidence = ref(false)
const issues = ref<PaymentReconciliationIssue[]>([])
const detail = ref<PaymentReconciliationIssueDetail | null>(null)
const actionNote = ref('')
const resolutionCode = ref('')
const pagination = reactive({ page: 1, pageSize: 20, total: 0, pages: 0 })
const filters = reactive<{
  status: '' | PaymentReconciliationStatus
  type: '' | PaymentReconciliationIssueType
  severity: '' | PaymentReconciliationSeverity
  sourceKind: '' | PaymentReconciliationSourceKind
  orderId: string
}>({ status: '', type: '', severity: '', sourceKind: '', orderId: '' })

async function loadIssues(): Promise<void> {
  loading.value = true
  try {
    const response = await adminPaymentAPI.getReconciliationIssues({
      page: pagination.page,
      page_size: pagination.pageSize,
      status: filters.status || undefined,
      type: filters.type || undefined,
      severity: filters.severity || undefined,
      source_kind: filters.sourceKind || undefined,
      order_id: filters.orderId || undefined,
    })
    issues.value = response.data.items || []
    pagination.total = response.data.total || 0
    pagination.pages = response.data.pages || 0
  } catch (error: unknown) {
    appStore.showError(extractI18nErrorMessage(error, t, 'payment.errors', t('common.error')))
  } finally {
    loading.value = false
  }
}

async function loadDetail(id: string): Promise<void> {
  try {
    const response = await adminPaymentAPI.getReconciliationIssue(id)
    detail.value = response.data
    actionNote.value = ''
    resolutionCode.value = ''
  } catch (error: unknown) {
    appStore.showError(extractI18nErrorMessage(error, t, 'payment.errors', t('common.error')))
  }
}

async function performAction(action: PaymentReconciliationAction): Promise<void> {
  const current = detail.value?.issue
  if (!current || acting.value) return
  acting.value = true
  try {
    const payload = action === 'resolve'
      ? { note: actionNote.value.trim(), resolution_code: resolutionCode.value.trim() }
      : { note: actionNote.value.trim() }
    const response = await adminPaymentAPI.actOnReconciliationIssue(
      current.id,
      action,
      current.version,
      payload,
    )
    detail.value = { ...detail.value!, issue: response.data }
    const successMessages: Record<PaymentReconciliationAction, string> = {
      acknowledge: 'Reconciliation issue acknowledged',
      resolve: 'Reconciliation issue resolved',
      reopen: 'Reconciliation issue reopened',
    }
    appStore.showSuccess(successMessages[action])
    await Promise.all([loadIssues(), loadDetail(current.id)])
  } catch (error: unknown) {
    appStore.showError(extractI18nErrorMessage(error, t, 'payment.errors', t('common.error')))
    if (isConflict(error)) await Promise.all([loadIssues(), loadDetail(current.id)])
  } finally {
    acting.value = false
  }
}

async function downloadEvidence(): Promise<void> {
  const current = detail.value?.issue
  if (!current || downloadingEvidence.value) return
  downloadingEvidence.value = true
  try {
    const response = await adminPaymentAPI.downloadReconciliationEvidence(current.id)
    const objectUrl = URL.createObjectURL(response.data)
    try {
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = `payment-reconciliation-${current.id}.json`
      link.rel = 'noopener'
      link.click()
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch (error: unknown) {
    appStore.showError(extractI18nErrorMessage(error, t, 'payment.errors', t('common.error')))
  } finally {
    downloadingEvidence.value = false
  }
}

function filtersChanged(): void {
  pagination.page = 1
  void loadIssues()
}

function changePage(page: number): void {
  pagination.page = page
  void loadIssues()
}

function isConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as { status?: unknown }).status === 409
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function severityClass(severity: PaymentReconciliationSeverity): string {
  const base = 'rounded-full px-2 py-0.5 text-[11px] font-medium'
  if (severity === 'critical') return `${base} bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300`
  if (severity === 'error') return `${base} bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300`
  return `${base} bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300`
}

function statusClass(status: PaymentReconciliationStatus): string {
  const base = 'rounded-full px-2 py-0.5 text-xs font-medium'
  if (status === 'resolved') return `${base} bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300`
  if (status === 'acknowledged') return `${base} bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300`
  return `${base} bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300`
}

onMounted(() => {
  void loadIssues()
})
</script>
