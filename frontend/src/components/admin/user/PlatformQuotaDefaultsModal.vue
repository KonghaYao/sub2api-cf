<template>
  <BaseDialog
    :show="show"
    :title="t('admin.users.platformQuotaDefaults.title')"
    width="wide"
    @close="emit('close')"
  >
    <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
      {{ t('admin.users.platformQuotaDefaults.hint') }}
    </p>
    <div v-if="loading" class="py-10 text-center text-gray-500">
      {{ t('common.loading') }}
    </div>
    <div v-else class="overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200 dark:border-dark-700">
            <th class="px-3 py-2 text-left">{{ t('admin.users.platformQuota.columns.platform') }}</th>
            <th class="px-3 py-2 text-left">{{ t('admin.users.platformQuota.columns.daily') }}</th>
            <th class="px-3 py-2 text-left">{{ t('admin.users.platformQuota.columns.weekly') }}</th>
            <th class="px-3 py-2 text-left">{{ t('admin.users.platformQuota.columns.monthly') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="platform in platforms"
            :key="platform"
            class="border-b border-gray-100 dark:border-dark-800"
          >
            <td class="px-3 py-2 font-mono">{{ platform }}</td>
            <td v-for="quotaWindow in windows" :key="quotaWindow" class="px-3 py-2">
              <input
                v-model.number="form[platform][`${quotaWindow}_limit_usd`]"
                type="number"
                min="0"
                step="0.000001"
                class="input w-28"
                :data-test="`default-${platform}-${quotaWindow}`"
                :placeholder="t('admin.users.platformQuota.placeholder')"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <template #footer>
      <div class="flex justify-end gap-3">
        <button type="button" class="btn btn-secondary" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          data-test="save-platform-quota-defaults"
          :disabled="loading || submitting"
          @click="save"
        >
          {{ submitting ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminAPI } from '@/api/admin'
import type {
  PlatformQuotaDefaultLimits,
  PlatformQuotaDefaultsMap,
  PlatformQuotaPlatform,
} from '@/api/admin/platformQuotas'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { useAppStore } from '@/stores/app'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: []; success: [] }>()
const { t } = useI18n()
const appStore = useAppStore()

const platforms: readonly PlatformQuotaPlatform[] = [
  'anthropic', 'openai', 'gemini', 'antigravity', 'grok',
]
const windows = ['daily', 'weekly', 'monthly'] as const
const loading = ref(false)
const submitting = ref(false)
const controlVersion = ref<number | null>(null)
const form = ref<PlatformQuotaDefaultsMap>(emptyMatrix())

watch(
  () => props.show,
  (show) => { if (show) void load() },
)

function emptyLimits(): PlatformQuotaDefaultLimits {
  return { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null }
}

function emptyMatrix(): PlatformQuotaDefaultsMap {
  return Object.fromEntries(
    platforms.map((platform) => [platform, emptyLimits()]),
  ) as PlatformQuotaDefaultsMap
}

function normalizeMatrix(value: Partial<PlatformQuotaDefaultsMap>): PlatformQuotaDefaultsMap {
  return Object.fromEntries(platforms.map((platform) => {
    const limits = value[platform]
    return [platform, {
      daily_limit_usd: limits?.daily_limit_usd ?? null,
      weekly_limit_usd: limits?.weekly_limit_usd ?? null,
      monthly_limit_usd: limits?.monthly_limit_usd ?? null,
    }]
  })) as PlatformQuotaDefaultsMap
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const data = await adminAPI.platformQuotas.getDefaults()
    controlVersion.value = data.control_version
    form.value = normalizeMatrix(data.platform_quotas)
  } catch (error: unknown) {
    controlVersion.value = null
    form.value = emptyMatrix()
    appStore.showError(errorMessage(error, t('admin.users.platformQuotaDefaults.loadFailed')))
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (controlVersion.value === null) {
    appStore.showError(t('admin.users.platformQuotaDefaults.loadFailed'))
    return
  }
  const next = emptyMatrix()
  for (const platform of platforms) {
    for (const quotaWindow of windows) {
      const field = `${quotaWindow}_limit_usd` as const
      const value = form.value[platform][field]
      if (value !== null && (
        typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) > 1e-6
      )) {
        appStore.showError(t('admin.users.platformQuotaDefaults.invalidNumber'))
        return
      }
      next[platform][field] = value === null ? null : value
    }
  }
  submitting.value = true
  try {
    const data = await adminAPI.platformQuotas.updateDefaults(next, controlVersion.value)
    controlVersion.value = data.control_version
    form.value = normalizeMatrix(data.platform_quotas)
    appStore.showSuccess(t('admin.users.platformQuotaDefaults.updateSuccess'))
    emit('success')
    emit('close')
  } catch (error: unknown) {
    appStore.showError(errorMessage(error, t('admin.users.platformQuotaDefaults.updateFailed')))
  } finally {
    submitting.value = false
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return fallback
}
</script>
