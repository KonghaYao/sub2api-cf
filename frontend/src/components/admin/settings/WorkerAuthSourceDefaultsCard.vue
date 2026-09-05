<template>
  <section class="card" data-testid="worker-auth-source-defaults-card">
    <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
            {{ t("admin.settings.authSourceDefaults.workerTitle") }}
          </h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t("admin.settings.authSourceDefaults.workerDescription") }}
          </p>
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="loading || saving"
          data-testid="auth-source-reload"
          @click="load"
        >
          {{ t("admin.settings.authSourceDefaults.reload") }}
        </button>
      </div>
    </div>

    <div class="space-y-5 p-6">
      <div v-if="loading" class="text-sm text-gray-500" data-testid="auth-source-loading">
        {{ t("admin.settings.authSourceDefaults.loading") }}
      </div>

      <template v-else>
        <div>
          <label for="worker-auth-source" class="input-label">
            {{ t("admin.settings.authSourceDefaults.sourceLabel") }}
          </label>
          <select
            id="worker-auth-source"
            v-model="selectedSource"
            class="input max-w-md"
            data-testid="auth-source-select"
            :disabled="saving"
            @change="clearMessages"
          >
            <option v-for="source in authSources" :key="source" :value="source">
              {{ sourceLabel(source) }}
            </option>
          </select>
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-4 dark:border-dark-600">
            <input
              v-model="current.grant_on_signup"
              type="checkbox"
              class="mt-0.5"
              data-testid="auth-source-grant-signup"
              :disabled="saving"
            />
            <span>
              <span class="block text-sm font-medium text-gray-900 dark:text-white">
                {{ t("admin.settings.authSourceDefaults.grantOnSignupLabel") }}
              </span>
              <span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                {{ t("admin.settings.authSourceDefaults.grantOnSignupHint") }}
              </span>
            </span>
          </label>
          <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-4 dark:border-dark-600">
            <input
              v-model="current.grant_on_first_bind"
              type="checkbox"
              class="mt-0.5"
              data-testid="auth-source-grant-first-bind"
              :disabled="saving"
            />
            <span>
              <span class="block text-sm font-medium text-gray-900 dark:text-white">
                {{ t("admin.settings.authSourceDefaults.grantOnFirstBindLabel") }}
              </span>
              <span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                {{ t("admin.settings.authSourceDefaults.grantOnFirstBindHint") }}
              </span>
            </span>
          </label>
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label for="worker-auth-source-balance" class="input-label">
              {{ t("admin.settings.authSourceDefaults.balanceUsdLabel") }}
            </label>
            <input
              id="worker-auth-source-balance"
              v-model.number="current.balance"
              type="number"
              min="0"
              step="0.000001"
              class="input"
              data-testid="auth-source-balance"
              :disabled="saving"
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ t("admin.settings.authSourceDefaults.usdPrecisionHint") }}
            </p>
          </div>
          <div>
            <label for="worker-auth-source-concurrency" class="input-label">
              {{ t("admin.settings.authSourceDefaults.concurrencyLabel") }}
            </label>
            <input
              id="worker-auth-source-concurrency"
              v-model.number="current.concurrency"
              type="number"
              min="1"
              step="1"
              class="input"
              data-testid="auth-source-concurrency"
              :disabled="saving"
            />
          </div>
        </div>

        <div class="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-dark-600">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="font-medium text-gray-900 dark:text-white">
                {{ t("admin.settings.authSourceDefaults.defaultSubscriptionsLabel") }}
              </h3>
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {{ t("admin.settings.authSourceDefaults.defaultSubscriptionsHint") }}
              </p>
            </div>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="auth-source-add-subscription"
              :disabled="saving || availableSubscriptionGroups.length === 0"
              @click="addSubscription"
            >
              {{ t("admin.settings.authSourceDefaults.addSubscription") }}
            </button>
          </div>

          <p
            v-if="current.subscriptions.length === 0"
            class="rounded border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-500 dark:border-dark-600"
          >
            {{ t("admin.settings.authSourceDefaults.noSourceSubscriptions") }}
          </p>
          <div
            v-for="(subscription, index) in current.subscriptions"
            v-else
            :key="`${selectedSource}-${index}`"
            class="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_auto]"
          >
            <div>
              <label :for="`worker-auth-source-group-${index}`" class="input-label">
                {{ t("admin.settings.authSourceDefaults.subscriptionGroupLabel") }}
              </label>
              <select
                :id="`worker-auth-source-group-${index}`"
                v-model="subscription.group_id"
                class="input"
                :data-testid="`auth-source-subscription-group-${index}`"
                :disabled="saving"
              >
                <option value="" disabled>
                  {{ t("admin.settings.authSourceDefaults.subscriptionGroupPlaceholder") }}
                </option>
                <option
                  v-for="group in groupsFor(subscription.group_id)"
                  :key="group.id"
                  :value="group.id"
                >
                  {{ group.name }} ({{ group.id }})
                </option>
              </select>
            </div>
            <div>
              <label :for="`worker-auth-source-validity-${index}`" class="input-label">
                {{ t("admin.settings.authSourceDefaults.validityDaysLabel") }}
              </label>
              <input
                :id="`worker-auth-source-validity-${index}`"
                v-model.number="subscription.validity_days"
                type="number"
                min="1"
                max="36500"
                step="1"
                class="input"
                :data-testid="`auth-source-subscription-validity-${index}`"
                :disabled="saving"
              />
            </div>
            <div class="flex items-end">
              <button
                type="button"
                class="btn btn-secondary text-red-600 dark:text-red-400"
                :disabled="saving"
                :aria-label="t('admin.settings.authSourceDefaults.removeSubscription')"
                @click="removeSubscription(index)"
              >
                {{ t("common.delete") }}
              </button>
            </div>
          </div>
        </div>

        <div class="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-dark-600">
          <div>
            <h3 class="font-medium text-gray-900 dark:text-white">
              {{ t("admin.settings.authSourceDefaults.platformQuotasTitle") }}
            </h3>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ t("admin.settings.authSourceDefaults.platformQuotasWorkerHint") }}
            </p>
          </div>
          <div class="overflow-x-auto">
            <table class="min-w-full text-sm">
              <thead>
                <tr class="text-left text-xs text-gray-500 dark:text-gray-400">
                  <th class="pb-2 pr-3 font-medium">{{ t("admin.settings.authSourceDefaults.platform") }}</th>
                  <th class="pb-2 pr-3 font-medium">{{ t("admin.settings.authSourceDefaults.dailyUsd") }}</th>
                  <th class="pb-2 pr-3 font-medium">{{ t("admin.settings.authSourceDefaults.weeklyUsd") }}</th>
                  <th class="pb-2 font-medium">{{ t("admin.settings.authSourceDefaults.monthlyUsd") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="platform in quotaPlatforms" :key="platform">
                  <td class="py-1 pr-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                    {{ platform }}
                  </td>
                  <td v-for="window in quotaWindows" :key="window" class="py-1 pr-3">
                    <input
                      v-model.number="current.platform_quotas[platform][window]"
                      type="number"
                      min="0"
                      step="0.000001"
                      class="input h-9 w-32"
                      :data-testid="`auth-source-quota-${platform}-${window}`"
                      :aria-label="`${platform} ${window} USD`"
                      :placeholder="t('admin.settings.authSourceDefaults.unlimitedPlaceholder')"
                      :disabled="saving"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div
          v-if="errorMessage"
          class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          role="alert"
          data-testid="auth-source-error"
        >
          {{ errorMessage }}
        </div>
        <div
          v-else-if="successMessage"
          class="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
          aria-live="polite"
          data-testid="auth-source-success"
        >
          {{ successMessage }}
        </div>

        <div class="flex justify-end">
          <button
            type="button"
            class="btn btn-primary"
            data-testid="auth-source-save"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? t("admin.settings.authSourceDefaults.saving") : t("admin.settings.authSourceDefaults.saveSource") }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { adminAPI } from '@/api'
import type {
  AuthSourceType,
  PlatformQuotaLimits,
  PlatformType,
  WorkerAuthSourceDefaultSettings,
  WorkerAuthSourceDefaults,
  WorkerAuthSourceDefaultsPatch,
} from '@/api/admin/settings'

const authSources: readonly AuthSourceType[] = [
  'email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google',
]
const quotaPlatforms: readonly PlatformType[] = [
  'anthropic', 'openai', 'gemini', 'antigravity', 'grok',
]
const quotaWindows = ['daily', 'weekly', 'monthly'] as const

interface SubscriptionGroupOption {
  id: string
  name: string
}

type EditableAuthSourceDefaultSettings = Omit<
  WorkerAuthSourceDefaultSettings,
  'platform_quotas'
> & {
  platform_quotas: Record<PlatformType, PlatformQuotaLimits>
}

type EditableAuthSourceDefaults = Record<
  AuthSourceType,
  EditableAuthSourceDefaultSettings
>

const { t } = useI18n()
const loading = ref(true)
const saving = ref(false)
const selectedSource = ref<AuthSourceType>('email')
const errorMessage = ref('')
const successMessage = ref('')
const availableSubscriptionGroups = ref<SubscriptionGroupOption[]>([])
const defaults = reactive<EditableAuthSourceDefaults>(emptyDefaults())
const current = computed(() => defaults[selectedSource.value])

function emptyQuota(): PlatformQuotaLimits {
  return { daily: null, weekly: null, monthly: null }
}

function emptySource(): EditableAuthSourceDefaultSettings {
  return {
    balance: 0,
    concurrency: 5,
    subscriptions: [],
    grant_on_signup: false,
    grant_on_first_bind: false,
    platform_quotas: Object.fromEntries(
      quotaPlatforms.map((platform) => [platform, emptyQuota()]),
    ) as Record<PlatformType, PlatformQuotaLimits>,
  }
}

function emptyDefaults(): EditableAuthSourceDefaults {
  return Object.fromEntries(
    authSources.map((source) => [source, emptySource()]),
  ) as EditableAuthSourceDefaults
}

function normalizeSource(value: WorkerAuthSourceDefaultSettings): EditableAuthSourceDefaultSettings {
  return {
    balance: value.balance,
    concurrency: value.concurrency,
    subscriptions: value.subscriptions.map((subscription) => ({ ...subscription })),
    grant_on_signup: value.grant_on_signup,
    grant_on_first_bind: value.grant_on_first_bind,
    platform_quotas: Object.fromEntries(
      quotaPlatforms.map((platform) => [
        platform,
        { ...emptyQuota(), ...value.platform_quotas[platform] },
      ]),
    ) as Record<PlatformType, PlatformQuotaLimits>,
  }
}

function applyDefaults(values: WorkerAuthSourceDefaults): void {
  for (const source of authSources) {
    const value = values[source]
    if (!value) throw new Error(t('admin.settings.authSourceDefaults.invalidResponse'))
    defaults[source] = normalizeSource(value)
  }
}

function sourceLabel(source: AuthSourceType): string {
  return t(`admin.settings.authSourceDefaults.sources.${source}.title`)
}

function clearMessages(): void {
  errorMessage.value = ''
  successMessage.value = ''
}

function readableError(error: unknown, fallbackKey: string): string {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown }
    const code = typeof value.code === 'string' ? value.code : ''
    const message = typeof value.message === 'string' ? value.message : t(fallbackKey)
    return code ? `${message} (${code})` : message
  }
  return t(fallbackKey)
}

async function load(): Promise<void> {
  loading.value = true
  clearMessages()
  try {
    const [settings, groups] = await Promise.all([
      adminAPI.settings.getSettings(),
      adminAPI.groups.getAll(),
    ])
    if (!settings.cloudflare_worker_contract || !settings.auth_source_defaults) {
      throw new Error(t('admin.settings.authSourceDefaults.invalidResponse'))
    }
    applyDefaults(settings.auth_source_defaults)
    availableSubscriptionGroups.value = groups
      .filter((group) => group.subscription_type === 'subscription' && group.status === 'active')
      .map((group) => ({ id: String(group.id), name: group.name }))
  } catch (error: unknown) {
    errorMessage.value = readableError(error, 'admin.settings.authSourceDefaults.loadFailed')
  } finally {
    loading.value = false
  }
}

function groupsFor(currentGroupID: string): SubscriptionGroupOption[] {
  if (
    currentGroupID === '' ||
    availableSubscriptionGroups.value.some((group) => group.id === currentGroupID)
  ) {
    return availableSubscriptionGroups.value
  }
  return [
    { id: currentGroupID, name: t('admin.settings.authSourceDefaults.unavailableGroup') },
    ...availableSubscriptionGroups.value,
  ]
}

function addSubscription(): void {
  const used = new Set(current.value.subscriptions.map((subscription) => subscription.group_id))
  const group = availableSubscriptionGroups.value.find((candidate) => !used.has(candidate.id))
  if (!group) return
  current.value.subscriptions.push({ group_id: group.id, validity_days: 30 })
}

function removeSubscription(index: number): void {
  current.value.subscriptions.splice(index, 1)
}

function validUsdAmount(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false
  return Number.isSafeInteger(value * 1_000_000)
}

function normalizedQuotaValue(value: unknown): number | null | undefined {
  if (value === '' || value === null || value === undefined) return null
  return validUsdAmount(value) ? value : undefined
}

function validatedCurrent(): WorkerAuthSourceDefaultSettings | null {
  const value = current.value
  const source = sourceLabel(selectedSource.value)
  if (!validUsdAmount(value.balance)) {
    errorMessage.value = t('admin.settings.authSourceDefaults.validation.balance', { source })
    return null
  }
  if (!Number.isSafeInteger(value.concurrency) || value.concurrency < 1) {
    errorMessage.value = t('admin.settings.authSourceDefaults.validation.concurrency', { source })
    return null
  }
  if (value.subscriptions.length > 100) {
    errorMessage.value = t('admin.settings.authSourceDefaults.validation.subscriptionCount', { source })
    return null
  }
  const groupIDs = new Set<string>()
  for (const subscription of value.subscriptions) {
    const groupID = subscription.group_id.trim()
    if (
      groupID === '' ||
      groupID.length > 128 ||
      groupIDs.has(groupID) ||
      !Number.isSafeInteger(subscription.validity_days) ||
      subscription.validity_days < 1 ||
      subscription.validity_days > 36_500
    ) {
      errorMessage.value = t('admin.settings.authSourceDefaults.validation.subscription', { source })
      return null
    }
    groupIDs.add(groupID)
  }
  const platformQuotas: WorkerAuthSourceDefaultSettings['platform_quotas'] = {}
  for (const platform of quotaPlatforms) {
    const quota = value.platform_quotas[platform] ?? emptyQuota()
    const normalized = {
      daily: normalizedQuotaValue(quota.daily),
      weekly: normalizedQuotaValue(quota.weekly),
      monthly: normalizedQuotaValue(quota.monthly),
    }
    if (Object.values(normalized).some((amount) => amount === undefined)) {
      errorMessage.value = t('admin.settings.authSourceDefaults.validation.quota', {
        source,
        platform,
      })
      return null
    }
    const limits = normalized as PlatformQuotaLimits
    if (Object.values(limits).some((amount) => amount !== null)) {
      platformQuotas[platform] = limits
    }
  }
  return {
    balance: value.balance,
    concurrency: value.concurrency,
    subscriptions: value.subscriptions.map((subscription) => ({
      group_id: subscription.group_id.trim(),
      validity_days: subscription.validity_days,
    })),
    grant_on_signup: value.grant_on_signup,
    grant_on_first_bind: value.grant_on_first_bind,
    platform_quotas: platformQuotas,
  }
}

async function save(): Promise<void> {
  clearMessages()
  const validated = validatedCurrent()
  if (!validated) return
  saving.value = true
  try {
    const patch: WorkerAuthSourceDefaultsPatch = {
      [selectedSource.value]: validated,
    }
    const updated = await adminAPI.settings.updateSettings({ auth_source_defaults: patch })
    if (!updated.auth_source_defaults) {
      throw new Error(t('admin.settings.authSourceDefaults.invalidResponse'))
    }
    applyDefaults(updated.auth_source_defaults)
    successMessage.value = t('admin.settings.authSourceDefaults.saved', {
      source: sourceLabel(selectedSource.value),
    })
  } catch (error: unknown) {
    errorMessage.value = readableError(error, 'admin.settings.authSourceDefaults.saveFailed')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>
