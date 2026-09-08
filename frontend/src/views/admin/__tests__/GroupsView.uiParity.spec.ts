import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
it('preserves the original Groups template and styles at 5097b3145', () => {
  const { descriptor, errors } = parse(readFileSync(resolve(process.cwd(), 'src/views/admin/GroupsView.vue'), 'utf8'))
  expect(errors).toEqual([])
  expect(createHash('sha256').update(JSON.stringify({ template: descriptor.template?.content, styles: descriptor.styles.map(s => s.content) })).digest('hex')).toBe('b5ab3a2a97c7715df2f12df3242f216f8bf06b24275e71f31f4adcbf0ed9e988')
})
