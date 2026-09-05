<template>
  <nav
    class="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 dark:border-dark-700"
    :aria-label="t('usage.explorer.paginationLabel')"
  >
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      data-testid="cursor-previous"
      :disabled="loading || page <= 1"
      @click="emit('previous')"
    >
      {{ t('usage.explorer.previous') }}
    </button>
    <span class="text-xs text-gray-500 dark:text-gray-400">
      {{ t('usage.explorer.page', { page }) }}
    </span>
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      data-testid="cursor-next"
      :disabled="loading || !hasMore"
      @click="emit('next')"
    >
      {{ t('usage.explorer.next') }}
    </button>
  </nav>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  page: number
  hasMore: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  (event: 'previous'): void
  (event: 'next'): void
}>()

const { t } = useI18n()
</script>
