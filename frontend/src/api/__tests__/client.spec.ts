import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios from 'axios'
import type { AxiosInstance } from 'axios'

// 需要在导入 client 之前设置 mock
vi.mock('@/i18n', () => ({
  getLocale: () => 'zh-CN',
}))

describe('API Client', () => {
  let apiClient: AxiosInstance

  beforeEach(async () => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    // 每次测试重新导入以获取干净的模块状态
    vi.resetModules()
    const mod = await import('@/api/client')
    apiClient = mod.apiClient
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // --- 请求拦截器 ---

  describe('请求拦截器', () => {
    it('规范化相对 API base，避免在回调页拼出相对 v1 路径', async () => {
      vi.resetModules()
      vi.stubEnv('VITE_API_BASE_URL', 'api/v1')

      const mod = await import('@/api/client')

      expect(mod.apiClient.defaults.baseURL).toBe('/api/v1')
      expect(mod.buildApiUrl('/auth/oauth/github/callback?code=abc')).toBe(
        '/api/v1/auth/oauth/github/callback?code=abc'
      )
    })

    it('自动附加 Authorization 头', async () => {
      localStorage.setItem('auth_token', 'my-jwt-token')

      // 拦截实际请求
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/test')

      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('Authorization')).toBe('Bearer my-jwt-token')
    })

    it('无 token 时不附加 Authorization 头', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/test')

      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('Authorization')).toBeFalsy()
    })

    it('GET 请求自动附加 timezone 参数', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/test')

      const config = adapter.mock.calls[0][0]
      expect(config.params).toHaveProperty('timezone')
    })

    it('POST 请求不附加 timezone 参数', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.post('/test', { foo: 'bar' })

      const config = adapter.mock.calls[0][0]
      expect(config.params?.timezone).toBeUndefined()
    })

    it('请求默认带 withCredentials 以支持跨域 cookie', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.post('/auth/oauth/bind-token')

      const config = adapter.mock.calls[0][0]
      expect(config.withCredentials).toBe(true)
    })

    it('Admin API 在进入管理页面前也带 Admin UI 标记', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/admin/users')

      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-Admin-UI-Request')).toBe('1')
    })

    it('管理页面调用共享 API 时带 Admin UI 标记', async () => {
      window.history.replaceState({}, '', '/admin/dashboard')
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/groups/available')

      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-Admin-UI-Request')).toBe('1')
    })

    it('普通用户页面调用共享 API 时不带 Admin UI 标记', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/groups/available')

      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-Admin-UI-Request')).toBeFalsy()
    })

    it('用户侧 timing API 自动带 User UI 标记', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/auth/me')

      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-User-UI-Request')).toBe('1')
      expect(config.headers.get('X-Admin-UI-Request')).toBeFalsy()
    })

    it('支付用户 API 带 User UI 标记，公开支付 API 不带', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/payment/plans')
      expect(adapter.mock.calls[0][0].headers.get('X-User-UI-Request')).toBe('1')

      await apiClient.post('/payment/public/orders/verify', {})
      expect(adapter.mock.calls[1][0].headers.get('X-User-UI-Request')).toBeFalsy()
    })

    it('管理页调用共享 API 时同时带 Admin 与 User UI 标记', async () => {
      window.history.replaceState({}, '', '/admin/dashboard')
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: {} },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await apiClient.get('/keys')

      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-Admin-UI-Request')).toBe('1')
      expect(config.headers.get('X-User-UI-Request')).toBe('1')
    })
  })

  // --- 响应拦截器 ---

  describe('响应拦截器', () => {
    it('code=0 时解包 data 字段', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 0, data: { name: 'test' }, message: 'ok' },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      const response = await apiClient.get('/test')
      expect(response.data).toEqual({ name: 'test' })
    })

    it('code!=0 时拒绝并返回结构化错误', async () => {
      const adapter = vi.fn().mockResolvedValue({
        status: 200,
        data: { code: 1001, message: '参数错误', data: null },
        headers: {},
        config: {},
        statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter

      await expect(apiClient.get('/test')).rejects.toEqual(
        expect.objectContaining({
          code: 1001,
          message: '参数错误',
        })
      )
    })

    it('将 Worker 嵌套错误 envelope 提升为可识别的语义错误', async () => {
      const adapter = vi.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            error: {
              code: 'STEP_UP_TOTP_NOT_ENABLED',
              message: 'Enable TOTP first',
              type: 'permission_error',
            },
          },
        },
        config: { method: 'post', url: '/admin/users', headers: {} },
        code: 'ERR_BAD_REQUEST',
        message: 'Request failed with status code 403',
      })
      apiClient.defaults.adapter = adapter

      await expect(apiClient.post('/admin/users', {})).rejects.toMatchObject({
        status: 403,
        code: 'STEP_UP_TOTP_NOT_ENABLED',
        message: 'Enable TOTP first',
      })
    })

    it('全局 step-up 成功后只重放一次任意管理写请求', async () => {
      const { registerAdminStepUpPrompt } = await import('@/api/adminStepUpRecovery')
      const prompt = vi.fn().mockResolvedValue(true)
      const unregister = registerAdminStepUpPrompt(prompt)
      const adapter = vi.fn()
        .mockRejectedValueOnce({
          response: {
            status: 403,
            data: {
              error: {
                code: 'STEP_UP_REQUIRED',
                message: 'Recent TOTP verification is required',
              },
            },
          },
          config: { method: 'delete', url: '/admin/accounts/account-1', headers: {} },
          code: 'ERR_BAD_REQUEST',
          message: 'Request failed with status code 403',
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { code: 0, data: { deleted: true } },
          headers: {},
          config: {},
          statusText: 'OK',
        })
      apiClient.defaults.adapter = adapter

      try {
        await expect(apiClient.delete('/admin/accounts/account-1')).resolves.toMatchObject({
          data: { deleted: true },
        })
      } finally {
        unregister()
      }

      expect(prompt).toHaveBeenCalledOnce()
      expect(adapter).toHaveBeenCalledTimes(2)
    })

    it('全局 step-up 被取消后返回取消标记且不重放请求', async () => {
      const { registerAdminStepUpPrompt } = await import('@/api/adminStepUpRecovery')
      const unregister = registerAdminStepUpPrompt(vi.fn().mockResolvedValue(false))
      const adapter = vi.fn().mockRejectedValue({
        response: {
          status: 403,
          data: { error: { code: 'STEP_UP_REQUIRED', message: 'TOTP required' } },
        },
        config: { method: 'post', url: '/admin/accounts/account-1/test', headers: {} },
        code: 'ERR_BAD_REQUEST',
        message: 'Request failed with status code 403',
      })
      apiClient.defaults.adapter = adapter

      try {
        await expect(apiClient.post('/admin/accounts/account-1/test')).rejects.toMatchObject({
          code: 'STEP_UP_CANCELLED',
        })
      } finally {
        unregister()
      }
      expect(adapter).toHaveBeenCalledOnce()
    })

    it('部署与运营合规未确认时广播事件且保留登录态', async () => {
      localStorage.setItem('auth_token', 'admin-token')
      const listener = vi.fn()
      window.addEventListener('admin-compliance-required', listener)

      const adapter = vi.fn().mockRejectedValue({
        response: {
          status: 423,
          data: {
            code: 'ADMIN_COMPLIANCE_ACK_REQUIRED',
            message: 'administrator compliance acknowledgement is required',
            metadata: {
              version: 'v2026.06.10',
              document_path_zh: 'docs/legal/admin-compliance.zh.md',
              document_path_en: 'docs/legal/admin-compliance.en.md',
            },
          },
        },
        config: {
          url: '/admin/users',
          headers: { Authorization: 'Bearer admin-token' },
        },
        code: 'ERR_BAD_REQUEST',
      })
      apiClient.defaults.adapter = adapter

      await expect(apiClient.get('/admin/users')).rejects.toEqual(
        expect.objectContaining({
          status: 423,
          code: 'ADMIN_COMPLIANCE_ACK_REQUIRED',
          metadata: expect.objectContaining({
            version: 'v2026.06.10',
          }),
        })
      )

      expect(listener).toHaveBeenCalledTimes(1)
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(
        expect.objectContaining({
          version: 'v2026.06.10',
        })
      )
      expect(localStorage.getItem('auth_token')).toBe('admin-token')

      window.removeEventListener('admin-compliance-required', listener)
    })
  })

  // --- 401 Token 刷新 ---

  describe('401 Token 刷新', () => {
    it('无 refresh_token 时 401 清除 localStorage', async () => {
      localStorage.setItem('auth_token', 'expired-token')
      // 不设置 refresh_token

      // Mock window.location
      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, pathname: '/dashboard', href: '/dashboard' },
        writable: true,
      })

      const adapter = vi.fn().mockRejectedValue({
        response: {
          status: 401,
          data: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
        },
        config: {
          url: '/test',
          headers: { Authorization: 'Bearer expired-token' },
        },
        code: 'ERR_BAD_REQUEST',
      })
      apiClient.defaults.adapter = adapter

      await expect(apiClient.get('/test')).rejects.toBeDefined()

      expect(localStorage.getItem('auth_token')).toBeNull()

      // 恢复 location
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      })
    })

    it('有 refresh_token 时刷新并重试原请求', async () => {
      localStorage.setItem('auth_token', 'expired-token')
      localStorage.setItem('refresh_token', 'refresh-token')
      localStorage.setItem('token_expires_at', String(Date.now() - 1))
      localStorage.setItem('auth_user', JSON.stringify({ id: 7 }))

      const adapter = vi.fn()
        .mockRejectedValueOnce({
          response: {
            status: 401,
            data: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
          },
          config: {
            url: '/test',
            headers: { Authorization: 'Bearer expired-token' },
          },
          code: 'ERR_BAD_REQUEST',
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { code: 0, data: { ok: true } },
          headers: {},
          config: {},
          statusText: 'OK',
        })
      apiClient.defaults.adapter = adapter
      vi.spyOn(axios, 'post').mockResolvedValueOnce({
        data: {
          code: 0,
          message: 'ok',
          data: {
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
      })

      await expect(apiClient.get('/test')).resolves.toMatchObject({ data: { ok: true } })

      expect(adapter).toHaveBeenCalledTimes(2)
      expect(localStorage.getItem('auth_token')).toBe('new-token')
      expect(localStorage.getItem('refresh_token')).toBe('new-refresh-token')
      expect(adapter.mock.calls[1][0].headers.get('Authorization')).toBe('Bearer new-token')
    })

    it('请求发出后换号且旧请求才返回401时不以新用户身份重试', async () => {
      localStorage.setItem('auth_token', 'user-a-access')
      localStorage.setItem('refresh_token', 'user-a-refresh')
      localStorage.setItem('auth_user', JSON.stringify({ id: '4d5f1031-a954-434e-9631-862b3dbb5531' }))
      let rejectOriginal!: () => void
      const adapter = vi.fn().mockImplementationOnce((config) => new Promise((_resolve, reject) => {
        rejectOriginal = () => reject({
          response: { status: 401, data: { code: 'invalid_access_token' } },
          config,
          code: 'ERR_BAD_REQUEST',
        })
      })).mockResolvedValue({
        status: 200, data: { code: 0, data: { deleted: true } }, headers: {}, config: {}, statusText: 'OK',
      })
      apiClient.defaults.adapter = adapter
      const refresh = vi.spyOn(axios, 'post')
      const pending = apiClient.delete('/user/resource')
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
      localStorage.setItem('auth_token', 'user-b-access')
      localStorage.setItem('refresh_token', 'user-b-refresh')
      localStorage.setItem('auth_user', JSON.stringify({ id: '05ff44e5-0e0c-4d15-ae85-a6fa839fd1f4' }))
      localStorage.setItem('token_expires_at', String(Date.now() + 3600_000))
      rejectOriginal()
      await expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' })
      expect(adapter).toHaveBeenCalledTimes(1)
      expect(refresh).not.toHaveBeenCalled()
      expect(localStorage.getItem('auth_token')).toBe('user-b-access')
    })

    it('刷新期间换号时旧请求不会清除新会话', async () => {
      localStorage.setItem('auth_token', 'user-a-access')
      localStorage.setItem('refresh_token', 'user-a-refresh')
      localStorage.setItem('token_expires_at', String(Date.now() - 1))
      localStorage.setItem('auth_user', JSON.stringify({ id: 7 }))

      apiClient.defaults.adapter = vi.fn().mockRejectedValueOnce({
        response: {
          status: 401,
          data: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
        },
        config: {
          url: '/test',
          headers: { Authorization: 'Bearer user-a-access' },
        },
        code: 'ERR_BAD_REQUEST',
      })

      let rejectRefresh!: (reason: Error) => void
      vi.spyOn(axios, 'post').mockImplementationOnce(
        () => new Promise((_resolve, reject) => {
          rejectRefresh = reject
        })
      )

      const staleRequest = apiClient.get('/test')
      await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))

      localStorage.setItem('auth_token', 'user-b-access')
      localStorage.setItem('refresh_token', 'user-b-refresh')
      localStorage.setItem('token_expires_at', String(Date.now() + 3600_000))
      localStorage.setItem('auth_user', JSON.stringify({ id: 8 }))
      rejectRefresh(new Error('stale refresh failed'))

      await expect(staleRequest).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' })
      expect(localStorage.getItem('auth_token')).toBe('user-b-access')
      expect(localStorage.getItem('refresh_token')).toBe('user-b-refresh')
      expect(localStorage.getItem('auth_user')).toBe(JSON.stringify({ id: 8 }))
      expect(window.location.pathname).toBe('/')
    })
  })

  // --- 网络错误 ---

  describe('网络错误', () => {
    it('网络错误返回 status 0 的错误', async () => {
      const adapter = vi.fn().mockRejectedValue({
        code: 'ERR_NETWORK',
        message: 'Network Error',
        config: { url: '/test' },
        // 没有 response
      })
      apiClient.defaults.adapter = adapter

      await expect(apiClient.get('/test')).rejects.toEqual(
        expect.objectContaining({
          status: 0,
          message: 'Network error. Please check your connection.',
        })
      )
    })
  })

  // --- 请求取消 ---

  describe('请求取消', () => {
    it('取消的请求保持原始取消错误', async () => {
      const source = axios.CancelToken.source()

      const adapter = vi.fn().mockRejectedValue(
        new axios.Cancel('Operation canceled')
      )
      apiClient.defaults.adapter = adapter

      await expect(
        apiClient.get('/test', { cancelToken: source.token })
      ).rejects.toBeDefined()
    })
  })
})
