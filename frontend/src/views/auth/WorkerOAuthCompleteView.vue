<template>
  <main class="min-h-screen bg-gray-50 px-4 py-12 dark:bg-dark-900">
    <section class="card mx-auto max-w-md space-y-5 p-6">
      <h1 class="text-xl font-semibold">{{ t('auth.createAccount') }}</h1>
      <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
      <PendingOAuthCreateAccountForm v-if="loaded" :initial-email="email" test-id-prefix="worker-oauth" :is-submitting="saving" :force-email-verification="true" :proof-already-verified="true" @submit="complete" @switch-to-bind="router.push('/login')" />
      <router-link to="/login" class="text-sm text-primary-600">{{ t('auth.backToLogin') }}</router-link>
    </section>
  </main>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import PendingOAuthCreateAccountForm, { type PendingOAuthCreateAccountPayload } from '@/components/auth/PendingOAuthCreateAccountForm.vue'
import { apiClient } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { persistOAuthTokenContext } from '@/api/auth'
const router = useRouter(), { t } = useI18n(), auth = useAuthStore()
const email = ref(''), loaded = ref(false), saving = ref(false), error = ref('')
function message(value: unknown): string { return (value as { message?: string })?.message || t('auth.loginFailed') }
onMounted(async () => {
  try { const { data } = await apiClient.post('/auth/oauth/pending/exchange', {}); email.value = data.email || ''; loaded.value = true } catch (value) { error.value = message(value) }
})
async function complete(payload: PendingOAuthCreateAccountPayload) {
  saving.value = true; error.value = ''
  try {
    const { data } = await apiClient.post('/auth/oauth/pending/create-account', { email: payload.email, password: payload.password, verify_code: payload.verifyCode, invitation_code: payload.invitationCode })
    persistOAuthTokenContext(data)
    await auth.setToken(data.access_token)
    const target = typeof data.redirect === 'string' && data.redirect.startsWith('/') && !data.redirect.startsWith('//') ? data.redirect : '/dashboard'
    await router.replace(target)
  } catch (value) { error.value = message(value) } finally { saving.value = false }
}
</script>
