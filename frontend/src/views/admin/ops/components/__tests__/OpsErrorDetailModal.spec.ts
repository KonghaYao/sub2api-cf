import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OpsErrorDetailModal from '../OpsErrorDetailModal.vue'

const mocks = vi.hoisted(() => ({
  getErrorDetail: vi.fn(),
  listRequestErrorUpstreamErrors: vi.fn(),
  updateErrorResolution: vi.fn()
}))

vi.mock('@/api/admin/ops', () => ({
  opsAPI: {
    getErrorDetail: mocks.getErrorDetail,
    listRequestErrorUpstreamErrors: mocks.listRequestErrorUpstreamErrors,
    updateErrorResolution: mocks.updateErrorResolution
  }
}))

vi.mock('@/stores', () => ({
  useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn() })
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key })
  }
})

describe('OpsErrorDetailModal', () => {
  beforeEach(() => {
    mocks.getErrorDetail.mockReset()
    mocks.listRequestErrorUpstreamErrors.mockReset()
    mocks.updateErrorResolution.mockReset()
    mocks.listRequestErrorUpstreamErrors.mockResolvedValue({ items: [], has_more: false, next_cursor: null })
  })

  it('uses only the redacted on-demand payload for diagnostic payloads', async () => {
    mocks.getErrorDetail.mockResolvedValue({
      id: 'err_opaque',
      created_at: '2026-08-19T00:00:00Z',
      phase: 'request',
      type: 'upstream_error',
      error_owner: 'provider',
      error_source: 'gateway',
      severity: 'P1',
      status_code: 502,
      upstream_status_code: 429,
      platform: 'openai',
      model: 'gpt-5.6',
      resolved: false,
      resolved_at: null,
      resolved_by_user_id: null,
      control_version: 42,
      request_id: 'rid-1',
      message: 'All available accounts exhausted',
      error_body: '{"error":"same"}',
      payload: {
        state: 'available',
        body: '{"error":"same"}',
        content_type: 'application/json',
        redacted: true,
      },
      account_name: 'account',
      group_name: 'group',
      is_business_limited: false
    })

    const wrapper = shallowMount(OpsErrorDetailModal, {
      props: { show: true, errorId: 'err_opaque', errorType: 'request' },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
          Icon: true
        }
      }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('All available accounts exhausted')
    expect(wrapper.text()).toContain('admin.ops.errorDetail.upstreamStatus')
    expect(wrapper.text()).toContain('429')
    expect(wrapper.findAll('pre')).toHaveLength(1)
  })

  it('loads bounded related upstream details and exposes their redacted preview', async () => {
    const open = {
      id: 'err_opaque',
      created_at: '2026-08-19T00:00:00Z',
      phase: 'upstream',
      type: 'upstream_error',
      error_owner: 'provider',
      error_source: 'upstream_http',
      severity: 'P1',
      status_code: 502,
      platform: 'openai',
      model: 'gpt-5.6',
      resolved: false,
      resolved_at: null,
      resolved_by_user_id: null,
      control_version: 42,
      request_id: 'rid-1',
      message: 'provider failed',
      payload: { state: 'missing', body: null, content_type: null, redacted: true },
      resolution_audit: [],
      resolution_audit_truncated: false,
    }
    mocks.getErrorDetail.mockResolvedValue(open)
    mocks.listRequestErrorUpstreamErrors.mockResolvedValue({
      total: 1,
      page: 1,
      page_size: 100,
      pages: 1,
      items: [{
        ...open,
        id: 'upstream_opaque',
        payload: { state: 'available', body: '{"error":"[REDACTED]"}', content_type: 'application/json', redacted: true },
      }],
    })

    const wrapper = shallowMount(OpsErrorDetailModal, {
      props: { show: true, errorId: 'err_opaque', errorType: 'request' },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
          Icon: true,
        },
      },
    })
    await flushPromises()

    expect(mocks.listRequestErrorUpstreamErrors).toHaveBeenCalledWith(
      'err_opaque',
      { page: 1, page_size: 100, view: 'all' },
      { include_detail: true },
    )
    const previewButton = wrapper.find('button')
    expect(previewButton.exists()).toBe(true)
    await previewButton.trigger('click')
    expect(wrapper.text()).toContain('[REDACTED]')
    expect(wrapper.find('[data-testid="error-resolution-action"]').exists()).toBe(false)
  })

  it('loads an opaque upstream error id through the upstream detail family', async () => {
    const resolved = {
      id: 'upstream_opaque',
      created_at: '2026-08-19T00:00:00Z',
      phase: 'upstream',
      type: 'upstream_error',
      error_owner: 'provider',
      error_source: 'upstream_http',
      severity: 'P1',
      status_code: 502,
      platform: 'openai',
      model: 'gpt-5.6',
      resolved: true,
      resolved_at: '2026-09-05T01:00:00.000Z',
      resolved_by_user_id: 'admin-1',
      control_version: 7,
      request_id: 'rid-upstream',
      message: 'provider failed',
      payload: { state: 'missing', body: null, content_type: null, redacted: true },
      resolution_audit: [],
      resolution_audit_truncated: false,
    }
    mocks.getErrorDetail.mockResolvedValue(resolved)

    const wrapper = shallowMount(OpsErrorDetailModal, {
      props: { show: true, errorId: 'upstream_opaque', errorType: 'upstream' },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
          Icon: true,
        },
      },
    })
    await flushPromises()

    expect(mocks.getErrorDetail).toHaveBeenCalledWith('upstream', 'upstream_opaque')
    expect(mocks.listRequestErrorUpstreamErrors).not.toHaveBeenCalled()
  })
})
