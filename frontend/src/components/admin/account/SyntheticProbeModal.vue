<template>
  <BaseDialog
    :show="show"
    :title="t('admin.accounts.syntheticProbe.title')"
    width="extra-wide"
    @close="emit('close')"
  >
    <div class="space-y-6">
      <section>
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <h4 class="text-sm font-semibold text-gray-900 dark:text-white">
              {{ t('admin.accounts.syntheticProbe.targets') }}
            </h4>
            <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">
              {{ t('admin.accounts.syntheticProbe.targetHint') }}
            </p>
          </div>
          <span data-testid="synthetic-selection-count" class="text-xs font-medium text-gray-600 dark:text-dark-300">
            {{ t('admin.accounts.syntheticProbe.selected', { count: selectedTargetKeys.size, max: MAX_TARGETS }) }}
          </span>
        </div>

        <div
          v-if="legalTargets.length === 0"
          data-testid="synthetic-probe-empty"
          class="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500 dark:border-dark-600 dark:text-dark-400"
        >
          {{ t('admin.accounts.syntheticProbe.noLegalTargets') }}
        </div>
        <div v-else class="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-gray-200 p-3 dark:border-dark-700">
          <label
            v-for="target in legalTargets"
            :key="target.key"
            class="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-gray-50 dark:hover:bg-dark-800"
          >
            <input
              type="checkbox"
              :checked="selectedTargetKeys.has(target.key)"
              :data-testid="`synthetic-target-${target.account_id}-${target.model_id}-${target.capability}`"
              class="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              @change="toggleTarget(target.key, ($event.target as HTMLInputElement).checked)"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-gray-800 dark:text-dark-100">
                {{ target.account_name }} · {{ target.model_name }}
              </span>
              <span class="block text-xs text-gray-500 dark:text-dark-400">{{ target.capability }}</span>
            </span>
          </label>
        </div>
        <p
          v-if="limitError"
          data-testid="synthetic-limit-error"
          class="mt-2 text-sm text-red-600 dark:text-red-400"
        >
          {{ t('admin.accounts.syntheticProbe.limitExceeded', { max: MAX_TARGETS }) }}
        </p>
        <p v-if="submitError" data-testid="synthetic-submit-error" class="mt-2 text-sm text-red-600 dark:text-red-400">
          {{ submitError }}
        </p>
      </section>

      <section v-if="batchResult" data-testid="synthetic-results">
        <h4 class="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
          {{ t('admin.accounts.syntheticProbe.resultSummary', { queued: batchResult.queued, failed: batchResult.failed }) }}
        </h4>
        <div class="max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-dark-700">
          <div
            v-for="result in batchResult.results"
            :key="`${result.account_id}:${result.model_id}:${result.capability}`"
            class="border-b border-gray-100 px-3 py-2 text-xs last:border-b-0 dark:border-dark-700"
          >
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-gray-800 dark:text-dark-100">
                {{ result.account_id }} · {{ result.model_id }} · {{ result.capability }}
              </span>
              <span :class="result.success ? 'text-green-600' : 'text-amber-600'">
                {{ result.success ? t('admin.accounts.syntheticProbe.accepted') : t('admin.accounts.syntheticProbe.stale') }}
              </span>
            </div>
            <p v-if="result.job_id" class="mt-1 break-all text-gray-500 dark:text-dark-400">{{ result.job_id }}</p>
            <p v-if="result.error" class="mt-1 text-red-600 dark:text-red-400">
              {{ result.error.code }} · {{ result.error.message }}
            </p>
          </div>
        </div>
      </section>

      <section data-testid="synthetic-history">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">
            {{ t('admin.accounts.syntheticProbe.history') }}
          </h4>
          <select
            v-if="accounts.length > 1"
            v-model="historyAccountId"
            data-testid="synthetic-history-account"
            class="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs dark:border-dark-600 dark:bg-dark-800"
            @change="loadHistory(false)"
          >
            <option v-for="account in accounts" :key="String(account.id)" :value="String(account.id)">
              {{ account.name }}
            </option>
          </select>
        </div>

        <div v-if="historyLoading && historyItems.length === 0" data-testid="synthetic-history-loading" class="py-6 text-center text-sm text-gray-500">
          {{ t('admin.accounts.syntheticProbe.loading') }}
        </div>
        <div v-else-if="historyError && historyItems.length === 0" data-testid="synthetic-history-error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
          <p>{{ historyError }}</p>
          <button data-testid="synthetic-history-retry" class="mt-2 font-medium underline" @click="loadHistory(false)">
            {{ t('admin.accounts.syntheticProbe.retry') }}
          </button>
        </div>
        <div v-else-if="historyItems.length === 0" class="py-6 text-center text-sm text-gray-500">
          {{ t('admin.accounts.syntheticProbe.noHistory') }}
        </div>
        <div v-else class="overflow-x-auto rounded-lg border border-gray-200 dark:border-dark-700">
          <table class="w-full text-left text-xs">
            <thead class="bg-gray-50 text-gray-500 dark:bg-dark-800 dark:text-dark-400">
              <tr>
                <th class="px-3 py-2">{{ t('admin.accounts.syntheticProbe.modelCapability') }}</th>
                <th class="px-3 py-2">{{ t('admin.accounts.syntheticProbe.status') }}</th>
                <th class="px-3 py-2">{{ t('admin.accounts.syntheticProbe.errorClass') }}</th>
                <th class="px-3 py-2">{{ t('admin.accounts.syntheticProbe.latency') }}</th>
                <th class="px-3 py-2">{{ t('admin.accounts.syntheticProbe.createdAt') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in historyItems"
                :key="item.id"
                data-testid="synthetic-history-row"
                class="border-t border-gray-100 dark:border-dark-700"
              >
                <td class="px-3 py-2">{{ item.model_id }} · {{ item.capability }}</td>
                <td class="px-3 py-2">{{ item.outcome }}</td>
                <td class="px-3 py-2">{{ item.error_code ?? '—' }}</td>
                <td class="px-3 py-2">{{ item.latency_ms }} ms</td>
                <td class="px-3 py-2">{{ formatCheckedAt(item.checked_at_ms) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="historyError && historyItems.length > 0" data-testid="synthetic-history-error" class="mt-2 text-sm text-red-600">
          {{ historyError }}
        </p>
        <button
          v-if="historyHasMore"
          data-testid="synthetic-history-more"
          :disabled="historyLoading"
          class="mt-3 rounded-lg border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-dark-600"
          @click="loadHistory(true)"
        >
          {{ historyLoading ? t('admin.accounts.syntheticProbe.loading') : t('admin.accounts.syntheticProbe.loadMore') }}
        </button>
      </section>
    </div>

    <template #footer>
      <button class="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-dark-600" @click="emit('close')">
        {{ t('common.close') }}
      </button>
      <button
        data-testid="synthetic-run"
        :disabled="submitting || selectedTargetKeys.size === 0"
        class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        @click="submit"
      >
        {{ submitting ? t('admin.accounts.syntheticProbe.submitting') : t('admin.accounts.syntheticProbe.run') }}
      </button>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import {
  listSyntheticProbeHistory,
  queueSyntheticProbes,
  type WorkerSyntheticProbeBatchResult,
  type WorkerSyntheticProbeCapability,
  type WorkerSyntheticProbeHistoryItem,
} from '@/api/admin/accounts'
import type { WorkerAdminModel } from '@/api/admin/models'

const MAX_TARGETS = 25

interface AccountModelCapability {
  model_id: string
  chat_completions?: boolean
  responses?: boolean
  embeddings?: boolean
}

export interface SyntheticProbeAccount {
  id: string | number
  name: string
  platform: string
  control_version?: number
  model_capabilities?: AccountModelCapability[]
}

interface LegalTarget {
  key: string
  account_id: string
  account_name: string
  expected_control_version: number
  model_id: string
  model_name: string
  capability: WorkerSyntheticProbeCapability
}

const props = defineProps<{
  show: boolean
  accounts: SyntheticProbeAccount[]
  models: WorkerAdminModel[]
}>()

const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useI18n()
const selectedTargetKeys = ref(new Set<string>())
const limitError = ref(false)
const submitting = ref(false)
const submitError = ref('')
const batchResult = ref<WorkerSyntheticProbeBatchResult | null>(null)
const historyItems = ref<WorkerSyntheticProbeHistoryItem[]>([])
const historyAccountId = ref('')
const historyLoading = ref(false)
const historyError = ref('')
const historyHasMore = ref(false)
const historyCursor = ref<string | null>(null)

function supportsCapability(model: WorkerAdminModel, capability: WorkerSyntheticProbeCapability): boolean {
  if (capability === 'chat_completions') return model.endpoint === 'chat_completions' || model.endpoint === 'both'
  if (capability === 'responses') return model.endpoint === 'responses' || model.endpoint === 'both'
  return model.embeddings
}

const legalTargets = computed<LegalTarget[]>(() => {
  const modelById = new Map(props.models.filter((model) => model.enabled).map((model) => [model.id, model]))
  const targets = new Map<string, LegalTarget>()
  for (const account of props.accounts) {
    if (!Number.isSafeInteger(account.control_version) || (account.control_version ?? -1) < 0) continue
    for (const relation of account.model_capabilities ?? []) {
      const model = modelById.get(relation.model_id)
      if (!model || model.platform !== account.platform) continue
      const capabilities: WorkerSyntheticProbeCapability[] = ['chat_completions', 'responses', 'embeddings']
      for (const capability of capabilities) {
        if (!relation[capability] || !supportsCapability(model, capability)) continue
        const key = `${String(account.id)}\u0000${model.id}\u0000${capability}`
        targets.set(key, {
          key,
          account_id: String(account.id),
          account_name: account.name,
          expected_control_version: account.control_version as number,
          model_id: model.id,
          model_name: model.public_name,
          capability,
        })
      }
    }
  }
  return Array.from(targets.values())
})

function toggleTarget(key: string, selected: boolean) {
  const next = new Set(selectedTargetKeys.value)
  if (selected) {
    if (next.size >= MAX_TARGETS) {
      limitError.value = true
      return
    }
    next.add(key)
  } else {
    next.delete(key)
  }
  limitError.value = false
  selectedTargetKeys.value = next
}

async function submit() {
  if (submitting.value || selectedTargetKeys.value.size === 0) return
  const selected = legalTargets.value.filter((target) => selectedTargetKeys.value.has(target.key))
  submitting.value = true
  submitError.value = ''
  try {
    batchResult.value = await queueSyntheticProbes(selected.map((target) => ({
      account_id: target.account_id,
      expected_control_version: target.expected_control_version,
      model_id: target.model_id,
      capability: target.capability,
    })))
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : t('admin.accounts.syntheticProbe.submitFailed')
  } finally {
    submitting.value = false
  }
}

async function loadHistory(append: boolean) {
  if (historyLoading.value || !historyAccountId.value) return
  historyLoading.value = true
  historyError.value = ''
  try {
    const page = await listSyntheticProbeHistory({
      account_id: historyAccountId.value,
      limit: 25,
      ...(append && historyCursor.value ? { cursor: historyCursor.value } : {}),
    })
    historyItems.value = append ? [...historyItems.value, ...page.items] : page.items
    historyHasMore.value = page.has_more
    historyCursor.value = page.next_cursor
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : t('admin.accounts.syntheticProbe.historyFailed')
  } finally {
    historyLoading.value = false
  }
}

function formatCheckedAt(value: number): string {
  return Number.isFinite(value) ? new Date(value).toLocaleString() : '—'
}

watch(
  () => [props.show, props.accounts.map((account) => String(account.id)).join(',')],
  ([show]) => {
    if (!show) return
    selectedTargetKeys.value = new Set()
    limitError.value = false
    submitError.value = ''
    batchResult.value = null
    historyItems.value = []
    historyHasMore.value = false
    historyCursor.value = null
    historyAccountId.value = props.accounts[0] ? String(props.accounts[0].id) : ''
    void loadHistory(false)
  },
  { immediate: true }
)
</script>
