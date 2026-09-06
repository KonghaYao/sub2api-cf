<template>
  <AppLayout>
    <div class="space-y-6">
      <UsageStatsCards v-if="!workerExplorer" :stats="usageStats" />
      <!-- Charts Section -->
      <div v-if="!workerExplorer" class="space-y-4">
        <div class="card p-4">
          <div class="flex flex-wrap items-center gap-4">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('admin.dashboard.timeRange') }}:</span>
              <DateRangePicker
                v-model:start-date="startDate"
                v-model:end-date="endDate"
                @change="onDateRangeChange"
              />
            </div>
            <div class="ml-auto flex items-center gap-2">
              <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('admin.dashboard.granularity') }}:</span>
              <div class="w-28">
                <Select v-model="granularity" :options="granularityOptions" @change="loadChartData" />
              </div>
            </div>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ModelDistributionChart
            v-model:source="modelDistributionSource"
            v-model:metric="modelDistributionMetric"
            :model-stats="requestedModelStats"
            :upstream-model-stats="upstreamModelStats"
            :mapping-model-stats="mappingModelStats"
            :loading="modelStatsLoading"
            :show-source-toggle="true"
            :show-metric-toggle="true"
            :start-date="startDate"
            :end-date="endDate"
            :filters="breakdownFilters"
          />
          <GroupDistributionChart
            v-model:metric="groupDistributionMetric"
            :group-stats="groupStats"
            :loading="chartsLoading"
            :show-metric-toggle="true"
            :start-date="startDate"
            :end-date="endDate"
            :filters="breakdownFilters"
          />
        </div>
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <EndpointDistributionChart
            v-model:source="endpointDistributionSource"
            v-model:metric="endpointDistributionMetric"
            :endpoint-stats="inboundEndpointStats"
            :upstream-endpoint-stats="upstreamEndpointStats"
            :endpoint-path-stats="endpointPathStats"
            :loading="endpointStatsLoading"
            :show-source-toggle="true"
            :show-metric-toggle="true"
            :title="t('usage.endpointDistribution')"
            :start-date="startDate"
            :end-date="endDate"
            :filters="breakdownFilters"
          />
          <TokenUsageTrend :trend-data="trendData" :loading="chartsLoading" />
        </div>
      </div>
      <!-- 明细区：tab 栏 + 筛选 + 内容收进同一张卡片，消除割裂感 -->
      <div class="card">
        <div class="flex flex-wrap items-center border-b border-gray-200 px-2 dark:border-dark-700 sm:px-4">
          <button
            v-for="tab in detailTabs"
            :key="tab.key"
            type="button"
            data-testid="usage-detail-tab"
            class="-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors sm:px-4"
            :class="activeTab === tab.key
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-dark-500 dark:hover:text-gray-200'"
            @click="switchTab(tab.key)"
          >
            <Icon :name="tab.icon" size="sm" />
            {{ tab.label }}
          </button>
        </div>

        <UsageFilters v-model="filters" ref="usageFiltersRef" flat worker-explorer :mode="activeTab" class="border-b border-gray-100 dark:border-dark-700/50" :start-date="startDate" :end-date="endDate" :exporting="false" :model-options="modelNameOptions" @change="applyFilters" @refresh="refreshData" @reset="resetFilters">
          <template #after-reset>
            <div v-if="activeTab !== 'ranking'" class="relative" ref="columnDropdownRef">
              <button
                data-testid="usage-column-settings"
                @click="showColumnDropdown = !showColumnDropdown"
                class="btn btn-secondary px-2 md:px-3"
                :title="t('admin.users.columnSettings')"
              >
                <svg class="h-4 w-4 md:mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125z" />
                </svg>
                <span class="hidden md:inline">{{ t('admin.users.columnSettings') }}</span>
              </button>
              <div
                v-if="showColumnDropdown"
                class="absolute right-0 top-full z-50 mt-1 max-h-80 w-48 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-dark-600 dark:bg-dark-800"
              >
                <button
                  v-for="col in currentToggleableColumns"
                  :key="col.key"
                  :data-testid="`usage-column-toggle-${col.key}`"
                  @click="toggleCurrentColumn(col.key)"
                  class="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-dark-700"
                >
                  <span>{{ col.label }}</span>
                  <Icon
                    v-if="isCurrentColumnVisible(col.key)"
                    name="check"
                    size="sm"
                    class="text-primary-500"
                    :stroke-width="2"
                  />
                </button>
              </div>
            </div>
          </template>
        </UsageFilters>

        <div v-show="activeTab === 'usage'" class="overflow-hidden rounded-b-2xl">
          <div v-if="loading" class="p-10 text-center text-sm text-gray-500 dark:text-gray-400">
            {{ t('common.loading') }}
          </div>
          <div v-else-if="usageLogs.length === 0" class="p-10 text-center text-sm text-gray-500 dark:text-gray-400">
            {{ t('common.noData') }}
          </div>
          <div v-else class="overflow-x-auto">
            <table data-testid="admin-usage-explorer-table" class="min-w-full divide-y divide-gray-200 text-sm dark:divide-dark-700">
              <thead class="bg-gray-50 dark:bg-dark-900">
                <tr>
                  <th v-if="isColumnVisible('user')" class="px-4 py-3 text-left">{{ t('admin.usage.user') }}</th>
                  <th v-if="isColumnVisible('api_key')" class="px-4 py-3 text-left">{{ t('usage.apiKeyFilter') }}</th>
                  <th v-if="isColumnVisible('account')" class="px-4 py-3 text-left">{{ t('admin.usage.account') }}</th>
                  <th v-if="isColumnVisible('model')" class="px-4 py-3 text-left">{{ t('usage.model') }}</th>
                  <th v-if="isColumnVisible('endpoint')" class="px-4 py-3 text-left">{{ t('usage.endpoint') }}</th>
                  <th v-if="isColumnVisible('group')" class="px-4 py-3 text-left">{{ t('admin.usage.group') }}</th>
                  <th v-if="isColumnVisible('stream')" class="px-4 py-3 text-left">{{ t('usage.type') }}</th>
                  <th v-if="isColumnVisible('status')" class="px-4 py-3 text-left">{{ t('admin.ops.errorLog.status') }}</th>
                  <th v-if="isColumnVisible('tokens')" class="px-4 py-3 text-right">{{ t('usage.tokens') }}</th>
                  <th v-if="isColumnVisible('cost')" class="px-4 py-3 text-right">{{ t('usage.cost') }}</th>
                  <th v-if="isColumnVisible('latency')" class="px-4 py-3 text-right">{{ t('usage.latency') }}</th>
                  <th v-if="isColumnVisible('created_at')" class="px-4 py-3 text-left">{{ t('usage.time') }}</th>
                  <th v-if="isColumnVisible('request_id')" class="px-4 py-3 text-left">{{ t('admin.usage.requestId') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-dark-800">
                <tr v-for="row in usageLogs" :key="row.id">
                  <td v-if="isColumnVisible('user')" class="whitespace-nowrap px-4 py-3">
                    <button v-if="row.user_id && !workerExplorer" data-testid="admin-usage-user" class="text-primary-600 hover:underline dark:text-primary-400" @click="handleUserClick(row.user_id)">
                      {{ row.user_id }}
                    </button>
                    <span v-else-if="row.user_id">{{ row.user_id }}</span>
                    <span v-else>—</span>
                  </td>
                  <td v-if="isColumnVisible('api_key')" class="whitespace-nowrap px-4 py-3">{{ row.api_key_id || '—' }}</td>
                  <td v-if="isColumnVisible('account')" class="whitespace-nowrap px-4 py-3">{{ row.account_id || '—' }}</td>
                  <td v-if="isColumnVisible('model')" class="px-4 py-3">
                    <div>{{ row.requested_model || row.model || '—' }}</div>
                    <div v-if="row.upstream_model && row.upstream_model !== (row.requested_model || row.model)" class="text-xs text-gray-500">↳ {{ row.upstream_model }}</div>
                  </td>
                  <td v-if="isColumnVisible('endpoint')" class="px-4 py-3">{{ row.inbound_endpoint || '—' }}</td>
                  <td v-if="isColumnVisible('group')" class="whitespace-nowrap px-4 py-3">{{ row.group_id || '—' }}</td>
                  <td v-if="isColumnVisible('stream')" class="whitespace-nowrap px-4 py-3">{{ formatExplorerRequestType(row) }}</td>
                  <td v-if="isColumnVisible('status')" class="whitespace-nowrap px-4 py-3">{{ row.status_code ?? '—' }}</td>
                  <td v-if="isColumnVisible('tokens')" class="whitespace-nowrap px-4 py-3 text-right">{{ formatExplorerTokens(row) }}</td>
                  <td v-if="isColumnVisible('cost')" class="whitespace-nowrap px-4 py-3 text-right">{{ formatExplorerCost(row.amount_micros) }}</td>
                  <td v-if="isColumnVisible('latency')" class="whitespace-nowrap px-4 py-3 text-right">{{ row.duration_ms == null ? '—' : `${row.duration_ms} ms` }}</td>
                  <td v-if="isColumnVisible('created_at')" class="whitespace-nowrap px-4 py-3">{{ formatExplorerTime(row.created_at) }}</td>
                  <td v-if="isColumnVisible('request_id')" data-testid="admin-usage-request-id" class="max-w-[240px] truncate px-4 py-3 font-mono text-xs" :title="row.request_id">{{ row.request_id || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <CursorPagination
            v-if="usageLogs.length > 0 || pagination.page > 1"
            :page="pagination.page"
            :has-more="usageHasMore"
            :loading="loading"
            @previous="goToPreviousUsagePage"
            @next="goToNextUsagePage"
          />
        </div>
        <!-- 懒挂载：首次切到该 tab 才请求排行数据，之后随筛选自动刷新 -->
        <div v-if="rankingMounted" v-show="activeTab === 'ranking'" class="overflow-hidden rounded-b-2xl">
          <UserTokenRanking
            ref="rankingRef"
            :start-date="startDate"
            :end-date="endDate"
            :filters="breakdownFilters"
            :model="filters.model"
            @select-user="handleRankingSelectUser"
          />
        </div>
      </div>
    </div>
  </AppLayout>
  <!-- Balance history modal triggered from usage table user click -->
  <UserBalanceHistoryModal
    v-if="!workerExplorer"
    :show="showBalanceHistoryModal"
    :user="balanceHistoryUser"
    :hide-actions="true"
    @close="showBalanceHistoryModal = false; balanceHistoryUser = null"
  />
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'; import { adminAPI } from '@/api/admin'
import { getPersistedPageSize } from '@/composables/usePersistedPageSize'
import { requestTypeToLegacyStream } from '@/utils/usageRequestType'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import AppLayout from '@/components/layout/AppLayout.vue'; import CursorPagination from '@/components/user/CursorPagination.vue'; import Select from '@/components/common/Select.vue'; import DateRangePicker from '@/components/common/DateRangePicker.vue'
import UsageStatsCards from '@/components/admin/usage/UsageStatsCards.vue'; import UsageFilters from '@/components/admin/usage/UsageFilters.vue'
import UserTokenRanking from '@/components/admin/usage/UserTokenRanking.vue'
import UserBalanceHistoryModal from '@/components/admin/user/UserBalanceHistoryModal.vue'
import ModelDistributionChart from '@/components/charts/ModelDistributionChart.vue'; import GroupDistributionChart from '@/components/charts/GroupDistributionChart.vue'; import TokenUsageTrend from '@/components/charts/TokenUsageTrend.vue'
import EndpointDistributionChart from '@/components/charts/EndpointDistributionChart.vue'
import Icon from '@/components/icons/Icon.vue'
import type { TrendDataPoint, ModelStat, GroupStat, EndpointStat, AdminUser } from '@/types'; import type { AdminUsageStatsResponse, AdminUsageQueryParams, WorkerAdminUsageItem } from '@/api/admin/usage'

type AdminExplorerFilters = Omit<AdminUsageQueryParams, 'user_id' | 'api_key_id' | 'account_id' | 'group_id'> & {
  user_id?: string | number
  api_key_id?: string | number
  account_id?: string | number
  group_id?: string | number
}

const { t } = useI18n()
const appStore = useAppStore()
const workerExplorer = isCloudflareWorkerContractActive()
type DistributionMetric = 'tokens' | 'actual_cost'
type EndpointSource = 'inbound' | 'upstream' | 'path'
type ModelDistributionSource = 'requested' | 'upstream' | 'mapping'
const route = useRoute()
const usageStats = ref<AdminUsageStatsResponse | null>(null); const usageLogs = ref<WorkerAdminUsageItem[]>([]); const loading = ref(false)
const trendData = ref<TrendDataPoint[]>([]); const requestedModelStats = ref<ModelStat[]>([]); const upstreamModelStats = ref<ModelStat[]>([]); const mappingModelStats = ref<ModelStat[]>([]); const groupStats = ref<GroupStat[]>([]); const chartsLoading = ref(false); const modelStatsLoading = ref(false); const granularity = ref<'day' | 'hour'>('hour')
const modelDistributionMetric = ref<DistributionMetric>('tokens')
const modelDistributionSource = ref<ModelDistributionSource>('requested')
const loadedModelSources = reactive<Record<ModelDistributionSource, boolean>>({
  requested: false,
  upstream: false,
  mapping: false,
})
const groupDistributionMetric = ref<DistributionMetric>('tokens')
const endpointDistributionMetric = ref<DistributionMetric>('tokens')
const endpointDistributionSource = ref<EndpointSource>('inbound')
const inboundEndpointStats = ref<EndpointStat[]>([])
const upstreamEndpointStats = ref<EndpointStat[]>([])
const endpointPathStats = ref<EndpointStat[]>([])
const endpointStatsLoading = ref(false)
let abortController: AbortController | null = null
let chartReqSeq = 0
let statsReqSeq = 0
let modelStatsReqSeq = 0
// Balance history modal state
const showBalanceHistoryModal = ref(false)
const balanceHistoryUser = ref<AdminUser | null>(null)

const breakdownFilters = computed(() => {
  const f: Record<string, any> = {}
  if (typeof filters.value.user_id === 'number') f.user_id = filters.value.user_id
  if (typeof filters.value.api_key_id === 'number') f.api_key_id = filters.value.api_key_id
  if (typeof filters.value.account_id === 'number') f.account_id = filters.value.account_id
  if (typeof filters.value.group_id === 'number') f.group_id = filters.value.group_id
  if (filters.value.request_type != null) f.request_type = filters.value.request_type
  if (filters.value.native_compaction_v2 != null) f.native_compaction_v2 = filters.value.native_compaction_v2
  if (filters.value.billing_type != null) f.billing_type = filters.value.billing_type
  return f
})

const modelNameOptions = computed(() =>
  Array.from(new Set(requestedModelStats.value.map((m) => m.model).filter(Boolean))).sort()
)

const handleUserClick = async (userId: string | number) => {
  try {
    const user = await adminAPI.users.getById(userId, true)
    balanceHistoryUser.value = user
    showBalanceHistoryModal.value = true
  } catch {
    appStore.showError(t('admin.usage.failedToLoadUser'))
  }
}

// Drill down from the per-user token ranking: scope the whole usage view to
// that user and jump to the usage-detail tab so the drill-down is visible.
const handleRankingSelectUser = (userId: number, email: string) => {
  filters.value = { ...filters.value, user_id: userId }
  usageFiltersRef.value?.setUserKeyword?.(email || '')
  activeTab.value = 'usage'
  applyFilters()
}

const granularityOptions = computed(() => [{ value: 'day', label: t('admin.dashboard.day') }, { value: 'hour', label: t('admin.dashboard.hour') }])
// Use local timezone to avoid UTC timezone issues
const formatLD = (d: Date) => {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const getLast24HoursRangeDates = (): { start: string; end: string } => {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  return {
    start: formatLD(start),
    end: formatLD(end)
  }
}
const getGranularityForRange = (start: string, end: string): 'day' | 'hour' => {
  const startTime = new Date(`${start}T00:00:00`).getTime()
  const endTime = new Date(`${end}T00:00:00`).getTime()
  const daysDiff = Math.ceil((endTime - startTime) / (1000 * 60 * 60 * 24))
  return daysDiff <= 1 ? 'hour' : 'day'
}
const defaultRange = getLast24HoursRangeDates()
const startDate = ref(defaultRange.start); const endDate = ref(defaultRange.end)
const filters = ref<AdminExplorerFilters>({ user_id: undefined, model: undefined, group_id: undefined, request_type: undefined, native_compaction_v2: null, billing_type: null, start_date: startDate.value, end_date: endDate.value })
const pagination = reactive({ page: 1, page_size: getPersistedPageSize() })
const usageHasMore = ref(false)
const usageNextCursor = ref<string | null>(null)
const usageCursors = ref<Array<string | undefined>>([undefined])

const getSingleQueryValue = (value: string | null | Array<string | null> | undefined): string | undefined => {
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string' && item.length > 0)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const getOpaqueQueryValue = getSingleQueryValue

const legacyNumericId = (value: string | number | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined

const applyRouteQueryFilters = () => {
  const queryStartDate = getSingleQueryValue(route.query.start_date)
  const queryEndDate = getSingleQueryValue(route.query.end_date)
  const queryUserId = getOpaqueQueryValue(route.query.user_id)

  if (queryStartDate) {
    startDate.value = queryStartDate
  }
  if (queryEndDate) {
    endDate.value = queryEndDate
  }

  filters.value = {
    ...filters.value,
    user_id: queryUserId,
    start_date: startDate.value,
    end_date: endDate.value
  }
  granularity.value = getGranularityForRange(startDate.value, endDate.value)
}

const loadRouteUserFilterLabel = async () => {
  const requestedUserId = filters.value.user_id
  if (!requestedUserId) return
  const userSearchRevision = usageFiltersRef.value?.getUserSearchRevision?.()

  const routeUserFilterIsCurrent = () => (
    filters.value.user_id === requestedUserId
    && usageFiltersRef.value?.getUserSearchRevision?.() === userSearchRevision
  )

  try {
    const user = await adminAPI.users.getById(requestedUserId, true)
    if (!routeUserFilterIsCurrent()) return
    usageFiltersRef.value?.setUserKeyword?.(user.email || String(requestedUserId))
  } catch {
    if (!routeUserFilterIsCurrent()) return
    usageFiltersRef.value?.setUserKeyword?.(String(requestedUserId))
  }
}

const onDateRangeChange = (range: { startDate: string; endDate: string; preset: string | null }) => {
  startDate.value = range.startDate
  endDate.value = range.endDate
  filters.value = {
    ...filters.value,
    start_date: range.startDate,
    end_date: range.endDate
  }
  granularity.value = getGranularityForRange(range.startDate, range.endDate)
  applyFilters()
}

const buildUsageListParams = () => {
  const opaqueId = (value: string | number | undefined) => value == null ? undefined : String(value)
  return {
    limit: pagination.page_size,
    cursor: usageCursors.value[pagination.page - 1],
    start_date: filters.value.start_date,
    end_date: filters.value.end_date,
    user_id: opaqueId(filters.value.user_id),
    api_key_id: opaqueId(filters.value.api_key_id),
    account_id: opaqueId(filters.value.account_id),
    group_id: opaqueId(filters.value.group_id),
    model: filters.value.model,
  }
}

const loadLogs = async () => {
  abortController?.abort(); const c = new AbortController(); abortController = c; loading.value = true
  try {
    const res = await adminAPI.usage.list(
      buildUsageListParams(),
      { signal: c.signal }
    )
    if(!c.signal.aborted) {
      usageLogs.value = res.items
      usageHasMore.value = res.has_more
      usageNextCursor.value = res.next_cursor
    }
  } catch (error: any) { if(error?.name !== 'AbortError') console.error('Failed to load usage logs:', error) } finally { if(abortController === c) loading.value = false }
}
const loadStats = async (force = false) => {
  const seq = ++statsReqSeq
  endpointStatsLoading.value = true
  try {
    const requestType = filters.value.request_type
    const legacyStream = requestType ? requestTypeToLegacyStream(requestType) : filters.value.stream
    const s = await adminAPI.usage.getStats({
      ...filters.value,
      user_id: legacyNumericId(filters.value.user_id),
      api_key_id: legacyNumericId(filters.value.api_key_id),
      account_id: legacyNumericId(filters.value.account_id),
      group_id: legacyNumericId(filters.value.group_id),
      stream: legacyStream === null ? undefined : legacyStream,
      ...(force ? { nocache: 1 } : {}),
    })
    if (seq !== statsReqSeq) return
    usageStats.value = s
    inboundEndpointStats.value = s.endpoints || []
    upstreamEndpointStats.value = s.upstream_endpoints || []
    endpointPathStats.value = s.endpoint_paths || []
  } catch (error) {
    if (seq !== statsReqSeq) return
    console.error('Failed to load usage stats:', error)
    inboundEndpointStats.value = []
    upstreamEndpointStats.value = []
    endpointPathStats.value = []
  } finally {
    if (seq === statsReqSeq) endpointStatsLoading.value = false
  }
}

// 失效模型统计缓存:仅标记需要重取,保留旧数据直到新数据到达(避免刷新时图表闪空)。
const invalidateModelStatsCache = () => {
  loadedModelSources.requested = false
  loadedModelSources.upstream = false
  loadedModelSources.mapping = false
}

const loadModelStats = async (source: ModelDistributionSource, force = false) => {
  if (!force && loadedModelSources[source]) {
    return
  }

  const seq = ++modelStatsReqSeq
  modelStatsLoading.value = true
  try {
    const requestType = filters.value.request_type
    const legacyStream = requestType ? requestTypeToLegacyStream(requestType) : filters.value.stream
    const baseParams = {
      start_date: filters.value.start_date || startDate.value,
      end_date: filters.value.end_date || endDate.value,
      user_id: legacyNumericId(filters.value.user_id),
      model: filters.value.model,
      api_key_id: legacyNumericId(filters.value.api_key_id),
      account_id: legacyNumericId(filters.value.account_id),
      group_id: legacyNumericId(filters.value.group_id),
      request_type: requestType,
      stream: legacyStream === null ? undefined : legacyStream,
      native_compaction_v2: filters.value.native_compaction_v2,
      billing_type: filters.value.billing_type,
	  upstream_model_mismatch: filters.value.upstream_model_mismatch,
    }

    const response = await adminAPI.dashboard.getModelStats({ ...baseParams, model_source: source })

    if (seq !== modelStatsReqSeq) return

    const models = response.models || []
    if (source === 'requested') {
      requestedModelStats.value = models
    } else if (source === 'upstream') {
      upstreamModelStats.value = models
    } else {
      mappingModelStats.value = models
    }
    loadedModelSources[source] = true
  } catch (error) {
    if (seq !== modelStatsReqSeq) return
    console.error('Failed to load model stats:', error)
    if (source === 'requested') {
      requestedModelStats.value = []
    } else if (source === 'upstream') {
      upstreamModelStats.value = []
    } else {
      mappingModelStats.value = []
    }
    loadedModelSources[source] = false
  } finally {
    if (seq === modelStatsReqSeq) modelStatsLoading.value = false
  }
}

const loadChartData = async () => {
  const seq = ++chartReqSeq
  chartsLoading.value = true
  try {
    const requestType = filters.value.request_type
    const legacyStream = requestType ? requestTypeToLegacyStream(requestType) : filters.value.stream
    const snapshot = await adminAPI.dashboard.getSnapshotV2({
      start_date: filters.value.start_date || startDate.value,
      end_date: filters.value.end_date || endDate.value,
      granularity: granularity.value,
      user_id: legacyNumericId(filters.value.user_id),
      model: filters.value.model,
      api_key_id: legacyNumericId(filters.value.api_key_id),
      account_id: legacyNumericId(filters.value.account_id),
      group_id: legacyNumericId(filters.value.group_id),
      request_type: requestType,
      stream: legacyStream === null ? undefined : legacyStream,
      native_compaction_v2: filters.value.native_compaction_v2,
      billing_type: filters.value.billing_type,
	  upstream_model_mismatch: filters.value.upstream_model_mismatch,
      include_stats: false,
      include_trend: true,
      include_model_stats: false,
      include_group_stats: true,
      include_users_trend: false
    })
    if (seq !== chartReqSeq) return
    trendData.value = snapshot.trend || []
    groupStats.value = snapshot.groups || []
  } catch (error) { console.error('Failed to load chart data:', error) } finally { if (seq === chartReqSeq) chartsLoading.value = false }
}
const applyFilters = () => {
  resetUsageCursor()
  if (workerExplorer) {
    loadLogs()
    return
  }
  invalidateModelStatsCache()
  loadLogs()
  loadStats()
  loadModelStats(modelDistributionSource.value, true)
  loadChartData()
}
const refreshData = () => {
  if (workerExplorer) {
    loadLogs()
    return
  }
  invalidateModelStatsCache()
  loadLogs()
  loadStats(true)
  loadModelStats(modelDistributionSource.value, true)
  loadChartData()
  if (rankingMounted.value) rankingRef.value?.reload()
}
const resetFilters = () => {
  const range = getLast24HoursRangeDates()
  startDate.value = range.start
  endDate.value = range.end
  filters.value = { start_date: startDate.value, end_date: endDate.value, request_type: undefined, native_compaction_v2: null, billing_type: null, billing_mode: undefined }
  granularity.value = getGranularityForRange(startDate.value, endDate.value)
  applyFilters()
}
const resetUsageCursor = () => {
  pagination.page = 1
  usageCursors.value = [undefined]
  usageHasMore.value = false
  usageNextCursor.value = null
}
const goToPreviousUsagePage = () => {
  if (pagination.page <= 1) return
  pagination.page -= 1
  loadLogs()
}
const goToNextUsagePage = () => {
  if (!usageHasMore.value || !usageNextCursor.value) return
  usageCursors.value[pagination.page] = usageNextCursor.value
  pagination.page += 1
  loadLogs()
}

const formatExplorerTokens = (row: WorkerAdminUsageItem) =>
  ((row.input_tokens ?? 0) + (row.output_tokens ?? 0) + (row.cache_read_tokens ?? 0)).toLocaleString()

const formatExplorerCost = (amountMicros: number | undefined) =>
  typeof amountMicros === 'number' ? `$${(amountMicros / 1_000_000).toFixed(6)}` : '—'

const formatExplorerTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const formatExplorerRequestType = (row: WorkerAdminUsageItem) => {
  if (row.request_type === 3) return t('usage.ws')
  if (row.request_type === 5) return t('usage.live')
  if (row.request_type === 2 || row.stream) return t('usage.stream')
  if (row.request_type === 1 || row.stream === false) return t('usage.sync')
  return '—'
}
// Column visibility
const ALWAYS_VISIBLE = ['user', 'created_at']
const DEFAULT_HIDDEN_COLUMNS = ['request_id']
const HIDDEN_COLUMNS_KEY = 'usage-hidden-columns'
const HIDDEN_COLUMNS_VERSION_KEY = 'usage-hidden-columns-version'
const HIDDEN_COLUMNS_CURRENT_VERSION = 'request-id-hidden-by-default'

const allColumns = computed(() => [
  { key: 'user', label: t('admin.usage.user'), sortable: false },
  { key: 'api_key', label: t('usage.apiKeyFilter'), sortable: false },
  { key: 'account', label: t('admin.usage.account'), sortable: false },
  { key: 'model', label: t('usage.model'), sortable: false },
  { key: 'endpoint', label: t('usage.endpoint'), sortable: false },
  { key: 'group', label: t('admin.usage.group'), sortable: false },
  { key: 'stream', label: t('usage.type'), sortable: false },
  { key: 'status', label: t('admin.ops.errorLog.status'), sortable: false },
  { key: 'tokens', label: t('usage.tokens'), sortable: false },
  { key: 'cost', label: t('usage.cost'), sortable: false },
  { key: 'latency', label: t('usage.latency'), sortable: false },
  { key: 'created_at', label: t('usage.time'), sortable: false },
  { key: 'request_id', label: t('admin.usage.requestId'), sortable: false },
])

const hiddenColumns = reactive<Set<string>>(new Set())

const toggleableColumns = computed(() =>
  allColumns.value.filter(col => !ALWAYS_VISIBLE.includes(col.key))
)

const isColumnVisible = (key: string) => !hiddenColumns.has(key)

const toggleColumn = (key: string) => {
  if (hiddenColumns.has(key)) {
    hiddenColumns.delete(key)
  } else {
    hiddenColumns.add(key)
  }
  try {
    localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hiddenColumns]))
    localStorage.setItem(HIDDEN_COLUMNS_VERSION_KEY, HIDDEN_COLUMNS_CURRENT_VERSION)
  } catch (e) {
    console.error('Failed to save columns:', e)
  }
}

const currentToggleableColumns = toggleableColumns
const isCurrentColumnVisible = isColumnVisible
const toggleCurrentColumn = toggleColumn

const loadSavedColumns = () => {
  try {
    const saved = localStorage.getItem(HIDDEN_COLUMNS_KEY)
    if (saved) {
      (JSON.parse(saved) as string[]).forEach((key) => {
        hiddenColumns.add(key)
      })
      if (localStorage.getItem(HIDDEN_COLUMNS_VERSION_KEY) !== HIDDEN_COLUMNS_CURRENT_VERSION) {
        hiddenColumns.add('request_id')
        localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hiddenColumns]))
        localStorage.setItem(HIDDEN_COLUMNS_VERSION_KEY, HIDDEN_COLUMNS_CURRENT_VERSION)
      }
    } else {
      DEFAULT_HIDDEN_COLUMNS.forEach((key) => {
        hiddenColumns.add(key)
      })
      localStorage.setItem(HIDDEN_COLUMNS_VERSION_KEY, HIDDEN_COLUMNS_CURRENT_VERSION)
    }
  } catch {
    DEFAULT_HIDDEN_COLUMNS.forEach((key) => {
      hiddenColumns.add(key)
    })
  }
}

// Detail tabs
type DetailTab = 'usage' | 'ranking'
const activeTab = ref<DetailTab>('usage')
const detailTabs = computed(() => [
  { key: 'usage' as const, label: t('usage.tabs.usage'), icon: 'document' as const },
  ...(!workerExplorer
    ? [{ key: 'ranking' as const, label: t('usage.tabs.ranking'), icon: 'chart' as const }]
    : []),
])
const usageFiltersRef = ref<InstanceType<typeof UsageFilters> | null>(null)
const rankingMounted = ref(false)
const rankingRef = ref<InstanceType<typeof UserTokenRanking> | null>(null)

const switchTab = (tab: DetailTab) => {
  activeTab.value = tab
  if (tab === 'ranking') rankingMounted.value = true
}

const showColumnDropdown = ref(false)
const columnDropdownRef = ref<HTMLElement | null>(null)

const handleColumnClickOutside = (event: MouseEvent) => {
  if (columnDropdownRef.value && !columnDropdownRef.value.contains(event.target as HTMLElement)) {
    showColumnDropdown.value = false
  }
}

onMounted(() => {
  applyRouteQueryFilters()
  void loadRouteUserFilterLabel()
  loadLogs()
  if (workerExplorer) {
    loadSavedColumns()
    document.addEventListener('click', handleColumnClickOutside)
    return
  }
  loadStats()
  loadModelStats(modelDistributionSource.value, true)
  window.setTimeout(() => {
    void loadChartData()
  }, 120)
  loadSavedColumns()
  document.addEventListener('click', handleColumnClickOutside)
})
onUnmounted(() => { abortController?.abort(); document.removeEventListener('click', handleColumnClickOutside) })

watch(modelDistributionSource, (source) => {
  void loadModelStats(source)
})

defineExpose({ requestedModelStats, refreshData })
</script>
