import { computed, ref } from 'vue'
import { keysAPI } from '@/api/keys'
import { userGroupsAPI, type AvailableUserGroup } from '@/api/groups'
import { useAuthStore } from '@/stores/auth'
import type { ApiKey } from '@/types'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import { hasPlaintextApiKey } from '@/utils/apiKeySecret'

const loaded = ref(false)
const loading = ref(false)
const hasAllowedBatchImageKey = ref(false)
let pendingLoad: Promise<boolean> | null = null
const pageSize = 100

export function keyAllowsBatchImage(
  key: ApiKey,
  availableGroups: readonly AvailableUserGroup[] = [],
): boolean {
  const group = availableGroups.find(item => String(item.id) === String(key.group_id))
  return (
    key.status === 'active' &&
    (isCloudflareWorkerContractActive() || hasPlaintextApiKey(key)) &&
    group?.status === 'active' &&
    group.platform === 'gemini' &&
    group.allow_batch_image_generation === true
  )
}

async function loadBatchImageAccess(force = false): Promise<boolean> {
  const authStore = useAuthStore()
  if (!authStore.isAuthenticated) {
    loaded.value = true
    hasAllowedBatchImageKey.value = false
    return false
  }

  if (loaded.value && !force) {
    return hasAllowedBatchImageKey.value
  }

  if (pendingLoad && !force) {
    return pendingLoad
  }

  loading.value = true
  pendingLoad = (async () => {
    const availableGroups = await userGroupsAPI.getAvailable()
    let page = 1
    while (true) {
      const response = await keysAPI.list(page, pageSize, {
        status: 'active',
        sort_by: 'created_at',
        sort_order: 'desc'
      })

      if ((response.items || []).some(key => keyAllowsBatchImage(key, availableGroups))) {
        hasAllowedBatchImageKey.value = true
        loaded.value = true
        return true
      }

      if (page >= response.pages || (response.items || []).length === 0) {
        hasAllowedBatchImageKey.value = false
        loaded.value = true
        return false
      }

      page += 1
    }
  })()
    .catch(() => {
      hasAllowedBatchImageKey.value = false
      loaded.value = true
      return false
    })
    .finally(() => {
      loading.value = false
      pendingLoad = null
    })

  return pendingLoad
}

export function useBatchImageAccess() {
  const canUseBatchImage = computed(() => hasAllowedBatchImageKey.value)

  return {
    canUseBatchImage,
    batchImageAccessLoaded: computed(() => loaded.value),
    batchImageAccessLoading: computed(() => loading.value),
    refreshBatchImageAccess: loadBatchImageAccess,
  }
}
