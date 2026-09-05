<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import Select from '@/components/common/Select.vue'
import OpsErrorLogTable from './OpsErrorLogTable.vue'
import { opsAPI, type OpsErrorListQueryParams, type OpsErrorLog } from '@/api/admin/ops'
import { buildOpsErrorTimeParams } from '../utils/opsErrorParams'

interface Props {
  show: boolean
  timeRange: string
  customStartTime?: string | null
  customEndTime?: string | null
  platform?: string
  groupId?: string | number | null
  errorType: 'request' | 'upstream'
  resumeState?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'openErrorDetail', errorId: string): void
}>()

const { t } = useI18n()


const loading = ref(false)
const rows = ref<OpsErrorLog[]>([])
const page = ref(1)
const pageSize = ref(10)
const hasMore = ref(false)
const nextCursor = ref<string | null>(null)
const cursors = ref<Array<string | undefined>>([undefined])
const timeParams = ref(buildOpsErrorTimeParams(props.timeRange, props.customStartTime, props.customEndTime))

const requestId = ref('')
const statusCode = ref<number | null>(null)


const modalTitle = computed(() => {
  return props.errorType === 'upstream' ? t('admin.ops.errorDetails.upstreamErrors') : t('admin.ops.errorDetails.requestErrors')
})

const statusCodeSelectOptions = computed(() => {
  const codes = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504, 529]
  return [
    { value: null, label: t('common.all') },
    ...codes.map((c) => ({ value: c, label: String(c) })),
  ]
})

function close() {
  emit('update:show', false)
}

function resetCursor() {
  page.value = 1
  cursors.value = [undefined]
  hasMore.value = false
  nextCursor.value = null
  timeParams.value = buildOpsErrorTimeParams(props.timeRange, props.customStartTime, props.customEndTime)
}

async function fetchErrorLogs() {
  if (!props.show) return

  loading.value = true
  try {
    const params: OpsErrorListQueryParams = {
      ...timeParams.value,
      limit: pageSize.value,
      cursor: cursors.value[page.value - 1],
    }

    const platform = String(props.platform || '').trim()
    if (platform) params.platform = platform
    if (props.groupId != null && String(props.groupId).trim()) params.group_id = String(props.groupId)

    if (requestId.value.trim()) params.request_id = requestId.value.trim()
    if (typeof statusCode.value === 'number') params.status_code = statusCode.value

    const res = props.errorType === 'upstream'
      ? await opsAPI.listUpstreamErrors(params)
      : await opsAPI.listRequestErrors(params)
    rows.value = res.items || []
    hasMore.value = res.has_more
    nextCursor.value = res.next_cursor
  } catch (err) {
    console.error('[OpsErrorDetailsModal] Failed to fetch error logs', err)
    rows.value = []
    hasMore.value = false
    nextCursor.value = null
  } finally {
    loading.value = false
  }
}

  function resetFilters() {
    requestId.value = ''
    statusCode.value = null
    resetCursor()
    fetchErrorLogs()
  }


watch(
  () => props.show,
  (open) => {
    if (!open) return
    if (props.resumeState) return
    page.value = 1
    pageSize.value = 10
    resetFilters()
  }
)

watch(
  () => [props.timeRange, props.customStartTime, props.customEndTime, props.platform, props.groupId] as const,
  () => {
    if (!props.show) return
    resetCursor()
    fetchErrorLogs()
  }
)

let searchTimeout: number | null = null
watch(
  () => requestId.value,
  () => {
    if (!props.show) return
    if (searchTimeout) window.clearTimeout(searchTimeout)
    searchTimeout = window.setTimeout(() => {
      resetCursor()
      fetchErrorLogs()
    }, 350)
  }
)

watch(
  () => statusCode.value,
  () => {
    if (!props.show) return
    resetCursor()
    fetchErrorLogs()
  }
)

function goToPreviousPage() {
  if (page.value <= 1) return
  page.value -= 1
  void fetchErrorLogs()
}

function goToNextPage() {
  if (!hasMore.value || !nextCursor.value) return
  cursors.value[page.value] = nextCursor.value
  page.value += 1
  void fetchErrorLogs()
}
</script>

<template>
  <BaseDialog :show="show" :title="modalTitle" width="full" @close="close">
    <div class="flex h-full min-h-0 flex-col">
      <!-- Filters -->
      <div class="mb-4 flex-shrink-0 border-b border-gray-200 pb-4 dark:border-dark-700">
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div class="col-span-2 compact-select">
            <div class="relative group">
              <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <svg
                  class="h-3.5 w-3.5 text-gray-400 transition-colors group-focus-within:text-blue-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                v-model="requestId"
                type="text"
                class="w-full rounded-lg border-gray-200 bg-gray-50/50 py-1.5 pl-9 pr-3 text-xs font-medium text-gray-700 transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/10 dark:border-dark-700 dark:bg-dark-900 dark:text-gray-300 dark:focus:bg-dark-800"
                :placeholder="t('admin.ops.errorDetails.searchPlaceholder')"
              />
            </div>
          </div>

          <div class="compact-select">
            <Select :model-value="statusCode" :options="statusCodeSelectOptions" @update:model-value="statusCode = $event as any" />
          </div>

          <div class="flex items-center justify-end">
            <button type="button" class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-dark-700 dark:text-gray-300 dark:hover:bg-dark-600" @click="resetFilters">
              {{ t('common.reset') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Body -->
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="mb-2 flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">
          {{ t('usage.explorer.page', { page }) }}
        </div>

          <OpsErrorLogTable
            class="min-h-0 flex-1"
            :rows="rows"
            :has-more="hasMore"
            :loading="loading"
            :page="page"
            @openErrorDetail="emit('openErrorDetail', $event)"
            @previous="goToPreviousPage"
            @next="goToNextPage"
          />

      </div>
    </div>
  </BaseDialog>
</template>

<style>
.compact-select .select-trigger {
  @apply py-1.5 px-3 text-xs rounded-lg;
}
</style>
