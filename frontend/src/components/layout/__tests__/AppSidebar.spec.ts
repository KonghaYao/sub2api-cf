import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), '../AppSidebar.vue')
const componentSource = readFileSync(componentPath, 'utf8')
const stylePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../style.css')
const styleSource = readFileSync(stylePath, 'utf8')

describe('AppSidebar custom SVG styles', () => {
  it('does not override uploaded SVG fill or stroke colors', () => {
    expect(componentSource).toContain('.sidebar-svg-icon {')
    expect(componentSource).toContain('color: currentColor;')
    expect(componentSource).toContain('display: block;')
    expect(componentSource).not.toContain('stroke: currentColor;')
    expect(componentSource).not.toContain('fill: none;')
  })
})

describe('AppSidebar scroll position persistence', () => {
  it('binds a template ref to the sidebar nav element', () => {
    expect(componentSource).toContain('ref="sidebarNavRef"')
    expect(componentSource).toContain('sidebar-nav')
  })

  it('declares sidebarNavRef in script setup', () => {
    expect(componentSource).toContain("const sidebarNavRef = ref<HTMLElement | null>(null)")
  })

  it('saves scroll position on beforeUnmount', () => {
    expect(componentSource).toContain('onBeforeUnmount')
    expect(componentSource).toContain('appStore.sidebarScrollTop')
    expect(componentSource).toContain('sidebarNavRef.value.scrollTop')
  })

  it('restores scroll position on mount', () => {
    expect(componentSource).toContain('onMounted')
    expect(componentSource).toContain('appStore.sidebarScrollTop')
    expect(componentSource).toContain('nextTick')
  })
})

describe('AppSidebar header styles', () => {
  it('does not clip the version badge dropdown', () => {
    const sidebarHeaderBlockMatch = styleSource.match(/\.sidebar-header\s*\{[\s\S]*?\n {2}\}/)
    const sidebarBrandBlockMatch = componentSource.match(/\.sidebar-brand\s*\{[\s\S]*?\n\}/)

    expect(sidebarHeaderBlockMatch).not.toBeNull()
    expect(sidebarBrandBlockMatch).not.toBeNull()
    expect(sidebarHeaderBlockMatch?.[0]).not.toContain('@apply overflow-hidden;')
    expect(sidebarBrandBlockMatch?.[0]).not.toContain('overflow: hidden;')
  })
})

describe('AppSidebar Worker capabilities', () => {
  it('keeps the original admin dashboard as the home page in Worker mode', () => {
    expect(componentSource).toContain("const homePath = computed(() => (isAdmin.value ? '/admin/dashboard' : '/dashboard'))")
    expect(componentSource).not.toContain('CLOUDFLARE_ADMIN_HOME')
  })

  it('keeps the original dynamic-plugin entry governed only by its business feature flag', () => {
    expect(componentSource).toContain("path: '/admin/plugins'")
    expect(componentSource).toContain('featureFlag: flagPluginManagement')
  })

  it('keeps the original outbound-proxy inventory entry', () => {
    expect(componentSource).toContain("path: '/admin/proxies'")
    expect(componentSource).toContain("{ path: '/admin/proxies', label: t('nav.proxies'), icon: ServerIcon }")
  })

  it('exposes the dedicated invitation-code administration entry', () => {
    expect(componentSource).toContain("path: '/admin/invitation-codes'")
    expect(componentSource).toContain("t('nav.invitationCodes')")
  })

  it('keeps ops governed by its original business feature flag', () => {
    expect(componentSource).toContain('featureFlag: flagOpsMonitoring')
  })

  it('keeps the original admin channel-monitor entry', () => {
    expect(componentSource).toContain("path: '/admin/channels/monitor'")
    expect(componentSource).toContain("path: '/admin/accounts'")
    expect(componentSource).toContain('featureFlag: flagChannelMonitor')
  })

  it.each(['/admin/dashboard', '/admin/risk-control', '/admin/prompt-audit'])(
    'keeps the still-to-migrate %s declaration instead of deleting its implementation',
    (path) => {
      expect(componentSource).toContain(`path: '${path}'`)
    }
  )

  it('keeps the legacy channel-monitor user entry in Worker mode', () => {
    expect(componentSource).toContain("{ path: '/monitor', label: t('nav.channelStatus'), icon: SignalIcon, featureFlag: flagChannelMonitor }")
  })

  it('does not filter original or custom admin menu entries by deployment platform', () => {
    expect(componentSource).not.toContain('filterCloudflareAdminNavigation(baseItems)')
    expect(componentSource).not.toContain('if (!adminSettingsStore.cloudflareWorkerContract)')
  })
})
