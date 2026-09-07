import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

const files = [
  'src/views/admin/ops/OpsDashboard.vue',
  'src/views/admin/ops/components/OpsDashboardHeader.vue',
  'src/views/admin/ops/components/OpsErrorDetailsModal.vue',
  'src/views/admin/ops/components/OpsErrorLogTable.vue',
  'src/views/admin/ops/components/OpsRequestDetailsModal.vue',
  'src/views/admin/ops/components/OpsErrorDetailModal.vue',
]

function templateAndStyles(source: string): string {
  const descriptor = parse(source).descriptor
  return JSON.stringify({
    template: descriptor.template?.content ?? '',
    styles: descriptor.styles.map((style) => ({ attrs: style.attrs, content: style.content })),
  })
}

describe('Ops origin UI parity', () => {
  it.each(files)('keeps %s template, classes, and styles intact', (file) => {
    const current = readFileSync(file, 'utf8')
    const origin = execFileSync('git', ['show', `5097b3145:frontend/${file}`], { encoding: 'utf8' })
    expect(templateAndStyles(current)).toBe(templateAndStyles(origin))
  })
})
