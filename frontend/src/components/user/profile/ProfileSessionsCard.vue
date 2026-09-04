<template>
  <div class="card">
    <div class="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
      <div>
        <h2 class="text-lg font-medium text-gray-900 dark:text-white">
          {{ t('profile.sessions.title') }}
        </h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {{ t('profile.sessions.description') }}
        </p>
      </div>
      <button
        v-if="hasOtherSessions"
        type="button"
        class="btn btn-secondary btn-sm shrink-0"
        :disabled="busy"
        @click="revokeOthers"
      >
        {{ t('profile.sessions.revokeOthers') }}
      </button>
    </div>

    <div class="px-6 py-6">
      <div v-if="loading" class="flex justify-center py-6">
        <div class="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-500"></div>
      </div>
      <div
        v-else-if="sessions.length === 0"
        class="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-gray-400"
      >
        {{ t('profile.sessions.empty') }}
      </div>
      <div v-else class="divide-y divide-gray-100 dark:divide-dark-700">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <Icon name="server" size="md" class="shrink-0 text-primary-500" />
              <p class="truncate font-medium text-gray-900 dark:text-white">
                {{ session.user_agent || t('profile.sessions.unknownDevice') }}
              </p>
              <span
                v-if="session.current"
                class="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300"
              >
                {{ t('profile.sessions.current') }}
              </span>
            </div>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ t('profile.sessions.createdAt', { date: formatDate(session.created_at) }) }}
              <template v-if="session.last_seen_at">
                · {{ t('profile.sessions.lastSeen', { date: formatDate(session.last_seen_at) }) }}
              </template>
            </p>
          </div>
          <button
            v-if="!session.current"
            type="button"
            class="btn btn-ghost btn-sm shrink-0 text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
            :disabled="busy"
            @click="revokeOne(session)"
          >
            {{ t('profile.sessions.revoke') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { authAPI } from '@/api'
import type { UserSessionSummary } from '@/api/auth'
import { Icon } from '@/components/icons'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const appStore = useAppStore()
const sessions = ref<UserSessionSummary[]>([])
const loading = ref(false)
const busy = ref(false)
const hasOtherSessions = computed(() => sessions.value.some((session) => !session.current))

async function loadSessions(): Promise<void> {
  loading.value = true
  try {
    sessions.value = (await authAPI.getSessions()).items
  } catch {
    appStore.showError(t('profile.sessions.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function revokeOne(session: UserSessionSummary): Promise<void> {
  if (!window.confirm(t('profile.sessions.revokeConfirm'))) return
  busy.value = true
  try {
    await authAPI.revokeSession(session.id)
    sessions.value = sessions.value.filter((item) => item.id !== session.id)
    appStore.showSuccess(t('profile.sessions.revoked'))
  } catch {
    appStore.showError(t('profile.sessions.revokeFailed'))
  } finally {
    busy.value = false
  }
}

async function revokeOthers(): Promise<void> {
  if (!window.confirm(t('profile.sessions.revokeOthersConfirm'))) return
  busy.value = true
  try {
    await authAPI.revokeOtherSessions()
    sessions.value = sessions.value.filter((session) => session.current)
    appStore.showSuccess(t('profile.sessions.othersRevoked'))
  } catch {
    appStore.showError(t('profile.sessions.revokeFailed'))
  } finally {
    busy.value = false
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

onMounted(loadSessions)
</script>
