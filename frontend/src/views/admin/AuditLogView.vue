<template>
  <AppLayout>
    <TablePageLayout>
      <template #filters>
        <div class="card p-4 sm:p-6">
          <div class="flex flex-wrap items-end justify-between gap-4">
            <div class="flex flex-1 flex-wrap items-end gap-4">
              <div class="w-full sm:w-auto sm:min-w-[150px]">
                <label class="input-label">{{ t('admin.audit.filters.category') }}</label>
                <Select v-model="filters.category" :options="categoryOptions" @change="search" />
              </div>
              <div class="w-full sm:w-auto sm:min-w-[210px]">
                <label class="input-label">{{ t('admin.audit.filters.action') }}</label>
                <input v-model.trim="filters.action" type="text" class="input" @keyup.enter="search" />
              </div>
              <div class="w-full sm:w-auto sm:min-w-[150px]">
                <label class="input-label">{{ t('admin.audit.filters.outcome') }}</label>
                <Select v-model="filters.outcome" :options="outcomeOptions" @change="search" />
              </div>
              <div class="w-full sm:w-auto sm:min-w-[200px]">
                <label class="input-label">{{ t('admin.audit.filters.actorUserId') }}</label>
                <input v-model.trim="filters.actor_user_id" type="text" class="input" @keyup.enter="search" />
              </div>
              <div class="w-full sm:w-auto sm:min-w-[180px]">
                <label class="input-label">{{ t('admin.audit.filters.resourceType') }}</label>
                <input v-model.trim="filters.resource_type" type="text" class="input" @keyup.enter="search" />
              </div>
              <div class="w-full sm:w-auto sm:min-w-[210px]">
                <label class="input-label">{{ t('admin.audit.filters.resourceId') }}</label>
                <input v-model.trim="filters.resource_id" type="text" class="input" @keyup.enter="search" />
              </div>
              <div class="w-full sm:w-auto sm:min-w-[170px]">
                <label class="input-label">{{ t('admin.dashboard.timeRange') }}</label>
                <Select
                  :model-value="timeRange"
                  :options="timeRangeOptions"
                  @update:model-value="handleTimeRangeChange"
                />
              </div>
            </div>
            <div class="flex w-full flex-wrap items-center justify-end gap-3 sm:w-auto">
              <button type="button" class="btn btn-primary" :disabled="loading" @click="search">
                {{ t('common.search') }}
              </button>
              <button type="button" class="btn btn-secondary" :disabled="loading" @click="resetFilters">
                {{ t('common.reset') }}
              </button>
            </div>
          </div>
        </div>
      </template>

      <template #table>
        <DataTable :columns="columns" :data="logs" :loading="loading" :row-key="auditRowKey">
          <template #cell-occurred_at="{ value }">
            <span class="whitespace-nowrap text-gray-600 dark:text-gray-300">{{ formatTime(value) }}</span>
          </template>
          <template #cell-category="{ value }">
            <span class="rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700 dark:bg-dark-700 dark:text-gray-200">
              {{ value }}
            </span>
          </template>
          <template #cell-actor="{ row }">
            <div class="min-w-0 max-w-[220px]">
              <div class="truncate font-mono text-sm text-gray-900 dark:text-white" :title="row.actor_user_id || ''">
                {{ row.actor_user_id || '—' }}
              </div>
              <div v-if="row.actor_session_id_masked" class="mt-0.5 truncate font-mono text-xs text-gray-400">
                {{ row.actor_session_id_masked }}
              </div>
            </div>
          </template>
          <template #cell-action="{ row }">
            <div class="min-w-0 max-w-xs">
              <div class="truncate font-mono text-sm text-gray-800 dark:text-gray-200" :title="row.action">
                {{ row.action }}
              </div>
              <div class="mt-0.5 truncate font-mono text-xs text-gray-400" :title="row.origin">
                {{ row.origin }}
              </div>
            </div>
          </template>
          <template #cell-outcome="{ value }">
            <span :class="outcomeBadgeClass(value)">
              <span class="h-1.5 w-1.5 rounded-full" :class="outcomeDotClass(value)"></span>
              {{ value }}
            </span>
          </template>
          <template #cell-resource="{ row }">
            <div class="max-w-[260px]">
              <div class="truncate text-xs text-gray-400">{{ row.resource_type }}</div>
              <div class="truncate font-mono text-sm text-gray-700 dark:text-gray-200" :title="row.resource_id">
                {{ row.resource_id || '—' }}
              </div>
            </div>
          </template>
          <template #cell-actions="{ row }">
            <button
              type="button"
              class="inline-flex items-center gap-1 font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              @click="openDetail(row.category, row.event_id)"
            >
              <Icon name="eye" size="sm" />
              {{ t('admin.audit.columns.detail') }}
            </button>
          </template>
          <template #empty>
            <div class="flex flex-col items-center py-8">
              <Icon name="shield" size="xl" class="mb-4 h-12 w-12 text-gray-300 dark:text-dark-600" />
              <p class="text-sm font-medium text-gray-500 dark:text-gray-400">{{ t('admin.audit.empty') }}</p>
            </div>
          </template>
        </DataTable>
      </template>

      <template #pagination>
        <div v-if="logs.length > 0 || currentPage > 1" class="flex items-center justify-between gap-4 px-1">
          <span class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.audit.pagination.page', { page: currentPage }) }}</span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="btn btn-secondary"
              :aria-label="t('admin.audit.pagination.previous')"
              :disabled="loading || currentPage === 1"
              @click="previousPage"
            >
              ‹
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              :aria-label="t('admin.audit.pagination.next')"
              :disabled="loading || !nextCursor"
              @click="nextPage"
            >
              ›
            </button>
          </div>
        </div>
      </template>
    </TablePageLayout>

    <BaseDialog
      :show="detailVisible"
      :title="t('admin.audit.detail.title')"
      width="wide"
      :close-on-click-outside="true"
      @close="closeDetail"
    >
      <div v-if="detailLoading" class="flex items-center justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-600"></div>
      </div>
      <div v-else-if="detail" class="space-y-5 py-2">
        <div class="rounded-2xl border border-gray-200 bg-gray-50/60 p-5 dark:border-dark-700 dark:bg-dark-900/60">
          <div class="flex flex-wrap items-center gap-3">
            <span :class="outcomeBadgeClass(detail.outcome)">
              <span class="h-1.5 w-1.5 rounded-full" :class="outcomeDotClass(detail.outcome)"></span>
              {{ detail.outcome }}
            </span>
            <span class="break-all font-mono text-base font-semibold text-gray-900 dark:text-white">
              {{ detail.action }}
            </span>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-gray-500 dark:text-gray-400">
            <span class="inline-flex items-center gap-1.5">
              <Icon name="clock" size="xs" />
              {{ formatTime(detail.occurred_at) }}
            </span>
            <span>{{ detail.category }}</span>
            <span>{{ detail.event_id }}</span>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="rounded-xl bg-gray-50 p-4 dark:bg-dark-900">
            <div class="text-xs font-bold uppercase tracking-wider text-gray-400">{{ t('admin.audit.detail.actor') }}</div>
            <div class="mt-1 break-all font-mono text-sm font-medium text-gray-900 dark:text-white">
              {{ detail.actor_user_id || '—' }}
            </div>
            <div class="mt-0.5 font-mono text-xs text-gray-400">{{ detail.actor_session_id_masked || '—' }}</div>
          </div>
          <div class="rounded-xl bg-gray-50 p-4 dark:bg-dark-900">
            <div class="text-xs font-bold uppercase tracking-wider text-gray-400">{{ t('admin.audit.detail.origin') }}</div>
            <div class="mt-1 break-all font-mono text-sm font-medium text-gray-900 dark:text-white">
              {{ detail.origin }}
            </div>
          </div>
          <div class="rounded-xl bg-gray-50 p-4 dark:bg-dark-900">
            <div class="text-xs font-bold uppercase tracking-wider text-gray-400">{{ t('admin.audit.detail.resource') }}</div>
            <div class="mt-1 text-xs text-gray-400">{{ detail.resource_type }}</div>
            <div class="mt-0.5 break-all font-mono text-sm font-medium text-gray-900 dark:text-white">
              {{ detail.resource_id || '—' }}
            </div>
            <div v-if="detail.resource_version !== null" class="mt-0.5 text-xs text-gray-400">
              {{ t('admin.audit.detail.version', { version: detail.resource_version }) }}
            </div>
          </div>
        </div>

        <section v-if="detail.metadata && Object.keys(detail.metadata).length">
          <h4 class="mb-1.5 text-xs font-bold uppercase tracking-wider text-gray-400">
            {{ t('admin.audit.detail.metadata') }}
          </h4>
          <pre class="max-h-72 overflow-auto rounded-xl bg-gray-50 p-4 font-mono text-xs leading-relaxed text-gray-600 dark:bg-dark-900 dark:text-gray-400">{{ JSON.stringify(detail.metadata, null, 2) }}</pre>
        </section>
      </div>
    </BaseDialog>

    <BaseDialog
      :show="showCustomTimeRangeDialog"
      :title="t('admin.ops.timeRange.custom')"
      width="narrow"
      @close="showCustomTimeRangeDialog = false"
    >
      <div class="space-y-4 py-2">
        <div>
          <label class="input-label">{{ t('admin.ops.customTimeRange.startTime') }}</label>
          <input v-model="customStartTimeInput" type="datetime-local" class="input" />
        </div>
        <div>
          <label class="input-label">{{ t('admin.ops.customTimeRange.endTime') }}</label>
          <input v-model="customEndTimeInput" type="datetime-local" class="input" />
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="showCustomTimeRangeDialog = false">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!customStartTimeInput || !customEndTimeInput"
          @click="applyCustomTimeRange"
        >
          {{ t('common.confirm') }}
        </button>
      </template>
    </BaseDialog>
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminAPI, type AuditLog } from '@/api/admin'
import type { AuditCategory, AuditOutcome } from '@/api/admin/audit'
import AppLayout from '@/components/layout/AppLayout.vue'
import TablePageLayout from '@/components/layout/TablePageLayout.vue'
import DataTable from '@/components/common/DataTable.vue'
import type { Column } from '@/components/common/types'
import Select from '@/components/common/Select.vue'
import BaseDialog from '@/components/common/BaseDialog.vue'
import Icon from '@/components/icons/Icon.vue'
import { useAppStore } from '@/stores'

const { t } = useI18n()
const appStore = useAppStore()
const loading = ref(false)
const logs = ref<AuditLog[]>([])
const pageSize = 20
const cursorHistory = ref<Array<string | undefined>>([undefined])
const nextCursor = ref<string | null>(null)
const currentPage = computed(() => cursorHistory.value.length)

const filters = reactive({
  category: '' as '' | AuditCategory,
  action: '',
  outcome: '' as '' | AuditOutcome,
  actor_user_id: '',
  resource_type: '',
  resource_id: ''
})

const categoryOptions = computed(() => [
  { value: '', label: t('admin.audit.filters.all') },
  { value: 'settings', label: t('admin.audit.categories.settings') },
  { value: 'rbac', label: t('admin.audit.categories.rbac') },
  { value: 'account', label: t('admin.audit.categories.account') },
  { value: 'auth', label: t('admin.audit.categories.auth') },
  { value: 'payment', label: t('admin.audit.categories.payment') }
])
const outcomeOptions = computed(() => [
  { value: '', label: t('admin.audit.filters.all') },
  { value: 'succeeded', label: t('admin.audit.outcomes.succeeded') },
  { value: 'failed', label: t('admin.audit.outcomes.failed') },
  { value: 'blocked', label: t('admin.audit.outcomes.blocked') },
  { value: 'recorded', label: t('admin.audit.outcomes.recorded') }
])

const timeRange = ref('')
const customStartTime = ref('')
const customEndTime = ref('')
const showCustomTimeRangeDialog = ref(false)
const customStartTimeInput = ref('')
const customEndTimeInput = ref('')
const timeRangeMinutes: Record<string, number> = {
  '30m': 30,
  '1h': 60,
  '6h': 360,
  '24h': 1440,
  '7d': 10080,
  '30d': 43200
}
const timeRangeOptions = computed(() => [
  { value: '', label: t('admin.audit.filters.all') },
  ...Object.keys(timeRangeMinutes).map((value) => ({ value, label: t(`admin.ops.timeRange.${value}`) })),
  { value: 'custom', label: customTimeRangeLabel.value }
])
const customTimeRangeLabel = computed(() => {
  if (timeRange.value !== 'custom' || !customStartTime.value || !customEndTime.value) {
    return t('admin.ops.timeRange.custom')
  }
  return `${t('admin.ops.timeRange.custom')} (${formatRange(customStartTime.value, customEndTime.value)})`
})
const columns = computed<Column[]>(() => [
  { key: 'occurred_at', label: t('admin.audit.columns.time') },
  { key: 'category', label: t('admin.audit.columns.category') },
  { key: 'actor', label: t('admin.audit.columns.actor') },
  { key: 'action', label: t('admin.audit.columns.action') },
  { key: 'outcome', label: t('admin.audit.columns.outcome') },
  { key: 'resource', label: t('admin.audit.columns.resource') },
  { key: 'actions', label: t('common.actions') }
])

function query(cursor?: string) {
  return {
    limit: pageSize,
    cursor,
    category: filters.category || undefined,
    action: filters.action || undefined,
    outcome: filters.outcome || undefined,
    actor_user_id: filters.actor_user_id || undefined,
    resource_type: filters.resource_type || undefined,
    resource_id: filters.resource_id || undefined,
    ...timeQuery()
  }
}

async function fetchLogs() {
  loading.value = true
  try {
    const result = await adminAPI.audit.list(query(cursorHistory.value.at(-1)))
    logs.value = result.items
    nextCursor.value = result.has_more ? result.next_cursor : null
  } catch (error: any) {
    appStore.showError(error?.message || t('admin.audit.loadFailed'))
  } finally {
    loading.value = false
  }
}

function search() {
  cursorHistory.value = [undefined]
  nextCursor.value = null
  void fetchLogs()
}

function resetFilters() {
  Object.assign(filters, {
    category: '', action: '', outcome: '', actor_user_id: '', resource_type: '', resource_id: ''
  })
  timeRange.value = ''
  customStartTime.value = ''
  customEndTime.value = ''
  search()
}

function nextPage() {
  if (!nextCursor.value || loading.value) return
  cursorHistory.value.push(nextCursor.value)
  void fetchLogs()
}

function previousPage() {
  if (cursorHistory.value.length <= 1 || loading.value) return
  cursorHistory.value.pop()
  void fetchLogs()
}

const detailLoading = ref(false)
const detail = ref<AuditLog | null>(null)
const detailVisible = ref(false)
async function openDetail(category: AuditCategory, eventId: string) {
  detailVisible.value = true
  detailLoading.value = true
  detail.value = null
  try {
    detail.value = await adminAPI.audit.get(category, eventId)
  } catch (error: any) {
    detailVisible.value = false
    appStore.showError(error?.message || t('admin.audit.loadFailed'))
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  detailVisible.value = false
  detail.value = null
}

function auditRowKey(row: AuditLog): string {
  return `${row.category}:${row.event_id}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function outcomeBadgeClass(outcome: AuditOutcome): string {
  const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold '
  if (outcome === 'failed') return base + 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (outcome === 'blocked') return base + 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
  if (outcome === 'recorded') return base + 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  return base + 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
}

function outcomeDotClass(outcome: AuditOutcome): string {
  if (outcome === 'failed') return 'bg-red-500'
  if (outcome === 'blocked') return 'bg-amber-500'
  if (outcome === 'recorded') return 'bg-blue-500'
  return 'bg-green-500'
}

function handleTimeRangeChange(raw: string | number | boolean | null) {
  const value = String(raw ?? '')
  if (value === 'custom') {
    const now = new Date()
    customStartTimeInput.value = customStartTime.value || toLocalDateTime(new Date(now.getTime() - 3_600_000))
    customEndTimeInput.value = customEndTime.value || toLocalDateTime(now)
    showCustomTimeRangeDialog.value = true
    return
  }
  timeRange.value = value
  search()
}

function applyCustomTimeRange() {
  if (!customStartTimeInput.value || !customEndTimeInput.value) return
  customStartTime.value = customStartTimeInput.value
  customEndTime.value = customEndTimeInput.value
  timeRange.value = 'custom'
  showCustomTimeRangeDialog.value = false
  search()
}

function timeQuery(): { start_time?: string; end_time?: string } {
  if (timeRange.value === 'custom') {
    return { start_time: toRFC3339(customStartTime.value), end_time: toRFC3339(customEndTime.value) }
  }
  const minutes = timeRangeMinutes[timeRange.value]
  return minutes ? { start_time: new Date(Date.now() - minutes * 60_000).toISOString() } : {}
}

function toRFC3339(value: string): string | undefined {
  const date = new Date(value)
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined
}

function toLocalDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatRange(start: string, end: string): string {
  const compact = (value: string) => value.replace('T', ' ')
  return `${compact(start)} ~ ${compact(end)}`
}

onMounted(fetchLogs)
</script>
