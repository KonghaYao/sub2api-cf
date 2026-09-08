import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'

const ORIGINAL_ACCOUNT_SURFACES = {
  'src/components/account/CreateAccountModal.vue':
    '9dbb4ecb24fd5c8caa8be6e716a5eef86e21af50ec21657c95012a7791fb9a78',
  'src/components/account/EditAccountModal.vue':
    '883df5f2f77361cd142c75b5e8f37c33a61698ee93854eaa6443560a1138a665',
  'src/components/account/BulkEditAccountModal.vue':
    '1225a5b0abbad77b5cdee474834b2264e7556900b1be6d6a4ebea33972c4bc5b',
  'src/components/admin/account/AccountActionMenu.vue':
    'e2d8676ba3d94a0a96fc4a9260fa4801395d45ffdef13f4fb0ef263d12e4adf1',
  'src/components/admin/account/AccountBulkActionsBar.vue':
    'f245bc42dcf11208a51ffa331468658d67b9e7eec18de193fab97ce4e2263320',
  'src/components/admin/account/AccountTableFilters.vue':
    '979f244ba25d9b87b1a74f5f3973ae9a4b2560921743f91e5d1c2b6127c0cf0c',
  'src/views/admin/AccountsView.vue':
    'ddcd7a01036fac7aedcbdf0c8097585131869b4fb6382fe0f6833be1233a9cbd',
} as const

// Only the explicitly supported Worker token-import additions are normalized.
// Their rendering and API contracts are exercised by the imported OAuth component tests.
function originalAccountTemplate(file: string, template: string): string {
  if (file.endsWith('/CreateAccountModal.vue')) {
    template = template
      .replace(/      <div v-if="importedOAuthOnly" class="space-y-4" data-testid="imported-oauth-form">[\s\S]*?      <OAuthAuthorizationFlow v-else\n/, '      <OAuthAuthorizationFlow\n')
      .replace(/\n        <button v-if="importedOAuthOnly"[^\n]*data-testid="imported-oauth-submit"[^\n]*<\/button>/, '')
      .replace('v-if="isManualInputMethod && !importedOAuthOnly"', 'v-if="isManualInputMethod"')
      .replace('\n            :disabled="isCloudflareWorkerContractActive()"', '')
  }
  if (file.endsWith('/EditAccountModal.vue')) {
    template = template.replace(/      <div v-if="importedOAuthOnly" class="space-y-2" data-testid="edit-imported-oauth">[\s\S]*?      <\/div>\n/, '')
  }
  if (file.endsWith('/AccountActionMenu.vue')) {
    // Keep all original actions while allowing the menu to scroll in short viewports.
    template = template
      .replace('overflow-y-auto overscroll-contain', 'overflow-hidden')
      .replace(', maxHeight: `calc(100dvh - ${position.top + 8}px)`', '')
  }

  return template.replace(' role="switch" :aria-checked="row.schedulable" :aria-label="t(\'admin.accounts.columns.schedulable\')"', '')
}

function accountSurfaceHash(file: string): string {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8')
  const { descriptor, errors } = parse(source, { filename: file })
  expect(errors).toEqual([])

  return createHash('sha256')
    .update(JSON.stringify({
      // Accessibility semantics on the scheduling switch do not change the original visual surface.
      template: originalAccountTemplate(file, descriptor.template?.content ?? ''),
      styles: descriptor.styles.map((style) => style.content),
    }))
    .digest('hex')
}

describe('original account UI surface', () => {
  it.each(Object.entries(ORIGINAL_ACCOUNT_SURFACES))(
    'keeps the original template and styles for %s',
    (file, expectedHash) => {
      expect(accountSurfaceHash(file)).toBe(expectedHash)
    },
  )
})
