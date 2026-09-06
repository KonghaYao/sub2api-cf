import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

const file = 'src/views/admin/UsageView.vue'

function surface(source: string): string {
  const descriptor = parse(source).descriptor
  return JSON.stringify({
    template: descriptor.template?.content ?? '',
    styles: descriptor.styles.map((style) => ({ attrs: style.attrs, content: style.content })),
  })
}

describe('Admin UsageView origin UI parity', () => {
  it('keeps the original template, classes, and styles intact', () => {
    const current = readFileSync(file, 'utf8')
    const baseline = execFileSync('git', ['show', `5097b3145:frontend/${file}`], { encoding: 'utf8' })
    expect(surface(current)).toBe(surface(baseline))
  })
})
