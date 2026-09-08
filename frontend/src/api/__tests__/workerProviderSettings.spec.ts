import { beforeEach, describe, expect, it, vi } from 'vitest'
const { get, put, list, upsert, getQuotas, putQuotas } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), list: vi.fn(), upsert: vi.fn(), getQuotas: vi.fn(), putQuotas: vi.fn() }))
vi.mock('@/api/admin/platformQuotas', () => ({ getPlatformQuotaDefaults: getQuotas, updatePlatformQuotaDefaults: putQuotas }))
vi.mock('@/api/client', () => ({ apiClient: { get, put } }))
vi.mock('@/api/admin/oauthProviders', () => ({ ADMIN_OAUTH_PROVIDERS: ['github', 'google', 'linuxdo', 'dingtalk', 'wechat', 'oidc'], list, upsert }))
const smtp = { control_version: 7, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_username: 'sender', smtp_from_email: 'sender@example.test', smtp_from_name: 'Mail', smtp_use_tls: true, smtp_password_configured: true }
const github = { schema_version: 1, control_version: 4, provider: 'github', adapter: 'github', enabled: true, issuer: 'github', authorization_endpoint: 'https://github.com/login/oauth/authorize', token_endpoint: 'https://github.com/login/oauth/access_token', userinfo_endpoint: 'https://api.github.com/user', emails_endpoint: 'https://api.github.com/user/emails', jwks_endpoint: null, client_id: 'client-public', client_secret_configured: true, scopes: ['read:user', 'user:email'], allowed_hosts: ['github.com', 'api.github.com'], frontend_callback_path: '/auth/github/callback', pkce_enabled: true, created_at_ms: 1, updated_at_ms: 1 }
describe('Worker settings provider bridge', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); getQuotas.mockResolvedValue({ control_version: 3, platform_quotas: { openai: { daily_limit_usd: 5, weekly_limit_usd: null, monthly_limit_usd: null } } }); putQuotas.mockResolvedValue({ control_version: 4 }); get.mockResolvedValue({ data: smtp }); list.mockResolvedValue({ items: [github], total: 1 }); put.mockResolvedValue({ data: { ...smtp, control_version: 8 } }); upsert.mockResolvedValue({ ...github, control_version: 5 }) })
  it('hydrates real provider and mail settings without overwriting the main settings version', async () => {
    const bridge = await import('@/api/admin/workerProviderSettings')
    const values = await bridge.getWorkerProviderSettings()
    expect(values).toMatchObject({ smtp_host: smtp.smtp_host, smtp_password_configured: true, github_oauth_enabled: true, github_oauth_client_id: 'client-public', github_oauth_client_secret_configured: true, google_oauth_enabled: false })
    expect(values).not.toHaveProperty('control_version')
    expect(values).not.toHaveProperty('smtp_password')
    await bridge.saveWorkerProviderSettings(values)
    expect(put).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })
  it('preserves independent WeChat mode credentials and skips an unchanged save', async () => {
    const provider = { ...github, provider: 'wechat', adapter: 'wechat', issuer: 'wechat', client_id: 'open-app', authorization_endpoint: 'https://open.weixin.qq.com/connect/qrconnect', token_endpoint: 'https://api.weixin.qq.com/sns/oauth2/access_token', userinfo_endpoint: 'https://api.weixin.qq.com/sns/userinfo', emails_endpoint: null, scopes: ['snsapi_login'], allowed_hosts: ['open.weixin.qq.com', 'api.weixin.qq.com'], frontend_callback_path: '/auth/wechat/callback', pkce_enabled: false, wechat_variants: { open: { enabled: true, client_id: 'open-app', client_secret_configured: true }, mp: { enabled: true, client_id: 'mp-app', client_secret_configured: true } } }
    list.mockResolvedValue({ items: [provider] })
    const bridge = await import('@/api/admin/workerProviderSettings')
    const values = await bridge.getWorkerProviderSettings()
    expect(values.wechat_connect_mp_app_id).toBe('mp-app')
    await bridge.saveWorkerProviderSettings(values)
    expect(upsert).not.toHaveBeenCalled()
    upsert.mockResolvedValue({ ...provider, control_version: 5 })
    await bridge.saveWorkerProviderSettings({ ...values, wechat_connect_mp_app_id: 'new-mp' })
    expect(upsert).toHaveBeenCalledWith('wechat', expect.objectContaining({ wechat_variants: expect.objectContaining({ mp: { enabled: true, client_id: 'new-mp' } }) }), { expectedControlVersion: 4 })
  })
  it('maps system quota units to the real defaults endpoint and preserves its version', async () => {
    const bridge = await import('@/api/admin/workerProviderSettings')
    const values = await bridge.getWorkerProviderSettings()
    expect(values.default_platform_quotas?.openai?.daily).toBe(5)
    await bridge.saveWorkerProviderSettings({ ...values, default_platform_quotas: { openai: { daily: 7, weekly: '', monthly: null } } })
    expect(putQuotas).toHaveBeenCalledWith(expect.objectContaining({ openai: { daily_limit_usd: 7, weekly_limit_usd: null, monthly_limit_usd: null } }), 3)
  })
  it('uses independent version checks and retains existing credentials when password fields are blank', async () => {
    const bridge = await import('@/api/admin/workerProviderSettings')
    const values = await bridge.getWorkerProviderSettings()
    await bridge.saveWorkerProviderSettings({ ...values, smtp_host: 'new.example.test', smtp_password: '', github_oauth_client_id: 'new-client', github_oauth_client_secret: '' })
    expect(put).toHaveBeenCalledWith('/admin/settings/email-delivery', expect.objectContaining({ smtp_host: 'new.example.test' }), { headers: { 'If-Match': '"7"' } })
    expect(put.mock.calls[0][1]).not.toHaveProperty('smtp_password')
    expect(upsert).toHaveBeenCalledWith('github', expect.objectContaining({ client_id: 'new-client', enabled: true }), { expectedControlVersion: 4 })
    expect(upsert.mock.calls[0][1]).not.toHaveProperty('client_secret')
  })
})
