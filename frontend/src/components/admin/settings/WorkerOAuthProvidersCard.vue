<template>
  <section class="card" data-testid="worker-oauth-providers-card">
    <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
            OAuth identity providers
          </h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Worker-native OAuth configuration. Client secrets are encrypted and never returned.
          </p>
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="loading || saving"
          data-testid="oauth-provider-reload"
          @click="reloadProviders"
        >
          Reload
        </button>
      </div>
    </div>

    <div class="space-y-5 p-6">
      <div v-if="loading" class="text-sm text-gray-500" data-testid="oauth-provider-loading">
        Loading OAuth providers…
      </div>

      <template v-else>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label class="input-label" for="worker-oauth-provider">Provider</label>
            <select
              id="worker-oauth-provider"
              v-model="selectedProvider"
              class="input"
              data-testid="oauth-provider-select"
              :disabled="saving"
              @change="selectProvider"
            >
              <option v-for="provider in ADMIN_OAUTH_PROVIDERS" :key="provider" :value="provider">
                {{ providerLabel(provider) }}{{ configuredProviders.has(provider) ? " — configured" : "" }}
              </option>
            </select>
          </div>
          <div>
            <label class="input-label">Adapter</label>
            <input :value="form.adapter" type="text" class="input bg-gray-50 font-mono dark:bg-dark-700" readonly />
          </div>
          <label class="flex items-center gap-3 self-end rounded-lg border border-gray-200 p-3 dark:border-dark-600">
            <input v-model="form.enabled" type="checkbox" data-testid="oauth-provider-enabled" />
            <span class="text-sm text-gray-700 dark:text-gray-300">Enable this provider</span>
          </label>
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label class="input-label" for="worker-oauth-client-id">Client ID</label>
            <input
              id="worker-oauth-client-id"
              v-model.trim="form.client_id"
              type="text"
              class="input font-mono"
              autocomplete="off"
              data-testid="oauth-provider-client-id"
            />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-client-secret">Client secret</label>
            <input
              id="worker-oauth-client-secret"
              v-model="clientSecret"
              type="password"
              class="input font-mono"
              autocomplete="new-password"
              data-testid="oauth-provider-client-secret"
              :placeholder="form.client_secret_configured ? 'Configured — leave blank to keep it' : 'Enter client secret'"
            />
          </div>
          <div class="md:col-span-2">
            <label class="input-label" for="worker-oauth-issuer">Issuer</label>
            <input id="worker-oauth-issuer" v-model.trim="form.issuer" type="text" class="input font-mono" />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-authorization-endpoint">Authorization endpoint</label>
            <input id="worker-oauth-authorization-endpoint" v-model.trim="form.authorization_endpoint" type="url" class="input font-mono" />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-token-endpoint">Token endpoint</label>
            <input id="worker-oauth-token-endpoint" v-model.trim="form.token_endpoint" type="url" class="input font-mono" />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-userinfo-endpoint">UserInfo endpoint</label>
            <input id="worker-oauth-userinfo-endpoint" v-model.trim="form.userinfo_endpoint" type="url" class="input font-mono" />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-emails-endpoint">Emails endpoint (optional)</label>
            <input id="worker-oauth-emails-endpoint" v-model.trim="form.emails_endpoint" type="url" class="input font-mono" />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-jwks-endpoint">JWKS endpoint {{ selectedProvider === "oidc" ? "(required)" : "(optional)" }}</label>
            <input id="worker-oauth-jwks-endpoint" v-model.trim="form.jwks_endpoint" type="url" class="input font-mono" />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-frontend-callback">Frontend callback path</label>
            <input id="worker-oauth-frontend-callback" v-model.trim="form.frontend_callback_path" type="text" class="input font-mono" />
          </div>
          <div>
            <label class="input-label" for="worker-oauth-scopes">Scopes</label>
            <textarea
              id="worker-oauth-scopes"
              v-model="scopesText"
              rows="3"
              class="input font-mono"
              placeholder="openid email profile"
              data-testid="oauth-provider-scopes"
            ></textarea>
            <p class="mt-1 text-xs text-gray-500">Separate scopes with spaces, commas, or new lines.</p>
          </div>
          <div>
            <label class="input-label" for="worker-oauth-allowed-hosts">Allowed upstream hosts</label>
            <textarea
              id="worker-oauth-allowed-hosts"
              v-model="allowedHostsText"
              rows="3"
              class="input font-mono"
              placeholder="accounts.example.com"
              data-testid="oauth-provider-allowed-hosts"
            ></textarea>
            <p class="mt-1 text-xs text-gray-500">Exact HTTPS host names only, one per line.</p>
          </div>
          <label class="flex items-center gap-3 rounded-lg border border-gray-200 p-3 dark:border-dark-600 md:col-span-2">
            <input v-model="form.pkce_enabled" type="checkbox" />
            <span class="text-sm text-gray-700 dark:text-gray-300">Use PKCE</span>
          </label>
        </div>

        <div
          v-if="errorMessage"
          class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          role="alert"
          data-testid="oauth-provider-error"
        >
          {{ errorMessage }}
        </div>
        <div
          v-else-if="successMessage"
          class="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
          aria-live="polite"
          data-testid="oauth-provider-success"
        >
          {{ successMessage }}
        </div>

        <div class="flex flex-wrap justify-end gap-3">
          <button
            v-if="currentConfig?.enabled"
            type="button"
            class="btn btn-secondary"
            :disabled="saving"
            data-testid="oauth-provider-disable"
            @click="disableProvider"
          >
            Disable
          </button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="saving"
            data-testid="oauth-provider-save"
            @click="saveProvider"
          >
            {{ saving ? "Saving…" : currentConfig ? "Update provider" : "Create provider" }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { adminAPI } from '@/api'
import {
  ADMIN_OAUTH_PROVIDERS,
  type AdminOAuthAdapter,
  type AdminOAuthProvider,
  type AdminOAuthProviderConfig,
  type UpsertAdminOAuthProviderInput,
} from '@/api/admin/oauthProviders'

interface OAuthProviderForm {
  adapter: AdminOAuthAdapter
  enabled: boolean
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  emails_endpoint: string
  jwks_endpoint: string
  client_id: string
  client_secret_configured: boolean
  frontend_callback_path: string
  pkce_enabled: boolean
}

const providerAdapters: Record<AdminOAuthProvider, AdminOAuthAdapter> = {
  github: 'github',
  google: 'standard',
  linuxdo: 'standard',
  dingtalk: 'dingtalk',
  wechat: 'wechat',
  oidc: 'oidc',
}

const providerDefaults: Record<AdminOAuthProvider, Omit<OAuthProviderForm, 'client_secret_configured'>> = {
  github: {
    adapter: 'github', enabled: false, issuer: 'github',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
    userinfo_endpoint: 'https://api.github.com/user',
    emails_endpoint: 'https://api.github.com/user/emails', jwks_endpoint: '', client_id: '',
    frontend_callback_path: '/auth/oauth/callback', pkce_enabled: true,
  },
  google: {
    adapter: 'standard', enabled: false, issuer: 'google',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    emails_endpoint: '', jwks_endpoint: '', client_id: '',
    frontend_callback_path: '/auth/oauth/callback', pkce_enabled: true,
  },
  linuxdo: {
    adapter: 'standard', enabled: false, issuer: 'linuxdo',
    authorization_endpoint: 'https://connect.linux.do/oauth2/authorize',
    token_endpoint: 'https://connect.linux.do/oauth2/token',
    userinfo_endpoint: 'https://connect.linux.do/api/user',
    emails_endpoint: '', jwks_endpoint: '', client_id: '',
    frontend_callback_path: '/auth/linuxdo/callback', pkce_enabled: true,
  },
  dingtalk: {
    adapter: 'dingtalk', enabled: false, issuer: 'dingtalk',
    authorization_endpoint: 'https://login.dingtalk.com/oauth2/auth',
    token_endpoint: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    userinfo_endpoint: 'https://api.dingtalk.com/v1.0/contact/users/me',
    emails_endpoint: '', jwks_endpoint: '', client_id: '',
    frontend_callback_path: '/auth/dingtalk/callback', pkce_enabled: true,
  },
  wechat: {
    adapter: 'wechat', enabled: false, issuer: 'wechat',
    authorization_endpoint: 'https://open.weixin.qq.com/connect/qrconnect',
    token_endpoint: 'https://api.weixin.qq.com/sns/oauth2/access_token',
    userinfo_endpoint: 'https://api.weixin.qq.com/sns/userinfo',
    emails_endpoint: '', jwks_endpoint: '', client_id: '',
    frontend_callback_path: '/auth/wechat/callback', pkce_enabled: false,
  },
  oidc: {
    adapter: 'oidc', enabled: false, issuer: '', authorization_endpoint: '', token_endpoint: '',
    userinfo_endpoint: '', emails_endpoint: '', jwks_endpoint: '', client_id: '',
    frontend_callback_path: '/auth/oidc/callback', pkce_enabled: true,
  },
}

const providerScopes: Record<AdminOAuthProvider, string[]> = {
  github: ['read:user', 'user:email'],
  google: ['openid', 'email', 'profile'],
  linuxdo: ['user'],
  dingtalk: ['openid'],
  wechat: ['snsapi_login'],
  oidc: ['openid', 'email', 'profile'],
}

const loading = ref(true)
const saving = ref(false)
const selectedProvider = ref<AdminOAuthProvider>('github')
const providers = ref<AdminOAuthProviderConfig[]>([])
const clientSecret = ref('')
const scopesText = ref('')
const allowedHostsText = ref('')
const errorMessage = ref('')
const successMessage = ref('')
const form = reactive<OAuthProviderForm>({
  ...providerDefaults.github,
  client_secret_configured: false,
})

const configuredProviders = computed(() => new Set(providers.value.map((provider) => provider.provider)))
const currentConfig = computed(() => (
  providers.value.find((provider) => provider.provider === selectedProvider.value) ?? null
))

function providerLabel(provider: AdminOAuthProvider): string {
  return ({
    github: 'GitHub', google: 'Google', linuxdo: 'Linux DO', dingtalk: 'DingTalk',
    wechat: 'WeChat', oidc: 'OIDC',
  })[provider]
}

function splitValues(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]
}

function hostsFromDefaults(provider: AdminOAuthProvider): string[] {
  const defaults = providerDefaults[provider]
  return [...new Set([
    defaults.authorization_endpoint,
    defaults.token_endpoint,
    defaults.userinfo_endpoint,
    defaults.emails_endpoint,
    defaults.jwks_endpoint,
  ].filter(Boolean).map((endpoint) => new URL(endpoint).hostname))]
}

function showConfig(config: AdminOAuthProviderConfig): void {
  Object.assign(form, {
    adapter: config.adapter,
    enabled: config.enabled,
    issuer: config.issuer,
    authorization_endpoint: config.authorization_endpoint,
    token_endpoint: config.token_endpoint,
    userinfo_endpoint: config.userinfo_endpoint,
    emails_endpoint: config.emails_endpoint ?? '',
    jwks_endpoint: config.jwks_endpoint ?? '',
    client_id: config.client_id,
    client_secret_configured: config.client_secret_configured,
    frontend_callback_path: config.frontend_callback_path,
    pkce_enabled: config.pkce_enabled,
  })
  scopesText.value = config.scopes.join(' ')
  allowedHostsText.value = config.allowed_hosts.join('\n')
  clientSecret.value = ''
}

function showDefaults(provider: AdminOAuthProvider): void {
  Object.assign(form, providerDefaults[provider], {
    adapter: providerAdapters[provider],
    client_secret_configured: false,
  })
  scopesText.value = providerScopes[provider].join(' ')
  allowedHostsText.value = hostsFromDefaults(provider).join('\n')
  clientSecret.value = ''
}

function replaceProvider(config: AdminOAuthProviderConfig): void {
  const next = providers.value.filter((item) => item.provider !== config.provider)
  next.push(config)
  providers.value = next
  showConfig(config)
}

function readableError(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown }
    const code = typeof value.code === 'string' ? value.code : ''
    const message = typeof value.message === 'string' ? value.message : 'OAuth provider request failed'
    return code ? `${message} (${code})` : message
  }
  return 'OAuth provider request failed'
}

async function loadSelectedProvider(): Promise<void> {
  errorMessage.value = ''
  successMessage.value = ''
  clientSecret.value = ''
  const existing = currentConfig.value
  if (existing === null) {
    showDefaults(selectedProvider.value)
    return
  }
  try {
    showConfig(await adminAPI.oauthProviders.get(selectedProvider.value))
  } catch (error) {
    errorMessage.value = readableError(error)
    showConfig(existing)
  }
}

async function selectProvider(): Promise<void> {
  await loadSelectedProvider()
}

async function reloadProviders(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  clientSecret.value = ''
  try {
    const result = await adminAPI.oauthProviders.list()
    providers.value = result.items
    await loadSelectedProvider()
  } catch (error) {
    errorMessage.value = readableError(error)
    showDefaults(selectedProvider.value)
  } finally {
    loading.value = false
  }
}

async function saveProvider(): Promise<void> {
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload: UpsertAdminOAuthProviderInput<AdminOAuthProvider> = {
      adapter: providerAdapters[selectedProvider.value],
      enabled: form.enabled,
      issuer: form.issuer,
      authorization_endpoint: form.authorization_endpoint,
      token_endpoint: form.token_endpoint,
      userinfo_endpoint: form.userinfo_endpoint,
      emails_endpoint: form.emails_endpoint || null,
      jwks_endpoint: form.jwks_endpoint || null,
      client_id: form.client_id,
      ...(clientSecret.value ? { client_secret: clientSecret.value } : {}),
      scopes: splitValues(scopesText.value),
      allowed_hosts: splitValues(allowedHostsText.value).map((host) => host.toLowerCase()),
      frontend_callback_path: form.frontend_callback_path,
      pkce_enabled: form.pkce_enabled,
    }
    const saved = await adminAPI.oauthProviders.upsert(selectedProvider.value, payload, {
      expectedControlVersion: currentConfig.value?.control_version ?? 0,
    })
    replaceProvider(saved)
    successMessage.value = `${providerLabel(selectedProvider.value)} provider saved.`
  } catch (error) {
    errorMessage.value = readableError(error)
  } finally {
    saving.value = false
  }
}

async function disableProvider(): Promise<void> {
  const existing = currentConfig.value
  if (existing === null) return
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const disabled = await adminAPI.oauthProviders.disable(selectedProvider.value, {
      expectedControlVersion: existing.control_version,
    })
    replaceProvider(disabled)
    successMessage.value = `${providerLabel(selectedProvider.value)} provider disabled.`
  } catch (error) {
    errorMessage.value = readableError(error)
  } finally {
    saving.value = false
  }
}

onMounted(reloadProviders)
</script>
