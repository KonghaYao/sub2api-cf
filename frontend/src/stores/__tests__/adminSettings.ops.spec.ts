import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAdminSettingsStore } from '../adminSettings'
const settings = vi.hoisted(() => vi.fn())
vi.mock('@/api', () => ({ adminAPI: { settings: { getSettings: settings }, payment: { getConfig: vi.fn(async () => ({ data: { enabled: false } })) } } }))
describe('Worker operations feature flags', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()) })
  it('uses actual settings for a Worker instead of forcing both monitoring switches off', async () => {
    settings.mockResolvedValueOnce({ cloudflare_worker_contract: true, ops_monitoring_enabled: true, ops_realtime_monitoring_enabled: true, ops_query_mode_default: 'raw' })
    const store = useAdminSettingsStore()
    await store.fetch()
    expect(store.opsMonitoringEnabled).toBe(true)
    expect(store.opsRealtimeMonitoringEnabled).toBe(true)
    expect(store.opsQueryModeDefault).toBe('raw')
    settings.mockResolvedValueOnce({ cloudflare_worker_contract: true, ops_monitoring_enabled: false, ops_realtime_monitoring_enabled: false, ops_query_mode_default: 'auto' })
    await store.fetch(true)
    expect(store.opsMonitoringEnabled).toBe(false)
    expect(store.opsRealtimeMonitoringEnabled).toBe(false)
  })
})
