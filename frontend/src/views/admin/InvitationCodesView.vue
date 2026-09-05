<template>
  <AppLayout>
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold text-gray-900 dark:text-white">{{ t('admin.invitation.title') }}</h1>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.invitation.description') }}</p>
        </div>
        <button class="btn btn-primary" data-testid="invitation-create-open" @click="openCreateDialog">
          <Icon name="plus" size="sm" />
          {{ t('admin.invitation.create') }}
        </button>
      </div>

      <div class="card p-4">
        <form class="flex flex-wrap items-center gap-3" @submit.prevent="applyFilters">
          <input
            v-model.trim="filters.search"
            class="input min-w-56 flex-1"
            type="search"
            :placeholder="t('admin.invitation.searchPlaceholder')"
            data-testid="invitation-search"
          />
          <select v-model="filters.status" class="input w-40" @change="applyFilters">
            <option value="">{{ t('admin.invitation.allStatuses') }}</option>
            <option value="active">{{ t('admin.invitation.active') }}</option>
            <option value="disabled">{{ t('admin.invitation.disabled') }}</option>
          </select>
          <button class="btn btn-secondary" type="button" data-testid="invitation-search-submit" @click="applyFilters">
            {{ t('common.search') }}
          </button>
          <button class="btn btn-secondary" type="button" :disabled="loading" @click="loadCodes">
            <Icon name="refresh" size="sm" :class="loading ? 'animate-spin' : ''" />
            {{ t('common.refresh') }}
          </button>
        </form>
      </div>

      <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-dark-600">
        <table class="min-w-full divide-y divide-gray-200 text-sm dark:divide-dark-600">
          <thead class="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-dark-700 dark:text-gray-400">
            <tr>
              <th class="px-3 py-2">{{ t('admin.invitation.code') }}</th>
              <th class="px-3 py-2">{{ t('admin.invitation.usage') }}</th>
              <th class="px-3 py-2">{{ t('admin.invitation.status') }}</th>
              <th class="px-3 py-2">{{ t('admin.invitation.expiresAt') }}</th>
              <th class="px-3 py-2">{{ t('admin.invitation.notes') }}</th>
              <th class="px-3 py-2 text-right">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 bg-white dark:divide-dark-700 dark:bg-dark-800">
            <tr v-if="loading">
              <td colspan="6" class="px-3 py-10 text-center text-gray-500">{{ t('common.loading') }}</td>
            </tr>
            <tr v-else-if="codes.length === 0">
              <td colspan="6" class="px-3 py-10 text-center text-gray-500">{{ t('admin.invitation.empty') }}</td>
            </tr>
            <tr v-for="code in codes" v-else :key="code.id">
              <td class="px-3 py-3">
                <div class="font-mono font-medium text-gray-900 dark:text-white">{{ code.code }}</div>
                <div class="mt-1 max-w-48 truncate font-mono text-[11px] text-gray-400" :title="code.id">{{ code.id }}</div>
              </td>
              <td class="px-3 py-3 text-gray-700 dark:text-gray-300">
                {{ code.used_count }} / {{ code.max_uses }}
              </td>
              <td class="px-3 py-3">
                <span :class="statusClass(code)">{{ statusLabel(code) }}</span>
                <div class="mt-1 font-mono text-[11px] text-gray-400">v{{ code.control_version }}</div>
              </td>
              <td class="whitespace-nowrap px-3 py-3 text-gray-500">
                {{ code.expires_at ? formatDateTime(code.expires_at) : t('admin.invitation.never') }}
              </td>
              <td class="max-w-56 truncate px-3 py-3 text-gray-500" :title="code.notes || ''">
                {{ code.notes || '—' }}
              </td>
              <td class="px-3 py-3">
                <div class="flex justify-end gap-1">
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    :data-testid="`invitation-copy-link-${code.id}`"
                    @click="copyRegistrationLink(code)"
                  >
                    {{ t('admin.invitation.copyLink') }}
                  </button>
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    :data-testid="`invitation-usages-${code.id}`"
                    @click="openUsages(code)"
                  >
                    {{ t('admin.invitation.records') }}
                  </button>
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    :data-testid="`invitation-edit-${code.id}`"
                    @click="openEditDialog(code)"
                  >
                    {{ t('common.edit') }}
                  </button>
                  <button
                    v-if="code.used_count === 0"
                    class="btn btn-danger btn-sm"
                    type="button"
                    :data-testid="`invitation-delete-${code.id}`"
                    @click="deletingCode = code"
                  >
                    {{ t('common.delete') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Pagination
        v-if="pagination.total > 0"
        :page="pagination.page"
        :total="pagination.total"
        :page-size="pagination.pageSize"
        @update:page="changePage"
        @update:page-size="changePageSize"
      />
    </div>

    <BaseDialog :show="showCreateDialog" :title="t('admin.invitation.create')" @close="showCreateDialog = false">
      <form id="invitation-create-form" class="space-y-4" @submit.prevent="createCode">
        <div>
          <label class="input-label">{{ t('admin.invitation.code') }}</label>
          <input v-model.trim="createForm.code" class="input font-mono uppercase" data-testid="invitation-create-code" :placeholder="t('admin.invitation.autoGenerate')" />
        </div>
        <div>
          <label class="input-label">{{ t('admin.invitation.maxUses') }}</label>
          <input v-model.number="createForm.maxUses" class="input" type="number" min="1" max="1000000" required data-testid="invitation-create-max-uses" />
        </div>
        <div>
          <label class="input-label">{{ t('admin.invitation.expiresAt') }}</label>
          <input v-model="createForm.expiresAt" class="input" type="datetime-local" />
        </div>
        <div>
          <label class="input-label">{{ t('admin.invitation.notes') }}</label>
          <textarea v-model.trim="createForm.notes" class="input min-h-20" maxlength="1000" />
        </div>
      </form>
      <template #footer>
        <button class="btn btn-secondary" type="button" @click="showCreateDialog = false">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="submit" form="invitation-create-form" :disabled="creating" data-testid="invitation-create-submit">{{ t('common.create') }}</button>
      </template>
    </BaseDialog>

    <BaseDialog :show="editingCode !== null" :title="t('admin.invitation.edit')" @close="editingCode = null">
      <form id="invitation-edit-form" class="space-y-4" @submit.prevent="updateCode">
        <div>
          <label class="input-label">{{ t('admin.invitation.code') }}</label>
          <input v-model.trim="editForm.code" class="input font-mono uppercase" />
        </div>
        <div>
          <label class="input-label">{{ t('admin.invitation.maxUses') }}</label>
          <input v-model.number="editForm.maxUses" class="input" type="number" :min="editingCode?.used_count || 1" max="1000000" required data-testid="invitation-edit-max-uses" />
        </div>
        <div>
          <label class="input-label">{{ t('admin.invitation.status') }}</label>
          <select v-model="editForm.status" class="input" data-testid="invitation-edit-status">
            <option value="active">{{ t('admin.invitation.active') }}</option>
            <option value="disabled">{{ t('admin.invitation.disabled') }}</option>
          </select>
        </div>
        <div>
          <label class="input-label">{{ t('admin.invitation.expiresAt') }}</label>
          <input v-model="editForm.expiresAt" class="input" type="datetime-local" />
        </div>
        <div>
          <label class="input-label">{{ t('admin.invitation.notes') }}</label>
          <textarea v-model.trim="editForm.notes" class="input min-h-20" maxlength="1000" />
        </div>
      </form>
      <template #footer>
        <button class="btn btn-secondary" type="button" @click="editingCode = null">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="submit" form="invitation-edit-form" :disabled="updating" data-testid="invitation-edit-submit">{{ t('common.save') }}</button>
      </template>
    </BaseDialog>

    <BaseDialog :show="usageCode !== null" :title="t('admin.invitation.usageRecords')" width="wide" @close="usageCode = null">
      <div data-testid="invitation-usage-records">
        <p v-if="usagesLoading" class="py-8 text-center text-gray-500">{{ t('common.loading') }}</p>
        <p v-else-if="usages.length === 0" class="py-8 text-center text-gray-500">{{ t('admin.invitation.noUsages') }}</p>
        <ul v-else class="divide-y divide-gray-100 dark:divide-dark-600">
          <li v-for="usage in usages" :key="usage.id" class="flex items-center justify-between gap-4 py-3">
            <div>
              <p class="font-medium text-gray-900 dark:text-white">{{ usage.user.email }}</p>
              <p class="text-xs text-gray-500">{{ usage.user.username || usage.user_id }}</p>
            </div>
            <time class="text-xs text-gray-500">{{ formatDateTime(usage.used_at) }}</time>
          </li>
        </ul>
        <Pagination
          v-if="usagePagination.total > usagePagination.pageSize"
          :page="usagePagination.page"
          :total="usagePagination.total"
          :page-size="usagePagination.pageSize"
          @update:page="changeUsagePage"
        />
      </div>
    </BaseDialog>

    <ConfirmDialog
      :show="deletingCode !== null"
      :title="t('admin.invitation.delete')"
      :message="t('admin.invitation.deleteConfirm')"
      danger
      data-testid="confirm-invitation-delete"
      @confirm="deleteCode"
      @cancel="deletingCode = null"
    />
  </AppLayout>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  createInvitationCode,
  deleteInvitationCode,
  listInvitationCodes,
  listInvitationCodeUsages,
  updateInvitationCode,
  type InvitationCode,
  type InvitationCodeStatus,
  type InvitationCodeUsage,
} from '@/api/admin/invitationCodes'
import BaseDialog from '@/components/common/BaseDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import Pagination from '@/components/common/Pagination.vue'
import Icon from '@/components/icons/Icon.vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { useAppStore } from '@/stores/app'
import { extractApiErrorMessage } from '@/utils/apiError'
import { formatDateTime, formatDateTimeLocalInput } from '@/utils/format'

const { t } = useI18n()
const appStore = useAppStore()
const codes = ref<InvitationCode[]>([])
const loading = ref(false)
const creating = ref(false)
const updating = ref(false)
const showCreateDialog = ref(false)
const editingCode = ref<InvitationCode | null>(null)
const deletingCode = ref<InvitationCode | null>(null)
const usageCode = ref<InvitationCode | null>(null)
const usages = ref<InvitationCodeUsage[]>([])
const usagesLoading = ref(false)
const filters = reactive<{ search: string; status: '' | InvitationCodeStatus }>({
  search: '',
  status: '',
})
const pagination = reactive({ page: 1, pageSize: 20, total: 0 })
const usagePagination = reactive({ page: 1, pageSize: 20, total: 0 })
const createForm = reactive({ code: '', maxUses: 1, expiresAt: '', notes: '' })
const editForm = reactive({
  code: '',
  maxUses: 1,
  status: 'active' as InvitationCodeStatus,
  expiresAt: '',
  notes: '',
})

async function loadCodes(): Promise<void> {
  loading.value = true
  try {
    const result = await listInvitationCodes({
      page: pagination.page,
      page_size: pagination.pageSize,
      status: filters.status || undefined,
      search: filters.search || undefined,
    })
    codes.value = result.items || []
    pagination.total = result.total || 0
  } catch (error: unknown) {
    showError(error, 'admin.invitation.failedToLoad')
  } finally {
    loading.value = false
  }
}

function applyFilters(): void {
  pagination.page = 1
  void loadCodes()
}

function changePage(page: number): void {
  pagination.page = page
  void loadCodes()
}

function changePageSize(pageSize: number): void {
  pagination.pageSize = pageSize
  pagination.page = 1
  void loadCodes()
}

function openCreateDialog(): void {
  Object.assign(createForm, { code: '', maxUses: 1, expiresAt: '', notes: '' })
  showCreateDialog.value = true
}

async function createCode(): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    await createInvitationCode({
      code: createForm.code || undefined,
      max_uses: createForm.maxUses,
      expires_at: unixTimestamp(createForm.expiresAt, undefined),
      notes: createForm.notes || undefined,
    })
    appStore.showSuccess(t('admin.invitation.created'))
    showCreateDialog.value = false
    await loadCodes()
  } catch (error: unknown) {
    showError(error, 'admin.invitation.failedToCreate')
  } finally {
    creating.value = false
  }
}

function openEditDialog(code: InvitationCode): void {
  editingCode.value = code
  Object.assign(editForm, {
    code: code.code,
    maxUses: code.max_uses,
    status: code.status,
    expiresAt: code.expires_at
      ? formatDateTimeLocalInput(Math.floor(new Date(code.expires_at).getTime() / 1000))
      : '',
    notes: code.notes || '',
  })
}

async function updateCode(): Promise<void> {
  const current = editingCode.value
  if (!current || updating.value) return
  updating.value = true
  try {
    await updateInvitationCode(current.id, current.control_version, {
      code: editForm.code,
      max_uses: editForm.maxUses,
      status: editForm.status,
      expires_at: unixTimestamp(editForm.expiresAt, 0),
      notes: editForm.notes,
    })
    appStore.showSuccess(t('admin.invitation.updated'))
    editingCode.value = null
    await loadCodes()
  } catch (error: unknown) {
    showError(error, 'admin.invitation.failedToUpdate')
    if (isConflict(error)) {
      editingCode.value = null
      await loadCodes()
    }
  } finally {
    updating.value = false
  }
}

async function deleteCode(): Promise<void> {
  const current = deletingCode.value
  if (!current || current.used_count !== 0) return
  try {
    await deleteInvitationCode(current.id, current.control_version)
    appStore.showSuccess(t('admin.invitation.deleted'))
    deletingCode.value = null
    await loadCodes()
  } catch (error: unknown) {
    showError(error, 'admin.invitation.failedToDelete')
    if (isConflict(error)) await loadCodes()
  }
}

async function openUsages(code: InvitationCode): Promise<void> {
  usageCode.value = code
  usagePagination.page = 1
  await loadUsages()
}

async function loadUsages(): Promise<void> {
  if (!usageCode.value) return
  usagesLoading.value = true
  try {
    const result = await listInvitationCodeUsages(usageCode.value.id, {
      page: usagePagination.page,
      page_size: usagePagination.pageSize,
    })
    usages.value = result.items || []
    usagePagination.total = result.total || 0
  } catch (error: unknown) {
    showError(error, 'admin.invitation.failedToLoadUsages')
  } finally {
    usagesLoading.value = false
  }
}

function changeUsagePage(page: number): void {
  usagePagination.page = page
  void loadUsages()
}

async function copyRegistrationLink(code: InvitationCode): Promise<void> {
  const url = new URL('/register', window.location.origin)
  url.searchParams.set('invitation_code', code.code)
  try {
    await navigator.clipboard.writeText(url.toString())
    appStore.showSuccess(t('admin.invitation.linkCopied'))
  } catch (error: unknown) {
    showError(error, 'admin.invitation.failedToCopy')
  }
}

function unixTimestamp(value: string, empty: number | undefined): number | undefined {
  if (!value) return empty
  return Math.floor(new Date(value).getTime() / 1000)
}

function isExpired(code: InvitationCode): boolean {
  return code.expires_at !== null && new Date(code.expires_at).getTime() <= Date.now()
}

function statusLabel(code: InvitationCode): string {
  if (isExpired(code)) return t('admin.invitation.expired')
  if (code.used_count >= code.max_uses) return t('admin.invitation.exhausted')
  return t(`admin.invitation.${code.status}`)
}

function statusClass(code: InvitationCode): string {
  const base = 'badge'
  if (isExpired(code)) return `${base} badge-danger`
  if (code.status === 'active' && code.used_count < code.max_uses) return `${base} badge-success`
  return `${base} badge-gray`
}

function isConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object' &&
    ([409, 412] as unknown[]).includes((error as { status?: unknown }).status)
}

function showError(error: unknown, fallbackKey: string): void {
  appStore.showError(extractApiErrorMessage(error, t(fallbackKey)))
}

onMounted(() => {
  void loadCodes()
})
</script>
