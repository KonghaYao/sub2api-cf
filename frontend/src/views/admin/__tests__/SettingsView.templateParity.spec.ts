import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

const file = 'src/views/admin/SettingsView.vue'

function templateAndStyles(source: string): string {
  const descriptor = parse(source).descriptor
  return JSON.stringify({
    template: (descriptor.template?.content ?? '').replace(/(v-model="form\.(?:linuxdo_connect|github_oauth|google_oauth|wechat_connect|dingtalk_connect|oidc_connect)_redirect_url")\n[ \t]*:readonly="cloudflareWorkerSettings"/g, '$1').replace("<Toggle v-model=\"form.enable_cch_signing\" :disabled=\"cloudflareWorkerSettings\" :title=\"cloudflareWorkerSettings ? localText('原功能已废弃', 'This feature has been deprecated') : undefined\" />", '<Toggle v-model="form.enable_cch_signing" />'),
    styles: descriptor.styles.map((style) => ({ attrs: style.attrs, content: style.content })),
  })
}

describe('SettingsView origin UI parity', () => {
  it('keeps the original template, classes, and styles intact', () => {
    const current = readFileSync(file, 'utf8')
    const origin = execFileSync('git', ['show', `5097b3145:frontend/${file}`], { encoding: 'utf8' })
    expect(templateAndStyles(current)).toBe(templateAndStyles(origin))
  })
})
